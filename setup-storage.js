// Storage setup form. Reads/writes via lib/config.js, exercises the live
// bucket via lib/bucket.js for the "Test connection" button. The page
// is intentionally FSA-independent (per docs/architecture.md per-surface
// table) — it never calls into lib/folders.js.

import './lib/register-sw.js';
import './lib/install.js';
import {
  loadConfig,
  saveConfig,
  validateConfig,
  defaultPathStyle,
  ConfigError,
} from './lib/config.js';
import { createBucketClient, BucketError } from './lib/bucket.js';
import { hashFile } from './lib/hash.js';
import { uploadFile, keyFor } from './lib/upload.js';

// E2E hooks. Only reachable when the page is loaded with ?e2e=1, so
// they never appear in production loads. Used by e2e/upload.spec.js.
if (new URL(location.href).searchParams.get('e2e') === '1') {
  globalThis.__test_upload__ = async ({
    name, content, byteCount, fill = 0xab, config, opts = {},
  }) => {
    let bytes;
    if (typeof byteCount === 'number') {
      // Generate in-page to avoid large-data IPC over Playwright.
      bytes = new Uint8Array(byteCount).fill(fill);
    } else if (typeof content === 'string') {
      bytes = new TextEncoder().encode(content);
    } else {
      bytes = new Uint8Array(content);
    }
    const file = new Blob([bytes], { type: opts.contentType ?? '' });
    const hash = await hashFile(file);
    const entry = {
      path: opts.path ?? `e2e/${name}`,
      name,
      size: file.size,
      hash,
      file,
      capturedAt: opts.capturedAt,
    };
    const client = createBucketClient(config);
    const result = await uploadFile(client, entry, {
      prefix: opts.prefix ?? config.prefix,
      threshold: opts.threshold,
      partSize: opts.partSize,
    });
    return { result, key: keyFor(opts.prefix ?? config.prefix, hash, name) };
  };

  globalThis.__test_head__ = async ({ key, config }) => {
    const client = createBucketClient(config);
    return client.head(key);
  };

  globalThis.__test_delete__ = async ({ key, config }) => {
    const client = createBucketClient(config);
    return client.delete(key);
  };

  // Helpers for the sync e2e: persist config + folder handles, then run
  // a full sync against MinIO and resolve when the worker reports
  // completion.
  globalThis.__test_save_config__ = async (config) => {
    const { saveConfig, clearConfig } = await import('./lib/config.js');
    await clearConfig();
    await saveConfig(config);
  };

  globalThis.__test_seed_folder__ = async ({ folderName, files }) => {
    // Build an OPFS subdirectory and write each file's contents into it.
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry(folderName, { recursive: true });
    } catch {
      /* fresh */
    }
    const folder = await root.getDirectoryHandle(folderName, { create: true });
    for (const { name, content } of files) {
      const fh = await folder.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(
        typeof content === 'string' ? content : new Uint8Array(content),
      );
      await w.close();
    }
    // Wipe any folders left from a previous run, then register this one.
    const { listFolders, removeFolder, addFolder } = await import(
      './lib/folders.js'
    );
    for (const f of await listFolders()) await removeFolder(f.id);
    globalThis.showDirectoryPicker = async () => folder;
    await addFolder(folderName);
  };

  globalThis.__test_clear_sync_index__ = async () => {
    const db = await import('./lib/db.js');
    await db.tx(['sync_index'], 'readwrite', async (t) => {
      const keys = [];
      await t.sync_index.iterate((v) => {
        keys.push(v.path);
      });
      for (const k of keys) await t.sync_index.del(k);
    });
  };

  globalThis.__test_sync_run__ = async () => {
    const { createSyncController } = await import('./lib/sync.js');
    const controller = createSyncController();
    const events = [];
    return new Promise((resolve, reject) => {
      const ch = new BroadcastChannel('webgallery:sync');
      const timeout = setTimeout(() => {
        ch.close();
        controller.stop();
        reject(new Error('sync timed out'));
      }, 30_000);
      ch.onmessage = (e) => {
        events.push(e.data);
        if (
          e.data.type === 'state' &&
          e.data.state === 'idle' &&
          e.data.reason === 'completed'
        ) {
          clearTimeout(timeout);
          ch.close();
          controller.stop();
          resolve(events);
        }
      };
      controller.start();
    });
  };
}

const PRESETS = {
  aws:    { endpoint: 'https://s3.amazonaws.com',                       pathStyle: false },
  r2:     { endpoint: 'https://<account>.r2.cloudflarestorage.com',     pathStyle: false },
  b2:     { endpoint: 'https://s3.<region>.backblazeb2.com',            pathStyle: false },
  minio:  { endpoint: 'http://localhost:9000',                          pathStyle: true  },
  custom: { endpoint: '',                                               pathStyle: true  },
};

const PRESET_ENDPOINTS = new Set(
  Object.values(PRESETS).map((p) => p.endpoint).filter(Boolean),
);

const $ = (id) => document.getElementById(id);

const form = $('storage-form');
const providerEl = $('provider');
const endpointEl = $('endpoint');
const pathStyleEl = $('pathStyle');
const testBtn = $('test-btn');
const resultEl = $('result');

const FIELDS = [
  'endpoint',
  'region',
  'bucket',
  'prefix',
  'accessKeyId',
  'secretAccessKey',
];

function readForm() {
  const c = {};
  for (const f of FIELDS) c[f] = $(f).value;
  c.pathStyle = pathStyleEl.checked;
  return c;
}

function applyConfigToForm(c) {
  for (const f of FIELDS) $(f).value = c[f] ?? '';
  pathStyleEl.checked = !!c.pathStyle;
}

function clearErrors() {
  for (const f of FIELDS) {
    const input = $(f);
    input.classList.remove('is-invalid');
    const slot = form.querySelector(`[data-error-for="${f}"]`);
    if (slot) slot.textContent = '';
  }
}

function applyErrors(errors) {
  clearErrors();
  for (const { field, message } of errors) {
    const input = $(field);
    if (input) input.classList.add('is-invalid');
    const slot = form.querySelector(`[data-error-for="${field}"]`);
    if (slot) slot.textContent = message;
  }
}

const resultPane = {
  clear: () => {
    resultEl.className = 'd-none';
    resultEl.textContent = '';
  },
  info: (msg) => set('alert alert-secondary mt-3', msg),
  success: (msg) => set('alert alert-success mt-3', msg),
  error: (msg) => set('alert alert-danger mt-3', msg),
};
function set(cls, msg) {
  resultEl.className = cls;
  resultEl.textContent = msg;
}

function applyPreset(name, { force = false } = {}) {
  const preset = PRESETS[name];
  if (!preset) return;
  // Don't clobber values the user has typed: only fill if empty or
  // matches one of the known preset endpoints.
  if (force || !endpointEl.value || PRESET_ENDPOINTS.has(endpointEl.value)) {
    endpointEl.value = preset.endpoint;
  }
  if (force || !endpointEl.value || PRESET_ENDPOINTS.has(endpointEl.value)) {
    pathStyleEl.checked = preset.pathStyle;
  }
}

function guessProvider(endpoint) {
  if (!endpoint) return 'custom';
  try {
    const host = new URL(endpoint).host;
    if (/(^|\.)amazonaws\.com$/i.test(host)) return 'aws';
    if (/(^|\.)r2\.cloudflarestorage\.com$/i.test(host)) return 'r2';
    if (/(^|\.)backblazeb2\.com$/i.test(host)) return 'b2';
    if (/^localhost(:|$)/i.test(host) || /^127\.0\.0\.1(:|$)/.test(host)) {
      return 'minio';
    }
  } catch {
    /* fall through */
  }
  return 'custom';
}

async function onTest() {
  resultPane.clear();
  const c = readForm();
  const errors = validateConfig(c);
  if (errors.length) {
    applyErrors(errors);
    return;
  }
  clearErrors();
  if (typeof c.pathStyle !== 'boolean') c.pathStyle = defaultPathStyle(c.endpoint);

  resultPane.info('Testing connection…');
  testBtn.disabled = true;
  try {
    const client = createBucketClient(c);
    await client.list({ maxKeys: 1 });
    resultPane.success('Connection OK.');
  } catch (err) {
    if (err instanceof BucketError) {
      resultPane.error(`${err.status} ${err.code}: ${err.message}`);
    } else {
      resultPane.error(err?.message ?? String(err));
    }
  } finally {
    testBtn.disabled = false;
  }
}

async function onSave(e) {
  e.preventDefault();
  resultPane.clear();
  try {
    await saveConfig(readForm());
    clearErrors();
    resultPane.success('Saved.');
  } catch (err) {
    if (err instanceof ConfigError) applyErrors(err.errors);
    else resultPane.error(err?.message ?? String(err));
  }
}

(async function bootstrap() {
  const existing = await loadConfig();
  if (existing) {
    applyConfigToForm(existing);
    providerEl.value = guessProvider(existing.endpoint);
  } else {
    providerEl.value = 'custom';
  }
  providerEl.addEventListener('change', () => applyPreset(providerEl.value));
  testBtn.addEventListener('click', onTest);
  form.addEventListener('submit', onSave);
})();
