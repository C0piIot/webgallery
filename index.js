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
import { isOnline, onChange as onConnectivityChange } from './lib/connectivity.js';
import * as db from './lib/db.js';

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
  // FSA-missing path: replace the Local pane content with the standard
  // explainer. Remote tab keeps working regardless.
  if (!hasFsa()) {
    renderFsaExplainer(document.getElementById('pane-local'));
  } else {
    bootstrapLocalTab();
  }
  bootstrapRemoteTab();
})();

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

  await refreshGrid();
  await wireControls();
  wireConnectivityLocal();
  subscribeBroadcast();

  async function refreshGrid() {
    const records = [];
    await db.iterate('sync_index', (r) => {
      records.push(r);
    });
    records.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    grid.replaceChildren(...records.map(renderCard));
    empty.classList.toggle('d-none', records.length > 0);
    updateSummary(records);
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
      const stub = renderCard({ path, status: 'pending' });
      grid.prepend(stub);
      empty.classList.add('d-none');
    }
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

function renderCard(record) {
  const filename = record.path?.split('/').pop() ?? record.path;
  const folder = record.folderLabel ?? '—';
  const date = record.mtime ? new Date(record.mtime).toLocaleDateString() : '—';
  const size = formatBytes(record.size);

  const col = document.createElement('div');
  col.className = 'col';
  col.dataset.path = record.path;

  const card = document.createElement('div');
  card.className = 'card h-100';

  const body = document.createElement('div');
  body.className = 'card-body p-3';

  const head = document.createElement('div');
  head.className = 'd-flex justify-content-between align-items-start gap-2';

  const title = document.createElement('h6');
  title.className = 'card-title mb-1 text-truncate';
  title.textContent = escapeText(filename);
  title.title = escapeText(filename);

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.dataset.role = 'status';

  head.appendChild(title);
  head.appendChild(badge);

  const meta = document.createElement('div');
  meta.className = 'text-muted small mb-0';

  const folderEl = document.createElement('div');
  folderEl.className = 'text-truncate';
  folderEl.textContent = escapeText(folder);
  folderEl.title = escapeText(folder);

  const stats = document.createElement('div');
  stats.textContent = `${date} · ${size}`;

  meta.appendChild(folderEl);
  meta.appendChild(stats);

  body.appendChild(head);
  body.appendChild(meta);
  card.appendChild(body);
  col.appendChild(card);

  setBadge(badge, record.status, record.error);
  return col;
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
  let client = null;
  let prefix = null;
  let refreshing = false;

  await initialRender();
  setupInfiniteScroll();
  wireConnectivity();
  wireRefresh();
  wireDetailDialog();
  await maybeBuildClient();
  // Auto-reconcile on first open if online + configured.
  if (isOnline() && client) {
    runReconcile();
  }

  async function maybeBuildClient() {
    if (!(await hasConfig())) return;
    const config = await loadConfig();
    client = createBucketClient(config);
    prefix = config.prefix;
    refreshBtn.disabled = !isOnline();
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
      await maybeBuildClient();
      if (!client) return;
    }
    refreshing = true;
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing…';
    summary.textContent = 'Refreshing…';
    try {
      await reconcile(client, prefix, db);
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

  // --- Detail view (lives inside bootstrapRemoteTab so it shares
  //     `client`, `allRecords`, `rendered`, updateEmpty, updateSummary). ---

  let currentDetailKey = null;
  const headCache = new Map();

  function wireDetailDialog() {
    // Card click delegation.
    grid.addEventListener('click', (e) => {
      const col = e.target.closest('.col[data-key]');
      if (!col) return;
      openDetail(col.dataset.key);
    });

    const dialog = document.getElementById('detail-dialog');
    document.getElementById('detail-close').addEventListener('click', () => dialog.close());
    document.getElementById('detail-close-bottom').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => {
      currentDetailKey = null;
      // Stop any video playback when the dialog closes.
      const video = document.querySelector('#detail-media video');
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
    });

    document.getElementById('detail-delete').addEventListener('click', onDelete);
  }

  async function openDetail(key) {
    const record = allRecords.find((r) => r.key === key);
    if (!record) return;
    currentDetailKey = key;

    const filenameFromKey = key.split('/').pop();
    setText('detail-filename', filenameFromKey);
    setText('detail-size', formatBytes(record.size));
    setText(
      'detail-captured',
      record.lastModified
        ? new Date(record.lastModified).toLocaleString()
        : '—',
    );
    setText('detail-source', '—');

    document.getElementById('detail-delete').disabled = !isOnline() || !client;

    await renderDetailMedia(record);
    document.getElementById('detail-dialog').showModal();

    // Async: HEAD for x-amz-meta-* and refine displayed metadata.
    if (isOnline() && client) {
      refineFromHead(key, record).catch(() => { /* keep what we have */ });
    }
  }

  async function renderDetailMedia(record) {
    const container = document.getElementById('detail-media');
    container.replaceChildren();
    const filename = record.key.split('/').pop();
    const isVideo = /\.(mp4|mov|webm|m4v|avi)$/i.test(filename);

    if (!isOnline() || !client) {
      const div = document.createElement('div');
      div.className =
        'd-flex align-items-center justify-content-center h-100 fs-5 text-muted';
      div.textContent = 'Offline — connect to load preview';
      container.appendChild(div);
      return;
    }

    let src;
    try {
      src = await client.presignGet(record.key);
    } catch {
      const div = document.createElement('div');
      div.className =
        'd-flex align-items-center justify-content-center h-100 fs-5 text-muted';
      div.textContent = 'Could not sign URL';
      container.appendChild(div);
      return;
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

  async function refineFromHead(key, record) {
    if (key !== currentDetailKey) return;
    let head = headCache.get(key);
    if (!head) {
      head = await client.head(key);
      headCache.set(key, head);
    }
    if (key !== currentDetailKey) return;
    const meta = head.metadata ?? {};
    if (meta.filename) setText('detail-filename', meta.filename);
    if (meta['captured-at']) {
      const d = new Date(meta['captured-at']);
      if (!Number.isNaN(d.getTime())) {
        setText('detail-captured', d.toLocaleString());
      }
    }
    if (meta['source-path']) setText('detail-source', meta['source-path']);
    // Prefer the HEAD-reported size if it differs (rare).
    if (typeof head.size === 'number') {
      setText('detail-size', formatBytes(head.size));
    }
  }

  async function onDelete() {
    const key = currentDetailKey;
    if (!key) return;
    const filename = key.split('/').pop();
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
