import { describe, beforeEach, it, expect } from '@jest/globals';
import {
  CmcdBufferLength,
  CmcdBufferStarvation,
  CmcdContentId,
  CmcdCustomKey,
  CmcdDeadline,
  CmcdEncodedBitrate,
  CmcdMeasuredThroughput,
  CmcdNextObjectRequest,
  CmcdNextRangeRequest,
  CmcdObjectDuration,
  CmcdObjectType,
  CmcdObjectTypeToken,
  CmcdPlaybackRate,
  CmcdRequestedMaximumThroughput,
  CmcdSessionId,
  CmcdStartup,
  CmcdStreamType,
  CmcdStreamTypeToken,
  CmcdStreamingFormat,
  CmcdStreamingFormatToken,
  CmcdTopBitrate,
  CmcdVersion,
  CmcdVersionNumbers,
  cmcdDataToHeader,
  cmcdDataToUrlParameter,
} from '../../src/ts/Cmcd';

describe('Cmcd', () => {
  beforeEach(() => {
    // fresh setup before every test case
  });

  it('should transform CMCD objects to URL parameter', () => {
    const cmcdObjects = [
      new CmcdEncodedBitrate(500),
      new CmcdBufferLength(0),
      new CmcdBufferStarvation(true),
      new CmcdObjectType(CmcdObjectTypeToken.VideoOnly),
    ];

    expect(cmcdDataToUrlParameter(cmcdObjects)).toEqual('CMCD=bl%3D0%2Cbr%3D500%2Cbs%2Cot%3Dv');
  });

  it('should always sort the URL parameters alphabetically by CMCD key', () => {
    const cmcdObjects1 = [
      new CmcdEncodedBitrate(500),
      new CmcdBufferLength(0),
      new CmcdBufferStarvation(true),
      new CmcdObjectType(CmcdObjectTypeToken.VideoOnly),
    ];
    const cmcdObjects2 = [
      new CmcdBufferLength(0),
      new CmcdBufferStarvation(true),
      new CmcdObjectType(CmcdObjectTypeToken.VideoOnly),
      new CmcdEncodedBitrate(500),
    ];
    const cmcdObjects3 = [
      new CmcdBufferStarvation(true),
      new CmcdObjectType(CmcdObjectTypeToken.VideoOnly),
      new CmcdBufferLength(0),
      new CmcdEncodedBitrate(500),
    ];
    const cmcdObjects4 = [
      new CmcdObjectType(CmcdObjectTypeToken.VideoOnly),
      new CmcdBufferLength(0),
      new CmcdBufferStarvation(true),
      new CmcdEncodedBitrate(500),
    ];

    const cmcdUrlParams1 = cmcdDataToUrlParameter(cmcdObjects1);
    const cmcdUrlParams2 = cmcdDataToUrlParameter(cmcdObjects2);
    const cmcdUrlParams3 = cmcdDataToUrlParameter(cmcdObjects3);
    const cmcdUrlParams4 = cmcdDataToUrlParameter(cmcdObjects4);

    expect(cmcdUrlParams1).toEqual(cmcdUrlParams2);
    expect(cmcdUrlParams2).toEqual(cmcdUrlParams3);
    expect(cmcdUrlParams3).toEqual(cmcdUrlParams4);
  });

  it('should sort custom keys alphabetically with standard keys according to full key name', () => {
    const cmcdObjects = [
      new CmcdObjectDuration(4004), // key: 'd'
      new CmcdCustomKey('com.example-myNumericKey', 500), // key: 'com.example-myNumericKey'
      new CmcdCustomKey('com.example-myStringKey', 'myStringValue'), // key: 'com.example-myStringKey'
    ];

    const result = cmcdDataToUrlParameter(cmcdObjects);
    
    // Custom keys should come first alphabetically before 'd'
    // Expected order: 'com.example-myNumericKey', 'com.example-myStringKey', 'd'
    expect(result).toEqual('CMCD=com.example-myNumericKey%3D500%2Ccom.example-myStringKey%3D%22myStringValue%22%2Cd%3D4004');
  });

  it('should maintain strict alphabetical order regardless of input order with mixed custom and standard keys', () => {
    const cmcdObjects1 = [
      new CmcdObjectDuration(4004), // 'd'
      new CmcdCustomKey('com.example-myKey', 500), // 'com.example-myKey' 
      new CmcdBufferLength(0), // 'bl'
    ];
    
    const cmcdObjects2 = [
      new CmcdBufferLength(0), // 'bl'
      new CmcdCustomKey('com.example-myKey', 500), // 'com.example-myKey'
      new CmcdObjectDuration(4004), // 'd'
    ];

    const result1 = cmcdDataToUrlParameter(cmcdObjects1);
    const result2 = cmcdDataToUrlParameter(cmcdObjects2);
    
    expect(result1).toEqual(result2);
    // Should be: bl, com.example-myKey, d
    expect(result1).toEqual('CMCD=bl%3D0%2Ccom.example-myKey%3D500%2Cd%3D4004');
  });

  it('should sort custom keys that come after standard keys alphabetically', () => {
    const cmcdObjects = [
      new CmcdBufferLength(100), // 'bl'
      new CmcdCustomKey('z-custom-key', 'value'), // 'z-custom-key' - should come last
      new CmcdObjectDuration(4004), // 'd'
      new CmcdCustomKey('m-custom-key', 123), // 'm-custom-key' - should come between 'd' and 'z'
    ];

    const result = cmcdDataToUrlParameter(cmcdObjects);
    
    // Expected alphabetical order: bl, d, m-custom-key, z-custom-key
    expect(result).toEqual('CMCD=bl%3D100%2Cd%3D4004%2Cm-custom-key%3D123%2Cz-custom-key%3D%22value%22');
  });

  describe('Cmcd classes', () => {
    it('should ignore keys with empty string value', () => {
      expect(new CmcdContentId('').keyValuePairToString()).toEqual('');
    });

    it('should quote strings', () => {
      expect(new CmcdContentId('test-content-id').keyValuePairToString()).toEqual('cid="test-content-id"');
    });

    it('should escape backslashes in strings', () => {
      expect(new CmcdContentId('test-\\content\\-id').keyValuePairToString()).toEqual('cid="test-\\\\content\\\\-id"');
    });

    it('should escape quotes in strings', () => {
      expect(new CmcdContentId('"test"-content-id').keyValuePairToString()).toEqual('cid="\\"test\\"-content-id"');
    });

    it('should escape quotes and backslashes in strings', () => {
      expect(new CmcdContentId('"test"-content\\-id').keyValuePairToString()).toEqual(
        'cid="\\"test\\"-content\\\\-id"'
      );
    });

    it('should truncate true boolean values to just include the CMCD key', () => {
      expect(new CmcdBufferStarvation(true).keyValuePairToString()).toEqual('bs');
    });

    it('should explicitly list false boolean values', () => {
      expect(new CmcdBufferStarvation(false).keyValuePairToString()).toEqual('bs=false');
    });

    it('should list number values "as is"', () => {
      expect(new CmcdEncodedBitrate(5432).keyValuePairToString()).toEqual('br=5432');
    });

    it('should list token values "as is"', () => {
      expect(new CmcdObjectType(CmcdObjectTypeToken.VideoOnly).keyValuePairToString()).toEqual('ot=v');
      expect(new CmcdObjectType(CmcdObjectTypeToken.AudioOnly).keyValuePairToString()).toEqual('ot=a');
      expect(new CmcdObjectType(CmcdObjectTypeToken.CaptionOrSubtitle).keyValuePairToString()).toEqual('ot=c');
      expect(
        new CmcdObjectType(CmcdObjectTypeToken.CryptographicKeyOrLicenseOrCertificate).keyValuePairToString()
      ).toEqual('ot=k');
      expect(new CmcdObjectType(CmcdObjectTypeToken.InitSegment).keyValuePairToString()).toEqual('ot=i');
      expect(new CmcdObjectType(CmcdObjectTypeToken.ManifestOrPlaylistTextFile).keyValuePairToString()).toEqual('ot=m');
      expect(new CmcdObjectType(CmcdObjectTypeToken.MuxedVideoAudio).keyValuePairToString()).toEqual('ot=av');
      expect(new CmcdObjectType(CmcdObjectTypeToken.Other).keyValuePairToString()).toEqual('ot=o');
      expect(new CmcdObjectType(CmcdObjectTypeToken.TimedTextTrack).keyValuePairToString()).toEqual('ot=tt');
    });

    it('should round buffer length, deadline values to nearest 100ms', () => {
      expect(new CmcdBufferLength(5452).keyValuePairToString()).toEqual('bl=5500');
      expect(new CmcdBufferLength(5450).keyValuePairToString()).toEqual('bl=5500');
      expect(new CmcdBufferLength(5432).keyValuePairToString()).toEqual('bl=5400');
      expect(new CmcdDeadline(5452).keyValuePairToString()).toEqual('dl=5500');
      expect(new CmcdDeadline(5450).keyValuePairToString()).toEqual('dl=5500');
      expect(new CmcdDeadline(5432).keyValuePairToString()).toEqual('dl=5400');
    });

    it('should round measured throughput values to nearest 100kbps', () => {
      expect(new CmcdMeasuredThroughput(87654).keyValuePairToString()).toEqual('mtp=87700');
      expect(new CmcdMeasuredThroughput(87650).keyValuePairToString()).toEqual('mtp=87700');
      expect(new CmcdMeasuredThroughput(87649).keyValuePairToString()).toEqual('mtp=87600');
    });

    it('should remove playback rate if value is 1', () => {
      expect(new CmcdPlaybackRate(1).keyValuePairToString()).toEqual('');
    });

    it('should add playback rate if value is not 1', () => {
      expect(new CmcdPlaybackRate(1.08).keyValuePairToString()).toEqual('pr=1.08');
      expect(new CmcdPlaybackRate(0).keyValuePairToString()).toEqual('pr=0');
      expect(new CmcdPlaybackRate(2.52).keyValuePairToString()).toEqual('pr=2.52');
    });

    it('should remove CMCD version if value is 1', () => {
      expect(new CmcdVersion(CmcdVersionNumbers.v1).keyValuePairToString()).toEqual('');
    });
  });

  describe('CMCD Spec Examples', () => {
    // Examples from CMCD v1 spec Section 6 taken as test cases

    it('Section 6, Example #1:', () => {
      const cmcdObjects = [new CmcdSessionId('6e2fb550-c457-11e9-bb97-0800200c9a66')];
      expect(cmcdDataToUrlParameter(cmcdObjects)).toEqual('CMCD=sid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22');
      expect(cmcdDataToHeader(cmcdObjects)).toEqual({
        'CMCD-Session': 'sid="6e2fb550-c457-11e9-bb97-0800200c9a66"',
      });
    });

    it('Section 6, Example #2:', () => {
      const cmcdObjects = [
        new CmcdEncodedBitrate(3200),
        new CmcdBufferStarvation(true),
        new CmcdObjectDuration(4004),
        new CmcdMeasuredThroughput(25432),
        new CmcdObjectType(CmcdObjectTypeToken.VideoOnly),
        new CmcdRequestedMaximumThroughput(15000),
        new CmcdSessionId('6e2fb550-c457-11e9-bb97-0800200c9a66'),
        new CmcdTopBitrate(6000),
      ];

      expect(cmcdDataToUrlParameter(cmcdObjects)).toEqual(
        'CMCD=br%3D3200%2Cbs%2Cd%3D4004%2Cmtp%3D25400%2Cot%3Dv%2Crtp%3D15000%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22%2Ctb%3D6000'
      );
      expect(cmcdDataToHeader(cmcdObjects)).toEqual({
        'CMCD-Request': 'mtp=25400',
        'CMCD-Object': 'br=3200,d=4004,ot=v,tb=6000',
        'CMCD-Status': 'bs,rtp=15000',
        'CMCD-Session': 'sid="6e2fb550-c457-11e9-bb97-0800200c9a66"',
      });
    });

    it('Section 6, Example #3:', () => {
      const cmcdObjects = [
        new CmcdBufferStarvation(true),
        new CmcdRequestedMaximumThroughput(15000),
        new CmcdSessionId('6e2fb550-c457-11e9-bb97-0800200c9a66'),
      ];
      // Small mistake in the CMCD spec where 'bs' was truncated to 'b' in this query arg example
      expect(cmcdDataToUrlParameter(cmcdObjects)).toEqual(
        'CMCD=bs%2Crtp%3D15000%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22'
      );
      expect(cmcdDataToHeader(cmcdObjects)).toEqual({
        'CMCD-Status': 'bs,rtp=15000',
        'CMCD-Session': 'sid="6e2fb550-c457-11e9-bb97-0800200c9a66"',
      });
    });

    it('Section 6, Example #4:', () => {
      const cmcdObjects = [new CmcdBufferStarvation(true), new CmcdStartup(true)];
      expect(cmcdDataToUrlParameter(cmcdObjects)).toEqual('CMCD=bs%2Csu');
      expect(cmcdDataToHeader(cmcdObjects)).toEqual({
        'CMCD-Status': 'bs',
        'CMCD-Request': 'su',
      });
    });

    it('Section 6, Example #5:', () => {
      const cmcdObjects = [
        new CmcdObjectDuration(4004),
        new CmcdCustomKey('com.example-myNumericKey', 500),
        new CmcdCustomKey('com.example-myStringKey', 'myStringValue'),
      ];
      expect(cmcdDataToUrlParameter(cmcdObjects)).toEqual(
        'CMCD=com.example-myNumericKey%3D500%2Ccom.example-myStringKey%3D%22myStringValue%22%2Cd%3D4004'
      );
      expect(cmcdDataToHeader(cmcdObjects)).toEqual({
        'CMCD-Object': 'd=4004',
        'CMCD-Session': 'com.example-myNumericKey=500,com.example-myStringKey="myStringValue"',
      });
    });

    it('Section 6, Example #6:', () => {
      const cmcdObjects = [
        new CmcdNextObjectRequest('..%2F300kbps%2Fsegment35.m4v'),
        new CmcdSessionId('6e2fb550-c457-11e9-bb97-0800200c9a66'),
      ];
      expect(cmcdDataToUrlParameter(cmcdObjects)).toEqual(
        'CMCD=nor%3D%22..%252F300kbps%252Fsegment35.m4v%22%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22'
      );
      expect(cmcdDataToHeader(cmcdObjects)).toEqual({
        'CMCD-Session': 'sid="6e2fb550-c457-11e9-bb97-0800200c9a66"',
        'CMCD-Request': 'nor="..%2F300kbps%2Fsegment35.m4v"',
      });
    });

    it('Section 6, Example #7:', () => {
      const cmcdObjects = [
        new CmcdNextRangeRequest('12323-48763'),
        new CmcdSessionId('6e2fb550-c457-11e9-bb97-0800200c9a66'),
      ];
      expect(cmcdDataToUrlParameter(cmcdObjects)).toEqual(
        'CMCD=nrr%3D%2212323-48763%22%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22'
      );
      expect(cmcdDataToHeader(cmcdObjects)).toEqual({
        'CMCD-Session': 'sid="6e2fb550-c457-11e9-bb97-0800200c9a66"',
        'CMCD-Request': 'nrr="12323-48763"',
      });
    });

    it('Section 6, Example #8:', () => {
      const cmcdObjects = [
        new CmcdNextObjectRequest('..%2F300kbps%2Ftrack.m4v'),
        new CmcdNextRangeRequest('12323-48763'),
        new CmcdSessionId('6e2fb550-c457-11e9-bb97-0800200c9a66'),
      ];
      expect(cmcdDataToUrlParameter(cmcdObjects)).toEqual(
        'CMCD=nor%3D%22..%252F300kbps%252Ftrack.m4v%22%2Cnrr%3D%2212323-48763%22%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22'
      );
      expect(cmcdDataToHeader(cmcdObjects)).toEqual({
        'CMCD-Session': 'sid="6e2fb550-c457-11e9-bb97-0800200c9a66"',
        'CMCD-Request': 'nor="..%2F300kbps%2Ftrack.m4v",nrr="12323-48763"',
      });
    });

    it('Section 6, Example #9:', () => {
      const cmcdObjects = [
        new CmcdBufferLength(21300),
        new CmcdEncodedBitrate(3200),
        new CmcdBufferStarvation(true),
        new CmcdContentId('faec5fc2-ac30-11ea-bb37-0242ac130002'),
        new CmcdObjectDuration(4004),
        new CmcdDeadline(18500),
        new CmcdMeasuredThroughput(48100),
        new CmcdNextObjectRequest('..%2F300kbps%2Ftrack.m4v'),
        new CmcdNextRangeRequest('12323-48763'),
        new CmcdObjectType(CmcdObjectTypeToken.VideoOnly),
        new CmcdPlaybackRate(1.08),
        new CmcdRequestedMaximumThroughput(12000),
        new CmcdStreamingFormat(CmcdStreamingFormatToken.MpegDash),
        new CmcdSessionId('6e2fb550-c457-11e9-bb97-0800200c9a66'),
        new CmcdStreamType(CmcdStreamTypeToken.Vod),
        new CmcdStartup(true),
        new CmcdTopBitrate(6000),
        new CmcdVersion(1),
      ];
      expect(cmcdDataToUrlParameter(cmcdObjects)).toEqual(
        'CMCD=bl%3D21300%2Cbr%3D3200%2Cbs%2Ccid%3D%22faec5fc2-ac30-11ea-bb37-0242ac130002%22%2Cd%3D4004%2Cdl%3D18500%2Cmtp%3D48100%2Cnor%3D%22..%252F300kbps%252Ftrack.m4v%22%2Cnrr%3D%2212323-48763%22%2Cot%3Dv%2Cpr%3D1.08%2Crtp%3D12000%2Csf%3Dd%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22%2Cst%3Dv%2Csu%2Ctb%3D6000'
      );
      expect(cmcdDataToHeader(cmcdObjects)).toEqual({
        'CMCD-Request': 'bl=21300,dl=18500,mtp=48100,nor="..%2F300kbps%2Ftrack.m4v",nrr="12323-48763",su',
        'CMCD-Object': 'br=3200,d=4004,ot=v,tb=6000',
        'CMCD-Status': 'bs,rtp=12000',
        'CMCD-Session':
          'cid="faec5fc2-ac30-11ea-bb37-0242ac130002",pr=1.08,sf=d,sid="6e2fb550-c457-11e9-bb97-0800200c9a66",st=v',
      });
    });
  });
});