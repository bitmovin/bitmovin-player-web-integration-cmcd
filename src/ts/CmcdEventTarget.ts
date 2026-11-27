/**
 * CMCD v2 Event Mode: one report destination. Builds its records and sends them as `application/cmcd` POST body.
 */

import {
  CMCD_V2_EVENT_KEYS,
  CmcdCustomKey,
  CmcdData,
  cmcdDataToEventRecord,
  cmcdEventRecordsToBody,
  CmcdEventType,
  CmcdPlayStateToken,
} from './Cmcd';
import { CmcdDestinationState } from './CmcdDestinationState';

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
  /**
   * Interval of `t` reports and of sending batched reports in ms, min. 1000. Default: 30000.
   * 0 disables both.
   */
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
const MIN_INTERVAL_MS = 1000;
/** Sent in all reports, independent of the key filter */
const MANDATORY_KEYS = ['e', 'ts', 'v', 'sid', 'cid'];
/** Key that an event type requires, independent of the key filter */
const EVENT_REQUIRED_KEY: { [event: string]: string } = { ps: 'sta', e: 'ec', ce: 'cen', rr: 'url', h: 'h' };

/** Maximum number of queued records. The oldest record is dropped. */
export const MAX_QUEUED_RECORDS = 200;
/** First retry delay after a 429, 5xx or network error. Doubles with each further failure. */
export const RETRY_BASE_DELAY_MS = 2000;
export const RETRY_MAX_DELAY_MS = 120000;
/** A request without response after this time is aborted and retried. */
export const REQUEST_TIMEOUT_MS = 10000;
/** Browsers limit the bodies of all pending keepalive requests to 64 KiB in total. */
export const KEEPALIVE_BUDGET_BYTES = 64000;

/** Body bytes of the pending keepalive requests of all targets. Records are ASCII, so length = bytes. */
let keepaliveBytesInFlight = 0;

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

/** Delay of a `Retry-After` header (seconds or HTTP date) in ms, 0 if none */
function getRetryAfter(response: Response): number {
  let value: string | null = null;
  try {
    value = response.headers.get('Retry-After');
  } catch {
    // No headers
  }
  if (!value) {
    return 0;
  }
  const seconds = Number(value);
  const delay = isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return delay > 0 ? delay : 0;
}

export class CmcdEventReporter {
  /** `sn`, `bsd`, `ec` and `msd` */
  public readonly state = new CmcdDestinationState();
  private readonly url: string;
  private readonly events: CmcdEventType[];
  /** `null` for all keys */
  private readonly keys: string[] | null;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly authorization?: string;
  private readonly customKeys: CmcdCustomKey[];
  private readonly urlFilter: CmcdUrlFilter;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  /** Rebuffering since the prior report (`bs`) */
  private starved = false;

  private queue: string[] = [];
  /** Number of pending requests */
  private inFlight = 0;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** `gone`: 410 response, until the next session. `destroyed`: for good. */
  private stopped: 'gone' | 'destroyed' | null = null;

  /** Expects a valid `config.url`. Invalid optional settings fall back to their default. */
  constructor(config: CmcdEventTarget, private readonly warn: (message: string) => void) {
    const { intervalMs, batchSize } = config;
    this.url = config.url;
    this.events = Array.isArray(config.events) ? config.events : DEFAULT_EVENTS;
    this.keys = Array.isArray(config.keys) ? config.keys : null;
    this.intervalMs =
      typeof intervalMs === 'number' && isFinite(intervalMs) && intervalMs >= 0
        ? intervalMs && Math.max(intervalMs, MIN_INTERVAL_MS)
        : DEFAULT_INTERVAL_MS;
    this.batchSize = typeof batchSize === 'number' && batchSize >= 1 ? Math.floor(batchSize) : 1;
    this.authorization = config.authorization;
    this.customKeys = Array.isArray(config.customKeys) ? config.customKeys : [];
    this.urlFilter = config.urlFilter || 'noQuery';
  }

  public reports(type: CmcdEventType): boolean {
    return !this.stopped && this.events.indexOf(type) !== -1;
  }

  /** A rebuffering started, so the next report carries `bs`. */
  public markStarved(): void {
    this.starved = true;
  }

  /** New session id. A target stopped by 410 is used again. */
  public resetSession(): void {
    this.state.reset();
    this.starved = false;
    if (this.stopped === 'gone') {
      this.stopped = null;
    }
  }

  /** Calls `onTick` every `intervalMs`, unless it is 0. */
  public startInterval(onTick: () => void): void {
    if (this.intervalMs > 0 && this.intervalTimer === null) {
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
   * (sent once, also if filtered), `bs` and `url` from `requestUrl`, then applies the key filter.
   */
  public report(data: CmcdData, requestUrl?: string, customKeys: CmcdCustomKey[] = []): void {
    this.state.addTo(data, CMCD_V2_EVENT_KEYS);
    if (this.starved) {
      data.bs = true;
    }
    // Also the reports while the rebuffering lasts carry `bs`.
    this.starved = data.sta === CmcdPlayStateToken.Rebuffering;

    if (requestUrl) {
      try {
        const url = filterUrl(requestUrl, this.urlFilter);
        if (url) {
          data.url = url;
        }
      } catch {
        // Not sent
      }
    }
    if (this.keys) {
      const requiredKey = EVENT_REQUIRED_KEY[data.e!];
      for (const key of Object.keys(data) as (keyof CmcdData)[]) {
        if (this.keys.indexOf(key) === -1 && MANDATORY_KEYS.indexOf(key) === -1 && key !== requiredKey) {
          delete data[key];
        }
      }
    }

    this.queue.push(cmcdDataToEventRecord(data, this.customKeys.concat(customKeys)));
    this.trimQueue();
    if (this.queue.length >= this.batchSize) {
      this.flush();
    }
  }

  /**
   * Sends all queued records. Unless `force` is set (page or player end), waits for a pending
   * request and for the retry delay after a failure. While the browser is offline, the records are kept.
   * `force` uses keepalive, which lets the requests outlive the page, in chunks that fit its size limit.
   */
  public flush(force = false): void {
    if (this.stopped || this.queue.length === 0 || (!force && (this.inFlight > 0 || this.retryTimer !== null))) {
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return;
    }
    this.clearRetryTimer();
    const records = this.queue;
    this.queue = [];
    if (!force) {
      this.send(records, false);
      return;
    }
    let chunk: string[] = [];
    let size = 0;
    for (const record of records) {
      if (chunk.length > 0 && size + record.length + 1 > KEEPALIVE_BUDGET_BYTES) {
        this.send(chunk, true);
        chunk = [];
        size = 0;
      }
      chunk.push(record);
      size += record.length + 1;
    }
    this.send(chunk, true);
  }

  /** Sends the queued records, then drops the queue and the timers. Pending requests are not cancelled. */
  public destroy(): void {
    this.flush(true);
    this.stopped = 'destroyed';
    this.queue = [];
    this.stopInterval();
    this.clearRetryTimer();
  }

  private send(records: string[], keepalive: boolean): void {
    const body = cmcdEventRecordsToBody(records);
    // Without keepalive if the shared budget is used up. Such a request may not outlive the page.
    const usesKeepalive = keepalive && keepaliveBytesInFlight + body.length <= KEEPALIVE_BUDGET_BYTES;
    if (usesKeepalive) {
      keepaliveBytesInFlight += body.length;
    }
    const headers: { [name: string]: string } = { 'Content-Type': 'application/cmcd' };
    if (this.authorization) {
      headers.Authorization = this.authorization;
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    const settle = () => {
      this.inFlight--;
      if (usesKeepalive) {
        keepaliveBytesInFlight -= body.length;
      }
      if (timeout !== null) {
        clearTimeout(timeout);
      }
    };

    this.inFlight++;
    let response: Promise<Response>;
    try {
      response = fetch(this.url, {
        method: 'POST',
        headers,
        body,
        keepalive: usesKeepalive,
        signal: controller ? controller.signal : undefined,
      });
    } catch (error) {
      response = Promise.reject(error);
    }
    response.then(
      (result) => {
        settle();
        this.onResponse(records, result);
      },
      () => {
        settle();
        this.retry(records, 0);
      }
    );
  }

  private onResponse(records: string[], response: Response): void {
    const status = response.status;
    if (status >= 200 && status < 300) {
      this.failures = 0;
      // The redirect status is not exposed: 301, 302 and 303 turn the POST into a GET without body, 307 and 308 keep it.
      if (response.redirected) {
        this.warn(
          `CMCD: ${this.url} was redirected. Reports are lost unless it is a 307 or 308 redirect; use the final URL.`
        );
      }
      if (this.queue.length >= this.batchSize) {
        this.flush();
      }
    } else if (status === 410) {
      this.warn(`CMCD: ${this.url} responded 410, stopped until the next session`);
      this.stopped = 'gone';
      this.queue = [];
      this.clearRetryTimer();
    } else if (status === 429 || status >= 500) {
      this.retry(records, getRetryAfter(response));
    } else {
      // Not retryable, e.g. 400, 403, or a redirect that was not followed (status 0 or 3xx)
      this.warn(`CMCD: ${this.url} responded ${status}, reports dropped`);
    }
  }

  /** Keeps the records and retries with exponential backoff. Records added meanwhile join the next batch. */
  private retry(records: string[], retryAfter: number): void {
    if (this.stopped) {
      return;
    }
    this.queue = records.concat(this.queue);
    this.trimQueue();
    this.failures++;
    const backoff = RETRY_BASE_DELAY_MS * Math.pow(2, this.failures - 1);
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.flush();
    }, Math.min(Math.max(backoff, retryAfter), RETRY_MAX_DELAY_MS));
  }

  private trimQueue(): void {
    const excess = this.queue.length - MAX_QUEUED_RECORDS;
    if (excess > 0) {
      this.queue.splice(0, excess);
      this.warn(`CMCD: ${this.url} queue full, oldest reports dropped`);
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
