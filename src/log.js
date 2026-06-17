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

  // Try file share (shows Android share sheet with a .txt attachment)
  try {
    const file = new File([text], filename, { type: 'text/plain' });
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'SharPho debug log' });
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
  }

  // Try text share (works in Capacitor WebView without file support)
  if (navigator.share) {
    try {
      await navigator.share({ title: filename, text });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }

  // Fallback: copy to clipboard
  try {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById('log-save');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  } catch {
    console.warn('clipboard write failed');
  }
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
  while (list.children.length > 500) list.removeChild(list.lastChild);
}
