import { CmcdEventData, CmcdKeyTable } from './Cmcd';

/** Maximum number of `bsd` durations kept per destination until its next report. The oldest are dropped. */
export const MAX_PENDING_REBUFFERINGS = 32;

/**
 * State of one report destination: `sn`, buffer starvation (`bs`) and the keys that are reported once per mode
 * and destination (`bsd`, `ec`, `msd`). Used for the Request Mode origins and the Event Mode targets.
 */
export class CmcdDestinationState {
  private rebufferingDurations: number[] = [];
  private errorCodes: string[] = [];
  private starved = false;
  private startupDelay = new CmcdStartupDelay();

  constructor(private sequenceNumber = 0) {}

  public addRebuffering(duration: number): void {
    this.rebufferingDurations.push(duration);
    if (this.rebufferingDurations.length > MAX_PENDING_REBUFFERINGS) {
      this.rebufferingDurations.shift();
    }
  }

  public addErrorCode(code: string): void {
    if (this.errorCodes.indexOf(code) === -1) {
      this.errorCodes.push(code);
    }
  }

  public setStartupDelay(delay: number): void {
    this.startupDelay.set(delay);
  }

  /** The buffer starved since the last report to this destination. */
  public markStarved(): void {
    this.starved = true;
  }

  /** Returns whether the buffer starved since the last report, and clears it. */
  public takeStarved(): boolean {
    const starved = this.starved;
    this.starved = false;
    return starved;
  }

  /** New session id */
  public reset(): void {
    this.sequenceNumber = 0;
    this.rebufferingDurations = [];
    this.errorCodes = [];
    this.starved = false;
    this.startupDelay.reset();
  }

  /** Adds `sn` and the buffered keys that `keys` contains. Buffered keys are sent once. */
  public addTo(data: CmcdEventData, keys: CmcdKeyTable): void {
    if (keys.sn) {
      data.sn = this.sequenceNumber++;
    }
    if (keys.bsd && this.rebufferingDurations.length > 0) {
      data.bsd = this.rebufferingDurations;
      this.rebufferingDurations = [];
    }
    if (keys.ec && this.errorCodes.length > 0) {
      data.ec = this.errorCodes;
      this.errorCodes = [];
    }
    if (keys.msd) {
      const startupDelay = this.startupDelay.take();
      if (startupDelay !== null) {
        data.msd = startupDelay;
      }
    }
  }
}

/** `msd`, reported once per session id and scope: Request Mode, or one Event Mode target. */
export class CmcdStartupDelay {
  private pending: number | null = null;
  private sent = false;

  public set(delay: number): void {
    if (!this.sent) {
      this.pending = delay;
    }
  }

  /** Returns the delay once, then `null` until the next session id. */
  public take(): number | null {
    const delay = this.pending;
    if (delay !== null) {
      this.pending = null;
      this.sent = true;
    }
    return delay;
  }

  /** New session id */
  public reset(): void {
    this.pending = null;
    this.sent = false;
  }
}
