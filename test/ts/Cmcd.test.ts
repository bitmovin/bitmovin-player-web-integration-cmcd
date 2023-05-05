import { describe, beforeEach, it, expect } from '@jest/globals';
import {
  CmcdBufferLength,
  CmcdBufferStarvation,
  CmcdContentId,
  CmcdDeadline,
  CmcdEncodedBitrate,
  CmcdMeasuredThroughput,
  CmcdObjectType,
  CmcdObjectTypeToken,
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
  });
});
