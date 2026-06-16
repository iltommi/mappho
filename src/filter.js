import { filterMarkers, getDateRange } from './map.js';
import { getOrphanDateRange } from './db.js';
import { getDateLocale } from './auth.js';

const panel   = document.getElementById('filter-panel');
const fromSlider = document.getElementById('filter-from');
const toSlider   = document.getElementById('filter-to');
const fromVal    = document.getElementById('filter-from-val');
const toVal      = document.getElementById('filter-to-val');

let minTs = 0, maxTs = 0;
// The slider's 0-1000 scale is too coarse to represent an exact picked date
// over a multi-year range (each tick can span days) — these hold the real,
// unquantized range, and the slider position is just a derived UI affordance.
let fromTs = 0, toTs = 0;

function fmt(ts) {
  return new Date(ts).toLocaleDateString(getDateLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
}

function tsAt(sliderValue) {
  return minTs + (parseInt(sliderValue) / 1000) * (maxTs - minTs);
}

function sliderAt(ts) {
  return Math.round(Math.max(0, Math.min(1000, (ts - minTs) / (maxTs - minTs) * 1000)));
}

// Format ms timestamp as "YYYY-MM-DDTHH:MM" for datetime-local input value.
function toInputValue(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function apply() {
  fromVal.textContent = fmt(fromTs);
  toVal.textContent   = fmt(toTs);
  filterMarkers(fromTs, toTs);
}

fromSlider.addEventListener('input', () => {
  if (parseInt(fromSlider.value) > parseInt(toSlider.value))
    fromSlider.value = toSlider.value;
  fromTs = tsAt(fromSlider.value);
  apply();
});

toSlider.addEventListener('input', () => {
  if (parseInt(toSlider.value) < parseInt(fromSlider.value))
    toSlider.value = fromSlider.value;
  toTs = tsAt(toSlider.value);
  apply();
});

// Hidden datetime-local inputs for precise date picking.
function makeDatePicker(onPick) {
  const input = document.createElement('input');
  input.type = 'datetime-local';
  input.className = 'filter-dt-input';
  panel.appendChild(input);
  input.addEventListener('change', () => {
    const ts = new Date(input.value).getTime();
    if (!isNaN(ts)) onPick(ts);
  });
  return input;
}

// Widens [minTs, maxTs] to include ts if it falls outside the current scale,
// rescaling both sliders' positions to match the still-exact fromTs/toTs.
function expandRangeIfNeeded(ts) {
  if (ts >= minTs && ts <= maxTs) return;
  minTs = Math.min(minTs, ts);
  maxTs = Math.max(maxTs, ts);
  fromSlider.value = sliderAt(fromTs);
  toSlider.value   = sliderAt(toTs);
}

let fromPicker, toPicker;
function ensurePickers() {
  if (fromPicker) return;
  fromPicker = makeDatePicker(ts => {
    expandRangeIfNeeded(ts);
    fromTs = ts;
    if (ts > toTs) toTs = ts;
    fromSlider.value = sliderAt(fromTs);
    toSlider.value   = sliderAt(toTs);
    apply();
  });
  toPicker = makeDatePicker(ts => {
    expandRangeIfNeeded(ts);
    toTs = ts;
    if (ts < fromTs) fromTs = ts;
    fromSlider.value = sliderAt(fromTs);
    toSlider.value   = sliderAt(toTs);
    apply();
  });
}

fromVal.addEventListener('click', () => {
  ensurePickers();
  fromPicker.removeAttribute('min');
  fromPicker.removeAttribute('max');
  fromPicker.value = toInputValue(fromTs);
  if (fromPicker.showPicker) fromPicker.showPicker(); else fromPicker.click();
});

toVal.addEventListener('click', () => {
  ensurePickers();
  toPicker.removeAttribute('min');
  toPicker.removeAttribute('max');
  toPicker.value = toInputValue(toTs);
  if (toPicker.showPicker) toPicker.showPicker(); else toPicker.click();
});

async function init() {
  const noDatesEl = panel.querySelector('.filter-no-dates');
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
  minTs = range.min;
  maxTs = range.max;
  fromTs = minTs;
  toTs   = maxTs;
  fromSlider.value = '0';
  toSlider.value   = '1000';
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

// Returns { from, to } in ms if the filter panel is open and has a valid range, else null.
export function getActiveFilterRange() {
  if (!panel.classList.contains('open') || minTs === maxTs) return null;
  return { from: fromTs, to: toTs };
}
