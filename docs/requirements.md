# Requirements

## Purpose

A self-hosted web app that serves two roles:

1. **Gallery** — browse photos and videos through a web UI.
2. **Backup** — durably store originals from user-selected local folders without
   running a desktop agent.

## In scope (v1)

- **Single user.** No accounts, no multi-tenant isolation. A single deployment
  serves one person.
- **Media types.** Photos and videos. Originals only — no derived thumbnails or
  transcodes.
- **Backup source.** Local folders the user grants access to via the browser's
  File System Access API. A Web Worker walks the folders, hashes files, and
  uploads anything the server doesn't already have.
- **Storage.** SQL database for metadata (default SQLite, but the schema and
  queries must stay portable to Postgres). S3-compatible object storage for
  bytes — works against AWS S3, Cloudflare R2, Backblaze B2, MinIO, etc.
- **Frontend.** Server-rendered HTML from Go templates, vanilla JS for the
  sync client, htmx for interactive bits.

## Out of scope (for now)

- Multi-user, sharing, public links.
- Thumbnails, web-sized derivatives, video transcoding. (May revisit.)
- Background sync while the browser tab is closed. (Service Worker
  Background Sync has tight quotas and platform gaps; defer.)
- Mobile apps. The browser's File System Access API is Chromium-only on
  desktop, so v1 targets Chrome/Edge/Brave.

## Non-functional

- **Idempotent uploads.** Re-running sync over an already-backed-up folder
  must not duplicate or re-upload. Dedup by content hash (SHA-256).
- **Resumable.** Sync can be stopped and restarted; per-file upload state is
  persisted client-side (IndexedDB).
- **No data loss on the read path.** Deletes are explicit user actions; the
  sync client never deletes server-side just because a local file vanished.
- **Storage portability.** Both DB and object-store layers sit behind
  interfaces so a single deployment can be migrated (SQLite → Postgres,
  R2 → S3) without code changes outside the implementation.

## Open questions

- Auth: even single-user deployments will be exposed to the internet. We will
  almost certainly want at least a shared password / basic-auth wrapper before
  anything is public. Tracked as a follow-up.
- Retention / soft-delete: undecided. Probably worth a "trash" state before
  a hard delete reaches S3.
