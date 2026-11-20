import { describe, it, expect } from '@jest/globals';
import { CmcdTargetRegistry } from '../../src/ts/CmcdTargetRegistry';

describe('CmcdTargetRegistry', () => {
  const createRegistry = (max: number) => {
    let created = 0;
    const registry = new CmcdTargetRegistry(() => ({ id: ++created }), max);
    return registry;
  };

  it('returns the same state for URLs of the same origin', () => {
    const registry = createRegistry(4);

    expect(registry.get('https://a.example/x/1.m4s')).toBe(registry.get('https://a.example/y/2.m4s?q=1'));
    expect(registry.get('https://a.example/1.m4s')).not.toBe(registry.get('https://b.example/1.m4s'));
  });

  it('shares one state for all invalid URLs', () => {
    const registry = createRegistry(4);

    expect(registry.get('not a url')).toBe(registry.get('also not a url'));
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
