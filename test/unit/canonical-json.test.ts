import { describe, expect, it } from 'bun:test';
import { canonicalHash, canonicalize } from '../../src/shared/domain/canonical-json.ts';

describe('canonicalize', () => {
  it('sorts object keys recursively', () => {
    const a = { b: 1, a: { d: 4, c: 3 } };
    const b = { a: { c: 3, d: 4 }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it('omits undefined properties', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('keeps null values', () => {
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });
});

describe('canonicalHash', () => {
  it('is stable regardless of key ordering', () => {
    const h1 = canonicalHash({ kind: 'BET', money: { amount: '25.00', currency: 'BRL' } });
    const h2 = canonicalHash({ money: { currency: 'BRL', amount: '25.00' }, kind: 'BET' });
    expect(h1).toBe(h2);
  });

  it('changes when a business value changes', () => {
    const h1 = canonicalHash({ amount: '25.00' });
    const h2 = canonicalHash({ amount: '25.01' });
    expect(h1).not.toBe(h2);
  });

  it('produces a 64-char hex SHA-256 digest', () => {
    expect(canonicalHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
