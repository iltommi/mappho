import { filterMarkers, getDateRange } from './map.js';

const panel   = document.getElementById('filter-panel');
const fromSlider = document.getElementById('filter-from');
const toSlider   = document.getElementById('filter-to');
const fromVal    = document.getElementById('filter-from-val');
const toVal      = document.getElementById('filter-to-val');

let minTs = 0, maxTs = 0;

function fmt(ts) {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function tsAt(sliderValue) {
  return minTs + (parseInt(sliderValue) / 1000) * (maxTs - minTs);
}

function apply() {
  const from = tsAt(fromSlider.value);
  const to   = tsAt(toSlider.value);
  fromVal.textContent = fmt(from);
  toVal.textContent   = fmt(to);
  filterMarkers(from, to);
}

fromSlider.addEventListener('input', () => {
  if (parseInt(fromSlider.value) > parseInt(toSlider.value))
    fromSlider.value = toSlider.value;
  apply();
});

toSlider.addEventListener('input', () => {
  if (parseInt(toSlider.value) < parseInt(fromSlider.value))
    toSlider.value = fromSlider.value;
  apply();
});

function init() {
  const range = getDateRange();
  if (!range) { panel.querySelector('.filter-no-dates').style.display = ''; return; }
  panel.querySelector('.filter-no-dates').style.display = 'none';
  minTs = range.min;
  maxTs = range.max;
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
