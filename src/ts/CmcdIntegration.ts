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
  ErrorEvent,
  HttpRequest,
  HttpRequestType,
  HttpResponse,
  HttpResponseBody,
  PlayerAPI,
  PlayerEvent,
  PlayerEventBase,
  SegmentInfo,
  TimeMode,
  VideoAdaptationData,
} from 'bitmovin-player';
import {
  CMCD_KEYS,
  CMCD_V2_EVENT_KEYS,
  CmcdCustomKey,
  CmcdData,
  cmcdDataToHeader,
  cmcdDataToUrlParameter,
  CmcdKeyTable,
  CmcdObjectTypeToken,
  CmcdPlayStateToken,
  CmcdStreamingFormatToken,
  CmcdStreamTypeToken,
  CmcdTypedValue,
  CmcdVersionNumbers,
} from './Cmcd';
import { toRelativeUrl } from './Url';
import { createWarnOnce } from './Log';
import { CmcdTargetRegistry } from './CmcdTargetRegistry';
import { attempt, CmcdEnvironment, CmcdEventMode } from './CmcdEventMode';
import { CmcdEventTarget } from './CmcdEventTarget';

export { CmcdCustomKey as CustomKey } from './Cmcd';
export { CmcdHeaderType as HeaderType } from './Cmcd';
export type { CmcdEventType } from './Cmcd';
export type { CmcdEventTarget, CmcdUrlFilter } from './CmcdEventTarget';
export type { CmcdEnvironment } from './CmcdEventMode';
export type { CmcdTransport, CmcdTransportRequest } from './CmcdEventReporter';

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
  /**
   * CMCD version, 1 (default) or 2. Version 2 sends the v2 Request Mode keys.
   */
  version?: 1 | 2;
  /**
   * v2 Event Mode report destinations. Event Mode always uses v2, also if `version` is 1.
   * `sessionId` and `contentId` are shared with Request Mode.
   */
  eventTargets?: CmcdEventTarget[];
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

/** Maximum number of origins with own `sn`, `bsd` and `ec` state. The least recently used one is dropped. */
const MAX_TARGETS = 16;

/** Timestamp of an event, or now if the event has none. */
const eventTime = (event?: PlayerEventBase) => (event && event.timestamp) || Date.now();

/** Request Mode state per report destination (origin) */
interface CmcdTarget {
  sequenceNumber: number;
  /** `bsd` to send with the next request */
  rebufferingDurations: number[];
  /** `ec` to send with the next request */
  errorCodes: string[];
}

export class CmcdIntegration {
  private sessionId: string;
  private contentId: string;
  private useQueryArgs: boolean;
  private customKeys: CmcdCustomKey[];
  private version: CmcdVersionNumbers;
  /** Keys of the configured version. Data of other keys is not collected. */
  private keys: CmcdKeyTable;
  private player?: PlayerAPI;
  private stalledSinceLastRequest: boolean;
  private currentVideoQuality: { bandwidth: number; id: string } | null;
  private currentAudioQuality: { bandwidth: number; id: string } | null;
  private isSeekingOrTimeshiftingOrStartup: boolean;
  private lastMeasuredThroughputAudio: number;
  private lastMeasuredThroughputVideo: number;
  private manifestType: CmcdStreamingFormatToken | null;
  private warnOnce = createWarnOnce();
  /** Player event listeners, to remove them from a replaced player */
  private listeners: { event: PlayerEvent; callback: (event?: any) => void }[] = [];

  // Source state for v2 keys
  /** Time of the first `Play` event of the source, `null` if none yet */
  private playRequestedAt: number | null;
  /** First `Playing` event of the source received */
  private hasStarted: boolean;
  private isSeeking: boolean;
  private hasFatalError: boolean;
  /** Start time of the current rebuffering, `null` if none */
  private rebufferingStartedAt: number | null;

  // Session state for v2 keys, reset on a new session id
  /** State per origin, in order of last use */
  private targets = new CmcdTargetRegistry<CmcdTarget>(
    () => ({ sequenceNumber: 0, rebufferingDurations: [], errorCodes: [] }),
    MAX_TARGETS
  );
  /** `msd` to send with the next request */
  private pendingStartupDelay: number | null;
  private startupDelaySent: boolean;
  private rebufferingCount: number;
  private rebufferingDuration: number;
  /** Dropped frames of the previous sources of the session */
  private droppedFramesOffset = 0;
  /** Last dropped frames count of the current source */
  private droppedFrames = 0;

  private eventMode: CmcdEventMode;

  /** `environment` is for tests. */
  constructor(config: CmcdConfig, environment: CmcdEnvironment = {}) {
    this.useQueryArgs = config.useQueryArgs || false;
    this.sessionId = config.sessionId || '';
    this.contentId = config.contentId || '';
    this.customKeys = config.customKeys || [];
    this.version = config.version === 2 ? CmcdVersionNumbers.v2 : CmcdVersionNumbers.v1;
    this.keys = CMCD_KEYS[this.version];
    this.resetSourceState();
    this.resetSessionState();

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

    this.eventMode = new CmcdEventMode(
      config.eventTargets || [],
      {
        getStateData: () => this.getEventStateData(),
        getPlayState: () => this.getPlayState(),
        isRebuffering: () => this.rebufferingStartedAt !== null,
        getObjectType: (type) => this.getObjectType(type),
      },
      environment,
      this.warnOnce
    );
  }

  public setPlayer(player: PlayerAPI) {
    // Listeners of a previously set player
    this.removePlayerListeners();

    const events = player.exports.PlayerEvent;
    const hasEventMode = this.eventMode.isEnabled;
    const on = <T extends PlayerEventBase>(event: PlayerEvent, callback: (event?: T) => void) => {
      // Events unknown to the player version
      if (!event) {
        return;
      }
      this.listeners.push({ event, callback });
      player.on(event, callback);
    };
    const setSeeking = (seeking: boolean) => {
      this.isSeekingOrTimeshiftingOrStartup = seeking;
      this.isSeeking = seeking;
    };
    this.player = player;
    on(events.SourceUnloaded, () => {
      this.droppedFramesOffset += this.droppedFrames;
      this.droppedFrames = 0;
      this.resetSourceState();
    });
    on(events.StallStarted, (event?: PlayerEventBase) => {
      this.stalledSinceLastRequest = true;
      this.isSeekingOrTimeshiftingOrStartup = true;
      // Rebuffering excludes stalls during startup and seeking.
      if (this.hasStarted && !this.isSeeking) {
        this.rebufferingCount++;
        this.rebufferingStartedAt = eventTime(event);
      }
    });
    on(events.StallEnded, (event?: PlayerEventBase) => {
      this.isSeekingOrTimeshiftingOrStartup = false;
      if (this.rebufferingStartedAt !== null) {
        const duration = eventTime(event) - this.rebufferingStartedAt;
        this.rebufferingDuration += duration;
        if (this.keys.bsd) {
          this.targets.forEach((target) => target.rebufferingDurations.push(duration));
        }
        this.eventMode.onRebufferingEnded(duration);
        this.rebufferingStartedAt = null;
      }
    });
    // Startup ends when playback begins. Without this, `su` is sent until the first seek or stall.
    on(events.Playing, (event?: PlayerEventBase) => {
      this.isSeekingOrTimeshiftingOrStartup = false;
      if (!this.hasStarted) {
        this.hasStarted = true;
        if (this.playRequestedAt !== null) {
          const startupDelay = eventTime(event) - this.playRequestedAt;
          if (!this.startupDelaySent) {
            this.pendingStartupDelay = startupDelay;
          }
          this.eventMode.onStartupDelay(startupDelay);
        }
      }
    });
    on(events.Seek, () => setSeeking(true));
    on(events.Seeked, () => setSeeking(false));
    on(events.TimeShift, () => setSeeking(true));
    on(events.TimeShifted, () => setSeeking(false));

    // Events for v2 keys only
    if (this.keys.sta || this.keys.msd || hasEventMode) {
      // Also fired for `PlaybackConfig.autoplay`, which calls `play()`
      on(events.Play, (event?: PlayerEventBase) => {
        if (!this.hasStarted && this.playRequestedAt === null) {
          this.playRequestedAt = eventTime(event);
        }
      });
    }
    if (this.keys.sta || this.keys.ec || hasEventMode) {
      // Errors are fatal. Warnings are not reported, as their codes overlap with error codes.
      on(events.Error, (event?: ErrorEvent) => {
        this.hasFatalError = true;
        if (event) {
          const errorCode = String(event.code);
          const addErrorCode = (target: CmcdTarget) => {
            if (target.errorCodes.indexOf(errorCode) === -1) {
              target.errorCodes.push(errorCode);
            }
          };
          if (this.keys.ec) {
            this.targets.forEach(addErrorCode);
          }
          this.eventMode.onError(errorCode);
        }
      });
    }

    if (hasEventMode) {
      this.eventMode.setPlayer(player, on);
    }
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
    this.playRequestedAt = null;
    this.hasStarted = false;
    this.isSeeking = false;
    this.hasFatalError = false;
    this.rebufferingStartedAt = null;
  }

  /** Clears all state that belongs to the previous session id. Known origins are kept as report destinations. */
  private resetSessionState() {
    this.targets.forEach((target) => {
      target.sequenceNumber = 0;
      target.rebufferingDurations = [];
      target.errorCodes = [];
    });
    // Not created yet when called by the constructor
    this.eventMode?.resetSession();
    this.pendingStartupDelay = null;
    this.startupDelaySent = false;
    // An ongoing rebuffering is counted in the new session from now on.
    this.rebufferingCount = this.rebufferingStartedAt === null ? 0 : 1;
    this.rebufferingStartedAt = this.rebufferingStartedAt === null ? null : Date.now();
    this.rebufferingDuration = 0;
    // The dropped frames of the current source so far belong to the previous session.
    this.droppedFramesOffset = -this.droppedFrames;
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
    const originalUrl = request.url;
    // An error must not fail the request, so it is sent without CMCD data.
    try {
      const data = this.gatherCmcdData(type, request);
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

    if (this.eventMode.isEnabled) {
      this.eventMode.onRequest(type, originalUrl, request.url);
    }
    return Promise.resolve(request);
  };

  public preprocessHttpResponse = (type: HttpRequestType, response: HttpResponse<HttpResponseBody>) => {
    if (this.eventMode.isEnabled) {
      this.eventMode.onResponse(type, response);
    }
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

  /** A new session id resets the v2 session state, e.g. `sn` and `bsa`. */
  public setSessionId(id: string): void {
    if (id !== this.sessionId) {
      this.resetSessionState();
    }
    this.sessionId = id;
  }

  /** Event Mode: a changed id is reported with event `c`. */
  public setContentId(id: string): void {
    const hasChanged = id !== this.contentId;
    this.contentId = id;
    if (hasChanged && this.eventMode.isEnabled) {
      this.eventMode.onContentIdChanged();
    }
  }

  /**
   * Event Mode: reports a custom event (`e=ce`) with the name `cen` of up to 64 characters
   * and optional custom keys.
   */
  public sendCustomEvent(name: string, customKeys: CmcdCustomKey[] = []): void {
    this.eventMode.sendCustomEvent(name, customKeys);
  }

  /**
   * Sends the pending Event Mode reports and removes all player and page listeners and timers.
   * Call it before the player is destroyed. The instance cannot be used afterwards.
   */
  public destroy(): void {
    this.removePlayerListeners();
    this.eventMode.destroy();
    this.player = undefined;
  }

  private removePlayerListeners() {
    for (const listener of this.listeners) {
      attempt(() => this.player?.off(listener.event, listener.callback));
    }
    this.listeners = [];
  }

  /** Event Mode: the keys of the state that this class tracks */
  private getEventStateData(): CmcdData {
    const data: CmcdData = { bsa: this.rebufferingCount, bsda: this.rebufferingDuration };
    if (this.isValidId('cid', this.contentId, CMCD_V2_EVENT_KEYS)) {
      data.cid = this.contentId;
    }
    if (this.isValidId('sid', this.sessionId, CMCD_V2_EVENT_KEYS)) {
      data.sid = this.sessionId;
    }
    if (this.manifestType) {
      data.sf = this.manifestType;
    }
    const mtp: CmcdTypedValue[] = [];
    if (this.lastMeasuredThroughputVideo > 0) {
      mtp.push({ value: this.lastMeasuredThroughputVideo, type: CmcdObjectTypeToken.VideoOnly });
    }
    if (this.lastMeasuredThroughputAudio > 0) {
      mtp.push({ value: this.lastMeasuredThroughputAudio, type: CmcdObjectTypeToken.AudioOnly });
    }
    if (mtp.length > 0) {
      data.mtp = mtp;
    }

    const player = this.player;
    if (!player) {
      return data;
    }
    attempt(() => {
      data.sta = this.getPlayState();
    });
    attempt(() => {
      data.dfa = this.getDroppedFramesOfSession();
    });
    if (this.hasStarted) {
      const isLive = !!attempt(() => player.isLive());
      attempt(() => {
        data.pt = this.getPlayheadTime(isLive);
      });
      attempt(() => {
        data.ltc = this.getLatency(isLive);
      });
    }
    return data;
  }

  private gatherCmcdData(type: HttpRequestType, request: HttpRequest): CmcdData {
    if (!this.player) {
      throw new Error('Bitmovin Player not provided!');
    }

    const data: CmcdData = {
      v: this.version,
      st: this.player.isLive() ? CmcdStreamTypeToken.Live : CmcdStreamTypeToken.Vod,
      // 0 before the first play and while paused
      pr: this.player.isPlaying() ? this.player.getPlaybackSpeed() : 0,
      ot: this.getObjectType(type),
    };

    const streamingFormat = this.getStreamingType(type);
    if (streamingFormat) {
      data.sf = streamingFormat;
    }

    if (this.isValidId('cid', this.contentId)) {
      data.cid = this.contentId;
    }

    if (this.isValidId('sid', this.sessionId)) {
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
    if (!isStartup && !isBufferStarvation && typeof data.br === 'number') {
      data.rtp = data.br * RTP_ENCODED_BITRATE_FACTOR;
    }

    // TODO: data.nrr = 'byte-range';

    this.addPlayerStateData(data, request);

    return data;
  }

  /** Adds the v2 keys that describe the player and session state. Only keys of the configured version are collected. */
  private addPlayerStateData(data: CmcdData, request: HttpRequest) {
    const player = this.player!;
    const target = this.targets.get(request.url);

    if (this.keys.sn) {
      data.sn = target.sequenceNumber++;
    }
    if (this.keys.bsd && target.rebufferingDurations.length > 0) {
      data.bsd = target.rebufferingDurations;
      target.rebufferingDurations = [];
    }
    if (this.keys.ec && target.errorCodes.length > 0) {
      data.ec = target.errorCodes;
      target.errorCodes = [];
    }
    if (this.keys.sta) {
      data.sta = this.getPlayState();
    }
    // Once per session id, with the first request after startup
    if (this.keys.msd && this.pendingStartupDelay !== null) {
      data.msd = this.pendingStartupDelay;
      this.pendingStartupDelay = null;
      this.startupDelaySent = true;
    }
    if (this.keys.bsa) {
      data.bsa = this.rebufferingCount;
    }
    if (this.keys.bsda) {
      data.bsda = this.rebufferingDuration;
    }

    if (!this.hasStarted) {
      return;
    }
    const isLive = player.isLive();
    if (this.keys.pt) {
      data.pt = this.getPlayheadTime(isLive);
    }
    if (this.keys.ltc) {
      data.ltc = this.getLatency(isLive);
    }
  }

  /**
   * Playhead time in ms. Live: absolute time, which is the wallclock time if the player knows it.
   * VOD: offset from the start of the asset.
   */
  private getPlayheadTime(isLive: boolean): number | undefined {
    const player = this.player!;
    const time = isLive ? player.getCurrentTime() : player.getCurrentTime('relativetime' as TimeMode);
    return Number.isFinite(time) ? time * 1000 : undefined;
  }

  /** Live latency in ms */
  private getLatency(isLive: boolean): number | undefined {
    const player = this.player!;
    if (!isLive || !player.lowlatency) {
      return undefined;
    }
    const latency = player.lowlatency.getLatency();
    return Number.isFinite(latency) && latency > 0 ? latency * 1000 : undefined;
  }

  /** Dropped frames since session start. The player counts per source. */
  private getDroppedFramesOfSession(): number | undefined {
    const droppedFrames = this.player!.getDroppedVideoFrames();
    if (!Number.isFinite(droppedFrames)) {
      return undefined;
    }
    this.droppedFrames = droppedFrames;
    return this.droppedFramesOffset + droppedFrames;
  }

  /** Play state as perceived by the user at request time */
  private getPlayState(): CmcdPlayStateToken {
    const player = this.player!;
    if (this.hasFatalError) {
      return CmcdPlayStateToken.FatalError;
    }
    if (player.hasEnded()) {
      return CmcdPlayStateToken.Ended;
    }
    if (!this.hasStarted) {
      const isAutoplay = !!player.getConfig().playback?.autoplay;
      return this.playRequestedAt !== null || isAutoplay ? CmcdPlayStateToken.Starting : CmcdPlayStateToken.Preloading;
    }
    if (this.isSeeking) {
      return CmcdPlayStateToken.Seeking;
    }
    if (player.isStalled()) {
      return CmcdPlayStateToken.Rebuffering;
    }
    if (player.isPaused()) {
      return CmcdPlayStateToken.Paused;
    }
    return CmcdPlayStateToken.Playing;
  }

  /** Ids longer than the maximum length of the key are omitted, as truncating could cause collisions. */
  private isValidId(key: 'cid' | 'sid', value: string, keys: CmcdKeyTable = this.keys): boolean {
    if (!value) {
      return false;
    }
    const maxLength = keys[key].maxLength;
    if (value.length <= maxLength) {
      return true;
    }
    this.warnOnce(`CMCD: '${key}' value '${value}' exceeds ${maxLength} characters and is not sent.`);
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
      if (this.keys.tbl) {
        data.tbl = buffer.targetLevel * 1000;
      }
    }

    const qualities = isAudio ? this.player.getAvailableAudioQualities() : this.player.getAvailableVideoQualities();
    const topBitrate = qualities.reduce((prev, current) => Math.max(prev, current.bitrate), 0) / 1000;
    if (topBitrate > 0) {
      data.tb = topBitrate;
    }
    if (this.keys.lb) {
      const lowestBitrate = qualities.reduce(
        (prev, current) => (current.bitrate > 0 ? Math.min(prev, current.bitrate) : prev),
        Infinity
      );
      if (lowestBitrate !== Infinity) {
        data.lb = lowestBitrate / 1000;
      }
    }
    if (this.keys.pb) {
      const playbackData = isAudio ? this.player.getPlaybackAudioData() : this.player.getPlaybackVideoData();
      if (playbackData && playbackData.bitrate > 0) {
        data.pb = playbackData.bitrate / 1000;
      }
    }
    if (this.keys.dfa && !isAudio) {
      data.dfa = this.getDroppedFramesOfSession();
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
