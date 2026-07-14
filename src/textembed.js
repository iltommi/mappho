// On-device CLIP text encoder for semantic photo search. This is the only
// client-side ML inference in the app — it runs entirely in the WebView via
// transformers.js (ONNX Runtime / WASM). Image embeddings are precomputed by
// the companion face/scene-recognition tool and synced separately (see
// embeddings.js); the phone only ever encodes the user's short query string.
//
// PLACEHOLDER MODEL: MODEL_ID currently points at OpenAI's original CLIP
// checkpoint, used only to validate that the pipeline mechanically works
// (model loads, tokenizes, encodes, produces a sane 512-float vector). It
// does NOT share an embedding space with the laion2b_s34b_b79k image
// embeddings the companion tool produces — real search results will be
// meaningless until this is swapped for an ONNX export of that exact
// checkpoint's text tower (see the "what to ask the ML devs for" note this
// was built alongside).
import { AutoTokenizer, CLIPTextModelWithProjection } from '@huggingface/transformers';
import { log } from './log.js';

const MODEL_ID = 'Xenova/clip-vit-base-patch32'; // TODO: swap for the laion2b_s34b_b79k text tower

let _tokenizer = null;
let _model     = null;
let _loading   = null;

function load() {
  if (_tokenizer && _model) return Promise.resolve();
  if (!_loading) {
    _loading = (async () => {
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
