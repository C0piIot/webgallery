# Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (PWA)                                              │
│                                                             │
│  ┌──────────────────┐    ┌────────────────────────────┐     │
│  │  Gallery UI      │    │  Sync Web Worker           │     │
│  │  - lists/views   │    │  - walks folder handles    │     │
│  │  - opens detail  │    │  - hashes new/changed      │     │
│  │  - deletes       │    │  - uploads via SigV4 PUT   │     │
│  └────────┬─────────┘    └──────────────┬─────────────┘     │
│           │                             │                   │
│           ├──────► IndexedDB ◄──────────┤                   │
│           │   - credentials             │                   │
│           │   - sync index              │                   │
│           │     (path,size,mtime→hash)  │                   │
│           │   - gallery cache           │                   │
│           │                             │                   │
│           └─────────► SigV4 signer ◄────┘                   │
│                          │                                  │
│  ┌──────────────────┐    │                                  │
│  │ Service Worker   │    │                                  │
│  │ (offline shell)  │    │                                  │
│  └──────────────────┘    │                                  │
└──────────────────────────┼──────────────────────────────────┘
                           │ HTTPS, signed requests
                           ▼
              ┌────────────────────────────┐
              │  S3-compatible bucket      │
              │  (user-owned)              │
              │                            │
              │  {prefix}/media/           │
              │     {sha256}.{ext}         │
              │    └─ x-amz-meta-*         │
              │       (capture date, name) │
              │                            │
              │  {prefix}/index/           │
              │     YYYY-MM.json           │
              │    (optional, future)      │
              └────────────────────────────┘
```

There is no application server. The PWA is a static bundle. All state lives
either on the user's device (IndexedDB) or in the user's bucket.

## Static bundle (no build step)

- **No bundler, no transpiler.** Plain HTML/CSS/JS shipped as-is. Modern
  browsers — which we already require for the File System Access API —
  handle native ES modules, dynamic `import()`, top-level await, module
  Web Workers, and Service Workers without help.
- **Vendored dependencies.** Anything we need from third parties
  (`aws4fetch` is the only one expected for v1) lives committed under
  `vendor/` as a static `.js` file. Same outcome as bundling, done once
  by hand instead of by a tool every build. Keeps the CSP simple — no
  third-party origins at runtime.
- **No framework.** Vanilla JS modules for the UI. (htmx was on the
  table when we had a server; without one, it doesn't earn its weight.)
- **Cache busting.** The Service Worker controls app-shell versioning:
  bump a constant in `sw.js`, the SW activates a new cache, and clients
  pick up the new files on next load. No need for hashed filenames in
  the static layout.
- **Service Worker.** Hand-written `sw.js` that caches the app shell so
  the gallery loads offline. Does not cache media bytes — those are
  large and the Range requests videos use don't play well with naive SW
  caching.
- **PWA manifest.** Hand-written `manifest.webmanifest`. Installable on
  desktop and mobile.
- **Local dev.** Any static file server (`python -m http.server`,
  `npx serve`, `caddy file-server`). No HMR — refresh the tab. For a
  single-developer app this is fine; if it stops being fine we revisit.
- **Hosting.** Anything static. The bucket itself works (with a website
  endpoint + CloudFront), but GitHub Pages or Cloudflare Pages are easier
  to start with.

If the app outgrows this — many modules, TypeScript, real tree-shaking
needs — adding a build tool later is straightforward; nothing about the
runtime depends on the absence of one.

## Talking to S3

- **SigV4 in the browser.** Use a small SigV4 implementation
  (`aws4fetch` or hand-rolled, ~5 KB) rather than the full
  `@aws-sdk/client-s3` (hundreds of KB). Works against any S3-compatible
  endpoint by configuring `service: "s3"`, the user's region, and the
  endpoint host.
- **One signing seam.** All bucket access goes through a `BucketClient`
  module exposing `put`, `get`, `head`, `list`, `delete`, plus the
  multipart calls (`createMultipartUpload`, `uploadPart`,
  `completeMultipartUpload`, `abortMultipartUpload`). Provider quirks
  (path-style vs virtual-hosted, trailing-slash listing, etc.) are
  isolated here.
- **Multipart uploads** for files above ~50 MB so a dropped connection
  doesn't restart from byte zero. Parts ~8 MB.
- **CORS.** The bucket must be configured to accept the PWA's origin.
  We ship a documented JSON snippet the user pastes into their bucket's
  CORS configuration.

## Object layout

- **Media objects.** `{prefix}/media/{sha256}.{ext}`
  - `{prefix}` is the user-chosen namespace from setup (e.g. `phone`,
    `laptop`). Acts as a per-installation root so multiple devices can
    share a bucket without coordination. Two devices that share a
    prefix merge into one library; under content-addressable keys
    those merges are conflict-free.
  - Content-addressable, so dedup is automatic and re-uploads are no-ops
    *within a prefix*. The same file under two different prefixes is
    two objects.
  - Extension is derived from filename / content-type at upload time so
    the URL is intuitive and browsers infer the right MIME.
  - User-defined metadata set at PUT:
    - `x-amz-meta-filename` — original basename
    - `x-amz-meta-captured-at` — ISO-8601 timestamp from EXIF / mp4
      metadata, when extractable
    - `x-amz-meta-source-path` — the local path the file came from
      (for debugging; optional)
- **No trash prefix.** Deletes are hard `DeleteObject` calls. Recovery is
  the user's responsibility via bucket versioning / object-lock; not an
  app-level concern.
- **Gallery index (future, when needed).** A sharded JSON index under
  `{prefix}/index/YYYY-MM.json` updated as files arrive. Skips full
  `ListObjectsV2` walks on gallery load. Not in v1 — start with listing
  the prefix and caching the result in IndexedDB.

## IndexedDB stores

- `config` — selected provider, endpoint, region, bucket, prefix, access
  key, secret. (Single record.)
- `folders` — `FileSystemDirectoryHandle`s the user has granted access
  to, plus a friendly label.
- `sync_index` — `(path, size, mtime) → sha256` records. The hot path
  for sync: lookup is `O(1)` and decides whether to skip the file.
- `uploaded` — set of `sha256` values known to be in the bucket. Avoids
  redundant `HEAD` calls when two local files share a hash. Refreshed
  periodically from a `ListObjectsV2` walk.
- `gallery_cache` — denormalized list of objects (key, size,
  last-modified, captured-at) for fast gallery rendering. Rebuilt from
  the bucket; treat as cache, not source of truth.

## Sync flow (Web Worker)

1. Worker boots with the credentials and folder handles handed in from
   the main thread.
2. Walk each folder recursively.
3. For each file emit `(path, size, mtime)`. Look up `sync_index`:
   - Hit → file is unchanged since last sync. Skip.
   - Miss → hash the file (streamed through `crypto.subtle.digest`).
4. For the resulting `sha256`, check `uploaded`:
   - Hit → already in bucket; just record `(path, size, mtime) → hash`
     in `sync_index`.
   - Miss → `HEAD {prefix}/media/{sha256}.{ext}`:
     - 200 → object exists; populate `uploaded`, then record in
       `sync_index`.
     - 404 → upload via PUT (or multipart for large files), set the
       metadata headers, then populate both stores.
5. Report progress to the main thread (files seen, files uploaded,
   bytes uploaded). Errors are surfaced per-file and retried with
   backoff; a file that fails repeatedly is reported and the worker
   moves on rather than wedging the whole sync.

## Gallery flow

1. On open, load `gallery_cache` from IndexedDB and render immediately.
2. In the background, run `ListObjectsV2` over `{prefix}/media/`.
   Reconcile with the cache — add new keys, drop missing ones — and
   re-render the delta.
3. Detail view: `<img src="...">` or `<video src="...">` pointing at
   the bucket URL (or a presigned URL if the bucket isn't directly
   readable from the PWA's origin). Capture date and filename come
   from a `HEAD` request, cached.
4. Delete: `DELETE` the object, drop from caches, re-render.

## Why these choices (vs. the previous server-backed design)

- **Operationally simpler.** No host, no DB, no deploy pipeline beyond
  static files.
- **Data lives where the user wants it.** Their bucket, their bytes.
- **Hash-addressable keys + IndexedDB cache** give us dedup and fast
  re-syncs without a metadata DB. The metadata that matters
  (capture date, filename) rides along on the S3 object as user-defined
  headers, so the bucket alone is enough to reconstruct the gallery.

## Known constraints / risks

- **File System Access API is Chromium-only.** Safari and Firefox users
  fall back to manual `<input type="file" multiple webkitdirectory>`
  uploads — works but no automatic re-sync.
- **Credentials in the browser.** XSS on this origin = full bucket
  access. Strict CSP and no third-party runtime JS are non-negotiable.
  The recommended IAM policy is bucket-scoped and excludes
  bucket-creation / billing actions.
- **Listing scales linearly.** Tens of thousands of objects make
  `ListObjectsV2` slow on cold load. Mitigated by IndexedDB caching;
  the sharded `index/YYYY-MM.json` strategy is the eventual answer.
- **Multipart cleanup.** Aborted multipart uploads accrue cost. We ship
  a recommended bucket lifecycle rule (`AbortIncompleteMultipartUpload`,
  N=7 days) for users to apply.
- **Background sync.** Tab-must-be-open is acceptable for v1; full
  background sync needs Service Worker `Background Sync`, which is
  unreliable across browsers.
