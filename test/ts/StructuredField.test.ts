import { describe, it, expect } from '@jest/globals';
import {
  SfToken,
  quoteString,
  serializeBareItem,
  serializeBoolean,
  serializeDecimal,
  serializeDictionaryMember,
  serializeInnerList,
  serializeInteger,
  serializeItem,
  serializeKey,
  serializeParameters,
  serializeString,
  serializeToken,
} from '../../src/ts/StructuredField';

describe('StructuredField', () => {
  describe('serializeInteger', () => {
    it('serializes integers', () => {
      expect(serializeInteger(0)).toEqual('0');
      expect(serializeInteger(-0)).toEqual('0');
      expect(serializeInteger(42)).toEqual('42');
      expect(serializeInteger(-42)).toEqual('-42');
    });

    it('accepts the range limits', () => {
      expect(serializeInteger(999_999_999_999_999)).toEqual('999999999999999');
      expect(serializeInteger(-999_999_999_999_999)).toEqual('-999999999999999');
    });

    it('throws a RangeError beyond the range limits', () => {
      expect(() => serializeInteger(1_000_000_000_000_000)).toThrow(RangeError);
      expect(() => serializeInteger(-1_000_000_000_000_000)).toThrow(RangeError);
      expect(() => serializeInteger(12345678901234567)).toThrow(RangeError);
    });

    it('throws a TypeError for non-integers', () => {
      expect(() => serializeInteger(1.5)).toThrow(TypeError);
      expect(() => serializeInteger(NaN)).toThrow(TypeError);
      expect(() => serializeInteger(Infinity)).toThrow(TypeError);
      expect(() => serializeInteger('1' as any)).toThrow(TypeError);
    });
  });

  describe('serializeDecimal', () => {
    it('serializes decimals with at least one fractional digit', () => {
      expect(serializeDecimal(1.08)).toEqual('1.08');
      expect(serializeDecimal(2)).toEqual('2.0');
      expect(serializeDecimal(0)).toEqual('0.0');
      expect(serializeDecimal(-2.5)).toEqual('-2.5');
      expect(serializeDecimal(0.1 + 0.2)).toEqual('0.3');
    });

    it('rounds to 3 fractional digits', () => {
      expect(serializeDecimal(1.23456)).toEqual('1.235');
      expect(serializeDecimal(1.2344)).toEqual('1.234');
      expect(serializeDecimal(-1.23456)).toEqual('-1.235');
      expect(serializeDecimal(0.9999)).toEqual('1.0');
      expect(serializeDecimal(-0.0001)).toEqual('0.0');
    });

    it('rounds ties to even', () => {
      // Binary fractions, so the tie is exact
      expect(serializeDecimal(0.0625)).toEqual('0.062');
      expect(serializeDecimal(0.1875)).toEqual('0.188');
      expect(serializeDecimal(-0.0625)).toEqual('-0.062');
      expect(serializeDecimal(-0.1875)).toEqual('-0.188');
    });

    it('accepts up to 12 integer digits', () => {
      expect(serializeDecimal(999_999_999_999.5)).toEqual('999999999999.5');
      expect(serializeDecimal(-999_999_999_999)).toEqual('-999999999999.0');
    });

    it('throws a RangeError for more than 12 integer digits', () => {
      expect(() => serializeDecimal(1_000_000_000_000)).toThrow(RangeError);
      expect(() => serializeDecimal(-1_000_000_000_000.5)).toThrow(RangeError);
      expect(() => serializeDecimal(Number.MAX_VALUE)).toThrow(RangeError);
    });

    it('throws a TypeError for non-finite numbers', () => {
      expect(() => serializeDecimal(NaN)).toThrow(TypeError);
      expect(() => serializeDecimal(-Infinity)).toThrow(TypeError);
    });
  });

  describe('serializeString', () => {
    it('quotes strings', () => {
      expect(serializeString('')).toEqual('""');
      expect(serializeString('test-content-id')).toEqual('"test-content-id"');
      expect(serializeString("a(b)!'* ~")).toEqual('"a(b)!\'* ~"');
    });

    it('escapes backslashes and quotes', () => {
      expect(serializeString('a\\b')).toEqual('"a\\\\b"');
      expect(serializeString('"a"')).toEqual('"\\"a\\""');
      expect(serializeString('"test"-content\\-id')).toEqual('"\\"test\\"-content\\\\-id"');
    });

    it('throws a TypeError for characters outside printable ASCII', () => {
      expect(() => serializeString('café')).toThrow(TypeError);
      expect(() => serializeString('\t')).toThrow(TypeError);
      expect(() => serializeString('a\nb')).toThrow(TypeError);
      expect(() => serializeString('\x7f')).toThrow(TypeError);
    });

    it('quoteString escapes without checking characters', () => {
      expect(quoteString('café "\\')).toEqual('"café \\"\\\\"');
    });
  });

  describe('serializeToken', () => {
    it('serializes tokens as is', () => {
      expect(serializeToken('v')).toEqual('v');
      expect(serializeToken('av')).toEqual('av');
      expect(serializeToken('*foo:bar/baz')).toEqual('*foo:bar/baz');
      expect(serializeToken("A1!#$%&'*+-.^_`|~")).toEqual("A1!#$%&'*+-.^_`|~");
    });

    it('throws a TypeError for invalid tokens', () => {
      expect(() => serializeToken('')).toThrow(TypeError);
      expect(() => serializeToken('1a')).toThrow(TypeError);
      expect(() => serializeToken('a b')).toThrow(TypeError);
      expect(() => serializeToken('a"b')).toThrow(TypeError);
      expect(() => serializeToken('a,b')).toThrow(TypeError);
    });
  });

  describe('serializeBoolean', () => {
    it('serializes booleans', () => {
      expect(serializeBoolean(true)).toEqual('?1');
      expect(serializeBoolean(false)).toEqual('?0');
    });

    it('throws a TypeError for non-booleans', () => {
      expect(() => serializeBoolean(1 as any)).toThrow(TypeError);
    });
  });

  describe('serializeKey', () => {
    it('accepts lowercase keys', () => {
      expect(serializeKey('br')).toEqual('br');
      expect(serializeKey('com.example-my_key*1')).toEqual('com.example-my_key*1');
      expect(serializeKey('*a')).toEqual('*a');
    });

    it('throws a TypeError for invalid keys', () => {
      expect(() => serializeKey('com.example-myNumericKey')).toThrow(TypeError);
      expect(() => serializeKey('')).toThrow(TypeError);
      expect(() => serializeKey('1a')).toThrow(TypeError);
      expect(() => serializeKey('a b')).toThrow(TypeError);
    });
  });

  describe('serializeBareItem', () => {
    it('infers the item type', () => {
      expect(serializeBareItem(3000)).toEqual('3000');
      expect(serializeBareItem(1.5)).toEqual('1.5');
      expect(serializeBareItem('seg.m4v')).toEqual('"seg.m4v"');
      expect(serializeBareItem(new SfToken('v'))).toEqual('v');
      expect(serializeBareItem(true)).toEqual('?1');
      expect(serializeBareItem(false)).toEqual('?0');
    });

    it('throws a TypeError for unsupported values', () => {
      expect(() => serializeBareItem({} as any)).toThrow(TypeError);
      expect(() => serializeBareItem(undefined as any)).toThrow(TypeError);
    });
  });

  describe('parameters', () => {
    it('serializes true as bare key', () => {
      expect(serializeParameters({ v: true })).toEqual(';v');
    });

    it('serializes other values with key', () => {
      expect(serializeParameters({ r: '100-200', a: false, n: 1 })).toEqual(';r="100-200";a=?0;n=1');
    });

    it('serializes no parameters as empty string', () => {
      expect(serializeParameters()).toEqual('');
      expect(serializeParameters({})).toEqual('');
    });

    it('throws for invalid parameter keys', () => {
      expect(() => serializeParameters({ A: true })).toThrow(TypeError);
    });

    it('serializes items with parameters', () => {
      expect(serializeItem({ value: 3000, params: { v: true } })).toEqual('3000;v');
      expect(serializeItem({ value: 'seg-2.m4v', params: { r: '100-' } })).toEqual('"seg-2.m4v";r="100-"');
    });
  });

  describe('inner list', () => {
    it('serializes items separated by space', () => {
      expect(
        serializeInnerList([
          { value: 3000, params: { v: true } },
          { value: 320, params: { a: true } },
        ])
      ).toEqual('(3000;v 320;a)');
    });

    it('serializes a single item', () => {
      expect(serializeInnerList([{ value: 2000 }])).toEqual('(2000)');
      expect(serializeInnerList([{ value: 'seg-2.m4v' }])).toEqual('("seg-2.m4v")');
    });

    it('serializes an empty list', () => {
      expect(serializeInnerList([])).toEqual('()');
    });

    it('throws for invalid items', () => {
      expect(() => serializeInnerList([{ value: 1e16 }])).toThrow(RangeError);
      expect(() => serializeInnerList([{ value: 'café' }])).toThrow(TypeError);
    });
  });

  describe('serializeDictionaryMember', () => {
    it('serializes items', () => {
      expect(serializeDictionaryMember('br', { value: 3200 })).toEqual('br=3200');
      expect(serializeDictionaryMember('ot', { value: new SfToken('v') })).toEqual('ot=v');
      expect(serializeDictionaryMember('sid', { value: 'abc' })).toEqual('sid="abc"');
      expect(serializeDictionaryMember('pr', { value: 1.08 })).toEqual('pr=1.08');
    });

    it('serializes true as bare key, also with parameters', () => {
      expect(serializeDictionaryMember('su', { value: true })).toEqual('su');
      expect(serializeDictionaryMember('bs', { value: true, params: { a: true } })).toEqual('bs;a');
    });

    it('serializes false as ?0', () => {
      expect(serializeDictionaryMember('bs', { value: false })).toEqual('bs=?0');
    });

    it('serializes inner lists', () => {
      expect(
        serializeDictionaryMember('br', [
          { value: 3000, params: { v: true } },
          { value: 320, params: { a: true } },
        ])
      ).toEqual('br=(3000;v 320;a)');
      expect(serializeDictionaryMember('bl', [{ value: 2000 }])).toEqual('bl=(2000)');
      expect(serializeDictionaryMember('nor', [{ value: 'seg-2.m4v' }])).toEqual('nor=("seg-2.m4v")');
      expect(serializeDictionaryMember('nor', [{ value: 'seg-2.m4v', params: { r: '100-200' } }])).toEqual(
        'nor=("seg-2.m4v";r="100-200")'
      );
    });

    it('throws for invalid keys', () => {
      expect(() => serializeDictionaryMember('com.example-myKey', { value: 1 })).toThrow(TypeError);
    });
  });
});
