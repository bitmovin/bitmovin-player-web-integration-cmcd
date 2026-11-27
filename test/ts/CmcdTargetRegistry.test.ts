import { describe, it, expect } from '@jest/globals';
import { CmcdTargetRegistry, toOrigin } from '../../src/ts/CmcdTargetRegistry';

describe('toOrigin', () => {
  it('returns the origin of a URL', () => {
    expect(toOrigin('https://a.example/x/1.m4s?q=1')).toBe('https://a.example');
    expect(toOrigin('https://a.example:8443/1.m4s')).toBe('https://a.example:8443');
  });

  it('returns the same empty origin for all invalid URLs', () => {
    expect(toOrigin('not a url')).toBe('');
    expect(toOrigin('also not a url')).toBe('');
  });
});

describe('CmcdTargetRegistry', () => {
  const createRegistry = (max: number) => {
    let created = 0;
    const registry = new CmcdTargetRegistry((key) => ({ id: ++created, key }), max);
    return registry;
  };

  it('returns the same state for the same key, created with the key', () => {
    const registry = createRegistry(4);

    expect(registry.get('a')).toBe(registry.get('a'));
    expect(registry.get('a')).not.toBe(registry.get('b'));
    expect(registry.get('b').key).toBe('b');
  });

  it('drops the least recently used origin when full', () => {
    const registry = createRegistry(2);
    const a = registry.get('https://a.example/');
    const b = registry.get('https://b.example/');

    // Use `a` again, so `b` is the least recently used one.
    registry.get('https://a.example/');
    registry.get('https://c.example/');

    expect(registry.get('https://a.example/')).toBe(a);
    expect(registry.get('https://b.example/')).not.toBe(b);
  });

  it('visits all known states', () => {
    const registry = createRegistry(4);
    registry.get('https://a.example/');
    registry.get('https://b.example/');
    const visited: number[] = [];

    registry.forEach((target) => visited.push(target.id));

    expect(visited.sort()).toEqual([1, 2]);
  });
});
