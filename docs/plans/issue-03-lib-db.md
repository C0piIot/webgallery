# Plan — Issue #3: lib/db.js IndexedDB wrapper + unit test

## Context

Every later module that owns durable state goes through this file: `lib/config.js` (storage credentials + prefix), `lib/folders.js` (FSA handles), the sync worker (`sync_index`, `uploaded`), and the main page's Remote tab (`gallery_cache`). The architecture doc commits to five stores and explicitly lists `tx(stores, mode, fn)` as part of the helper surface (`docs/architecture.md` *IndexedDB stores*).

## Dependency note: tests vs #4 tooling

Issue #3's acceptance lists "Unit tests run against `fake-indexeddb`," but Vitest + `fake-indexeddb` are installed by issue **#4** (Dev tooling). That tooling isn't on the host yet.

**Approach:** write `lib/db.js` *and* its `tests/lib/db.test.js` now. The test file uses Vitest's API and `import 'fake-indexeddb/auto'`. It won't run until #4 ships, but it's committed and ready. #4's smoke run is responsible for ensuring it actually passes.

## Approach

### 1. Schema (centralized, easy to extend)

Defined once at the top of `lib/db.js`:

```js
const DB_NAME = 'webgallery';
const DB_VERSION = 1;

const SCHEMA = {
  config:        { keyPath: null }, // single record at fixed key 'storage'
  folders:       { keyPath: 'id', autoIncrement: true },
  sync_index:    { keyPath: 'path' },
  uploaded:      { keyPath: 'hash' },
  gallery_cache: { keyPath: 'key' },
};
```

`onupgradeneeded` switches on `event.oldVersion`:
- `0 → 1`: create every store from `SCHEMA`.
- Future versions append cases.

Schema details for each store's *records* are owned by the consuming modules — `db.js` only declares the keying.

### 2. API surface

```js
export async function open();                      // idempotent, returns IDBDatabase
export async function get(store, key);
export async function put(store, value, key);      // key only when keyPath is null
export async function del(store, key);
export async function iterate(store, callback);    // returning false stops
export async function tx(stores, mode, callback);  // multi-store atomic
```

Inside a `tx` callback, the caller gets a per-store wrapper exposing the same get/put/del/iterate bound to the transaction.

### 3. Implementation notes

- **Promise wrapping.** Internal `req(idbRequest)` helper turns an `IDBRequest` into a Promise.
- **Singleton DB connection.** Module-level `dbPromise` set on first `open()`. Reset to `null` on `versionchange` so a new tab triggering an upgrade doesn't deadlock the old one.
- **Transaction lifetime safety.** Callbacks in `tx` must only await db-bound work. Awaiting `fetch` inside a `tx` callback would auto-commit IDB transactions while suspended — silent data loss. Documented in the JSDoc, not enforced.
- **Rollback on throw.** If the callback throws, call `t.abort()` and re-raise.
- **No globals beyond the module-level promise.** Every helper goes through `open()` first.

### 4. Tests

`tests/lib/db.test.js`. Top of file: `import 'fake-indexeddb/auto';` (registers a global IDB shim). Each test gets a fresh `IDBFactory` plus `vi.resetModules()` so the cached `dbPromise` doesn't leak.

Coverage:
- `open()` is idempotent — second call returns the same instance.
- All five stores exist after `open()`.
- `put` then `get` round-trips per store. `config` (keyPath null) takes an explicit key; the others use their keyPath.
- `del` removes records. `get` after `del` returns `undefined`.
- `iterate` visits every record exactly once; returning `false` stops mid-walk.
- `tx(['a','b'], 'readwrite', ...)` with a throwing callback → no writes persisted.
- `tx(['a','b'], 'readwrite', ...)` happy-path → both stores see writes.

### 5. Verification

- **Static (now):** Manually walk the file in a browser context using DevTools console. Application → IndexedDB shows `webgallery` with the five stores.
- **Tests (after #4):** `make test` runs Vitest against `fake-indexeddb`; all tests pass.

### 6. Commit + close

One commit with a `Closes #3` trailer. Bumps `sw.js`'s `VERSION` to `v2` and adds `lib/db.js` to `SHELL` so it precaches alongside the rest.

## Files

**Created:** `lib/db.js`, `tests/lib/db.test.js`

**Modified:** `sw.js` — bump `VERSION` to `v2`, add `lib/db.js` to `SHELL`.

## Out of scope

- Concrete record shapes for each store — owned by consumer modules (#7, #9, #14, #18).
- Test runner config (`package.json`, `vitest.config`, `make test`) — **#4**.
- CI hookup — **#5**.

## Sources / references

- `docs/architecture.md` — *IndexedDB stores*.
- Issue #3 acceptance criteria.
