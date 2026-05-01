# Plan — Issue #8: setup-storage.html form + connection test

## Context

The first piece of v1 the user actually interacts with. Before this issue the storage page is a placeholder; after it lands, a fresh user can paste their S3-compatible credentials, prove the connection works, and persist them — closing the loop opened by `lib/config.js` (#7) and `lib/bucket.js` (#6).

## Approach

### 1. Form layout — Bootstrap-only, mobile-first

Single Bootstrap form inside the existing `<main>` container. Field order matches `Config`'s validation order so the layout reads top-to-bottom the way values flow into `saveConfig`.

```
[Provider preset]   <select>  AWS S3 / Cloudflare R2 / Backblaze B2 / MinIO / Custom
[Endpoint]          <input type="url">          // placeholder switches with provider
[Region]            <input type="text">
[Bucket]            <input type="text">
[Prefix]            <input type="text">         // help text: "phone, laptop, family-2024..."
[Access key ID]     <input type="text" autocomplete="off">
[Secret access key] <input type="password" autocomplete="off">
[Path-style URLs]   <input type="checkbox" role="switch">

[Result pane]       Bootstrap alert that appears on test/save (success/error)

[Test connection]   <button type="button" class="btn btn-outline-primary">
[Save]              <button type="submit"  class="btn btn-primary">
```

Each input has a sibling `<div class="invalid-feedback" data-error-for="X">` that surfaces field-level errors from `validateConfig`. Bootstrap's `.is-invalid` class on the input + non-empty feedback = standard validation visuals. No custom CSS.

### 2. Provider presets

Pure data table in `setup-storage.js`:

| Provider | Default endpoint placeholder | Default `pathStyle` |
|---|---|---|
| AWS S3 | `https://s3.amazonaws.com` | `false` |
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` | `false` |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | `false` |
| MinIO | `http://localhost:9000` | `true` |
| Custom | (blank) | `true` |

When the user picks a preset, fill the **endpoint** and **path-style toggle** with the preset's defaults — but only if the corresponding field is empty / matches a previous preset's default. Don't clobber values the user has already typed. (Standard "smart presets" pattern.)

`defaultPathStyle` from `lib/config.js` covers anything custom; presets are just UX shortcuts.

### 3. Bootstrap + behavior wiring (`setup-storage.js`)

Replaces the current stub. Imports the SW registration shim (already there) plus `lib/config.js` and `lib/bucket.js`:

```js
import './lib/register-sw.js';
import {
  loadConfig, saveConfig, validateConfig,
  defaultPathStyle, ConfigError,
} from './lib/config.js';
import { createBucketClient, BucketError } from './lib/bucket.js';
```

Page boot:
1. `loadConfig()` — if non-null, populate every field. `pathStyle` round-trips its checkbox state.
2. Provider select defaults to `Custom` if no config is loaded; otherwise stays on whatever option matches the loaded endpoint host (best-effort string match).
3. Wire `change` on provider → apply preset (with don't-clobber rule).
4. Wire `click` on **Test connection** → run the test flow.
5. Wire `submit` on form → run the save flow.

#### Read form → config

Single helper `readForm()` returns a `Config`-shaped object built from the inputs (trim whitespace, no transformation otherwise).

#### Validation surface

A helper `applyErrors(errors)` clears prior `.is-invalid` state, then for each `{field, message}` flips the matching input's class and writes the message into its `invalid-feedback` sibling. Empty errors array → form is clean.

#### Test connection flow

```js
async function onTest() {
  resultPane.clear();
  const c = readForm();
  const errors = validateConfig(c);
  if (errors.length) { applyErrors(errors); return; }

  // Fill in pathStyle if it's a "default per provider" situation —
  // saveConfig would do this but the test path needs it explicit.
  if (typeof c.pathStyle !== 'boolean') c.pathStyle = defaultPathStyle(c.endpoint);

  resultPane.info('Testing connection…');
  try {
    const client = createBucketClient(c);
    await client.list({ maxKeys: 1 });   // exercises ListBucket
    resultPane.success('Connection OK.');
  } catch (err) {
    if (err instanceof BucketError) {
      resultPane.error(`${err.status} ${err.code}: ${err.message}`);
    } else {
      resultPane.error(err.message ?? String(err));
    }
  }
}
```

`list({ maxKeys: 1 })` is the right probe: it exercises the actual permission the gallery needs (`s3:ListBucket`), works on empty buckets, and surfaces `403 SignatureDoesNotMatch` etc. cleanly via our existing error mapping.

#### Save flow

```js
async function onSave(e) {
  e.preventDefault();
  resultPane.clear();
  try {
    await saveConfig(readForm());
    resultPane.success('Saved.');
  } catch (err) {
    if (err instanceof ConfigError) applyErrors(err.errors);
    else resultPane.error(err.message ?? String(err));
  }
}
```

Save does NOT auto-test — keeps the two operations independent. If the user wants a test, they click the button.

### 4. The result pane

Tiny module-local helpers wrapping a single `<div id="result">`:

```js
const pane = document.getElementById('result');
const resultPane = {
  clear: () => { pane.className = 'd-none'; pane.textContent = ''; },
  info:    (msg) => set('alert alert-secondary', msg),
  success: (msg) => set('alert alert-success', msg),
  error:   (msg) => set('alert alert-danger', msg),
};
function set(cls, msg) { pane.className = cls; pane.textContent = msg; }
```

All Bootstrap utility classes; zero custom CSS.

### 5. CORS sanity-check (already handled, just noting)

Browser at PWA origin (`http://localhost:8888` in CI / `http://static:8080` in compose) fetches `http://localhost:9000` (CI) / `http://minio:9000` (compose). Different origins → CORS preflight. MinIO is started with `MINIO_API_CORS_ALLOW_ORIGIN=*`, which responds permissively to any origin. No code change here.

### 6. E2E tests — `e2e/setup-storage.spec.js`

Three tests against the live MinIO that `make e2e` brings up. Endpoint URL comes from `process.env.MINIO_ENDPOINT` (set in compose; will need to set in CI — see workflow change below) with a `http://localhost:9000` fallback.

```js
import { test, expect } from '@playwright/test';

const MINIO = {
  endpoint: process.env.MINIO_ENDPOINT || 'http://localhost:9000',
  region: 'us-east-1',
  bucket: process.env.MINIO_BUCKET || 'test-bucket',
  prefix: 'e2e',
  accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
};

async function fill(page, c) { /* fill inputs by label */ }

test('test connection: success against MinIO', async ({ page }) => {
  await page.goto('/setup-storage.html');
  await fill(page, MINIO);
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText(/connection ok/i)).toBeVisible();
});

test('test connection: bad credentials → clear error', async ({ page }) => {
  await page.goto('/setup-storage.html');
  await fill(page, { ...MINIO, secretAccessKey: 'wrong-secret' });
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText(/Signature|forbidden|not match/i)).toBeVisible();
});

test('save persists across reload', async ({ page }) => {
  await page.goto('/setup-storage.html');
  await fill(page, MINIO);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/^Saved\.?$/i)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Endpoint')).toHaveValue(MINIO.endpoint);
  await expect(page.getByLabel('Bucket')).toHaveValue(MINIO.bucket);
});
```

Each Playwright test runs in a fresh browser context → fresh IndexedDB by default, so tests don't bleed config into each other.

### 7. CI workflow update

The e2e job currently only sets `PLAYWRIGHT_BASE_URL`. The new spec needs the MinIO env vars too (matching what compose injects locally). One small addition to `.github/workflows/ci.yml`:

```yaml
- name: Run Playwright
  run: npm run e2e
  env:
    PLAYWRIGHT_BASE_URL: http://localhost:8888
    MINIO_ENDPOINT: http://localhost:9000
    MINIO_BUCKET: test-bucket
    MINIO_ACCESS_KEY: minioadmin
    MINIO_SECRET_KEY: minioadmin
```

### 8. Service Worker shell

`setup-storage.html`'s contents change (placeholder → form) and `setup-storage.js` replaces a stub. Both already in `SHELL`; bump `sw.js` `VERSION` from `v4` → `v5` so users get the new code.

### 9. Verification

1. **`make lint`** — `node --check` over the new JS passes (also fires in the pre-commit hook).
2. **`make test`** — existing 34 unit tests stay green (no unit-test changes for #8).
3. **`make e2e`** — smoke spec from #4 still passes (4 tests); 3 new setup-storage tests pass (success / error / persistence).
4. **CI** — push triggers the workflow; lint + unit + e2e all green with the updated env block.

If any test fails, that's the verification — fix and re-run.

### 10. Commit + close

One commit (`Closes #8`) covering: rewritten `setup-storage.html` + `setup-storage.js`, new `e2e/setup-storage.spec.js`, CI workflow env addition, `sw.js` version bump, plus `docs/plans/issue-08-setup-storage.md` and the index update.

## Files

**Created:**
- `e2e/setup-storage.spec.js`
- `docs/plans/issue-08-setup-storage.md` (frozen copy of this plan)

**Modified:**
- `setup-storage.html` — replace placeholder body with the Bootstrap form + result pane.
- `setup-storage.js` — implement preset logic, validation surface, test, save.
- `.github/workflows/ci.yml` — add MinIO env block to the Playwright step.
- `sw.js` — bump `VERSION` to `v5`.
- `docs/plans/README.md` — add #8 to the index.

## Out of scope for this issue (handled later)

- **Auto-redirect from gallery to setup-storage when no config exists** — that's part of capability gating (#11) / index page bootstrap (#17).
- **Ergonomics like "show secret" toggle, paste-detection, bucket dropdown** — fine to add later if the form proves clunky in real use.
- **Encryption of credentials at rest** — explicitly out of scope per `docs/requirements.md` *Open questions*.
- **Multi-config / connection profiles** — single-user, single-config v1.
- **Auto-saving on test success** — explicit decision: test and save are independent buttons. Less surprising, easier to reason about.

## Sources / references

- `docs/architecture.md` — *Pages* (`setup-storage.html`), *Capability and connectivity awareness*.
- `docs/requirements.md` — *Connection setup*.
- Issue #8 acceptance criteria.
- `lib/config.js` (#7) — `loadConfig` / `saveConfig` / `validateConfig` / `defaultPathStyle` / `ConfigError`.
- `lib/bucket.js` (#6) — `createBucketClient` + `list({ maxKeys })` + `BucketError`.
- `docker-compose.yml` — MinIO env block (`MINIO_API_CORS_ALLOW_ORIGIN=*`, default credentials, port mappings).
