import { describe, it, expect } from '@jest/globals';
import { CmcdData, CMCD_V2_KEYS } from '../../src/ts/Cmcd';
import { CmcdDestinationState, CmcdStartupDelay } from '../../src/ts/CmcdDestinationState';

describe('CmcdStartupDelay', () => {
  it('returns the delay once per session id', () => {
    const startupDelay = new CmcdStartupDelay();

    startupDelay.set(400);
    expect(startupDelay.take()).toBe(400);
    expect(startupDelay.take()).toBeNull();

    // Ignored after it was sent in this session
    startupDelay.set(500);
    expect(startupDelay.take()).toBeNull();

    startupDelay.reset();
    startupDelay.set(600);
    expect(startupDelay.take()).toBe(600);
  });

  it('keeps the latest delay until it is taken', () => {
    const startupDelay = new CmcdStartupDelay();

    startupDelay.set(400);
    startupDelay.set(450);

    expect(startupDelay.take()).toBe(450);
  });
});

describe('CmcdDestinationState', () => {
  it('adds msd once per destination and session id', () => {
    const state = new CmcdDestinationState();
    state.setStartupDelay(400);

    const first: CmcdData = {};
    const second: CmcdData = {};
    state.addTo(first, CMCD_V2_KEYS);
    state.addTo(second, CMCD_V2_KEYS);

    expect(first.msd).toBe(400);
    expect(second.msd).toBeUndefined();
  });
});
