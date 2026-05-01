# webgallery

A static **Progressive Web App** that doubles as a personal photo/video
gallery and a backup tool. There is no backend — the PWA talks straight to
an S3-compatible bucket the user provides.

Status: early design. No code yet — see [`docs/`](./docs).

- [`docs/requirements.md`](./docs/requirements.md) — what v1 should and
  shouldn't do.
- [`docs/architecture.md`](./docs/architecture.md) — system layout, object
  layout, sync flow, and the tradeoffs.

## How it works (in one paragraph)

The user opens the PWA, picks an S3-compatible provider (AWS, R2, B2,
MinIO, ...), and pastes their endpoint, bucket, and credentials. They grant
the app access to one or more local folders via the File System Access API.
A Web Worker walks those folders, hashes new or changed files, and uploads
them straight to the bucket using SigV4 signing under a user-chosen prefix
— keys are content-addressable (`{prefix}/media/{sha256}.{ext}`) so dedup
is automatic. Two devices that share a prefix merge into one library; two
devices with different prefixes coexist in the same bucket without
stepping on each other. The gallery view lists the prefix and renders
originals.

## Stack (planned)

- Multi-page app — three plain HTML pages (main view, storage setup,
  folder setup), no SPA router. Main view has two tabs: **Local** (files
  from configured folders, with backup status) and **Remote** (the
  bucket gallery, infinite scroll).
- Vanilla JS, no build step. Native ES modules, hand-written Service
  Worker and PWA manifest, third-party deps vendored under `vendor/`.
- Service Worker for offline app shell + PWA installability.
- File System Access API for folder access (Chrome 132+, Android primary
  + desktop secondary).
- IndexedDB for credentials, sync index `(path,size,mtime)→hash`, and
  gallery cache.
- `aws4fetch` (or equivalent ~5 KB SigV4 helper) for direct calls to any
  S3-compatible endpoint.

## Caveats up front

- Chrome on Android (primary) + Chrome on desktop (secondary). Chrome
  132+ required (FSA shipped on Android stable in Jan 2025). Other
  engines are out of scope for v1.
- Mobile-first UI; desktop renders acceptably but isn't optimized for
  pointer interactions or large screens beyond a single breakpoint.
- Credentials live in IndexedDB on the device. Strict CSP and bucket-scoped
  IAM are mandatory; documentation will spell out the recommended policy.
- Sync runs while the tab is open; reliable background-while-closed isn't
  feasible cross-browser today.
