/**
 * Serializer for the subset of Structured Field Values (RFC 8941) that CMCD uses.
 *
 * The `serialize*` functions throw a `TypeError` or `RangeError` for values that RFC 8941 cannot represent.
 */

/** Marks a string as Token, so it is serialized without quotes. */
export class SfToken {
  constructor(public readonly value: string) {}
}

/** Marks a number as Decimal, so integral values are serialized as e.g. `2.0`. */
export class SfDecimal {
  constructor(public readonly value: number) {}
}

export type SfBareItem = number | string | boolean | SfToken | SfDecimal;

export interface SfParameters {
  [key: string]: SfBareItem;
}

export interface SfItem {
  value: SfBareItem;
  params?: SfParameters;
}

export type SfInnerList = SfItem[];

const MAX_INTEGER = 999999999999999;
const MAX_DECIMAL_INTEGER_PART = 999999999999;
const KEY_REGEX = /^[a-z*][a-z0-9_\-.*]*$/;
const TOKEN_REGEX = /^[a-zA-Z*][!#$%&'*+\-.^_`|~0-9a-zA-Z:/]*$/;
const PRINTABLE_ASCII_REGEX = /^[\x20-\x7e]*$/;

export function isInteger(value: number): boolean {
  return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
}

export function serializeInteger(value: number): string {
  if (!isInteger(value)) {
    throw new TypeError(`Not an integer: ${value}`);
  }
  if (Math.abs(value) > MAX_INTEGER) {
    throw new RangeError(`Integer out of range: ${value}`);
  }
  return String(value);
}

/** Rounds to 3 fractional digits, ties to even. */
export function serializeDecimal(value: number): string {
  if (typeof value !== 'number' || !isFinite(value)) {
    throw new TypeError(`Not a decimal: ${value}`);
  }
  // 15 significant digits remove the float error of the multiplication, e.g. 130.0825 * 1000 = 130082.50000000001.
  // 15 digits cover the 12 integer and 3 fractional digits of the allowed range.
  const scaled = Number((value * 1000).toPrecision(15));
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const thousandths = diff > 0.5 || (diff === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;

  const abs = Math.abs(thousandths);
  const integerPart = Math.floor(abs / 1000);
  if (integerPart > MAX_DECIMAL_INTEGER_PART) {
    throw new RangeError(`Decimal out of range: ${value}`);
  }
  // At least one fractional digit, no trailing zeros
  const fraction = `00${abs % 1000}`.slice(-3).replace(/(\d)0+$/, '$1');
  return `${thousandths < 0 ? '-' : ''}${integerPart}.${fraction}`;
}

/** Escapes `\` and `"` and adds quotes, without checking the characters. */
export function quoteString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function serializeString(value: string): string {
  if (typeof value !== 'string' || !PRINTABLE_ASCII_REGEX.test(value)) {
    throw new TypeError(`Not a printable ASCII string: ${value}`);
  }
  return quoteString(value);
}

export function serializeToken(value: string): string {
  if (typeof value !== 'string' || !TOKEN_REGEX.test(value)) {
    throw new TypeError(`Not a token: ${value}`);
  }
  return value;
}

export function serializeBoolean(value: boolean): string {
  if (typeof value !== 'boolean') {
    throw new TypeError(`Not a boolean: ${value}`);
  }
  return value ? '?1' : '?0';
}

export function serializeKey(key: string): string {
  if (typeof key !== 'string' || !KEY_REGEX.test(key)) {
    throw new TypeError(`Not a key: ${key}`);
  }
  return key;
}

/** Numbers are serialized as Integer if integral, otherwise as Decimal. Use `SfDecimal` to force a Decimal. */
export function serializeBareItem(value: SfBareItem): string {
  if (value instanceof SfToken) {
    return serializeToken(value.value);
  }
  if (value instanceof SfDecimal) {
    return serializeDecimal(value.value);
  }
  switch (typeof value) {
    case 'number':
      return isInteger(value) ? serializeInteger(value) : serializeDecimal(value);
    case 'string':
      return serializeString(value);
    case 'boolean':
      return serializeBoolean(value);
  }
  throw new TypeError(`Unsupported bare item: ${value}`);
}

export function serializeParameters(params: SfParameters = {}): string {
  return Object.keys(params)
    .map((key) => {
      const value = params[key];
      return `;${serializeKey(key)}${value === true ? '' : `=${serializeBareItem(value)}`}`;
    })
    .join('');
}

export function serializeItem(item: SfItem): string {
  return serializeBareItem(item.value) + serializeParameters(item.params);
}

export function serializeInnerList(items: SfInnerList): string {
  return `(${items.map(serializeItem).join(' ')})`;
}

/** A Dictionary member. Boolean true is serialized as the bare key (plus parameters). */
export function serializeDictionaryMember(key: string, value: SfItem | SfInnerList): string {
  if (Array.isArray(value)) {
    return `${serializeKey(key)}=${serializeInnerList(value)}`;
  }
  if (value.value === true) {
    return serializeKey(key) + serializeParameters(value.params);
  }
  return `${serializeKey(key)}=${serializeItem(value)}`;
}
