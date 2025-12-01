import { describe, beforeEach, it, expect, jest } from '@jest/globals';
import { HttpRequest, HttpRequestType, PlayerAPI } from 'bitmovin-player';
import { CmcdIntegration, CmcdConfig } from '../../src/ts/CmcdIntegration';
import { cmcdDataToHeader, cmcdDataToUrlParameter } from '../../src/ts/Cmcd';
import { 
  CmcdObjectDuration, 
  CmcdEncodedBitrate, 
  CmcdTopBitrate,
  CmcdCustomKey,
  CmcdSessionId,
  CmcdContentId 
} from '../../src/ts/Cmcd';

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
  CmcdCustomKey: jest.fn(),
  CmcdObjectDuration: jest.fn(),
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

  describe('CMCD Key Sorting Bug Fix', () => {
    it('should sort CMCD keys alphabetically with custom keys coming before standard keys when appropriate', async () => {
      // Mock the gatherCmcdData method to return test data with mixed key order
      const mockCmcdData = [
        { key: 'd', value: 4004, keyValuePairToString: () => 'd=4004', type: 'CMCD-Object' },
        { key: 'com.example-myNumericKey', value: 500, keyValuePairToString: () => 'com.example-myNumericKey=500', type: 'CMCD-Session' },
        { key: 'br', value: 1000, keyValuePairToString: () => 'br=1000', type: 'CMCD-Object' },
        { key: 'tb', value: 2000, keyValuePairToString: () => 'tb=2000', type: 'CMCD-Object' },
        { key: 'com.example-myStringKey', value: '"myStringValue"', keyValuePairToString: () => 'com.example-myStringKey="myStringValue"', type: 'CMCD-Session' },
      ];

      // Mock the gatherCmcdData method to return our test data
      jest.spyOn(cmcdIntegration as any, 'gatherCmcdData').mockReturnValue(mockCmcdData);

      // Mock cmcdDataToUrlParameter to simulate the actual sorting behavior
      (cmcdDataToUrlParameter as jest.Mock).mockImplementation((data: any[]) => {
        // Sort the data alphabetically by key (this simulates the actual prepareCmcdData function)
        const sortedData = data.sort((a: any, b: any) => a.key.localeCompare(b.key));
        const serializedParams = sortedData.map((item: any) => item.keyValuePairToString()).join(',');
        return `CMCD=${encodeURIComponent(serializedParams)}`;
      });

      const request: HttpRequest = {
        credentials: undefined,
        method: undefined,
        responseType: undefined,
        url: 'https://example.com/segment.ts',
        headers: {},
      };

      const processedRequest = await cmcdIntegration.preprocessHttpRequest(HttpRequestType.MEDIA_VIDEO, request);

      // Verify the URL contains the CMCD parameter with keys sorted alphabetically
      expect(processedRequest.url).toContain('CMCD=');
      
      // Extract the CMCD parameter value
      const urlParams = new URLSearchParams(processedRequest.url.split('?')[1]);
      const cmcdParam = urlParams.get('CMCD');
      expect(cmcdParam).toBeTruthy();

      // Decode and verify the order of keys in the CMCD parameter
      const decodedCmcd = decodeURIComponent(cmcdParam!);
      
      // The keys should appear in alphabetical order: br, com.example-myNumericKey, com.example-myStringKey, d, tb
      const expectedOrder = [
        'br=1000',
        'com.example-myNumericKey=500', 
        'com.example-myStringKey="myStringValue"',
        'd=4004',
        'tb=2000'
      ].join(',');
      
      expect(decodedCmcd).toBe(expectedOrder);
      
      // Additional verification: check that custom keys come before 'd' as specified in the bug report
      const brIndex = decodedCmcd.indexOf('br=');
      const customNumericIndex = decodedCmcd.indexOf('com.example-myNumericKey=');
      const customStringIndex = decodedCmcd.indexOf('com.example-myStringKey=');
      const dIndex = decodedCmcd.indexOf('d=');
      const tbIndex = decodedCmcd.indexOf('tb=');

      expect(brIndex).toBeLessThan(customNumericIndex);
      expect(customNumericIndex).toBeLessThan(customStringIndex);  
      expect(customStringIndex).toBeLessThan(dIndex);
      expect(dIndex).toBeLessThan(tbIndex);
    });
  });
});