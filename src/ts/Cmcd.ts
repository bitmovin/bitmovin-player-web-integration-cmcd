/**
 * CMCD data model and encoding, CMCD v1 according to CTA-5004.
 *
 * Limitation:
 * - JSON is not supported, only HTTP Headers and Query Args.
 */

import { quoteString, serializeString, serializeToken } from './StructuredField';
import { createWarnOnce } from './Log';

export enum CmcdObjectTypeToken {
  AudioOnly = 'a',
  VideoOnly = 'v',
  MuxedVideoAudio = 'av',
  ManifestOrPlaylistTextFile = 'm',
  InitSegment = 'i',
  CaptionOrSubtitle = 'c',
  TimedTextTrack = 'tt',
  CryptographicKeyOrLicenseOrCertificate = 'k',
  Other = 'o',
}

export enum CmcdStreamingFormatToken {
  MpegDash = 'd',
  Hls = 'h',
  Smooth = 's',
  Other = 'o',
}

export enum CmcdStreamTypeToken {
  Vod = 'v',
  Live = 'l',
}

export interface CmcdHeaders {
  [CmcdHeaderType.Request]?: string;
  [CmcdHeaderType.Object]?: string;
  [CmcdHeaderType.Session]?: string;
  [CmcdHeaderType.Status]?: string;
}

export enum CmcdVersionNumbers {
  v1 = 1,
}

/**
 * Enum containing all CMCD keys as defined in CTA-5004
 */
export enum CmcdKeysToken {
  EncodedBitrate = 'br',
  BufferLength = 'bl',
  BufferStarvation = 'bs',
  ContentId = 'cid',
  ObjectDuration = 'd',
  Deadline = 'dl',
  MeasuredThroughput = 'mtp',
  NextObjectRequest = 'nor',
  NextRangeRequest = 'nrr',
  ObjectType = 'ot',
  PlaybackRate = 'pr',
  RequestedMaximumThroughput = 'rtp',
  StreamingFormat = 'sf',
  SessionId = 'sid',
  StreamType = 'st',
  Startup = 'su',
  TopBitrate = 'tb',
  CmcdVersion = 'v',
}

export enum CmcdHeaderType {
  Object = 'CMCD-Object',
  Request = 'CMCD-Request',
  Status = 'CMCD-Status',
  Session = 'CMCD-Session',
}

/**
 * CMCD data of one request. Values are unrounded and unencoded; the encoder applies the rules of the
 * key table. `undefined` keys are not sent.
 */
export interface CmcdData {
  /** Encoded bitrate in kbps */
  br?: number;
  /** Buffer length in ms */
  bl?: number;
  /** Buffer starvation since the prior request */
  bs?: boolean;
  /** Content id, max. 64 characters */
  cid?: string;
  /** Object duration in ms */
  d?: number;
  /** Deadline in ms */
  dl?: number;
  /** Measured throughput in kbps */
  mtp?: number;
  /** Next object request, path relative to the current request */
  nor?: string;
  /** Next range request, e.g. `12323-48763` */
  nrr?: string;
  /** Object type */
  ot?: CmcdObjectTypeToken;
  /** Playback rate, 0 if not playing */
  pr?: number;
  /** Requested maximum throughput in kbps */
  rtp?: number;
  /** Streaming format */
  sf?: CmcdStreamingFormatToken;
  /** Session id, max. 64 characters */
  sid?: string;
  /** Stream type */
  st?: CmcdStreamTypeToken;
  /** Startup, seek or recovery after a buffer-empty event */
  su?: boolean;
  /** Top bitrate in kbps */
  tb?: number;
  /** CMCD version */
  v?: CmcdVersionNumbers;
}

type CmcdValue = string | number | boolean;

type CmcdValueType = 'integer' | 'decimal' | 'string' | 'token' | 'boolean';

export interface CmcdKeyInfo {
  header: CmcdHeaderType;
  type: CmcdValueType;
  /** Rounds to a multiple of this value */
  round?: number;
  /** Value (after rounding) that is not sent */
  omit?: number | boolean;
  /** Value is URL encoded before serialization */
  urlEncode?: boolean;
}

/** Keys of a CMCD version. Keys without an entry are not sent. */
export type CmcdKeyTable = { [K in keyof CmcdData]?: CmcdKeyInfo };

export const CMCD_V1_KEYS: CmcdKeyTable = {
  br: { header: CmcdHeaderType.Object, type: 'integer', round: 1 },
  bl: { header: CmcdHeaderType.Request, type: 'integer', round: 100 },
  bs: { header: CmcdHeaderType.Status, type: 'boolean', omit: false },
  cid: { header: CmcdHeaderType.Session, type: 'string' },
  d: { header: CmcdHeaderType.Object, type: 'integer', round: 1 },
  dl: { header: CmcdHeaderType.Request, type: 'integer', round: 100 },
  // 0 is not a valid measurement, see https://github.com/cta-wave/common-media-client-data/issues/100
  mtp: { header: CmcdHeaderType.Request, type: 'integer', round: 100, omit: 0 },
  nor: { header: CmcdHeaderType.Request, type: 'string', urlEncode: true },
  nrr: { header: CmcdHeaderType.Request, type: 'string' },
  ot: { header: CmcdHeaderType.Object, type: 'token' },
  pr: { header: CmcdHeaderType.Session, type: 'decimal', omit: 1 },
  rtp: { header: CmcdHeaderType.Status, type: 'integer', round: 100, omit: 0 },
  sf: { header: CmcdHeaderType.Session, type: 'token' },
  sid: { header: CmcdHeaderType.Session, type: 'string' },
  st: { header: CmcdHeaderType.Session, type: 'token' },
  su: { header: CmcdHeaderType.Request, type: 'boolean', omit: false },
  tb: { header: CmcdHeaderType.Object, type: 'integer', round: 1 },
  v: { header: CmcdHeaderType.Session, type: 'integer', omit: 1 },
};

const PRINTABLE_ASCII_REGEX = /^[\x20-\x7e]*$/;

/**
 * Serializes one v1 key-value pair. Returns `null` if the key is not sent.
 * Without `info` (custom keys), only the generic rules apply.
 * `forHeader` rejects keys and strings that are not printable ASCII, as HTTP header values must not contain them.
 */
function encodeV1Member(key: string, value: CmcdValue, info?: CmcdKeyInfo, forHeader = false): string | null {
  if (forHeader && !PRINTABLE_ASCII_REGEX.test(key)) {
    throw new TypeError(`Not a printable ASCII key: ${key}`);
  }
  if (info) {
    if (info.round) {
      value = Math.round((value as number) / info.round) * info.round;
    }
    if (info.urlEncode) {
      value = encodeURIComponent(value);
    }
    if (value === info.omit) {
      return null;
    }
    if (info.type === 'token') {
      return `${key}=${serializeToken(value as string)}`;
    }
  }
  if (value === '') {
    return null;
  }
  if (value === true) {
    return key;
  }
  if (typeof value === 'string') {
    // v1: in query mode, characters outside printable ASCII are sent URL encoded (RFC 8941 rejects them).
    return `${key}=${forHeader ? serializeString(value) : quoteString(value)}`;
  }
  // v1: numbers are sent as JavaScript formats them. RFC 8941 would round decimals to 3 fractional
  // digits and reject integers beyond ±999,999,999,999,999. `false` is sent as `false`, not `?0`.
  return `${key}=${value}`;
}

interface CmcdEntry {
  key: string;
  header: CmcdHeaderType | null;
  member: string;
}

/** Warnings already logged, to log each invalid key or value only once */
const warnOnce = createWarnOnce();

function toEntries(data: CmcdData, customKeys: CmcdCustomKey[], forHeader: boolean): CmcdEntry[] {
  const entries: CmcdEntry[] = [];
  const add = (key: string, value: CmcdValue, header: CmcdHeaderType | null, info?: CmcdKeyInfo) => {
    let member: string | null = null;
    try {
      member = encodeV1Member(key, value, info, forHeader);
    } catch (error) {
      warnOnce(`CMCD: '${key}' is not sent: ${(error as Error).message}`);
    }
    if (member !== null) {
      entries.push({ key, header, member });
    }
  };

  for (const key of Object.keys(data) as (keyof CmcdData)[]) {
    const info = CMCD_V1_KEYS[key];
    const value = data[key];
    if (info && value !== undefined && value !== null) {
      add(key, value, info.header, info);
    }
  }
  for (const customKey of customKeys) {
    add(customKey.key, customKey.value, customKey.type);
  }

  // 9. Key-value pairs SHOULD be sequenced in alphabetical order of the key name in
  // order to reduce the fingerprinting surface exposed by the player.
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

function joinMembers(entries: CmcdEntry[]): string {
  // 3. Successive key/value pairs MUST be delimited by a comma Unicode 0x2C.
  return entries.map((entry) => entry.member).join(',');
}

export function cmcdDataToHeader(data: CmcdData, customKeys: CmcdCustomKey[] = []): CmcdHeaders {
  const entries = toEntries(data, customKeys, true);
  const headers: CmcdHeaders = {};

  for (const header of [CmcdHeaderType.Request, CmcdHeaderType.Object, CmcdHeaderType.Status, CmcdHeaderType.Session]) {
    const value = joinMembers(entries.filter((entry) => entry.header === header));
    if (value) {
      headers[header] = value;
    }
  }

  // 10. [...]  Data payloads transmitted via headers MUST NOT be URLEncoded.
  return headers;
}

export function cmcdDataToUrlParameter(data: CmcdData, customKeys: CmcdCustomKey[] = []): string {
  // 10. If the data payload is transmitted as a query argument, then the entire payload
  // string MUST be URLEncoded per [5].
  // Throws a URIError for lone surrogates.
  return `CMCD=${encodeURIComponent(joinMembers(toEntries(data, customKeys, false)))}`;
}

export class CmcdCustomKey {
  public readonly key: string;
  public readonly value: string | number;

  // Header type must be set if HTTP header mode is used (`CmcdConfig.useQueryArgs = false`).
  // `null` if not set or invalid.
  public readonly type: CmcdHeaderType;

  constructor(key: string, value: string | number, headerType?: CmcdHeaderType) {
    /**
     * Custom key names
     * may be used, but they MUST carry a hyphenated prefix to ensure that there will
     * not be a namespace collision with future revisions to this specification. Clients
     * SHOULD use a reverse-DNS syntax when defining their own prefix.
     */
    const regexMatches = key.match(/^(.*-)(.*)$/);
    if (!regexMatches || !regexMatches[2]) {
      throw new Error('Custom key names MUST carry a hyphenated prefix (and SHOULD use a reverse-DNS syntax)');
    }

    // v1: key names are not checked against RFC 8941, which only allows lowercase.
    this.key = key;
    this.value = value;
    this.type = Object.values(CmcdHeaderType).includes(headerType) ? headerType : null;
  }

  /**
   * @deprecated Will be removed. Encoding is done for all keys of a request at once.
   * @returns The CMCD v1 key-value pair, or an empty string if the key is not sent.
   */
  keyValuePairToString(): string {
    return encodeV1Member(this.key, this.value) || '';
  }
}
