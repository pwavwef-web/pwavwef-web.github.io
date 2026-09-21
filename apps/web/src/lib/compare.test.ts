import { describe, expect, it } from 'vitest';
import { sameData } from './compare';

describe('sameData', () => {
  it('ignores object key order at every depth', () => {
    expect(sameData({ palette: 'amber', visualStyle: '35mm', refs: { a: [1, 2], b: null } }, { refs: { b: null, a: [1, 2] }, visualStyle: '35mm', palette: 'amber' })).toBe(true);
  });

  it('still sees real changes, including array order and undefined-vs-missing keys', () => {
    expect(sameData({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameData({ a: 'x' }, { a: 'y' })).toBe(false);
    expect(sameData({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameData({ a: null }, { a: undefined })).toBe(false);
  });
});
