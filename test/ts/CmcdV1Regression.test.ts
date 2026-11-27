import { describe, beforeEach, afterEach, it, expect, jest } from '@jest/globals';
import { HttpRequestMethod, HttpRequestType, HttpResponseType, PlayerAPI } from 'bitmovin-player';
import { CmcdConfig, CmcdIntegration, CustomKey, HeaderType } from '../../src/ts/CmcdIntegration';
import { playerExports } from './helpers/playerExports';

/**
 * v1 output of a playback scenario, recorded on the encoder before v2 support was added.
 * v1 output must stay byte-identical.
 */
describe('CMCD v1 regression', () => {
  const base = 'https://cdn.example.com/content';
  const videoSegments = [
    { url: `${base}/video/2000kbps/seg1.m4s`, duration: 4 },
    { url: `${base}/video/2000kbps/seg2.m4s`, duration: 4.004 },
    { url: `${base}/video/300kbps/seg 3.m4s`, duration: 4 },
  ];
  const audioSegments = [
    { url: `${base}/audio/128kbps/seg1.m4s`, duration: 2 },
    { url: `${base}/audio/128kbps/seg2.m4s`, duration: 2 },
  ];

  let handlers: Record<string, ((event?: unknown) => void)[]>;
  let state: { playing: boolean; paused: boolean; stalled: boolean; ended: boolean; speed: number; level: number };
  let mockPlayer: PlayerAPI;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  const emit = (event: string, data: object = {}) =>
    (handlers[event] || []).forEach((handler) => handler({ type: event, timestamp: 1000, ...data }));

  beforeEach(() => {
    handlers = {};
    state = { playing: false, paused: false, stalled: false, ended: false, speed: 1, level: 0 };
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockPlayer = {
      isLive: () => false,
      isPlaying: () => state.playing,
      isPaused: () => state.paused,
      isStalled: () => state.stalled,
      hasEnded: () => state.ended,
      getPlaybackSpeed: () => state.speed,
      getConfig: () => ({}),
      getCurrentTime: () => 12.3456,
      getDroppedVideoFrames: () => 3,
      getPlaybackVideoData: () => ({ id: 'v1', bitrate: 2_000_000 }),
      getPlaybackAudioData: () => ({ id: 'a1', bitrate: 128_000 }),
      lowlatency: { getLatency: () => 3.2 },
      buffer: { getLevel: () => ({ targetLevel: 20, level: state.level }) },
      getAvailableAudioQualities: () => [{ bitrate: 64_000 }, { bitrate: 128_000 }],
      getAvailableVideoQualities: () => [{ bitrate: 300_000 }, { bitrate: 2_000_000 }, { bitrate: 6_000_000 }],
      getAvailableSegments: () => ({
        'video/mp4': { v1: videoSegments },
        'audio/mp4': { a1: audioSegments },
      }),
      exports: playerExports,
      on: (event: string, handler: () => void) => (handlers[event] = [...(handlers[event] || []), handler]),
    } as unknown as PlayerAPI;
  });

  afterEach(() => warnSpy.mockRestore());

  const runScenario = async (config: CmcdConfig): Promise<string[]> => {
    const integration = new CmcdIntegration({
      sessionId: '6e2fb550-c457-11e9-bb97-0800200c9a66',
      contentId: 'content-é',
      customKeys: [
        new CustomKey('com.example-num', 500, HeaderType.Session),
        new CustomKey('com.example-str', 'a"b\\c', HeaderType.Request),
      ],
      ...config,
    });
    integration.setPlayer(mockPlayer);
    const output: string[] = [];

    const send = async (type: HttpRequestType, url: string) => {
      const request = await integration.preprocessHttpRequest(type, {
        credentials: 'omit',
        method: HttpRequestMethod.GET,
        responseType: HttpResponseType.ARRAYBUFFER,
        url,
        headers: {},
      });
      output.push(config.useQueryArgs ? request.url : JSON.stringify(request.headers));
    };
    const receive = (type: HttpRequestType, elapsedTime: number, length: number) =>
      integration.preprocessHttpResponse(type, { elapsedTime, length } as unknown as Parameters<
        CmcdIntegration['preprocessHttpResponse']
      >[1]);

    await send(HttpRequestType.MANIFEST_DASH, `${base}/manifest.mpd`);
    await send(HttpRequestType.DRM_LICENSE_WIDEVINE, 'https://drm.example.com/license');
    integration.onVideoAdaptation({
      representations: [{ id: 'v1', bandwidth: 2_000_000 }],
      suggested: 'v1',
    } as unknown as Parameters<CmcdIntegration['onVideoAdaptation']>[0]);
    integration.onAudioAdaptation({
      representations: [{ id: 'a1', bandwidth: 128_000 }],
      suggested: 'a1',
    } as unknown as Parameters<CmcdIntegration['onAudioAdaptation']>[0]);
    emit('play');
    await send(HttpRequestType.MEDIA_VIDEO, videoSegments[0].url);
    await receive(HttpRequestType.MEDIA_VIDEO, 0.5, 1_000_000);
    await send(HttpRequestType.MEDIA_AUDIO, audioSegments[0].url);
    await receive(HttpRequestType.MEDIA_AUDIO, 0.1, 40_000);

    state.playing = true;
    state.level = 7.86;
    emit('playing');
    await send(HttpRequestType.MEDIA_VIDEO, videoSegments[1].url);
    await send(HttpRequestType.MEDIA_SUBTITLES, `${base}/subs/en.vtt`);

    emit('warning', { code: 1105 });
    state.stalled = true;
    emit('stallstarted');
    await send(HttpRequestType.MEDIA_VIDEO, videoSegments[2].url);
    state.stalled = false;
    emit('stallended', { timestamp: 2234 });
    await send(HttpRequestType.MEDIA_AUDIO, audioSegments[1].url);

    state.speed = 2;
    emit('seek');
    await send(HttpRequestType.MEDIA_VIDEO, videoSegments[0].url);
    emit('seeked');
    await send(HttpRequestType.MEDIA_VIDEO, videoSegments[1].url);

    state.playing = false;
    state.paused = true;
    emit('paused');
    await send(HttpRequestType.MEDIA_AUDIO, audioSegments[0].url);

    integration.setSessionId('s'.repeat(65));
    integration.setContentId('c'.repeat(64));
    emit('error', { code: 3011 });
    emit('sourceunloaded');
    await send(HttpRequestType.MANIFEST_DASH, `${base}/manifest.mpd`);

    return output;
  };

  it('keeps the query output unchanged', async () => {
    expect(await runScenario({ useQueryArgs: true })).toMatchInlineSnapshot(`
      [
        "https://cdn.example.com/content/manifest.mpd?CMCD=cid%3D%22content-%C3%A9%22%2Ccom.example-num%3D500%2Ccom.example-str%3D%22a%5C%22b%5C%5Cc%22%2Cot%3Dm%2Cpr%3D0%2Csf%3Dd%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22%2Cst%3Dv%2Csu",
        "https://drm.example.com/license?CMCD=cid%3D%22content-%C3%A9%22%2Ccom.example-num%3D500%2Ccom.example-str%3D%22a%5C%22b%5C%5Cc%22%2Cot%3Dk%2Cpr%3D0%2Csf%3Dd%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22%2Cst%3Dv%2Csu",
        "https://cdn.example.com/content/video/2000kbps/seg1.m4s?CMCD=bl%3D0%2Cbr%3D2000%2Ccid%3D%22content-%C3%A9%22%2Ccom.example-num%3D500%2Ccom.example-str%3D%22a%5C%22b%5C%5Cc%22%2Cd%3D4000%2Cdl%3D0%2Cnor%3D%22seg2.m4s%22%2Cot%3Dv%2Cpr%3D0%2Csf%3Dd%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22%2Cst%3Dv%2Csu%2Ctb%3D6000",
        "https://cdn.example.com/content/audio/128kbps/seg1.m4s?CMCD=bl%3D0%2Cbr%3D128%2Ccid%3D%22content-%C3%A9%22%2Ccom.example-num%3D500%2Ccom.example-str%3D%22a%5C%22b%5C%5Cc%22%2Cd%3D2000%2Cdl%3D0%2Cnor%3D%22seg2.m4s%22%2Cot%3Da%2Cpr%3D0%2Csf%3Dd%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22%2Cst%3Dv%2Csu%2Ctb%3D128",
        "https://cdn.example.com/content/video/2000kbps/seg2.m4s?CMCD=bl%3D7900%2Cbr%3D2000%2Ccid%3D%22content-%C3%A9%22%2Ccom.example-num%3D500%2Ccom.example-str%3D%22a%5C%22b%5C%5Cc%22%2Cd%3D4004%2Cdl%3D7900%2Cmtp%3D16000%2Cnor%3D%22..%252F300kbps%252Fseg%2525203.m4s%22%2Cot%3Dv%2Crtp%3D10000%2Csf%3Dd%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22%2Cst%3Dv%2Ctb%3D6000",
        "https://cdn.example.com/content/subs/en.vtt?CMCD=cid%3D%22content-%C3%A9%22%2Ccom.example-num%3D500%2Ccom.example-str%3D%22a%5C%22b%5C%5Cc%22%2Cot%3Dc%2Csf%3Dd%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22%2Cst%3Dv",
        "https://cdn.example.com/content/video/300kbps/seg 3.m4s?CMCD=bl%3D7900%2Cbr%3D2000%2Cbs%2Ccid%3D%22content-%C3%A9%22%2Ccom.example-num%3D500%2Ccom.example-str%3D%22a%5C%22b%5C%5Cc%22%2Cd%3D4000%2Cdl%3D7900%2Cmtp%3D16000%2Cot%3Dv%2Csf%3Dd%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22%2Cst%3Dv%2Csu%2Ctb%3D6000",
        "https://cdn.example.com/content/audio/128kbps/seg2.m4s?CMCD=bl%3D7900%2Cbr%3D128%2Ccid%3D%22content-%C3%A9%22%2Ccom.example-num%3D500%2Ccom.example-str%3D%22a%5C%22b%5C%5Cc%22%2Cd%3D2000%2Cdl%3D7900%2Cmtp%3D3200%2Cot%3Da%2Crtp%3D600%2Csf%3Dd%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22%2Cst%3Dv%2Ctb%3D128",
        "https://cdn.example.com/content/video/2000kbps/seg1.m4s?CMCD=bl%3D7900%2Cbr%3D2000%2Ccid%3D%22content-%C3%A9%22%2Ccom.example-num%3D500%2Ccom.example-str%3D%22a%5C%22b%5C%5Cc%22%2Cd%3D4000%2Cdl%3D3900%2Cmtp%3D16000%2Cnor%3D%22seg2.m4s%22%2Cot%3Dv%2Cpr%3D2%2Csf%3Dd%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22%2Cst%3Dv%2Csu%2Ctb%3D6000",
        "https://cdn.example.com/content/video/2000kbps/seg2.m4s?CMCD=bl%3D7900%2Cbr%3D2000%2Ccid%3D%22content-%C3%A9%22%2Ccom.example-num%3D500%2Ccom.example-str%3D%22a%5C%22b%5C%5Cc%22%2Cd%3D4004%2Cdl%3D3900%2Cmtp%3D16000%2Cnor%3D%22..%252F300kbps%252Fseg%2525203.m4s%22%2Cot%3Dv%2Cpr%3D2%2Crtp%3D10000%2Csf%3Dd%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22%2Cst%3Dv%2Ctb%3D6000",
        "https://cdn.example.com/content/audio/128kbps/seg1.m4s?CMCD=bl%3D7900%2Cbr%3D128%2Ccid%3D%22content-%C3%A9%22%2Ccom.example-num%3D500%2Ccom.example-str%3D%22a%5C%22b%5C%5Cc%22%2Cd%3D2000%2Cdl%3D3900%2Cmtp%3D3200%2Cnor%3D%22seg2.m4s%22%2Cot%3Da%2Cpr%3D0%2Crtp%3D600%2Csf%3Dd%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22%2Cst%3Dv%2Ctb%3D128",
        "https://cdn.example.com/content/manifest.mpd?CMCD=cid%3D%22cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc%22%2Ccom.example-num%3D500%2Ccom.example-str%3D%22a%5C%22b%5C%5Cc%22%2Cot%3Dm%2Cpr%3D0%2Csf%3Dd%2Cst%3Dv%2Csu",
      ]
    `);
  });

  it('keeps the header output unchanged', async () => {
    expect(await runScenario({ useQueryArgs: false })).toMatchInlineSnapshot(`
      [
        "{"CMCD-Request":"com.example-str=\\"a\\\\\\"b\\\\\\\\c\\",su","CMCD-Object":"ot=m","CMCD-Session":"com.example-num=500,pr=0,sf=d,sid=\\"6e2fb550-c457-11e9-bb97-0800200c9a66\\",st=v"}",
        "{"CMCD-Request":"com.example-str=\\"a\\\\\\"b\\\\\\\\c\\",su","CMCD-Object":"ot=k","CMCD-Session":"com.example-num=500,pr=0,sf=d,sid=\\"6e2fb550-c457-11e9-bb97-0800200c9a66\\",st=v"}",
        "{"CMCD-Request":"bl=0,com.example-str=\\"a\\\\\\"b\\\\\\\\c\\",dl=0,nor=\\"seg2.m4s\\",su","CMCD-Object":"br=2000,d=4000,ot=v,tb=6000","CMCD-Session":"com.example-num=500,pr=0,sf=d,sid=\\"6e2fb550-c457-11e9-bb97-0800200c9a66\\",st=v"}",
        "{"CMCD-Request":"bl=0,com.example-str=\\"a\\\\\\"b\\\\\\\\c\\",dl=0,nor=\\"seg2.m4s\\",su","CMCD-Object":"br=128,d=2000,ot=a,tb=128","CMCD-Session":"com.example-num=500,pr=0,sf=d,sid=\\"6e2fb550-c457-11e9-bb97-0800200c9a66\\",st=v"}",
        "{"CMCD-Request":"bl=7900,com.example-str=\\"a\\\\\\"b\\\\\\\\c\\",dl=7900,mtp=16000,nor=\\"..%2F300kbps%2Fseg%25203.m4s\\"","CMCD-Object":"br=2000,d=4004,ot=v,tb=6000","CMCD-Status":"rtp=10000","CMCD-Session":"com.example-num=500,sf=d,sid=\\"6e2fb550-c457-11e9-bb97-0800200c9a66\\",st=v"}",
        "{"CMCD-Request":"com.example-str=\\"a\\\\\\"b\\\\\\\\c\\"","CMCD-Object":"ot=c","CMCD-Session":"com.example-num=500,sf=d,sid=\\"6e2fb550-c457-11e9-bb97-0800200c9a66\\",st=v"}",
        "{"CMCD-Request":"bl=7900,com.example-str=\\"a\\\\\\"b\\\\\\\\c\\",dl=7900,mtp=16000,su","CMCD-Object":"br=2000,d=4000,ot=v,tb=6000","CMCD-Status":"bs","CMCD-Session":"com.example-num=500,sf=d,sid=\\"6e2fb550-c457-11e9-bb97-0800200c9a66\\",st=v"}",
        "{"CMCD-Request":"bl=7900,com.example-str=\\"a\\\\\\"b\\\\\\\\c\\",dl=7900,mtp=3200","CMCD-Object":"br=128,d=2000,ot=a,tb=128","CMCD-Status":"rtp=600","CMCD-Session":"com.example-num=500,sf=d,sid=\\"6e2fb550-c457-11e9-bb97-0800200c9a66\\",st=v"}",
        "{"CMCD-Request":"bl=7900,com.example-str=\\"a\\\\\\"b\\\\\\\\c\\",dl=3900,mtp=16000,nor=\\"seg2.m4s\\",su","CMCD-Object":"br=2000,d=4000,ot=v,tb=6000","CMCD-Session":"com.example-num=500,pr=2,sf=d,sid=\\"6e2fb550-c457-11e9-bb97-0800200c9a66\\",st=v"}",
        "{"CMCD-Request":"bl=7900,com.example-str=\\"a\\\\\\"b\\\\\\\\c\\",dl=3900,mtp=16000,nor=\\"..%2F300kbps%2Fseg%25203.m4s\\"","CMCD-Object":"br=2000,d=4004,ot=v,tb=6000","CMCD-Status":"rtp=10000","CMCD-Session":"com.example-num=500,pr=2,sf=d,sid=\\"6e2fb550-c457-11e9-bb97-0800200c9a66\\",st=v"}",
        "{"CMCD-Request":"bl=7900,com.example-str=\\"a\\\\\\"b\\\\\\\\c\\",dl=3900,mtp=3200,nor=\\"seg2.m4s\\"","CMCD-Object":"br=128,d=2000,ot=a,tb=128","CMCD-Status":"rtp=600","CMCD-Session":"com.example-num=500,pr=0,sf=d,sid=\\"6e2fb550-c457-11e9-bb97-0800200c9a66\\",st=v"}",
        "{"CMCD-Request":"com.example-str=\\"a\\\\\\"b\\\\\\\\c\\",su","CMCD-Object":"ot=m","CMCD-Session":"cid=\\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\\",com.example-num=500,pr=0,sf=d,st=v"}",
      ]
    `);
  });
});
