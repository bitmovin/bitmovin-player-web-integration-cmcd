import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  CMCD_V2_EVENT_KEYS,
  CMCD_V2_EVENT_ONLY_KEYS,
  CMCD_V2_KEYS,
  CmcdCustomKey,
  CmcdData,
  cmcdDataToEventRecord,
  cmcdDataToHeader,
  cmcdDataToUrlParameter,
  cmcdEventRecordsToBody,
  CmcdObjectTypeToken,
  CmcdPlayStateToken,
  CmcdStreamingFormatToken,
  CmcdStreamTypeToken,
  CmcdVersionNumbers,
} from '../../src/ts/Cmcd';

const v = CmcdVersionNumbers.v2;
const ids = { cid: 'content-id-123', sid: 'session-id-123' };
const VIDEO = CmcdObjectTypeToken.VideoOnly;
const AUDIO = CmcdObjectTypeToken.AudioOnly;

describe('CMCD v2 Event Mode encoding', () => {
  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // CTA-5004-A section 8.2 and 8.3. Line breaks and spaces of the spec text are removed.
  describe('spec examples', () => {
    it('8.2.1 time interval with the minimal keys', () => {
      expect(cmcdDataToEventRecord({ e: 't', ts: 1764752400000, v })).toEqual('e=t,ts=1764752400000,v=2');
    });

    it('8.2.3 response received', () => {
      const data: CmcdData = {
        cid: 'bbb',
        cmsdd: 'ZXRwPTEyNTAwO3J0dD0zNTttYj02MDAwO3JkPTIwMA==',
        cmsds: 'c2lkPSI5YTNiLTIxY2QiO2JyPTQ1MDA7ZD00MDAwO290PXY7c3Q9dg==',
        e: 'rr',
        nor: 'video/segment-6.m4v',
        ot: VIDEO,
        rc: 200,
        sid: 'session1',
        ts: 1763657019723,
        ttfb: 180,
        ttlb: 200,
        url: 'video/segment-5.m4v',
        v,
      };
      expect(cmcdDataToEventRecord(data)).toEqual(
        'cid="bbb",cmsdd="ZXRwPTEyNTAwO3J0dD0zNTttYj02MDAwO3JkPTIwMA==",cmsds="c2lkPSI5YTNiLTIxY2QiO2JyPTQ1MDA7ZD00MDAwO290PXY7c3Q9dg==",e=rr,nor=("video/segment-6.m4v"),ot=v,rc=200,sid="session1",ts=1763657019723,ttfb=180,ttlb=200,url="video/segment-5.m4v",v=2'
      );
    });

    it('8.2.4 error', () => {
      expect(cmcdDataToEventRecord({ ...ids, e: 'e', ec: ['CODEC_NOT_SUPPORTED'], ts: 1764269150, v })).toEqual(
        'cid="content-id-123",e=e,ec=("CODEC_NOT_SUPPORTED"),sid="session-id-123",ts=1764269150,v=2'
      );
    });

    it('8.2.5 rebuffering start and end', () => {
      expect(
        cmcdDataToEventRecord({ ...ids, e: 'ps', sta: CmcdPlayStateToken.Rebuffering, ts: 1764269150, v })
      ).toEqual('cid="content-id-123",e=ps,sid="session-id-123",sta=r,ts=1764269150,v=2');
      expect(
        cmcdDataToEventRecord({
          ...ids,
          bs: true,
          bsd: [1500],
          e: 'ps',
          sta: CmcdPlayStateToken.Playing,
          ts: 1764269150,
          v,
        })
      ).toEqual('bs,bsd=(1500),cid="content-id-123",e=ps,sid="session-id-123",sta=p,ts=1764269150,v=2');
    });

    it('8.2.7 skip ad', () => {
      expect(cmcdDataToEventRecord({ cid: 'ad-content-555', sid: ids.sid, e: 'sk', ts: 1764269150, v })).toEqual(
        'cid="ad-content-555",e=sk,sid="session-id-123",ts=1764269150,v=2'
      );
    });

    it('8.2.8 ad sequence, without `nr`', () => {
      const sid = ids.sid;
      expect(cmcdDataToEventRecord({ cid: 'movie-123', sid, e: 'abs', ts: 1764269150, v })).toEqual(
        'cid="movie-123",e=abs,sid="session-id-123",ts=1764269150,v=2'
      );
      expect(cmcdDataToEventRecord({ cid: 'ad-001', sid, e: 'as', ts: 1764269150, v })).toEqual(
        'cid="ad-001",e=as,sid="session-id-123",ts=1764269150,v=2'
      );
      expect(cmcdDataToEventRecord({ cid: 'ad-001', sid, e: 'ae', ts: 1764269170, v })).toEqual(
        'cid="ad-001",e=ae,sid="session-id-123",ts=1764269170,v=2'
      );
      expect(cmcdDataToEventRecord({ cid: 'movie-123', sid, e: 'abe', ts: 1764269170, v })).toEqual(
        'cid="movie-123",e=abe,sid="session-id-123",ts=1764269170,v=2'
      );
    });

    it('8.3 batch of the 8.2.2 reports 1 to 4, without `tpb`', () => {
      const playing = {
        ...ids,
        br: [
          { value: 4200, type: VIDEO },
          { value: 256, type: AUDIO },
        ],
        e: 't' as const,
        h: 'example.com',
        lb: [
          { value: 523, type: VIDEO },
          { value: 64, type: AUDIO },
        ],
        pb: [
          { value: 4200, type: VIDEO },
          { value: 256, type: AUDIO },
        ],
        sf: CmcdStreamingFormatToken.MpegDash,
        st: CmcdStreamTypeToken.Vod,
        sta: CmcdPlayStateToken.Playing,
        tb: [
          { value: 4200, type: VIDEO },
          { value: 256, type: AUDIO },
        ],
        v,
      };
      const mtp = (video: number, audio: number) => [
        { value: video, type: VIDEO },
        { value: audio, type: AUDIO },
      ];
      const records = [
        {
          ...ids,
          bl: 0,
          e: 't' as const,
          h: 'example.com',
          pt: 0,
          sn: 1,
          sta: CmcdPlayStateToken.Starting,
          su: true,
          ts: 1764752400000,
          v,
        },
        { ...playing, bl: 6000, msd: 812, mtp: mtp(87000, 49000), pt: 29188, sn: 2, ts: 1764752430000 },
        {
          ...playing,
          bl: 3200,
          bs: true,
          bsd: [{ value: 720, type: VIDEO }],
          ec: ['MEDIA_ERR_NETWORK'],
          mtp: mtp(89000, 52000),
          pt: 59188,
          sn: 3,
          ts: 1764752460000,
        },
        { ...playing, bl: 6000, mtp: mtp(81000, 55000), pt: 89188, sn: 4, ts: 1764752490000 },
      ].map((record) => cmcdDataToEventRecord(record as CmcdData));

      expect(cmcdEventRecordsToBody(records)).toEqual(
        [
          'bl=(0),cid="content-id-123",e=t,h="example.com",pt=0,sid="session-id-123",sn=1,sta=s,su,ts=1764752400000,v=2',
          'bl=(6000),br=(4200;v 256;a),cid="content-id-123",e=t,h="example.com",lb=(523;v 64;a),msd=812,mtp=(87000;v 49000;a),pb=(4200;v 256;a),pt=29188,sf=d,sid="session-id-123",sn=2,st=v,sta=p,tb=(4200;v 256;a),ts=1764752430000,v=2',
          'bl=(3200),br=(4200;v 256;a),bs,bsd=(720;v),cid="content-id-123",e=t,ec=("MEDIA_ERR_NETWORK"),h="example.com",lb=(523;v 64;a),mtp=(89000;v 52000;a),pb=(4200;v 256;a),pt=59188,sf=d,sid="session-id-123",sn=3,st=v,sta=p,tb=(4200;v 256;a),ts=1764752460000,v=2',
          'bl=(6000),br=(4200;v 256;a),cid="content-id-123",e=t,h="example.com",lb=(523;v 64;a),mtp=(81000;v 55000;a),pb=(4200;v 256;a),pt=89188,sf=d,sid="session-id-123",sn=4,st=v,sta=p,tb=(4200;v 256;a),ts=1764752490000,v=2',
        ].join('\n')
      );
    });
  });

  describe('body', () => {
    it('has no trailing LF for a single record', () => {
      expect(cmcdEventRecordsToBody(['e=t,ts=1,v=2'])).toEqual('e=t,ts=1,v=2');
    });

    it('separates records by one LF, in the given order, without a trailing LF', () => {
      expect(cmcdEventRecordsToBody(['e=t,ts=2,v=2', 'e=ps,sta=p,ts=1,v=2'])).toEqual(
        'e=t,ts=2,v=2\ne=ps,sta=p,ts=1,v=2'
      );
    });

    it('is empty without records', () => {
      expect(cmcdEventRecordsToBody([])).toEqual('');
    });
  });

  describe('record', () => {
    it('sorts the keys alphabetically, custom keys included', () => {
      expect(
        cmcdDataToEventRecord({ v, ts: 5, e: 'ce', cen: 'my-event', sid: 's' }, [
          new CmcdCustomKey('com.example-a', 'x'),
        ])
      ).toEqual('cen="my-event",com.example-a="x",e=ce,sid="s",ts=5,v=2');
    });

    it('escapes quotes and backslashes and does not URL encode', () => {
      expect(cmcdDataToEventRecord({ v, e: 'rr', ts: 1, url: 'https://a.b/c d/"e"\\f?g=h&i' })).toEqual(
        'e=rr,ts=1,url="https://a.b/c d/\\"e\\"\\\\f?g=h&i",v=2'
      );
    });

    it('omits strings that are not printable ASCII, with a warning', () => {
      expect(cmcdDataToEventRecord({ v, e: 't', ts: 1, cid: 'é' })).toEqual('e=t,ts=1,v=2');
      expect(warnSpy).toHaveBeenCalled();
    });

    it('rounds integers', () => {
      expect(cmcdDataToEventRecord({ v, e: 'rr', ts: 1.6, ttlb: 200.4, ttfb: 99.5 })).toEqual(
        'e=rr,ts=2,ttfb=100,ttlb=200,v=2'
      );
    });

    it('sends values per object type with their own parameter', () => {
      expect(
        cmcdDataToEventRecord({
          v,
          e: 't',
          ts: 1,
          bl: [
            { value: 2140, type: VIDEO },
            { value: 0, type: AUDIO },
          ],
          mtp: [{ value: 15040, type: VIDEO }],
        })
      ).toEqual('bl=(2100;v 0;a),e=t,mtp=(15000;v),ts=1,v=2');
    });

    it('sends `rr` keys only with `rr`', () => {
      const rrData: CmcdData = {
        v,
        ts: 1,
        rc: 200,
        ttfb: 1,
        ttfbb: 2,
        ttlb: 3,
        url: 'u',
        cmsdd: 'a',
        cmsds: 'b',
      };
      expect(cmcdDataToEventRecord({ ...rrData, e: 'rr' })).toEqual(
        'cmsdd="a",cmsds="b",e=rr,rc=200,ts=1,ttfb=1,ttfbb=2,ttlb=3,url="u",v=2'
      );
      expect(cmcdDataToEventRecord({ ...rrData, e: 't' })).toEqual('e=t,ts=1,v=2');
    });

    it('sends `cen` only with `ce`', () => {
      expect(cmcdDataToEventRecord({ v, ts: 1, e: 'ce', cen: 'x' })).toEqual('cen="x",e=ce,ts=1,v=2');
      expect(cmcdDataToEventRecord({ v, ts: 1, e: 't', cen: 'x' })).toEqual('e=t,ts=1,v=2');
    });

    it('sends `h` and the Request and Event Mode keys', () => {
      expect(
        cmcdDataToEventRecord({ v, ts: 1, e: 'h', h: 'cdn.example.com', pr: 0, st: CmcdStreamTypeToken.Live })
      ).toEqual('e=h,h="cdn.example.com",pr=0.0,st=l,ts=1,v=2');
    });

    it('always uses v2, also for v1 data', () => {
      expect(cmcdDataToEventRecord({ v: CmcdVersionNumbers.v1, e: 't', ts: 1, bl: 2000 })).toEqual(
        'bl=(2000),e=t,ts=1,v=2'
      );
      expect(cmcdDataToEventRecord({ e: 't', ts: 1 })).toEqual('e=t,ts=1,v=2');
    });
  });

  describe('key table', () => {
    it('allows the Event-only keys only in Event Mode', () => {
      for (const key of Object.keys(CMCD_V2_EVENT_ONLY_KEYS) as (keyof CmcdData)[]) {
        expect(CMCD_V2_EVENT_ONLY_KEYS[key]!.modes).toEqual(['event']);
        expect(CMCD_V2_EVENT_ONLY_KEYS[key]!.header).toBeUndefined();
        expect(CMCD_V2_KEYS[key]).toBeUndefined();
      }
      expect(Object.keys(CMCD_V2_EVENT_KEYS).sort()).toEqual(
        Object.keys(CMCD_V2_KEYS).concat(Object.keys(CMCD_V2_EVENT_ONLY_KEYS)).sort()
      );
    });

    it('does not send Event-only keys in Request Mode', () => {
      const data: CmcdData = { v, e: 'rr', ts: 1, url: 'u', rc: 200, h: 'host', cen: 'x' };
      expect(cmcdDataToUrlParameter(data)).toEqual('CMCD=v%3D2');
      expect(cmcdDataToHeader(data)).toEqual({ 'CMCD-Session': 'v=2' });
      expect(cmcdDataToHeader({ ...data, v: CmcdVersionNumbers.v1 })).toEqual({});
    });
  });
});
