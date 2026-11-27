import { describe, beforeEach, afterEach, it, expect, jest } from '@jest/globals';
import { HttpRequest, HttpRequestMethod, HttpRequestType, HttpResponseType, PlayerAPI } from 'bitmovin-player';
import { CmcdConfig, CmcdIntegration, CustomKey, HeaderType } from '../../src/ts/CmcdIntegration';
import * as Cmcd from '../../src/ts/Cmcd';

// Runs the real encoder through `preprocessHttpRequest`.
describe('CmcdIntegration encoding', () => {
  const baseUrl = 'https://cdn.example.com/content/video/1000kbps';
  const segmentUrl = `${baseUrl}/seg1.m4s`;
  let playerEventHandlers: Record<string, () => void>;
  let mockPlayer: PlayerAPI;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  const createIntegration = (config: CmcdConfig) => {
    const integration = new CmcdIntegration({
      sessionId: '6e2fb550-c457-11e9-bb97-0800200c9a66',
      contentId: 'faec5fc2-ac30-11ea-bb37-0242ac130002',
      customKeys: [
        new CustomKey('com.example-myNumericKey', 500, HeaderType.Session),
        new CustomKey('com.example-myStringKey', 'my"String\\', HeaderType.Request),
      ],
      ...config,
    });
    integration.setPlayer(mockPlayer);
    integration.onVideoAdaptation({
      representations: [{ id: 'v1', bandwidth: 2_000_000 }],
      suggested: 'v1',
    } as unknown as Parameters<CmcdIntegration['onVideoAdaptation']>[0]);
    return integration;
  };

  const sendSegmentRequest = (integration: CmcdIntegration) => {
    const request: HttpRequest = {
      credentials: 'omit',
      method: HttpRequestMethod.GET,
      responseType: HttpResponseType.ARRAYBUFFER,
      url: `${segmentUrl}?token=a`,
      headers: { Accept: '*/*' },
    };
    return integration.preprocessHttpRequest(HttpRequestType.MEDIA_VIDEO, request);
  };

  beforeEach(() => {
    playerEventHandlers = {};
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockPlayer = {
      isLive: () => false,
      getPlaybackSpeed: () => 1.5,
      isPlaying: () => true,
      isStalled: () => false,
      buffer: { getLevel: () => ({ targetLevel: 10, level: 5.432 }) },
      getAvailableAudioQualities: (): { bitrate: number }[] => [],
      getAvailableVideoQualities: () => [{ bitrate: 500_000 }, { bitrate: 6_000_000 }],
      getAvailableSegments: () => ({
        'video/mp4': {
          v1: [
            { url: `${segmentUrl}?token=a`, duration: 4 },
            { url: `${baseUrl}/../300kbps/seg 2.m4s`, duration: 4 },
          ],
        },
      }),
      exports: {
        HttpRequestType: { MEDIA_AUDIO: 'media/audio', MEDIA_VIDEO: 'media/video' },
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
        BufferType: { ForwardDuration: 'forwardduration' },
        MediaType: { Video: 'video', Audio: 'audio' },
      },
      on: (event: string, handler: () => void) => (playerEventHandlers[event] = handler),
    } as unknown as PlayerAPI;
  });

  afterEach(() => warnSpy.mockRestore());

  it('adds the CMCD query argument', async () => {
    const integration = createIntegration({ useQueryArgs: true });
    playerEventHandlers.playing();

    const request = await sendSegmentRequest(integration);

    expect(request.url).toEqual(
      `${segmentUrl}?token=a&CMCD=bl%3D5400%2Cbr%3D2000%2Ccid%3D%22faec5fc2-ac30-11ea-bb37-0242ac130002%22%2Ccom.example-myNumericKey%3D500%2Ccom.example-myStringKey%3D%22my%5C%22String%5C%5C%22%2Cd%3D4000%2Cdl%3D3600%2Cnor%3D%22..%252F300kbps%252Fseg%2525202.m4s%22%2Cot%3Dv%2Cpr%3D1.5%2Crtp%3D10000%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22%2Cst%3Dv%2Ctb%3D6000`
    );
    expect(request.headers).toEqual({ Accept: '*/*' });
  });

  it('adds the CMCD headers', async () => {
    const integration = createIntegration({ useQueryArgs: false });

    const request = await sendSegmentRequest(integration);

    expect(request.url).toEqual(`${segmentUrl}?token=a`);
    expect(request.headers).toEqual({
      Accept: '*/*',
      'CMCD-Request': 'bl=5400,com.example-myStringKey="my\\"String\\\\",dl=3600,nor="..%2F300kbps%2Fseg%25202.m4s",su',
      'CMCD-Object': 'br=2000,d=4000,ot=v,tb=6000',
      'CMCD-Session':
        'cid="faec5fc2-ac30-11ea-bb37-0242ac130002",com.example-myNumericKey=500,pr=1.5,sid="6e2fb550-c457-11e9-bb97-0800200c9a66",st=v',
    });
  });

  it('sends the request without CMCD data if the query argument cannot be encoded', async () => {
    const integration = createIntegration({ useQueryArgs: true, contentId: 'a\uD800' });

    const request = await sendSegmentRequest(integration);
    await sendSegmentRequest(integration);

    expect(request.url).toEqual(`${segmentUrl}?token=a`);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('warns once per distinct encoding error', async () => {
    const integration = createIntegration({ useQueryArgs: true });
    const encodeSpy = jest
      .spyOn(Cmcd, 'cmcdDataToUrlParameter')
      .mockImplementationOnce(() => {
        throw new Error('first');
      })
      .mockImplementationOnce(() => {
        throw new Error('second');
      })
      .mockImplementationOnce(() => {
        throw new Error('first');
      });

    await sendSegmentRequest(integration);
    await sendSegmentRequest(integration);
    await sendSegmentRequest(integration);
    encodeSpy.mockRestore();

    expect(warnSpy.mock.calls.map((call) => call[0])).toEqual([
      'CMCD: data is not sent: Error: first',
      'CMCD: data is not sent: Error: second',
    ]);
  });

  it('omits header values that are not printable ASCII', async () => {
    const integration = createIntegration({ useQueryArgs: false, contentId: 'a\r\nX-Injected: 1' });

    const request = await sendSegmentRequest(integration);

    expect(request.headers['CMCD-Session']).toEqual(
      'com.example-myNumericKey=500,pr=1.5,sid="6e2fb550-c457-11e9-bb97-0800200c9a66",st=v'
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'cid'"));
  });
});
