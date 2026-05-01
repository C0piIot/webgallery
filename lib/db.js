// IndexedDB wrapper for the five stores defined in
// docs/architecture.md → IndexedDB stores. Every later module that owns
// durable state goes through this file.
//
// API:
//   open()                     — idempotent; returns the IDBDatabase.
//   get(store, key)            — single-call read.
//   put(store, value, key?)    — single-call write (key only when keyPath null).
//   del(store, key)            — single-call delete.
//   iterate(store, cb)         — visit every record; return false from cb to stop.
//   tx(stores, mode, fn)       — multi-store atomic transaction.
//
// Inside a tx callback, `fn` receives an object keyed by store name; each
// entry exposes get/put/del/iterate bound to that transaction.
//
// IMPORTANT: Inside a tx callback, only await the per-store wrapper methods.
// Awaiting an external promise (e.g. fetch) suspends the microtask queue
// long enough for IndexedDB to auto-commit the transaction — silent data
// loss. This is a standard IDB footgun, not a webgallery thing.

const DB_NAME = 'webgallery';
const DB_VERSION = 1;

// Centralized schema. db.js only declares store keying; concrete record
// shapes (validation, defaults) belong to the modules that own each store.
const SCHEMA = {
  config:        { keyPath: null },
  folders:       { keyPath: 'id', autoIncrement: true },
  sync_index:    { keyPath: 'path' },
  uploaded:      { keyPath: 'hash' },
  gallery_cache: { keyPath: 'key' },
};

let dbPromise = null;

export function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      // v0 → v1: create everything from SCHEMA.
      if (event.oldVersion < 1) {
        for (const [name, { keyPath, autoIncrement }] of Object.entries(SCHEMA)) {
          const opts = {};
          if (keyPath) opts.keyPath = keyPath;
          if (autoIncrement) opts.autoIncrement = true;
          db.createObjectStore(name, opts);
        }
      }
      // Future migrations append here.
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        // Another tab triggered an upgrade; close here and drop the cached
        // promise so the next open() re-opens at the new version.
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function req(idbRequest) {
  return new Promise((resolve, reject) => {
    idbRequest.onsuccess = () => resolve(idbRequest.result);
    idbRequest.onerror = () => reject(idbRequest.error);
  });
}

function wrapStore(store) {
  return {
    get: (key) => req(store.get(key)),
    put: (value, key) =>
      req(key === undefined ? store.put(value) : store.put(value, key)),
    del: (key) => req(store.delete(key)),
    iterate: (cb) =>
      new Promise((resolve, reject) => {
        const r = store.openCursor();
        r.onsuccess = () => {
          const cursor = r.result;
          if (!cursor) return resolve();
          if (cb(cursor.value, cursor.key) === false) return resolve();
          cursor.continue();
        };
        r.onerror = () => reject(r.error);
      }),
  };
}

export async function tx(stores, mode, fn) {
  const db = await open();
  const t = db.transaction(stores, mode);
  const ctx = {};
  for (const name of stores) ctx[name] = wrapStore(t.objectStore(name));

  let result;
  try {
    result = await fn(ctx);
  } catch (err) {
    try { t.abort(); } catch { /* already done */ }
    throw err;
  }

  await new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
  return result;
}

export const get = (store, key) =>
  tx([store], 'readonly', (t) => t[store].get(key));

export const put = (store, value, key) =>
  tx([store], 'readwrite', (t) => t[store].put(value, key));

export const del = (store, key) =>
  tx([store], 'readwrite', (t) => t[store].del(key));

export const iterate = (store, cb) =>
  tx([store], 'readonly', (t) => t[store].iterate(cb));
