# webgallery

Self-hosted web app that serves as a personal photo/video gallery and a backup
target for selected local folders.

Status: early design. No code yet — see [`docs/`](./docs) for goals and the
intended architecture.

- [`docs/requirements.md`](./docs/requirements.md) — what v1 should and
  shouldn't do.
- [`docs/architecture.md`](./docs/architecture.md) — system layout, data
  model, and the choices behind them.

## Stack (planned)

- Go server, single binary.
- SQL for metadata (SQLite default, Postgres-portable).
- S3-compatible object storage for bytes (AWS S3, R2, B2, MinIO, ...).
- Server-rendered HTML + htmx for the gallery; vanilla JS + a Web Worker
  driving the File System Access API for backup sync.
