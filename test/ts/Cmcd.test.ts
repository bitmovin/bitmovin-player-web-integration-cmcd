import { describe, it, expect, jest, afterEach } from '@jest/globals';
import {
  CMCD_V1_KEYS,
  CmcdCustomKey,
  CmcdData,
  CmcdHeaderType,
  CmcdObjectTypeToken,
  CmcdStreamTypeToken,
  CmcdStreamingFormatToken,
  CmcdVersionNumbers,
  cmcdDataToHeader,
  cmcdDataToUrlParameter,
} from '../../src/ts/Cmcd';

/** The CMCD payload without query encoding, e.g. `bl=0,br=500`. */
function payload(data: CmcdData, customKeys?: CmcdCustomKey[]): string {
  return decodeURIComponent(cmcdDataToUrlParameter(data, customKeys).slice('CMCD='.length));
}

describe('Cmcd', () => {
  it('should transform CMCD data to URL parameter', () => {
    const data: CmcdData = { br: 500, bl: 0, bs: true, ot: CmcdObjectTypeToken.VideoOnly };

    expect(cmcdDataToUrlParameter(data)).toEqual('CMCD=bl%3D0%2Cbr%3D500%2Cbs%2Cot%3Dv');
  });

  it('should always sort the URL parameters alphabetically by CMCD key', () => {
    const data1: CmcdData = { br: 500, bl: 0, bs: true, ot: CmcdObjectTypeToken.VideoOnly };
    const data2: CmcdData = { bl: 0, bs: true, ot: CmcdObjectTypeToken.VideoOnly, br: 500 };
    const data3: CmcdData = { bs: true, ot: CmcdObjectTypeToken.VideoOnly, bl: 0, br: 500 };
    const data4: CmcdData = { ot: CmcdObjectTypeToken.VideoOnly, bl: 0, bs: true, br: 500 };

    const cmcdUrlParams1 = cmcdDataToUrlParameter(data1);
    const cmcdUrlParams2 = cmcdDataToUrlParameter(data2);
    const cmcdUrlParams3 = cmcdDataToUrlParameter(data3);
    const cmcdUrlParams4 = cmcdDataToUrlParameter(data4);

    expect(cmcdUrlParams1).toEqual(cmcdUrlParams2);
    expect(cmcdUrlParams2).toEqual(cmcdUrlParams3);
    expect(cmcdUrlParams3).toEqual(cmcdUrlParams4);
  });

  it('should sort custom keys alphabetically with standard keys according to full key name', () => {
    const result = cmcdDataToUrlParameter({ d: 4004 }, [
      new CmcdCustomKey('com.example-myNumericKey', 500),
      new CmcdCustomKey('com.example-myStringKey', 'myStringValue'),
    ]);

    // Custom keys should come first alphabetically before 'd'
    // Expected order: 'com.example-myNumericKey', 'com.example-myStringKey', 'd'
    expect(result).toEqual(
      'CMCD=com.example-myNumericKey%3D500%2Ccom.example-myStringKey%3D%22myStringValue%22%2Cd%3D4004'
    );
  });

  it('should maintain strict alphabetical order regardless of input order with mixed custom and standard keys', () => {
    const result1 = cmcdDataToUrlParameter({ d: 4004, bl: 0 }, [new CmcdCustomKey('com.example-myKey', 500)]);
    const result2 = cmcdDataToUrlParameter({ bl: 0, d: 4004 }, [new CmcdCustomKey('com.example-myKey', 500)]);

    expect(result1).toEqual(result2);
    // Should be: bl, com.example-myKey, d
    expect(result1).toEqual('CMCD=bl%3D0%2Ccom.example-myKey%3D500%2Cd%3D4004');
  });

  it('should sort custom keys that come after standard keys alphabetically', () => {
    const result = cmcdDataToUrlParameter({ bl: 100, d: 4004 }, [
      new CmcdCustomKey('z-custom-key', 'value'),
      new CmcdCustomKey('m-custom-key', 123),
    ]);

    // Expected alphabetical order: bl, d, m-custom-key, z-custom-key
    expect(result).toEqual('CMCD=bl%3D100%2Cd%3D4004%2Cm-custom-key%3D123%2Cz-custom-key%3D%22value%22');
  });

  it('should sort mixed-case custom keys case-insensitively', () => {
    expect(payload({}, [new CmcdCustomKey('com.example-Upper', 1), new CmcdCustomKey('com.example-lower', 2)])).toEqual(
      'com.example-lower=2,com.example-Upper=1'
    );
  });

  it('should send an empty payload if no key is sent', () => {
    expect(cmcdDataToUrlParameter({})).toEqual('CMCD=');
    expect(cmcdDataToHeader({})).toEqual({});
  });

  it('should ignore undefined keys', () => {
    expect(payload({ br: undefined, sf: undefined, su: undefined })).toEqual('');
  });

  describe('key encoding', () => {
    it('should ignore keys with empty string value', () => {
      expect(payload({ cid: '' })).toEqual('');
    });

    it('should quote strings', () => {
      expect(payload({ cid: 'test-content-id' })).toEqual('cid="test-content-id"');
    });

    it('should escape backslashes in strings', () => {
      expect(payload({ cid: 'test-\\content\\-id' })).toEqual('cid="test-\\\\content\\\\-id"');
    });

    it('should escape quotes in strings', () => {
      expect(payload({ cid: '"test"-content-id' })).toEqual('cid="\\"test\\"-content-id"');
    });

    it('should escape quotes and backslashes in strings', () => {
      expect(payload({ cid: '"test"-content\\-id' })).toEqual('cid="\\"test\\"-content\\\\-id"');
    });

    it('should truncate true boolean values to just include the CMCD key', () => {
      expect(payload({ bs: true })).toEqual('bs');
    });

    it('should list number values "as is"', () => {
      expect(payload({ br: 5432 })).toEqual('br=5432');
    });

    it('should list token values "as is"', () => {
      expect(payload({ ot: CmcdObjectTypeToken.VideoOnly })).toEqual('ot=v');
      expect(payload({ ot: CmcdObjectTypeToken.AudioOnly })).toEqual('ot=a');
      expect(payload({ ot: CmcdObjectTypeToken.CaptionOrSubtitle })).toEqual('ot=c');
      expect(payload({ ot: CmcdObjectTypeToken.CryptographicKeyOrLicenseOrCertificate })).toEqual('ot=k');
      expect(payload({ ot: CmcdObjectTypeToken.InitSegment })).toEqual('ot=i');
      expect(payload({ ot: CmcdObjectTypeToken.ManifestOrPlaylistTextFile })).toEqual('ot=m');
      expect(payload({ ot: CmcdObjectTypeToken.MuxedVideoAudio })).toEqual('ot=av');
      expect(payload({ ot: CmcdObjectTypeToken.Other })).toEqual('ot=o');
      expect(payload({ ot: CmcdObjectTypeToken.TimedTextTrack })).toEqual('ot=tt');
      expect(payload({ sf: CmcdStreamingFormatToken.MpegDash })).toEqual('sf=d');
      expect(payload({ sf: CmcdStreamingFormatToken.Hls })).toEqual('sf=h');
      expect(payload({ sf: CmcdStreamingFormatToken.Smooth })).toEqual('sf=s');
      expect(payload({ sf: CmcdStreamingFormatToken.Other })).toEqual('sf=o');
      expect(payload({ st: CmcdStreamTypeToken.Vod })).toEqual('st=v');
      expect(payload({ st: CmcdStreamTypeToken.Live })).toEqual('st=l');
    });

    it('should round buffer length, deadline values to nearest 100ms', () => {
      expect(payload({ bl: 5452 })).toEqual('bl=5500');
      expect(payload({ bl: 5450 })).toEqual('bl=5500');
      expect(payload({ bl: 5432 })).toEqual('bl=5400');
      expect(payload({ dl: 5452 })).toEqual('dl=5500');
      expect(payload({ dl: 5450 })).toEqual('dl=5500');
      expect(payload({ dl: 5432 })).toEqual('dl=5400');
    });

    it('should round measured throughput values to nearest 100kbps', () => {
      expect(payload({ mtp: 87654 })).toEqual('mtp=87700');
      expect(payload({ mtp: 87650 })).toEqual('mtp=87700');
      expect(payload({ mtp: 87649 })).toEqual('mtp=87600');
    });

    it('should omit measured throughput if it rounds to 0', () => {
      expect(payload({ mtp: 0 })).toEqual('');
      expect(payload({ mtp: 49 })).toEqual('');
      expect(payload({ mtp: 50 })).toEqual('mtp=100');
      expect(cmcdDataToUrlParameter({ mtp: 40 })).toEqual('CMCD=');
    });

    it('should round requested maximum throughput to nearest 100kbps and omit 0', () => {
      expect(payload({ rtp: 15049 })).toEqual('rtp=15000');
      expect(payload({ rtp: 15050 })).toEqual('rtp=15100');
      expect(payload({ rtp: 40 })).toEqual('');
    });

    it('should URL encode the next object request value', () => {
      expect(payload({ nor: '../300kbps/segment 35.m4v?token=a&b=c' })).toEqual(
        'nor="..%2F300kbps%2Fsegment%2035.m4v%3Ftoken%3Da%26b%3Dc"'
      );
    });

    it('should remove playback rate if value is 1', () => {
      expect(payload({ pr: 1 })).toEqual('');
    });

    it('should add playback rate if value is not 1', () => {
      expect(payload({ pr: 1.08 })).toEqual('pr=1.08');
      expect(payload({ pr: 0 })).toEqual('pr=0');
      expect(payload({ pr: 2.52 })).toEqual('pr=2.52');
    });

    it('should round encoded bitrate, object duration and top bitrate to integers', () => {
      expect(payload({ br: 1234.567 })).toEqual('br=1235');
      expect(payload({ d: 4003.9999999999995 })).toEqual('d=4004');
      expect(payload({ tb: 1234.567 })).toEqual('tb=1235');
    });

    it('should omit buffer starvation and startup if value is false', () => {
      expect(payload({ bs: true })).toEqual('bs');
      expect(payload({ bs: false })).toEqual('');
      expect(payload({ su: true })).toEqual('su');
      expect(payload({ su: false })).toEqual('');
    });

    it('should remove CMCD version if value is 1', () => {
      expect(payload({ v: CmcdVersionNumbers.v1 })).toEqual('');
    });

    it('should not limit the length of cid and sid', () => {
      // The 64 character limit is applied when collecting the data.
      expect(payload({ cid: 'x'.repeat(65) })).toEqual(`cid="${'x'.repeat(65)}"`);
    });

    describe('v1 values outside of RFC 8941', () => {
      it('should send non-ASCII and control characters in strings as is', () => {
        expect(payload({ cid: 'café' })).toEqual('cid="café"');
        expect(payload({ sid: '\t\n' })).toEqual('sid="\t\n"');
        expect(cmcdDataToUrlParameter({ cid: 'café' })).toEqual('CMCD=cid%3D%22caf%C3%A9%22');
      });

      it('should send decimals with more than 3 fractional digits unrounded', () => {
        expect(payload({ pr: 1.23456 })).toEqual('pr=1.23456');
        expect(payload({}, [new CmcdCustomKey('com.example-x', 1.23456)])).toEqual('com.example-x=1.23456');
      });

      it('should send integers beyond the RFC 8941 range as JavaScript formats them', () => {
        expect(payload({ br: 1e16 })).toEqual('br=10000000000000000');
        expect(payload({}, [new CmcdCustomKey('com.example-x', 12345678901234567)])).toEqual(
          'com.example-x=12345678901234568'
        );
      });

      it('should send false custom values as `false`', () => {
        expect(payload({}, [new CmcdCustomKey('com.example-t', true as any)])).toEqual('com.example-t');
        expect(payload({}, [new CmcdCustomKey('com.example-f', false as any)])).toEqual('com.example-f=false');
      });

      it('should send mixed-case custom key names', () => {
        expect(payload({}, [new CmcdCustomKey('com.example-myNumericKey', 500)])).toEqual(
          'com.example-myNumericKey=500'
        );
      });
    });

    it('should not encode URL sub-delimiters that encodeURIComponent keeps in query mode', () => {
      expect(cmcdDataToUrlParameter({ cid: "a(b)!'*" })).toEqual("CMCD=cid%3D%22a(b)!'*%22");
    });

    it('should double encode nor in query mode', () => {
      expect(cmcdDataToUrlParameter({ nor: '../300kbps/segment35.m4v' })).toEqual(
        'CMCD=nor%3D%22..%252F300kbps%252Fsegment35.m4v%22'
      );
    });

    describe('invalid values', () => {
      let warnSpy: jest.SpiedFunction<typeof console.warn>;

      afterEach(() => warnSpy.mockRestore());

      it('should omit a key with an invalid token value and warn instead of throwing', () => {
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const data = { br: 500, ot: 'not a token' as CmcdObjectTypeToken };

        expect(payload(data)).toEqual('br=500');
        expect(cmcdDataToHeader(data)).toEqual({ 'CMCD-Object': 'br=500' });
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'ot'"));
      });
    });
  });

  describe('v1 key table', () => {
    it('should assign each key to its header', () => {
      const shards: Record<string, string[]> = {};
      for (const key of Object.keys(CMCD_V1_KEYS) as (keyof CmcdData)[]) {
        (shards[CMCD_V1_KEYS[key].header] ||= []).push(key);
      }
      expect(shards).toEqual({
        [CmcdHeaderType.Object]: ['br', 'd', 'ot', 'tb'],
        [CmcdHeaderType.Request]: ['bl', 'dl', 'mtp', 'nor', 'nrr', 'su'],
        [CmcdHeaderType.Status]: ['bs', 'rtp'],
        [CmcdHeaderType.Session]: ['cid', 'pr', 'sf', 'sid', 'st', 'v'],
      });
    });
  });

  describe('CmcdCustomKey', () => {
    it('should throw for key names without hyphenated prefix', () => {
      expect(() => new CmcdCustomKey('mykey', 1)).toThrowError();
      expect(() => new CmcdCustomKey('com.example-', 1)).toThrowError();
    });

    it('should keep key and value', () => {
      const customKey = new CmcdCustomKey('com.example-myKey', 'value');
      expect(customKey.key).toEqual('com.example-myKey');
      expect(customKey.value).toEqual('value');
    });

    it('should still serialize itself with the deprecated keyValuePairToString', () => {
      expect(new CmcdCustomKey('com.example-n', 500).keyValuePairToString()).toEqual('com.example-n=500');
      expect(new CmcdCustomKey('com.example-s', 'a"b').keyValuePairToString()).toEqual('com.example-s="a\\"b"');
      expect(new CmcdCustomKey('com.example-e', '').keyValuePairToString()).toEqual('');
    });

    it('should not be sent in HTTP header mode without header type', () => {
      expect(cmcdDataToHeader({ br: 1 }, [new CmcdCustomKey('com.example-x', 1)])).toEqual({ 'CMCD-Object': 'br=1' });
    });

    describe('with HTTP Header mode', () => {
      it('should set the provided CmcdHeaderType correctly', () => {
        const customKey1 = new CmcdCustomKey('com.example-myNumericKey1', 'value1', CmcdHeaderType.Object);
        const customKey2 = new CmcdCustomKey('com.example-myNumericKey2', 'value2', CmcdHeaderType.Request);
        const customKey3 = new CmcdCustomKey('com.example-myNumericKey3', 'value3', CmcdHeaderType.Session);
        const customKey4 = new CmcdCustomKey('com.example-myNumericKey4', 'value4', CmcdHeaderType.Status);

        expect(customKey1.type).toEqual(CmcdHeaderType.Object);
        expect(customKey2.type).toEqual(CmcdHeaderType.Request);
        expect(customKey3.type).toEqual(CmcdHeaderType.Session);
        expect(customKey4.type).toEqual(CmcdHeaderType.Status);
      });

      it('should set invalid CmcdHeaderType to null', () => {
        const customKey1 = new CmcdCustomKey('com.example-myNumericKey1', 'value1', 'invalid' as any);
        const customKey2 = new CmcdCustomKey('com.example-myNumericKey2', 'value2', null as any);
        const customKey3 = new CmcdCustomKey('com.example-myNumericKey3', 'value3', undefined as any);
        const customKey4 = new CmcdCustomKey('com.example-myNumericKey4', 'value4', 2 as any);

        expect(customKey1.type).toEqual(null);
        expect(customKey2.type).toEqual(null);
        expect(customKey3.type).toEqual(null);
        expect(customKey4.type).toEqual(null);
      });

      it('should assign custom keys to their headers', () => {
        expect(
          cmcdDataToHeader({ bl: 100, d: 4004 }, [
            new CmcdCustomKey('z-custom-key', 'value', CmcdHeaderType.Status),
            new CmcdCustomKey('m-custom-key', 123, CmcdHeaderType.Request),
          ])
        ).toEqual({
          'CMCD-Request': 'bl=100,m-custom-key=123',
          'CMCD-Object': 'd=4004',
          'CMCD-Status': 'z-custom-key="value"',
        });
      });
    });
  });

  describe('CMCD Spec Examples', () => {
    // Examples from CMCD v1 spec Section 6 taken as test cases

    it('Section 6, Example #1:', () => {
      const data: CmcdData = { sid: '6e2fb550-c457-11e9-bb97-0800200c9a66' };
      expect(cmcdDataToUrlParameter(data)).toEqual('CMCD=sid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22');
      expect(cmcdDataToHeader(data)).toEqual({
        'CMCD-Session': 'sid="6e2fb550-c457-11e9-bb97-0800200c9a66"',
      });
    });

    it('Section 6, Example #2:', () => {
      const data: CmcdData = {
        br: 3200,
        bs: true,
        d: 4004,
        mtp: 25432,
        ot: CmcdObjectTypeToken.VideoOnly,
        rtp: 15000,
        sid: '6e2fb550-c457-11e9-bb97-0800200c9a66',
        tb: 6000,
      };

      expect(cmcdDataToUrlParameter(data)).toEqual(
        'CMCD=br%3D3200%2Cbs%2Cd%3D4004%2Cmtp%3D25400%2Cot%3Dv%2Crtp%3D15000%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22%2Ctb%3D6000'
      );
      expect(cmcdDataToHeader(data)).toEqual({
        'CMCD-Request': 'mtp=25400',
        'CMCD-Object': 'br=3200,d=4004,ot=v,tb=6000',
        'CMCD-Status': 'bs,rtp=15000',
        'CMCD-Session': 'sid="6e2fb550-c457-11e9-bb97-0800200c9a66"',
      });
    });

    it('Section 6, Example #3:', () => {
      const data: CmcdData = { bs: true, rtp: 15000, sid: '6e2fb550-c457-11e9-bb97-0800200c9a66' };
      // Small mistake in the CMCD spec where 'bs' was truncated to 'b' in this query arg example
      expect(cmcdDataToUrlParameter(data)).toEqual(
        'CMCD=bs%2Crtp%3D15000%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22'
      );
      expect(cmcdDataToHeader(data)).toEqual({
        'CMCD-Status': 'bs,rtp=15000',
        'CMCD-Session': 'sid="6e2fb550-c457-11e9-bb97-0800200c9a66"',
      });
    });

    it('Section 6, Example #4:', () => {
      const data: CmcdData = { bs: true, su: true };
      expect(cmcdDataToUrlParameter(data)).toEqual('CMCD=bs%2Csu');
      expect(cmcdDataToHeader(data)).toEqual({
        'CMCD-Status': 'bs',
        'CMCD-Request': 'su',
      });
    });

    it('Section 6, Example #5:', () => {
      const data: CmcdData = { d: 4004 };
      const customKeys = [
        new CmcdCustomKey('com.example-myNumericKey', 500, CmcdHeaderType.Session),
        new CmcdCustomKey('com.example-myStringKey', 'myStringValue', CmcdHeaderType.Session),
      ];
      expect(cmcdDataToUrlParameter(data, customKeys)).toEqual(
        'CMCD=com.example-myNumericKey%3D500%2Ccom.example-myStringKey%3D%22myStringValue%22%2Cd%3D4004'
      );
      expect(cmcdDataToHeader(data, customKeys)).toEqual({
        'CMCD-Object': 'd=4004',
        'CMCD-Session': 'com.example-myNumericKey=500,com.example-myStringKey="myStringValue"',
      });
    });

    it('Section 6, Example #6:', () => {
      const data: CmcdData = { nor: '../300kbps/segment35.m4v', sid: '6e2fb550-c457-11e9-bb97-0800200c9a66' };
      expect(cmcdDataToUrlParameter(data)).toEqual(
        'CMCD=nor%3D%22..%252F300kbps%252Fsegment35.m4v%22%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22'
      );
      expect(cmcdDataToHeader(data)).toEqual({
        'CMCD-Session': 'sid="6e2fb550-c457-11e9-bb97-0800200c9a66"',
        'CMCD-Request': 'nor="..%2F300kbps%2Fsegment35.m4v"',
      });
    });

    it('Section 6, Example #7:', () => {
      const data: CmcdData = { nrr: '12323-48763', sid: '6e2fb550-c457-11e9-bb97-0800200c9a66' };
      expect(cmcdDataToUrlParameter(data)).toEqual(
        'CMCD=nrr%3D%2212323-48763%22%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22'
      );
      expect(cmcdDataToHeader(data)).toEqual({
        'CMCD-Session': 'sid="6e2fb550-c457-11e9-bb97-0800200c9a66"',
        'CMCD-Request': 'nrr="12323-48763"',
      });
    });

    it('Section 6, Example #8:', () => {
      const data: CmcdData = {
        nor: '../300kbps/track.m4v',
        nrr: '12323-48763',
        sid: '6e2fb550-c457-11e9-bb97-0800200c9a66',
      };
      expect(cmcdDataToUrlParameter(data)).toEqual(
        'CMCD=nor%3D%22..%252F300kbps%252Ftrack.m4v%22%2Cnrr%3D%2212323-48763%22%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22'
      );
      expect(cmcdDataToHeader(data)).toEqual({
        'CMCD-Session': 'sid="6e2fb550-c457-11e9-bb97-0800200c9a66"',
        'CMCD-Request': 'nor="..%2F300kbps%2Ftrack.m4v",nrr="12323-48763"',
      });
    });

    it('Section 6, Example #9:', () => {
      const data: CmcdData = {
        bl: 21300,
        br: 3200,
        bs: true,
        cid: 'faec5fc2-ac30-11ea-bb37-0242ac130002',
        d: 4004,
        dl: 18500,
        mtp: 48100,
        nor: '../300kbps/track.m4v',
        nrr: '12323-48763',
        ot: CmcdObjectTypeToken.VideoOnly,
        pr: 1.08,
        rtp: 12000,
        sf: CmcdStreamingFormatToken.MpegDash,
        sid: '6e2fb550-c457-11e9-bb97-0800200c9a66',
        st: CmcdStreamTypeToken.Vod,
        su: true,
        tb: 6000,
        v: 1,
      };
      expect(cmcdDataToUrlParameter(data)).toEqual(
        'CMCD=bl%3D21300%2Cbr%3D3200%2Cbs%2Ccid%3D%22faec5fc2-ac30-11ea-bb37-0242ac130002%22%2Cd%3D4004%2Cdl%3D18500%2Cmtp%3D48100%2Cnor%3D%22..%252F300kbps%252Ftrack.m4v%22%2Cnrr%3D%2212323-48763%22%2Cot%3Dv%2Cpr%3D1.08%2Crtp%3D12000%2Csf%3Dd%2Csid%3D%226e2fb550-c457-11e9-bb97-0800200c9a66%22%2Cst%3Dv%2Csu%2Ctb%3D6000'
      );
      expect(cmcdDataToHeader(data)).toEqual({
        'CMCD-Request': 'bl=21300,dl=18500,mtp=48100,nor="..%2F300kbps%2Ftrack.m4v",nrr="12323-48763",su',
        'CMCD-Object': 'br=3200,d=4004,ot=v,tb=6000',
        'CMCD-Status': 'bs,rtp=12000',
        'CMCD-Session':
          'cid="faec5fc2-ac30-11ea-bb37-0242ac130002",pr=1.08,sf=d,sid="6e2fb550-c457-11e9-bb97-0800200c9a66",st=v',
      });
    });
  });
});
