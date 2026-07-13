// pCloud content hashes are uint64, but every source that hands one to this
// app — pCloud's own API responses, faces.json, locations.json — goes
// through JSON.parse, whose numbers are IEEE-754 doubles and lose precision
// above 2^53. Round every hash through the same Number() conversion before
// stringifying so two hashes that reached the app via different paths (a
// photo record from pCloud vs. an entry from an externally-generated JSON
// file) still land on the same string and joins between them work.
export function normPcloudHash(h) {
  if (h == null) return null;
  const n = Number(h);
  return Number.isFinite(n) ? String(n) : String(h);
}
