# Plan — Issue #15: Sync controller + BroadcastChannel + lib/connectivity.js

## Context

The biggest issue in M4. Up to now we have three pure modules — walker (#12), hasher (#13), uploader (#14) — and one library each for state (db, config, folders, capability, bucket). #15 ties them together into a working sync engine: a Web Worker that walks the user's configured folders, hashes new/changed files, uploads them, and writes per-file state to `sync_index`. A controller running on the main page owns the worker's lifecycle and routes online/offline transitions, FSA gating (#11), and user-initiated pause/resume/retry into worker commands. Status flows out via a `BroadcastChannel` so the Local tab (#17) can subscribe without coupling.

After this lands the upload pipeline is fully exercisable from a real browser session — the Local tab in #17 just becomes a UI on top, and #16 layers retry/backoff onto the worker's per-file failure path.

## Approach

### 1. `lib/connectivity.js` — small online/offline helper

```js
let registered = false;
const subscribers = new Set();

function ensureRegistered() {
  if (registered || typeof globalThis.addEventListener !== 'function') return;
  registered = true;
  globalThis.addEventListener('online',  () => notify(true));
  globalThis.addEventListener('offline', () => notify(false));
}

function notify(online) {
  for (const cb of subscribers) {
    try { cb(online); } catch { /* never block other subscribers */ }
  }
}

export function isOnline() {
  if (typeof navigator !== 'undefined' && 'onLine' in navigator) {
    return navigator.onLine;
  }
  return true;
}

export function onChange(cb) {
  ensureRegistered();
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function _resetForTesting() {
  registered = false;
  subscribers.clear();
}
```

Lazy registration — no module-level side effects until the first `onChange` call. Test resets via `_resetForTesting`.

### 2. Module split: controller vs worker

Two files because they live in different JS realms:

- **`lib/sync.js`** — runs on the main page. Owns the `Worker` instance. Listens on `BroadcastChannel` and re-fans events to in-page subscribers. Subscribes to `connectivity.onChange` and forwards to the worker as pause/resume commands. Exposes `start / stop / pause / resume / retry / on`.
- **`lib/sync-worker.js`** — runs inside the Web Worker. Loads config + folders + bucket client itself (the worker has its own IndexedDB connection and SigV4 signer). Walks → hashes → uploads → writes `sync_index`, broadcasting progress on the channel. Listens for command postMessages from the controller.

Both communicate via two channels:

- **postMessage** (controller ↔ worker, command/control): `{ type: 'start' | 'pause' | 'resume' | 'stop' | 'retry', payload? }`. Asymmetric — the worker rarely needs to talk *back* to the controller; everything observable goes on the BroadcastChannel.
- **BroadcastChannel** named `webgallery:sync` (worker → all open pages): fan-out events. Includes the controller (which re-fans to its in-page subscribers) AND the Local tab (#17) directly. Letting the Local tab subscribe without going through the controller keeps the UI ↔ worker dependency one-way.

### 3. BroadcastChannel event shapes

```js
{ type: 'state',         state: 'idle' | 'running' | 'paused' | 'stopped',
                         reason?: 'no-config' | 'no-folders' | 'completed' | 'offline' | 'paused' }
{ type: 'walking',       folder: <label>, count: <number-emitted-so-far> }
{ type: 'progress',      path, phase: 'hashing' | 'uploading',
                         uploaded?: <bytes>, total?: <bytes> }
{ type: 'file-uploaded', path, hash, key, skipped: <boolean> }
{ type: 'file-error',    path, error: <message> }
{ type: 'folder-error',  folder: <label>, error: <message> }
```

`state` events drive the controller's status indicator and the Local tab's "syncing | paused | offline | idle" header. `progress` is for the live-status badges in #17. `file-uploaded` / `file-error` close out a single file — they're what populate the Local tab's row badges.

### 4. Controller — `lib/sync.js`

```js
import { hasFsa } from './capability.js';
import { isOnline, onChange } from './connectivity.js';

const CHANNEL = 'webgallery:sync';

export function createSyncController({ workerUrl } = {}) {
  let worker = null;
  let channel = null;
  let unsubConnectivity = null;
  const listeners = new Map(); // type -> Set<cb>
  const allListeners = new Set();
  let started = false;

  function send(type, payload) {
    worker?.postMessage({ type, ...(payload ?? {}) });
  }

  function emit(msg) {
    for (const cb of allListeners) cb(msg);
    const set = listeners.get(msg.type);
    if (set) for (const cb of set) cb(msg);
  }

  function start() {
    if (!hasFsa()) {
      throw new Error('FSA not available; cannot start sync');
    }
    if (started) return;
    started = true;

    const url = workerUrl ?? new URL('./sync-worker.js', import.meta.url);
    worker = new Worker(url, { type: 'module' });

    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e) => emit(e.data);

    unsubConnectivity = onChange((online) => {
      send(online ? 'resume' : 'pause');
    });

    send('start', { online: isOnline() });
  }

  function stop() {
    if (!started) return;
    send('stop');
    worker?.terminate();
    worker = null;
    channel?.close();
    channel = null;
    unsubConnectivity?.();
    unsubConnectivity = null;
    started = false;
  }

  function pause()         { send('pause'); }
  function resume()        { send('resume'); }
  function retry(path)     { send('retry', { path }); }

  function on(type, cb) {
    if (type === '*') {
      allListeners.add(cb);
      return () => allListeners.delete(cb);
    }
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(cb);
    return () => listeners.get(type).delete(cb);
  }

  return { start, stop, pause, resume, retry, on };
}
```

`workerUrl` is injectable for tests (so we can substitute a mock Worker). Default uses `import.meta.url`.

### 5. Worker — `lib/sync-worker.js`

Two-layer file: a pure async function (`runSync`) that's testable in isolation, plus the postMessage glue.

```js
import { walkFolder } from './walker.js';
import { hashFile } from './hash.js';
import { uploadFile } from './upload.js';
import { createBucketClient } from './bucket.js';
import { loadConfig } from './config.js';
import { listFolders, ensurePermissions } from './folders.js';
import * as db from './db.js';

const CHANNEL = 'webgallery:sync';

let state = 'idle';   // 'idle' | 'running' | 'paused' | 'stopped'
let pauseGate = null; // Promise that resolves when state goes back to running

const channel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel(CHANNEL)
  : null;

function broadcast(msg) { channel?.postMessage(msg); }

function setState(next, reason) {
  state = next;
  broadcast({ type: 'state', state, ...(reason ? { reason } : {}) });
}

async function gate() {
  // Throws if stopped; awaits if paused; otherwise returns immediately.
  if (state === 'stopped') throw new Error('stopped');
  while (state === 'paused') {
    await pauseGate;
    if (state === 'stopped') throw new Error('stopped');
  }
}

function pauseLoop()  { state = 'paused'; pauseGate = new Promise(() => {}); broadcast({ type: 'state', state, reason: 'paused' }); }
function resumeLoop() {
  if (state !== 'paused') return;
  state = 'running';
  // Replace the unresolved gate with a resolved one to wake awaiters.
  pauseGate = Promise.resolve();
  broadcast({ type: 'state', state });
}

export async function runSync(deps = {}) {
  const _loadConfig    = deps.loadConfig    ?? loadConfig;
  const _listFolders   = deps.listFolders   ?? listFolders;
  const _ensurePerms   = deps.ensurePermissions ?? ensurePermissions;
  const _walkFolder    = deps.walkFolder    ?? walkFolder;
  const _hashFile      = deps.hashFile      ?? hashFile;
  const _uploadFile    = deps.uploadFile    ?? uploadFile;
  const _createClient  = deps.createBucketClient ?? createBucketClient;
  const _db            = deps.db            ?? db;

  setState('running');

  const config = await _loadConfig();
  if (!config) { setState('idle', 'no-config'); return; }
  const folders = await _listFolders();
  if (!folders.length) { setState('idle', 'no-folders'); return; }

  const client = _createClient(config);

  for (const folder of folders) {
    await gate();
    const granted = await _ensurePerms(folder.handle).catch(() => false);
    if (!granted) {
      broadcast({ type: 'folder-error', folder: folder.label, error: 'permission-denied' });
      continue;
    }

    let count = 0;
    for await (const batch of _walkFolder(folder.handle)) {
      for (const entry of batch) {
        await gate();
        await processEntry(entry, folder, config, client, { _db, _hashFile, _uploadFile });
        count++;
      }
      broadcast({ type: 'walking', folder: folder.label, count });
    }
  }

  setState('idle', 'completed');
}

async function processEntry(entry, folder, config, client, { _db, _hashFile, _uploadFile }) {
  const existing = await _db.get('sync_index', entry.path);
  if (existing
    && existing.size === entry.size
    && existing.mtime === entry.mtime
    && existing.status === 'uploaded') {
    return;
  }

  await _db.put('sync_index', {
    path: entry.path, size: entry.size, mtime: entry.mtime,
    hash: existing?.hash, status: 'pending',
  });

  try {
    broadcast({ type: 'progress', path: entry.path, phase: 'hashing' });
    const hash = await _hashFile(entry.file);

    broadcast({ type: 'progress', path: entry.path, phase: 'uploading' });
    const result = await _uploadFile(client, { ...entry, hash }, {
      prefix: config.prefix,
      onProgress: (uploaded, total) =>
        broadcast({ type: 'progress', path: entry.path, phase: 'uploading', uploaded, total }),
    });

    await _db.put('sync_index', {
      path: entry.path, size: entry.size, mtime: entry.mtime,
      hash, status: 'uploaded', uploadedAt: Date.now(),
    });
    broadcast({ type: 'file-uploaded', path: entry.path, hash,
                 key: `${config.prefix}/media/${hash}`, skipped: result.skipped });
  } catch (err) {
    await _db.put('sync_index', {
      path: entry.path, size: entry.size, mtime: entry.mtime,
      status: 'errored', error: err.message,
    });
    broadcast({ type: 'file-error', path: entry.path, error: err.message ?? String(err) });
  }
}

// postMessage glue (only when running inside a Worker).
if (typeof self !== 'undefined' && typeof self.addEventListener === 'function'
    && typeof window === 'undefined') {
  self.addEventListener('message', async (e) => {
    const { type, online } = e.data ?? {};
    if (type === 'start') {
      if (state !== 'idle') return;
      // Honor the controller's initial connectivity hint.
      if (online === false) pauseLoop();
      try {
        await runSync();
      } catch (err) {
        if (err?.message !== 'stopped') broadcast({ type: 'state', state: 'errored', reason: err.message });
      }
    } else if (type === 'pause') {
      if (state === 'running') pauseLoop();
    } else if (type === 'resume') {
      if (state === 'paused') resumeLoop();
    } else if (type === 'stop') {
      state = 'stopped';
      broadcast({ type: 'state', state });
    } else if (type === 'retry') {
      // Mark the entry pending and let the next sync run pick it up.
      // (Auto-retry-with-backoff lives in #16.)
      const path = e.data.path;
      const r = await db.get('sync_index', path);
      if (r) await db.put('sync_index', { ...r, status: 'pending' });
    }
  });
}
```

The pure `runSync(deps)` is what unit tests drive — every dependency is injected. The Worker glue is invoked by the runtime; tests never touch it.

The pause/resume mechanism uses an awaited promise (`pauseGate`) that only resolves when state flips back to `'running'`. Each iteration of the entry loop awaits `gate()` first.

### 6. Tests

#### Unit — `tests/lib/connectivity.test.js` (~5 cases)

```js
// @vitest-environment happy-dom    // window.addEventListener in scope
```
- `isOnline()` returns `navigator.onLine`.
- `onChange` callback fires on `online` event.
- `onChange` callback fires on `offline` event.
- Returned unsubscribe stops further callbacks.
- `_resetForTesting` clears cached registration + subscribers.

#### Unit — `tests/lib/sync.test.js` (~7 cases, controller)

Use a fake Worker class injected via the `workerUrl` indirection:

```js
class FakeWorker {
  constructor() { this.posts = []; this.terminated = false; }
  postMessage(m) { this.posts.push(m); }
  terminate() { this.terminated = true; }
}
```

Override Worker globally for the test, capture all instances:
```js
let workers = [];
beforeEach(() => {
  workers = [];
  globalThis.Worker = class extends FakeWorker { constructor(...a) { super(...a); workers.push(this); } };
  globalThis.BroadcastChannel = class { constructor(name){ this.name=name; this.posts=[]; allChannels.push(this); } postMessage(m){ this.posts.push(m); } close(){} };
});
```

Cases:
- `start()` creates a Worker and posts `{ type: 'start', online: <bool> }`.
- `start()` throws when `hasFsa()` is false (capability stubbed).
- `stop()` terminates the worker and is idempotent.
- `pause()` / `resume()` post the right messages.
- `retry(path)` posts `{ type: 'retry', path }`.
- Connectivity offline event → controller posts `pause`. Online → posts `resume`.
- BroadcastChannel emits → controller's `on('*', cb)` listeners fire; `on('file-uploaded', cb)` fires only for that type.

#### Unit — `tests/lib/sync-worker.test.js` (~6 cases, runSync engine)

`runSync(deps)` driven directly with mocked dependencies — no Worker involved.

```js
const fakeFolder = { id: 1, label: 'photos', handle: { /* ignored by mocks */ } };
const fakeEntries = [
  { path: 'a.jpg', name: 'a.jpg', size: 100, mtime: 1, file: new Blob(['a']) },
  { path: 'b.jpg', name: 'b.jpg', size: 200, mtime: 1, file: new Blob(['b']) },
];
```

Cases:
- `runSync` with no config → broadcasts `{ state: 'idle', reason: 'no-config' }` and returns.
- `runSync` with config but no folders → `{ state: 'idle', reason: 'no-folders' }`.
- Happy path: 2 entries, all upload, sync_index records have `status: 'uploaded'`, broadcasts include 2 `file-uploaded`.
- Permission denied for a folder → broadcasts `folder-error`, continues with next folder.
- Existing sync_index record with matching size/mtime + `status: 'uploaded'` → entry skipped (no hash, no upload, no put).
- Upload throws → sync_index updated to `status: 'errored'` with the error message; broadcasts `file-error`.

(Pause/resume logic is hard to test against `runSync` in isolation because the message handler that flips state lives in the Worker glue. We test it indirectly via the controller's `pause()` posting the right command; the worker glue's behavior is straightforward enough that we accept manual / e2e validation.)

#### E2E — `e2e/sync.spec.js` (1 test, scoped)

The big-picture happy path against real MinIO + an OPFS folder. Reuses the `?e2e=1` injection patterns:

1. Configure MinIO via `__test_save_config__` (new helper on setup-storage), then add an OPFS folder containing 3 small files.
2. Start a sync controller from the page via a new helper (`__test_sync_start__`), wait for the `state: idle, reason: completed` event with a 30 s timeout.
3. Verify all 3 files exist in the bucket via `__test_head__`.

We **don't** add a separate offline/online e2e test here. Playwright's `context.setOffline` toggles browser-side connectivity, but the worker's HTTP requests would all succeed against `localhost` regardless — toggling offline only fires the events. We get pause/resume signal coverage in the unit tests; the e2e covers the full pipeline, which is the higher-leverage signal.

### 7. Page test helpers (gated by `?e2e=1`)

Extend `setup-storage.js`'s existing block with helpers needed by the sync e2e:

```js
globalThis.__test_save_config__ = async (config) => {
  const { saveConfig } = await import('./lib/config.js');
  await saveConfig(config);
};
globalThis.__test_add_folder_handle__ = async (name) => {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getDirectoryHandle(name, { create: true });
  // Return a way to populate files via subsequent calls.
  return handle;
};
globalThis.__test_write_file__ = async (folderName, fileName, content) => {
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle(folderName, { create: true });
  const fileHandle = await folder.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
  // Persist the folder handle for the sync run.
  const { addFolder } = await import('./lib/folders.js');
  // Stub showDirectoryPicker so addFolder picks up THIS folder.
  globalThis.showDirectoryPicker = async () => folder;
  return folder;
};
globalThis.__test_sync_start__ = async () => {
  const { createSyncController } = await import('./lib/sync.js');
  const controller = createSyncController();
  const completion = new Promise((resolve) => {
    const ch = new BroadcastChannel('webgallery:sync');
    ch.onmessage = (e) => {
      if (e.data.type === 'state' && e.data.state === 'idle' && e.data.reason === 'completed') {
        ch.close();
        resolve();
      }
    };
  });
  controller.start();
  await completion;
  controller.stop();
};
```

### 8. Service Worker shell

Three new files: `lib/connectivity.js`, `lib/sync.js`, `lib/sync-worker.js`. Add all to `SHELL`. Bump `sw.js` `VERSION` from `v11` → `v12`.

### 9. Verification

1. `make lint` — passes.
2. `make test` — 79 → ~97 unit (5 connectivity + 7 sync controller + 6 sync-worker).
3. `make e2e` — 17 → 18 e2e (1 new sync happy path).
4. CI green.

If any test fails, that's the verification — fix and re-run.

### 10. Commit + close

One commit (`Closes #15`) covering: three new `lib/` files, three new test files, the new e2e spec, page test helpers, README touch-up if needed, `sw.js` version bump, plus `docs/plans/issue-15-sync-controller.md` and the index update.

## Files

**Created:**
- `lib/connectivity.js`
- `lib/sync.js`
- `lib/sync-worker.js`
- `tests/lib/connectivity.test.js`
- `tests/lib/sync.test.js`
- `tests/lib/sync-worker.test.js`
- `e2e/sync.spec.js`
- `docs/plans/issue-15-sync-controller.md` (frozen copy of this plan)

**Modified:**
- `setup-storage.js` — add e2e helpers (`__test_save_config__`, `__test_write_file__`, `__test_sync_start__`).
- `sw.js` — bump `VERSION` to `v12`; add the three new lib files to `SHELL`.
- `docs/plans/README.md` — add #15 to the index.

## Out of scope for this issue (handled later)

- **Per-file retry / backoff on transient errors.** That's **#16**. The worker marks errored files in `sync_index` and moves on; #16 layers an automatic-retry pass on top.
- **Wiring sync into `index.html`'s page bootstrap.** The Local tab UI in **#17** kicks off the controller and renders the events. #15 ships the engine; the wiring is part of #17's scope.
- **EXIF / mp4 `capturedAt` extraction.** The uploader already accepts the field; nobody populates it yet. Future enhancement.
- **SharedWorker upgrade** (one sync engine across all open pages of the app). Architecture notes this as a follow-up if "running-only-on-the-main-page" proves limiting.
- **Periodic Background Sync** (waking the worker without an open tab). Architecture defers this to v1.1.
- **Graceful auto-recover after a folder permission lapses mid-sync.** Today: skip with `folder-error`; user re-grants from setup-folders, restarts sync. A more elegant flow lands later.
- **Concurrency** (multiple files hashing/uploading in parallel). Sequential per worker for v1; trivially parallelizable later.

## Sources / references

- `docs/architecture.md` — *Sync trigger model*; *Sync flow* (the loop); *Capability and connectivity awareness*; *IndexedDB stores* (`sync_index`).
- Issue #15 acceptance criteria.
- `lib/walker.js` (#12), `lib/hash.js` (#13), `lib/upload.js` (#14) — composed here.
- `lib/db.js` (#3) — `sync_index` reads/writes.
- `lib/config.js` (#7) and `lib/folders.js` (#9) — input data the worker loads.
- `lib/capability.js` (#11) — the FSA gate the controller honors.
