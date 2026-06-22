export function askRetry(count, noun) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:6000;display:flex;align-items:center;justify-content:center';

    const box = document.createElement('div');
    box.style.cssText = 'background:#16213e;border:1px solid #334155;border-radius:12px;padding:20px 24px;max-width:300px;width:90vw;display:flex;flex-direction:column;gap:14px';

    const msg = document.createElement('p');
    msg.style.cssText = 'color:#e2e8f0;margin:0;font-size:.95rem;text-align:center;line-height:1.4';
    msg.textContent = `${count} ${noun}${count !== 1 ? 's' : ''} couldn't be processed. Retry?`;

    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:10px';

    const yes = document.createElement('button');
    yes.textContent = '↺ Retry';
    yes.style.cssText = 'flex:1;padding:10px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-size:.9rem;cursor:pointer';

    const no = document.createElement('button');
    no.textContent = 'Skip';
    no.style.cssText = 'flex:1;padding:10px;border:none;border-radius:8px;background:#334155;color:#e2e8f0;font-size:.9rem;cursor:pointer';

    btns.append(yes, no);
    box.append(msg, btns);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    yes.addEventListener('click', () => { overlay.remove(); resolve(true); });
    no.addEventListener('click', () => { overlay.remove(); resolve(false); });
  });
}
