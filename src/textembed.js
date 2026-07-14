// On-device CLIP text encoder for semantic photo search. This is the only
// client-side ML inference in the app — it runs entirely in the WebView via
// transformers.js (ONNX Runtime / WASM). Image embeddings are precomputed by
// the companion tool and synced separately (see embeddings.js); the phone
// only ever encodes the user's short query string.
//
// The model itself (config/tokenizer/ONNX weights) is synced from
// Photos/clip-text-tower/ on pCloud, same file-hosting pattern as
// faces.json/locations.json/embeddings.*, and cached in IndexedDB — but
// transformers.js has no notion of "load this model from pCloud" (it
// expects a plain HTTPS host, and pCloud files need an authenticated,
// signed-URL fetch). Instead of trying to make pCloud look like a static
// file host, this hands transformers.js a custom cache object (env.customCache)
// that serves the already-downloaded bytes by filename match — checked
// before it would ever attempt a real network fetch, so the fetch never
// happens. See buildResourcePaths/tryCache in transformers.js's source for
// why this specific mechanism (rather than e.g. env.remoteHost) was chosen:
// it doesn't require replicating their exact URL-construction logic.
import { env, AutoTokenizer, CLIPTextModelWithProjection } from '@huggingface/transformers';
import { statByPath, downloadFullFile } from './pcloud.js';
import { getAllTextModelFiles, putTextModelFile } from './db.js';
import { log } from './log.js';

const REMOTE_DIR = '/Photos/clip-text-tower';
const MODEL_ID = 'mappho/clip-text-tower'; // arbitrary — never actually resolved over the network, only used as a cache namespace
const MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.json',
  'merges.txt',
  'onnx/text_model_quantized.onnx',
];

let _tokenizer = null;
let _model     = null;
let _loading   = null;

// Serves pre-downloaded model files to transformers.js by matching the
// request URL's filename suffix — avoids needing to replicate its internal
// remoteHost/remotePathTemplate URL construction exactly.
function makeCustomCache(files) {
  return {
    async match(request) {
      const url = typeof request === 'string' ? request : request.url;
      for (const [name, buf] of files) {
        if (url.endsWith('/' + name) || url.endsWith(name)) return new Response(buf);
      }
      return undefined;
    },
    async put() {}, // no-op — nothing new to persist, we already have every file
  };
}

async function syncModelFiles() {
  const local = await getAllTextModelFiles();
  if (local.size >= MODEL_FILES.length) {
    log('TextEmbed', `using local model files — ${local.size} cached`);
    return local;
  }
  log('TextEmbed', 'downloading CLIP text-tower model files from pCloud');
  const files = new Map();
  for (const name of MODEL_FILES) {
    const stat = await statByPath(`${REMOTE_DIR}/${name}`);
    const buf = await downloadFullFile(stat.fileid);
    await putTextModelFile(name, buf);
    files.set(name, buf);
    log('TextEmbed', `synced ${name} (${(buf.byteLength / 1e6).toFixed(1)} MB)`);
  }
  return files;
}

function load() {
  if (_tokenizer && _model) return Promise.resolve();
  if (!_loading) {
    _loading = (async () => {
      const files = await syncModelFiles();
      env.useCustomCache = true;
      env.customCache = makeCustomCache(files);
      // Deliberately NOT setting allowRemoteModels=false: transformers.js
      // has an unconditional guard that throws if both allowLocalModels and
      // allowRemoteModels are false, checked before the custom cache is
      // ever consulted — allowLocalModels already defaults to false in a
      // browser. Leaving allowRemoteModels at its default (true) is safe:
      // the cache is still checked first and satisfies every real request,
      // so a genuine network fetch only happens if a file is unexpectedly
      // missing from the cache, and fails cleanly (404) rather than hanging.
      const t0 = Date.now();
      _tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
      _model     = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'q8' });
      log('TextEmbed', `model loaded in ${Date.now() - t0}ms`);
    })().catch(e => {
      _loading = null; // allow retry on next call instead of wedging forever
      _tokenizer = null;
      _model = null;
      throw e;
    });
  }
  return _loading;
}

// Kicks off the (large, one-time — tens of MB) model download without
// blocking on it. Call this as soon as search UI becomes reachable (e.g. the
// popup opens) so the first real query isn't stuck behind a cold load.
export function preloadTextEncoder() {
  load().catch(e => log('TextEmbed', `preload failed: ${e.message}`));
}

// Encodes free text into an L2-normalized 512-float query vector — same
// normalization convention as the int8-quantized photo embeddings, so a
// plain dot product against a dequantized stored vector is the cosine
// similarity directly.
export async function embedQuery(text) {
  await load();
  const inputs = _tokenizer([text], { padding: true, truncation: true });
  const { text_embeds } = await _model(inputs);
  const vec = Float32Array.from(text_embeds.data);
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}
