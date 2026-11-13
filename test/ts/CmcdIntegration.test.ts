import { describe, beforeEach, it, expect, jest } from '@jest/globals';
import { HttpRequest, HttpRequestMethod, HttpRequestType, HttpResponseType, PlayerAPI } from 'bitmovin-player';
import { CmcdIntegration, CmcdConfig, toRelativeUrl } from '../../src/ts/CmcdIntegration';
import { CmcdCustomKey, cmcdDataToHeader, cmcdDataToUrlParameter, CmcdHeaderType } from '../../src/ts/Cmcd';

// Jest Mocking for helper functions
jest.mock('../../src/ts/Cmcd', () => {
  const actual = jest.requireActual<typeof import('../../src/ts/Cmcd')>('../../src/ts/Cmcd');
  return {
    ...actual,
    CmcdVersion: jest.fn(),
    CmcdStreamType: jest.fn(),
    CmcdPlaybackRate: jest.fn(),
    CmcdObjectType: jest.fn(),
    CmcdStreamingFormat: jest.fn(),
    CmcdStartup: jest.fn(),
    CmcdBufferStarvation: jest.fn(),
    CmcdBufferLength: jest.fn(),
    CmcdContentId: jest.fn(),
    CmcdSessionId: jest.fn(),
    CmcdDeadline: jest.fn(),
    CmcdTopBitrate: jest.fn(),
    cmcdDataToHeader: jest.fn(),
    cmcdDataToUrlParameter: jest.fn(),
  };
});

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
      exports: {
        HttpRequestType: {
          MEDIA_AUDIO: 'media/audio',
          MEDIA_VIDEO: 'media/video',
          MANIFEST_HLS_MASTER: 'manifest/hls/master',
        },
        PlayerEvent: {
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
      const data = (cmcdDataToUrlParameter as jest.Mock).mock.calls.at(-1)?.[0] as { key: string; value: unknown }[];
      return data.find((entry) => entry.key === 'mtp')?.value;
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
      const data = (cmcdDataToUrlParameter as jest.Mock).mock.calls.at(-1)?.[0] as {
        key: string;
        value: unknown;
        keyValuePairToString(): string;
      }[];
      return Object.fromEntries(
        data.filter((entry) => entry.key).map((entry) => [entry.key, entry.keyValuePairToString()])
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
      const { CmcdStartup } = jest.requireMock<typeof import('../../src/ts/Cmcd')>('../../src/ts/Cmcd');
      const startupMock = CmcdStartup as unknown as jest.Mock;
      startupMock.mockClear();

      await getCmcdData(HttpRequestType.MEDIA_VIDEO, videoSegments[0].url);
      expect(startupMock).toHaveBeenCalledTimes(1);

      playerEventHandlers.playing();
      await getCmcdData(HttpRequestType.MEDIA_VIDEO, videoSegments[1].url);
      expect(startupMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('toRelativeUrl', () => {
  it.each([
    ['https://a.com/v/1000kbps/seg1.m4s', 'https://a.com/v/1000kbps/seg2.m4s', 'seg2.m4s'],
    ['https://a.com/v/1000kbps/seg1.m4s', 'https://a.com/v/300kbps/seg2.m4s', '../300kbps/seg2.m4s'],
    ['https://a.com/v/1000kbps/seg1.m4s', 'https://a.com/x/y/seg2.m4s', '../../x/y/seg2.m4s'],
    ['https://a.com/v/seg1.m4s', 'https://a.com/v/hd/seg2.m4s', 'hd/seg2.m4s'],
    ['https://a.com/v/seg1.m4s?CMCD=x', 'https://a.com/v/seg2.m4s?token=abc', 'seg2.m4s?token=abc'],
    ['https://a.com/v/seg1.m4s', 'https://a.com/v/a:b.m4s', './a:b.m4s'],
    ['https://a.com/v/seg1.m4s', 'seg2.m4s', 'seg2.m4s'],
  ])('%s -> %s = %s', (base, target, expected) => {
    expect(toRelativeUrl(base, target)).toEqual(expected);
  });

  it('returns null for different origins', () => {
    expect(toRelativeUrl('https://a.com/seg1.m4s', 'https://b.com/seg2.m4s')).toBeNull();
    expect(toRelativeUrl('https://a.com/seg1.m4s', 'http://a.com/seg2.m4s')).toBeNull();
  });
});
