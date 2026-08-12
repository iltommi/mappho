import { describe, it, expect } from 'vitest';
import { parseDateFromFilename, tsFromParts, toDMS } from './exif.js';

describe('tsFromParts', () => {
  it('builds a local timestamp from valid parts', () => {
    const ts = tsFromParts(2024, 6, 13, 12, 12, 50);
    const d = new Date(ts);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(5); // 0-indexed
    expect(d.getDate()).toBe(13);
    expect(d.getHours()).toBe(12);
    expect(d.getMinutes()).toBe(12);
    expect(d.getSeconds()).toBe(50);
  });

  it('rejects an out-of-range month instead of letting Date roll over', () => {
    expect(tsFromParts(2025, 99, 1)).toBeNull(); // would silently become mid-2033
  });

  it('rejects an out-of-range day', () => {
    expect(tsFromParts(2024, 6, 32)).toBeNull();
  });

  it('rejects a nonexistent calendar date within the fixed day bound (Feb 30)', () => {
    // day=30 passes the simple `d > 31` bound check, but February never has
    // a 30th — Date would otherwise silently roll this over to Mar 1/2.
    expect(tsFromParts(2024, 2, 30)).toBeNull();
  });

  it('accepts Feb 29 on a leap year', () => {
    expect(tsFromParts(2024, 2, 29)).not.toBeNull();
  });

  it('rejects Feb 29 on a non-leap year', () => {
    expect(tsFromParts(2023, 2, 29)).toBeNull();
  });

  it('rejects out-of-range hour/minute/second', () => {
    expect(tsFromParts(2024, 6, 13, 25, 0, 0)).toBeNull();
    expect(tsFromParts(2024, 6, 13, 0, 60, 0)).toBeNull();
    expect(tsFromParts(2024, 6, 13, 0, 0, 60)).toBeNull();
  });

  it('rejects years far outside a plausible photo range', () => {
    expect(tsFromParts(1899, 1, 1)).toBeNull();
    expect(tsFromParts(2101, 1, 1)).toBeNull();
  });
});

describe('parseDateFromFilename', () => {
  it('parses a dashed full datetime', () => {
    const ts = parseDateFromFilename('2024-01-15_14-30-22_anything.jpg');
    const d = new Date(ts);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()])
      .toEqual([2024, 0, 15, 14, 30, 22]);
  });

  it('parses a T-separated, colon-timed datetime', () => {
    const ts = parseDateFromFilename('2024-01-15T14:30:22.jpg');
    const d = new Date(ts);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()])
      .toEqual([2024, 0, 15, 14, 30, 22]);
  });

  it('parses a compact full datetime', () => {
    const ts = parseDateFromFilename('20240613_121250.jpg');
    const d = new Date(ts);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()])
      .toEqual([2024, 5, 13, 12, 12, 50]);
  });

  it('parses a dashed date-only filename as local midnight', () => {
    const ts = parseDateFromFilename('2024-06-13_001.jpg');
    const d = new Date(ts);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2024, 5, 13, 0]);
  });

  it('parses a compact date-only filename surrounded by non-digits (WhatsApp-style)', () => {
    const ts = parseDateFromFilename('IMG-20240613-WA0001.jpg');
    const d = new Date(ts);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2024, 5, 13, 0]);
  });

  it('returns null when no date-like pattern is present', () => {
    expect(parseDateFromFilename('vacation_photo_final.jpg')).toBeNull();
  });

  it('does not mistake an impossible embedded date for a real one', () => {
    // Every digit-block pattern still runs through tsFromParts's validation.
    expect(parseDateFromFilename('2024-02-30_00-00-00.jpg')).toBeNull();
  });

  it('falls through to a later, looser pattern when an earlier one is invalid', () => {
    // The dashed-full-datetime and dashed-date-only patterns both match
    // structurally against the "2024-99-01" prefix but fail range validation
    // (month 99) — parsing should fall through all the way to the compact
    // surrounded-by-non-digits pattern rather than giving up on the filename.
    const ts = parseDateFromFilename('2024-99-01_10-10-10_IMG-20240613-0001.jpg');
    const d = new Date(ts);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2024, 5, 13, 0]);
  });
});

describe('toDMS', () => {
  it('converts a decimal degree value to [deg, min, sec] rational pairs', () => {
    // 40.7128°N (roughly NYC) → 40° 42' 46.08"
    const [[degN, degD], [minN, minD], [secN, secD]] = toDMS(40.7128);
    expect(degN / degD).toBe(40);
    expect(minN / minD).toBe(42);
    expect(secN / secD).toBeCloseTo(46.08, 1);
  });

  it('round-trips back to (approximately) the original decimal value', () => {
    const decimal = 51.5074; // London
    const [[degN, degD], [minN, minD], [secN, secD]] = toDMS(decimal);
    const reconstructed = degN / degD + (minN / minD) / 60 + (secN / secD) / 3600;
    expect(reconstructed).toBeCloseTo(decimal, 4);
  });

  it('handles an exact whole-degree value', () => {
    const [[degN], [minN], [secN]] = toDMS(10);
    expect(degN).toBe(10);
    expect(minN).toBe(0);
    expect(secN).toBe(0);
  });
});
