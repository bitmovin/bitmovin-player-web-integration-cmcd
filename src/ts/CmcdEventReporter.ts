/**
 * CMCD v2 Event Mode transport: queues the records of one target and sends them as `text/cmcd` POST body.
 */

import { cmcdEventRecordsToBody } from './Cmcd';

export interface CmcdTransportRequest {
  method: 'POST';
  headers: { [name: string]: string };
  body: string;
  keepalive: boolean;
}

/** Sends one request. Resolves with the final status (after redirects), rejects on network errors. */
export type CmcdTransport = (url: string, request: CmcdTransportRequest) => Promise<{ status: number }>;

export interface CmcdEventReporterOptions {
  batchSize: number;
  authorization?: string;
}

/** Maximum number of queued records. The oldest record is dropped. */
export const MAX_QUEUED_RECORDS = 200;
/** First retry delay after a 429, 5xx or network error. Doubles with each further failure. */
export const RETRY_BASE_DELAY_MS = 2000;
export const RETRY_MAX_DELAY_MS = 120000;
/** Browsers limit the bodies of pending keepalive requests to 64 KiB in total. */
const MAX_KEEPALIVE_BODY_LENGTH = 60000;

export class CmcdEventReporter {
  private queue: string[] = [];
  /** Number of pending requests */
  private inFlight = 0;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly options: CmcdEventReporterOptions,
    private readonly transport: CmcdTransport,
    private readonly warn: (message: string) => void
  ) {}

  /** `true` after a 410 response or `stop()`. No records are queued or sent anymore. */
  public get isStopped(): boolean {
    return this.stopped;
  }

  public add(record: string): void {
    if (this.stopped) {
      return;
    }
    this.queue.push(record);
    this.trimQueue();
    if (this.queue.length >= this.options.batchSize) {
      this.flush();
    }
  }

  /**
   * Sends all queued records in one request. Unless `force` is set (page unload), waits for a pending
   * request and for the retry delay after a failure. While the browser is offline, the records are kept.
   */
  public flush(force = false): void {
    if (this.stopped || this.queue.length === 0 || (!force && (this.inFlight > 0 || this.retryTimer !== null))) {
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return;
    }
    this.clearRetryTimer();

    const batch = this.queue;
    this.queue = [];
    const body = cmcdEventRecordsToBody(batch);
    const headers: { [name: string]: string } = { 'Content-Type': 'text/cmcd' };
    if (this.options.authorization) {
      headers.Authorization = this.options.authorization;
    }

    this.inFlight++;
    let response: Promise<{ status: number }>;
    try {
      response = this.transport(this.url, {
        method: 'POST',
        headers,
        body,
        keepalive: body.length <= MAX_KEEPALIVE_BODY_LENGTH,
      });
    } catch (error) {
      response = Promise.reject(error);
    }
    response.then(
      (result) => this.onResponse(batch, result && result.status),
      () => this.onFailure(batch)
    );
  }

  /** Drops the queue and timers. Pending requests are not cancelled. */
  public stop(): void {
    this.stopped = true;
    this.queue = [];
    this.clearRetryTimer();
  }

  private onResponse(batch: string[], status: number): void {
    this.inFlight--;
    if (status >= 200 && status < 300) {
      this.failures = 0;
      if (this.queue.length >= this.options.batchSize) {
        this.flush();
      }
    } else if (status === 410) {
      this.warn(`CMCD: event target ${this.url} responded 410, no more reports are sent to it.`);
      this.stop();
    } else if (status === 429 || status >= 500) {
      this.retry(batch);
    } else {
      // Not retryable, e.g. 400 or 403
      this.warn(`CMCD: event target ${this.url} responded ${status}, reports are dropped.`);
    }
  }

  /** Keeps the records and retries with exponential backoff. Records added meanwhile join the next batch. */
  private onFailure(batch: string[]): void {
    this.inFlight--;
    this.retry(batch);
  }

  private retry(batch: string[]): void {
    if (this.stopped) {
      return;
    }
    this.queue = batch.concat(this.queue);
    this.trimQueue();
    this.failures++;
    const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, this.failures - 1), RETRY_MAX_DELAY_MS);
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.flush();
    }, delay);
  }

  private trimQueue(): void {
    const excess = this.queue.length - MAX_QUEUED_RECORDS;
    if (excess > 0) {
      this.queue.splice(0, excess);
      this.warn(`CMCD: event report queue of ${this.url} is full, the oldest reports are dropped.`);
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
