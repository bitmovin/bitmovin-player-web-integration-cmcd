import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  CmcdEventReporter,
  CmcdEventTarget,
  filterUrl,
  MAX_QUEUED_RECORDS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
} from '../../src/ts/CmcdEventTarget';
import { CmcdData, CmcdPlayStateToken, CmcdVersionNumbers } from '../../src/ts/Cmcd';

const URL = 'https://collector.example.com/cmcd';

interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  keepalive: boolean;
}

/** Lets pending promise callbacks run */
const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

/** Record of a custom event named `name`, with the key filter of `create` */
const record = (name: string) => `cen="${name}",e=ce,ts=1,v=2`;

describe('CmcdEventReporter', () => {
  let responses: (number | Error)[];
  let fetchMock: jest.Mock<(url: string, init: FetchInit) => Promise<{ status: number }>>;
  let warn: jest.Mock<(message: string) => void>;

  const bodies = () => fetchMock.mock.calls.map((call) => call[1].body);
  const create = (config: Partial<CmcdEventTarget> = {}) =>
    new CmcdEventReporter({ url: URL, events: ['ce'], keys: [], ...config }, warn);
  const add = (reporter: CmcdEventReporter, name: string, data: CmcdData = {}) =>
    reporter.report({ e: 'ce', cen: name, ts: 1, v: CmcdVersionNumbers.v2, ...data });

  beforeEach(() => {
    jest.useFakeTimers();
    responses = [];
    fetchMock = jest.fn(() => {
      const response = responses.length > 0 ? responses.shift()! : 204;
      return response instanceof Error ? Promise.reject(response) : Promise.resolve({ status: response });
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    warn = jest.fn();
  });

  afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
    jest.useRealTimers();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });

  it('sends a POST with text/cmcd and the Authorization header', () => {
    add(create({ authorization: 'Bearer abc' }), 'a');
    expect(fetchMock).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'text/cmcd', Authorization: 'Bearer abc' },
        body: record('a'),
        keepalive: false,
      })
    );
  });

  it('omits the Authorization header if not configured', () => {
    add(create(), 'a');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'text/cmcd' });
  });

  it('sends when the batch size is reached, and the rest on flush', () => {
    const reporter = create({ batchSize: 3 });
    add(reporter, 'a');
    add(reporter, 'b');
    expect(fetchMock).not.toHaveBeenCalled();
    add(reporter, 'c');
    add(reporter, 'd');
    reporter.flush();
    expect(bodies()).toEqual([[record('a'), record('b'), record('c')].join('\n')]);
  });

  it('waits for a pending request, then sends the records added meanwhile', async () => {
    const reporter = create();
    add(reporter, 'a');
    add(reporter, 'b');
    expect(bodies()).toEqual([record('a')]);
    await settle();
    expect(bodies()).toEqual([record('a'), record('b')]);
  });

  it.each([429, 500, 503])('keeps the records on %d and retries with exponential backoff', async (status) => {
    responses = [status, status];
    const reporter = create();
    add(reporter, 'a');
    await settle();
    // The batch grows while waiting.
    add(reporter, 'b');
    jest.advanceTimersByTime(RETRY_BASE_DELAY_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(bodies()[1]).toEqual(`${record('a')}\n${record('b')}`);
    await settle();
    jest.advanceTimersByTime(2 * RETRY_BASE_DELAY_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('limits the retry delay', async () => {
    responses = new Array(20).fill(500);
    const reporter = create();
    add(reporter, 'a');
    for (let i = 0; i < 10; i++) {
      await settle();
      jest.advanceTimersByTime(RETRY_MAX_DELAY_MS);
    }
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it('drops the records on other errors', async () => {
    responses = [400];
    const reporter = create();
    add(reporter, 'a');
    await settle();
    add(reporter, 'b');
    expect(bodies()).toEqual([record('a'), record('b')]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('400'));
  });

  it('keeps the records on network errors and retries', async () => {
    responses = [new TypeError('Failed to fetch')];
    add(create(), 'a');
    await settle();
    jest.advanceTimersByTime(RETRY_BASE_DELAY_MS);
    expect(bodies()).toEqual([record('a'), record('a')]);
  });

  it('keeps the records while offline', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const reporter = create();
    add(reporter, 'a');
    add(reporter, 'b');
    expect(fetchMock).not.toHaveBeenCalled();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    reporter.flush();
    expect(bodies()).toEqual([`${record('a')}\n${record('b')}`]);
  });

  it('drops the oldest records when the queue is full', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const reporter = create();
    for (let i = 0; i < MAX_QUEUED_RECORDS + 2; i++) {
      add(reporter, `r${i}`);
    }
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    reporter.flush();
    const records = bodies()[0].split('\n');
    expect(records.length).toBe(MAX_QUEUED_RECORDS);
    expect(records[0]).toBe(record('r2'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('full'));
  });

  it('sends with keepalive on a forced flush, also during the retry delay', async () => {
    responses = [500];
    const reporter = create({ batchSize: 5 });
    add(reporter, 'a');
    reporter.flush();
    await settle();
    add(reporter, 'b');
    reporter.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    reporter.flush(true);
    expect(fetchMock.mock.calls.map((call) => [call[1].body, call[1].keepalive])).toEqual([
      [record('a'), false],
      [`${record('a')}\n${record('b')}`, true],
    ]);
  });

  it('sends the queue on destroy, then nothing more', async () => {
    const reporter = create({ batchSize: 5 });
    add(reporter, 'a');
    reporter.destroy();
    add(reporter, 'b');
    reporter.flush(true);
    expect(bodies()).toEqual([record('a')]);
  });

  it('adds sn and the buffered keys, and bs after a rebuffering', () => {
    const reporter = create({ keys: ['sn', 'bs', 'bsd', 'ec', 'msd'], batchSize: 10 });
    reporter.state.addRebuffering(1500);
    reporter.state.addErrorCode('1');
    reporter.state.setStartupDelay(200);
    add(reporter, 'a', { sta: CmcdPlayStateToken.Rebuffering });
    add(reporter, 'b');
    add(reporter, 'c');
    reporter.markStarved();
    add(reporter, 'd');
    reporter.flush();
    expect(bodies()).toEqual([
      [
        'bsd=(1500),cen="a",e=ce,ec=("1"),msd=200,sn=0,ts=1,v=2',
        'bs,cen="b",e=ce,sn=1,ts=1,v=2',
        'cen="c",e=ce,sn=2,ts=1,v=2',
        'bs,cen="d",e=ce,sn=3,ts=1,v=2',
      ].join('\n'),
    ]);
  });

  describe('filterUrl', () => {
    const url = 'https://a.example.com:8443/p/x.m4s?t=1#f';
    it.each([
      ['full', 'https://a.example.com:8443/p/x.m4s?t=1'],
      ['noQuery', 'https://a.example.com:8443/p/x.m4s'],
      ['origin', 'https://a.example.com:8443'],
    ] as [CmcdEventTarget['urlFilter'], string][])('%s', (filter, expected) => {
      expect(filterUrl(url, filter!)).toEqual(expected);
    });
  });
});
