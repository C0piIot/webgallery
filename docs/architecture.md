# Architecture

```
┌──────────────────────────────────────────────┐
│  Browser                                     │
│                                              │
│  ┌──────────────┐    ┌────────────────────┐  │
│  │ Gallery UI   │    │  Sync Web Worker   │  │
│  │ (htmx + JS)  │    │  - walks folders   │  │
│  │              │    │  - hashes files    │  │
│  │              │    │  - uploads diffs   │  │
│  └──────┬───────┘    └─────────┬──────────┘  │
│         │                      │             │
│         │  HTML / htmx         │  HTTP+JSON  │
└─────────┼──────────────────────┼─────────────┘
          │                      │
          ▼                      ▼
┌──────────────────────────────────────────────┐
│  Go server (single binary)                   │
│                                              │
│   HTTP handlers ── templates (html/template) │
│        │                                     │
│        ├──► MetadataStore (database/sql)     │
│        │       ├─ SQLite (default)           │
│        │       └─ Postgres (optional)        │
│        │                                     │
│        └──► BlobStore (S3 SDK v2)            │
│                ├─ AWS S3                     │
│                └─ S3-compatible (R2/B2/...)  │
└──────────────────────────────────────────────┘
```

## Server (Go)

- **HTTP layer.** Stdlib `net/http` plus a lightweight router (`chi`).
  Server-renders gallery pages with `html/template`. Returns HTML fragments
  for htmx requests and JSON for the sync client.
- **Storage interfaces.** Two seams the rest of the code talks through:
  - `MetadataStore` — CRUD over the `media` table, hash lookups for dedup.
  - `BlobStore` — `Put(ctx, key, reader)`, `Get(ctx, key) → reader`,
    `Delete`, `PresignGet(key, ttl)`. Backed by `aws-sdk-go-v2/service/s3`
    with a configurable endpoint so non-AWS S3-compatible services work.
- **DB access.** `database/sql` with `sqlc` for typed queries. Schema kept
  to the SQLite/Postgres common subset (no SQLite-only types, no
  Postgres-only features in v1). Migrations via `goose` or
  `golang-migrate`.
- **Config.** Env vars — DB DSN, S3 endpoint/bucket/credentials, listen
  address. No config file in v1.

## Data model (initial)

`media` table:
- `id` (uuid, primary key)
- `content_hash` (sha256 hex, unique) — dedup key
- `storage_key` (string) — object key in the bucket
- `filename` (string) — original basename at upload time
- `content_type` (string)
- `size_bytes` (int64)
- `captured_at` (timestamp, nullable) — from EXIF / mp4 metadata when present
- `created_at` (timestamp) — when the server first saw the file
- `source_path` (string, nullable) — last known path on the user's machine,
  for debugging

Indexes on `content_hash` (unique), `captured_at`, `created_at`.

## API surface (initial sketch)

- `GET /` — gallery view (HTML).
- `GET /media/{id}` — detail page (HTML).
- `GET /media/{id}/file` — 302 to a presigned S3 URL, or stream-through if
  the bucket isn't publicly reachable.
- `POST /api/sync/check` — body: `{ hashes: [...] }`. Returns the subset
  the server doesn't have. Lets the client skip already-backed-up files.
- `POST /api/media` — multipart upload of a single file plus metadata
  (filename, source_path, captured_at if known). Server hashes on the way
  in, dedups, writes to S3, inserts the row.
- `DELETE /api/media/{id}` — removes the row and the object.

## Sync client (browser)

- **Folder picker.** `window.showDirectoryPicker()` returns a
  `FileSystemDirectoryHandle`. Handles are stored in IndexedDB so they
  survive page reloads; the user re-grants permission once per browser
  session via `handle.requestPermission({mode: 'read'})`.
- **Web Worker.** Receives the folder handles, walks them recursively,
  computes SHA-256 of each file (streamed via `crypto.subtle.digest`),
  batches hashes to `POST /api/sync/check`, uploads the unknown ones via
  `POST /api/media`. Reports progress to the main thread.
- **Local state.** IndexedDB tracks per-file hash + last-known-mtime so
  re-scans skip unchanged files quickly.
- **No deletions.** A file disappearing locally never triggers a server
  delete.

## Why these choices

- **Go.** Good fit for streaming uploads, S3 multipart, single-binary
  deployment.
- **SQLite default, Postgres-capable.** SQLite makes "clone, run, done"
  trivial; staying portable means we don't repaint when the dataset grows.
- **htmx over a SPA.** UI is mostly server data + occasional partial
  updates. Avoids the build pipeline tax for a one-person app.
- **File System Access API.** Sidesteps building and shipping a desktop
  sync agent. Tradeoff: Chromium-only desktop browsers in v1.

## Known constraints / risks

- File System Access API isn't in Safari or Firefox. Firefox tracks it but
  ships nothing usable today. Document this clearly in the UI.
- Background sync while the tab is closed isn't reliably available. Sync
  runs while the gallery tab is open; that's fine for v1.
- Hashing large videos client-side is slow. The worker should stream
  through `crypto.subtle.digest` rather than loading whole files into
  memory.
