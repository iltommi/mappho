// Most modules in src/ wire up DOM listeners at import time (e.g.
// `document.getElementById('x').addEventListener(...)` at module scope),
// mirroring how they run for real in index.html. That means even importing
// a module purely to test a couple of its pure functions pulls in every
// other module it references, each expecting its own element to already
// exist — so tests load the real index.html markup into jsdom once, up
// front, the same way a browser would before src/main.js ever runs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? '';
// Strip the app's own script tag — it's not what's under test, and jsdom
// doesn't execute module scripts anyway.
document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/, '');
