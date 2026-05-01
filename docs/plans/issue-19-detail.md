# Plan — Issue #19: Detail view + delete

## Context

Closes M5. Cards in the Remote tab become clickable; tapping one opens a full-size view with the actual image (or video player), the filename + capture-date + size pulled from the object's `x-amz-meta-*` headers, and a Delete affordance. Per the architecture's *No trash prefix* decision, delete is hard — one confirm step → `DeleteObject` → object is gone, gallery_cache is updated, the card is removed.

The architecture explicitly committed to using the **native `<dialog>` element** here (we shipped without Bootstrap's JS bundle in #1, so we can't use `data-bs-toggle="modal"`). `<dialog>` handles backdrop, ESC dismissal, focus trapping, and the top-layer overlay for free in Chrome 132+.

## Approach

### 1. `<dialog>` element in `index.html`

Single `<dialog>` placed at the end of `<body>` so it isn't nested inside any tab pane. Bootstrap utility classes for the inner layout; one small inline `style` for sizing because Bootstrap's grid doesn't apply naturally inside a top-layer dialog.

```html
<dialog id="detail-dialog" class="rounded p-0 border-0"
        style="max-width: min(95vw, 800px); width: 100%;">
  <div class="d-flex justify-content-between align-items-center p-3 border-bottom gap-2">
    <h5 id="detail-filename" class="mb-0 text-truncate flex-grow-1">—</h5>
    <button id="detail-close" type="button" class="btn-close" aria-label="Close"></button>
  </div>
  <div class="p-3">
    <div id="detail-media" class="ratio ratio-16x9 bg-light mb-3">
      <!-- <img>, <video>, or offline placeholder -->
    </div>
    <dl class="row mb-0 small">
      <dt class="col-4 col-sm-3">Captured</dt>
      <dd id="detail-captured" class="col-8 col-sm-9 mb-2">—</dd>
      <dt class="col-4 col-sm-3">Source</dt>
      <dd id="detail-source" class="col-8 col-sm-9 mb-2 text-truncate">—</dd>
      <dt class="col-4 col-sm-3">Size</dt>
      <dd id="detail-size" class="col-8 col-sm-9 mb-0">—</dd>
    </dl>
  </div>
  <div class="d-flex justify-content-end gap-2 p-3 border-top">
    <button id="detail-delete" type="button" class="btn btn-danger" disabled>Delete</button>
    <button id="detail-close-bottom" type="button" class="btn btn-secondary">Close</button>
  </div>
</dialog>
```

Why a single inline style: native `<dialog>` is centered in the top layer by user-agent CSS, but its default width is "shrink-to-fit content," which gives a too-narrow box on desktop. Bootstrap doesn't ship a width utility that applies here. One line; defensible.

### 2. Card click handler

Cards in the Remote grid get a `click` handler that opens the dialog with the card's `record`. The handler is attached once via event delegation on `#remote-grid` (no per-card listener bookkeeping):

```js
grid.addEventListener('click', (e) => {
  const col = e.target.closest('.col[data-key]');
  if (!col) return;
  openDetail(col.dataset.key);
});
```

Cards visually invite clicks: cursor pointer + a subtle hover effect via Bootstrap's `.cursor-pointer`-like behavior. We add `style="cursor: pointer"` on the card root in `renderRemoteCard`.

### 3. `openDetail(key)` flow

```js
async function openDetail(key) {
  const record = remoteAll.find((r) => r.key === key);
  if (!record) return;

  // Reset dialog content to a known state.
  resetDetailDialog();

  // Show what we know synchronously from gallery_cache.
  const filenameFromKey = key.split('/').pop();
  setText('detail-filename', filenameFromKey);
  setText('detail-size', formatBytes(record.size));
  setText('detail-captured',
    record.lastModified
      ? new Date(record.lastModified).toLocaleString()
      : '—');

  // Render media (image or video) with a presigned URL when online.
  await renderDetailMedia(record);

  // Enable Delete only when online + configured.
  document.getElementById('detail-delete').disabled = !isOnline() || !client;

  // Show the dialog.
  document.getElementById('detail-dialog').showModal();

  // Async: HEAD for x-amz-meta-* and refine the displayed metadata.
  if (isOnline() && client) {
    refineFromHead(key).catch(() => { /* keep what we have */ });
  }
}
```

`refineFromHead(key)` runs `client.head(key)`, reads `metadata.filename` / `metadata['captured-at']` / `metadata['source-path']`, and overwrites the dialog fields. In-memory cached on the page module so re-opening the same card doesn't re-HEAD:

```js
const headCache = new Map(); // key -> head result
```

### 4. Media rendering

Helper that picks `<img>` or `<video>` based on the key's extension, populates `src` from a presigned URL, and falls back to an "offline" placeholder when not online:

```js
async function renderDetailMedia(record) {
  const container = document.getElementById('detail-media');
  container.replaceChildren();
  const filename = record.key.split('/').pop();
  const isVideo = /\.(mp4|mov|webm|m4v|avi)$/i.test(filename);

  if (!isOnline() || !client) {
    container.appendChild(offlinePlaceholder());
    return;
  }
  const src = await client.presignGet(record.key);
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

function offlinePlaceholder() {
  const div = document.createElement('div');
  div.className = 'd-flex align-items-center justify-content-center h-100 fs-5 text-muted';
  div.textContent = 'Offline — connect to load preview';
  return div;
}
```

### 5. Delete flow

Native `confirm()` is the simplest path; Playwright handles it via the `dialog` event listener.

```js
document.getElementById('detail-delete').addEventListener('click', async () => {
  const key = currentDetailKey;
  if (!key) return;
  const filename = key.split('/').pop();
  if (!confirm(`Delete ${filename}? This is permanent.`)) return;
  try {
    await client.delete(key);
    await db.del('gallery_cache', key);
    headCache.delete(key);
    document.getElementById('detail-dialog').close();
    // Remove the card and re-derive remoteAll.
    document.querySelector(`#remote-grid [data-key="${cssEscape(key)}"]`)?.remove();
    remoteAll = remoteAll.filter((r) => r.key !== key);
    rendered = Math.min(rendered, remoteAll.length);
    updateEmpty();
    updateSummary();
  } catch (err) {
    alert(`Delete failed: ${err?.message ?? err}`);
  }
});
```

`updateEmpty` / `updateSummary` from #18 are reused — they're closure-scoped inside `bootstrapRemoteTab`, so the delete handler needs to be wired inside that scope (or we hoist them; cleanest is wiring inside).

### 6. Dialog dismissal

Three close paths, all converging on `dialog.close()`:
- Top-right `×` button (`#detail-close`)
- Bottom-right `Close` button (`#detail-close-bottom`)
- Backdrop click — listener checks `e.target === dialog` (native `<dialog>` clicks on backdrop bubble to the dialog with target = dialog itself)
- ESC key — handled by the browser natively

```js
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close();
});
```

### 7. Connectivity awareness inside the dialog

If the user opens the dialog online and connectivity drops while it's open:
- The image is already loaded (browser cached); leave it visible.
- Delete button disables itself via the `connectivity.onChange` subscription that's already wired by `bootstrapRemoteTab`.

If they open the dialog while offline:
- Media container shows the offline placeholder.
- Delete button is disabled.
- HEAD doesn't run; metadata stays at "best-known from cache."

### 8. Tests

#### Unit — none new

The detail-view logic is DOM/dialog-bound; `<dialog>` semantics aren't usefully testable in vitest's Node + happy-dom environment (happy-dom doesn't fully implement the top-layer / `showModal` semantics). The metadata-extraction path is just object-property access on the existing `bucket.head` shape. E2E covers the integrated behavior.

#### E2E — `e2e/detail.spec.js` (1 test)

```js
test('Remote card click → dialog → Delete removes from grid + bucket', async ({
  page,
}) => {
  await page.goto('/setup-storage.html?e2e=1');

  // Save config + upload one file.
  await page.evaluate(async (config) => window.__test_save_config__(config), MINIO);
  const out = await page.evaluate(
    async (args) => window.__test_upload__(args),
    { name: 'pic.txt', content: 'hello',
      config: MINIO,
      opts: { contentType: 'text/plain', prefix: MINIO.prefix } },
  );

  // Open Remote tab; one card should appear after auto-reconcile.
  await page.goto('/index.html?tab=remote');
  await expect(page.locator('#remote-grid .col')).toHaveCount(1);

  // Click the card → dialog opens with filename and Delete button.
  await page.locator('#remote-grid .col').click();
  const dialog = page.locator('#detail-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#detail-filename')).toContainText(/pic/i);
  await expect(dialog.locator('#detail-delete')).toBeEnabled();

  // Accept the native confirm() and click Delete.
  page.once('dialog', (d) => d.accept());
  await dialog.locator('#detail-delete').click();

  // Dialog closes, card gone from grid.
  await expect(dialog).toBeHidden();
  await expect(page.locator('#remote-grid .col')).toHaveCount(0);

  // Bucket-side: HEAD now returns 404 (BucketError).
  await page.goto('/setup-storage.html?e2e=1');
  const headed = await page.evaluate(
    async ({ key, config }) => {
      try {
        await window.__test_head__({ key, config });
        return 'present';
      } catch (e) {
        return e.status === 404 ? 'gone' : `error:${e.status}`;
      }
    },
    { key: out.key, config: MINIO },
  );
  expect(headed).toBe('gone');
});
```

(Single test — opens dialog, asserts metadata + Delete enabled, accepts confirm, asserts grid + bucket both clean afterwards. Offline / dialog-keyboard / etc. are covered by manual smoke; not worth dedicated e2e for v1.)

### 9. Service Worker shell

`index.html` content changes (new `<dialog>`); `index.js` content changes. Both already in `SHELL`. Bump `sw.js` `VERSION` from `v15` → `v16`.

### 10. Verification

1. `make lint` — passes.
2. `make test` — 113/113 unit (no changes).
3. `make e2e` — 20 → 21 e2e (one new `e2e/detail.spec.js`).
4. CI green.

### 11. Commit + close

One commit (`Closes #19`) covering: `index.html` `<dialog>` block, `index.js` detail-view logic + delete handler + card click delegation, the e2e, `sw.js` version bump, plus `docs/plans/issue-19-detail.md` and the index update.

## Files

**Created:**
- `e2e/detail.spec.js`
- `docs/plans/issue-19-detail.md` (frozen copy of this plan)

**Modified:**
- `index.html` — append `<dialog id="detail-dialog">…</dialog>` at the end of `<body>`.
- `index.js` — card click delegation on `#remote-grid`; `openDetail(key)`, `refineFromHead`, media rendering, delete handler, dialog dismissal wiring.
- `sw.js` — bump `VERSION` to `v16`.
- `docs/plans/README.md` — add #19 to the index.

## Out of scope for this issue (handled later)

- **Image zoom / pan / pinch.** v1 just renders the original sized to the dialog's media area. If photos are huge they'll be visible but not zoomable; defer.
- **Video thumbnail / poster frame.** Video element loads the file; first frame appears once buffering kicks in. Generating a server-side poster is a transcode job and explicitly out of v1 scope.
- **Keyboard arrow navigation between cards.** Tap-to-open and ESC-to-close; left/right between adjacent items is a future polish.
- **Persistent metadata cache.** HEAD results live in an in-memory `Map` for the page session; clearing on reload. A persistent metadata field on `gallery_cache` records is a follow-up if/when we want to avoid re-HEAD on cold opens.
- **Bulk delete / multi-select.** v1 deletes one item at a time. Multi-select with a "Delete N selected" toolbar is a future feature.
- **EXIF / mp4 capture-date extraction at upload time** so the dialog's "Captured" field has the real moment-of-capture even before HEAD. The architecture defers this; we read whatever `x-amz-meta-captured-at` contains (from #14's plumbing — currently nothing populates it).

## Sources / references

- `docs/architecture.md` — *Main page flow* → Remote tab steps 3-4 (detail view + delete); *Object layout* (no trash prefix).
- Issue #19 acceptance criteria.
- `lib/bucket.js` (#6 + #18) — `head` (for x-amz-meta-*), `delete`, `presignGet`.
- `lib/db.js` (#3) — `gallery_cache.del` after a successful DeleteObject.
- `lib/connectivity.js` (#15) — `isOnline` + `onChange` for Delete-button gating.
- `index.js` Remote tab section from #18 — `client`, `remoteAll`, `cssEscape` are reused.
