# Plan — Issue #24: Local-tab media previews (parity with Remote)

## Scope (in / out)

**In**
- Thumbnails on Local cards for status `uploaded` (via bucket presign — same path Remote uses).
- Status placeholder thumbs for in-flight states (pending/hashing/uploading/errored) and videos (`🎬`, like Remote).
- Status badge overlaid on the thumb (corner) so it stays visible.
- Layout parity: `ratio ratio-1x1` thumb + compact metadata, grid cols `2 / 3 / 4`.
- Detail dialog opens from Local card clicks too, **read-only** (no delete button).

**Out (deferred to follow-up)**
- Local FSA `URL.createObjectURL(file)` previews for in-flight items. Requires caching file handles during walk + revoke-on-scroll memory mgmt — separate effort. v1 falls back to placeholder until upload completes.
- Delete from Local detail. Semantically muddy (next sync re-uploads). Remote-tab delete is the canonical path.
- Auto-thumbnailing for video frames.

## Approach

### 1. Lift the bucket client into a shared module-scope cache

Today `client` is built inside `bootstrapRemoteTab` via `maybeBuildClient`. Local needs the same client for presigning. Refactor:

```js
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
```

Both bootstraps call `ensureBucketClient()`. Removes duplication, single point of truth.

### 2. Rework `renderCard` (Local) to match Remote's shape

```html
<div class="col" data-path="...">
  <div class="card h-100">
    <div class="ratio ratio-1x1 bg-light position-relative" data-role="thumb">
      [<img> | <video-placeholder> | <status-placeholder>]
      <span class="badge position-absolute top-0 end-0 m-1" data-role="status"></span>
    </div>
    <div class="card-body p-2 small">
      <div class="text-truncate fw-medium" data-role="filename"></div>
      <div class="text-muted text-truncate" data-role="folder"></div>
      <div class="text-muted">[date · size]</div>
    </div>
  </div>
</div>
```

Filename stays (Local users pick by name). Folder + date+size match the existing meta. Status badge moves from inline to thumb-overlay so it doesn't compete with the filename.

`#local-grid` class: `row-cols-1 row-cols-md-2 row-cols-lg-3` → `row-cols-2 row-cols-md-3 row-cols-lg-4` to match Remote.

### 3. Thumb rendering rules

`renderLocalThumb(thumbEl, record, client)` clears the thumb container, then:

- Videos → `🎬` placeholder regardless of status (we don't auto-thumbnail in v1).
- `status === 'uploaded'` + client + hash + bucketPrefix → presigned `<img>`.
  - Key built via `keyFor(bucketPrefix, record.hash, filename)` (imported from `lib/upload.js` so the thumb path matches the upload path exactly — same `extOf` lowering).
  - On `presignGet` failure, log via `console.warn` (same convention used on the Remote side).
- Anything else → status-emoji placeholder.

Then the status badge (`data-role="status"`) is appended absolutely-positioned in the top-right of the thumb so `applyBadge`'s existing selector still finds it.

Status emoji map: pending/hashing/uploading → `⏳`, errored → `⚠️`, uploaded → `✅` (uploaded has its own image case, but the emoji is the fallback when the hash isn't yet known).

**Per-file thumb refresh on `file-uploaded`** (added during implementation): when the worker finishes uploading a single file, `subscribeBroadcast` calls `refreshCardThumb(path)` which re-reads the record from `sync_index` and re-renders the card. This swaps the `⏳` placeholder for a real preview as soon as each file completes, instead of users staring at placeholders until the entire sync run wraps up. Cheap (one IDB read + one DOM replace per finished file).

### 4. Detail dialog refactor — share between Local and Remote

Currently `wireDetailDialog` lives inside `bootstrapRemoteTab`'s closure (uses `client`, `allRecords`, `headCache`). Pull it out:

```js
function setupDetailDialog() {
  const dialog = document.getElementById('detail-dialog');
  // Generic close + media-stop handlers — set up once.
}

async function openDetail({ key, filename, size, capturedAt, sourcePath, deletable, onDelete }) {
  // Builds dialog content from opts. Hides delete button when !deletable.
}
```

Each tab's card-click handler builds opts and calls `openDetail`:
- Remote: `{ key, filename, size, capturedAt: lastModified, sourcePath: undefined (refined by HEAD), deletable: true, onDelete: ... }`
- Local: `{ key: media-key from hash, filename, size, capturedAt: mtime, sourcePath: record.path, deletable: false }`

`refineFromHead` stays Remote-only (Local already has all the metadata in sync_index). Keeps the refactor narrow.

### 5. Click delegation for Local

Local grid currently has no card-click handler. Add one in `bootstrapLocalTab`:

```js
grid.addEventListener('click', (e) => {
  const col = e.target.closest('.col[data-path]');
  if (!col) return;
  const record = lastRenderedRecords.find(r => r.path === col.dataset.path);
  if (!record || record.status !== 'uploaded') return; // no preview to show
  openDetail({ ...mapToDetailOpts(record) });
});
```

Cards in non-`uploaded` state are non-interactive (cursor stays default); clicking is a no-op.

### 6. Service Worker

`index.js` content changes; `index.html` `class` attribute changes. Both already in `SHELL`. Bump `sw.js` `VERSION` v20 → v21.

## Tests

### Unit — none new
Pure DOM + presign-URL plumbing; no extractable pure logic worth a unit test.

### E2E — extend existing `e2e/local-tab.spec.js`

After the existing two-file sync test, add:

```js
const card = page.locator('#local-grid [data-path="a.txt"]');
await expect(card.locator('[data-role="thumb"] img')).toHaveAttribute(
  'src',
  /amzn|x-amz|http/i,
);
```

Plus a click-to-open assertion:

```js
await card.click();
await expect(page.locator('#detail-dialog[open]')).toBeVisible();
await expect(page.locator('#detail-delete')).toBeHidden(); // read-only from Local
await page.locator('#detail-close').click();
```

## Files

**Created**
- `docs/plans/issue-24-local-previews.md`.

**Modified**
- `index.js` — `ensureBucketClient` lifted; `renderCard` reshape; `setupDetailDialog`/`openDetail` extracted; Local click delegation.
- `index.html` — Local grid `row-cols-*` updated to match Remote.
- `e2e/local-tab.spec.js` — thumb + click-to-open assertions.
- `sw.js` — `VERSION` v20 → v21.
- `docs/plans/README.md` — index entry for #24.

## Verification

1. `make lint` / `make test` — no unit regressions expected.
2. `make e2e` — 27 → 27 (existing test extended, no count change).
3. Manual smoke at deploy: run a sync of a folder with ~10 photos; Local cards show real thumbnails after upload completes; click → dialog shows the same image; close.
4. Network panel: confirm Local thumbnails go through `presignGet` (no Authorization header on `<img>`).

## Risks / open questions

- **Failed presigns repeated per render**: each `refreshGrid` rebuilds cards and re-presigns. Cheap (string-only signing) but noisy in console if the bucket is offline. Acceptable for v1.
- **Order of bootstrap**: `ensureBucketClient()` is async; if Local renders before it resolves, thumbs show placeholders briefly until next refresh. Mitigated by awaiting in both bootstraps before first `refreshGrid` call.
- **First-sync UX**: cards spend their lifetime as `pending → hashing → uploading → uploaded`, only the last state has a thumb. The `refreshCardThumb` hook on `file-uploaded` minimizes the wait — each card flips to a real preview the moment its upload completes, instead of waiting for the whole sync run. Pre-upload phases still show placeholders; the deferred FSA-blob-URL work is the proper fix for those.
