const panel = document.getElementById('log-panel');
const list = document.getElementById('log-list');

document.getElementById('log-close').addEventListener('click', () => {
  panel.classList.remove('open');
});

document.getElementById('log-clear').addEventListener('click', () => {
  list.innerHTML = '';
});

document.getElementById('log-save').addEventListener('click', () => {
  const lines = [];
  for (const entry of [...list.children].reverse()) {
    const time  = entry.querySelector('.log-time')?.textContent ?? '';
    const label = entry.querySelector('.log-label')?.textContent ?? '';
    const pre   = entry.querySelector('pre')?.textContent ?? '';
    lines.push(pre ? `${time} ${label}\n  ${pre.replace(/\n/g, '\n  ')}` : `${time} ${label}`);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sharpho-log-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
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
