/**
 * CMCD v2 Event Mode: turns player events, responses and API calls into reports for the configured targets.
 *
 * The integration provides the state it tracks for Request Mode as well (ids, play state, rebuffering,
 * playhead, throughput). This module reads the remaining keys from the player.
 */

import {
  AudioDownloadQualityChangedEvent,
  HttpRequestType,
  HttpResponse,
  HttpResponseBody,
  PlayerAPI,
  PlayerEvent,
  PlayerEventBase,
  VideoDownloadQualityChangedEvent,
} from 'bitmovin-player';
import {
  CMCD_V2_EVENT_KEYS,
  CmcdCustomKey,
  CmcdData,
  CmcdEventType,
  CmcdObjectTypeToken,
  CmcdPlayStateToken,
  CmcdStreamTypeToken,
  CmcdTypedValue,
  CmcdVersionNumbers,
} from './Cmcd';
import { CmcdTransport } from './CmcdEventReporter';
import { CmcdEventTarget, CmcdEventTargetState } from './CmcdEventTarget';

/** Dependencies that tests replace */
export interface CmcdEnvironment {
  /** Default: `fetch` */
  transport?: CmcdTransport;
  /** Default: `Date.now` */
  now?: () => number;
}

/** State that the integration tracks */
export interface CmcdEventSource {
  /** `cid`, `sid`, `sf`, `sta`, `bsa`, `bsda`, `dfa`, `pt`, `ltc` and `mtp`, as far as known */
  getStateData(): CmcdData;
  getPlayState(): CmcdPlayStateToken;
  isRebuffering(): boolean;
  getObjectType(type: HttpRequestType): CmcdObjectTypeToken;
}

export type CmcdPlayerEventRegistration = <T extends PlayerEventBase>(
  event: PlayerEvent,
  callback: (event?: T) => void
) => void;

/** Maximum number of requests waiting for their response, to correlate `rr` reports */
const MAX_PENDING_REQUESTS = 64;
const MAX_CUSTOM_EVENT_NAME_LENGTH = 64;

/** Runs `fn` and returns its result, or `undefined` if it throws. */
export function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Base64 of the header value (case-insensitive name), or `undefined` */
function headerToBase64(headers: { [name: string]: string } | undefined, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === lowerName && headers![key]) {
      return attempt(() => btoa(headers![key]));
    }
  }
  return undefined;
}

/** Seconds to ms, or `undefined` if not a valid duration */
function toMilliseconds(seconds: number | undefined): number | undefined {
  return typeof seconds === 'number' && isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export class CmcdEventMode {
  private readonly targets: CmcdEventTargetState[] = [];
  private readonly now: () => number;
  private player?: PlayerAPI;
  /** Last reported play state, `null` if none for the current source */
  private playState: CmcdPlayStateToken | null = null;
  /** Hostname of the last manifest or media request */
  private hostname: string | null = null;
  /** Bitrates of the last download quality changes, in bps */
  private downloadBitrates: { audio?: number; video?: number } = {};
  private isAdBreakActive = false;
  private isAdActive = false;
  /** Request start time and URL before CMCD was added, by the URL of the sent request */
  private pendingRequests = new Map<string, { url: string; time: number }>();
  private pageListeners: { target: EventTarget; event: string; callback: () => void }[] = [];

  constructor(
    configs: CmcdEventTarget[],
    private readonly source: CmcdEventSource,
    environment: CmcdEnvironment,
    private readonly warn: (message: string) => void
  ) {
    this.now = environment.now || (() => Date.now());
    if (configs.length === 0) {
      return;
    }
    let transport = environment.transport;
    if (!transport) {
      if (typeof fetch !== 'function') {
        warn('CMCD: Event Mode is disabled, as fetch is not available.');
        return;
      }
      transport = (url, request) => fetch(url, request);
    }
    for (const config of configs) {
      if (config && typeof config.url === 'string' && config.url) {
        this.targets.push(new CmcdEventTargetState(config, transport, warn));
      } else {
        warn('CMCD: an event target without url is ignored.');
      }
    }

    if (this.targets.length > 0 && typeof window !== 'undefined' && typeof document !== 'undefined') {
      // Last chance to send before the page is closed or frozen
      const flushNow = () => this.flush(true);
      this.addPageListener(window, 'pagehide', flushNow);
      this.addPageListener(document, 'visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          flushNow();
        }
      });
      this.addPageListener(window, 'online', () => this.flush(false));
    }
  }

  public get isEnabled(): boolean {
    return this.targets.length > 0;
  }

  /** Registers the player listeners with `on`, which the integration removes when the player changes. */
  public setPlayer(player: PlayerAPI, on: CmcdPlayerEventRegistration): void {
    this.player = player;
    const events = player.exports.PlayerEvent;
    const report = (type: CmcdEventType) => (event?: PlayerEventBase) => this.report(type, this.timeOf(event));
    const onPlayStateEvent = (event?: PlayerEventBase) => this.reportPlayState(event);
    const endSource = () => {
      this.stopIntervals();
      this.playState = null;
      this.downloadBitrates = {};
      this.flush(true);
    };

    on(events.SourceLoaded, (event?: PlayerEventBase) => {
      this.startIntervals();
      this.reportPlayState(event);
    });
    on(events.SourceUnloaded, endSource);
    on(events.Destroy, endSource);
    for (const event of [
      events.Play,
      events.Playing,
      events.Paused,
      events.Seek,
      events.Seeked,
      events.TimeShift,
      events.TimeShifted,
      events.StallStarted,
      events.StallEnded,
      events.PlaybackFinished,
    ]) {
      on(event, onPlayStateEvent);
    }
    // The integration buffers the error code (`ec`) before.
    on(events.Error, (event?: PlayerEventBase) => {
      this.report('e', this.timeOf(event));
      this.reportPlayState(event);
    });
    on(events.Muted, report('m'));
    on(events.Unmuted, report('um'));

    const onDownloadQualityChanged =
      (mediaType: 'audio' | 'video') =>
      (event?: VideoDownloadQualityChangedEvent | AudioDownloadQualityChangedEvent) => {
        if (!event || !event.targetQuality) {
          return;
        }
        this.downloadBitrates[mediaType] = event.targetQuality.bitrate;
        // The first quality of a source is no change.
        if (event.sourceQualityId) {
          this.report('bc', this.timeOf(event));
        }
      };
    on(events.VideoDownloadQualityChanged, onDownloadQualityChanged('video'));
    on(events.AudioDownloadQualityChanged, onDownloadQualityChanged('audio'));

    // `ae` and `abe` only follow a reported `as` and `abs`.
    const endAd = (event?: PlayerEventBase) => {
      if (this.isAdActive) {
        this.isAdActive = false;
        this.report('ae', this.timeOf(event));
      }
    };
    on(events.AdBreakStarted, (event?: PlayerEventBase) => {
      this.isAdBreakActive = true;
      this.report('abs', this.timeOf(event));
    });
    on(events.AdStarted, (event?: PlayerEventBase) => {
      this.isAdActive = true;
      this.report('as', this.timeOf(event));
    });
    on(events.AdSkipped, (event?: PlayerEventBase) => {
      this.report('sk', this.timeOf(event));
      endAd(event);
    });
    on(events.AdFinished, endAd);
    on(events.AdError, endAd);
    on(events.AdBreakFinished, (event?: PlayerEventBase) => {
      endAd(event);
      if (this.isAdBreakActive) {
        this.isAdBreakActive = false;
        this.report('abe', this.timeOf(event));
      }
    });

    // The source may be loaded before `setPlayer`.
    if (attempt(() => player.getSource())) {
      this.startIntervals();
    }
  }

  public onRebufferingEnded(duration: number): void {
    this.targets.forEach((target) => target.addRebuffering(duration));
  }

  public onError(code: string): void {
    this.targets.forEach((target) => target.addErrorCode(code));
  }

  public onStartupDelay(delay: number): void {
    this.targets.forEach((target) => target.setStartupDelay(delay));
  }

  public resetSession(): void {
    this.targets.forEach((target) => target.resetSession());
  }

  public onContentIdChanged(): void {
    this.report('c', this.now());
  }

  public sendCustomEvent(name: string, customKeys: CmcdCustomKey[]): void {
    if (typeof name !== 'string' || !name || name.length > MAX_CUSTOM_EVENT_NAME_LENGTH) {
      this.warn(`CMCD: custom event name '${name}' is empty or exceeds 64 characters and is not sent.`);
      return;
    }
    this.report('ce', this.now(), { cen: name }, undefined, Array.isArray(customKeys) ? customKeys : []);
  }

  /** Tracks requests for `rr` reports and the hostname for `h`. `sentUrl` includes CMCD in query mode. */
  public onRequest(type: HttpRequestType, originalUrl: string, sentUrl: string): void {
    try {
      const time = this.now();
      if (this.reportsEvent('rr')) {
        if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
          this.pendingRequests.delete(this.pendingRequests.keys().next().value as string);
        }
        this.pendingRequests.set(sentUrl, { url: originalUrl, time });
      }

      const requestTypes = this.player?.exports.HttpRequestType;
      const contentRequestTypes = requestTypes
        ? [
            requestTypes.MANIFEST_DASH,
            requestTypes.MANIFEST_HLS_MASTER,
            requestTypes.MANIFEST_HLS_VARIANT,
            requestTypes.MANIFEST_SMOOTH,
            requestTypes.MEDIA_AUDIO,
            requestTypes.MEDIA_VIDEO,
          ]
        : [];
      if (contentRequestTypes.indexOf(type) === -1) {
        return;
      }
      const hostname = new URL(originalUrl).hostname;
      if (hostname && hostname !== this.hostname) {
        // The first hostname is no change.
        const hasChanged = this.hostname !== null;
        this.hostname = hostname;
        if (hasChanged) {
          this.report('h', time);
        }
      }
    } catch (error) {
      this.warn(`CMCD: event report failed: ${error}`);
    }
  }

  public onResponse(type: HttpRequestType, response: HttpResponse<HttpResponseBody>): void {
    try {
      const sentUrl = response.request ? response.request.url : response.url;
      const pending = this.pendingRequests.get(sentUrl);
      this.pendingRequests.delete(sentUrl);
      if (!this.reportsEvent('rr')) {
        return;
      }

      const data: CmcdData = { ot: this.source.getObjectType(type) };
      if (typeof response.status === 'number') {
        data.rc = response.status;
      }
      const elapsedMs = toMilliseconds(response.elapsedTime);
      if (elapsedMs !== undefined) {
        data.ttlb = elapsedMs;
      }
      const timeToFirstByteMs = toMilliseconds(response.timeToFirstByte);
      if (timeToFirstByteMs !== undefined) {
        data.ttfb = timeToFirstByteMs;
      }
      data.cmsdd = headerToBase64(response.headers, 'CMSD-Dynamic');
      data.cmsds = headerToBase64(response.headers, 'CMSD-Static');

      // `ts` is the request start.
      const time = pending ? pending.time : this.now() - (elapsedMs || 0);
      this.report('rr', time, data, pending ? pending.url : sentUrl);
    } catch (error) {
      this.warn(`CMCD: event report failed: ${error}`);
    }
  }

  /** Sends the queued reports of all targets. `force` ignores pending requests and retry delays. */
  public flush(force: boolean): void {
    this.targets.forEach((target) => target.flush(force));
  }

  /** Sends the queued reports, then stops all targets and removes the page listeners. */
  public destroy(): void {
    this.flush(true);
    this.targets.forEach((target) => target.stop());
    for (const listener of this.pageListeners) {
      listener.target.removeEventListener(listener.event, listener.callback);
    }
    this.pageListeners = [];
    this.pendingRequests.clear();
    this.player = undefined;
  }

  private addPageListener(target: EventTarget, event: string, callback: () => void) {
    this.pageListeners.push({ target, event, callback });
    target.addEventListener(event, callback);
  }

  private startIntervals() {
    this.targets.forEach((target) =>
      target.startInterval(() => {
        this.report('t', this.now(), {}, undefined, [], target);
        target.flush();
      })
    );
  }

  private stopIntervals() {
    this.targets.forEach((target) => target.stopInterval());
  }

  private timeOf(event?: PlayerEventBase): number {
    return (event && event.timestamp) || this.now();
  }

  private reportsEvent(type: CmcdEventType): boolean {
    return this.targets.some((target) => target.reports(type));
  }

  /** Reports `ps` if the play state differs from the last reported one. */
  private reportPlayState(event?: PlayerEventBase) {
    const playState = attempt(() => this.source.getPlayState());
    if (playState && playState !== this.playState) {
      this.playState = playState;
      this.report('ps', this.timeOf(event), { sta: playState });
    }
  }

  /** Queues the report of an event for all targets that report it, or only for `onlyTarget`. Never throws. */
  private report(
    type: CmcdEventType,
    time: number,
    eventData: CmcdData = {},
    requestUrl?: string,
    customKeys: CmcdCustomKey[] = [],
    onlyTarget?: CmcdEventTargetState
  ) {
    try {
      const targets = (onlyTarget ? [onlyTarget] : this.targets).filter((target) => target.reports(type));
      if (targets.length === 0) {
        return;
      }
      const snapshot = this.gatherSnapshot();
      const isRebuffering = !!attempt(() => this.source.isRebuffering());
      for (const target of targets) {
        const data: CmcdData = { ...snapshot, ...eventData, e: type, ts: time, v: CmcdVersionNumbers.v2 };
        target.report(data, isRebuffering, requestUrl, customKeys);
      }
    } catch (error) {
      this.warn(`CMCD: event report failed: ${error}`);
    }
  }

  /** Keys that describe the player and session state, the same for all targets */
  private gatherSnapshot(): CmcdData {
    const data: CmcdData = attempt(() => this.source.getStateData()) || {};
    if (this.hostname && this.hostname.length <= CMCD_V2_EVENT_KEYS.h!.maxLength!) {
      data.h = this.hostname;
    }
    const player = this.player;
    if (!player) {
      return data;
    }
    attempt(() => {
      data.st = player.isLive() ? CmcdStreamTypeToken.Live : CmcdStreamTypeToken.Vod;
    });
    attempt(() => {
      data.pr = player.isPlaying() ? player.getPlaybackSpeed() : 0;
    });
    this.addMediaData(data, player, 'video');
    this.addMediaData(data, player, 'audio');
    return data;
  }

  /** Adds the bitrate and buffer keys of a media type, with the object type as parameter. */
  private addMediaData(data: CmcdData, player: PlayerAPI, mediaType: 'audio' | 'video') {
    const isAudio = mediaType === 'audio';
    const type = isAudio ? CmcdObjectTypeToken.AudioOnly : CmcdObjectTypeToken.VideoOnly;
    const add = (key: 'bl' | 'br' | 'lb' | 'pb' | 'tb' | 'tbl', value: number | undefined, allowZero = false) => {
      if (typeof value === 'number' && isFinite(value) && (value > 0 || (allowZero && value === 0))) {
        data[key] = ((data[key] as CmcdTypedValue[] | undefined) || []).concat({ value, type });
      }
    };

    attempt(() => {
      const buffer = player.buffer.getLevel(
        player.exports.BufferType.ForwardDuration,
        isAudio ? player.exports.MediaType.Audio : player.exports.MediaType.Video
      );
      if (buffer.targetLevel > 0) {
        add('bl', buffer.level * 1000, true);
        add('tbl', buffer.targetLevel * 1000);
      }
    });
    const downloadBitrate =
      this.downloadBitrates[mediaType] ??
      attempt(() => (isAudio ? player.getDownloadedAudioData() : player.getDownloadedVideoData()).bitrate);
    add('br', downloadBitrate !== undefined ? downloadBitrate / 1000 : undefined);
    add(
      'pb',
      attempt(() => (isAudio ? player.getPlaybackAudioData() : player.getPlaybackVideoData()).bitrate / 1000)
    );
    const bitrates =
      attempt(() =>
        (isAudio ? player.getAvailableAudioQualities() : player.getAvailableVideoQualities())
          .map((quality) => quality.bitrate)
          .filter((bitrate) => bitrate > 0)
      ) || [];
    if (bitrates.length > 0) {
      add('tb', Math.max.apply(null, bitrates) / 1000);
      add('lb', Math.min.apply(null, bitrates) / 1000);
    }
  }
}
