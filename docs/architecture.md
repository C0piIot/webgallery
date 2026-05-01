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
- **Vendored dependencies.** Everything third-party lives committed
  under `vendor/` as static files. v1 vendors:
  - `aws4fetch` — SigV4 signing
  - **Bootstrap 5** CSS + JS bundle — UI framework
  Same outcome as bundling, done once by hand instead of by a tool every
  build. Keeps the CSP simple — no third-party origins at runtime.
- **Icons are emojis.** Status badges, nav, file-type glyphs all use
  Unicode emoji rendered by the OS — no icon font, no SVG sprite, no
  extra vendored asset. Acceptable consistency on Chrome / Android
  (our primary surface).
- **No JS framework; Bootstrap for CSS.** Vanilla JS modules for app
  logic. UI styling and components come exclusively from Bootstrap —
  see *Styling discipline* below. (htmx was on the table when we had
  a server; without one, it doesn't earn its weight.)
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
- **Hosting.** **GitHub Pages on this repository, for v1.** Pulled
  straight from `main` — no separate deploy step, every push is the
  release.
  - On a free GitHub plan, Pages requires the **repo to be public**.
    The repo will be flipped from private to public when we're ready
    to publish; until then, the site is served by running a local
    static file server.
  - The runtime origin will be `https://c0piiot.github.io/webgallery/`
    (or a custom domain later). The bucket's CORS allow-list and the
    documented IAM policy must reference this origin.
  - Other static hosts work without code changes (Cloudflare Pages,
    the bucket itself, etc.) if we ever migrate.

If the app outgrows this — many modules, TypeScript, real tree-shaking
needs — adding a build tool later is straightforward; nothing about the
runtime depends on the absence of one.

## UI structure (multi-page, not SPA)

The app is a small set of plain HTML pages. Each page is self-contained
and bootstrapped by a sibling ES module. Navigation is regular `<a>`
links — browser back/forward and bookmarks work without router code, and
shared state lives in IndexedDB so page reloads don't lose anything that
matters.

**Mobile-first, desktop-acceptable.** Layouts target a phone in
portrait by default (Chrome on Android is the primary surface). Desktop
should render acceptably without bespoke desktop chrome; the goal is
"comfortable on a phone, fine on a laptop," not pixel parity across
form factors. Bootstrap's grid + breakpoint system handles the
phone/desktop split out of the box.

### Styling discipline

All styling is **Bootstrap, only Bootstrap**. v1 ships **no
app-specific CSS file**. If a layout can't be expressed with Bootstrap
utilities and components, the answer is to rethink the layout, not
to start writing custom CSS.

- Use Bootstrap classes for spacing, typography, buttons, forms,
  modals, navs, alerts, badges, cards, the grid, etc.
- Theme via Bootstrap's CSS variables and `data-bs-theme` if we want
  light/dark — no overrides.
- Icons are Unicode emoji inlined in the markup — no icon font.

The goal is to keep CSS surface area at zero for v1. If we hit a real
limit later (we won't, for this UI), we revisit the rule explicitly
rather than accreting one-off styles.

### Pages

- **`index.html`** — main view. Two tabs that share the same infinite
  scroll surface:
  - **Local** — files walked from the configured local folders, each
    rendered with its backup status (uploaded / pending / uploading /
    error). Driven by IndexedDB's `sync_index` plus live updates from
    the sync worker.
  - **Remote** — every object in `{prefix}/media/` in the bucket, sorted
    by capture date. This is the gallery. Local availability of a file
    has no effect on whether it shows here.
  Tab state is reflected in the URL (`?tab=local` / `?tab=remote`) so
  refreshes and bookmarks are stable. If no storage config exists, the
  page redirects to `setup-storage.html`; if no folders are configured,
  the Local tab prompts the user to add some.
- **`setup-storage.html`** — provider, endpoint, region, bucket, prefix,
  credentials. Validates by issuing a test request against the bucket
  before saving.
- **`setup-folders.html`** — picks `FileSystemDirectoryHandle`s,
  re-grants permissions, and lists currently registered folders.

A small shared header in each page exposes nav between the three.

### File layout

```
/index.html                  # main view (Local | Remote)
/index.js                    # bootstrap for index.html
/setup-storage.html
/setup-storage.js
/setup-folders.html
/setup-folders.js
/sw.js                       # Service Worker
/manifest.webmanifest

/lib/db.js                   # IndexedDB wrappers
/lib/config.js               # load/save storage config + prefix
/lib/folders.js              # FSA handle persistence + permission re-grant
/lib/bucket.js               # BucketClient (wraps aws4fetch)
/lib/sync.js                 # worker controller (start/stop, BroadcastChannel)
/lib/sync-worker.js          # the actual Web Worker entry
/lib/capability.js           # FSA-present check (boot-time, cached)
/lib/connectivity.js         # navigator.onLine + online/offline events
/lib/components/             # file-card.js, nav.js, tabs.js, ...

/vendor/aws4fetch.js
/vendor/bootstrap.min.css
/vendor/bootstrap.bundle.min.js
```

No `styles/` directory. If one ever appears in a PR, it's a smell
worth questioning.

Each page's bootstrap script imports only what it needs. The Service
Worker pre-caches the union of these files as the app shell.

### Sync trigger model

The sync worker is started by `index.js` when the main page loads (and
storage + folders are configured). It runs as long as the main page is
open, regardless of which tab is active — so opening the Remote tab
doesn't pause backup. Setup pages don't run sync. Closing or navigating
away from the main page tears the worker down; durable state is in
IndexedDB, so progress is never lost.

If running-only-on-the-main-page proves limiting, a `SharedWorker` is
the natural upgrade path — a single sync instance shared across all
open pages of the app — but we want to validate FSA-handle permission
behavior in that context before committing to it.

## Capability and connectivity awareness

The app is not all-or-nothing. Two runtime conditions gate features:

### Capability check (static, at boot)

A boot-time probe (`'showDirectoryPicker' in window`) sets a flag that
the rest of the app reads. The flag never changes during a session.

| Surface | FSA present | FSA absent |
|---|---|---|
| `index.html` Remote tab | Full functionality | Full functionality |
| `index.html` Local tab | Full functionality | Tab still navigable; renders an explainer panel ("requires Chrome 132+ on Android or desktop"); no folder-walk runs |
| `setup-storage.html` | Full functionality | Full functionality |
| `setup-folders.html` | Full functionality | Renders the same explainer instead of the picker |
| Sync worker | Started when folders configured | Never started |

The header nav stays consistent across capabilities so the user is
never staring at a missing menu item; the disabled surfaces explain
what they need rather than redirect away.

### Connectivity awareness (dynamic, at runtime)

`lib/connectivity.js` exposes a small helper around `navigator.onLine`
plus the `online` / `offline` window events. Subscribers get notified
on transitions; the current value is cheap to read.

- **Sync controller.** On `offline`, gracefully stops the upload
  pipeline (any in-flight PUT is allowed to fail naturally and is
  re-queued). On `online`, resumes from `sync_index` — durable per-file
  state means no work is lost.
- **Remote tab.** When offline, renders from `gallery_cache` and shows
  an "offline" pill in the tab header. `ListObjectsV2` and detail
  metadata fetches are deferred. When online, the cache is reconciled
  in the background.
- **Detail view.** Image / video bytes come from the bucket, so they
  may fail to load offline. The card surfaces an inline placeholder
  with a retry affordance instead of a broken icon.
- **Setup pages.** Function fully offline (they only touch IndexedDB
  and the local file system). The storage-setup "test connection"
  button calls `HEAD` against the bucket; offline → clear error,
  online → real result.
- **Service Worker.** Caches the app shell so the bare site loads
  offline. See *Static bundle* above.

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

The worker is owned by `index.html` (see *Sync trigger model* above). It
posts progress updates to the page on a `BroadcastChannel` so the Local
tab's status badges stay live without polling IndexedDB. The worker is
gated by both capability (FSA present) and connectivity (online); see
*Capability and connectivity awareness* above.

1. Worker boots with the credentials and folder handles handed in from
   the main thread.
2. Walk each folder recursively, **incrementally**: pull batches from
   the directory's async iterator, process each batch, then yield
   before the next pull. Never materialize the full file list. This is
   non-negotiable for Android Chrome — large directories (a real DCIM)
   can hang the browser if walked greedily.
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

## Main page flow

The Local and Remote tabs share the same infinite-scroll surface and the
same file-card component; what differs is the data source and which
fields the card surfaces.

**Remote tab (the gallery).**
1. On open, render from `gallery_cache` in IndexedDB immediately.
2. If online, in the background run `ListObjectsV2` over
   `{prefix}/media/`. Reconcile with the cache — add new keys, drop
   missing ones — and re-render the delta. If offline, skip the
   reconcile and show an "offline" pill in the tab header.
3. Detail view: `<img src="...">` or `<video src="...">` pointing at
   the bucket URL (or a presigned URL if the bucket isn't directly
   readable from the PWA's origin). Capture date and filename come
   from `x-amz-meta-*` on a `HEAD` request, cached. Offline → render
   the card with an inline placeholder + retry affordance.
4. Delete (online only): `DELETE` the object, drop from caches,
   re-render.

**Local tab (backup status).** Works the same online or offline — all
inputs are local. When FSA is unavailable, the tab renders the
explainer panel from *Capability and connectivity awareness* instead.

1. On open, render from the existing `sync_index` records — no new
   filesystem walk needed, the worker keeps these up to date.
2. Each card shows: filename, source folder, size, capture date, and a
   status badge driven by the worker's live messages on the
   `BroadcastChannel`:
   - **Uploaded** — `(path,size,mtime)` resolves to a hash that's in
     `uploaded` (or HEAD returned 200).
   - **Pending** — known but not yet processed by the current worker
     pass.
   - **Uploading** — currently in flight; per-byte progress visible.
   - **Error** — last attempt failed; tooltip carries the reason.
3. The user can retry a single errored file or trigger a full re-walk
   from a control on the tab header.

Both tabs share the same delete affordance on the card. Deleting from
the Local tab only removes it from the bucket; the local file is never
touched.

## Why these choices (vs. the previous server-backed design)

- **Operationally simpler.** No host, no DB, no deploy pipeline beyond
  static files.
- **Data lives where the user wants it.** Their bucket, their bytes.
- **Hash-addressable keys + IndexedDB cache** give us dedup and fast
  re-syncs without a metadata DB. The metadata that matters
  (capture date, filename) rides along on the S3 object as user-defined
  headers, so the bucket alone is enough to reconstruct the gallery.

## Known constraints / risks

- **Target is Chrome on Android (primary) + Chrome on desktop
  (secondary).** Min version: Chrome 132 (January 2025), when File
  System Access shipped on Android stable. Firefox, Safari, and other
  engines are out of scope for *backup* — but the app degrades
  gracefully there: the Remote (gallery) tab and storage setup work
  without FSA, while the Local tab and folder setup show an explainer
  rather than failing or hiding. See *Capability and connectivity
  awareness* for the surface-by-surface table.
- **Large folders can hang Android Chrome.** Per the Chromium
  intent-to-ship, opening a directory with many files (think a real
  DCIM with 10k+ photos) is known to make Android Chrome unresponsive.
  Design rule: the worker walks directories *incrementally* — pulls
  one batch from the async iterator, processes, yields, repeats —
  and never materializes the full file list into memory. Progress
  must be visible from the first batch, not buffered until the walk
  completes.
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
- **Background sync.** Tab-must-be-open is acceptable for v1.
  `Periodic Background Sync` on installed PWAs is a credible v1.1
  follow-up on Chrome Android (lets the SW resume queued uploads on
  occasional wake-ups); fires are opportunistic and throttled, so it's
  a top-up, not a guarantee.
