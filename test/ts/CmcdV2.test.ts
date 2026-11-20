import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import {
  CMCD_V2_KEYS,
  CmcdCustomKey,
  CmcdData,
  CmcdHeaderType,
  CmcdObjectTypeToken,
  CmcdPlayStateToken,
  CmcdStreamingFormatToken,
  CmcdStreamTypeToken,
  CmcdVersionNumbers,
  cmcdDataToHeader,
  cmcdDataToUrlParameter,
} from '../../src/ts/Cmcd';

const v = CmcdVersionNumbers.v2;

/** The v2 payload without query encoding */
function payload(data: CmcdData, customKeys?: CmcdCustomKey[]): string {
  return decodeURIComponent(cmcdDataToUrlParameter({ v, ...data }, customKeys).slice('CMCD='.length));
}

/** The payload without the always present `v=2` */
function keys(data: CmcdData, customKeys?: CmcdCustomKey[]): string {
  return payload(data, customKeys).replace(/,?v=2$/, '');
}

describe('CMCD v2 encoding', () => {
  // Spec examples, CTA-5004-A section 8.1. Line breaks of the spec text are removed.
  describe('spec examples (8.1)', () => {
    const ids = { cid: 'content-id-123', sid: 'session-id-123' };

    it('8.1.1 standard video segment request', () => {
      const data: CmcdData = {
        ...ids,
        v,
        bl: 2000,
        br: 3000,
        d: 4000,
        dl: 1000,
        mtp: 15000,
        nor: 'next-seg.mp4',
        ot: CmcdObjectTypeToken.VideoOnly,
        pr: 1,
        rtp: 12000,
        sf: CmcdStreamingFormatToken.MpegDash,
        st: CmcdStreamTypeToken.Vod,
        sta: CmcdPlayStateToken.Playing,
        tb: 6000,
      };

      expect(cmcdDataToUrlParameter(data)).toEqual(
        'CMCD=bl%3D%282000%29%2Cbr%3D%283000%3Bv%29%2Ccid%3D%22content-id-123%22%2Cd%3D4000%2Cdl%3D1000%2Cmtp%3D%2815000%29%2Cnor%3D%28%22next-seg.mp4%22%29%2Cot%3Dv%2Crtp%3D12000%2Csf%3Dd%2Csid%3D%22session-id-123%22%2Cst%3Dv%2Csta%3Dp%2Ctb%3D%286000%3Bv%29%2Cv%3D2'
      );
      expect(cmcdDataToHeader(data)).toEqual({
        'CMCD-Request': 'bl=(2000),dl=1000,mtp=(15000),nor=("next-seg.mp4"),sta=p',
        'CMCD-Object': 'br=(3000;v),d=4000,ot=v,tb=(6000;v)',
        'CMCD-Status': 'rtp=12000',
        'CMCD-Session': 'cid="content-id-123",sf=d,sid="session-id-123",st=v,v=2',
      });
    });

    it('8.1.2 standard audio segment request (deviation: `br` carries `;a`)', () => {
      const data: CmcdData = {
        ...ids,
        v,
        bl: 2000,
        br: 320,
        d: 2000,
        mtp: 15000,
        ot: CmcdObjectTypeToken.AudioOnly,
        st: CmcdStreamTypeToken.Vod,
      };

      // The spec example sends `br=(320)`, but `br=(3000;v)` in 8.1.1. The type parameter is added for audio as well.
      expect(cmcdDataToUrlParameter(data)).toEqual(
        'CMCD=bl%3D%282000%29%2Cbr%3D%28320%3Ba%29%2Ccid%3D%22content-id-123%22%2Cd%3D2000%2Cmtp%3D%2815000%29%2Cot%3Da%2Csid%3D%22session-id-123%22%2Cst%3Dv%2Cv%3D2'
      );
      expect(cmcdDataToHeader(data)).toEqual({
        'CMCD-Request': 'bl=(2000),mtp=(15000)',
        'CMCD-Object': 'br=(320;a),d=2000,ot=a',
        'CMCD-Session': 'cid="content-id-123",sid="session-id-123",st=v,v=2',
      });
    });

    it('8.1.3 standard request showing minimal fields', () => {
      const data: CmcdData = { ...ids, v };

      expect(cmcdDataToUrlParameter(data)).toEqual(
        'CMCD=cid%3D%22content-id-123%22%2Csid%3D%22session-id-123%22%2Cv%3D2'
      );
      expect(cmcdDataToHeader(data)).toEqual({
        'CMCD-Session': 'cid="content-id-123",sid="session-id-123",v=2',
      });
    });

    describe('8.1.4 start-up sequence', () => {
      const session = { ...ids, v, st: CmcdStreamTypeToken.Vod };

      it('request 1: manifest', () => {
        const data: CmcdData = {
          ...session,
          ot: CmcdObjectTypeToken.ManifestOrPlaylistTextFile,
          sf: CmcdStreamingFormatToken.MpegDash,
          su: true,
        };

        expect(cmcdDataToUrlParameter(data)).toEqual(
          'CMCD=cid%3D%22content-id-123%22%2Cot%3Dm%2Csf%3Dd%2Csid%3D%22session-id-123%22%2Cst%3Dv%2Csu%2Cv%3D2'
        );
        expect(cmcdDataToHeader(data)).toEqual({
          'CMCD-Request': 'su',
          'CMCD-Object': 'ot=m',
          'CMCD-Session': 'cid="content-id-123",sf=d,sid="session-id-123",st=v,v=2',
        });
      });

      it('request 2: init segment (deviation: one `nor` object, no type parameter for `ot=i`)', () => {
        const data: CmcdData = {
          ...session,
          bl: 0,
          br: 3000,
          mtp: 15000,
          nor: 'seg-1.m4v',
          ot: CmcdObjectTypeToken.InitSegment,
          sta: CmcdPlayStateToken.Starting,
          su: true,
        };

        // Spec: br=(3000;v), nor=("seg-1.m4v" "seg-2.m4v")
        expect(cmcdDataToHeader(data)).toEqual({
          'CMCD-Request': 'bl=(0),mtp=(15000),nor=("seg-1.m4v"),sta=s,su',
          'CMCD-Object': 'br=(3000),ot=i',
          'CMCD-Session': 'cid="content-id-123",sid="session-id-123",st=v,v=2',
        });
      });

      it('request 3: first segment (deviation: one `nor` object)', () => {
        const data: CmcdData = {
          ...session,
          bl: 0,
          br: 3000,
          d: 4000,
          mtp: 15000,
          nor: 'seg-2.m4v',
          ot: CmcdObjectTypeToken.VideoOnly,
          sta: CmcdPlayStateToken.Starting,
          su: true,
        };

        // Spec: nor=("seg-2.m4v" "seg-3.m4v")
        expect(cmcdDataToUrlParameter(data)).toEqual(
          'CMCD=bl%3D%280%29%2Cbr%3D%283000%3Bv%29%2Ccid%3D%22content-id-123%22%2Cd%3D4000%2Cmtp%3D%2815000%29%2Cnor%3D%28%22seg-2.m4v%22%29%2Cot%3Dv%2Csid%3D%22session-id-123%22%2Cst%3Dv%2Csta%3Ds%2Csu%2Cv%3D2'
        );
        expect(cmcdDataToHeader(data)).toEqual({
          'CMCD-Request': 'bl=(0),mtp=(15000),nor=("seg-2.m4v"),sta=s,su',
          'CMCD-Object': 'br=(3000;v),d=4000,ot=v',
          'CMCD-Session': 'cid="content-id-123",sid="session-id-123",st=v,v=2',
        });
      });

      it('request 4: second segment with startup delay (deviation: one `nor` object)', () => {
        const data: CmcdData = {
          ...session,
          bl: 4000,
          br: 3000,
          d: 4000,
          msd: 200,
          mtp: 15000,
          nor: 'seg-3.m4v',
          ot: CmcdObjectTypeToken.VideoOnly,
          sta: CmcdPlayStateToken.Playing,
        };

        // Spec: nor=("seg-3.m4v" "seg-4.m4v")
        expect(cmcdDataToUrlParameter(data)).toEqual(
          'CMCD=bl%3D%284000%29%2Cbr%3D%283000%3Bv%29%2Ccid%3D%22content-id-123%22%2Cd%3D4000%2Cmsd%3D200%2Cmtp%3D%2815000%29%2Cnor%3D%28%22seg-3.m4v%22%29%2Cot%3Dv%2Csid%3D%22session-id-123%22%2Cst%3Dv%2Csta%3Dp%2Cv%3D2'
        );
        expect(cmcdDataToHeader(data)).toEqual({
          'CMCD-Request': 'bl=(4000),mtp=(15000),nor=("seg-3.m4v"),sta=p',
          'CMCD-Object': 'br=(3000;v),d=4000,ot=v',
          'CMCD-Session': 'cid="content-id-123",msd=200,sid="session-id-123",st=v,v=2',
        });
      });
    });

    describe('8.1.5 error scenario', () => {
      it('non-fatal error', () => {
        const data: CmcdData = { ...ids, v, ec: ['CODEC_NOT_SUPPORTED'], sta: CmcdPlayStateToken.Playing };

        expect(cmcdDataToUrlParameter(data)).toEqual(
          'CMCD=cid%3D%22content-id-123%22%2Cec%3D%28%22CODEC_NOT_SUPPORTED%22%29%2Csid%3D%22session-id-123%22%2Csta%3Dp%2Cv%3D2'
        );
        expect(cmcdDataToHeader(data)).toEqual({
          'CMCD-Request': 'sta=p',
          'CMCD-Status': 'ec=("CODEC_NOT_SUPPORTED")',
          'CMCD-Session': 'cid="content-id-123",sid="session-id-123",v=2',
        });
      });

      it('fatal error', () => {
        const data: CmcdData = {
          ...ids,
          v,
          ec: ['DRM_NOT_SUPPORTED', 'PLAYBACK_FAILED'],
          sta: CmcdPlayStateToken.FatalError,
        };

        expect(cmcdDataToUrlParameter(data)).toEqual(
          'CMCD=cid%3D%22content-id-123%22%2Cec%3D%28%22DRM_NOT_SUPPORTED%22%20%22PLAYBACK_FAILED%22%29%2Csid%3D%22session-id-123%22%2Csta%3Df%2Cv%3D2'
        );
        expect(cmcdDataToHeader(data)).toEqual({
          'CMCD-Request': 'sta=f',
          'CMCD-Status': 'ec=("DRM_NOT_SUPPORTED" "PLAYBACK_FAILED")',
          'CMCD-Session': 'cid="content-id-123",sid="session-id-123",v=2',
        });
      });
    });

    it('8.1.6 rebuffering, minimal information', () => {
      const data: CmcdData = {
        ...ids,
        v,
        bl: 0,
        bs: true,
        ot: CmcdObjectTypeToken.VideoOnly,
        sta: CmcdPlayStateToken.Rebuffering,
      };

      expect(cmcdDataToUrlParameter(data)).toEqual(
        'CMCD=bl%3D%280%29%2Cbs%2Ccid%3D%22content-id-123%22%2Cot%3Dv%2Csid%3D%22session-id-123%22%2Csta%3Dr%2Cv%3D2'
      );
      expect(cmcdDataToHeader(data)).toEqual({
        'CMCD-Request': 'bl=(0),sta=r',
        'CMCD-Object': 'ot=v',
        'CMCD-Status': 'bs',
        'CMCD-Session': 'cid="content-id-123",sid="session-id-123",v=2',
      });
    });

    it('8.1.8 assigns the implemented keys to the same headers', () => {
      const shards: Record<string, string[]> = {};
      for (const key of Object.keys(CMCD_V2_KEYS) as (keyof CmcdData)[]) {
        (shards[CMCD_V2_KEYS[key]!.header] ||= []).push(key);
      }
      // 8.1.8 without the keys that are not implemented (bg, cs, nr, tpb)
      expect(shards).toEqual({
        [CmcdHeaderType.Request]: ['bl', 'dfa', 'dl', 'ltc', 'mtp', 'nor', 'pb', 'sn', 'sta', 'su', 'tbl'],
        [CmcdHeaderType.Object]: ['br', 'd', 'lb', 'ot', 'tb'],
        [CmcdHeaderType.Status]: ['bs', 'bsa', 'bsd', 'bsda', 'ec', 'pr', 'pt', 'rtp'],
        [CmcdHeaderType.Session]: ['cid', 'msd', 'sf', 'sid', 'st', 'v'],
      });
    });
  });

  describe('key encoding', () => {
    it('always sends v=2', () => {
      expect(payload({})).toEqual('v=2');
      expect(cmcdDataToHeader({ v })).toEqual({ 'CMCD-Session': 'v=2' });
    });

    it('uses list syntax for inner-list keys, also for one value', () => {
      expect(keys({ bl: 2000, mtp: 15000, tbl: 30000, bsa: 2, bsd: [1200], bsda: 1200 })).toEqual(
        'bl=(2000),bsa=(2),bsd=(1200),bsda=(1200),mtp=(15000),tbl=(30000)'
      );
      expect(keys({ ec: ['1001', '2001'], bsd: [100, 250] })).toEqual('bsd=(100 250),ec=("1001" "2001")');
    });

    it('adds the object type parameter to br, lb, pb and tb of audio and video requests', () => {
      const bitrates = { br: 2000, lb: 300, pb: 1000, tb: 6000 };

      expect(keys({ ...bitrates, ot: CmcdObjectTypeToken.VideoOnly })).toEqual(
        'br=(2000;v),lb=(300;v),ot=v,pb=(1000;v),tb=(6000;v)'
      );
      expect(keys({ ...bitrates, ot: CmcdObjectTypeToken.AudioOnly })).toEqual(
        'br=(2000;a),lb=(300;a),ot=a,pb=(1000;a),tb=(6000;a)'
      );
      expect(keys({ ...bitrates, ot: CmcdObjectTypeToken.MuxedVideoAudio })).toEqual(
        'br=(2000;av),lb=(300;av),ot=av,pb=(1000;av),tb=(6000;av)'
      );
      expect(keys({ ...bitrates, ot: CmcdObjectTypeToken.ManifestOrPlaylistTextFile })).toEqual(
        'br=(2000),lb=(300),ot=m,pb=(1000),tb=(6000)'
      );
      expect(keys(bitrates)).toEqual('br=(2000),lb=(300),pb=(1000),tb=(6000)');
    });

    it('does not add the object type parameter to bl, mtp, tbl and the buffer starvation keys', () => {
      expect(
        keys({ bl: 2000, bsa: 1, bsd: [5], bsda: 5, mtp: 100, tbl: 100, ot: CmcdObjectTypeToken.VideoOnly })
      ).toEqual('bl=(2000),bsa=(1),bsd=(5),bsda=(5),mtp=(100),ot=v,tbl=(100)');
    });

    it('rounds as in v1 and omits values that are not sent', () => {
      expect(keys({ bl: 5450, mtp: 49, rtp: 40, br: 1234.5, d: 4003.9999999999995, tbl: 29950 })).toEqual(
        'bl=(5500),br=(1235),d=4004,tbl=(30000)'
      );
      expect(keys({ bsa: 0, bsda: 0, dfa: 0, bsd: [] })).toEqual('');
      expect(keys({ dfa: 32, sn: 0, msd: 1700.4, ltc: 13500.2, pt: 1752000000123.6 })).toEqual(
        'dfa=32,ltc=13500,msd=1700,pt=1752000000124,sn=0'
      );
    });

    it('sends pr as Decimal in CMCD-Status and omits 1', () => {
      expect(keys({ pr: 2 })).toEqual('pr=2.0');
      expect(keys({ pr: 0 })).toEqual('pr=0.0');
      expect(keys({ pr: 1.1 })).toEqual('pr=1.1');
      expect(keys({ pr: 1 })).toEqual('');
      expect(cmcdDataToHeader({ v, pr: 0.5 })).toEqual({ 'CMCD-Status': 'pr=0.5', 'CMCD-Session': 'v=2' });
    });

    it('never sends nrr', () => {
      expect(keys({ nrr: '100-200' })).toEqual('');
    });

    it('sends nor as plain relative path, URL encoded only with the payload in query mode', () => {
      const nor = '../300kbps/seg%202.m4v?token=a&b=c';

      expect(cmcdDataToHeader({ v, nor })).toEqual({
        'CMCD-Request': 'nor=("../300kbps/seg%202.m4v?token=a&b=c")',
        'CMCD-Session': 'v=2',
      });
      expect(cmcdDataToUrlParameter({ v, nor })).toEqual(
        'CMCD=nor%3D%28%22..%2F300kbps%2Fseg%25202.m4v%3Ftoken%3Da%26b%3Dc%22%29%2Cv%3D2'
      );
    });

    it('sends the v2 tokens', () => {
      expect(keys({ sf: CmcdStreamingFormatToken.Hesp, st: CmcdStreamTypeToken.LowLatencyLive })).toEqual('sf=e,st=ll');
      for (const sta of Object.values(CmcdPlayStateToken)) {
        expect(keys({ sta })).toEqual(`sta=${sta}`);
      }
    });

    it('sends booleans as bare key and omits false', () => {
      expect(keys({ bs: true, su: true })).toEqual('bs,su');
      expect(keys({ bs: false, su: false })).toEqual('');
    });

    it('encodes RFC 3986 sub-delimiters in query mode', () => {
      expect(cmcdDataToUrlParameter({ v, cid: "a(b)!'*" })).toEqual('CMCD=cid%3D%22a%28b%29%21%27%2A%22%2Cv%3D2');
    });
  });

  describe('invalid values', () => {
    let warnSpy: jest.SpiedFunction<typeof console.warn>;

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => warnSpy.mockRestore());

    it('omits strings that are not printable ASCII also in query mode', () => {
      expect(keys({ cid: 'café-v2', sid: 'ok' })).toEqual('sid="ok"');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'cid'"));
    });

    it('omits values outside of the RFC 8941 ranges', () => {
      expect(keys({ br: 1e16, sn: 1.5, d: 4000 })).toEqual('d=4000');
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('custom keys', () => {
    let warnSpy: jest.SpiedFunction<typeof console.warn>;

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => warnSpy.mockRestore());

    it('sends values as String, numbers converted', () => {
      expect(
        keys({}, [new CmcdCustomKey('com.example-num', 500), new CmcdCustomKey('com.example-str', 'a"b\\c')])
      ).toEqual('com.example-num="500",com.example-str="a\\"b\\\\c"');
    });

    it('sends values of up to 64 characters and omits longer ones with a warning once', () => {
      const ok = new CmcdCustomKey('com.example-ok', 'x'.repeat(64));
      const tooLong = new CmcdCustomKey('com.example-long', 'y'.repeat(65));

      expect(keys({}, [ok, tooLong])).toEqual(`com.example-ok="${'x'.repeat(64)}"`);
      keys({}, [tooLong]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'com.example-long'"));
    });

    it('omits empty values', () => {
      expect(keys({}, [new CmcdCustomKey('com.example-e', '')])).toEqual('');
    });

    it('omits key names that are not valid RFC 8941 keys', () => {
      expect(keys({}, [new CmcdCustomKey('com.example-myKey', 'a')])).toEqual('');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'com.example-myKey'"));
    });

    it('assigns custom keys to their headers', () => {
      expect(
        cmcdDataToHeader({ v }, [
          new CmcdCustomKey('com.example-r', 1, CmcdHeaderType.Request),
          new CmcdCustomKey('com.example-s', 'x', CmcdHeaderType.Status),
        ])
      ).toEqual({ 'CMCD-Request': 'com.example-r="1"', 'CMCD-Status': 'com.example-s="x"', 'CMCD-Session': 'v=2' });
    });
  });
});
