import { describe, it, expect } from '@jest/globals';
import { toRelativeUrl } from '../../src/ts/Url';

describe('toRelativeUrl', () => {
  it.each([
    ['https://a.com/v/1000kbps/seg1.m4s', 'https://a.com/v/1000kbps/seg2.m4s', 'seg2.m4s'],
    ['https://a.com/v/1000kbps/seg1.m4s', 'https://a.com/v/300kbps/seg2.m4s', '../300kbps/seg2.m4s'],
    ['https://a.com/v/1000kbps/seg1.m4s', 'https://a.com/x/y/seg2.m4s', '../../x/y/seg2.m4s'],
    ['https://a.com/v/seg1.m4s', 'https://a.com/v/hd/seg2.m4s', 'hd/seg2.m4s'],
    ['https://a.com/v/seg1.m4s?CMCD=x', 'https://a.com/v/seg2.m4s?token=abc', 'seg2.m4s?token=abc'],
    ['https://a.com/v/seg1.m4s', 'https://a.com/v/a:b.m4s', './a:b.m4s'],
    ['https://a.com/v/seg1.m4s', 'seg2.m4s', 'seg2.m4s'],
  ])('%s -> %s = %s', (base, target, expected) => {
    expect(toRelativeUrl(base, target)).toEqual(expected);
  });

  it('returns null for different origins', () => {
    expect(toRelativeUrl('https://a.com/seg1.m4s', 'https://b.com/seg2.m4s')).toBeNull();
    expect(toRelativeUrl('https://a.com/seg1.m4s', 'http://a.com/seg2.m4s')).toBeNull();
  });
});
