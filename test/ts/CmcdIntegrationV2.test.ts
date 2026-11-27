import { describe, beforeEach, afterEach, it, expect, jest } from '@jest/globals';
import { HttpRequestMethod, HttpRequestType, HttpResponseType, PlayerAPI } from 'bitmovin-player';
import { CmcdConfig, CmcdIntegration, CustomKey, HeaderType } from '../../src/ts/CmcdIntegration';
import { CmcdData, cmcdDataToHeader } from '../../src/ts/Cmcd';

// Passes the data through to the real encoder, so both the collected data and the output can be checked.
jest.mock('../../src/ts/Cmcd', () => {
  const actual = jest.requireActual<typeof import('../../src/ts/Cmcd')>('../../src/ts/Cmcd');
  return {
    ...actual,
    cmcdDataToHeader: jest.fn(actual.cmcdDataToHeader),
    cmcdDataToUrlParameter: jest.fn(actual.cmcdDataToUrlParameter),
  };
});

/** CMCD data of the last request (header mode) */
const lastData = () => (cmcdDataToHeader as jest.Mock).mock.calls.at(-1)?.[0] as CmcdData;

describe('CmcdIntegration v2', () => {
  const base = 'https://cdn.example.com/content';
  const videoSegments = [
    { url: `${base}/video/2000kbps/seg1.m4s`, duration: 4 },
    { url: `${base}/video/2000kbps/seg2.m4s`, duration: 4 },
    { url: `${base}/video/300kbps/seg 3.m4s`, duration: 4 },
  ];
  const audioSegments = [
    { url: `${base}/audio/128kbps/seg1.m4s`, duration: 2 },
    { url: `${base}/audio/128kbps/seg2.m4s`, duration: 2 },
  ];

  let handlers: Record<string, ((event?: unknown) => void)[]>;
  let state: {
    live: boolean;
    playing: boolean;
    paused: boolean;
    stalled: boolean;
    ended: boolean;
    autoplay: boolean;
    time: number;
    latency: number;
    droppedFrames: number;
  };
  let mockPlayer: PlayerAPI;
  let integration: CmcdIntegration;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  const emit = (event: string, data: object = {}) =>
    (handlers[event] || []).forEach((handler) => handler({ type: event, timestamp: 0, ...data }));

  const create = (config: CmcdConfig = {}) => {
    const created = new CmcdIntegration({
      sessionId: 'session-id-123',
      contentId: 'content-id-123',
      version: 2,
      ...config,
    });
    created.setPlayer(mockPlayer);
    created.onVideoAdaptation({
      representations: [{ id: 'v1', bandwidth: 2_000_000 }],
      suggested: 'v1',
    } as unknown as Parameters<CmcdIntegration['onVideoAdaptation']>[0]);
    created.onAudioAdaptation({
      representations: [{ id: 'a1', bandwidth: 128_000 }],
      suggested: 'a1',
    } as unknown as Parameters<CmcdIntegration['onAudioAdaptation']>[0]);
    return created;
  };

  const send = async (type: HttpRequestType, url: string, target = integration) =>
    target.preprocessHttpRequest(type, {
      credentials: 'omit',
      method: HttpRequestMethod.GET,
      responseType: HttpResponseType.ARRAYBUFFER,
      url,
      headers: {},
    });

  /** Sends a request and returns its CMCD data */
  const dataOf = async (type: HttpRequestType = HttpRequestType.MEDIA_VIDEO, url = videoSegments[0].url) => {
    await send(type, url);
    return lastData();
  };

  const startPlayback = (playAt = 1000, playingAt = 1200) => {
    emit('play', { timestamp: playAt });
    state.playing = true;
    emit('playing', { timestamp: playingAt });
  };

  beforeEach(() => {
    handlers = {};
    state = {
      live: false,
      playing: false,
      paused: false,
      stalled: false,
      ended: false,
      autoplay: false,
      time: 12.3456,
      latency: 3.2,
      droppedFrames: 7,
    };
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockPlayer = {
      isLive: () => state.live,
      isPlaying: () => state.playing,
      isPaused: () => state.paused,
      isStalled: () => state.stalled,
      hasEnded: () => state.ended,
      getPlaybackSpeed: () => 1,
      getConfig: () => ({ playback: { autoplay: state.autoplay } }),
      getCurrentTime: jest.fn(() => state.time),
      getDroppedVideoFrames: () => state.droppedFrames,
      getPlaybackVideoData: () => ({ id: 'v1', bitrate: 1_000_000 }),
      getPlaybackAudioData: () => ({ id: 'a1', bitrate: 64_000 }),
      lowlatency: { getLatency: () => state.latency },
      buffer: { getLevel: () => ({ targetLevel: 30, level: 4 }) },
      getAvailableAudioQualities: () => [{ bitrate: 128_000 }, { bitrate: 64_000 }],
      getAvailableVideoQualities: () => [{ bitrate: 2_000_000 }, { bitrate: 300_000 }, { bitrate: 6_000_000 }],
      getAvailableSegments: () => ({
        'video/mp4': { v1: videoSegments },
        'audio/mp4': { a1: audioSegments },
      }),
      exports: {
        HttpRequestType: {
          MEDIA_AUDIO: 'media/audio',
          MEDIA_VIDEO: 'media/video',
          MANIFEST_DASH: 'manifest/dash',
          DRM_LICENSE_WIDEVINE: 'drm/license/widevine',
        },
        PlayerEvent: {
          SourceUnloaded: 'sourceunloaded',
          StallStarted: 'stallstarted',
          StallEnded: 'stallended',
          Seek: 'seek',
          Seeked: 'seeked',
          TimeShift: 'timeshift',
          TimeShifted: 'timeshifted',
          Play: 'play',
          Playing: 'playing',
          Error: 'error',
          Warning: 'warning',
        },
        BufferType: { ForwardDuration: 'forwardduration' },
        MediaType: { Video: 'video', Audio: 'audio' },
      },
      on: (event: string, handler: () => void) => (handlers[event] = [...(handlers[event] || []), handler]),
      off: (event: string, handler: () => void) =>
        (handlers[event] = (handlers[event] || []).filter((registered) => registered !== handler)),
    } as unknown as PlayerAPI;
    integration = create();
  });

  afterEach(() => warnSpy.mockRestore());

  describe('version', () => {
    it('sends v=2', async () => {
      expect((await dataOf()).v).toBe(2);
      expect((await send(HttpRequestType.MANIFEST_DASH, `${base}/manifest.mpd`)).headers['CMCD-Session']).toContain(
        'v=2'
      );
    });

    it('does not collect v2 keys or listen to v2 events with version 1 or unset', async () => {
      for (const version of [1, undefined] as const) {
        handlers = {};
        integration = create({ version });
        startPlayback();

        const data = await dataOf();
        expect(data.v).toBe(1);
        for (const key of ['bsa', 'bsda', 'dfa', 'ec', 'lb', 'msd', 'pb', 'pt', 'sn', 'sta', 'tbl'] as const) {
          expect(data[key]).toBeUndefined();
        }
        expect(handlers.play).toBeUndefined();
        expect(handlers.error).toBeUndefined();
      }
    });
  });

  describe('setPlayer', () => {
    it('removes the listeners of the previous player', async () => {
      const counts = () => Object.keys(handlers).map((event) => handlers[event].length);
      const countsBefore = counts();
      integration.setPlayer(mockPlayer);

      expect(counts()).toEqual(countsBefore);
      expect(handlers.stallstarted).toHaveLength(1);
      startPlayback();
      await dataOf();
      state.stalled = true;
      emit('stallstarted');
      expect((await dataOf()).bsa).toBe(1);
    });
  });

  describe('request errors', () => {
    it('sends the request unchanged and warns once if no player is set', async () => {
      const withoutPlayer = new CmcdIntegration({ version: 2 });
      const request = await send(HttpRequestType.MEDIA_VIDEO, videoSegments[0].url, withoutPlayer);
      await send(HttpRequestType.MEDIA_VIDEO, videoSegments[0].url, withoutPlayer);

      expect(request.url).toEqual(videoSegments[0].url);
      expect(request.headers).toEqual({});
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Bitmovin Player not provided'));
    });

    it('sends the request unchanged if a player API throws', async () => {
      (mockPlayer as unknown as { isLive: () => boolean }).isLive = () => {
        throw new Error('not available');
      };
      const request = await send(HttpRequestType.MEDIA_VIDEO, videoSegments[0].url);

      expect(request.headers).toEqual({});
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not available'));
    });
  });

  describe('content id (cid) and session id (sid)', () => {
    it('sends cid of up to 128 characters', async () => {
      integration = create({ contentId: 'c'.repeat(128) });
      expect((await dataOf()).cid).toEqual('c'.repeat(128));

      integration = create({ contentId: 'c'.repeat(129) });
      expect((await dataOf()).cid).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('exceeds 128 characters'));
    });

    it('keeps the sid limit of 64 characters', async () => {
      integration = create({ sessionId: 's'.repeat(64) });
      expect((await dataOf()).sid).toEqual('s'.repeat(64));

      integration = create({ sessionId: 's'.repeat(65) });
      expect((await dataOf()).sid).toBeUndefined();
    });
  });

  describe('backgrounded (bg)', () => {
    const setVisibility = (value: string) =>
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });

    afterEach(() => setVisibility('visible'));

    it('is sent while the page is hidden', async () => {
      setVisibility('hidden');
      const request = await send(HttpRequestType.MEDIA_VIDEO, videoSegments[0].url);

      expect(request.headers['CMCD-Status']).toContain('bg');
    });

    it('is not sent while the page is visible', async () => {
      setVisibility('visible');

      expect((await dataOf()).bg).toBeUndefined();
    });

    it('is not sent in v1', async () => {
      setVisibility('hidden');
      integration = create({ version: 1 });
      const request = await send(HttpRequestType.MEDIA_VIDEO, videoSegments[0].url);

      expect(JSON.stringify(request.headers)).not.toMatch(/\bbg\b/);
    });
  });

  describe('play state (sta)', () => {
    it('is preloading before play is requested', async () => {
      expect((await dataOf(HttpRequestType.MANIFEST_DASH)).sta).toBe('d');
    });

    it('is starting with autoplay before playback starts', async () => {
      state.autoplay = true;
      expect((await dataOf(HttpRequestType.MANIFEST_DASH)).sta).toBe('s');
    });

    it('follows the player state', async () => {
      emit('play');
      expect((await dataOf()).sta).toBe('s');

      state.playing = true;
      emit('playing');
      expect((await dataOf()).sta).toBe('p');

      emit('seek');
      expect((await dataOf()).sta).toBe('k');
      emit('seeked');
      emit('timeshift');
      expect((await dataOf()).sta).toBe('k');
      emit('timeshifted');

      state.stalled = true;
      emit('stallstarted');
      expect((await dataOf()).sta).toBe('r');
      state.stalled = false;
      emit('stallended');

      state.playing = false;
      state.paused = true;
      expect((await dataOf()).sta).toBe('a');

      state.paused = false;
      state.ended = true;
      expect((await dataOf()).sta).toBe('e');
    });

    it('is paused if autoplay was blocked', async () => {
      // The player pauses (after warning 1303) without a play event.
      state.autoplay = true;
      state.paused = true;

      expect((await dataOf(HttpRequestType.MEDIA_VIDEO)).sta).toBe('a');
    });

    it('is not rebuffering during startup', async () => {
      emit('play');
      state.stalled = true;
      emit('stallstarted');

      expect((await dataOf()).sta).toBe('s');
    });

    it('is fatal error after an error', async () => {
      startPlayback();
      emit('error', { code: 3011 });

      expect((await dataOf()).sta).toBe('f');
    });

    it('is reset when the source is unloaded', async () => {
      startPlayback();
      emit('error', { code: 3011 });
      emit('sourceunloaded');
      state.playing = false;

      expect((await dataOf(HttpRequestType.MANIFEST_DASH)).sta).toBe('d');
    });
  });

  describe('sequence number (sn)', () => {
    it('starts at 0 and increases per origin', async () => {
      expect((await dataOf(HttpRequestType.MANIFEST_DASH, `${base}/manifest.mpd`)).sn).toBe(0);
      expect((await dataOf(HttpRequestType.DRM_LICENSE_WIDEVINE, 'https://drm.example.com/license')).sn).toBe(0);
      expect((await dataOf()).sn).toBe(1);
      expect((await dataOf(HttpRequestType.MEDIA_AUDIO, audioSegments[0].url)).sn).toBe(2);
      expect((await dataOf(HttpRequestType.DRM_LICENSE_WIDEVINE, 'https://drm.example.com/license')).sn).toBe(1);
    });

    it('is reset to 0 on a new session id only', async () => {
      await dataOf();
      integration.setSessionId('session-id-123');
      expect((await dataOf()).sn).toBe(1);

      integration.setSessionId('session-id-456');
      expect((await dataOf()).sn).toBe(0);
    });

    it('is not reset when the source is unloaded', async () => {
      await dataOf();
      emit('sourceunloaded');

      expect((await dataOf()).sn).toBe(1);
    });

    it('keeps the state of the 16 most recently used origins', async () => {
      const urlOf = (index: number) => `https://cdn${index}.example.com/seg.m4s`;
      for (let index = 0; index < 16; index++) {
        await dataOf(HttpRequestType.MEDIA_VIDEO, urlOf(index));
      }
      // Origin 0 is the most recently used one now, so origin 1 is dropped by origin 16.
      expect((await dataOf(HttpRequestType.MEDIA_VIDEO, urlOf(0))).sn).toBe(1);
      await dataOf(HttpRequestType.MEDIA_VIDEO, urlOf(16));

      expect((await dataOf(HttpRequestType.MEDIA_VIDEO, urlOf(0))).sn).toBe(2);
      expect((await dataOf(HttpRequestType.MEDIA_VIDEO, urlOf(1))).sn).toBe(0);
    });
  });

  describe('media start delay (msd)', () => {
    it('is the time from play to playing, sent once with the next request', async () => {
      emit('play', { timestamp: 1000 });
      expect((await dataOf()).msd).toBeUndefined();

      state.playing = true;
      emit('playing', { timestamp: 1234 });
      const data = await dataOf();
      expect(data.msd).toBe(234);
      expect((cmcdDataToHeader as jest.Mock).mock.results.at(-1)?.value).toEqual(
        expect.objectContaining({ 'CMCD-Session': expect.stringContaining('msd=234') })
      );

      expect((await dataOf()).msd).toBeUndefined();
    });

    it('is not measured again after a pause or seek', async () => {
      startPlayback();
      await dataOf();

      emit('play', { timestamp: 5000 });
      emit('seek');
      emit('seeked');
      emit('playing', { timestamp: 6000 });
      expect((await dataOf()).msd).toBeUndefined();
    });

    it('is sent once per session id', async () => {
      startPlayback(1000, 1200);
      expect((await dataOf()).msd).toBe(200);

      emit('sourceunloaded');
      startPlayback(2000, 2500);
      expect((await dataOf()).msd).toBeUndefined();

      integration.setSessionId('session-id-456');
      emit('sourceunloaded');
      startPlayback(3000, 3300);
      expect((await dataOf()).msd).toBe(300);
    });

    it('is measured from the play event of autoplay', async () => {
      state.autoplay = true;
      expect((await dataOf()).sta).toBe('s');
      startPlayback(1000, 1400);

      expect((await dataOf()).msd).toBe(400);
    });
  });

  describe('buffer starvation (bsa, bsd, bsda)', () => {
    const stall = (from: number, to: number) => {
      state.stalled = true;
      emit('stallstarted', { timestamp: from });
      state.stalled = false;
      emit('stallended', { timestamp: to });
    };

    it('counts rebufferings and their durations', async () => {
      startPlayback();
      let data = await dataOf();
      expect([data.bsa, data.bsd, data.bsda]).toEqual([0, undefined, 0]);
      // Known zero values are sent.
      expect((cmcdDataToHeader as jest.Mock).mock.results.at(-1)?.value).toEqual(
        expect.objectContaining({ 'CMCD-Status': 'bsa=(0),bsda=(0),pt=12346,rtp=10000' })
      );

      stall(10_000, 10_500);
      stall(20_000, 21_200);
      data = await dataOf();
      expect([data.bsa, data.bsd, data.bsda]).toEqual([2, [500, 1200], 1700]);
      expect((cmcdDataToHeader as jest.Mock).mock.results.at(-1)?.value).toEqual(
        expect.objectContaining({ 'CMCD-Status': 'bs,bsa=(2),bsd=(500 1200),bsda=(1700),pt=12346' })
      );

      // bsd is sent once
      data = await dataOf();
      expect([data.bsa, data.bsd, data.bsda]).toEqual([2, undefined, 1700]);
    });

    it('sends the count of an ongoing rebuffering and its duration once it ended', async () => {
      startPlayback();
      state.stalled = true;
      emit('stallstarted', { timestamp: 10_000 });
      let data = await dataOf();
      expect([data.bsa, data.bsd, data.bsda]).toEqual([1, undefined, 0]);

      emit('stallended', { timestamp: 10_300 });
      data = await dataOf();
      expect([data.bsa, data.bsd, data.bsda]).toEqual([1, [300], 300]);
    });

    it('does not count stalls during startup or seeking', async () => {
      emit('play');
      stall(1000, 2000);
      state.playing = true;
      emit('playing');
      emit('seek');
      stall(3000, 4000);
      emit('seeked');

      const data = await dataOf();
      expect([data.bsa, data.bsd, data.bsda]).toEqual([0, undefined, 0]);
    });

    it('is reset on a new session id', async () => {
      startPlayback();
      await dataOf();
      stall(10_000, 10_500);
      integration.setSessionId('session-id-456');

      const data = await dataOf();
      expect([data.bsa, data.bsd, data.bsda]).toEqual([0, undefined, 0]);
    });

    it('counts an ongoing rebuffering in the new session from the session change', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(20_000);
      startPlayback();
      await dataOf();
      state.stalled = true;
      emit('stallstarted', { timestamp: 10_000 });
      integration.setSessionId('session-id-456');
      emit('stallended', { timestamp: 20_500 });
      nowSpy.mockRestore();

      const data = await dataOf();
      expect([data.bsa, data.bsd, data.bsda]).toEqual([1, [500], 500]);
    });

    it('reports each rebuffering duration once to each origin', async () => {
      const otherOrigin = 'https://drm.example.com/license';
      startPlayback();
      await dataOf();
      await dataOf(HttpRequestType.DRM_LICENSE_WIDEVINE, otherOrigin);
      stall(10_000, 10_500);

      expect((await dataOf()).bsd).toEqual([500]);
      expect((await dataOf()).bsd).toBeUndefined();
      expect((await dataOf(HttpRequestType.DRM_LICENSE_WIDEVINE, otherOrigin)).bsd).toEqual([500]);
      expect((await dataOf(HttpRequestType.DRM_LICENSE_WIDEVINE, otherOrigin)).bsd).toBeUndefined();
    });
  });

  describe('player error codes (ec)', () => {
    it('buffers error codes until the next request', async () => {
      await dataOf();
      emit('error', { code: 3011 });
      emit('error', { code: 3011 });
      emit('error', { code: 1001 });

      expect((await dataOf()).ec).toEqual(['3011', '1001']);
      expect((cmcdDataToHeader as jest.Mock).mock.results.at(-1)?.value).toEqual(
        expect.objectContaining({ 'CMCD-Status': 'bsa=(0),bsda=(0),ec=("3011" "1001"),pr=0.0' })
      );
      expect((await dataOf()).ec).toBeUndefined();
    });

    it('does not report warnings, as their codes overlap with error codes', async () => {
      await dataOf();
      emit('warning', { code: 1001 });

      expect((await dataOf()).ec).toBeUndefined();
      expect(handlers.warning).toBeUndefined();
    });

    it('reports each error code once to each origin', async () => {
      const otherOrigin = 'https://drm.example.com/license';
      await dataOf();
      await dataOf(HttpRequestType.DRM_LICENSE_WIDEVINE, otherOrigin);
      emit('error', { code: 3011 });

      expect((await dataOf()).ec).toEqual(['3011']);
      expect((await dataOf()).ec).toBeUndefined();
      expect((await dataOf(HttpRequestType.DRM_LICENSE_WIDEVINE, otherOrigin)).ec).toEqual(['3011']);
    });

    it('drops buffered codes on a new session id', async () => {
      await dataOf();
      emit('error', { code: 3011 });
      integration.setSessionId('session-id-456');

      expect((await dataOf()).ec).toBeUndefined();
    });
  });

  describe('playhead time (pt)', () => {
    it('is not sent before playback started', async () => {
      expect((await dataOf()).pt).toBeUndefined();
    });

    it('is the relative time for VOD', async () => {
      startPlayback();

      expect((await dataOf()).pt).toBeCloseTo(12345.6);
      expect(mockPlayer.getCurrentTime).toHaveBeenLastCalledWith('relativetime');
    });

    it('is the wallclock time for live', async () => {
      state.live = true;
      state.time = 1_752_000_000.5;
      startPlayback();

      expect((await dataOf()).pt).toBe(1_752_000_000_500);
      expect(mockPlayer.getCurrentTime).toHaveBeenLastCalledWith();
    });

    it('is the current time for live without a wallclock time', async () => {
      state.live = true;
      state.time = 632.782;
      startPlayback();

      expect((await dataOf()).pt).toBe(632782);
    });
  });

  describe('live latency (ltc)', () => {
    it('is sent for live after startup', async () => {
      state.live = true;
      expect((await dataOf()).ltc).toBeUndefined();

      startPlayback();
      expect((await dataOf()).ltc).toBe(3200);
    });

    it('is not sent for VOD or an unknown latency', async () => {
      startPlayback();
      expect((await dataOf()).ltc).toBeUndefined();

      state.live = true;
      state.latency = NaN;
      expect((await dataOf()).ltc).toBeUndefined();
    });
  });

  describe('segment request keys', () => {
    it('sends lb, tb, tbl and pb of the requested media type', async () => {
      let data = await dataOf();
      expect([data.lb, data.tb, data.tbl, data.pb]).toEqual([300, 6000, 30000, 1000]);

      data = await dataOf(HttpRequestType.MEDIA_AUDIO, audioSegments[0].url);
      expect([data.lb, data.tb, data.tbl, data.pb]).toEqual([64, 128, 30000, 64]);
    });

    it('sends dfa for video requests only', async () => {
      expect((await dataOf()).dfa).toBe(7);
      expect((await dataOf(HttpRequestType.MEDIA_AUDIO, audioSegments[0].url)).dfa).toBeUndefined();
    });

    it('sends dfa=0', async () => {
      state.droppedFrames = 0;

      expect((await send(HttpRequestType.MEDIA_VIDEO, videoSegments[0].url)).headers['CMCD-Request']).toContain(
        'dfa=0'
      );
    });

    it('counts dfa since session start across sources', async () => {
      expect((await dataOf()).dfa).toBe(7);
      emit('sourceunloaded');
      state.droppedFrames = 3;
      expect((await dataOf()).dfa).toBe(10);

      // A new session id starts at 0 from the current count.
      integration.setSessionId('session-id-456');
      state.droppedFrames = 5;
      expect((await dataOf()).dfa).toBe(2);
      emit('sourceunloaded');
      state.droppedFrames = 1;
      expect((await dataOf()).dfa).toBe(3);
    });

    it('does not send segment keys for other requests', async () => {
      const data = await dataOf(HttpRequestType.MANIFEST_DASH, `${base}/manifest.mpd`);

      for (const key of ['bl', 'br', 'd', 'dfa', 'lb', 'mtp', 'nor', 'pb', 'tb', 'tbl'] as const) {
        expect(data[key]).toBeUndefined();
      }
    });

    it('sends nor as plain relative path', async () => {
      const request = await send(HttpRequestType.MEDIA_VIDEO, videoSegments[1].url);

      expect(request.headers['CMCD-Request']).toContain('nor=("../300kbps/seg%203.m4s")');
    });

    it('sends nor of a non-ASCII segment URL percent-encoded in query mode', async () => {
      const segment = { url: `${base}/video/2000kbps/café.m4s`, duration: 4 };
      videoSegments.splice(1, 0, segment);
      try {
        integration = create({ useQueryArgs: true });
        const request = await send(HttpRequestType.MEDIA_VIDEO, videoSegments[0].url);

        // The URL parser percent-encodes the path, so the value is ASCII and is not dropped.
        expect(decodeURIComponent(request.url)).toContain('nor=("caf%C3%A9.m4s")');
      } finally {
        videoSegments.splice(1, 1);
      }
    });
  });

  it('sends a start-up sequence', async () => {
    integration = create({
      customKeys: [new CustomKey('com.example-k', 7, HeaderType.Session)],
    });
    const headers = [];

    headers.push((await send(HttpRequestType.MANIFEST_DASH, `${base}/manifest.mpd`)).headers);
    emit('play', { timestamp: 1000 });
    headers.push((await send(HttpRequestType.MEDIA_VIDEO, videoSegments[0].url)).headers);
    await integration.preprocessHttpResponse(HttpRequestType.MEDIA_VIDEO, {
      elapsedTime: 0.5,
      length: 1_000_000,
    } as unknown as Parameters<CmcdIntegration['preprocessHttpResponse']>[1]);
    state.playing = true;
    emit('playing', { timestamp: 1200 });
    headers.push((await send(HttpRequestType.MEDIA_VIDEO, videoSegments[1].url)).headers);

    expect(headers).toEqual([
      {
        // Requested before play: preloading
        'CMCD-Request': 'sn=0,sta=d,su',
        'CMCD-Object': 'ot=m',
        'CMCD-Status': 'bsa=(0),bsda=(0),pr=0.0',
        'CMCD-Session': 'cid="content-id-123",com.example-k="7",sf=d,sid="session-id-123",st=v,v=2',
      },
      {
        'CMCD-Request': 'bl=(4000),dfa=7,dl=4000,nor=("seg2.m4s"),pb=(1000;v),sn=1,sta=s,su,tbl=(30000)',
        'CMCD-Object': 'br=(2000;v),d=4000,lb=(300;v),ot=v,tb=(6000;v)',
        'CMCD-Status': 'bsa=(0),bsda=(0),pr=0.0',
        'CMCD-Session': 'cid="content-id-123",com.example-k="7",sf=d,sid="session-id-123",st=v,v=2',
      },
      {
        'CMCD-Request':
          'bl=(4000),dfa=7,dl=4000,mtp=(16000),nor=("../300kbps/seg%203.m4s"),pb=(1000;v),sn=2,sta=p,tbl=(30000)',
        'CMCD-Object': 'br=(2000;v),d=4000,lb=(300;v),ot=v,tb=(6000;v)',
        'CMCD-Status': 'bsa=(0),bsda=(0),pt=12346,rtp=10000',
        'CMCD-Session': 'cid="content-id-123",com.example-k="7",msd=200,sf=d,sid="session-id-123",st=v,v=2',
      },
    ]);
  });
});
