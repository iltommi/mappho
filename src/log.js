const panel = document.getElementById('log-panel');
const list = document.getElementById('log-list');

document.getElementById('log-close').addEventListener('click', () => {
  panel.classList.remove('open');
});

document.getElementById('log-clear').addEventListener('click', () => {
  list.innerHTML = '';
});

document.getElementById('log-save').addEventListener('click', async () => {
  const lines = [];
  for (const entry of [...list.children].reverse()) {
    const time  = entry.querySelector('.log-time')?.textContent ?? '';
    const label = entry.querySelector('.log-label')?.textContent ?? '';
    const pre   = entry.querySelector('pre')?.textContent ?? '';
    lines.push(pre ? `${time} ${label}\n  ${pre.replace(/\n/g, '\n  ')}` : `${time} ${label}`);
  }
  const text     = lines.join('\n');
  const filename = `sharpho-log-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.txt`;

  // Try Web Share API first (shows Android share sheet)
  try {
    const file = new File([text], filename, { type: 'text/plain' });
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'SharPho debug log' });
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') return; // user dismissed share sheet
    console.warn('share failed, falling back to download', e);
  }

  // Fallback: anchor download (desktop / unsupported WebViews)
  const blob = new Blob([text], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
