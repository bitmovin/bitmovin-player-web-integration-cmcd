import { CmcdData, CmcdKeyTable } from './Cmcd';

/**
 * State of one report destination: `sn` and the keys that are reported once per mode and destination
 * (`bsd`, `ec`, `msd`). Used for the Request Mode origins and the Event Mode targets.
 */
export class CmcdDestinationState {
  private sequenceNumber = 0;
  private rebufferingDurations: number[] = [];
  private errorCodes: string[] = [];
  private startupDelay: number | null = null;
  private startupDelaySent = false;

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
      this.startupDelay = delay;
    }
  }

  /** New session id */
  public reset(): void {
    this.sequenceNumber = 0;
    this.rebufferingDurations = [];
    this.errorCodes = [];
    this.startupDelay = null;
    this.startupDelaySent = false;
  }

  /** Adds `sn` and the buffered keys that `keys` contains. Buffered keys are sent once. */
  public addTo(data: CmcdData, keys: CmcdKeyTable): void {
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
    if (keys.msd && this.startupDelay !== null) {
      data.msd = this.startupDelay;
      this.startupDelay = null;
      this.startupDelaySent = true;
    }
  }
}
