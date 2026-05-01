# Plan — Issue #9: lib/folders.js FSA handle persistence + permission re-grant

## Context

Persists `FileSystemDirectoryHandle`s across page reloads + provides the small permission-management surface the rest of the app needs. Used by `setup-folders.html` (#10) for adding/removing folders, by the capability-gating layer (#11) to detect FSA availability, and by the sync worker (#12+) to re-grant permission before walking each folder.

`lib/db.js` (#3) already created the `folders` object store with `keyPath: 'id', autoIncrement: true`. Records are `{ id, label, handle }`. This issue is the API on top of that.

## Approach

### 1. Exported API

```js
// Capability check — boot-time-cheap, no IO. Same heuristic lib/capability.js
// (#11) will pivot on; living here means callers can avoid that dep until #11.
export function isFsaAvailable();        // → boolean

// Lifecycle
export async function addFolder(label?); // throws if FSA unavailable
                                         // → { id, label, handle }
export async function listFolders();     // → Array<{ id, label, handle }>
export async function removeFolder(id);

// Permission flow
export async function ensurePermissions(handle, mode = 'read');
                                         // → boolean (true = granted)
```

`addFolder` invokes `showDirectoryPicker()` itself — it's a complete unit of "let user pick + persist". The caller (the form in #10) just calls it from a click handler. No need for the form to thread `handle` through.

`ensurePermissions` is split out because it must be re-called on every page load that wants to use a stored handle (FSA permissions are session-scoped). Worker bootstrap and the Local tab will use it.

### 2. `addFolder` flow

```js
export async function addFolder(label) {
  if (!isFsaAvailable()) {
    throw new Error('File System Access API is not available in this browser');
  }
  const handle = await globalThis.showDirectoryPicker({ mode: 'read' });
  const record = { label: label?.trim() || handle.name, handle };
  const id = await db.put('folders', record);
  return { id, ...record };
}
```

- `showDirectoryPicker` is opened in read-only mode — we never write to local files.
- Default label is the directory name (e.g. `DCIM`, `Pictures`). The form (#10) can pass an explicit label later if it adds a "rename" affordance.
- The handle goes straight into IndexedDB via structured clone. Browsers handle this natively.

### 3. `listFolders` / `removeFolder`

Direct passthrough to `lib/db.js`:

```js
export async function listFolders() {
  const out = [];
  await db.iterate('folders', (v) => { out.push(v); });
  return out;
}

export async function removeFolder(id) {
  await db.del('folders', id);
}
```

No de-duping or sorting — the caller orders for display. Records come out in insertion order (autoIncrement key) which is fine for v1.

### 4. `ensurePermissions`

```js
export async function ensurePermissions(handle, mode = 'read') {
  if (!handle?.queryPermission) return false;
  const opts = { mode };
  let state = await handle.queryPermission(opts);
  if (state === 'granted') return true;
  if (typeof handle.requestPermission === 'function') {
    state = await handle.requestPermission(opts);
  }
  return state === 'granted';
}
```

- Caller is responsible for invoking from a user-gesture context (FSA spec requirement). We document but don't enforce — there's no reliable way to detect from inside.
- `null`/missing-method handles return `false` rather than throwing — defensive against IndexedDB returning a bare object after a browser data wipe or version drift.

### 5. `isFsaAvailable`

```js
export function isFsaAvailable() {
  return typeof globalThis.showDirectoryPicker === 'function';
}
```

Same check `lib/capability.js` will use in #11. Defining it here means folders.js doesn't need to import capability.js, and #10's form can call this directly.

### 6. Tests — `tests/lib/folders.test.js`

Same fake-indexeddb pattern as the other lib tests. `showDirectoryPicker` and the handle's permission methods are stubbed via `vi.stubGlobal` / `vi.fn`. The "handle" is a plain JS object with the right shape — IndexedDB's structured clone will round-trip it like any other object.

```js
import { IDBFactory } from 'fake-indexeddb';
import { describe, test, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  delete globalThis.showDirectoryPicker;
});

function makeHandle({ name = 'Photos', perm = 'granted' } = {}) {
  return {
    name,
    kind: 'directory',
    queryPermission: vi.fn(async () => perm),
    requestPermission: vi.fn(async () => perm),
  };
}
```

Cases (~10):

- **`isFsaAvailable`** — `false` when `globalThis.showDirectoryPicker` is undefined; `true` when it's a function.
- **`addFolder` rejects when FSA missing** — throws with a clear message.
- **`addFolder` happy path** — stubs `showDirectoryPicker` to return a fake handle; result is `{ id: <number>, label: 'Photos', handle }`.
- **`addFolder` uses caller's label when provided**; falls back to `handle.name` otherwise.
- **`listFolders` returns persisted records in insertion order** after two `addFolder` calls.
- **`removeFolder(id)` removes the right record**, leaves the others.
- **`ensurePermissions(handle)` returns `true` when state is `granted`**, doesn't call `requestPermission`.
- **`ensurePermissions(handle)` calls `requestPermission` when `prompt`**, propagates the result.
- **`ensurePermissions(handle)` calls `requestPermission` when `denied`**, propagates the (likely still-`denied`) result.
- **`ensurePermissions(null)` returns `false`** — defensive for missing/wiped handles.

~10 tests, ~80 lines.

### 7. Service Worker shell

`lib/folders.js` is part of the runtime shell as soon as anything imports it. Add to `sw.js` `SHELL` and bump `VERSION` from `v5` → `v6`.

### 8. Verification

1. **`make lint`** — passes.
2. **`make test`** — total goes 34 → ~44 green; existing 9 db + 12 config + 13 bucket + 10 new folders.
3. **CI** — push triggers the workflow; lint + unit + e2e all green. (No e2e for #9 — folder form e2e lands with #10.)

If any test fails, that's the verification — fix and re-run.

### 9. Add MIT license (outside #9's acceptance, shipped in the same commit)

Repo hygiene the user asked for alongside this issue.

- New `LICENSE` file at repo root: standard MIT text, `Copyright (c) 2026 Eduard Martinez` (git config name; trivially changeable).
- `package.json` gains `"license": "MIT"` so npm + GitHub's "About" sidebar pick it up.
- No README badge or extra sections — GitHub auto-detects `LICENSE` and shows it in the sidebar.

If a different copyright holder is preferred (e.g. `C0piIot`), say so before I commit and I'll update.

### 10. Commit + close

One commit (`Closes #9`) covering: `lib/folders.js`, `tests/lib/folders.test.js`, `sw.js` version bump, the LICENSE + package.json license entry, plus `docs/plans/issue-09-folders.md` and the index update.

## Files

**Created:**
- `lib/folders.js`
- `tests/lib/folders.test.js`
- `LICENSE` — MIT, `Copyright (c) 2026 Eduard Martinez`.
- `docs/plans/issue-09-folders.md` (frozen copy of this plan)

**Modified:**
- `sw.js` — bump `VERSION` to `v6`, add `./lib/folders.js` to `SHELL`.
- `package.json` — add `"license": "MIT"`.
- `docs/plans/README.md` — add #9 to the index.

## Out of scope for this issue (handled later)

- **`setup-folders.html`** form (Add / List / Remove UI) — **#10**.
- **Capability-aware page gating** (showing an explainer panel when FSA missing) — **#11**, which will reuse `isFsaAvailable()` from this file.
- **Permission re-grant from the sync worker** — happens in **#15** (sync controller) using the helper this issue ships.
- **Showing a "permission lapsed" banner** in the Local tab — **#17**.
- **Per-folder label editing / "rename folder" affordance** — defer until users ask.

## Sources / references

- `docs/architecture.md` — *IndexedDB stores* → `folders`; *Sync trigger model*; *Capability and connectivity awareness*.
- `docs/requirements.md` — *Backup source*.
- Issue #9 acceptance criteria.
- `lib/db.js` (#3) — `put` / `del` / `iterate`, the only persistence path used here.
- [MDN — `FileSystemDirectoryHandle`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemDirectoryHandle) for `queryPermission` / `requestPermission` semantics.
