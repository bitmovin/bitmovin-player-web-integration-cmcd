import { describe, beforeEach, afterEach, it, expect, jest } from '@jest/globals';
import { createWarnOnce } from '../../src/ts/Log';

describe('createWarnOnce', () => {
  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => warnSpy.mockRestore());

  it('logs each distinct message once', () => {
    const warnOnce = createWarnOnce();

    warnOnce('a');
    warnOnce('a');
    warnOnce('b');

    expect(warnSpy.mock.calls).toEqual([['a'], ['b']]);
  });

  it('keeps a separate memory per instance', () => {
    createWarnOnce()('a');
    createWarnOnce()('a');

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
