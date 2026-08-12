import { describe, it, expect } from 'vitest';
import { normPcloudHash } from './hashutil.js';

describe('normPcloudHash', () => {
  it('returns null for null/undefined', () => {
    expect(normPcloudHash(null)).toBeNull();
    expect(normPcloudHash(undefined)).toBeNull();
  });

  it('normalizes a plain small integer the same way whether given as a number or a string', () => {
    expect(normPcloudHash(12345)).toBe('12345');
    expect(normPcloudHash('12345')).toBe('12345');
  });

  it('converges a hash reaching it as a JS number vs. as a numeric string to the same string', () => {
    // This is the regression this function exists for: a hash coming straight
    // from pCloud's API response (already a JSON.parse'd double) and the same
    // hash coming from an externally-generated JSON file (a numeric string)
    // must land on an identical string, or a join between the two never
    // matches even when they're the same underlying file.
    const big = 18446744073709551615; // uint64 max — already lossy as a JS double
    const bigStr = String(big);
    expect(normPcloudHash(big)).toBe(normPcloudHash(bigStr));
  });

  it('falls back to the raw string for a non-numeric value', () => {
    expect(normPcloudHash('not-a-hash')).toBe('not-a-hash');
  });

  it('treats 0 as a real hash value, not as nullish', () => {
    expect(normPcloudHash(0)).toBe('0');
  });
});
