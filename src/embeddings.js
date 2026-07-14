// Maintains the local mirror of the CLIP photo-embeddings corpus the
// companion ML tool produces — Photos/embeddings-manifest.json (small:
// hashes + metadata) and Photos/embeddings.bin (the bulk payload: an
// int8-quantized dim×count matrix, row-major, row i corresponding
// positionally to manifest.hashes[i]). See textembed.js for the on-device
// query-side encoder this is paired with.
//
// Unlike faces.js/locations.js this is NOT downloaded at app startup — it's
// tens of MB, so it's fetched lazily the first time semantic search is
// actually used (preloadEmbeddings()), and re-checked for staleness the
// next time search opens rather than on every app resume.
import { statByPath, downloadJsonFile, downloadFullFileNative, LARGE_FILE_TIMEOUT } from './pcloud.js';
import { getEmbeddingsBlob, putEmbeddingsBlob, clearEmbeddingsBlob } from './db.js';
import { normPcloudHash } from './hashutil.js';
import { log } from './log.js';

const MANIFEST_PATH = '/Photos/embeddings-manifest.json';
const BINARY_PATH    = '/Photos/embeddings.bin';
const MANIFEST_HASH_KEY = 'mappho_embeddings_manifest_hash'; // pCloud content hash of the last synced manifest
const BINARY_HASH_KEY   = 'mappho_embeddings_binary_hash';   // pCloud content hash of the last synced binary

let _cached  = null; // { hashes, dim, dtype, quantScale, count, vectors: Int8Array | Float32Array }
let _loading = null;

// Reports { file, bytes, total } while embeddings.bin downloads — total may
// be null if the server didn't send a content-length.
let _progressHandler = null;
export function setEmbeddingsProgressHandler(fn) { _progressHandler = fn; }

async function fetchAndStore() {
  const [manifestStat, binaryStat] = await Promise.all([statByPath(MANIFEST_PATH), statByPath(BINARY_PATH)]);
  const manifest = await downloadJsonFile(manifestStat.fileid, LARGE_FILE_TIMEOUT);
  if (!Array.isArray(manifest?.hashes) || !manifest.dim || !manifest.count) {
    throw new Error('malformed embeddings-manifest.json');
  }
  const buf = await downloadFullFileNative(binaryStat.fileid, {
    onProgress: (bytes, total) => _progressHandler?.({ file: 'embeddings.bin', bytes, total }),
  });
  const expectedBytes = manifest.count * manifest.dim * (manifest.dtype === 'float32' ? 4 : 1);
  if (buf.byteLength !== expectedBytes) {
    throw new Error(`embeddings.bin size mismatch: expected ${expectedBytes} bytes for ${manifest.count}×${manifest.dim} ${manifest.dtype}, got ${buf.byteLength}`);
  }
  const hashes = manifest.hashes.map(normPcloudHash);
  const record = {
    hashes,
    dim: manifest.dim,
    dtype: manifest.dtype,
    quantScale: manifest.quant_scale ?? null,
    count: manifest.count,
    model: manifest.model ?? null,
    generatedAt: manifest.generated_at ?? null,
    buffer: buf,
  };
  await putEmbeddingsBlob(record);
  localStorage.setItem(MANIFEST_HASH_KEY, String(manifestStat.hash ?? ''));
  localStorage.setItem(BINARY_HASH_KEY, String(binaryStat.hash ?? ''));
  log('Embeddings', `synced ${manifest.count} photo embeddings (${manifest.dtype}, dim ${manifest.dim}, model ${manifest.model ?? '?'})`);
  return record;
}

function toTypedVectors(record) {
  return record.dtype === 'float32' ? new Float32Array(record.buffer) : new Int8Array(record.buffer);
}

// Lazy gate: uses whatever's already in IDB without re-checking pCloud, one
// download attempt if the local mirror is empty. Call ensureFresh() instead
// when staleness actually matters (e.g. right when search UI opens).
function load() {
  if (_cached) return Promise.resolve(_cached);
  if (!_loading) {
    _loading = (async () => {
      try {
        const local = await getEmbeddingsBlob();
        if (local) {
          _cached = { ...local, vectors: toTypedVectors(local) };
          log('Embeddings', `using local mirror — ${local.count} entries`);
          return _cached;
        }
        log('Embeddings', 'local mirror empty — downloading from pCloud');
        const record = await fetchAndStore();
        _cached = { ...record, vectors: toTypedVectors(record) };
        return _cached;
      } catch (e) {
        log('Embeddings', `not available: ${e.message}`);
        return null;
      } finally {
        _loading = null;
      }
    })();
  }
  return _loading;
}

// Kicks off loading (from IDB, or downloading if empty) without blocking —
// call this as soon as search UI becomes reachable so the corpus is likely
// ready by the time the user actually submits a query.
export function preloadEmbeddings() {
  load().catch(e => log('Embeddings', `preload failed: ${e.message}`));
}

// Compares the remote manifest/binary hashes against what's locally synced
// and re-downloads if either changed. Meant to be called once when search
// UI opens (not on every app resume — this corpus is large enough that an
// unsolicited background re-sync would be a bad surprise on mobile data).
export async function ensureFresh() {
  await load();
  try {
    const [manifestStat, binaryStat] = await Promise.all([statByPath(MANIFEST_PATH), statByPath(BINARY_PATH)]);
    const manifestKnown = localStorage.getItem(MANIFEST_HASH_KEY);
    const binaryKnown   = localStorage.getItem(BINARY_HASH_KEY);
    const changed = !_cached
      || String(manifestStat.hash ?? '') !== manifestKnown
      || String(binaryStat.hash ?? '') !== binaryKnown;
    if (!changed) { log('Embeddings', `mirror up to date — ${_cached.count} entries`); return _cached; }
    log('Embeddings', 'remote embeddings changed or missing locally — re-downloading');
    const record = await fetchAndStore();
    _cached = { ...record, vectors: toTypedVectors(record) };
    return _cached;
  } catch (e) {
    log('Embeddings', `staleness check failed, using local mirror if any: ${e.message}`);
    return _cached;
  }
}

// Drops the local mirror entirely (e.g. Settings → Erase cache).
export async function clearEmbeddings() {
  _cached = null;
  await clearEmbeddingsBlob();
  localStorage.removeItem(MANIFEST_HASH_KEY);
  localStorage.removeItem(BINARY_HASH_KEY);
}

// Returns { hashes, dim, dtype, quantScale, count, vectors } or null if
// unavailable — the raw material for the ranking scan in search.js.
export async function getEmbeddingsMatrix() {
  return load();
}
