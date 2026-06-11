const panel = document.getElementById('log-panel');
const list = document.getElementById('log-list');

document.getElementById('log-close').addEventListener('click', () => {
  panel.classList.remove('open');
});

document.getElementById('log-clear').addEventListener('click', () => {
  list.innerHTML = '';
});

export function toggleLog() {
  panel.classList.toggle('open');
}

export function log(label, data) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  const time = new Date().toISOString().slice(11, 23);
  entry.innerHTML = `<span class="log-time">${time}</span> <span class="log-label">${label}</span>`;
  if (data !== undefined) {
    const pre = document.createElement('pre');
    pre.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    entry.appendChild(pre);
  }
  list.prepend(entry);
}
