import { describe, beforeEach, it, expect, jest } from '@jest/globals';
import { HttpRequest, HttpRequestType, PlayerAPI } from 'bitmovin-player';
import { CmcdIntegration, CmcdConfig } from '../../src/ts/CmcdIntegration';
import { cmcdDataToHeader, cmcdDataToUrlParameter } from '../../src/ts/Cmcd';

// Jest Mocking for helper functions
jest.mock('../../src/ts/Cmcd', () => ({
  CmcdVersionNumbers: {
    v1: 1,
  },
  CmcdStreamTypeToken: {
    Live: 'live',
    Vod: 'vod',
  },
  CmcdObjectTypeToken: {
    AudioOnly: 'a',
    VideoOnly: 'v',
    ManifestOrPlaylistTextFile: 'm',
    InitSegment: 'i',
    CaptionOrSubtitle: 'c',
    CryptographicKeyOrLicenseOrCertificate: 'k',
    MuxedVideoAudio: 'av',
    Other: 'o',
    TimedTextTrack: 'tt',
  },
  CmcdStreamingFormatToken: {
    Hls: 'h',
    MpegDash: 'd',
    Smooth: 's',
    Other: 'o',
  },
  CmcdKeysToken: {
    EncodedBitrate: 'br',
    ObjectDuration: 'd',
    Startup: 'su',
  },
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
  CmcdEncodedBitrate: jest.fn(),
  CmcdDeadline: jest.fn(),
  CmcdTopBitrate: jest.fn(),
  cmcdDataToHeader: jest.fn(),
  cmcdDataToUrlParameter: jest.fn(),
}));

describe('CmcdIntegration', () => {
  let cmcdIntegration: CmcdIntegration;
  let config: CmcdConfig;
  let mockPlayer: PlayerAPI;

  beforeEach(() => {
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
      on: jest.fn(),
    } as unknown as PlayerAPI;

    cmcdIntegration.setPlayer(mockPlayer);
  });

  describe('preprocessHttpRequest', () => {
    it('should add CMCD data as query parameters when useQueryArgs is true', async () => {
      const request: HttpRequest = {
        credentials: undefined,
        method: undefined,
        responseType: undefined,
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
        credentials: undefined,
        method: undefined,
        responseType: undefined,
        url: 'https://example.com/manifest.m3u8?CMCD=oldData',
        headers: {},
      };

      (cmcdDataToUrlParameter as jest.Mock).mockReturnValue('CMCD=newData');

      const processedRequest = await cmcdIntegration.preprocessHttpRequest(HttpRequestType.MEDIA_VIDEO, request);

      expect(processedRequest.url).toBe('https://example.com/manifest.m3u8?CMCD=newData');
      expect(cmcdDataToUrlParameter).toHaveBeenCalled();
    });

    it('should add CMCD data as headers when useQueryArgs is false', async () => {
      cmcdIntegration = new CmcdIntegration({ ...config, useQueryArgs: false });
      cmcdIntegration.setPlayer(mockPlayer);

      const request: HttpRequest = {
        credentials: undefined,
        method: undefined,
        responseType: undefined,
        url: 'https://example.com/manifest.m3u8?',
        headers: {},
      };

      (cmcdDataToHeader as jest.Mock).mockReturnValue({ 'CMCD-Header': 'mockData' });

      const processedRequest = await cmcdIntegration.preprocessHttpRequest(HttpRequestType.MEDIA_VIDEO, request);

      expect(processedRequest.headers).toEqual({ 'CMCD-Header': 'mockData' });
      expect(cmcdDataToHeader).toHaveBeenCalled();
    });
  });
});
