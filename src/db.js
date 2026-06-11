import { openDB } from 'idb';

const DB_NAME = 'sharpho';
const DB_VERSION = 1;
const STORE = 'photos';

let _db;
async function db() {
  if (_db) return _db;
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore(STORE, { keyPath: 'fileid' });
    },
  });
  return _db;
}

export async function getCached(fileid) {
  return (await db()).get(STORE, fileid);
}

export async function putCached(photo) {
  return (await db()).put(STORE, photo);
}

export async function getAllCached() {
  return (await db()).getAll(STORE);
}

export async function countCached() {
  return (await db()).count(STORE);
}
