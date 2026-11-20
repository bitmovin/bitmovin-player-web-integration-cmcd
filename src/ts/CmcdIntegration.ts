/**
 * Collect CMCD data from the Bitmovin Player and add them to the network requests.
 *
 * Limitations:
 * - Range requests aren't supported
 * - It's currently assumed all requests go to the same server
 * - There is no distinguishing between media (ObjectType `a`/`v`/`av`) and initialization (ObjectType `i`) segments
 * - Muxed Audio and Video into a single segment (ObjectType `av`) is not supported
 * - TimedTextTrack (ObjectType `tt`) is currently not used
 */

import {
  AudioAdaptationData,
  HttpRequest,
  HttpRequestType,
  HttpResponse,
  HttpResponseBody,
  PlayerAPI,
  SegmentInfo,
  VideoAdaptationData,
} from 'bitmovin-player';
import {
  CmcdCustomKey,
  CmcdData,
  cmcdDataToHeader,
  cmcdDataToUrlParameter,
  CmcdKeysToken,
  CmcdObjectTypeToken,
  CmcdStreamingFormatToken,
  CmcdStreamTypeToken,
  CmcdVersionNumbers,
} from './Cmcd';
import { toRelativeUrl } from './Url';
import { createWarnOnce } from './Log';

export { CmcdCustomKey as CustomKey } from './Cmcd';
export { CmcdHeaderType as HeaderType } from './Cmcd';

export interface CmcdConfig {
  sessionId?: string;
  contentId?: string;
  useQueryArgs?: boolean;
  /**
   * Allows to set custom keys, which will be appended to all requests.
   * This list is static and cannot be changed during run-time.
   *
   * Please note that custom key names MUST carry a hyphenated prefix to ensure
   * that there won't be a namespace collision with future revisions of CMCD.
   * The prefix SHOULD also use a reverse-DNS syntax.
   */
  customKeys?: CmcdCustomKey[];
}

/**
 * Appends the already URL encoded CMCD query argument to the given URL, replacing a
 * previously present `CMCD` argument.
 *
 * The URL is manipulated as a string on purpose: parsing it into a `URL` and modifying
 * its `searchParams` re-serializes all pre-existing query arguments and would therefore
 * encode characters the origin might expect verbatim (e.g. `:` in `?date=2026-07-24T13:20:00Z`).
 */
function appendCmcdQueryArg(url: string, cmcdQueryArg: string): string {
  const queryStart = url.indexOf('?');
  const fragmentStart = url.indexOf('#');

  // The CMCD argument has to be part of the query, so anything after the fragment
  // delimiter is preserved as-is and re-appended at the end.
  const fragment = fragmentStart === -1 ? '' : url.slice(fragmentStart);
  const urlWithoutFragment = fragmentStart === -1 ? url : url.slice(0, fragmentStart);

  if (queryStart === -1 || (fragmentStart !== -1 && queryStart > fragmentStart)) {
    return `${urlWithoutFragment}?${cmcdQueryArg}${fragment}`;
  }

  const path = urlWithoutFragment.slice(0, queryStart);
  const existingArgs = urlWithoutFragment
    .slice(queryStart + 1)
    .split('&')
    .filter((arg) => arg !== '' && arg !== 'CMCD' && !arg.startsWith('CMCD='));

  const query = [...existingArgs, cmcdQueryArg].join('&');

  return `${path}?${query}${fragment}`;
}

/**
 * Requested maximum throughput (`rtp`) as a multiple of the encoded bitrate (`br`)
 * of the requested object. Matches the ratio of the example in CTA-5004 (2 Mbps -> 10 Mbps).
 */
const RTP_ENCODED_BITRATE_FACTOR = 5;

/** Maximum length of the content id (`cid`) and session id (`sid`) in CMCD v1. */
const MAX_ID_LENGTH = 64;

export class CmcdIntegration {
  private sessionId: string;
  private contentId: string;
  private useQueryArgs: boolean;
  private customKeys: CmcdCustomKey[];
  private player?: PlayerAPI;
  private stalledSinceLastRequest: boolean;
  private currentVideoQuality: { bandwidth: number; id: string } | null;
  private currentAudioQuality: { bandwidth: number; id: string } | null;
  private isSeekingOrTimeshiftingOrStartup: boolean;
  private lastMeasuredThroughputAudio: number;
  private lastMeasuredThroughputVideo: number;
  private manifestType: CmcdStreamingFormatToken | null;
  private warnOnce = createWarnOnce();

  constructor(config: CmcdConfig) {
    this.useQueryArgs = config.useQueryArgs || false;
    this.sessionId = config.sessionId || '';
    this.contentId = config.contentId || '';
    this.customKeys = config.customKeys || [];
    this.resetSourceState();

    if (this.useQueryArgs === false && this.customKeys.length > 0) {
      const customKeyWithoutHeaderType = this.customKeys
        .filter((key) => key.type === null)
        .map((customKey) => customKey.key);
      if (customKeyWithoutHeaderType.length > 0) {
        throw new Error(
          'All custom keys must have an HTTP header type configured if HTTP header mode is used ' +
            '(`CmcdConfig.useQueryArgs = false`), but is missing for ' +
            customKeyWithoutHeaderType.join(', ')
        );
      }
    }
  }

  public setPlayer(player: PlayerAPI) {
    this.player = player;
    this.player.on(player.exports.PlayerEvent.SourceUnloaded, () => this.resetSourceState());
    this.player.on(player.exports.PlayerEvent.StallStarted, () => {
      this.stalledSinceLastRequest = true;
      this.isSeekingOrTimeshiftingOrStartup = true;
    });
    this.player.on(player.exports.PlayerEvent.StallEnded, () => (this.isSeekingOrTimeshiftingOrStartup = false));
    // Startup ends when playback begins. Without this, `su` is sent until the first seek or stall.
    this.player.on(player.exports.PlayerEvent.Playing, () => (this.isSeekingOrTimeshiftingOrStartup = false));
    this.player.on(player.exports.PlayerEvent.Seek, () => (this.isSeekingOrTimeshiftingOrStartup = true));
    this.player.on(player.exports.PlayerEvent.Seeked, () => (this.isSeekingOrTimeshiftingOrStartup = false));
    this.player.on(player.exports.PlayerEvent.TimeShift, () => (this.isSeekingOrTimeshiftingOrStartup = true));
    this.player.on(player.exports.PlayerEvent.TimeShifted, () => (this.isSeekingOrTimeshiftingOrStartup = false));
  }

  /** Clears all state that belongs to the previously loaded source. */
  private resetSourceState() {
    this.stalledSinceLastRequest = false;
    this.currentVideoQuality = null;
    this.currentAudioQuality = null;
    this.isSeekingOrTimeshiftingOrStartup = true;
    this.lastMeasuredThroughputAudio = 0;
    this.lastMeasuredThroughputVideo = 0;
    this.manifestType = null;
  }

  public onVideoAdaptation = (data: VideoAdaptationData) => {
    this.currentVideoQuality = data.representations.filter((rep) => rep.id === data.suggested)[0];
    return data.suggested;
  };

  public onAudioAdaptation = (data: AudioAdaptationData) => {
    this.currentAudioQuality = data.representations.filter((rep) => rep.id === data.suggested)[0];
    return data.suggested;
  };

  public preprocessHttpRequest = (type: HttpRequestType, request: HttpRequest) => {
    const data = this.gatherCmcdData(type, request);

    // An encoding error must not fail the request, so it is sent without CMCD data.
    try {
      if (this.useQueryArgs) {
        request.url = appendCmcdQueryArg(request.url, cmcdDataToUrlParameter(data, this.customKeys));
      } else {
        const cmcdHeaders = cmcdDataToHeader(data, this.customKeys);

        request.headers = {
          ...request.headers,
          ...cmcdHeaders,
        };
      }
    } catch (error) {
      // Deduplicated per message: different values with the same error type are reported once.
      this.warnOnce(`CMCD: data is not sent: ${error}`);
    }

    return Promise.resolve(request);
  };

  public preprocessHttpResponse = (type: HttpRequestType, response: HttpResponse<HttpResponseBody>) => {
    const time = response.elapsedTime;
    const bytes = response.length;

    if (!time || !bytes) {
      return Promise.resolve(response);
    }

    // `elapsedTime` is in seconds and `length` in bytes. CMCD `mtp` is expressed
    // in kilobits per second, so convert bytes to bits (* 8) before scaling to kbps.
    const kbps = (bytes * 8) / time / 1000;

    if (type === (this.player?.exports.HttpRequestType.MEDIA_AUDIO || 'media/audio')) {
      this.lastMeasuredThroughputAudio = Math.round(kbps * 100) / 100;
    }
    if (type === (this.player?.exports.HttpRequestType.MEDIA_VIDEO || 'media/video')) {
      this.lastMeasuredThroughputVideo = Math.round(kbps * 100) / 100;
    }
    return Promise.resolve(response);
  };

  public setSessionId(id: string): void {
    this.sessionId = id;
  }

  public setContentId(id: string): void {
    this.contentId = id;
  }

  private gatherCmcdData(type: HttpRequestType, request: HttpRequest): CmcdData {
    if (!this.player) {
      throw new Error('Bitmovin Player not provided!');
    }

    const data: CmcdData = {
      v: CmcdVersionNumbers.v1,
      st: this.player.isLive() ? CmcdStreamTypeToken.Live : CmcdStreamTypeToken.Vod,
      // 0 before the first play and while paused
      pr: this.player.isPlaying() ? this.player.getPlaybackSpeed() : 0,
      ot: this.getObjectType(type),
    };

    const streamingFormat = this.getStreamingType(type);
    if (streamingFormat) {
      data.sf = streamingFormat;
    }

    if (this.isValidId(CmcdKeysToken.ContentId, this.contentId)) {
      data.cid = this.contentId;
    }

    if (this.isValidId(CmcdKeysToken.SessionId, this.sessionId)) {
      data.sid = this.sessionId;
    }

    const isStartup = this.isSeekingOrTimeshiftingOrStartup;
    if (isStartup) {
      data.su = true;
    }

    const isBufferStarvation = this.stalledSinceLastRequest || this.player.isStalled();
    if (isBufferStarvation) {
      data.bs = true;
      this.stalledSinceLastRequest = false;
    }

    if (type === this.player.exports.HttpRequestType.MEDIA_AUDIO) {
      this.addSegmentRequestSpecificData(data, request, 'audio');
    } else if (type === this.player.exports.HttpRequestType.MEDIA_VIDEO) {
      this.addSegmentRequestSpecificData(data, request, 'video');
    }

    // The object is needed as fast as possible during startup and after a stall, so no throughput cap is requested.
    if (!isStartup && !isBufferStarvation && data.br !== undefined) {
      data.rtp = data.br * RTP_ENCODED_BITRATE_FACTOR;
    }

    // TODO: data.nrr = 'byte-range';

    return data;
  }

  /** `cid` and `sid` are limited to 64 characters. Longer values are omitted, as truncating could cause collisions. */
  private isValidId(key: CmcdKeysToken, value: string): boolean {
    if (!value) {
      return false;
    }
    if (value.length <= MAX_ID_LENGTH) {
      return true;
    }
    this.warnOnce(`CMCD: '${key}' value '${value}' exceeds ${MAX_ID_LENGTH} characters and is not sent.`);
    return false;
  }

  /**
   * Main manifest requests set the format, so loading another source before the previous one
   * was unloaded is handled. An HLS variant request only sets it if still unknown (media playlist as source).
   * Returns `null` while unknown, as `sf` MUST NOT be sent then.
   */
  private getStreamingType(type: HttpRequestType): CmcdStreamingFormatToken | null {
    const requestTypes = this.player?.exports.HttpRequestType;
    if (type === requestTypes?.MANIFEST_DASH) {
      this.manifestType = CmcdStreamingFormatToken.MpegDash;
    } else if (type === requestTypes?.MANIFEST_HLS_MASTER) {
      this.manifestType = CmcdStreamingFormatToken.Hls;
    } else if (type === requestTypes?.MANIFEST_SMOOTH) {
      this.manifestType = CmcdStreamingFormatToken.Smooth;
    } else if (type === requestTypes?.MANIFEST_HLS_VARIANT && !this.manifestType) {
      this.manifestType = CmcdStreamingFormatToken.Hls;
    }

    return this.manifestType;
  }

  private getObjectType(type: HttpRequestType): CmcdObjectTypeToken {
    switch (type) {
      case this.player?.exports.HttpRequestType.MEDIA_AUDIO:
        // TODO: We can't distinguish between media and init segments
        return CmcdObjectTypeToken.AudioOnly;
      case this.player?.exports.HttpRequestType.MEDIA_VIDEO:
        // TODO: We can't distinguish between Video and muxed Audio/Video
        // TODO: We can't distinguish between media and init segments
        return CmcdObjectTypeToken.VideoOnly;
      case this.player?.exports.HttpRequestType.DRM_CERTIFICATE_FAIRPLAY:
      case this.player?.exports.HttpRequestType.DRM_LICENSE_CLEARKEY:
      case this.player?.exports.HttpRequestType.DRM_LICENSE_FAIRPLAY:
      case this.player?.exports.HttpRequestType.DRM_LICENSE_PLAYREADY:
      case this.player?.exports.HttpRequestType.DRM_LICENSE_WIDEVINE:
      case this.player?.exports.HttpRequestType.KEY_HLS_AES:
        return CmcdObjectTypeToken.CryptographicKeyOrLicenseOrCertificate;
      case this.player?.exports.HttpRequestType.MANIFEST_ADS:
      case this.player?.exports.HttpRequestType.MANIFEST_DASH:
      case this.player?.exports.HttpRequestType.MANIFEST_HLS_MASTER:
      case this.player?.exports.HttpRequestType.MANIFEST_HLS_VARIANT:
      case this.player?.exports.HttpRequestType.MANIFEST_SMOOTH:
        return CmcdObjectTypeToken.ManifestOrPlaylistTextFile;
      case this.player?.exports.HttpRequestType.MEDIA_SEGMENTINDEX:
        return CmcdObjectTypeToken.InitSegment;
      case this.player?.exports.HttpRequestType.MEDIA_SUBTITLES:
        return CmcdObjectTypeToken.CaptionOrSubtitle;
      default:
        return CmcdObjectTypeToken.Other;
    }
  }

  private addSegmentRequestSpecificData(data: CmcdData, request: HttpRequest, mediaType: 'audio' | 'video') {
    if (!this.player) {
      return;
    }

    const isAudio = mediaType === 'audio';
    const currentQuality = isAudio ? this.currentAudioQuality : this.currentVideoQuality;
    const lastMeasuredThroughput = isAudio ? this.lastMeasuredThroughputAudio : this.lastMeasuredThroughputVideo;

    if (currentQuality && currentQuality.bandwidth) {
      data.br = Math.round(currentQuality.bandwidth / 1000);
    }

    if (lastMeasuredThroughput) {
      data.mtp = lastMeasuredThroughput;
    }

    const buffer = this.player.buffer.getLevel(
      this.player.exports.BufferType.ForwardDuration,
      isAudio ? this.player.exports.MediaType.Audio : this.player.exports.MediaType.Video
    );
    if (buffer.targetLevel > 0) {
      data.bl = buffer.level * 1000;
      data.dl = (buffer.level / this.player.getPlaybackSpeed()) * 1000;
    }

    const qualities = isAudio ? this.player.getAvailableAudioQualities() : this.player.getAvailableVideoQualities();
    const topBitrate = qualities.reduce((prev, current) => Math.max(prev, current.bitrate), 0) / 1000;
    if (topBitrate > 0) {
      data.tb = topBitrate;
    }

    if (currentQuality) {
      try {
        const allSegments = this.player.getAvailableSegments();
        for (const mimeType in allSegments) {
          const segments = allSegments[mimeType][currentQuality.id];
          if (mimeType.startsWith(`${mediaType}/`) && segments) {
            this.addNextObjectAndObjectDuration(data, segments, request.url);
          }
        }
      } catch (error) {
        console.error(`Error processing ${mediaType} segments:`, error);
      }
    }
  }

  private addNextObjectAndObjectDuration(data: CmcdData, segments: SegmentInfo[], requestUrl: string) {
    const currentSegmentIndex = segments.findIndex((value) => value.url === requestUrl);
    if (currentSegmentIndex > -1) {
      const currentSegment = segments[currentSegmentIndex];
      if (Number.isFinite(currentSegment.duration)) {
        data.d = Number(currentSegment.duration) * 1000;
      }

      if (currentSegmentIndex + 1 < segments.length) {
        const nextSegment = segments[currentSegmentIndex + 1];
        // TODO what about range requests?
        const relativePath = nextSegment.url ? toRelativeUrl(requestUrl, nextSegment.url) : null;
        if (relativePath) {
          data.nor = relativePath;
        }
      }
    }
  }
}
