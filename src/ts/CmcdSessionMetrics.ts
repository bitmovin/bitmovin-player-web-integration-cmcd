/**
 * Rebuffering and dropped frames since the start of the session id (`bsa`, `bsda`, `dfa`).
 * The values continue across sources until `startSession`.
 */
export class CmcdSessionMetrics {
  private count = 0;
  private duration = 0;
  private rebufferingStartedAt: number | null = null;
  /** Dropped frames of the previous sources of the session */
  private droppedFramesOffset = 0;
  /** Last dropped frames count of the current source */
  private droppedFrames = 0;

  /** `bsa`: rebufferings started in the session */
  getRebufferingCount(): number {
    return this.count;
  }

  /** `bsda`: duration of the completed rebufferings of the session, in ms */
  getRebufferingDuration(): number {
    return this.duration;
  }

  startRebuffering(time: number): void {
    this.count++;
    this.rebufferingStartedAt = time;
  }

  /** Returns the duration of the ended rebuffering in ms, or `null` if none was ongoing. */
  endRebuffering(time: number): number | null {
    if (this.rebufferingStartedAt === null) {
      return null;
    }
    const duration = time - this.rebufferingStartedAt;
    this.duration += duration;
    this.rebufferingStartedAt = null;
    return duration;
  }

  /** `dfa`, from the dropped frames count of the current source, which the player starts at 0 for each source */
  droppedFramesOfSession(droppedFramesOfSource: number): number {
    this.droppedFrames = droppedFramesOfSource;
    return this.droppedFramesOffset + droppedFramesOfSource;
  }

  /** The source was unloaded. An ongoing rebuffering ends without a duration. */
  endSource(): void {
    this.droppedFramesOffset += this.droppedFrames;
    this.droppedFrames = 0;
    this.rebufferingStartedAt = null;
  }

  /** A new session id starts at `time`. */
  startSession(time: number): void {
    // An ongoing rebuffering is counted in the new session from now on.
    const isRebuffering = this.rebufferingStartedAt !== null;
    this.count = isRebuffering ? 1 : 0;
    this.rebufferingStartedAt = isRebuffering ? time : null;
    this.duration = 0;
    // The dropped frames of the current source so far belong to the previous session.
    this.droppedFramesOffset = -this.droppedFrames;
  }
}
