# Plan — Issue #7: lib/config.js load/save storage config + prefix

## Context

Persistence layer for the storage config the user enters in `setup-storage.html` (#8). Every later module that talks to the bucket reads through this — `lib/bucket.js` consumes the same shape via `createBucketClient(config)`, the sync controller bootstraps from it, the Remote tab reads it. The architecture doc nails down the fields (`docs/architecture.md` *IndexedDB stores* → `config`; *Connection setup* in `docs/requirements.md`).

`lib/db.js` (#3) already created the `config` object store with `keyPath: null`. This issue's job is the validated read/write API on top of it, keyed at the fixed slot `'storage'`.

## Approach

### 1. Stored shape

Single record at the fixed key `'storage'` in the `config` object store:

```js
{
  endpoint: 'https://s3.amazonaws.com',
  region: 'us-east-1',
  bucket: 'my-bucket',
  prefix: 'phone',
  accessKeyId: 'AKIA...',
  secretAccessKey: '...',
  pathStyle: false,
}
```

This matches what `createBucketClient` from #6 expects. No translation layer between this module and `lib/bucket.js` — pass the loaded object straight through.

### 2. Exported API

```js
// All async (IndexedDB).
export async function loadConfig();    // → Config | null
export async function saveConfig(c);   // throws ConfigError on validation failure
export async function clearConfig();
export async function hasConfig();     // → boolean

// Sync helpers used by the setup form (#8) and any caller that wants
// to validate before saving.
export function validateConfig(c);     // → Array<{ field, message }> (empty = ok)
export function defaultPathStyle(endpoint); // → boolean

export class ConfigError extends Error {
  constructor(errors) { ... this.errors = errors; ... }
}
```

`loadConfig()` returning `null` (not throwing) when no record exists is the contract that lets `index.js` cheaply check "have we been set up?" without try/catch.

### 3. Validation rules

Required, all strings, all non-empty after trim:
- `endpoint` — additionally must parse as a URL (`new URL(endpoint)` doesn't throw); origin must be `https:` for v1, with `http:` allowed only for `localhost`/`127.0.0.1`/dev hostnames (handy for MinIO local testing).
- `region`
- `bucket`
- `prefix`
- `accessKeyId`
- `secretAccessKey`

Optional:
- `pathStyle` — boolean; if missing on save, `defaultPathStyle(endpoint)` fills it in.

`validateConfig` collects every failure and returns them as an array, so the form (#8) can highlight each bad field at once. `saveConfig` wraps that — empty array → write to IndexedDB; non-empty → throw `ConfigError` carrying the array.

### 4. `defaultPathStyle(endpoint)` heuristic

Simple host check, since we ship presets in the form (#8) but want a sane fallback:

```js
export function defaultPathStyle(endpoint) {
  try {
    const host = new URL(endpoint).host;
    // AWS S3 (real or accelerated): virtual-hosted by default.
    if (/(^|\.)amazonaws\.com$/i.test(host)) return false;
    // Everything else (MinIO, B2, local dev, R2 with raw endpoint): path-style.
    return true;
  } catch {
    return true;
  }
}
```

Conservative: `true` is the safe default — works on every S3-compatible service we care about; AWS is the only common one that actively wants `false`.

### 5. Implementation notes

- All persistence routes through `lib/db.js`'s `get('config', 'storage')` / `put('config', value, 'storage')` / `del('config', 'storage')`. No direct `indexedDB.open` here; that's #3's seam.
- `hasConfig()` is `(await loadConfig()) != null`. It's a convenience — saves the form a comparison.
- No partial saves. The form sends the whole object every time. Simpler model, no merge logic.
- `ConfigError` is exported so callers can `instanceof`-check it without coupling to the message format.

### 6. Tests — `tests/lib/config.test.js`

Same pattern as `db.test.js`: `globalThis.indexedDB = new IDBFactory()` in `beforeEach` plus `vi.resetModules()` so the cached `dbPromise` in `lib/db.js` is dropped between tests.

```js
import { IDBFactory } from 'fake-indexeddb';
import { describe, test, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
});
```

Cases (~10):

- `loadConfig()` returns `null` initially.
- `hasConfig()` is `false` initially.
- `saveConfig` round-trips through `loadConfig` (full object preserved verbatim).
- `hasConfig()` becomes `true` after a successful save.
- `clearConfig` wipes — `loadConfig` returns `null` after.
- `validateConfig` flags every missing required field at once (one assertion, length === 6).
- `validateConfig` rejects an unparseable endpoint URL.
- `validateConfig` rejects `http://` against a non-localhost host; allows `http://localhost:9000` and `http://127.0.0.1:9000`.
- `saveConfig` throws `ConfigError` whose `errors` array matches what `validateConfig` returns.
- `defaultPathStyle`: AWS endpoint → `false`; MinIO-style endpoint → `true`; malformed URL → `true`.
- `saveConfig` fills in `pathStyle` via `defaultPathStyle` when caller omits it; respects the caller's value when set.

~12 tests total. Closes the issue's "round-trip, validation rejections, clearing" line.

### 7. Service Worker shell

`lib/config.js` joins `SHELL` so the module is precached. Bump `sw.js` `VERSION` from `v3` → `v4`.

### 8. Verification

1. **`make lint`** — `node --check` over the new files passes (also fires in the pre-commit hook).
2. **`make test`** — total suite goes from 22 → ~34 green; existing 9 db + 13 bucket + new ~12 config.
3. **CI** — push triggers the workflow; lint + unit + e2e jobs all green. The smoke E2E spec from #4 still passes; bucket-level e2e lands with #14.

If any test fails, that's the verification — fix and re-run.

### 9. Commit + close

One commit (`Closes #7`) covering: `lib/config.js`, `tests/lib/config.test.js`, `sw.js` version bump, plus the design-log copy at `docs/plans/issue-07-config.md` and the index update.

## Files

**Created:**
- `lib/config.js`
- `tests/lib/config.test.js`
- `docs/plans/issue-07-config.md` (frozen copy of this plan)

**Modified:**
- `sw.js` — bump `VERSION` to `v4`, add `./lib/config.js` to `SHELL`.
- `docs/plans/README.md` — add #7 to the index.

## Out of scope for this issue (handled later)

- **Provider presets** (`AWS` / `R2` / `B2` / `MinIO` dropdown that auto-fills `endpoint` and `pathStyle`) — lives in **`setup-storage.html`** / `setup-storage.js` (**#8**). `lib/config.js` only stores what it's given.
- **"Test connection" button** — that's a `bucket.head` call against the configured bucket, wired in **#8**.
- **Encryption of credentials at rest** — explicitly out of scope per `docs/requirements.md` *Open questions*. Credentials live in IndexedDB plaintext for v1; CSP + IAM scoping are the mitigations.
- **Migration when the schema grows** — handled by `lib/db.js`'s `onupgradeneeded` switch, not here.

## Sources / references

- `docs/architecture.md` — *IndexedDB stores* → `config`.
- `docs/requirements.md` — *Connection setup*.
- Issue #7 acceptance criteria.
- `lib/db.js` — `get`/`put`/`del`-with-explicit-key, the only persistence path used here.
- `lib/bucket.js` — `createBucketClient(config)` shape, which `Config` matches verbatim.
