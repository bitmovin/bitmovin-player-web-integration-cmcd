/**
 * CMCD v2 Event Mode: turns player events, responses and API calls into reports for the configured targets.
 * The integration provides the state keys, which it collects for Request Mode as well.
 */

import {
  AudioDownloadQualityChangedEvent,
  HttpRequest,
  HttpRequestType,
  HttpResponse,
  HttpResponseBody,
  PlayerAPI,
  PlayerEvent,
  PlayerEventBase,
  VideoDownloadQualityChangedEvent,
} from 'bitmovin-player';
import {
  CmcdCustomKey,
  CmcdData,
  CmcdEventType,
  CmcdObjectTypeToken,
  CmcdPlayStateToken,
  CmcdTypedValue,
  CmcdVersionNumbers,
} from './Cmcd';
import { CmcdEventReporter, CmcdEventTarget } from './CmcdEventTarget';

/** State that the integration tracks */
export interface CmcdEventSource {
  /** State keys, including the media keys per object type, except `br` */
  getStateData(): CmcdData;
  getPlayState(): CmcdPlayStateToken;
}

export type CmcdPlayerEventRegistration = <T extends PlayerEventBase>(
  event: PlayerEvent,
  callback: (event?: T) => void
) => void;

/** `cen`: printable ASCII, max. 64 characters */
const CUSTOM_EVENT_NAME_REGEX = /^[\x20-\x7e]{1,64}$/;
const MAX_HOSTNAME_LENGTH = 128;
/** Manifest (without ads) and audio and video segment requests, by `HttpRequestType` value */
const CONTENT_REQUEST_TYPE_REGEX = /^(manifest\/(dash|hls|smooth)|media\/(audio|video))/;

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
  let value = '';
  Object.keys(headers || {}).forEach((key) => {
    if (key.toLowerCase() === lowerName) {
      value = headers![key];
    }
  });
  return value ? attempt(() => btoa(value)) : undefined;
}

/** Seconds to ms, or `undefined` if not a valid duration. 0 is unknown. */
function toMilliseconds(seconds: number | undefined): number | undefined {
  return typeof seconds === 'number' && isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export class CmcdEventMode {
  public readonly targets: CmcdEventReporter[] = [];
  public readonly isEnabled: boolean = false;
  private player?: PlayerAPI;
  /** Last reported play state, `null` if none for the current source */
  private playState: CmcdPlayStateToken | null = null;
  /** Hostname of the last manifest or media request */
  private hostname: string | null = null;
  /** Bitrates of the last download quality changes, in bps */
  private downloadBitrates: { audio?: number; video?: number } = {};
  private isAdBreakActive = false;
  private isAdActive = false;
  /** Start time and URL before CMCD per request. The player passes the same object for retries. */
  private requests = new WeakMap<HttpRequest, { url: string; time: number }>();
  private pageListeners: { target: EventTarget; event: string; callback: () => void }[] = [];

  constructor(
    configs: CmcdEventTarget[],
    private readonly source: CmcdEventSource,
    private readonly warn: (message: string) => void
  ) {
    if (configs.length === 0) {
      return;
    }
    if (typeof fetch !== 'function') {
      warn('CMCD: Event Mode disabled, fetch not available');
      return;
    }
    for (const config of configs) {
      if (config && typeof config.url === 'string' && config.url) {
        this.targets.push(new CmcdEventReporter(config, warn));
      } else {
        warn('CMCD: event target without url ignored');
      }
    }

    this.isEnabled = this.targets.length > 0;
    if (this.isEnabled && typeof window !== 'undefined' && typeof document !== 'undefined') {
      // Last chance to send before the page is closed or frozen
      const flushNow = () => this.flush(true);
      this.addPageListener(window, 'pagehide', flushNow);
      this.addPageListener(document, 'visibilitychange', () => {
        // Entered (with `bg`) or left (without `bg`) the backgrounded mode
        this.report('b', Date.now());
        if (document.visibilityState === 'hidden') {
          flushNow();
        }
      });
      this.addPageListener(window, 'online', () => this.flush(false));
    }
  }

  /** Registers the player listeners with `on`, which the integration removes when the player changes. */
  public setPlayer(player: PlayerAPI, on: CmcdPlayerEventRegistration): void {
    this.player = player;
    const events = player.exports.PlayerEvent;
    const report = (type: CmcdEventType) => (event?: PlayerEventBase) => this.report(type, this.timeOf(event));
    const onPlayStateEvent = (event?: PlayerEventBase) => this.reportPlayState(event);

    const startIntervals = () =>
      this.targets.forEach((target) =>
        target.startInterval(() => {
          this.report('t', Date.now(), {}, undefined, [], target);
          target.flush();
        })
      );

    on(events.SourceLoaded, (event?: PlayerEventBase) => {
      startIntervals();
      this.reportPlayState(event);
    });
    on(events.SourceUnloaded, () => {
      this.targets.forEach((target) => target.stopInterval());
      this.playState = null;
      this.downloadBitrates = {};
      this.flush(true);
    });
    for (const event of [
      events.Play,
      events.Playing,
      events.Paused,
      events.Seek,
      events.Seeked,
      events.TimeShift,
      events.TimeShifted,
      events.StallEnded,
      events.PlaybackFinished,
    ]) {
      on(event, onPlayStateEvent);
    }
    on(events.StallStarted, (event?: PlayerEventBase) => {
      this.reportPlayState(event);
      // After the `ps` report, which does not carry `bs` yet
      if (this.playState === CmcdPlayStateToken.Rebuffering) {
        this.targets.forEach((target) => target.markStarved());
      }
    });
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
      startIntervals();
    }
  }

  public onContentIdChanged(): void {
    this.report('c', Date.now());
  }

  public sendCustomEvent(name: string, customKeys: CmcdCustomKey[]): void {
    if (typeof name !== 'string' || !CUSTOM_EVENT_NAME_REGEX.test(name)) {
      this.warn(`CMCD: custom event name '${name}' not sent, needs 1 to 64 printable ASCII characters`);
      return;
    }
    this.report('ce', Date.now(), { cen: name }, undefined, Array.isArray(customKeys) ? customKeys : []);
  }

  /** Tracks requests for `rr` reports and the hostname for `h`. */
  public onRequest(type: HttpRequestType, request: HttpRequest, originalUrl: string): void {
    try {
      const time = Date.now();
      // A retry keeps the first start time and URL.
      if (!this.requests.has(request)) {
        this.requests.set(request, { url: originalUrl, time });
      }

      if (!CONTENT_REQUEST_TYPE_REGEX.test(type)) {
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
      this.fail(error);
    }
  }

  /** `objectType` of the request */
  public onResponse(response: HttpResponse<HttpResponseBody>, objectType: CmcdObjectTypeToken): void {
    try {
      const request = response.request;
      const pending = request ? this.requests.get(request) : undefined;
      const data: CmcdData = { ot: objectType };
      if (typeof response.status === 'number') {
        data.rc = response.status;
      }
      const elapsedMs = toMilliseconds(response.elapsedTime);
      data.ttlb = elapsedMs;
      data.ttfb = toMilliseconds(response.timeToFirstByte);
      data.cmsdd = headerToBase64(response.headers, 'CMSD-Dynamic');
      data.cmsds = headerToBase64(response.headers, 'CMSD-Static');

      // `ts` is the request start.
      const time = pending ? pending.time : Date.now() - (elapsedMs || 0);
      this.report('rr', time, data, pending ? pending.url : request ? request.url : response.url);
    } catch (error) {
      this.fail(error);
    }
  }

  /** Sends the queued reports of all targets. `force` ignores pending requests and retry delays. */
  public flush(force: boolean): void {
    this.targets.forEach((target) => target.flush(force));
  }

  /** Sends the queued reports, then stops all targets and removes the page listeners. */
  public destroy(): void {
    this.targets.forEach((target) => target.destroy());
    for (const listener of this.pageListeners) {
      listener.target.removeEventListener(listener.event, listener.callback);
    }
    this.pageListeners = [];
    this.player = undefined;
  }

  private fail(error: unknown) {
    this.warn(`CMCD: event report failed: ${error}`);
  }

  private addPageListener(target: EventTarget, event: string, callback: () => void) {
    this.pageListeners.push({ target, event, callback });
    target.addEventListener(event, callback);
  }

  private timeOf(event?: PlayerEventBase): number {
    return (event && event.timestamp) || Date.now();
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
    onlyTarget?: CmcdEventReporter
  ) {
    try {
      const targets = (onlyTarget ? [onlyTarget] : this.targets).filter((target) => target.reports(type));
      if (targets.length === 0) {
        return;
      }
      const snapshot = this.gatherSnapshot();
      for (const target of targets) {
        target.report(
          Object.assign({}, snapshot, eventData, { e: type, ts: time, v: CmcdVersionNumbers.v2 }),
          requestUrl,
          customKeys
        );
      }
    } catch (error) {
      this.fail(error);
    }
  }

  /** Keys that describe the player and session state, the same for all targets */
  private gatherSnapshot(): CmcdData {
    const data: CmcdData = attempt(() => this.source.getStateData()) || {};
    if (this.hostname && this.hostname.length <= MAX_HOSTNAME_LENGTH) {
      data.h = this.hostname;
    }
    // `br` of the selected (downloaded) quality, not of a requested object
    const player = this.player;
    const br: CmcdTypedValue[] = [];
    (['video', 'audio'] as const).forEach((mediaType) => {
      const isAudio = mediaType === 'audio';
      const bitrate =
        this.downloadBitrates[mediaType] ??
        attempt(() => (isAudio ? player!.getDownloadedAudioData() : player!.getDownloadedVideoData()).bitrate);
      if (typeof bitrate === 'number' && bitrate > 0) {
        br.push({
          value: bitrate / 1000,
          type: isAudio ? CmcdObjectTypeToken.AudioOnly : CmcdObjectTypeToken.VideoOnly,
        });
      }
    });
    if (br.length > 0) {
      data.br = br;
    }
    return data;
  }
}
