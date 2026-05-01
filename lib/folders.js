// FSA handle persistence + permission re-grant.
//
// FileSystemDirectoryHandles are structured-cloneable so they survive a
// page reload via IndexedDB, but their permission grants are session-
// scoped — every page-load that wants to use a stored handle must
// re-call ensurePermissions(handle) from a user-gesture context.
//
// All persistence goes through lib/db.js's `folders` object store
// (keyPath: 'id', autoIncrement). Records are { id, label, handle }.

import * as db from './db.js';

const STORE = 'folders';

export function isFsaAvailable() {
  return typeof globalThis.showDirectoryPicker === 'function';
}

export async function addFolder(label) {
  if (!isFsaAvailable()) {
    throw new Error('File System Access API is not available in this browser');
  }
  const handle = await globalThis.showDirectoryPicker({ mode: 'read' });
  const trimmed = label?.trim();
  const record = { label: trimmed || handle.name, handle };
  const id = await db.put(STORE, record);
  return { id, ...record };
}

export async function listFolders() {
  const out = [];
  await db.iterate(STORE, (v) => {
    out.push(v);
  });
  return out;
}

export async function removeFolder(id) {
  await db.del(STORE, id);
}

export async function ensurePermissions(handle, mode = 'read') {
  if (!handle || typeof handle.queryPermission !== 'function') return false;
  const opts = { mode };
  let state = await handle.queryPermission(opts);
  if (state === 'granted') return true;
  if (typeof handle.requestPermission === 'function') {
    state = await handle.requestPermission(opts);
  }
  return state === 'granted';
}
