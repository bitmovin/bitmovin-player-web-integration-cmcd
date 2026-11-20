import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  CmcdEventReporter,
  CmcdTransport,
  CmcdTransportRequest,
  MAX_QUEUED_RECORDS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
} from '../../src/ts/CmcdEventReporter';

const URL = 'https://collector.example.com/cmcd';

/** Lets pending promise callbacks run */
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

describe('CmcdEventReporter', () => {
  let responses: (number | Error)[];
  let transport: jest.Mock<CmcdTransport>;
  let warn: jest.Mock<(message: string) => void>;

  const bodies = () => transport.mock.calls.map((call) => (call[1] as CmcdTransportRequest).body);
  const create = (batchSize = 1, authorization?: string) =>
    new CmcdEventReporter(URL, { batchSize, authorization }, transport, warn);

  beforeEach(() => {
    jest.useFakeTimers();
    responses = [];
    transport = jest.fn<CmcdTransport>(() => {
      const response = responses.length > 0 ? responses.shift()! : 204;
      return response instanceof Error ? Promise.reject(response) : Promise.resolve({ status: response });
    });
    warn = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });

  it('sends a POST with text/cmcd, keepalive and the Authorization header', () => {
    create(1, 'Bearer abc').add('e=t,ts=1,v=2');
    expect(transport).toHaveBeenCalledWith(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/cmcd', Authorization: 'Bearer abc' },
      body: 'e=t,ts=1,v=2',
      keepalive: true,
    });
  });

  it('omits the Authorization header if not configured', () => {
    create().add('a');
    expect((transport.mock.calls[0][1] as CmcdTransportRequest).headers).toEqual({ 'Content-Type': 'text/cmcd' });
  });

  it('sends when the batch size is reached', async () => {
    const reporter = create(3);
    reporter.add('a');
    reporter.add('b');
    expect(transport).not.toHaveBeenCalled();
    reporter.add('c');
    expect(bodies()).toEqual(['a\nb\nc']);
  });

  it('sends the remaining records on flush', () => {
    const reporter = create(3);
    reporter.add('a');
    reporter.flush();
    expect(bodies()).toEqual(['a']);
    reporter.flush();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('waits for a pending request, then sends the records added meanwhile', async () => {
    const reporter = create();
    reporter.add('a');
    reporter.add('b');
    expect(bodies()).toEqual(['a']);
    await settle();
    expect(bodies()).toEqual(['a', 'b']);
  });

  it('treats any 2xx as success', async () => {
    responses = [200, 202];
    const reporter = create();
    reporter.add('a');
    await settle();
    reporter.add('b');
    await settle();
    jest.advanceTimersByTime(RETRY_MAX_DELAY_MS);
    expect(bodies()).toEqual(['a', 'b']);
  });

  it('stops the target on 410', async () => {
    responses = [410];
    const reporter = create();
    reporter.add('a');
    await settle();
    expect(reporter.isStopped).toBe(true);
    reporter.add('b');
    reporter.flush(true);
    jest.advanceTimersByTime(RETRY_MAX_DELAY_MS);
    expect(bodies()).toEqual(['a']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('410'));
  });

  it.each([429, 500, 503])('keeps the records on %d and retries with exponential backoff', async (status) => {
    responses = [status, status];
    const reporter = create();
    reporter.add('a');
    await settle();
    // The batch grows while waiting.
    reporter.add('b');
    expect(bodies()).toEqual(['a']);

    jest.advanceTimersByTime(RETRY_BASE_DELAY_MS - 1);
    expect(transport).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(bodies()).toEqual(['a', 'a\nb']);
    await settle();

    jest.advanceTimersByTime(2 * RETRY_BASE_DELAY_MS - 1);
    expect(transport).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    expect(bodies()).toEqual(['a', 'a\nb', 'a\nb']);
    await settle();

    // Success resets the backoff.
    reporter.add('c');
    expect(bodies()).toEqual(['a', 'a\nb', 'a\nb', 'c']);
  });

  it('limits the retry delay', async () => {
    responses = new Array(20).fill(500);
    const reporter = create();
    reporter.add('a');
    for (let i = 0; i < 10; i++) {
      await settle();
      jest.advanceTimersByTime(RETRY_MAX_DELAY_MS);
    }
    expect(transport).toHaveBeenCalledTimes(11);
  });

  it('drops the records on other errors', async () => {
    responses = [400];
    const reporter = create();
    reporter.add('a');
    await settle();
    reporter.add('b');
    expect(bodies()).toEqual(['a', 'b']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('400'));
  });

  it('keeps the records on network errors and retries', async () => {
    responses = [new TypeError('Failed to fetch')];
    const reporter = create();
    reporter.add('a');
    await settle();
    jest.advanceTimersByTime(RETRY_BASE_DELAY_MS);
    expect(bodies()).toEqual(['a', 'a']);
  });

  it('handles a transport that throws', async () => {
    const throwing = jest.fn<CmcdTransport>(() => {
      throw new Error('boom');
    });
    const reporter = new CmcdEventReporter(URL, { batchSize: 1 }, throwing, warn);
    expect(() => reporter.add('a')).not.toThrow();
    await settle();
    expect(throwing).toHaveBeenCalledTimes(1);
  });

  it('keeps the records while offline', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const reporter = create();
    reporter.add('a');
    reporter.add('b');
    expect(transport).not.toHaveBeenCalled();

    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    reporter.flush();
    expect(bodies()).toEqual(['a\nb']);
  });

  it('drops the oldest records when the queue is full', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const reporter = create();
    for (let i = 0; i < MAX_QUEUED_RECORDS + 2; i++) {
      reporter.add(`r${i}`);
    }
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    reporter.flush();
    const records = bodies()[0].split('\n');
    expect(records.length).toBe(MAX_QUEUED_RECORDS);
    expect(records[0]).toBe('r2');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('full'));
  });

  it('sends on a forced flush during the retry delay and a pending request', async () => {
    responses = [500];
    const reporter = create(5);
    reporter.add('a');
    reporter.flush();
    await settle();
    reporter.add('b');
    reporter.flush();
    expect(transport).toHaveBeenCalledTimes(1);
    reporter.flush(true);
    expect(bodies()).toEqual(['a', 'a\nb']);
  });

  it('does not use keepalive for large bodies', () => {
    create().add('x'.repeat(70000));
    expect((transport.mock.calls[0][1] as CmcdTransportRequest).keepalive).toBe(false);
  });

  it('drops the queue on stop', () => {
    const reporter = create(5);
    reporter.add('a');
    reporter.stop();
    reporter.flush(true);
    expect(transport).not.toHaveBeenCalled();
  });
});
