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
import { CmcdBase, CmcdCustomKey } from './Cmcd';
import {
  CmcdBufferLength,
  CmcdBufferStarvation,
  CmcdContentId,
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
  }

  public setPlayer(player: PlayerAPI) {
    this.player = player;
    this.player.on(player.exports.PlayerEvent.StallStarted, () => {
      this.stalledSinceLastRequest = true;
      this.isSeekingOrTimeshiftingOrStartup = true;
    });
    this.player.on(player.exports.PlayerEvent.StallEnded, () => (this.isSeekingOrTimeshiftingOrStartup = false));
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
      const cmcdStr = cmcdDataToUrlParameter(data);
      const separator = request.url.includes('?') ? '&' : '?';
      request.url = `${request.url}${separator}${cmcdStr}`;
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

    const kbps = bytes / time / 1000;

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

    if (this.isSeekingOrTimeshiftingOrStartup) {
      data.push(new CmcdStartup(true));
    }

    if (this.stalledSinceLastRequest || this.player.isStalled()) {
      data.push(new CmcdBufferStarvation(true));
      this.stalledSinceLastRequest = false;
    }

    if (type === this.player?.exports.HttpRequestType.MEDIA_AUDIO) {
      data = data.concat(this.getAudioSegmentRequestSpecificData(request));
    } else if (type === this.player?.exports.HttpRequestType.MEDIA_VIDEO) {
      data = data.concat(this.getVideoSegmentRequestSpecificData(request));
    }

    data.concat(this.getRequestedMaximumThroughput(data));

    // TODO: data.push(new CmcdNextRangeRequest('byte-range'));

    for (const customKey of this.customKeys) {
      data.push(customKey);
    }

    return data;
  }

  private getRequestedMaximumThroughput(data: CmcdBase[]): CmcdBase[] {
    const cmcdEncodedBitrate = data.find((obj) => obj.key === CmcdKeysToken.EncodedBitrate) as CmcdEncodedBitrate;
    const cmcdObjectDuration = data.find((obj) => obj.key === CmcdKeysToken.ObjectDuration) as CmcdObjectDuration;
    const isBufferStarvation = Boolean(data.find((obj) => obj.key === CmcdKeysToken.ObjectDuration));
    const cmcdStartup = data.find((obj) => obj.key === CmcdKeysToken.Startup);
    const isStartup = cmcdStartup && !cmcdStartup.value;
    if (cmcdEncodedBitrate && cmcdObjectDuration && !isBufferStarvation && !isStartup) {
      const segmentDurationSec = Number(cmcdObjectDuration.value) * 1000;
      const encodedBitrateKbps = Number(cmcdEncodedBitrate.value);
      const maxThroughput = encodedBitrateKbps * (segmentDurationSec / 2);
      return [new CmcdRequestedMaximumThroughput(maxThroughput)];
    }
    return [];
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

  private getAudioSegmentRequestSpecificData(request: HttpRequest): CmcdBase[] {
    let data: CmcdBase[] = [];

    if (this.currentAudioQuality && this.currentAudioQuality.bandwidth) {
      data.push(new CmcdEncodedBitrate(Math.round(this.currentAudioQuality.bandwidth / 1000)));
    }

    if (this.lastMeasuredThroughputAudio) {
      data.push(new CmcdMeasuredThroughput(this.lastMeasuredThroughputAudio));
    }

    if (!this.player) {
      return data;
    }

    const audioBuffer = this.player.buffer.getLevel(
      this.player.exports.BufferType.ForwardDuration,
      this.player.exports.MediaType.Audio
    );
    if (audioBuffer.targetLevel > 0) {
      data.push(new CmcdBufferLength(audioBuffer.level * 1000));

      const deadline = audioBuffer.level / this.player?.getPlaybackSpeed();
      data.push(new CmcdDeadline(deadline * 1000));
    }

    const audioTopBitrate =
      this.player.getAvailableAudioQualities().reduce((prev, current) => {
        return Math.max(prev, current.bitrate);
      }, 0) / 1000;
    if (audioTopBitrate > 0) {
      data.push(new CmcdTopBitrate(audioTopBitrate));
    }

    if (this.currentVideoQuality) {
      try {
        const allSegments = this.player.getAvailableSegments();
        for (const mimeType in allSegments) {
          if (mimeType.startsWith('video/')) {
            const segments = allSegments[mimeType][this.currentVideoQuality.id];
            data = data.concat(this.getNextObjectAndObjectDurationCmcdData(segments, request.url));
          }
        }
      } catch (error) {
        console.error('Error processing audio segments:', error);
      }
    }

    return data;
  }

  private getVideoSegmentRequestSpecificData(request: HttpRequest): CmcdBase[] {
    let data: CmcdBase[] = [];

    if (this.currentVideoQuality && this.currentVideoQuality.bandwidth) {
      data.push(new CmcdEncodedBitrate(Math.round(this.currentVideoQuality.bandwidth / 1000)));
    }

    if (this.lastMeasuredThroughputVideo) {
      data.push(new CmcdMeasuredThroughput(this.lastMeasuredThroughputVideo));
    }

    if (!this.player) {
      return data;
    }

    const videoBuffer = this.player.buffer.getLevel(
      this.player.exports.BufferType.ForwardDuration,
      this.player.exports.MediaType.Video
    );
    if (videoBuffer.targetLevel > 0) {
      data.push(new CmcdBufferLength(videoBuffer.level * 1000));

      const deadline = videoBuffer.level / this.player?.getPlaybackSpeed();
      data.push(new CmcdDeadline(deadline * 1000));
    }

    const videoTopBitrate =
      this.player.getAvailableVideoQualities().reduce((prev, current) => {
        return Math.max(prev, current.bitrate);
      }, 0) / 1000;
    if (videoTopBitrate > 0) {
      data.push(new CmcdTopBitrate(videoTopBitrate));
    }

    if (this.currentVideoQuality) {
      try {
        const allSegments = this.player.getAvailableSegments();
        for (const mimeType in allSegments) {
          if (mimeType.startsWith('video/')) {
            const segments = allSegments[mimeType][this.currentVideoQuality.id];
            data = data.concat(this.getNextObjectAndObjectDurationCmcdData(segments, request.url));
          }
        }
      } catch (error) {
        console.error('Error processing video segments:', error);
      }
    }

    return data;
  }

  private getNextObjectAndObjectDurationCmcdData(segments: SegmentInfo[], requestUrl: string): CmcdBase[] {
    const data: CmcdBase[] = [];

    const currentSegmentIndex = segments.findIndex((value) => value.url === requestUrl);
    if (currentSegmentIndex > -1) {
      const currentSegment = segments[currentSegmentIndex];
      if (!Number.isNaN(currentSegment.duration)) {
        data.push(new CmcdObjectDuration(Number(currentSegment.duration) * 1000));
      }

      if (currentSegmentIndex + 1 < segments.length) {
        const nextSegment = segments[currentSegmentIndex + 1];
        if (nextSegment.url) {
          // TODO what about range requests?
          data.push(new CmcdNextObjectRequest(nextSegment.url));
        }
      }
    }
    return data;
  }
}
