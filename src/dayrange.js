import { UNDATED_TS } from './db.js';

// [start, end] ms bounds of the local calendar day containing ts.
export function localDayBounds(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const from = d.getTime();
  d.setHours(23, 59, 59, 999);
  return { from, to: d.getTime() };
}

// Groups `anchors` (any selection of photos passed to a grid's "Same day"
// button) into the distinct local calendar days they cover, deduping
// anchors that land on the same day. Anchors without a real date are
// skipped. Shared by every sameDayFetch implementation across main.js and
// map.js (the cluster long-press grid can't import from main.js without a
// circular dependency, hence this standalone module).
export function distinctDayRanges(anchors) {
  const dayRanges = new Map(); // local midnight ts -> {from, to}
  for (const a of anchors) {
    if (a.ts == null || a.ts >= UNDATED_TS) continue;
    const { from, to } = localDayBounds(a.ts);
    dayRanges.set(from, { from, to });
  }
  return [...dayRanges.values()];
}

// sameDayFetch for grids whose full photo list is already resident in
// memory (person grids, cluster long-press grids) — no DB query needed,
// just filter the list that's already there by the anchors' day(s).
export function sameDayFromList(list) {
  return anchors => {
    const ranges = distinctDayRanges(anchors);
    if (!ranges.length) return [];
    return list.filter(p => p.ts != null && p.ts < UNDATED_TS && ranges.some(r => p.ts >= r.from && p.ts <= r.to));
  };
}
