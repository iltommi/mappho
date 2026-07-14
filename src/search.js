// Ranks the synced CLIP photo-embeddings corpus against a free-text query,
// combining textembed.js (on-device query encoding) and embeddings.js (the
// synced photo corpus). Both sides are L2-normalized, so cosine similarity
// is a plain dot product.
import { embedQuery } from './textembed.js';
import { getEmbeddingsMatrix } from './embeddings.js';
import { log } from './log.js';

const DEFAULT_TOP_K = 200; // cross-modal CLIP similarity scores don't have a
// stable "good match" threshold the way same-modality (text-text) scores do,
// so a fixed result-count cap is safer than guessing a similarity cutoff.

// Returns [{ hash, score }, ...] sorted by descending similarity, or []
// if the embeddings corpus or text encoder aren't available.
export async function rankByQuery(text, { topK = DEFAULT_TOP_K } = {}) {
  const query = text.trim();
  if (!query) return [];
  const [queryVec, matrix] = await Promise.all([embedQuery(query), getEmbeddingsMatrix()]);
  if (!matrix) { log('Search', 'no embeddings corpus available'); return []; }

  const { hashes, vectors, dim, dtype, quantScale } = matrix;
  const invScale = dtype === 'float32' ? 1 : 1 / (quantScale ?? 127);
  // Pre-scale the query once instead of dividing 48k×512 times in the loop.
  const scaledQuery = new Float32Array(dim);
  for (let d = 0; d < dim; d++) scaledQuery[d] = queryVec[d] * invScale;

  const t0 = performance.now();
  const scored = new Array(hashes.length);
  for (let i = 0; i < hashes.length; i++) {
    const base = i * dim;
    let dot = 0;
    for (let d = 0; d < dim; d++) dot += vectors[base + d] * scaledQuery[d];
    scored[i] = { hash: hashes[i], score: dot };
  }
  scored.sort((a, b) => b.score - a.score);
  log('Search', `"${query}" ranked ${hashes.length} photos in ${(performance.now() - t0).toFixed(0)}ms`);
  return topK ? scored.slice(0, topK) : scored;
}
