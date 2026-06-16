import { filterMarkers, getDateRange } from './map.js';
import { getOrphanDateRange, countOrphansInRange, countGeotaggedInRange } from './db.js';
import { getDateLocale } from './auth.js';

const panel       = document.getElementById('filter-panel');
const fromDisplay = document.getElementById('filter-from-val');
const toDisplay   = document.getElementById('filter-to-val');

let minTs = 0, maxTs = 0;
let fromTs = 0, toTs = 0;

function fmt(ts) {
  return new Date(ts).toLocaleDateString(getDateLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
}

function toDateStr(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

let _pickersMade = false;

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
  fromDisplay.textContent = fmt(fromTs);
  toDisplay.textContent   = fmt(toTs);
  filterMarkers(fromTs, toTs);
  scheduleRangeInfo();
}

// Single tap: open date picker. Double tap within 350ms: reset to default.
function makeDateDisplay(displayEl, getDefault) {
  const picker = document.createElement('input');
  picker.type = 'date';
  picker.className = 'filter-dt-input';
  panel.appendChild(picker);

  picker.addEventListener('change', () => {
    const ts = new Date(picker.value + 'T12:00:00').getTime();
    if (!isNaN(ts)) {
      if (displayEl === fromDisplay) {
        fromTs = ts;
        if (fromTs > toTs) toTs = fromTs;
      } else {
        toTs = ts;
        if (toTs < fromTs) fromTs = toTs;
      }
      apply();
    }
  });

  let lastTap = 0;
  displayEl.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 350) {
      lastTap = 0;
      if (displayEl === fromDisplay) fromTs = getDefault();
      else                           toTs   = getDefault();
      if (fromTs > toTs) toTs = fromTs;
      if (toTs < fromTs) fromTs = toTs;
      apply();
      return;
    }
    lastTap = now;
    picker.value = toDateStr(displayEl === fromDisplay ? fromTs : toTs);
    if (picker.showPicker) picker.showPicker(); else picker.click();
  });
}

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
    return;
  }
  if (range.min === range.max) {
    noDatesEl.textContent = `All photos are from ${fmt(range.min)} — filter not available.`;
    noDatesEl.style.display = '';
    return;
  }
  noDatesEl.style.display = 'none';
  const saneMax = Date.now() + 2 * 365 * 24 * 3600 * 1000;
  minTs = Math.max(range.min, 0);
  maxTs = Math.min(range.max, saneMax);

  fromTs = minTs;
  toTs   = maxTs;

  if (!_pickersMade) {
    _pickersMade = true;
    makeDateDisplay(fromDisplay, () => minTs);
    makeDateDisplay(toDisplay,   () => maxTs);
  }

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
}

export function getActiveFilterRange() {
  if (!panel.classList.contains('open') || minTs === maxTs) return null;
  return { from: fromTs, to: toTs };
}
