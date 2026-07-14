import { filterMarkers, getDateRange } from './map.js';
import { getOrphanDateRange, countOrphansInRange, countGeotaggedInRange } from './db.js';
import { getDateLocale } from './auth.js';

const panel        = document.getElementById('filter-panel');
const spanRow       = document.getElementById('filter-span-row');
const navRow        = document.getElementById('filter-nav-row');
const rangeDisplay  = document.getElementById('filter-range-val');
const prevBtn       = document.getElementById('filter-prev-btn');
const nextBtn       = document.getElementById('filter-next-btn');

const ONE_DAY_MS = 24 * 3600 * 1000;

let minTs = 0, maxTs = 0;
let fromTs = 0, toTs = 0;
// span in days, or null for "All time". anchorTs is the centre of the window
// when a span is active. Both persist across a plain toggleFilter() close so
// reopening the panel resumes where you left off; closeFilter() (erase cache)
// wipes them for good.
let span      = null;
let anchorTs  = null;
let _savedSpan     = null;
let _savedAnchorTs = null;

function fmt(ts) {
  return new Date(ts).toLocaleDateString(getDateLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
}

// Local-time YYYY-MM-DD for <input type="date"> — toISOString() would use UTC
// and shift the date for photos taken shortly after local midnight.
export function toDateStr(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

let rangeInfoHandler = null;
export function setRangeInfoHandler(fn) { rangeInfoHandler = fn; }

let rangeInfoTimer = null;
function scheduleRangeInfo() {
  if (!rangeInfoHandler) return;
  clearTimeout(rangeInfoTimer);
  const from = fromTs, to = toTs;
  rangeInfoTimer = setTimeout(async () => {
    const [withLocation, noLocation] = await Promise.all([
      countGeotaggedInRange(from, to),
      countOrphansInRange(from, to),
    ]);
    rangeInfoHandler({ total: withLocation + noLocation, withLocation });
  }, 150);
}

function apply() {
  if (span == null) {
    fromTs = minTs;
    toTs   = maxTs;
    navRow.style.display = 'none';
  } else {
    const half = (span * ONE_DAY_MS) / 2;
    fromTs = anchorTs - half;
    toTs   = anchorTs + half;
    rangeDisplay.textContent = `${fmt(fromTs)} – ${fmt(toTs)}`;
    prevBtn.disabled = fromTs <= minTs;
    nextBtn.disabled = toTs >= maxTs;
    navRow.style.display = 'flex';
  }
  spanRow.querySelectorAll('.filter-span-chip').forEach(chip => {
    chip.classList.toggle('active', (chip.dataset.span || null) === (span == null ? null : String(span)));
  });
  _savedSpan     = span;
  _savedAnchorTs = anchorTs;
  filterMarkers(fromTs, toTs);
  scheduleRangeInfo();
}

spanRow.addEventListener('click', e => {
  const chip = e.target.closest('.filter-span-chip');
  if (!chip) return;
  const value = chip.dataset.span;
  if (!value) {
    span = null;
  } else {
    span = Number(value);
    if (anchorTs == null) anchorTs = maxTs; // first time a span is picked: start from the most recent photo
  }
  apply();
});

function step(dir) {
  if (span == null) return;
  anchorTs += dir * span * ONE_DAY_MS;
  apply();
}
prevBtn.addEventListener('click', () => step(-1));
nextBtn.addEventListener('click', () => step(1));

// Tapping the range text opens a native date picker to jump the window's
// centre directly instead of stepping through it one span at a time.
const jumpPicker = document.createElement('input');
jumpPicker.type = 'date';
jumpPicker.className = 'filter-dt-input';
panel.appendChild(jumpPicker);
jumpPicker.addEventListener('change', () => {
  const ts = new Date(jumpPicker.value + 'T12:00:00').getTime();
  if (!isNaN(ts)) { anchorTs = ts; apply(); }
});
rangeDisplay.addEventListener('click', () => {
  jumpPicker.value = toDateStr(anchorTs ?? maxTs);
  if (jumpPicker.showPicker) jumpPicker.showPicker(); else jumpPicker.click();
});

async function init() {
  const noDatesEl   = panel.querySelector('.filter-no-dates');
  const gpsRange    = getDateRange();
  const orphanRange = await getOrphanDateRange();
  const mins = [gpsRange?.min, orphanRange?.min].filter(Boolean);
  const maxs = [gpsRange?.max, orphanRange?.max].filter(Boolean);
  const range = mins.length ? { min: Math.min(...mins), max: Math.max(...maxs) } : null;
  if (!range) {
    noDatesEl.textContent = 'No photo dates in cache — rescan to pick up dates.';
    noDatesEl.style.display = '';
    spanRow.style.display = 'none';
    navRow.style.display  = 'none';
    return;
  }
  if (range.min === range.max) {
    noDatesEl.textContent = `All photos are from ${fmt(range.min)} — filter not available.`;
    noDatesEl.style.display = '';
    spanRow.style.display = 'none';
    navRow.style.display  = 'none';
    return;
  }
  noDatesEl.style.display = 'none';
  spanRow.style.display   = 'flex';
  const saneMax = Date.now() + 2 * 365 * 24 * 3600 * 1000;
  minTs = Math.max(range.min, 0);
  maxTs = Math.min(range.max, saneMax);

  span     = _savedSpan;
  anchorTs = _savedAnchorTs != null ? Math.max(minTs, Math.min(maxTs, _savedAnchorTs)) : null;

  apply();
}

export function toggleFilter() {
  const open = panel.classList.toggle('open');
  document.body.classList.toggle('filter-open', open);
  if (open) init();
  else filterMarkers(-Infinity, Infinity);
}

export function closeFilter() {
  if (!panel.classList.contains('open')) return;
  panel.classList.remove('open');
  document.body.classList.remove('filter-open');
  minTs = 0; maxTs = 0;
  span = null; anchorTs = null;
  _savedSpan = null; _savedAnchorTs = null;
}

export function getActiveFilterRange() {
  if (!panel.classList.contains('open') || minTs >= maxTs) return null;
  return { from: fromTs, to: toTs };
}
