/**
 * CMCD v2 Event Mode: configuration and state of one report destination.
 */

import { CmcdCustomKey, CmcdData, cmcdDataToEventRecord, CmcdEventType } from './Cmcd';
import { CmcdEventReporter, CmcdTransport } from './CmcdEventReporter';

/**
 * Part of the request URL that is sent in the `url` key of `rr` reports:
 * - `full`: without the fragment
 * - `noQuery`: without query and fragment
 * - `origin`: scheme, host and port
 * - a function that returns the value to send, or `null` to omit the key
 */
export type CmcdUrlFilter = 'full' | 'noQuery' | 'origin' | ((url: string) => string | null);

/** v2 Event Mode report destination */
export interface CmcdEventTarget {
  /** Endpoint the reports are sent to with HTTP POST */
  url: string;
  /** Events to report. Default: `ps`, `e`, `t` and `rr`. */
  events?: CmcdEventType[];
  /**
   * Keys to send. Default: all collected keys. `e`, `ts`, `v`, `sid`, `cid` and the key that an event
   * requires (`sta` for `ps`, `ec` for `e`, `cen` for `ce`, `url` for `rr`, `h` for `h`) are always sent.
   */
  keys?: string[];
  /** Interval of `t` reports and of sending batched reports in ms. Default: 30000. 0 disables both. */
  intervalMs?: number;
  /** Number of reports sent in one request. Default: 1. */
  batchSize?: number;
  /** Value of the `Authorization` request header */
  authorization?: string;
  /** Custom keys added to all reports of this target. The header type is not used. */
  customKeys?: CmcdCustomKey[];
  /** Part of the request URL sent in the `url` key. Default: `noQuery`. */
  urlFilter?: CmcdUrlFilter;
}

const DEFAULT_EVENTS: CmcdEventType[] = ['ps', 'e', 't', 'rr'];
const DEFAULT_INTERVAL_MS = 30000;
/** Sent in all reports, independent of the key filter */
const MANDATORY_KEYS = ['e', 'ts', 'v', 'sid', 'cid'];
/** Key that an event type requires, independent of the key filter */
const EVENT_REQUIRED_KEY: { [event: string]: string } = { ps: 'sta', e: 'ec', ce: 'cen', rr: 'url', h: 'h' };

/** The part of `url` that `filter` allows, or `null` */
export function filterUrl(url: string, filter: CmcdUrlFilter): string | null {
  if (typeof filter === 'function') {
    return filter(url);
  }
  const parsed = new URL(url);
  if (filter === 'origin') {
    return parsed.origin;
  }
  if (filter !== 'full') {
    parsed.search = '';
  }
  parsed.hash = '';
  return parsed.href;
}

export class CmcdEventTargetState {
  public readonly reporter: CmcdEventReporter;
  private readonly events: CmcdEventType[];
  /** `null` for all keys */
  private readonly keys: string[] | null;
  private readonly intervalMs: number;
  private readonly customKeys: CmcdCustomKey[];
  private readonly urlFilter: CmcdUrlFilter;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  // Session state, reset on a new session id
  private sequenceNumber = 0;
  /** `bsd` to send with the next report */
  private rebufferingDurations: number[] = [];
  /** `ec` to send with the next report */
  private errorCodes: string[] = [];
  /** `msd` to send with the next report */
  private pendingStartupDelay: number | null = null;
  private startupDelaySent = false;
  /** Rebuffering since the prior report (`bs`) */
  private starved = false;

  /** Expects a validated `config.url`. Invalid optional settings fall back to their default. */
  constructor(config: CmcdEventTarget, transport: CmcdTransport, warn: (message: string) => void) {
    const { intervalMs, batchSize } = config;
    this.events = Array.isArray(config.events) ? config.events : DEFAULT_EVENTS;
    this.keys = Array.isArray(config.keys) ? config.keys : null;
    this.intervalMs =
      typeof intervalMs === 'number' && isFinite(intervalMs) && intervalMs >= 0 ? intervalMs : DEFAULT_INTERVAL_MS;
    this.customKeys = Array.isArray(config.customKeys) ? config.customKeys : [];
    this.urlFilter = config.urlFilter || 'noQuery';
    this.reporter = new CmcdEventReporter(
      config.url,
      {
        batchSize: typeof batchSize === 'number' && batchSize >= 1 ? Math.floor(batchSize) : 1,
        authorization: config.authorization,
      },
      transport,
      warn
    );
  }

  public reports(type: CmcdEventType): boolean {
    return !this.reporter.isStopped && this.events.indexOf(type) !== -1;
  }

  public addRebuffering(duration: number): void {
    this.rebufferingDurations.push(duration);
  }

  public addErrorCode(code: string): void {
    if (this.errorCodes.indexOf(code) === -1) {
      this.errorCodes.push(code);
    }
  }

  /** Sent once per session id */
  public setStartupDelay(delay: number): void {
    if (!this.startupDelaySent) {
      this.pendingStartupDelay = delay;
    }
  }

  public resetSession(): void {
    this.sequenceNumber = 0;
    this.rebufferingDurations = [];
    this.errorCodes = [];
    this.pendingStartupDelay = null;
    this.startupDelaySent = false;
    this.starved = false;
  }

  /** Calls `onTick` every `intervalMs`, unless it is 0. */
  public startInterval(onTick: () => void): void {
    if (this.intervalMs > 0 && this.intervalTimer === null && !this.reporter.isStopped) {
      this.intervalTimer = setInterval(onTick, this.intervalMs);
    }
  }

  public stopInterval(): void {
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  /**
   * Queues the report of `data`, which holds the event and state keys. Adds `sn`, the buffered keys
   * (consumed, also if filtered) and `url` from `requestUrl`, then applies the key filter.
   * `isRebuffering`: the player is rebuffering after this report, so the next one carries `bs`.
   */
  public report(data: CmcdData, isRebuffering: boolean, requestUrl?: string, customKeys: CmcdCustomKey[] = []): void {
    data.sn = this.sequenceNumber++;
    if (this.rebufferingDurations.length > 0) {
      data.bsd = this.rebufferingDurations;
      this.rebufferingDurations = [];
    }
    if (this.errorCodes.length > 0) {
      data.ec = this.errorCodes;
      this.errorCodes = [];
    }
    if (this.pendingStartupDelay !== null) {
      data.msd = this.pendingStartupDelay;
      this.pendingStartupDelay = null;
      this.startupDelaySent = true;
    }
    // The report that starts a rebuffering does not carry `bs` yet.
    if (this.starved) {
      data.bs = true;
    }
    this.starved = isRebuffering;

    if (requestUrl) {
      let url: string | null = null;
      try {
        url = filterUrl(requestUrl, this.urlFilter);
      } catch {
        // Not sent
      }
      if (url) {
        data.url = url;
      }
    }
    this.filterKeys(data);
    this.reporter.add(cmcdDataToEventRecord(data, this.customKeys.concat(customKeys)));
  }

  public flush(force = false): void {
    this.reporter.flush(force);
  }

  public stop(): void {
    this.stopInterval();
    this.reporter.stop();
  }

  /** Removes the keys that the target does not want, except the mandatory ones. */
  private filterKeys(data: CmcdData): void {
    if (!this.keys) {
      return;
    }
    const requiredKey = data.e ? EVENT_REQUIRED_KEY[data.e] : undefined;
    for (const key of Object.keys(data) as (keyof CmcdData)[]) {
      if (this.keys.indexOf(key) === -1 && MANDATORY_KEYS.indexOf(key) === -1 && key !== requiredKey) {
        delete data[key];
      }
    }
  }
}
