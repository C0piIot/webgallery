// Bootstrap for index.html. Tab toggle, FSA gate, the Local-tab card
// grid driven live by the sync worker's BroadcastChannel events, and
// the Remote-tab gallery view backed by gallery_cache + ListObjectsV2.

import './lib/register-sw.js';
import './lib/install.js';
import { hasFsa, renderFsaExplainer } from './lib/capability.js';
import { loadConfig, hasConfig } from './lib/config.js';
import { createSyncController } from './lib/sync.js';
import { createBucketClient } from './lib/bucket.js';
import { reconcile } from './lib/remote-list.js';
import { keyFor } from './lib/upload.js';
import { listFolders } from './lib/folders.js';
import { isOnline, onChange as onConnectivityChange } from './lib/connectivity.js';
import * as db from './lib/db.js';

const VIDEO_RE = /\.(mp4|mov|webm|m4v|avi)$/i;

// Shared bucket client. Both tabs need one — Remote for ListObjectsV2 +
// thumbnails (and as a Local-thumb fallback). Built lazily on first
// use so the welcome redirect doesn't race against it.
let bucketClient = null;
let bucketPrefix = null;
async function ensureBucketClient() {
  if (bucketClient) return bucketClient;
  const config = await loadConfig();
  if (!config) return null;
  bucketClient = createBucketClient(config);
  bucketPrefix = config.prefix;
  return bucketClient;
}

// --- Local-disk preview resolution ---
//
// Local-tab thumbnails resolve to files on disk via the user's already-
// permissioned FileSystemDirectoryHandle. Avoids egress fees and works
// offline. Falls back to the bucket only when permission isn't granted
// at this moment (e.g. fresh tab open).

let folderCache = null;
async function getFolders() {
  if (folderCache) return folderCache;
  folderCache = await listFolders();
  return folderCache;
}

async function tryLocalObjectUrl(record) {
  if (!record?.path) return null;
  const folders = await getFolders();
  const folder = record.folderId != null
    ? folders.find((f) => f.id === record.folderId)
    : folders.find((f) => f.label === record.folderLabel);
  if (!folder?.handle) return null;
  // OPFS handles (used in e2e) don't expose queryPermission and are
  // always permitted; treat that case as granted.
  if (typeof folder.handle.queryPermission === 'function') {
    const state = await folder.handle.queryPermission({ mode: 'read' });
    if (state !== 'granted') return null;
  }
  let dir = folder.handle;
  const parts = record.path.split('/');
  const filename = parts.pop();
  try {
    for (const p of parts) dir = await dir.getDirectoryHandle(p);
    const fh = await dir.getFileHandle(filename);
    const file = await fh.getFile();
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

const objectUrls = new Map();
function trackObjectUrl(path, url) {
  const old = objectUrls.get(path);
  if (old && old !== url) URL.revokeObjectURL(old);
  objectUrls.set(path, url);
}
window.addEventListener('pagehide', () => {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
});

const TABS = ['local', 'remote'];

function showTab(name) {
  if (!TABS.includes(name)) name = 'local';
  for (const t of TABS) {
    document.getElementById(`tab-${t}`).classList.toggle('active', t === name);
    document.getElementById(`pane-${t}`).classList.toggle('active', t === name);
    document.getElementById(`pane-${t}`).classList.toggle('show', t === name);
  }
  const url = new URL(location.href);
  url.searchParams.set('tab', name);
  history.replaceState(null, '', url);
}

for (const t of TABS) {
  document.getElementById(`tab-${t}`).addEventListener('click', () => showTab(t));
}
showTab(new URL(location.href).searchParams.get('tab') || 'local');

// Welcome funnel: if no storage config exists, send the user to
// setup-storage with a flag the page reads to show a welcome banner.
// `replace` instead of `assign` so the back button doesn't bounce
// back to a useless gallery.
(async function welcomeRedirect() {
  if (!(await hasConfig())) {
    location.replace('./setup-storage.html?welcome=1');
    return;
  }
  setupDetailDialog();
  // FSA-missing path: replace the Local pane content with the standard
  // explainer. Remote tab keeps working regardless.
  if (!hasFsa()) {
    renderFsaExplainer(document.getElementById('pane-local'));
  } else {
    bootstrapLocalTab();
  }
  bootstrapRemoteTab();
})();

// --- Shared detail dialog ---
//
// The <dialog> element + its skeleton fields live in index.html. Both
// tabs build an opts bag and call openDetail; the dialog is shared so
// behavior stays consistent. Local opens it read-only (no delete);
// Remote provides a delete handler + an optional refine() that HEADs
// the bucket for richer metadata.

let currentDetailKey = null;

function setupDetailDialog() {
  const dialog = document.getElementById('detail-dialog');
  document.getElementById('detail-close')
    .addEventListener('click', () => dialog.close());
  document.getElementById('detail-close-bottom')
    .addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    currentDetailKey = null;
    const video = document.querySelector('#detail-media video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  });
}

async function openDetail({
  key, filename, size, capturedAt, sourcePath,
  deletable, onDelete, refine, localResolve,
}) {
  currentDetailKey = key;

  setText('detail-filename', filename);
  setText('detail-size', formatBytes(size));
  setText(
    'detail-captured',
    capturedAt ? new Date(capturedAt).toLocaleString() : '—',
  );
  setText('detail-source', sourcePath ?? '—');

  // Reset the delete button by cloning — the simplest way to drop any
  // listener bound by a previous openDetail call.
  const oldBtn = document.getElementById('detail-delete');
  const deleteBtn = oldBtn.cloneNode(true);
  oldBtn.parentNode.replaceChild(deleteBtn, oldBtn);
  deleteBtn.classList.toggle('d-none', !deletable);
  if (deletable) {
    deleteBtn.disabled = !isOnline();
    if (onDelete) {
      deleteBtn.addEventListener('click', () => onDelete(key, filename));
    }
  }

  await renderDetailMedia(key, filename, localResolve);
  document.getElementById('detail-dialog').showModal();

  if (refine && isOnline()) {
    refine(key)
      .then((updates) => {
        if (key !== currentDetailKey || !updates) return;
        if (updates.filename) setText('detail-filename', updates.filename);
        if (updates.capturedAt) {
          const d = new Date(updates.capturedAt);
          if (!Number.isNaN(d.getTime())) {
            setText('detail-captured', d.toLocaleString());
          }
        }
        if (updates.sourcePath) setText('detail-source', updates.sourcePath);
        if (typeof updates.size === 'number') {
          setText('detail-size', formatBytes(updates.size));
        }
      })
      .catch(() => { /* keep what we have */ });
  }
}

async function renderDetailMedia(key, filename, localResolve) {
  const container = document.getElementById('detail-media');
  container.replaceChildren();
  const isVideo = VIDEO_RE.test(filename);

  // Prefer the local file if the caller can resolve it. Works offline,
  // no egress fees, no signing.
  let src = null;
  if (localResolve) {
    try {
      src = await localResolve();
    } catch {
      src = null;
    }
  }

  if (!src) {
    const client = await ensureBucketClient();
    if (!isOnline() || !client) {
      container.appendChild(detailPlaceholder('Offline — connect to load preview'));
      return;
    }
    try {
      src = await client.presignGet(key);
    } catch {
      container.appendChild(detailPlaceholder('Could not sign URL'));
      return;
    }
  }

  if (isVideo) {
    const video = document.createElement('video');
    video.controls = true;
    video.src = src;
    video.style.width = '100%';
    video.style.height = '100%';
    container.appendChild(video);
  } else {
    const img = document.createElement('img');
    img.src = src;
    img.alt = filename;
    img.style.objectFit = 'contain';
    img.style.width = '100%';
    img.style.height = '100%';
    container.appendChild(img);
  }
}

function detailPlaceholder(text) {
  const div = document.createElement('div');
  div.className = 'd-flex align-items-center justify-content-center h-100 fs-5 text-muted';
  div.textContent = text;
  return div;
}

// --- Local tab ---

const BADGES = {
  pending:   { cls: ['bg-secondary'],         text: '⏳ Pending'   },
  hashing:   { cls: ['bg-secondary'],         text: '⏳ Hashing'   },
  uploading: { cls: ['bg-info', 'text-dark'], text: '⬆️ Uploading' },
  retrying:  { cls: ['bg-warning', 'text-dark'], text: '⏳ Retrying' },
  uploaded:  { cls: ['bg-success'],           text: '✅ Uploaded'  },
  errored:   { cls: ['bg-danger'],            text: '⚠️ Error'    },
};

function formatBytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function escapeText(s) {
  // textContent assignment is safe; we just need a string.
  return s == null ? '' : String(s);
}

async function bootstrapLocalTab() {
  const grid = document.getElementById('local-grid');
  const empty = document.getElementById('local-empty');
  const summary = document.getElementById('local-summary');
  const rewalkBtn = document.getElementById('local-rewalk');
  const retryBtn = document.getElementById('local-retry-errored');
  const offlinePill = document.getElementById('local-offline-pill');

  const controller = createSyncController();
  // Pre-fetch the bucket client so renderCard can presign thumbs for
  // already-uploaded items on the very first paint.
  let client = await ensureBucketClient();

  await refreshGrid();
  await wireControls();
  wireConnectivityLocal();
  wireGridClicks();
  subscribeBroadcast();

  async function refreshGrid() {
    const records = [];
    await db.iterate('sync_index', (r) => {
      records.push(r);
    });
    records.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    grid.replaceChildren(...records.map((r) => renderCard(r, client)));
    empty.classList.toggle('d-none', records.length > 0);
    updateSummary(records);
  }

  function wireGridClicks() {
    grid.addEventListener('click', async (e) => {
      const col = e.target.closest('.col[data-path]');
      if (!col) return;
      const record = await db.get('sync_index', col.dataset.path);
      // Only uploaded items have a bucket key to preview.
      if (!record || record.status !== 'uploaded' || !record.hash) return;
      if (!client) client = await ensureBucketClient();
      if (!client) return;
      const filename = record.path.split('/').pop();
      const key = keyFor(bucketPrefix, record.hash, filename);
      openDetail({
        key,
        filename,
        size: record.size,
        capturedAt: record.mtime,
        sourcePath: record.path,
        deletable: false,
        localResolve: () => tryLocalObjectUrl(record),
      });
    });
  }

  async function wireControls() {
    const ready = (await hasConfig()) && isOnline();
    rewalkBtn.disabled = !ready;
    retryBtn.disabled = !ready;
    rewalkBtn.addEventListener('click', () => {
      try {
        controller.rewalk();
      } catch (err) {
        // FSA gate failure should not happen here — we already checked.
        console.warn('rewalk failed:', err);
      }
    });
    retryBtn.addEventListener('click', async () => {
      const erroredPaths = [];
      await db.iterate('sync_index', (r) => {
        if (r.status === 'errored') erroredPaths.push(r.path);
      });
      for (const p of erroredPaths) controller.retry(p);
      try {
        controller.rewalk();
      } catch (err) {
        console.warn('rewalk after retry failed:', err);
      }
    });
  }

  function wireConnectivityLocal() {
    function syncUi() {
      const online = isOnline();
      offlinePill.classList.toggle('d-none', online);
      // Disable Re-walk + Retry while offline; the worker would just
      // pause waiting for connectivity to come back.
      hasConfig().then((ok) => {
        rewalkBtn.disabled = !ok || !online;
        retryBtn.disabled = !ok || !online;
      });
    }
    syncUi();
    onConnectivityChange(syncUi);
  }

  function subscribeBroadcast() {
    controller.on('*', (msg) => {
      if (msg.type === 'state') {
        if (msg.state === 'idle' && msg.reason === 'completed') {
          refreshGrid();
        } else if (msg.state === 'idle' && msg.reason === 'no-folders') {
          summary.textContent = 'No folders configured. Add one in Folders.';
        } else if (msg.state === 'idle' && msg.reason === 'no-config') {
          summary.textContent = 'No bucket configured. Set it up in Storage.';
        }
      } else if (msg.type === 'progress') {
        const phase = msg.phase === 'hashing' ? 'hashing' : 'uploading';
        ensureCard(msg.path);
        applyBadge(msg.path, phase);
      } else if (msg.type === 'file-retry-scheduled' || msg.type === 'file-retry') {
        applyBadge(msg.path, 'retrying', msg.error);
      } else if (msg.type === 'file-uploaded') {
        applyBadge(msg.path, 'uploaded');
        // Re-render this card so its thumb switches from the in-flight
        // placeholder to the bucket-presigned image.
        refreshCardThumb(msg.path);
      } else if (msg.type === 'file-error') {
        applyBadge(msg.path, 'errored', msg.error);
      } else if (msg.type === 'folder-error') {
        summary.textContent = `Folder ${msg.folder}: ${msg.error}`;
      }
    });
  }

  function ensureCard(path) {
    if (!grid.querySelector(`[data-path="${cssEscape(path)}"]`)) {
      // Create a stub card from minimal info; it'll fill in on the next
      // refreshGrid() (which fires on completion) with the rest.
      const stub = renderCard({ path, status: 'pending' }, client);
      grid.prepend(stub);
      empty.classList.add('d-none');
    }
  }

  async function refreshCardThumb(path) {
    const record = await db.get('sync_index', path);
    if (!record) return;
    const card = grid.querySelector(`.col[data-path="${cssEscape(path)}"]`);
    if (!card) return;
    if (!client) client = await ensureBucketClient();
    card.replaceWith(renderCard(record, client));
  }

  function applyBadge(path, key, errorMsg) {
    const card = grid.querySelector(`[data-path="${cssEscape(path)}"]`);
    if (!card) return;
    const badge = card.querySelector('[data-role="status"]');
    setBadge(badge, key, errorMsg);
  }

  function updateSummary(records) {
    const counts = { uploaded: 0, errored: 0, pending: 0 };
    for (const r of records) counts[r.status] = (counts[r.status] ?? 0) + 1;
    summary.textContent = records.length
      ? `${records.length} indexed · ${counts.uploaded} uploaded · ${counts.errored} errored`
      : '';
  }
}

function renderCard(record, client) {
  const filename = record.path?.split('/').pop() ?? record.path;
  const folder = record.folderLabel ?? '—';
  const date = record.mtime ? new Date(record.mtime).toLocaleDateString() : '—';
  const size = formatBytes(record.size);

  const col = document.createElement('div');
  col.className = 'col';
  col.dataset.path = record.path;
  if (record.status === 'uploaded') col.style.cursor = 'pointer';

  const card = document.createElement('div');
  card.className = 'card h-100';

  const thumb = document.createElement('div');
  thumb.className = 'ratio ratio-1x1 bg-light';
  thumb.dataset.role = 'thumb';
  renderLocalThumb(thumb, record, client);
  card.appendChild(thumb);

  const body = document.createElement('div');
  body.className = 'card-body p-2 small';

  const filenameEl = document.createElement('div');
  filenameEl.className = 'text-truncate fw-medium';
  filenameEl.textContent = escapeText(filename);
  filenameEl.title = escapeText(filename);
  body.appendChild(filenameEl);

  const folderEl = document.createElement('div');
  folderEl.className = 'text-muted text-truncate';
  folderEl.textContent = escapeText(folder);
  folderEl.title = escapeText(folder);
  body.appendChild(folderEl);

  const stats = document.createElement('div');
  stats.className = 'text-muted';
  stats.textContent = `${date} · ${size}`;
  body.appendChild(stats);

  card.appendChild(body);
  col.appendChild(card);
  return col;
}

function renderLocalThumb(thumbEl, record, client) {
  thumbEl.replaceChildren();
  const filename = record.path?.split('/').pop() ?? record.path ?? '';
  const isVideo = VIDEO_RE.test(filename);

  // .ratio > * forces position:absolute + 100%/100% on every direct
  // child, which would stretch the badge across the whole thumb. Wrap
  // the image + badge in a single inner layer so they're descendants
  // of that absolute container, free to size and position normally.
  const layer = document.createElement('div');
  thumbEl.appendChild(layer);

  // Always paint the badge — it stays in sync with status regardless
  // of whether the thumb resolves.
  const badge = document.createElement('span');
  badge.className = 'badge position-absolute top-0 end-0 m-1';
  badge.dataset.role = 'status';
  setBadge(badge, record.status, record.error);

  if (isVideo) {
    layer.appendChild(thumbPlaceholder('🎬'));
    layer.appendChild(badge);
    return;
  }

  // Optimistic <img>: resolve disk URL first, fall back to bucket
  // presign for uploaded items, and replace with a status placeholder
  // if both fail.
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = filename;
  img.style.objectFit = 'cover';
  img.style.width = '100%';
  img.style.height = '100%';
  layer.appendChild(img);
  layer.appendChild(badge);

  tryLocalObjectUrl(record)
    .then((url) => {
      if (url) {
        trackObjectUrl(record.path, url);
        img.src = url;
        return;
      }
      if (
        record.status === 'uploaded' && client && record.hash && bucketPrefix
      ) {
        const key = keyFor(bucketPrefix, record.hash, filename);
        return client.presignGet(key)
          .then((src) => { img.src = src; })
          .catch((err) => {
            console.warn('local preview presign failed:', key, err);
            replaceWithPlaceholder(layer, badge, record.status);
          });
      }
      replaceWithPlaceholder(layer, badge, record.status);
    });
}

function replaceWithPlaceholder(layer, badge, status) {
  layer.replaceChildren();
  layer.appendChild(thumbPlaceholder(statusEmoji(status)));
  layer.appendChild(badge);
}

function thumbPlaceholder(emoji) {
  const div = document.createElement('div');
  div.className = 'd-flex align-items-center justify-content-center fs-1 h-100 w-100';
  div.textContent = emoji;
  return div;
}

function statusEmoji(status) {
  if (status === 'uploaded') return '✅';
  if (status === 'errored') return '⚠️';
  return '⏳';
}

function setBadge(badge, key, errorMsg) {
  const def = BADGES[key] ?? BADGES.pending;
  // Reset classes — keep base 'badge' class only.
  badge.className = 'badge';
  for (const c of def.cls) badge.classList.add(c);
  badge.textContent = def.text;
  badge.title = errorMsg ? String(errorMsg) : '';
}

// CSS.escape is the standard way; fall back to a regex in tests / older
// browsers (we target modern Chrome so this is mostly defensive).
function cssEscape(s) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

// --- Remote tab ---

const REMOTE_PAGE = 30;

async function bootstrapRemoteTab() {
  const grid = document.getElementById('remote-grid');
  const empty = document.getElementById('remote-empty');
  const summary = document.getElementById('remote-summary');
  const sentinel = document.getElementById('remote-sentinel');
  const refreshBtn = document.getElementById('remote-refresh');
  const offlinePill = document.getElementById('remote-offline-pill');

  let allRecords = [];
  let rendered = 0;
  let refreshing = false;
  const headCache = new Map();
  let client = await ensureBucketClient();

  await initialRender();
  setupInfiniteScroll();
  wireConnectivity();
  wireRefresh();
  wireGridClicks();
  refreshBtn.disabled = !client || !isOnline();
  // Auto-reconcile on first open if online + configured.
  if (isOnline() && client) {
    runReconcile();
  }

  async function initialRender() {
    allRecords = [];
    await db.iterate('gallery_cache', (r) => allRecords.push(r));
    sortRecords();
    grid.replaceChildren();
    rendered = 0;
    renderNextBatch();
    updateEmpty();
    updateSummary();
  }

  function sortRecords() {
    allRecords.sort((a, b) => {
      const ka = a.lastModified ?? '';
      const kb = b.lastModified ?? '';
      return ka < kb ? 1 : ka > kb ? -1 : 0;
    });
  }

  function renderNextBatch() {
    if (!client && allRecords.length > 0) {
      // Cards need a client to presign thumbs; if no config yet, wait.
      // Render placeholder cards so the grid still shows something.
    }
    const end = Math.min(rendered + REMOTE_PAGE, allRecords.length);
    const frag = document.createDocumentFragment();
    for (let i = rendered; i < end; i++) {
      frag.appendChild(renderRemoteCard(allRecords[i], client));
    }
    grid.appendChild(frag);
    rendered = end;
  }

  function setupInfiniteScroll() {
    if (!('IntersectionObserver' in globalThis)) return;
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && rendered < allRecords.length) {
          renderNextBatch();
        }
      }
    }, { rootMargin: '200px' });
    io.observe(sentinel);
  }

  function updateEmpty() {
    empty.classList.toggle('d-none', allRecords.length > 0);
  }

  function updateSummary(extra) {
    const base = `${allRecords.length} object${allRecords.length === 1 ? '' : 's'}`;
    summary.textContent = extra ? `${base} · ${extra}` : base;
  }

  function wireConnectivity() {
    function syncOfflineUi() {
      const online = isOnline();
      offlinePill.classList.toggle('d-none', online);
      refreshBtn.disabled = !online || !client;
    }
    syncOfflineUi();
    onConnectivityChange((online) => {
      syncOfflineUi();
      if (online && client) runReconcile();
    });
  }

  function wireRefresh() {
    refreshBtn.addEventListener('click', () => runReconcile());
  }

  async function runReconcile() {
    if (refreshing) return;
    if (!client) {
      client = await ensureBucketClient();
      if (!client) return;
    }
    refreshing = true;
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing…';
    summary.textContent = 'Refreshing…';
    try {
      await reconcile(client, bucketPrefix, db);
      await initialRender();
      updateSummary('refreshed just now');
    } catch (err) {
      updateSummary(`refresh failed: ${err?.message ?? err}`);
    } finally {
      refreshing = false;
      refreshBtn.textContent = 'Refresh';
      refreshBtn.disabled = !isOnline() || !client;
    }
  }

  function wireGridClicks() {
    grid.addEventListener('click', (e) => {
      const col = e.target.closest('.col[data-key]');
      if (!col) return;
      const record = allRecords.find((r) => r.key === col.dataset.key);
      if (!record) return;
      const filename = record.key.split('/').pop();
      openDetail({
        key: record.key,
        filename,
        size: record.size,
        capturedAt: record.lastModified,
        sourcePath: undefined,
        deletable: true,
        onDelete: handleDelete,
        refine: remoteRefine,
      });
    });
  }

  async function remoteRefine(key) {
    let head = headCache.get(key);
    if (!head) {
      head = await client.head(key);
      headCache.set(key, head);
    }
    const meta = head.metadata ?? {};
    return {
      filename: meta.filename,
      capturedAt: meta['captured-at'],
      sourcePath: meta['source-path'],
      size: typeof head.size === 'number' ? head.size : undefined,
    };
  }

  async function handleDelete(key, filename) {
    if (!confirm(`Delete ${filename}? This is permanent.`)) return;
    try {
      await client.delete(key);
      await db.del('gallery_cache', key);
      headCache.delete(key);
      document.getElementById('detail-dialog').close();
      grid.querySelector(`[data-key="${cssEscape(key)}"]`)?.remove();
      allRecords = allRecords.filter((r) => r.key !== key);
      rendered = Math.min(rendered, allRecords.length);
      updateEmpty();
      updateSummary();
    } catch (err) {
      alert(`Delete failed: ${err?.message ?? err}`);
    }
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function renderRemoteCard(record, client) {
  const filename = record.key.split('/').pop();
  const isVideo = /\.(mp4|mov|webm|m4v|avi)$/i.test(filename);

  const col = document.createElement('div');
  col.className = 'col';
  col.dataset.key = record.key;
  col.style.cursor = 'pointer';

  const card = document.createElement('div');
  card.className = 'card h-100';

  const thumb = document.createElement('div');
  thumb.className = 'ratio ratio-1x1 bg-light';
  if (isVideo) {
    const placeholder = document.createElement('div');
    placeholder.className = 'd-flex align-items-center justify-content-center fs-1';
    placeholder.textContent = '🎬';
    thumb.appendChild(placeholder);
  } else if (client) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = filename;
    img.style.objectFit = 'cover';
    img.style.width = '100%';
    img.style.height = '100%';
    client.presignGet(record.key).then((src) => {
      img.src = src;
    }).catch((err) => {
      console.warn('presign failed for', record.key, err);
    });
    thumb.appendChild(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'd-flex align-items-center justify-content-center fs-1';
    placeholder.textContent = '🖼️';
    thumb.appendChild(placeholder);
  }
  card.appendChild(thumb);

  const meta = document.createElement('div');
  meta.className = 'card-body p-2 small text-muted';
  const date = record.lastModified
    ? new Date(record.lastModified).toLocaleDateString()
    : '—';
  meta.textContent = `${date} · ${formatBytes(record.size)}`;
  card.appendChild(meta);

  col.appendChild(card);
  return col;
}
