# Plan — Issue #18: Remote tab — ListObjectsV2 + gallery_cache + offline cache mode

## Context

The actual gallery — what the user opens the app to look at. M5's headline feature. Renders every object under `{prefix}/media/` in their bucket as a card with a thumbnail, refreshes against the live bucket on open (when online), and falls back gracefully to the last-known list (`gallery_cache`) when offline. Infinite-scroll with `IntersectionObserver` so the DOM stays light even with thousands of photos.

Detail view + delete are #19. This issue stops at "show me the cards in the right order."

## Approach

### 1. `gallery_cache` record shape

The store was created in #3 with `keyPath: 'key'`. v1 records:

```js
{
  key: 'phone/media/abc123def....jpg',  // primary key, includes prefix
  size: 12345,
  lastModified: '2025-01-15T10:23:00.000Z',
  etag: 'abc123def...',
}
```

`x-amz-meta-*` headers (filename / captured-at / source-path) are **not** part of the cache. ListObjectsV2 doesn't return them, and HEADing every object on every list refresh is N round-trips for N objects — too expensive at scale. The detail view (#19) HEADs lazily and caches the metadata into IndexedDB on demand.

### 2. Sort order

Architecture says "sorted by capture date desc." Without `captured-at` in the cache that's not directly possible at gallery render time. **For v1, sort by `lastModified` desc** — fresh uploads first. Documented in the plan; revisited when we have a story for cheap captured-at access (e.g., the worker writes the value into `gallery_cache` at upload time alongside `sync_index`, since the worker already has it). That enhancement is naturally a follow-up; mentioning it in `Out of scope` so the path is visible.

### 3. `client.presignGet(key, ttl?)` — add to `lib/bucket.js`

Cards render thumbnails inline as `<img src="...">`, which means we need a URL the browser can fetch *without* setting an `Authorization` header. Standard answer: SigV4 presigned URLs (signature carried in query string). aws4fetch's `AwsClient` already supports it through `aws.sign(url, { aws: { signQuery: true } })` — we just expose a thin wrapper:

```js
async function presignGet(key, ttl = 3600) {
  const url = urlFor(config, key, { 'X-Amz-Expires': String(ttl) });
  const signed = await aws.sign(url, {
    method: 'GET',
    aws: { signQuery: true },
  });
  return signed.url;
}
```

Returns a fully-signed `https://…?X-Amz-Algorithm=…&X-Amz-Signature=…` URL valid for `ttl` seconds (default 1 h). Cards stash the URL after first render; SW caching handles repeat loads.

One unit test in `tests/lib/bucket.test.js` confirms the URL has the expected query parameters and points at the right key.

### 4. Reconciliation: `gallery_cache` ↔ live bucket

`lib/remote-list.js` (new module — keeps `index.js` from ballooning further):

```js
export async function reconcile(client, prefix, db) {
  const liveKeys = new Set();
  const upserts = [];
  let token;
  do {
    const page = await client.list({
      prefix: `${prefix}/media/`,
      continuationToken: token,
      maxKeys: 1000,
    });
    for (const it of page.items) {
      liveKeys.add(it.key);
      upserts.push(it);
    }
    token = page.continuationToken;
  } while (token);

  // Diff against cache.
  const cached = await readAll(db);
  const cachedKeys = new Set(cached.map((r) => r.key));
  const removed = cached.filter((r) => !liveKeys.has(r.key));
  const added = upserts.filter((it) => !cachedKeys.has(it.key));

  await db.tx(['gallery_cache'], 'readwrite', async (t) => {
    for (const r of removed) await t.gallery_cache.del(r.key);
    for (const it of upserts) {
      await t.gallery_cache.put({
        key: it.key,
        size: it.size,
        lastModified: it.lastModified,
        etag: it.etag,
      });
    }
  });

  return { added, removed };
}
```

`reconcile()` is pure data-plane; the page calls it from a click ("Refresh") or automatically when the Remote tab activates and we're online.

### 5. `index.html` — Remote pane structure

Replace the placeholder with a header strip + grid + sentinel + empty state.

```html
<div class="tab-pane" id="pane-remote">
  <div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
    <div id="remote-summary" class="text-muted small"></div>
    <div class="d-flex align-items-center gap-2">
      <span id="remote-offline-pill" class="badge bg-warning text-dark d-none">⚠️ Offline</span>
      <button id="remote-refresh" type="button" class="btn btn-sm btn-primary" disabled>Refresh</button>
    </div>
  </div>
  <div id="remote-grid" class="row row-cols-2 row-cols-md-3 row-cols-lg-4 g-3"></div>
  <div id="remote-sentinel" style="height: 1px;"></div>
  <div id="remote-empty" class="text-muted text-center py-4 d-none">
    Nothing in the bucket yet. Upload something from the Local tab.
  </div>
</div>
```

The grid is denser than Local's (2/3/4 cols) since cards are mostly thumbnails — more per screen is the right call.

### 6. `index.js` — Remote tab logic

Builds on the existing structure (FSA gate is *not* applied to Remote per the per-surface table — Remote works without FSA). Hooks into the `showTab('remote')` path.

```js
import { isOnline, onChange as onConnectivityChange } from './lib/connectivity.js';
import { loadConfig } from './lib/config.js';
import { createBucketClient } from './lib/bucket.js';
import { reconcile } from './lib/remote-list.js';
```

State held in module scope (single tab, single page):

```js
let remoteAll = [];      // all cached records, sorted lastModified desc
let remoteRendered = 0;  // how many of remoteAll are in the DOM
const PAGE = 30;         // batch size for infinite scroll
```

Boot:
1. On page load, read `gallery_cache` into `remoteAll`, sorted desc.
2. Render the first PAGE.
3. Set up an `IntersectionObserver` watching `#remote-sentinel`; each intersection appends another PAGE.
4. Set `Refresh` button enabled when `hasConfig()` and `isOnline()`. Wire it to `runReconcile()`.
5. Subscribe to `onConnectivityChange` — toggle the offline pill, enable/disable Refresh, run a refresh on online transition.
6. Auto-trigger a reconcile on first Remote tab activation if online + configured.

`runReconcile()`:
- Builds a presigned-aware BucketClient from `loadConfig()`.
- Calls `reconcile(client, prefix, db)`.
- If anything changed, re-reads the cache, re-sorts, and merges into the rendered grid (append new at top, remove deleted card nodes by `[data-key="..."]`).
- Updates `#remote-summary` ("`N objects · last refresh just now`").

### 7. Card markup

Same general shape as Local's card but with the thumbnail front and center. Uses `<img loading="lazy">` plus `presignGet` to populate `src` once the row is added to the DOM.

```js
async function renderCard(record, client) {
  const filename = record.key.split('/').pop();
  const isVideo = /\.(mp4|mov|webm|m4v|avi)$/i.test(filename);
  const col = document.createElement('div');
  col.className = 'col';
  col.dataset.key = record.key;

  const card = document.createElement('div');
  card.className = 'card h-100';
  // Aspect-ratio box for the thumbnail so the grid stays uniform.
  const thumb = document.createElement('div');
  thumb.className = 'ratio ratio-1x1 bg-light';
  if (isVideo) {
    // Show a 🎬 placeholder; real <video> playback is detail-view (#19).
    thumb.innerHTML = '<div class="d-flex align-items-center justify-content-center fs-1">🎬</div>';
  } else {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = filename;
    img.style.objectFit = 'cover';
    // Presign asynchronously so the rest of the card is up immediately.
    client.presignGet(record.key).then((src) => { img.src = src; });
    thumb.appendChild(img);
  }
  card.appendChild(thumb);

  const meta = document.createElement('div');
  meta.className = 'card-body p-2 small text-muted';
  const date = record.lastModified ? new Date(record.lastModified).toLocaleDateString() : '—';
  meta.textContent = `${date} · ${formatBytes(record.size)}`;
  card.appendChild(meta);

  col.appendChild(card);
  return col;
}
```

The `formatBytes` helper from #17 is reused (small refactor — move it to a tiny `lib/format.js` so both tabs share it; or just duplicate the 6 lines for now). I'll **duplicate** for v1 — extracting a one-function module to share `formatBytes` is over-engineering when the function is six lines.

### 8. Offline behavior

When `isOnline()` is false:
- The offline pill (`#remote-offline-pill`) is shown.
- The `Refresh` button is disabled.
- The cards still render from `gallery_cache` — they're already there from the last online session.
- Thumbnail `<img>`s with cached presigned URLs may or may not load depending on whether the SW caches them. Per the architecture the SW does NOT cache media bytes, so offline thumbnails will show as broken images. v1 acceptable; the cards still display metadata. Logging this in *Out of scope* with a note about adding a same-origin proxy/cache layer if it becomes a real problem.

When connectivity transitions back online:
- The pill hides, Refresh re-enables, and we trigger one auto-reconcile to catch up.

### 9. Tests

#### Unit — `tests/lib/remote-list.test.js` (~5 cases)

`reconcile()` is a pure-ish function; we mock `client.list` and use the existing fake-indexeddb pattern.

- **Empty bucket + empty cache**: no upserts, no removals.
- **First sync of a non-empty bucket**: all items end up in cache, all returned in `added`.
- **Bucket adds new keys**: only the new keys appear in `added`; existing records updated for size changes.
- **Bucket removes keys**: missing-from-list keys end up in `removed` and are deleted from cache.
- **Multi-page list**: a fake `list` that returns `continuationToken` on first call exercises the pagination loop.

#### Unit — `tests/lib/bucket.test.js` (1 new case)

- **`presignGet` returns a URL with X-Amz-Algorithm + X-Amz-Signature query params** and the right path. Don't assert exact signature value — depends on timestamp.

#### E2E — `e2e/remote-tab.spec.js` (1 test, plus an offline-toggle assertion)

```js
test('Remote tab renders cards, transitions to offline, refreshes on reconnect', async ({
  page, context,
}) => {
  await page.goto('/setup-storage.html?e2e=1');

  // Pre-populate the bucket: save config + upload 3 files via __test_upload__.
  const keys = [];
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    keys.push(
      (await page.evaluate(async (args) => window.__test_upload__(args),
        { name, content: `content of ${name}`, config: MINIO,
          opts: { contentType: 'text/plain', prefix: MINIO.prefix } })).key,
    );
  }

  // Open Remote tab. Cards appear after auto-reconcile.
  await page.goto('/index.html?tab=remote');
  await expect(page.locator('#remote-grid .col')).toHaveCount(3);

  // Go offline → pill appears, Refresh disabled.
  await context.setOffline(true);
  await expect(page.locator('#remote-offline-pill')).toBeVisible();
  await expect(page.locator('#remote-refresh')).toBeDisabled();
  await expect(page.locator('#remote-grid .col')).toHaveCount(3); // cache still there

  // Back online → pill hides, Refresh enabled.
  await context.setOffline(false);
  await expect(page.locator('#remote-offline-pill')).toBeHidden();
  await expect(page.locator('#remote-refresh')).toBeEnabled();

  // Cleanup.
  for (const key of keys) {
    await page.goto('/setup-storage.html?e2e=1');
    await page.evaluate(async (a) => window.__test_delete__(a),
      { key, config: MINIO });
  }
});
```

Infinite-scroll behavior is hard to e2e-test cleanly with only 3 fixtures; covered indirectly by the `IntersectionObserver` setup. If we want strict coverage we add it later when there's reason to; for now the unit-tested pagination + a working initial render is enough signal.

### 10. Service Worker shell

`lib/remote-list.js` joins `SHELL`. Bump `sw.js` `VERSION` from `v14` → `v15`.

### 11. Verification

1. `make lint` — passes.
2. `make test` — 107 → ~113 unit (5 remote-list + 1 bucket).
3. `make e2e` — 19 → 20 e2e.
4. CI green.

### 12. Commit + close

One commit (`Closes #18`) covering: new `lib/remote-list.js`, `lib/bucket.js` `presignGet` method, `index.html` Remote pane rewrite, `index.js` Remote-tab logic, both new test files, the e2e, `sw.js` version bump, plus `docs/plans/issue-18-remote-tab.md` and the index update.

## Files

**Created:**
- `lib/remote-list.js`
- `tests/lib/remote-list.test.js`
- `e2e/remote-tab.spec.js`
- `docs/plans/issue-18-remote-tab.md` (frozen copy of this plan)

**Modified:**
- `lib/bucket.js` — add `presignGet(key, ttl?)`.
- `tests/lib/bucket.test.js` — one new case for `presignGet`.
- `index.html` — replace Remote pane placeholder with the grid layout.
- `index.js` — Remote tab boot, reconcile, offline pill, infinite scroll.
- `sw.js` — bump `VERSION` to `v15`; add `./lib/remote-list.js` to `SHELL`.
- `docs/plans/README.md` — add #18 to the index.

## Out of scope for this issue (handled later)

- **Sort by `captured-at` instead of `lastModified`.** Needs the worker to write `capturedAt` into `gallery_cache` at upload time (or HEAD on demand). Defer until #14's EXIF/mp4 extractor lands.
- **Detail view + delete.** That's **#19**. v1 cards render but aren't clickable for navigation.
- **Image thumbnails / web-sized derivatives.** We render originals scaled by CSS — fine for hundreds, ugly for thousands of 5 MB photos. Architecture explicitly defers.
- **Offline thumbnail caching.** The SW doesn't cache bucket bytes (range-request issue on videos). Cached cards render with broken thumbs offline; metadata still shows. Acceptable for v1.
- **Date grouping headers** ("Today" / "Last week" / month/year). Cosmetic; defer.
- **Server-side filtering / search.** S3 doesn't natively support filter beyond prefix. We could filter client-side from `gallery_cache`. Defer.
- **Live updates from sync worker.** When the Local tab uploads something, the Remote tab doesn't auto-discover it until next refresh. Trivial to wire via the same BroadcastChannel — defer until users notice.

## Sources / references

- `docs/architecture.md` — *Main page flow* → Remote tab; *IndexedDB stores* (`gallery_cache`); *Capability and connectivity awareness* (offline pill).
- Issue #18 acceptance criteria.
- `lib/bucket.js` (#6) — `list` (paginated) + new `presignGet` here.
- `lib/connectivity.js` (#15) — `isOnline` + `onChange`.
- `lib/db.js` (#3) — `gallery_cache` reads/writes via `tx`.
- `vendor/aws4fetch.js` — `AwsClient.sign(url, { aws: { signQuery: true } })` is what `presignGet` builds on.
