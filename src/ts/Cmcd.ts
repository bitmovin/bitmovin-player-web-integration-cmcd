/**
 * CMCD data model and encoding, CMCD v1 according to CTA-5004
 * and CMCD v2 (CTA-5004-B) Request Mode and Event Mode.
 *
 * Limitation:
 * - JSON is not supported, only HTTP Headers, Query Args and (Event Mode) the `application/cmcd` body.
 */

import {
  isInteger,
  quoteString,
  serializeDictionaryMember,
  serializeString,
  serializeToken,
  SfBareItem,
  SfDecimal,
  SfItem,
  SfParameters,
  SfToken,
} from './StructuredField';
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
  /** v2 only */
  Hesp = 'e',
  Smooth = 's',
  Other = 'o',
}

export enum CmcdStreamTypeToken {
  Vod = 'v',
  Live = 'l',
  /** v2 only */
  LowLatencyLive = 'll',
}

/** v2 play state (`sta`) */
export enum CmcdPlayStateToken {
  Starting = 's',
  Playing = 'p',
  Seeking = 'k',
  Rebuffering = 'r',
  Paused = 'a',
  Ended = 'e',
  FatalError = 'f',
  Quit = 'q',
  Preloading = 'd',
}

/** v2 Event Mode event types (`e`) that this integration reports */
export type CmcdEventType =
  | 'abe'
  | 'abs'
  | 'ae'
  | 'as'
  | 'b'
  | 'bc'
  | 'c'
  | 'ce'
  | 'e'
  | 'h'
  | 'm'
  | 'ps'
  | 'rr'
  | 'sk'
  | 't'
  | 'um';

/** v2: one value of an Inner List with the object type as parameter, e.g. `4200;v` */
export interface CmcdTypedValue {
  value: number;
  type: CmcdObjectTypeToken;
}

/** v2: plain value, which gets the object type of the request as parameter, or values per object type */
export type CmcdListValue = number | CmcdTypedValue[];

export interface CmcdHeaders {
  [CmcdHeaderType.Request]?: string;
  [CmcdHeaderType.Object]?: string;
  [CmcdHeaderType.Session]?: string;
  [CmcdHeaderType.Status]?: string;
}

export enum CmcdVersionNumbers {
  v1 = 1,
  v2 = 2,
}

export enum CmcdHeaderType {
  Object = 'CMCD-Object',
  Request = 'CMCD-Request',
  Status = 'CMCD-Status',
  Session = 'CMCD-Session',
}

/**
 * CMCD v1 data of one request. Values are unrounded and unencoded; the encoder applies the rules of the
 * key table. `undefined` keys are not sent.
 */
export interface CmcdData {
  /** Encoded bitrate in kbps */
  br?: CmcdListValue;
  /** Buffer length in ms */
  bl?: CmcdListValue;
  /** Buffer starvation since the prior request */
  bs?: boolean;
  /** Content id, max. 64 characters */
  cid?: string;
  /** Object duration in ms */
  d?: number;
  /** Deadline in ms */
  dl?: number;
  /** Measured throughput in kbps */
  mtp?: CmcdListValue;
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
  tb?: CmcdListValue;
  /** CMCD version */
  v?: CmcdVersionNumbers;
}

/** CMCD v2 Request Mode data: the v1 keys and the keys added in v2. `nrr` is not sent in v2. */
export interface CmcdDataV2 extends CmcdData {
  /** Backgrounded: the page is hidden */
  bg?: boolean;
  /** Buffer starvation count since session start */
  bsa?: number;
  /** Durations of the buffer starvations completed since the prior request, in ms */
  bsd?: number[];
  /** Buffer starvation duration since session start, in ms */
  bsda?: number;
  /** Dropped frames since session start */
  dfa?: number;
  /** Player error codes since the prior request */
  ec?: string[];
  /** Lowest bitrate in kbps */
  lb?: CmcdListValue;
  /** Live latency in ms */
  ltc?: number;
  /** Media start delay in ms */
  msd?: number;
  /** Playhead bitrate in kbps */
  pb?: CmcdListValue;
  /** Playhead time in ms, epoch ms for live with a wallclock */
  pt?: number;
  /** Sequence number */
  sn?: number;
  /** Play state */
  sta?: CmcdPlayStateToken;
  /** Target buffer length in ms */
  tbl?: CmcdListValue;
}

/** CMCD v2 Event Mode data: the v2 Request Mode keys and the Event Mode keys. */
export interface CmcdEventData extends CmcdDataV2 {
  /** Custom event name, max. 64 characters */
  cen?: string;
  /** Base64 of the `CMSD-Dynamic` response header */
  cmsdd?: string;
  /** Base64 of the `CMSD-Static` response header */
  cmsds?: string;
  /** Event type */
  e?: CmcdEventType;
  /** Hostname the player retrieves content from, max. 128 characters */
  h?: string;
  /** Response code */
  rc?: number;
  /** Event time, or request start for `rr`, in epoch ms */
  ts?: number;
  /** Time to first byte in ms */
  ttfb?: number;
  /** Time to first body byte in ms */
  ttfbb?: number;
  /** Time to last byte in ms */
  ttlb?: number;
  /** URL of the request, before redirects */
  url?: string;
}

type CmcdValue = string | number | boolean | string[] | number[] | CmcdTypedValue[];

type CmcdScalar = string | number | boolean;

type CmcdValueType = 'integer' | 'decimal' | 'string' | 'token' | 'boolean';

export interface CmcdKeyInfo {
  /** Header in Request Mode, none for Event-only keys */
  header?: CmcdHeaderType;
  /** Event Mode: event types the key is allowed for, default all */
  events?: CmcdEventType[];
  /** Type of the value, or of each list item */
  type: CmcdValueType;
  /** Rounds to a multiple of this value */
  round?: number;
  /** Value (after rounding) that is not sent */
  omit?: number | boolean;
  /** Value is URL encoded before serialization */
  urlEncode?: boolean;
  /** Maximum string length, checked when collecting the data */
  maxLength?: number;
  /**
   * v2: sent as Inner List, also for one value.
   * `typed`: each item gets the object type of the request (`ot`) as parameter if it is `a`, `v` or `av`.
   */
  list?: 'plain' | 'typed';
}

/** Keys of a CMCD version. Keys without an entry are not sent. */
/** `cid` and `sid` need a maximum length in every version. */
type CmcdIdKeyInfo = CmcdKeyInfo & { maxLength: number };

export type CmcdKeyTable<T extends CmcdData = CmcdEventData> = { [K in keyof T]?: CmcdKeyInfo } & {
  cid: CmcdIdKeyInfo;
  sid: CmcdIdKeyInfo;
};

export const CMCD_V1_KEYS: CmcdKeyTable<CmcdData> = {
  br: { header: CmcdHeaderType.Object, type: 'integer', round: 1 },
  bl: { header: CmcdHeaderType.Request, type: 'integer', round: 100 },
  bs: { header: CmcdHeaderType.Status, type: 'boolean', omit: false },
  cid: { header: CmcdHeaderType.Session, type: 'string', maxLength: 64 },
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
  sid: { header: CmcdHeaderType.Session, type: 'string', maxLength: 64 },
  st: { header: CmcdHeaderType.Session, type: 'token' },
  su: { header: CmcdHeaderType.Request, type: 'boolean', omit: false },
  tb: { header: CmcdHeaderType.Object, type: 'integer', round: 1 },
  v: { header: CmcdHeaderType.Session, type: 'integer', omit: 1 },
};

/**
 * v2 Request Mode keys. Differences to v1: inner lists, `pr` in CMCD-Status, `cid` up to 128 characters,
 * `nor` not URL encoded, `nrr` removed, `v` always sent, and new keys.
 *
 * Object type parameter (`;v`, `;a`): added to bitrate keys of the requested object (`br`, `lb`, `pb`, `tb`).
 * Not added to `bl`, `mtp` and `tbl`, as in the spec examples, nor to the stall keys, as the cause of a stall is unknown.
 */
export const CMCD_V2_KEYS: CmcdKeyTable<CmcdDataV2> = {
  bl: { header: CmcdHeaderType.Request, type: 'integer', round: 100, list: 'plain' },
  br: { header: CmcdHeaderType.Object, type: 'integer', round: 1, list: 'typed' },
  bg: { header: CmcdHeaderType.Status, type: 'boolean', omit: false },
  bs: { header: CmcdHeaderType.Status, type: 'boolean', omit: false },
  bsa: { header: CmcdHeaderType.Status, type: 'integer', list: 'plain' },
  bsd: { header: CmcdHeaderType.Status, type: 'integer', round: 1, list: 'plain' },
  bsda: { header: CmcdHeaderType.Status, type: 'integer', round: 1, list: 'plain' },
  cid: { header: CmcdHeaderType.Session, type: 'string', maxLength: 128 },
  d: { header: CmcdHeaderType.Object, type: 'integer', round: 1 },
  dfa: { header: CmcdHeaderType.Request, type: 'integer' },
  dl: { header: CmcdHeaderType.Request, type: 'integer', round: 100 },
  ec: { header: CmcdHeaderType.Status, type: 'string', list: 'plain' },
  lb: { header: CmcdHeaderType.Object, type: 'integer', round: 1, list: 'typed' },
  ltc: { header: CmcdHeaderType.Request, type: 'integer', round: 1 },
  msd: { header: CmcdHeaderType.Session, type: 'integer', round: 1 },
  mtp: { header: CmcdHeaderType.Request, type: 'integer', round: 100, omit: 0, list: 'plain' },
  nor: { header: CmcdHeaderType.Request, type: 'string', list: 'plain' },
  ot: { header: CmcdHeaderType.Object, type: 'token' },
  pb: { header: CmcdHeaderType.Request, type: 'integer', round: 1, list: 'typed' },
  pr: { header: CmcdHeaderType.Status, type: 'decimal', omit: 1 },
  pt: { header: CmcdHeaderType.Status, type: 'integer', round: 1 },
  rtp: { header: CmcdHeaderType.Status, type: 'integer', round: 100, omit: 0 },
  sf: { header: CmcdHeaderType.Session, type: 'token' },
  sid: { header: CmcdHeaderType.Session, type: 'string', maxLength: 64 },
  sn: { header: CmcdHeaderType.Request, type: 'integer' },
  st: { header: CmcdHeaderType.Session, type: 'token' },
  sta: { header: CmcdHeaderType.Request, type: 'token' },
  su: { header: CmcdHeaderType.Request, type: 'boolean', omit: false },
  tb: { header: CmcdHeaderType.Object, type: 'integer', round: 1, list: 'typed' },
  tbl: { header: CmcdHeaderType.Request, type: 'integer', round: 100, list: 'plain' },
  v: { header: CmcdHeaderType.Session, type: 'integer' },
};

/** v2 keys that are only allowed in Event Mode */
export const CMCD_V2_EVENT_ONLY_KEYS: { [K in Exclude<keyof CmcdEventData, keyof CmcdDataV2>]?: CmcdKeyInfo } = {
  cen: { type: 'string', maxLength: 64, events: ['ce'] },
  cmsdd: { type: 'string', events: ['rr'] },
  cmsds: { type: 'string', events: ['rr'] },
  e: { type: 'token' },
  h: { type: 'string', maxLength: 128 },
  rc: { type: 'integer', events: ['rr'] },
  ts: { type: 'integer', round: 1 },
  ttfb: { type: 'integer', round: 1, events: ['rr'] },
  ttfbb: { type: 'integer', round: 1, events: ['rr'] },
  ttlb: { type: 'integer', round: 1, events: ['rr'] },
  url: { type: 'string', events: ['rr'] },
};

/** Keys of v2 Event Mode */
export const CMCD_V2_EVENT_KEYS: CmcdKeyTable<CmcdEventData> = Object.assign({}, CMCD_V2_EVENT_ONLY_KEYS, CMCD_V2_KEYS);

/** Key table per version (Request Mode) */
export const CMCD_KEYS: { [version: number]: CmcdKeyTable<CmcdDataV2> } = {
  [CmcdVersionNumbers.v1]: CMCD_V1_KEYS,
  [CmcdVersionNumbers.v2]: CMCD_V2_KEYS,
};

/** v2: maximum length of custom key values */
const MAX_V2_CUSTOM_VALUE_LENGTH = 64;

/** Object types that the parameter of `typed` list keys is added for */
const TYPED_OBJECT_TYPES: string[] = [
  CmcdObjectTypeToken.AudioOnly,
  CmcdObjectTypeToken.VideoOnly,
  CmcdObjectTypeToken.MuxedVideoAudio,
];

const PRINTABLE_ASCII_REGEX = /^[\x20-\x7e]*$/;

/**
 * Serializes one v1 key-value pair. Returns `null` if the key is not sent.
 * Without `info` (custom keys), only the generic rules apply.
 * `forHeader` rejects keys and strings that are not printable ASCII, as HTTP header values must not contain them.
 */
function encodeV1Member(key: string, value: CmcdScalar, info?: CmcdKeyInfo, forHeader = false): string | null {
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

/** Converts one v2 value to a bare item. Returns `null` if it is not sent. */
function toV2BareItem(value: CmcdScalar, info: CmcdKeyInfo): SfBareItem | null {
  if (info.round) {
    value = Math.round((value as number) / info.round) * info.round;
  }
  if (value === info.omit || value === '') {
    return null;
  }
  switch (info.type) {
    case 'integer':
      if (!isInteger(value as number)) {
        throw new TypeError(`Not an integer: ${value}`);
      }
      return value;
    case 'decimal':
      return new SfDecimal(value as number);
    case 'token':
      return new SfToken(value as string);
  }
  return value;
}

/**
 * Serializes one v2 key-value pair according to RFC 8941. Returns `null` if the key is not sent.
 * Without `info` (custom keys), the value is sent as String of max. 64 characters.
 * `ot` is the object type of the request, used as parameter of `typed` list keys.
 */
function encodeV2Member(key: string, value: CmcdValue, info?: CmcdKeyInfo, ot?: CmcdObjectTypeToken): string | null {
  if (!info) {
    const text = String(value);
    if (text.length > MAX_V2_CUSTOM_VALUE_LENGTH) {
      throw new RangeError(`Value exceeds ${MAX_V2_CUSTOM_VALUE_LENGTH} characters (${text.length})`);
    }
    return text ? serializeDictionaryMember(key, { value: text }) : null;
  }
  if (!info.list) {
    const item = toV2BareItem(value as CmcdScalar, info);
    return item === null ? null : serializeDictionaryMember(key, { value: item });
  }

  let params: SfParameters | undefined;
  if (info.list === 'typed' && ot && TYPED_OBJECT_TYPES.indexOf(ot) !== -1) {
    params = { [ot]: true };
  }
  const items: SfItem[] = [];
  for (const itemValue of Array.isArray(value) ? value : [value]) {
    // Values per object type carry their own type as parameter.
    const isTyped = typeof itemValue === 'object';
    const item = toV2BareItem(isTyped ? itemValue.value : itemValue, info);
    if (item !== null) {
      items.push({ value: item, params: isTyped ? { [itemValue.type]: true } : params });
    }
  }
  return items.length > 0 ? serializeDictionaryMember(key, items) : null;
}

interface CmcdEntry {
  key: string;
  header: CmcdHeaderType | null;
  member: string;
}

/** Warnings already logged, to log each invalid key or value only once */
const warnOnce = createWarnOnce();

type CmcdMemberEncoder = (
  key: string,
  value: CmcdValue,
  info: CmcdKeyInfo | undefined,
  data: CmcdEventData,
  forHeader: boolean
) => string | null;

/** Member encoder per version */
const MEMBER_ENCODERS: { [version: number]: CmcdMemberEncoder } = {
  [CmcdVersionNumbers.v1]: (key, value, info, _data, forHeader) =>
    encodeV1Member(key, value as CmcdScalar, info, forHeader),
  [CmcdVersionNumbers.v2]: (key, value, info, data) => encodeV2Member(key, value, info, data.ot),
};

/**
 * The encoding rules follow the version in `data.v`, v1 if unset or unknown.
 * Event Mode uses the v2 Event Mode keys. Keys that are not allowed for the event type `data.e` are not sent.
 */
function toEntries(
  data: CmcdEventData,
  customKeys: CmcdCustomKey[],
  forHeader: boolean,
  isEventMode = false
): CmcdEntry[] {
  const version = data.v && CMCD_KEYS[data.v] ? data.v : CmcdVersionNumbers.v1;
  const keys: CmcdKeyTable = isEventMode ? CMCD_V2_EVENT_KEYS : CMCD_KEYS[version];
  const encodeMember = MEMBER_ENCODERS[version];
  const isAllowed = (info: CmcdKeyInfo) => !info.events || (!!data.e && info.events.indexOf(data.e) !== -1);
  const entries: CmcdEntry[] = [];
  const add = (key: string, value: CmcdValue, header: CmcdHeaderType | null, info?: CmcdKeyInfo) => {
    let member: string | null = null;
    try {
      member = encodeMember(key, value, info, data, forHeader);
    } catch (error) {
      warnOnce(`CMCD: '${key}' is not sent: ${(error as Error).message}`);
    }
    if (member !== null) {
      entries.push({ key, header, member });
    }
  };

  for (const key of Object.keys(data) as (keyof CmcdEventData)[]) {
    const info = keys[key];
    const value = data[key];
    if (info && value !== undefined && value !== null && isAllowed(info)) {
      add(key, value, info.header || null, info);
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

export function cmcdDataToHeader(data: CmcdDataV2, customKeys: CmcdCustomKey[] = []): CmcdHeaders {
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

export function cmcdDataToUrlParameter(data: CmcdDataV2, customKeys: CmcdCustomKey[] = []): string {
  // 10. If the data payload is transmitted as a query argument, then the entire payload
  // string MUST be URLEncoded per [5].
  // Throws a URIError for lone surrogates.
  let payload = encodeURIComponent(joinMembers(toEntries(data, customKeys, false)));
  if (data.v === CmcdVersionNumbers.v2) {
    // v2: inner lists use `(` and `)`. Encodes all characters except the RFC 3986 unreserved ones, as the spec examples do.
    payload = payload.replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  }
  return `CMCD=${payload}`;
}

/**
 * v2 Event Mode: one record of an `application/cmcd` body. As a query argument payload, but not URL encoded.
 * Always v2 (CTA-5004-B 5.2), also if Request Mode uses v1.
 */
export function cmcdDataToEventRecord(data: CmcdEventData, customKeys: CmcdCustomKey[] = []): string {
  return joinMembers(toEntries(Object.assign({}, data, { v: CmcdVersionNumbers.v2 }), customKeys, false, true));
}

/** v2 Event Mode: `application/cmcd` body of the records, separated by LF without a trailing LF */
export function cmcdEventRecordsToBody(records: string[]): string {
  return records.join('\n');
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
