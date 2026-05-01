// Bootstrap for index.html. Tab toggle, FSA gate, and the Local-tab
// card grid driven live by the sync worker's BroadcastChannel events.
// The Remote tab is still a placeholder until #18.

import './lib/register-sw.js';
import { hasFsa, renderFsaExplainer } from './lib/capability.js';
import { hasConfig } from './lib/config.js';
import { createSyncController } from './lib/sync.js';
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

// FSA-missing path: replace the Local pane content with the standard
// explainer and stop. Remote tab keeps working.
if (!hasFsa()) {
  renderFsaExplainer(document.getElementById('pane-local'));
} else {
  bootstrapLocalTab();
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

  const controller = createSyncController();

  await refreshGrid();
  await wireControls();
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
    const ready = await hasConfig();
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

  function subscribeBroadcast() {
    controller.on('*', (msg) => {
      if (msg.type === 'state') {
        if (msg.state === 'idle' && msg.reason === 'completed') {
          // Refresh card statuses from sync_index in case any uploads
          // updated while we weren't listening for the specific event.
          refreshGrid();
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
