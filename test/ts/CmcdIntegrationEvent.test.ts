import { describe, beforeEach, afterEach, it, expect, jest } from '@jest/globals';
import { HttpRequestMethod, HttpRequestType, HttpResponseType, PlayerAPI } from 'bitmovin-player';
import { CmcdConfig, CmcdEventTarget, CmcdIntegration, CmcdUrlFilter, CustomKey } from '../../src/ts/CmcdIntegration';

const START = 1764752400000;
const COLLECTOR = 'https://collector.example.com/cmcd';
const OTHER_COLLECTOR = 'https://other.example.com/cmcd';
const SEGMENT = 'https://cdn.example.com/video/seg1.m4s?token=secret#frag';

interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  keepalive: boolean;
  signal?: AbortSignal;
}

interface FetchResponse {
  status: number;
  redirected?: boolean;
  headers?: { get(name: string): string | null };
}

type FetchMock = jest.Mock<(url: string, init: FetchInit) => Promise<FetchResponse>>;

const PLAYER_EVENTS: Record<string, string> = {
  SourceLoaded: 'sourceloaded',
  SourceUnloaded: 'sourceunloaded',
  Destroy: 'destroy',
  Play: 'play',
  Playing: 'playing',
  Paused: 'paused',
  Seek: 'seek',
  Seeked: 'seeked',
  TimeShift: 'timeshift',
  TimeShifted: 'timeshifted',
  StallStarted: 'stallstarted',
  StallEnded: 'stallended',
  PlaybackFinished: 'playbackfinished',
  Error: 'error',
  Muted: 'muted',
  Unmuted: 'unmuted',
  VideoDownloadQualityChanged: 'videodownloadqualitychanged',
  AudioDownloadQualityChanged: 'audiodownloadqualitychanged',
  AdBreakStarted: 'adbreakstarted',
  AdBreakFinished: 'adbreakfinished',
  AdStarted: 'adstarted',
  AdFinished: 'adfinished',
  AdSkipped: 'adskipped',
  AdError: 'aderror',
};

/** Lets pending promise callbacks run */
const settle = async () => {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
};

describe('CmcdIntegration Event Mode', () => {
  let handlers: Record<string, ((event?: unknown) => void)[]>;
  let state: {
    live: boolean;
    playing: boolean;
    paused: boolean;
    stalled: boolean;
    ended: boolean;
    time: number;
    source: object | null;
  };
  let mockPlayer: PlayerAPI;
  let fetchMock: FetchMock;
  let statuses: number[];
  let warnSpy: jest.SpiedFunction<typeof console.warn>;
  let integration: CmcdIntegration;

  const emit = (event: string, data: object = {}) =>
    (handlers[event] || []).slice().forEach((handler) => handler({ type: event, timestamp: Date.now(), ...data }));

  const create = (targets: CmcdEventTarget[], config: CmcdConfig = {}, withPlayer = true) => {
    const created = new CmcdIntegration({
      sessionId: 'session-id-123',
      contentId: 'content-id-123',
      eventTargets: targets,
      ...config,
    });
    if (withPlayer) {
      created.setPlayer(mockPlayer);
    }
    return created;
  };

  const requestsTo = (url: string) => fetchMock.mock.calls.filter((call) => call[0] === url).map((call) => call[1]);

  /** All records sent to `url`, in order */
  const recordsTo = async (url = COLLECTOR) => {
    await settle();
    return requestsTo(url).reduce<string[]>((all, request) => all.concat(request.body.split('\n')), []);
  };

  /** Records sent to `url` as key-value maps */
  const parsedTo = async (url = COLLECTOR) =>
    (await recordsTo(url)).map((record) => {
      const map: Record<string, string> = {};
      // Inner lists and strings in these tests contain no commas.
      for (const member of record.split(',')) {
        const index = member.indexOf('=');
        map[index === -1 ? member : member.slice(0, index)] = index === -1 ? '?1' : member.slice(index + 1);
      }
      return map;
    });

  const sendRequest = (type: HttpRequestType, url: string, target = integration) =>
    target.preprocessHttpRequest(type, {
      credentials: 'omit',
      method: HttpRequestMethod.GET,
      responseType: HttpResponseType.ARRAYBUFFER,
      url,
      headers: {},
    });

  const receive = async (
    type: HttpRequestType,
    url: string,
    response: { status?: number; elapsedTime?: number; timeToFirstByte?: number; headers?: object } = {},
    target = integration
  ) => {
    const request = await sendRequest(type, url, target);
    jest.advanceTimersByTime(200);
    await target.preprocessHttpResponse(type, {
      request,
      url: request.url,
      headers: {},
      status: 200,
      statusText: 'OK',
      length: 1000,
      elapsedTime: 0.2,
      ...response,
    } as Parameters<CmcdIntegration['preprocessHttpResponse']>[1]);
  };

  const startPlayback = () => {
    emit('play');
    state.playing = true;
    emit('playing');
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    handlers = {};
    statuses = [];
    state = { live: false, playing: false, paused: false, stalled: false, ended: false, time: 12.3456, source: null };
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock = jest.fn(() => Promise.resolve({ status: statuses.shift() || 204 })) as unknown as FetchMock;
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    mockPlayer = {
      isLive: () => state.live,
      isPlaying: () => state.playing,
      isPaused: () => state.paused,
      isStalled: () => state.stalled,
      hasEnded: () => state.ended,
      getSource: () => state.source,
      getPlaybackSpeed: () => 1,
      getConfig: () => ({ playback: {} }),
      getCurrentTime: () => state.time,
      getDroppedVideoFrames: () => 3,
      getDownloadedVideoData: () => ({ id: 'v1', bitrate: 4_200_000, isAuto: true }),
      getDownloadedAudioData: () => ({ id: 'a1', bitrate: 256_000, isAuto: true }),
      getPlaybackVideoData: () => ({ id: 'v1', bitrate: 4_200_000 }),
      getPlaybackAudioData: () => ({ id: 'a1', bitrate: 256_000 }),
      buffer: { getLevel: (_type: string, media: string) => ({ targetLevel: 30, level: media === 'audio' ? 3 : 6 }) },
      getAvailableVideoQualities: () => [{ bitrate: 523_000 }, { bitrate: 4_200_000 }],
      getAvailableAudioQualities: () => [{ bitrate: 64_000 }, { bitrate: 256_000 }],
      getAvailableSegments: () => ({}),
      on: (event: string, handler: (event?: unknown) => void) => (handlers[event] ||= []).push(handler),
      off: (event: string, handler: (event?: unknown) => void) => {
        handlers[event] = (handlers[event] || []).filter((registered) => registered !== handler);
      },
      exports: {
        HttpRequestType: {
          MEDIA_AUDIO: 'media/audio',
          MEDIA_VIDEO: 'media/video',
          MANIFEST_DASH: 'manifest/dash',
          MANIFEST_HLS_MASTER: 'manifest/hls/master',
          MANIFEST_HLS_VARIANT: 'manifest/hls/variant',
          MANIFEST_SMOOTH: 'manifest/smooth',
          DRM_LICENSE_WIDEVINE: 'drm/license/widevine',
        },
        PlayerEvent: PLAYER_EVENTS,
        BufferType: { ForwardDuration: 'forwardduration' },
        MediaType: { Audio: 'audio', Video: 'video' },
      },
    } as unknown as PlayerAPI;
  });

  afterEach(() => {
    integration?.destroy();
    delete (globalThis as { fetch?: unknown }).fetch;
    warnSpy.mockRestore();
    jest.useRealTimers();
  });

  describe('setup', () => {
    it('is disabled with one warning if fetch is not available', () => {
      delete (globalThis as { fetch?: unknown }).fetch;
      integration = new CmcdIntegration({ eventTargets: [{ url: COLLECTOR }, { url: OTHER_COLLECTOR }] });
      integration.setPlayer(mockPlayer);
      expect(() => {
        emit('sourceloaded');
        integration.sendCustomEvent('x');
        integration.setContentId('other');
      }).not.toThrow();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('fetch not available'));
    });

    it('ignores targets without url', async () => {
      integration = create([{ url: '' } as CmcdEventTarget, { url: COLLECTOR, events: ['ce'] }]);
      integration.sendCustomEvent('x');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('without url'));
    });

    it('does not change the Request Mode output', async () => {
      const headersOf = async (target: CmcdIntegration) => {
        target.onVideoAdaptation({
          representations: [{ id: 'v1', bandwidth: 2_000_000 }],
          suggested: 'v1',
        } as unknown as Parameters<CmcdIntegration['onVideoAdaptation']>[0]);
        return (await sendRequest(HttpRequestType.MEDIA_VIDEO, SEGMENT, target)).headers;
      };
      for (const version of [1, 2] as const) {
        const plain = new CmcdIntegration({ sessionId: 's', contentId: 'c', version });
        plain.setPlayer(mockPlayer);
        const withEvents = create([{ url: COLLECTOR }], { sessionId: 's', contentId: 'c', version });
        startPlayback();
        expect(await headersOf(withEvents)).toEqual(await headersOf(plain));
        plain.destroy();
        withEvents.destroy();
      }
    });
  });

  describe('every report', () => {
    it('has e, ts, v=2, sn and the state keys, also if Request Mode uses v1', async () => {
      integration = create([{ url: COLLECTOR, events: ['ce'] }], { version: 1 });
      state.source = {};
      emit('sourceloaded');
      await sendRequest(HttpRequestType.MANIFEST_DASH, 'https://cdn.example.com/manifest.mpd');
      startPlayback();
      integration.sendCustomEvent('my-event');

      expect(await recordsTo()).toEqual([
        'bl=(6000;v 3000;a),br=(4200;v 256;a),bsa=(0),bsda=(0),cen="my-event",cid="content-id-123",dfa=3,e=ce,' +
          'h="cdn.example.com",lb=(523;v 64;a),msd=0,pb=(4200;v 256;a),pt=12346,sf=d,sid="session-id-123",sn=0,' +
          `st=v,sta=p,tb=(4200;v 256;a),tbl=(30000;v 30000;a),ts=${START},v=2`,
      ]);
    });

    it('works before setPlayer', async () => {
      integration = create([{ url: COLLECTOR, events: ['ce'] }], {}, false);
      integration.sendCustomEvent('early');
      expect(await recordsTo()).toEqual([
        `bsa=(0),bsda=(0),cen="early",cid="content-id-123",e=ce,sid="session-id-123",sn=0,ts=${START},v=2`,
      ]);
    });
  });

  describe('events', () => {
    it('ps: reports each play state change once', async () => {
      integration = create([{ url: COLLECTOR, events: ['ps'], keys: [] }]);
      emit('sourceloaded');
      emit('play');
      state.playing = true;
      emit('playing');
      emit('timechanged');
      state.paused = true;
      state.playing = false;
      emit('paused');
      state.paused = false;
      state.playing = true;
      emit('play');
      emit('playing');
      emit('seek');
      emit('stallstarted');
      emit('seeked');
      state.stalled = true;
      emit('stallstarted');
      state.stalled = false;
      emit('stallended');
      state.ended = true;
      emit('playbackfinished');

      expect((await parsedTo()).map((record) => record.sta)).toEqual([
        'd',
        's',
        'p',
        'a',
        'p',
        'k',
        'p',
        'r',
        'p',
        'e',
      ]);
    });

    it('ps: reports msd once per session with the start of playback', async () => {
      integration = create([{ url: COLLECTOR, events: ['ps'], keys: ['msd'] }]);
      emit('play', { timestamp: START });
      state.playing = true;
      emit('playing', { timestamp: START + 812 });
      state.paused = true;
      emit('paused');
      expect((await parsedTo()).map((record) => record.msd)).toEqual([undefined, '812', undefined]);
    });

    it('e: reports the error with ec, then the fatal play state', async () => {
      integration = create([{ url: COLLECTOR, events: ['e', 'ps'], keys: [] }]);
      emit('error', { code: 3011, timestamp: START + 5 });
      expect(await recordsTo()).toEqual([
        `cid="content-id-123",e=e,ec=("3011"),sid="session-id-123",ts=${START + 5},v=2`,
        `cid="content-id-123",e=ps,sid="session-id-123",sta=f,ts=${START + 5},v=2`,
      ]);
    });

    it('t: reports every intervalMs while a source is loaded', async () => {
      integration = create([
        { url: COLLECTOR, events: ['t'], keys: [] },
        { url: OTHER_COLLECTOR, events: ['t'], keys: [], intervalMs: 10000 },
      ]);
      jest.advanceTimersByTime(60000);
      emit('sourceloaded');
      jest.advanceTimersByTime(60000);
      emit('sourceunloaded');
      jest.advanceTimersByTime(60000);

      expect((await parsedTo()).map((record) => Number(record.ts) - START)).toEqual([90000, 120000]);
      expect((await recordsTo(OTHER_COLLECTOR)).length).toBe(6);
    });

    it('t: starts with setPlayer if the source is loaded', async () => {
      state.source = {};
      integration = create([{ url: COLLECTOR, events: ['t'], keys: [] }]);
      jest.advanceTimersByTime(30000);
      expect(await recordsTo()).toEqual([`cid="content-id-123",e=t,sid="session-id-123",ts=${START + 30000},v=2`]);
    });

    it('t: intervalMs 0 disables it', async () => {
      integration = create([{ url: COLLECTOR, intervalMs: 0 }]);
      emit('sourceloaded');
      jest.advanceTimersByTime(300000);
      expect((await parsedTo()).map((record) => record.e)).toEqual(['ps']);
    });

    it('rr: reports the response with the URL before CMCD and redirects', async () => {
      integration = create([{ url: COLLECTOR, events: ['rr'], keys: ['ot', 'rc', 'ttfb', 'ttlb', 'cmsdd', 'cmsds'] }], {
        useQueryArgs: true,
        version: 2,
      });
      await receive(HttpRequestType.MEDIA_VIDEO, SEGMENT, {
        status: 200,
        elapsedTime: 0.2,
        timeToFirstByte: 0.18,
        headers: { 'cmsd-dynamic': 'etp=12500', 'CMSD-Static': 'ot=v' },
      });

      expect(await recordsTo()).toEqual([
        `cid="content-id-123",cmsdd="${btoa('etp=12500')}",cmsds="${btoa('ot=v')}",e=rr,ot=v,rc=200,` +
          `sid="session-id-123",ts=${START},ttfb=180,ttlb=200,url="https://cdn.example.com/video/seg1.m4s",v=2`,
      ]);
    });

    it.each<[CmcdUrlFilter, string]>([
      ['full', 'https://cdn.example.com/video/seg1.m4s?token=secret'],
      ['origin', 'https://cdn.example.com'],
      ['noQuery', 'https://cdn.example.com/video/seg1.m4s'],
    ])('rr: urlFilter %s', async (urlFilter, expected) => {
      integration = create([{ url: COLLECTOR, events: ['rr'], urlFilter }]);
      await receive(HttpRequestType.MEDIA_VIDEO, SEGMENT);
      expect((await parsedTo())[0].url).toEqual(`"${expected}"`);
    });

    it('rr: urlFilter function', async () => {
      const urlFilter = jest.fn((url: string) => (url.indexOf('secret') !== -1 ? null : url));
      integration = create([{ url: COLLECTOR, events: ['rr'], urlFilter }]);
      await receive(HttpRequestType.MEDIA_VIDEO, SEGMENT);
      await receive(HttpRequestType.MEDIA_VIDEO, 'https://cdn.example.com/a.m4s');
      expect((await parsedTo()).map((record) => record.url)).toEqual([undefined, '"https://cdn.example.com/a.m4s"']);
    });

    it('rr: without a known request, ts is derived from the elapsed time', async () => {
      integration = create([{ url: COLLECTOR, events: ['rr'], keys: [] }]);
      await integration.preprocessHttpResponse(HttpRequestType.MEDIA_VIDEO, {
        request: { url: 'https://cdn.example.com/x.m4s' },
        url: 'https://cdn.example.com/x.m4s',
        headers: {},
        status: 200,
        elapsedTime: 0.5,
      } as unknown as Parameters<CmcdIntegration['preprocessHttpResponse']>[1]);
      expect((await parsedTo())[0].ts).toEqual(String(START - 500));
    });

    it('c: reports a changed content id', async () => {
      integration = create([{ url: COLLECTOR, events: ['c'], keys: [] }]);
      integration.setContentId('content-id-123');
      integration.setContentId('ad-001');
      expect(await recordsTo()).toEqual([`cid="ad-001",e=c,sid="session-id-123",ts=${START},v=2`]);
    });

    it('h: reports a changed hostname of manifest and media requests', async () => {
      integration = create([{ url: COLLECTOR, events: ['h'], keys: [] }]);
      await sendRequest(HttpRequestType.MANIFEST_DASH, 'https://cdn-a.example.com/m.mpd');
      await sendRequest(HttpRequestType.MEDIA_VIDEO, 'https://cdn-a.example.com/1.m4s');
      await sendRequest(HttpRequestType.DRM_LICENSE_WIDEVINE, 'https://drm.example.com/license');
      await sendRequest(HttpRequestType.MEDIA_VIDEO, 'https://cdn-b.example.com/2.m4s');
      expect(await recordsTo()).toEqual([
        `cid="content-id-123",e=h,h="cdn-b.example.com",sid="session-id-123",ts=${START},v=2`,
      ]);
    });

    it('m, um: reports mute and unmute', async () => {
      integration = create([{ url: COLLECTOR, events: ['m', 'um'], keys: [] }]);
      emit('muted');
      emit('unmuted');
      expect((await parsedTo()).map((record) => record.e)).toEqual(['m', 'um']);
    });

    it('bc: reports download quality changes, not the first quality', async () => {
      integration = create([{ url: COLLECTOR, events: ['bc'], keys: ['br'] }]);
      emit('videodownloadqualitychanged', {
        sourceQualityId: null,
        targetQualityId: 'v1',
        targetQuality: { bitrate: 523_000 },
      });
      emit('videodownloadqualitychanged', {
        sourceQualityId: 'v1',
        targetQualityId: 'v2',
        targetQuality: { bitrate: 1_000_000 },
      });
      emit('audiodownloadqualitychanged', {
        sourceQualityId: 'a1',
        targetQualityId: 'a2',
        targetQuality: { bitrate: 64_000 },
      });
      expect((await parsedTo()).map((record) => record.br)).toEqual(['(1000;v 256;a)', '(1000;v 64;a)']);
    });

    it('ads: reports the ad sequence and skip, with ae and abe only after as and abs', async () => {
      integration = create([{ url: COLLECTOR, events: ['abs', 'as', 'ae', 'sk', 'abe'], keys: [] }]);
      emit('adfinished');
      emit('adbreakfinished');
      emit('adbreakstarted');
      emit('adstarted');
      emit('adfinished');
      emit('adstarted');
      emit('adskipped');
      emit('adstarted');
      emit('aderror');
      emit('adbreakfinished');
      expect((await parsedTo()).map((record) => record.e)).toEqual([
        'abs',
        'as',
        'ae',
        'as',
        'sk',
        'ae',
        'as',
        'ae',
        'abe',
      ]);
    });

    it('ce: reports custom events with cen and custom keys', async () => {
      integration = create([{ url: COLLECTOR, events: ['ce'], keys: [] }]);
      integration.sendCustomEvent('com.example-login', [new CustomKey('com.example-user', 'u1')]);
      integration.sendCustomEvent('x'.repeat(65));
      integration.sendCustomEvent('');
      expect(await recordsTo()).toEqual([
        `cen="com.example-login",cid="content-id-123",com.example-user="u1",e=ce,sid="session-id-123",ts=${START},v=2`,
      ]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('64 printable ASCII characters'));
    });
  });

  describe('filters', () => {
    it('reports the default events ps, e, t and rr only', async () => {
      integration = create([{ url: COLLECTOR }]);
      emit('sourceloaded');
      emit('muted');
      emit('error', { code: 1 });
      await receive(HttpRequestType.MEDIA_VIDEO, SEGMENT);
      jest.advanceTimersByTime(30000);
      expect((await parsedTo()).map((record) => record.e)).toEqual(['ps', 'e', 'ps', 'rr', 't']);
    });

    it('keeps the mandatory keys and the key the event requires', async () => {
      integration = create([{ url: COLLECTOR, events: ['ps', 'rr', 'e'], keys: ['nonexistent'] }]);
      emit('sourceloaded');
      emit('error', { code: 7 });
      await receive(HttpRequestType.MEDIA_VIDEO, SEGMENT);
      expect(Object.keys((await parsedTo())[0]).sort()).toEqual(['cid', 'e', 'sid', 'sta', 'ts', 'v']);
      expect(Object.keys((await parsedTo())[1]).sort()).toEqual(['cid', 'e', 'ec', 'sid', 'ts', 'v']);
      expect(Object.keys((await parsedTo())[3]).sort()).toEqual(['cid', 'e', 'sid', 'ts', 'url', 'v']);
    });

    it('applies the key and event filters per target', async () => {
      integration = create([
        { url: COLLECTOR, events: ['ps'], keys: ['pt'] },
        { url: OTHER_COLLECTOR, events: ['m'], keys: ['st'] },
      ]);
      startPlayback();
      emit('muted');
      expect((await parsedTo()).map((record) => [record.e, record.pt, record.st])).toEqual([
        ['ps', undefined, undefined],
        ['ps', '12346', undefined],
      ]);
      expect((await parsedTo(OTHER_COLLECTOR)).map((record) => [record.e, record.pt, record.st])).toEqual([
        ['m', undefined, 'v'],
      ]);
    });
  });

  describe('state per target', () => {
    it('counts sn per target, independent of Request Mode, and resets it with a new session id', async () => {
      integration = create(
        [
          { url: COLLECTOR, events: ['ce'], keys: ['sn'] },
          { url: OTHER_COLLECTOR, events: ['m'], keys: ['sn'] },
        ],
        { version: 2 }
      );
      await sendRequest(HttpRequestType.MEDIA_VIDEO, SEGMENT);
      await sendRequest(HttpRequestType.MEDIA_VIDEO, SEGMENT);
      integration.sendCustomEvent('a');
      integration.sendCustomEvent('b');
      emit('muted');
      integration.setSessionId('new-session');
      integration.sendCustomEvent('c');
      expect((await parsedTo()).map((record) => record.sn)).toEqual(['0', '1', '0']);
      expect((await parsedTo(OTHER_COLLECTOR)).map((record) => record.sn)).toEqual(['0']);
    });

    it('buffers bsd, ec and msd per target until its next report', async () => {
      integration = create([
        { url: COLLECTOR, events: ['ps'], keys: ['bs', 'bsd', 'ec', 'msd'] },
        { url: OTHER_COLLECTOR, events: ['m'], keys: ['bs', 'bsd', 'ec', 'msd'] },
      ]);
      emit('play', { timestamp: START });
      state.playing = true;
      emit('playing', { timestamp: START + 100 });
      state.stalled = true;
      emit('stallstarted', { timestamp: START + 1000 });
      state.stalled = false;
      emit('stallended', { timestamp: START + 2500 });
      emit('error', { code: 9 });
      emit('muted');
      emit('unmuted');

      const first = await parsedTo();
      expect(first.map((record) => [record.sta, record.msd, record.bs, record.bsd, record.ec])).toEqual([
        ['s', undefined, undefined, undefined, undefined],
        ['p', '100', undefined, undefined, undefined],
        ['r', undefined, undefined, undefined, undefined],
        ['p', undefined, '?1', '(1500)', undefined],
        ['f', undefined, undefined, undefined, '("9")'],
      ]);
      const other = await parsedTo(OTHER_COLLECTOR);
      expect(other.map((record) => [record.msd, record.bs, record.bsd, record.ec])).toEqual([
        ['100', '?1', '(1500)', '("9")'],
      ]);
    });

    it('sends bs while the rebuffering lasts', async () => {
      integration = create([{ url: COLLECTOR, events: ['ps', 'ce'], keys: ['bs'] }]);
      startPlayback();
      state.stalled = true;
      emit('stallstarted');
      integration.sendCustomEvent('during');
      integration.sendCustomEvent('during2');
      state.stalled = false;
      emit('stallended');
      integration.sendCustomEvent('after');
      expect((await parsedTo()).map((record) => record.bs)).toEqual([
        undefined,
        undefined,
        undefined,
        '?1',
        '?1',
        '?1',
        undefined,
      ]);
    });
  });

  describe('transport', () => {
    it('batches reports and flushes them with the interval', async () => {
      integration = create([{ url: COLLECTOR, events: ['ce', 't'], keys: [], batchSize: 3 }]);
      emit('sourceloaded');
      integration.sendCustomEvent('a');
      integration.sendCustomEvent('b');
      await settle();
      expect(fetchMock).not.toHaveBeenCalled();
      integration.sendCustomEvent('c');
      integration.sendCustomEvent('d');
      await settle();
      expect(requestsTo(COLLECTOR).map((request) => request.body.split('\n').length)).toEqual([3]);
      jest.advanceTimersByTime(30000);
      await settle();
      expect(requestsTo(COLLECTOR).map((request) => request.body.split('\n').length)).toEqual([3, 2]);
    });

    it.each([
      ['SourceUnloaded', () => emit('sourceunloaded')],
      ['player Destroy', () => emit('destroy')],
      ['pagehide', () => window.dispatchEvent(new Event('pagehide'))],
      [
        'visibilitychange to hidden',
        () => {
          Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
          document.dispatchEvent(new Event('visibilitychange'));
          Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        },
      ],
      ['destroy()', () => integration.destroy()],
    ])('flushes on %s', async (_name, trigger) => {
      integration = create([{ url: COLLECTOR, events: ['ce'], keys: [], batchSize: 10 }]);
      integration.sendCustomEvent('a');
      trigger();
      expect(await recordsTo()).toHaveLength(1);
    });

    it('flushes when the browser is online again', async () => {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      try {
        integration = create([{ url: COLLECTOR, events: ['ce'], keys: [] }]);
        integration.sendCustomEvent('a');
        await settle();
        expect(fetchMock).not.toHaveBeenCalled();
        Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
        window.dispatchEvent(new Event('online'));
        expect(await recordsTo()).toHaveLength(1);
      } finally {
        Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
      }
    });

    it('stops a target after 410 and keeps sending to others', async () => {
      statuses = [410];
      integration = create([
        { url: COLLECTOR, events: ['ce'], keys: [] },
        { url: OTHER_COLLECTOR, events: ['ce'], keys: [] },
      ]);
      integration.sendCustomEvent('a');
      await settle();
      integration.sendCustomEvent('b');
      expect(await recordsTo()).toHaveLength(1);
      expect(await recordsTo(OTHER_COLLECTOR)).toHaveLength(2);
    });

    it('destroy() removes the player and page listeners and the timers', async () => {
      integration = create([{ url: COLLECTOR, events: ['t', 'm', 'ce'], keys: [] }]);
      emit('sourceloaded');
      integration.destroy();
      emit('muted');
      window.dispatchEvent(new Event('pagehide'));
      jest.advanceTimersByTime(120000);
      integration.sendCustomEvent('a');
      expect(Object.values(handlers).every((list) => list.length === 0)).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
      expect(await recordsTo()).toHaveLength(0);
    });
  });

  describe('review fixes', () => {
    const response = (status: number, headers: Record<string, string> = {}, redirected = false) => ({
      status,
      redirected,
      headers: { get: (name: string) => headers[name] ?? null },
    });

    it('1: sends bs with the next report after a rebuffering, also without ps reports', async () => {
      integration = create([{ url: COLLECTOR, events: ['t'], keys: ['bs', 'bsd'] }]);
      emit('sourceloaded');
      startPlayback();
      jest.advanceTimersByTime(5000);
      state.stalled = true;
      emit('stallstarted');
      jest.advanceTimersByTime(2000);
      state.stalled = false;
      emit('stallended');
      jest.advanceTimersByTime(23000);
      jest.advanceTimersByTime(30000);
      expect((await parsedTo()).map((record) => [record.bs, record.bsd])).toEqual([
        ['?1', '(2000)'],
        [undefined, undefined],
      ]);
    });

    it('2: warns once if the target redirected, as 301 to 303 drop the body', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(response(204, {}, true)));
      integration = create([{ url: COLLECTOR, events: ['ce'], keys: [] }]);
      integration.sendCustomEvent('a');
      await settle();
      integration.sendCustomEvent('b');
      await settle();
      expect(warnSpy.mock.calls.filter((call) => String(call[0]).indexOf('redirected') !== -1)).toHaveLength(1);
    });

    it('2: drops the reports with a warning on a redirect that was not followed', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(response(0)));
      integration = create([{ url: COLLECTOR, events: ['ce'], keys: [] }]);
      integration.sendCustomEvent('a');
      await settle();
      jest.advanceTimersByTime(300000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('responded 0'));
    });

    it('3: uses keepalive only when the page or the source ends', async () => {
      integration = create([{ url: COLLECTOR, events: ['ce'], keys: [], batchSize: 2 }]);
      integration.sendCustomEvent('a');
      integration.sendCustomEvent('b');
      integration.sendCustomEvent('c');
      window.dispatchEvent(new Event('pagehide'));
      await settle();
      expect(requestsTo(COLLECTOR).map((request) => request.keepalive)).toEqual([false, true]);
    });

    it('3: splits forced batches into chunks within the keepalive budget, shared by all targets', async () => {
      // Pending until the request timeout aborts it
      fetchMock.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('abort'))))
      );
      integration = create([
        { url: COLLECTOR, events: ['rr'], keys: [], batchSize: 10000, urlFilter: 'full' },
        { url: OTHER_COLLECTOR, events: ['rr'], keys: [], batchSize: 10000, urlFilter: 'full' },
      ]);
      // 200 records (the queue limit) of about 500 bytes per target
      for (let i = 0; i < 200; i++) {
        await receive(HttpRequestType.MEDIA_VIDEO, `https://cdn.example.com/seg.m4s?q=${'a'.repeat(400)}`);
      }
      window.dispatchEvent(new Event('pagehide'));
      const requests = fetchMock.mock.calls.map((call) => call[1]);
      for (const request of requests.filter((request) => request.keepalive)) {
        expect(request.body.length).toBeLessThanOrEqual(64000);
      }
      const keepaliveBytes = requests
        .filter((request) => request.keepalive)
        .reduce((sum, request) => sum + request.body.length, 0);
      expect(keepaliveBytes).toBeLessThanOrEqual(64000);
      expect(keepaliveBytes).toBeGreaterThan(0);
      expect(requests.length).toBeGreaterThan(2);

      // The timeout ends the requests and frees the budget.
      jest.advanceTimersByTime(10000);
      await settle();
      fetchMock.mockImplementation(() => Promise.resolve({ status: 204 }));
      integration.destroy();
      await settle();
      integration = create([{ url: COLLECTOR, events: ['ce'], keys: [], batchSize: 10 }]);
      integration.sendCustomEvent('a');
      window.dispatchEvent(new Event('pagehide'));
      expect(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].keepalive).toBe(true);
    });

    it('4: aborts a request without response after 10 s and retries', async () => {
      fetchMock.mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('abort'))))
      );
      integration = create([{ url: COLLECTOR, events: ['ce'], keys: [] }]);
      integration.sendCustomEvent('a');
      integration.sendCustomEvent('b');
      jest.advanceTimersByTime(10000);
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(2000);
      await settle();
      expect(requestsTo(COLLECTOR).map((request) => request.body.split('\n').length)).toEqual([1, 2]);
    });

    it('5: matches retries and concurrent requests of the same URL by request object', async () => {
      integration = create([{ url: COLLECTOR, events: ['rr'], keys: [] }], { useQueryArgs: true, version: 2 });
      const respond = (request: Awaited<ReturnType<CmcdIntegration['preprocessHttpRequest']>>) =>
        integration.preprocessHttpResponse(HttpRequestType.MEDIA_VIDEO, {
          request,
          url: request.url,
          headers: {},
          status: 200,
          elapsedTime: 0.1,
        } as unknown as Parameters<CmcdIntegration['preprocessHttpResponse']>[1]);
      const first = await sendRequest(HttpRequestType.MEDIA_VIDEO, SEGMENT);
      jest.advanceTimersByTime(1000);
      const second = await sendRequest(HttpRequestType.MEDIA_VIDEO, SEGMENT);
      jest.advanceTimersByTime(1000);
      await respond(first);
      await respond(first);
      await respond(second);
      expect((await parsedTo()).map((record) => Number(record.ts) - START)).toEqual([0, 0, 1000]);
    });

    it('6: omits ttfb 0', async () => {
      integration = create([{ url: COLLECTOR, events: ['rr'], keys: ['ttfb'] }]);
      await receive(HttpRequestType.MEDIA_VIDEO, SEGMENT, { timeToFirstByte: 0 });
      expect((await parsedTo())[0].ttfb).toBeUndefined();
    });

    it('7: resumes a target stopped by 410 with a new session id', async () => {
      statuses = [410];
      integration = create([{ url: COLLECTOR, events: ['ce'], keys: [] }]);
      integration.sendCustomEvent('a');
      await settle();
      integration.sendCustomEvent('b');
      integration.setSessionId('next-session');
      integration.sendCustomEvent('c');
      expect((await parsedTo()).map((record) => record.cen)).toEqual(['"a"', '"c"']);
    });

    it('8: on player Destroy, flushes and removes the player and page listeners', async () => {
      integration = create([{ url: COLLECTOR, events: ['ce', 'm'], keys: [], batchSize: 10 }]);
      integration.sendCustomEvent('a');
      emit('destroy');
      expect(Object.values(handlers).every((list) => list.length === 0)).toBe(true);
      window.dispatchEvent(new Event('online'));
      expect(await recordsTo()).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('9: rejects a custom event name that is not printable ASCII', async () => {
      integration = create([{ url: COLLECTOR, events: ['ce'], keys: [] }]);
      integration.sendCustomEvent('café');
      expect(await recordsTo()).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('printable ASCII'));
    });

    it.each([
      ['seconds', '30'],
      ['HTTP date', new Date(START + 30000).toUTCString()],
    ])('10: waits for Retry-After in %s', async (_name, retryAfter) => {
      fetchMock.mockImplementationOnce(() => Promise.resolve(response(429, { 'Retry-After': retryAfter })));
      integration = create([{ url: COLLECTOR, events: ['ce'], keys: [] }]);
      integration.sendCustomEvent('a');
      await settle();
      jest.advanceTimersByTime(29000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('11: uses an intervalMs of at least 1000', async () => {
      integration = create([{ url: COLLECTOR, events: ['t'], keys: [], intervalMs: 200 }]);
      emit('sourceloaded');
      jest.advanceTimersByTime(3000);
      expect(await recordsTo()).toHaveLength(3);
    });
  });

  describe('no-throw', () => {
    it('does not throw if player APIs throw', async () => {
      const throwing = () => {
        throw new Error('boom');
      };
      for (const method of [
        'isLive',
        'isPlaying',
        'getCurrentTime',
        'getDroppedVideoFrames',
        'getDownloadedVideoData',
        'getAvailableVideoQualities',
        'getSource',
        'hasEnded',
      ]) {
        (mockPlayer as unknown as Record<string, unknown>)[method] = throwing;
      }
      (mockPlayer.buffer as unknown as Record<string, unknown>).getLevel = throwing;
      integration = create([{ url: COLLECTOR, events: ['ps', 'ce', 'm', 'rr', 't'] }]);
      expect(() => {
        emit('sourceloaded');
        startPlayback();
        emit('muted');
        integration.sendCustomEvent('a');
        jest.advanceTimersByTime(30000);
      }).not.toThrow();
      await expect(receive(HttpRequestType.MEDIA_VIDEO, SEGMENT)).resolves.toBeUndefined();
      // No `ps`, as the play state is unknown
      expect((await parsedTo()).map((record) => record.e)).toEqual(['m', 'ce', 't', 'rr']);
    });

    it('does not throw if fetch throws or rejects', async () => {
      fetchMock.mockImplementation(() => {
        throw new Error('boom');
      });
      integration = create([{ url: COLLECTOR, events: ['ce'] }]);
      expect(() => integration.sendCustomEvent('a')).not.toThrow();
      await settle();
      fetchMock.mockImplementation(() => Promise.reject(new Error('offline')));
      expect(() => jest.advanceTimersByTime(10000)).not.toThrow();
      await settle();
    });

    it('does not report or throw without a response', async () => {
      integration = create([{ url: COLLECTOR, events: ['rr'] }]);
      const missing = undefined as unknown as Parameters<CmcdIntegration['preprocessHttpResponse']>[1];
      await expect(integration.preprocessHttpResponse(HttpRequestType.MEDIA_VIDEO, missing)).resolves.toBeUndefined();
      expect(await recordsTo()).toHaveLength(0);
      // Event Mode does not read the missing response.
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not throw for invalid URLs and custom keys', async () => {
      integration = create([{ url: COLLECTOR, events: ['rr', 'ce'] }]);
      await expect(receive(HttpRequestType.MEDIA_VIDEO, 'not a url')).resolves.toBeUndefined();
      expect(() => integration.sendCustomEvent('a', [new CustomKey('com.example-Upper', 'x')])).not.toThrow();
      expect(() => integration.sendCustomEvent('a', 'invalid' as unknown as CustomKey[])).not.toThrow();
    });
  });

  // CTA-5004-A section 8.2, reproduced from player events
  describe('spec examples', () => {
    const ids = { sessionId: 'session-id-123', contentId: 'content-id-123' };

    it('8.2.1 time interval with the minimal keys', async () => {
      integration = create([{ url: COLLECTOR, events: ['t'], keys: [] }], { sessionId: '', contentId: '' });
      jest.setSystemTime(START - 30000);
      emit('sourceloaded');
      jest.advanceTimersByTime(30000);
      expect(await recordsTo()).toEqual(['e=t,ts=1764752400000,v=2']);
    });

    it('8.2.3 response received, with absolute url and without nor', async () => {
      integration = create(
        [
          {
            url: COLLECTOR,
            events: ['rr'],
            keys: ['cmsdd', 'cmsds', 'ot', 'rc', 'ttfb', 'ttlb'],
            urlFilter: 'noQuery',
          },
        ],
        { sessionId: 'session1', contentId: 'bbb' }
      );
      jest.setSystemTime(1763657019723);
      await receive(HttpRequestType.MEDIA_VIDEO, 'https://cdn.example.com/video/segment-5.m4v', {
        status: 200,
        elapsedTime: 0.2,
        timeToFirstByte: 0.18,
        headers: {
          'CMSD-Dynamic': atob('ZXRwPTEyNTAwO3J0dD0zNTttYj02MDAwO3JkPTIwMA=='),
          'CMSD-Static': atob('c2lkPSI5YTNiLTIxY2QiO2JyPTQ1MDA7ZD00MDAwO290PXY7c3Q9dg=='),
        },
      });
      expect(await recordsTo()).toEqual([
        'cid="bbb",cmsdd="ZXRwPTEyNTAwO3J0dD0zNTttYj02MDAwO3JkPTIwMA==",cmsds="c2lkPSI5YTNiLTIxY2QiO2JyPTQ1MDA7ZD00MDAwO290PXY7c3Q9dg==",e=rr,ot=v,rc=200,sid="session1",ts=1763657019723,ttfb=180,ttlb=200,url="https://cdn.example.com/video/segment-5.m4v",v=2',
      ]);
    });

    it('8.2.4 error', async () => {
      integration = create([{ url: COLLECTOR, events: ['e'], keys: [] }], ids);
      emit('error', { code: 'CODEC_NOT_SUPPORTED', timestamp: 1764269150 });
      expect(await recordsTo()).toEqual([
        'cid="content-id-123",e=e,ec=("CODEC_NOT_SUPPORTED"),sid="session-id-123",ts=1764269150,v=2',
      ]);
    });

    it('8.2.5 rebuffering start and end, with the end time as ts', async () => {
      integration = create([{ url: COLLECTOR, events: ['ps'], keys: ['bs', 'bsd'] }], ids);
      startPlayback();
      state.stalled = true;
      emit('stallstarted', { timestamp: 1764269150 });
      state.stalled = false;
      emit('stallended', { timestamp: 1764269150 + 1500 });
      expect((await recordsTo()).slice(2)).toEqual([
        'cid="content-id-123",e=ps,sid="session-id-123",sta=r,ts=1764269150,v=2',
        'bs,bsd=(1500),cid="content-id-123",e=ps,sid="session-id-123",sta=p,ts=1764270650,v=2',
      ]);
    });

    it('8.2.7 skip ad', async () => {
      integration = create([{ url: COLLECTOR, events: ['sk'], keys: [] }], ids);
      integration.setContentId('ad-content-555');
      emit('adskipped', { timestamp: 1764269150 });
      expect(await recordsTo()).toEqual(['cid="ad-content-555",e=sk,sid="session-id-123",ts=1764269150,v=2']);
    });

    it('8.2.8 ad sequence, without nr', async () => {
      integration = create([{ url: COLLECTOR, events: ['abs', 'as', 'ae', 'abe'], keys: [] }], {
        ...ids,
        contentId: 'movie-123',
      });
      emit('adbreakstarted', { timestamp: 1764269150 });
      integration.setContentId('ad-001');
      emit('adstarted', { timestamp: 1764269150 });
      emit('adfinished', { timestamp: 1764269170 });
      integration.setContentId('movie-123');
      emit('adbreakfinished', { timestamp: 1764269170 });
      expect(await recordsTo()).toEqual([
        'cid="movie-123",e=abs,sid="session-id-123",ts=1764269150,v=2',
        'cid="ad-001",e=as,sid="session-id-123",ts=1764269150,v=2',
        'cid="ad-001",e=ae,sid="session-id-123",ts=1764269170,v=2',
        'cid="movie-123",e=abe,sid="session-id-123",ts=1764269170,v=2',
      ]);
    });
  });
});
