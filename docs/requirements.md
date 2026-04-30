# Requirements

## Purpose

A static **Progressive Web App** that doubles as:

1. **Gallery** — browse photos and videos that live in the user's own
   S3-compatible bucket.
2. **Backup** — durably store originals from user-selected local folders by
   uploading them straight to that bucket from the browser. No application
   server is involved at any point.

The whole app is a bundle of static files (HTML/JS/CSS + a Service Worker)
hostable on any static host (GitHub Pages, Cloudflare Pages, the bucket
itself, ...).

## In scope (v1)

- **Single user.** No accounts. The user owns the bucket and the IAM
  credentials.
- **Media types.** Photos and videos. Originals only — no derived thumbnails
  or transcodes.
- **Storage.** One S3-compatible bucket the user provides. Tested against
  AWS S3, Cloudflare R2, Backblaze B2, and MinIO.
- **Connection setup.** A first-run screen lets the user pick the provider
  and enter:
  - Endpoint URL (preset for AWS, free-form for others)
  - Region
  - Bucket name
  - Access key ID + secret access key
  - Path-style vs virtual-hosted style (auto-detected per provider, overridable)
  Credentials are stored in IndexedDB on the device and never leave the
  origin.
- **Backup source.** Local folders the user grants access to via the
  File System Access API. A Web Worker walks the folders, hashes new files,
  and uploads them directly to S3 with SigV4 from the browser.
- **Dedup.** Object keys are content-addressable
  (`media/{sha256}.{ext}`). Re-uploading the same file is a no-op.
- **Sync index.** IndexedDB caches `(path, size, mtime) → sha256` so
  re-running sync over an unchanged folder does no hashing and no S3 calls.
  Steady-state cost scales with *changes since last sync*, not library size.
- **Gallery.** Browse, sort by capture date, view individual items.
  Capture date and original filename are stored in S3 user-defined object
  metadata at upload time so they survive a wiped IndexedDB.

## Out of scope (for now)

- Multi-user, sharing, public links.
- Thumbnails, web-sized derivatives, video transcoding. Gallery serves
  originals — fine for hundreds, will need revisiting at thousands.
- Background sync while the browser tab is closed. Service Worker
  Background Sync has tight quotas and platform gaps; sync runs while the
  app is open.
- Cross-browser parity. The File System Access API is Chromium-only on
  desktop, so v1 targets Chrome / Edge / Brave. iOS and Firefox can still
  use the gallery via fallback `<input type="file">` uploads but won't get
  folder sync.
- Any first-party server. The app is purely a static bundle plus the
  user's bucket.

## Non-functional

- **Idempotent uploads.** Content-addressable keys make re-uploads a no-op
  at the protocol level (S3 PUT overwrites with the same bytes). The local
  index avoids the network round-trip in the first place.
- **Resumable.** Sync can be stopped and restarted. The Web Worker reports
  per-file progress; partial multipart uploads should be cleaned up by an
  S3 lifecycle rule the user is asked to configure (documented).
- **No silent deletions.** A file disappearing locally never deletes from
  the bucket. Bucket deletes are explicit user actions in the gallery UI.
- **Storage portability.** All S3 access goes through one signing layer so
  swapping providers means changing endpoint / creds, not code.
- **Recoverable from bucket alone.** If a user clears site data, opening
  the PWA fresh, re-entering credentials, and pointing it at the same
  bucket reconstructs the gallery. The local IndexedDB sync index is a
  cache, not the source of truth.

## Security model

- **Credentials live in IndexedDB on the user's device.** Any XSS on this
  origin reads them. Mitigations:
  - Strict CSP (no inline scripts, no third-party origins).
  - No third-party JS at runtime — bundle dependencies at build time.
  - Document the recommended IAM policy: scope to one bucket, allow only
    `GetObject`, `PutObject`, `ListBucket`, `DeleteObject`, `HeadObject`,
    and the multipart actions; deny everything else.
- **CORS** on the bucket must allow `GET`, `HEAD`, `PUT`, `POST`,
  `DELETE` from the PWA's origin and expose `ETag` and any
  `x-amz-meta-*` headers we read.
- **HTTPS only.** Both the static host and the bucket endpoint.
- **No telemetry, no analytics.** The app talks only to the user's bucket.

## Open questions

- **Multiple devices / browsers.** Single user, but the user might run the
  app from a phone *and* a laptop. We assume infrequent concurrent writes
  and rely on content-addressable keys to make collisions harmless. Index
  refresh strategy across devices is a follow-up.
- **Soft-delete.** Probably worth a "trashed" marker (object tag or move
  to a `trash/` prefix) before a hard delete. Decision deferred.
- **Encryption at rest beyond what S3 provides.** Client-side envelope
  encryption is possible but breaks browser-native playback of videos.
  Out of scope for v1.
