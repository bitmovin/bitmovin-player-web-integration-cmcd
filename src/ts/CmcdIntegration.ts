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
  CmcdBase,
  CmcdBufferLength,
  CmcdBufferStarvation,
  CmcdContentId,
  CmcdCustomKey,
  cmcdDataToHeader,
  cmcdDataToUrlParameter,
  CmcdDeadline,
  CmcdEncodedBitrate,
  CmcdKeysToken,
  CmcdMeasuredThroughput,
  CmcdNextObjectRequest,
  CmcdNextRangeRequest,
  CmcdObjectDuration,
  CmcdObjectType,
  CmcdObjectTypeToken,
  CmcdPlaybackRate,
  CmcdRequestedMaximumThroughput,
  CmcdSessionId,
  CmcdStartup,
  CmcdStreamingFormat,
  CmcdStreamingFormatToken,
  CmcdStreamType,
  CmcdStreamTypeToken,
  CmcdTopBitrate,
  CmcdVersion,
  CmcdVersionNumbers,
} from './Cmcd';

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

/**
 * Returns the path of `targetUrl` relative to `baseUrl` (e.g. `../300kbps/segment35.m4v`),
 * including the query of `targetUrl`.
 * Returns `null` if no relative path is possible, i.e. both URLs have a different origin.
 */
export function toRelativeUrl(baseUrl: string, targetUrl: string): string | null {
  let base: URL;
  let target: URL;
  try {
    base = new URL(baseUrl);
    target = new URL(targetUrl, base);
  } catch {
    return null;
  }

  if (base.origin !== target.origin) {
    return null;
  }

  // Directory segments of the base. The last segment is the file name of the current request.
  const baseDirSegments = base.pathname.split('/').slice(0, -1);
  const targetSegments = target.pathname.split('/');

  // Keep at least the file name of the target.
  let commonLength = 0;
  while (
    commonLength < baseDirSegments.length &&
    commonLength < targetSegments.length - 1 &&
    baseDirSegments[commonLength] === targetSegments[commonLength]
  ) {
    commonLength++;
  }

  const upSegments = new Array(baseDirSegments.length - commonLength).fill('..');
  let relativePath = [...upSegments, ...targetSegments.slice(commonLength)].join('/');

  // A colon in the first segment would make the path look like a URL scheme.
  if (upSegments.length === 0 && relativePath.split('/')[0].includes(':')) {
    relativePath = `./${relativePath}`;
  }

  return `${relativePath}${target.search}`;
}

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

  constructor(config: CmcdConfig) {
    this.useQueryArgs = config.useQueryArgs || false;
    this.sessionId = config.sessionId || '';
    this.contentId = config.contentId || '';
    this.customKeys = config.customKeys || [];
    this.stalledSinceLastRequest = false;
    this.currentVideoQuality = null;
    this.currentAudioQuality = null;
    this.isSeekingOrTimeshiftingOrStartup = true;
    this.lastMeasuredThroughputAudio = 0;
    this.lastMeasuredThroughputVideo = 0;
    this.manifestType = null;

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

    if (this.useQueryArgs) {
      request.url = appendCmcdQueryArg(request.url, cmcdDataToUrlParameter(data));
    } else {
      const cmcdHeaders = cmcdDataToHeader(data);

      request.headers = {
        ...request.headers,
        ...cmcdHeaders,
      };
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

  private gatherCmcdData(type: HttpRequestType, request: HttpRequest): CmcdBase[] {
    if (!this.player) {
      throw new Error('Bitmovin Player not provided!');
    }

    let data: CmcdBase[] = [];
    data.push(new CmcdVersion(CmcdVersionNumbers.v1));
    data.push(new CmcdStreamType(this.player.isLive() ? CmcdStreamTypeToken.Live : CmcdStreamTypeToken.Vod));
    data.push(new CmcdPlaybackRate(this.player.getPlaybackSpeed()));
    data.push(this.getObjectType(type));
    data.push(this.getStreamingType(type));

    if (this.contentId) {
      data.push(new CmcdContentId(this.contentId));
    }

    if (this.sessionId) {
      data.push(new CmcdSessionId(this.sessionId));
    }

    const isStartup = this.isSeekingOrTimeshiftingOrStartup;
    if (isStartup) {
      data.push(new CmcdStartup(true));
    }

    const isBufferStarvation = this.stalledSinceLastRequest || this.player.isStalled();
    if (isBufferStarvation) {
      data.push(new CmcdBufferStarvation(true));
      this.stalledSinceLastRequest = false;
    }

    if (type === this.player.exports.HttpRequestType.MEDIA_AUDIO) {
      data = data.concat(this.getSegmentRequestSpecificData(request, 'audio'));
    } else if (type === this.player.exports.HttpRequestType.MEDIA_VIDEO) {
      data = data.concat(this.getSegmentRequestSpecificData(request, 'video'));
    }

    // The object is needed as fast as possible during startup and after a stall, so no throughput cap is requested.
    if (!isStartup && !isBufferStarvation) {
      data = data.concat(this.getRequestedMaximumThroughput(data));
    }

    // TODO: data.push(new CmcdNextRangeRequest('byte-range'));

    for (const customKey of this.customKeys) {
      data.push(customKey);
    }

    return data;
  }

  private getRequestedMaximumThroughput(data: CmcdBase[]): CmcdBase[] {
    const encodedBitrate = data.find((obj) => obj.key === CmcdKeysToken.EncodedBitrate);
    if (!encodedBitrate) {
      return [];
    }
    return [new CmcdRequestedMaximumThroughput(Number(encodedBitrate.value) * RTP_ENCODED_BITRATE_FACTOR)];
  }

  private getStreamingType(type: HttpRequestType) {
    if (!this.manifestType) {
      if (type === this.player?.exports.HttpRequestType.MANIFEST_DASH) {
        this.manifestType = CmcdStreamingFormatToken.MpegDash;
      } else if (type === this.player?.exports.HttpRequestType.MANIFEST_HLS_MASTER) {
        this.manifestType = CmcdStreamingFormatToken.Hls;
      } else if (type === this.player?.exports.HttpRequestType.MANIFEST_SMOOTH) {
        this.manifestType = CmcdStreamingFormatToken.Smooth;
      } else {
        this.manifestType = CmcdStreamingFormatToken.Other;
      }
    }
    return new CmcdStreamingFormat(this.manifestType);
  }

  private getObjectType(type: HttpRequestType) {
    let data;

    switch (type) {
      case this.player?.exports.HttpRequestType.MEDIA_AUDIO:
        // TODO: We can't distinguish between media and init segments
        data = new CmcdObjectType(CmcdObjectTypeToken.AudioOnly);
        break;
      case this.player?.exports.HttpRequestType.MEDIA_VIDEO:
        // TODO: We can't distinguish between Video and muxed Audio/Video
        // TODO: We can't distinguish between media and init segments
        data = new CmcdObjectType(CmcdObjectTypeToken.VideoOnly);
        break;
      case this.player?.exports.HttpRequestType.DRM_CERTIFICATE_FAIRPLAY:
      case this.player?.exports.HttpRequestType.DRM_LICENSE_CLEARKEY:
      case this.player?.exports.HttpRequestType.DRM_LICENSE_FAIRPLAY:
      case this.player?.exports.HttpRequestType.DRM_LICENSE_PLAYREADY:
      case this.player?.exports.HttpRequestType.DRM_LICENSE_WIDEVINE:
      case this.player?.exports.HttpRequestType.KEY_HLS_AES:
        data = new CmcdObjectType(CmcdObjectTypeToken.CryptographicKeyOrLicenseOrCertificate);
        break;
      case this.player?.exports.HttpRequestType.MANIFEST_ADS:
      case this.player?.exports.HttpRequestType.MANIFEST_DASH:
      case this.player?.exports.HttpRequestType.MANIFEST_HLS_MASTER:
      case this.player?.exports.HttpRequestType.MANIFEST_HLS_VARIANT:
      case this.player?.exports.HttpRequestType.MANIFEST_SMOOTH:
        data = new CmcdObjectType(CmcdObjectTypeToken.ManifestOrPlaylistTextFile);
        break;
      case this.player?.exports.HttpRequestType.MEDIA_SEGMENTINDEX:
        data = new CmcdObjectType(CmcdObjectTypeToken.InitSegment);
        break;
      case this.player?.exports.HttpRequestType.MEDIA_SUBTITLES:
        data = new CmcdObjectType(CmcdObjectTypeToken.CaptionOrSubtitle);
        break;
      default:
        data = new CmcdObjectType(CmcdObjectTypeToken.Other);
        break;
    }

    return data;
  }

  private getSegmentRequestSpecificData(request: HttpRequest, mediaType: 'audio' | 'video'): CmcdBase[] {
    let data: CmcdBase[] = [];
    if (!this.player) {
      return data;
    }

    const isAudio = mediaType === 'audio';
    const currentQuality = isAudio ? this.currentAudioQuality : this.currentVideoQuality;
    const lastMeasuredThroughput = isAudio ? this.lastMeasuredThroughputAudio : this.lastMeasuredThroughputVideo;

    if (currentQuality && currentQuality.bandwidth) {
      data.push(new CmcdEncodedBitrate(Math.round(currentQuality.bandwidth / 1000)));
    }

    if (lastMeasuredThroughput) {
      data.push(new CmcdMeasuredThroughput(lastMeasuredThroughput));
    }

    const buffer = this.player.buffer.getLevel(
      this.player.exports.BufferType.ForwardDuration,
      isAudio ? this.player.exports.MediaType.Audio : this.player.exports.MediaType.Video
    );
    if (buffer.targetLevel > 0) {
      data.push(new CmcdBufferLength(buffer.level * 1000));

      const deadline = buffer.level / this.player.getPlaybackSpeed();
      data.push(new CmcdDeadline(deadline * 1000));
    }

    const qualities = isAudio ? this.player.getAvailableAudioQualities() : this.player.getAvailableVideoQualities();
    const topBitrate = qualities.reduce((prev, current) => Math.max(prev, current.bitrate), 0) / 1000;
    if (topBitrate > 0) {
      data.push(new CmcdTopBitrate(topBitrate));
    }

    if (currentQuality) {
      try {
        const allSegments = this.player.getAvailableSegments();
        for (const mimeType in allSegments) {
          const segments = allSegments[mimeType][currentQuality.id];
          if (mimeType.startsWith(`${mediaType}/`) && segments) {
            data = data.concat(this.getNextObjectAndObjectDurationCmcdData(segments, request.url));
          }
        }
      } catch (error) {
        console.error(`Error processing ${mediaType} segments:`, error);
      }
    }

    return data;
  }

  private getNextObjectAndObjectDurationCmcdData(segments: SegmentInfo[], requestUrl: string): CmcdBase[] {
    const data: CmcdBase[] = [];

    const currentSegmentIndex = segments.findIndex((value) => value.url === requestUrl);
    if (currentSegmentIndex > -1) {
      const currentSegment = segments[currentSegmentIndex];
      if (Number.isFinite(currentSegment.duration)) {
        data.push(new CmcdObjectDuration(Number(currentSegment.duration) * 1000));
      }

      if (currentSegmentIndex + 1 < segments.length) {
        const nextSegment = segments[currentSegmentIndex + 1];
        // TODO what about range requests?
        const relativePath = nextSegment.url ? toRelativeUrl(requestUrl, nextSegment.url) : null;
        if (relativePath) {
          data.push(new CmcdNextObjectRequest(relativePath));
        }
      }
    }
    return data;
  }
}
