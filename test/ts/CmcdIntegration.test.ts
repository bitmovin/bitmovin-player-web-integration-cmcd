import { describe, beforeEach, afterEach, it, expect, jest } from '@jest/globals';
import { HttpRequest, HttpRequestMethod, HttpRequestType, HttpResponseType, PlayerAPI } from 'bitmovin-player';
import { CmcdIntegration, CmcdConfig } from '../../src/ts/CmcdIntegration';
import { CmcdCustomKey, CmcdDataV1, cmcdDataToHeader, cmcdDataToUrlParameter, CmcdHeaderType } from '../../src/ts/Cmcd';

// Jest Mocking for helper functions
jest.mock('../../src/ts/Cmcd', () => {
  const actual = jest.requireActual<typeof import('../../src/ts/Cmcd')>('../../src/ts/Cmcd');
  return {
    ...actual,
    cmcdDataToHeader: jest.fn(),
    cmcdDataToUrlParameter: jest.fn(),
  };
});

const actualCmcd = jest.requireActual<typeof import('../../src/ts/Cmcd')>('../../src/ts/Cmcd');

/** CMCD data passed to the encoder by the last request in query mode. */
const lastCmcdData = () => (cmcdDataToUrlParameter as jest.Mock).mock.calls.at(-1)?.[0] as CmcdDataV1;

describe('CmcdIntegration', () => {
  let cmcdIntegration: CmcdIntegration;
  let config: CmcdConfig;
  let mockPlayer: PlayerAPI;
  let playerEventHandlers: Record<string, () => void>;

  beforeEach(() => {
    playerEventHandlers = {};
    config = {
      sessionId: 'test-session',
      contentId: 'test-content',
      useQueryArgs: true,
      customKeys: [],
    };

    cmcdIntegration = new CmcdIntegration(config);

    mockPlayer = {
      isLive: jest.fn().mockReturnValue(false),
      getPlaybackSpeed: jest.fn().mockReturnValue(1),
      buffer: {
        getLevel: jest.fn().mockReturnValue({
          targetLevel: 10,
          level: 5,
        }),
      },
      getAvailableAudioQualities: jest
        .fn()
        .mockReturnValue([{ bitrate: 64000 }, { bitrate: 128000 }, { bitrate: 256000 }]),
      getAvailableVideoQualities: jest
        .fn()
        .mockReturnValue([{ bitrate: 500000 }, { bitrate: 800000 }, { bitrate: 1200000 }]),
      getAvailableSegments: jest.fn(),
      isStalled: jest.fn().mockReturnValue(false),
      isPlaying: jest.fn().mockReturnValue(true),
      exports: {
        HttpRequestType: {
          MEDIA_AUDIO: 'media/audio',
          MEDIA_VIDEO: 'media/video',
          MANIFEST_DASH: 'manifest/dash',
          MANIFEST_HLS_MASTER: 'manifest/hls/master',
          MANIFEST_HLS_VARIANT: 'manifest/hls/variant',
          MANIFEST_SMOOTH: 'manifest/smooth',
          MANIFEST_ADS: 'manifest/ads',
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
          Playing: 'playing',
        },
        BufferType: {
          ForwardDuration: 'forwardduration',
          BackwardDuration: 'backwardduration',
        },
        MediaType: {
          Video: 'video',
          Audio: 'audio',
        },
      },
      on: jest.fn((event: string, handler: () => void) => {
        playerEventHandlers[event] = handler;
      }),
    } as unknown as PlayerAPI;

    cmcdIntegration.setPlayer(mockPlayer);
  });

  it('should throw an error if custom keys without headerType are added when useQueryArgs is false', async () => {
    config.useQueryArgs = false;
    config.customKeys = [new CmcdCustomKey('com.example-myCustomKey', 'value')];

    expect(() => new CmcdIntegration(config)).toThrowError();
  });

  it('should not throw an error if custom keys with headerType are added when useQueryArgs is false', async () => {
    config.useQueryArgs = false;
    config.customKeys = [new CmcdCustomKey('com.example-myCustomKey', 'value', CmcdHeaderType.Request)];

    expect(() => new CmcdIntegration(config)).not.toThrowError();
  });

  it('should not throw an error if custom keys without headerType are added when useQueryArgs is true', async () => {
    config.useQueryArgs = true;
    config.customKeys = [new CmcdCustomKey('com.example-myCustomKey', 'value')];
    expect(() => new CmcdIntegration(config)).not.toThrowError();
  });

  it('should not throw an error if custom keys with headerType are added when useQueryArgs is true', async () => {
    config.useQueryArgs = true;
    config.customKeys = [new CmcdCustomKey('com.example-myCustomKey', 'value', CmcdHeaderType.Request)];
    expect(() => new CmcdIntegration(config)).not.toThrowError();
  });

  it('should throw an error if at least on custom key without headerType is added when useQueryArgs is false', async () => {
    config.useQueryArgs = false;
    config.customKeys = [
      new CmcdCustomKey('com.example-myCustomKey1', 'value1', CmcdHeaderType.Status),
      new CmcdCustomKey('com.example-myCustomKey2', 'value2'),
      new CmcdCustomKey('com.example-myCustomKey3', 'value3', CmcdHeaderType.Request),
    ];

    expect(() => new CmcdIntegration(config)).toThrowError();
  });

  describe('preprocessHttpRequest', () => {
    it('should add CMCD data as query parameters when useQueryArgs is true', async () => {
      const request: HttpRequest = {
        credentials: 'omit',
        method: HttpRequestMethod.GET,
        responseType: HttpResponseType.ARRAYBUFFER,
        url: 'https://example.com/manifest.m3u8',
        headers: {},
      };

      (cmcdDataToUrlParameter as jest.Mock).mockReturnValue('CMCD=mockData');

      const processedRequest = await cmcdIntegration.preprocessHttpRequest(
        HttpRequestType.MANIFEST_HLS_MASTER,
        request
      );

      expect(processedRequest.url).toBe('https://example.com/manifest.m3u8?CMCD=mockData');
      expect(cmcdDataToUrlParameter).toHaveBeenCalled();
    });

    it('should remove existing CMCD query parameters before adding new ones', async () => {
      const request: HttpRequest = {
        credentials: 'omit',
        method: HttpRequestMethod.GET,
        responseType: HttpResponseType.ARRAYBUFFER,
        url: 'https://example.com/manifest.m3u8?CMCD=oldData',
        headers: {},
      };

      (cmcdDataToUrlParameter as jest.Mock).mockReturnValue('CMCD=newData');

      const processedRequest = await cmcdIntegration.preprocessHttpRequest(HttpRequestType.MEDIA_VIDEO, request);

      expect(processedRequest.url).toBe('https://example.com/manifest.m3u8?CMCD=newData');
      expect(cmcdDataToUrlParameter).toHaveBeenCalled();
    });

    it('should not re-encode pre-existing query parameters', async () => {
      const request: HttpRequest = {
        credentials: 'omit',
        method: HttpRequestMethod.GET,
        responseType: HttpResponseType.ARRAYBUFFER,
        url: 'https://example.com/manifest.m3u8?ateme_date_begin=2026-07-24T13:20:00Z&token=a+b%2Fc',
        headers: {},
      };

      (cmcdDataToUrlParameter as jest.Mock).mockReturnValue('CMCD=mockData');

      const processedRequest = await cmcdIntegration.preprocessHttpRequest(HttpRequestType.MEDIA_VIDEO, request);

      expect(processedRequest.url).toBe(
        'https://example.com/manifest.m3u8?ateme_date_begin=2026-07-24T13:20:00Z&token=a+b%2Fc&CMCD=mockData'
      );
    });

    it('should keep pre-existing query parameters when replacing an existing CMCD parameter', async () => {
      const request: HttpRequest = {
        credentials: 'omit',
        method: HttpRequestMethod.GET,
        responseType: HttpResponseType.ARRAYBUFFER,
        url: 'https://example.com/manifest.m3u8?CMCD=oldData&ateme_date_begin=2026-07-24T13:20:00Z',
        headers: {},
      };

      (cmcdDataToUrlParameter as jest.Mock).mockReturnValue('CMCD=newData');

      const processedRequest = await cmcdIntegration.preprocessHttpRequest(HttpRequestType.MEDIA_VIDEO, request);

      expect(processedRequest.url).toBe(
        'https://example.com/manifest.m3u8?ateme_date_begin=2026-07-24T13:20:00Z&CMCD=newData'
      );
    });

    it('should add the CMCD parameter before the fragment', async () => {
      const request: HttpRequest = {
        credentials: 'omit',
        method: HttpRequestMethod.GET,
        responseType: HttpResponseType.ARRAYBUFFER,
        url: 'https://example.com/manifest.m3u8?ateme_date_begin=2026-07-24T13:20:00Z#t=10',
        headers: {},
      };

      (cmcdDataToUrlParameter as jest.Mock).mockReturnValue('CMCD=mockData');

      const processedRequest = await cmcdIntegration.preprocessHttpRequest(HttpRequestType.MEDIA_VIDEO, request);

      expect(processedRequest.url).toBe(
        'https://example.com/manifest.m3u8?ateme_date_begin=2026-07-24T13:20:00Z&CMCD=mockData#t=10'
      );
    });

    it('should add CMCD data as headers when useQueryArgs is false', async () => {
      cmcdIntegration = new CmcdIntegration({ ...config, useQueryArgs: false });
      cmcdIntegration.setPlayer(mockPlayer);

      const request: HttpRequest = {
        credentials: 'omit',
        method: HttpRequestMethod.GET,
        responseType: HttpResponseType.ARRAYBUFFER,
        url: 'https://example.com/manifest.m3u8?',
        headers: {},
      };

      (cmcdDataToHeader as jest.Mock).mockReturnValue({ 'CMCD-Header': 'mockData' });

      const processedRequest = await cmcdIntegration.preprocessHttpRequest(HttpRequestType.MEDIA_VIDEO, request);

      expect(processedRequest.headers).toEqual({ 'CMCD-Header': 'mockData' });
      expect(cmcdDataToHeader).toHaveBeenCalled();
    });

    it.each([true, false])('should pass the custom keys to the encoder (useQueryArgs: %s)', async (useQueryArgs) => {
      const customKeys = [new CmcdCustomKey('com.example-myCustomKey', 'value', CmcdHeaderType.Request)];
      cmcdIntegration = new CmcdIntegration({ ...config, useQueryArgs, customKeys });
      cmcdIntegration.setPlayer(mockPlayer);
      const encoder = (useQueryArgs ? cmcdDataToUrlParameter : cmcdDataToHeader) as jest.Mock;
      encoder.mockClear();

      await cmcdIntegration.preprocessHttpRequest(HttpRequestType.MEDIA_VIDEO, {
        credentials: 'omit',
        method: HttpRequestMethod.GET,
        responseType: HttpResponseType.ARRAYBUFFER,
        url: 'https://example.com/segment.m4s',
        headers: {},
      });

      expect(encoder).toHaveBeenCalledWith(expect.any(Object), customKeys);
    });
  });

  describe('preprocessHttpResponse', () => {
    const buildResponse = (elapsedTime: number, length: number) =>
      ({
        request: {} as HttpRequest,
        url: 'https://example.com/segment.ts',
        headers: {},
        status: 200,
        body: new ArrayBuffer(0),
        elapsedTime,
        length,
      } as unknown as Parameters<CmcdIntegration['preprocessHttpResponse']>[1]);

    const getMeasuredThroughput = async (type: HttpRequestType) => {
      const request: HttpRequest = {
        credentials: 'omit',
        method: HttpRequestMethod.GET,
        responseType: HttpResponseType.ARRAYBUFFER,
        url: 'https://example.com/segment.ts',
        headers: {},
      };
      (cmcdDataToUrlParameter as jest.Mock).mockReturnValue('CMCD=mockData');
      await cmcdIntegration.preprocessHttpRequest(type, request);
      return lastCmcdData().mtp;
    };

    it('measures throughput in kilobits per second (bytes are converted to bits)', async () => {
      // 1,000,000 bytes over 1 second = 8,000,000 bit/s = 8000 kbps, not 1000.
      await cmcdIntegration.preprocessHttpResponse(HttpRequestType.MEDIA_VIDEO, buildResponse(1, 1_000_000));

      expect(await getMeasuredThroughput(HttpRequestType.MEDIA_VIDEO)).toBe(8000);
    });

    it('tracks audio and video throughput independently', async () => {
      await cmcdIntegration.preprocessHttpResponse(HttpRequestType.MEDIA_AUDIO, buildResponse(1, 125_000));
      await cmcdIntegration.preprocessHttpResponse(HttpRequestType.MEDIA_VIDEO, buildResponse(2, 1_000_000));

      expect(await getMeasuredThroughput(HttpRequestType.MEDIA_AUDIO)).toBe(1000);
      expect(await getMeasuredThroughput(HttpRequestType.MEDIA_VIDEO)).toBe(4000);
    });

    it('does not throw and passes on a missing response (e.g. network error)', async () => {
      const missingResponse = undefined as unknown as Parameters<CmcdIntegration['preprocessHttpResponse']>[1];

      await expect(cmcdIntegration.preprocessHttpResponse(HttpRequestType.MEDIA_VIDEO, missingResponse)).resolves.toBe(
        missingResponse
      );
      await expect(
        cmcdIntegration.preprocessHttpResponse(HttpRequestType.MEDIA_AUDIO, null as never)
      ).resolves.toBeNull();
    });

    it('does not record throughput when the response is missing timing or length', async () => {
      await cmcdIntegration.preprocessHttpResponse(HttpRequestType.MEDIA_VIDEO, buildResponse(0, 1_000_000));

      expect(await getMeasuredThroughput(HttpRequestType.MEDIA_VIDEO)).toBeUndefined();
    });
  });

  describe('segment request data', () => {
    const baseUrl = 'https://cdn.example.com/content';
    const videoSegments = [
      { url: `${baseUrl}/video/1000kbps/seg1.m4s`, duration: 4 },
      { url: `${baseUrl}/video/1000kbps/seg2.m4s`, duration: 4 },
      { url: `${baseUrl}/video/1000kbps/seg3.m4s` },
    ];
    const audioSegments = [
      { url: `${baseUrl}/audio/128kbps/seg1.m4s`, duration: 2 },
      { url: `${baseUrl}/audio/128kbps/seg2.m4s`, duration: 2 },
    ];

    const getCmcdData = async (type: HttpRequestType, url: string) => {
      const request: HttpRequest = {
        credentials: 'omit',
        method: HttpRequestMethod.GET,
        responseType: HttpResponseType.ARRAYBUFFER,
        url,
        headers: {},
      };
      (cmcdDataToUrlParameter as jest.Mock).mockReturnValue('CMCD=mockData');
      await cmcdIntegration.preprocessHttpRequest(type, request);
      // Encoded key-value pair per key, e.g. `{ d: 'd=4000' }`
      const data = lastCmcdData();
      return Object.fromEntries(
        (Object.keys(data) as (keyof CmcdDataV1)[]).map((key) => [
          key,
          Object.values(actualCmcd.cmcdDataToHeader({ [key]: data[key] })).join(),
        ])
      );
    };

    beforeEach(() => {
      (mockPlayer.getAvailableSegments as jest.Mock).mockReturnValue({
        'video/mp4': { v1: videoSegments },
        'audio/mp4': { a1: audioSegments },
      });
      cmcdIntegration.onVideoAdaptation({
        representations: [{ id: 'v1', bandwidth: 2_000_000 }],
        suggested: 'v1',
      } as unknown as Parameters<CmcdIntegration['onVideoAdaptation']>[0]);
      cmcdIntegration.onAudioAdaptation({
        representations: [{ id: 'a1', bandwidth: 128_000 }],
        suggested: 'a1',
      } as unknown as Parameters<CmcdIntegration['onAudioAdaptation']>[0]);
    });

    it('sends nor as URL encoded path relative to the current request', async () => {
      const data = await getCmcdData(HttpRequestType.MEDIA_VIDEO, videoSegments[0].url);

      expect(data.nor).toEqual('nor="seg2.m4s"');
      expect(data.d).toEqual('d=4000');
    });

    it('sends nor with parent directory segments if the next object is in another directory', async () => {
      (mockPlayer.getAvailableSegments as jest.Mock).mockReturnValue({
        'video/mp4': { v1: [videoSegments[0], { url: `${baseUrl}/video/300kbps/seg2.m4s` }] },
      });

      const data = await getCmcdData(HttpRequestType.MEDIA_VIDEO, videoSegments[0].url);

      expect(data.nor).toEqual('nor="..%2F300kbps%2Fseg2.m4s"');
    });

    it('omits nor if the next object is on a different origin', async () => {
      (mockPlayer.getAvailableSegments as jest.Mock).mockReturnValue({
        'video/mp4': { v1: [videoSegments[0], { url: 'https://other-cdn.example.com/seg2.m4s' }] },
      });

      const data = await getCmcdData(HttpRequestType.MEDIA_VIDEO, videoSegments[0].url);

      expect(data.nor).toBeUndefined();
    });

    it('omits d if the segment duration is unknown', async () => {
      const data = await getCmcdData(HttpRequestType.MEDIA_VIDEO, videoSegments[2].url);

      expect(data.d).toBeUndefined();
      expect(data.nor).toBeUndefined();
    });

    it('uses audio segments for audio requests', async () => {
      const data = await getCmcdData(HttpRequestType.MEDIA_AUDIO, audioSegments[0].url);

      expect(data.nor).toEqual('nor="seg2.m4s"');
      expect(data.d).toEqual('d=2000');
      expect(data.br).toEqual('br=128');
    });

    it('does not send rtp during startup', async () => {
      const data = await getCmcdData(HttpRequestType.MEDIA_VIDEO, videoSegments[0].url);

      expect(data.rtp).toBeUndefined();
    });

    it('sends rtp as a multiple of the encoded bitrate once playback started', async () => {
      playerEventHandlers.playing();

      const data = await getCmcdData(HttpRequestType.MEDIA_VIDEO, videoSegments[0].url);

      expect(data.br).toEqual('br=2000');
      expect(data.rtp).toEqual('rtp=10000');
    });

    it('does not send rtp while the buffer is starving', async () => {
      playerEventHandlers.playing();
      (mockPlayer.isStalled as jest.Mock).mockReturnValue(true);

      const data = await getCmcdData(HttpRequestType.MEDIA_VIDEO, videoSegments[0].url);

      expect(data.rtp).toBeUndefined();
    });

    it('does not send rtp for non-media requests', async () => {
      playerEventHandlers.playing();

      const data = await getCmcdData(HttpRequestType.MANIFEST_HLS_MASTER, `${baseUrl}/master.m3u8`);

      expect(data.rtp).toBeUndefined();
    });

    it('stops sending su once playback started', async () => {
      expect((await getCmcdData(HttpRequestType.MEDIA_VIDEO, videoSegments[0].url)).su).toEqual('su');

      playerEventHandlers.playing();
      expect((await getCmcdData(HttpRequestType.MEDIA_VIDEO, videoSegments[1].url)).su).toBeUndefined();
    });
  });

  describe('streaming format (sf)', () => {
    /** Sends the requests and returns `sf` of each. */
    const send = async (...types: HttpRequestType[]) => {
      const formats = [];
      for (const type of types) {
        await cmcdIntegration.preprocessHttpRequest(type, {
          credentials: 'omit',
          method: HttpRequestMethod.GET,
          responseType: HttpResponseType.ARRAYBUFFER,
          url: 'https://example.com/request',
          headers: {},
        });
        formats.push(lastCmcdData().sf);
      }
      return formats;
    };

    it('is not sent until the format is known', async () => {
      expect(await send(HttpRequestType.DRM_LICENSE_WIDEVINE, HttpRequestType.MANIFEST_ADS)).toEqual([
        undefined,
        undefined,
      ]);
    });

    it('is not determined by a non-manifest request that precedes the manifest', async () => {
      expect(
        await send(HttpRequestType.MANIFEST_ADS, HttpRequestType.MANIFEST_DASH, HttpRequestType.MEDIA_VIDEO)
      ).toEqual([undefined, 'd', 'd']);
    });

    it.each([
      [HttpRequestType.MANIFEST_DASH, 'd'],
      [HttpRequestType.MANIFEST_HLS_MASTER, 'h'],
      [HttpRequestType.MANIFEST_HLS_VARIANT, 'h'],
      [HttpRequestType.MANIFEST_SMOOTH, 's'],
    ])('is derived from %s', async (type, token) => {
      expect(await send(type)).toEqual([token]);
    });

    it('follows a new main manifest even if the previous source was never unloaded', async () => {
      expect(
        await send(HttpRequestType.MANIFEST_DASH, HttpRequestType.MANIFEST_HLS_MASTER, HttpRequestType.MEDIA_VIDEO)
      ).toEqual(['d', 'h', 'h']);
    });

    it('does not let an HLS variant request override a known format', async () => {
      expect(await send(HttpRequestType.MANIFEST_DASH, HttpRequestType.MANIFEST_HLS_VARIANT)).toEqual(['d', 'd']);
    });
  });

  describe('playback rate (pr)', () => {
    const sendAndGetRate = async () => {
      await cmcdIntegration.preprocessHttpRequest(HttpRequestType.MEDIA_VIDEO, {
        credentials: 'omit',
        method: HttpRequestMethod.GET,
        responseType: HttpResponseType.ARRAYBUFFER,
        url: 'https://example.com/segment.m4s',
        headers: {},
      });
      return lastCmcdData().pr;
    };

    it('is the playback speed while playing', async () => {
      (mockPlayer.getPlaybackSpeed as jest.Mock).mockReturnValue(2);

      expect(await sendAndGetRate()).toBe(2);
    });

    it('is 0 while paused or before the first play, regardless of the playback speed', async () => {
      (mockPlayer.isPlaying as jest.Mock).mockReturnValue(false);
      (mockPlayer.getPlaybackSpeed as jest.Mock).mockReturnValue(2);

      expect(await sendAndGetRate()).toBe(0);
    });
  });

  describe('source change', () => {
    const segmentUrl = 'https://example.com/video/seg1.m4s';

    const sendSegmentRequest = async (type: HttpRequestType = HttpRequestType.MEDIA_VIDEO) => {
      await cmcdIntegration.preprocessHttpRequest(type, {
        credentials: 'omit',
        method: HttpRequestMethod.GET,
        responseType: HttpResponseType.ARRAYBUFFER,
        url: segmentUrl,
        headers: {},
      });
      const data = lastCmcdData();
      return (Object.keys(data) as (keyof CmcdDataV1)[]).filter((key) => data[key] !== undefined);
    };

    beforeEach(() => {
      (mockPlayer.getAvailableSegments as jest.Mock).mockReturnValue({
        'video/mp4': {
          v1: [
            { url: segmentUrl, duration: 4 },
            { url: 'https://example.com/video/seg2.m4s', duration: 4 },
          ],
        },
      });
      (cmcdDataToUrlParameter as jest.Mock).mockReturnValue('CMCD=mockData');
    });

    it('resets the state of the previous source when it is unloaded', async () => {
      await cmcdIntegration.preprocessHttpRequest(HttpRequestType.MANIFEST_DASH, {
        credentials: 'omit',
        method: HttpRequestMethod.GET,
        responseType: HttpResponseType.ARRAYBUFFER,
        url: 'https://example.com/manifest.mpd',
        headers: {},
      });
      cmcdIntegration.onVideoAdaptation({
        representations: [{ id: 'v1', bandwidth: 2_000_000 }],
        suggested: 'v1',
      } as unknown as Parameters<CmcdIntegration['onVideoAdaptation']>[0]);
      await cmcdIntegration.preprocessHttpResponse(HttpRequestType.MEDIA_VIDEO, {
        elapsedTime: 1,
        length: 1_000_000,
      } as unknown as Parameters<CmcdIntegration['preprocessHttpResponse']>[1]);
      playerEventHandlers.playing();

      const keysBefore = await sendSegmentRequest();
      expect(keysBefore).toEqual(expect.arrayContaining(['br', 'mtp', 'rtp', 'nor', 'sf']));
      expect(keysBefore).not.toContain('su');

      playerEventHandlers.stallstarted();
      playerEventHandlers.playing();
      playerEventHandlers.sourceunloaded();

      const keysAfter = await sendSegmentRequest();

      expect(keysAfter).not.toContain('br');
      expect(keysAfter).not.toContain('mtp');
      expect(keysAfter).not.toContain('bs');
      expect(keysAfter).toContain('su');
      // `sf` of the old source is not reused
      expect(keysAfter).not.toContain('sf');
    });

    it('resets the audio state of the previous source when it is unloaded', async () => {
      cmcdIntegration.onAudioAdaptation({
        representations: [{ id: 'a1', bandwidth: 128_000 }],
        suggested: 'a1',
      } as unknown as Parameters<CmcdIntegration['onAudioAdaptation']>[0]);
      await cmcdIntegration.preprocessHttpResponse(HttpRequestType.MEDIA_AUDIO, {
        elapsedTime: 1,
        length: 1_000_000,
      } as unknown as Parameters<CmcdIntegration['preprocessHttpResponse']>[1]);

      const keysBefore = await sendSegmentRequest(HttpRequestType.MEDIA_AUDIO);
      expect(keysBefore).toEqual(expect.arrayContaining(['br', 'mtp']));

      playerEventHandlers.sourceunloaded();

      const keysAfter = await sendSegmentRequest(HttpRequestType.MEDIA_AUDIO);
      expect(keysAfter).not.toContain('br');
      expect(keysAfter).not.toContain('mtp');
    });
  });

  describe('content id (cid) and session id (sid)', () => {
    let warnSpy: jest.SpiedFunction<typeof console.warn>;

    const send = async (integration: CmcdIntegration) => {
      await integration.preprocessHttpRequest(HttpRequestType.MANIFEST_DASH, {
        credentials: 'omit',
        method: HttpRequestMethod.GET,
        responseType: HttpResponseType.ARRAYBUFFER,
        url: 'https://example.com/manifest.mpd',
        headers: {},
      });
    };

    const createIntegration = (cfg: Partial<CmcdConfig>) => {
      const integration = new CmcdIntegration({ ...config, ...cfg });
      integration.setPlayer(mockPlayer);
      return integration;
    };

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => warnSpy.mockRestore());

    it('sends ids of up to 64 characters', async () => {
      await send(createIntegration({ contentId: 'c'.repeat(64), sessionId: 's'.repeat(64) }));

      expect(lastCmcdData().cid).toEqual('c'.repeat(64));
      expect(lastCmcdData().sid).toEqual('s'.repeat(64));
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('omits ids longer than 64 characters instead of truncating them', async () => {
      await send(createIntegration({ contentId: 'c'.repeat(65), sessionId: 's'.repeat(65) }));

      expect(lastCmcdData().cid).toBeUndefined();
      expect(lastCmcdData().sid).toBeUndefined();
    });

    it('warns only once per value', async () => {
      const integration = createIntegration({ contentId: 'c'.repeat(65) });
      await send(integration);
      await send(integration);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      integration.setContentId('d'.repeat(65));
      await send(integration);
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });
  });
});
