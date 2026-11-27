import { describe, it, expect, beforeEach } from '@jest/globals';
import { CmcdSessionMetrics } from '../../src/ts/CmcdSessionMetrics';

describe('CmcdSessionMetrics', () => {
  let metrics: CmcdSessionMetrics;

  beforeEach(() => {
    metrics = new CmcdSessionMetrics();
  });

  describe('rebuffering', () => {
    it('counts started rebufferings and sums the completed durations', () => {
      metrics.startRebuffering(1000);
      expect(metrics.getRebufferingCount()).toBe(1);
      expect(metrics.getRebufferingDuration()).toBe(0);
      expect(metrics.endRebuffering(1500)).toBe(500);
      metrics.startRebuffering(2000);
      expect(metrics.endRebuffering(2200)).toBe(200);

      expect(metrics.getRebufferingCount()).toBe(2);
      expect(metrics.getRebufferingDuration()).toBe(700);
    });

    it('ignores an end without start', () => {
      expect(metrics.endRebuffering(1000)).toBeNull();
      expect(metrics.getRebufferingDuration()).toBe(0);
    });

    it('continues across sources; a rebuffering ongoing at source end has no duration', () => {
      metrics.startRebuffering(1000);
      metrics.endRebuffering(1100);
      metrics.startRebuffering(2000);
      metrics.endSource();

      expect(metrics.endRebuffering(3000)).toBeNull();
      expect(metrics.getRebufferingCount()).toBe(2);
      expect(metrics.getRebufferingDuration()).toBe(100);
    });

    it('resets with a new session; an ongoing rebuffering counts in the new session from its start', () => {
      metrics.startRebuffering(1000);
      metrics.endRebuffering(1100);
      metrics.startRebuffering(2000);
      metrics.startSession(2500);

      expect(metrics.getRebufferingCount()).toBe(1);
      expect(metrics.getRebufferingDuration()).toBe(0);
      expect(metrics.endRebuffering(3000)).toBe(500);
      expect(metrics.getRebufferingDuration()).toBe(500);
    });

    it('starts the new session at 0 without an ongoing rebuffering', () => {
      metrics.startRebuffering(1000);
      metrics.endRebuffering(1100);
      metrics.startSession(2000);

      expect(metrics.getRebufferingCount()).toBe(0);
      expect(metrics.endRebuffering(3000)).toBeNull();
    });
  });

  describe('dropped frames', () => {
    it('sums the per-source counts of the session', () => {
      expect(metrics.droppedFramesOfSession(0)).toBe(0);
      expect(metrics.droppedFramesOfSession(5)).toBe(5);
      metrics.endSource();
      expect(metrics.droppedFramesOfSession(0)).toBe(5);
      expect(metrics.droppedFramesOfSession(3)).toBe(8);
    });

    it('counts only the frames dropped after a new session started', () => {
      metrics.droppedFramesOfSession(5);
      metrics.startSession(1000);
      expect(metrics.droppedFramesOfSession(5)).toBe(0);
      expect(metrics.droppedFramesOfSession(7)).toBe(2);
      metrics.endSource();
      expect(metrics.droppedFramesOfSession(1)).toBe(3);
    });
  });
});
