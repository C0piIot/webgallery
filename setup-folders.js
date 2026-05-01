// Folders page. Drives lib/folders.js — the heavy logic lives there;
// this file orchestrates clicks and renders.

import './lib/register-sw.js';
import './lib/install.js';
import {
  addFolder,
  listFolders,
  removeFolder,
  ensurePermissions,
} from './lib/folders.js';
import { hasFsa, renderFsaExplainer } from './lib/capability.js';

// E2E injection hook. When the page is loaded with ?e2e=1, expose a
// helper that lets Playwright tests substitute showDirectoryPicker with
// a function that returns an OPFS subdirectory — a real
// FileSystemDirectoryHandle that is structured-cloneable (so addFolder's
// IDB persistence round-trips) and whose queryPermission always returns
// 'granted'. Not reachable without the URL param, so it's invisible in
// production loads.
if (new URL(location.href).searchParams.get('e2e') === '1') {
  globalThis.__test_inject_folders__ = async (name) => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getDirectoryHandle(name, { create: true });
    globalThis.showDirectoryPicker = async () => handle;
  };
}

const $ = (id) => document.getElementById(id);

const contentEl = $('content');
const addBtn = $('add-btn');
const addError = $('add-error');
const foldersEl = $('folders');
const emptyEl = $('empty');

function showError(msg) {
  addError.textContent = msg;
  addError.classList.remove('d-none');
}
function hideError() {
  addError.classList.add('d-none');
  addError.textContent = '';
}

async function queryState(handle, mode = 'read') {
  if (!handle?.queryPermission) return 'unknown';
  try {
    return await handle.queryPermission({ mode });
  } catch {
    return 'unknown';
  }
}

function badgeFor(state) {
  const span = document.createElement('span');
  span.classList.add('badge', 'ms-2');
  if (state === 'granted') {
    span.classList.add('bg-success');
    span.textContent = '✓ Granted';
  } else if (state === 'denied') {
    span.classList.add('bg-danger');
    span.textContent = '✗ Denied';
  } else {
    span.classList.add('bg-warning', 'text-dark');
    span.textContent = '⚠ Permission needed';
  }
  return span;
}

async function makeRow(folder) {
  const state = await queryState(folder.handle);

  const row = document.createElement('div');
  row.className =
    'list-group-item d-flex justify-content-between align-items-center gap-2 flex-wrap';

  const left = document.createElement('div');
  const label = document.createElement('strong');
  label.textContent = folder.label;
  left.appendChild(label);
  if (folder.handle?.name && folder.handle.name !== folder.label) {
    const name = document.createElement('small');
    name.className = 'text-muted ms-2';
    name.textContent = `(${folder.handle.name})`;
    left.appendChild(name);
  }
  left.appendChild(badgeFor(state));

  const right = document.createElement('div');
  right.className = 'btn-group btn-group-sm';
  if (state !== 'granted' && isFsaAvailable()) {
    const regrant = document.createElement('button');
    regrant.type = 'button';
    regrant.className = 'btn btn-outline-secondary';
    regrant.textContent = 'Re-grant';
    regrant.dataset.action = 'regrant';
    regrant.dataset.id = String(folder.id);
    right.appendChild(regrant);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-outline-danger';
  remove.textContent = 'Remove';
  remove.dataset.action = 'remove';
  remove.dataset.id = String(folder.id);
  right.appendChild(remove);

  row.appendChild(left);
  row.appendChild(right);
  return row;
}

async function render() {
  const folders = await listFolders();
  emptyEl.classList.toggle('d-none', folders.length > 0);
  const rows = await Promise.all(folders.map(makeRow));
  foldersEl.replaceChildren(...rows);
}

async function onAdd() {
  hideError();
  try {
    await addFolder();
    await render();
  } catch (err) {
    if (err?.name === 'AbortError') return; // user dismissed picker
    showError(err?.message ?? String(err));
  }
}

async function onRegrant(id) {
  const f = (await listFolders()).find((x) => x.id === id);
  if (!f) return;
  await ensurePermissions(f.handle);
  await render();
}

async function onRemove(id) {
  await removeFolder(id);
  await render();
}

(async function bootstrap() {
  if (!hasFsa()) {
    renderFsaExplainer(contentEl);
    return;
  }
  addBtn.addEventListener('click', onAdd);
  foldersEl.addEventListener('click', (e) => {
    const regrant = e.target.closest('[data-action="regrant"]');
    if (regrant) return onRegrant(Number(regrant.dataset.id));
    const remove = e.target.closest('[data-action="remove"]');
    if (remove) return onRemove(Number(remove.dataset.id));
  });
  await render();
})();
