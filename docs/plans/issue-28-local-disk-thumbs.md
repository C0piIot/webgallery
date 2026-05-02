# Plan — Issue #28: Local thumbnails from disk

## Scope (in / out)

**In**
- Local card thumbnails resolve to local files via `URL.createObjectURL` whenever the directory handle's read permission is currently granted.
- Works for **all** statuses (pending/hashing/uploading/errored/uploaded) — not just uploaded — since the path is enough to resolve a handle from the directory tree.
- Falls back to bucket-presigned URL (current behavior) only when:
  - We can't find a folder for the record, or
  - `queryPermission` says permission is no longer granted, or
  - File traversal fails (file moved/deleted).
- Object URLs are revoked when their card is replaced and on `pagehide`, so memory doesn't grow over a long session.

**Out (deferred)**
- User-gesture-driven re-grant prompt for thumbnails. If permission is in `prompt` state, we don't surface a "click to grant previews" button; users still re-grant via the existing Re-walk button. Adding a dedicated UI pattern is its own UX call.
- Hash-vs-disk content drift detection (file edited after sync). Reading bytes to verify is too expensive per render. We trust the path.

## Approach

### 1. Stamp `folderId` on `sync_index` records

Today records carry `folderLabel` only — labels can collide between two folders, so we need an unambiguous link to `folders.id`. Update three writes in `lib/sync-worker.js#processEntry` (pending / uploaded / errored) to include `folderId: folder.id`. Old records without it still resolve via `folderLabel` fallback (next sync upgrades them in place).

### 2. Module-level cache + helpers in `index.js`

```js
let folderCache = null;
async function getFolders() {
  if (folderCache) return folderCache;
  folderCache = await listFolders();
  return folderCache;
}

async function tryLocalObjectUrl(record) {
  if (!record.path) return null;
  const folders = await getFolders();
  const folder = record.folderId != null
    ? folders.find(f => f.id === record.folderId)
    : folders.find(f => f.label === record.folderLabel);
  if (!folder) return null;
  if (typeof folder.handle.queryPermission === 'function') {
    const state = await folder.handle.queryPermission({ mode: 'read' });
    if (state !== 'granted') return null;
  }
  let dir = folder.handle;
  const parts = record.path.split('/');
  const name = parts.pop();
  try {
    for (const p of parts) dir = await dir.getDirectoryHandle(p);
    const fh = await dir.getFileHandle(name);
    const file = await fh.getFile();
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}
```

`queryPermission` is undefined on OPFS handles (which the e2e tests use) — treat that as granted so the existing test infra still works.

### 3. Object-URL lifecycle

Module-level `objectUrls = new Map<path, url>`. `trackObjectUrl(path, url)` revokes the prior URL for that path before stashing the new one. On `pagehide`, iterate and revoke all (cheap defensive cleanup; browsers usually clean up automatically on unload).

### 4. `renderLocalThumb` rewrite

Same signature; body becomes a try-disk-then-bucket flow. Real thumb whenever the disk is reachable, bucket fallback only on permission loss for uploaded items, status-emoji placeholder otherwise.

### 5. Detail dialog: prefer disk too

`openDetail` accepts an optional `localResolve` callback that returns a disk Object URL or null. `renderDetailMedia` calls it first; if it produces a URL, use it. Otherwise presign from the bucket (current Remote behavior). Local cards pass `localResolve = () => tryLocalObjectUrl(record)`. Remote cards omit it.

### 6. SW shell

`index.js` content + `lib/sync-worker.js` content change. Both already in `SHELL`. Bump `sw.js` `VERSION` v21 → v22.

## Tests

### Unit
None new. The disk-resolve helper is DOM-coupled (creates Object URLs) and the test value-add is tiny vs. e2e coverage.

### E2E — update `e2e/local-tab.spec.js`

- The current "thumbnails wired" assertion checks for an `X-Amz-Signature` query param. Update it to assert `src` is a `blob:` URL (what we now expect when OPFS is reachable).
- Network sniff during the Local-tab-only flow asserts no S3 requests for thumbnails — same evidence the disk path is being used and the bucket isn't.
- Detail-dialog `<img>` opened from Local also asserts `blob:` (covers the new `localResolve` plumbing in `renderDetailMedia`).

A separate `setOffline(true)` test was tried but `context.setOffline` cuts localhost too, so the page can't even reload. The "no S3 traffic during normal Local-tab flow" assertion already proves the disk path works independently of the bucket; an offline-specific test would be redundant.

## Files

**Created**
- `docs/plans/issue-28-local-disk-thumbs.md` (this file).

**Modified**
- `lib/sync-worker.js` — add `folderId` to `sync_index` writes (3 sites).
- `index.js` — `getFolders`, `tryLocalObjectUrl`, `trackObjectUrl`, `renderLocalThumb` rewrite, `openDetail({ localResolve })`, `renderDetailMedia` precedence.
- `e2e/local-tab.spec.js` — `blob:` assertion + offline test + no-S3-for-thumbs assertion.
- `sw.js` — `VERSION` v21 → v22.
- `docs/plans/README.md` — index entry for #28.

## Verification

1. `make lint` / `make test` — no unit regressions expected.
2. `make e2e` — extended test still passes; new offline test passes.
3. Manual smoke at deploy with a real bucket: open Local tab in DevTools Network panel; with permission granted, thumbnails resolve to `blob:` URLs and zero S3 GETs go out; airplane mode still shows thumbnails.

## Risks

- **Permission state across reloads**: in Chrome on Android, persistent FSA permissions are still gated by user activation. Likely first reload after closing the tab → `prompt` state → we fall back to bucket. After Re-walk (user gesture), permission goes to granted and subsequent renders use disk. Acceptable; the fallback path keeps thumbs working.
- **Folder cache staleness**: `folderCache` is populated once per page session. If the user adds/removes folders mid-session, the cache could be stale. v1 accepts this; the sync controller rebuilds anyway on rewalk.
