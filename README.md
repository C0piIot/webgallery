# webgallery

A static **Progressive Web App** that doubles as a personal photo/video
gallery and a backup tool. There is no backend — the PWA talks straight to
an S3-compatible bucket the user provides.

Status: early design. No code yet — see [`docs/`](./docs).

- [`docs/requirements.md`](./docs/requirements.md) — what v1 should and
  shouldn't do.
- [`docs/architecture.md`](./docs/architecture.md) — system layout, object
  layout, sync flow, and the tradeoffs.
- [`docs/plans/`](./docs/plans/) — per-issue design log: the plan that was
  approved before each issue's implementation.

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
- **Bootstrap 5** for all UI styling. No app-specific CSS file —
  Bootstrap utilities and components only.
- Service Worker for offline app shell + PWA installability.
- File System Access API for folder access (Chrome 132+, Android primary
  + desktop secondary).
- IndexedDB for credentials, sync index `(path,size,mtime)→hash`, and
  gallery cache.
- `aws4fetch` (~5 KB) for SigV4 signing direct to any S3-compatible
  endpoint.
- **Hosted on GitHub Pages off `main`** — every push is the release.
  Requires the repo to be public on a free GitHub plan.

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

## Running tests locally

All test commands run inside Docker — no Node required on the host.

```sh
make install   # one-time: install dev deps into a docker volume
make test      # Vitest unit tests
make e2e       # Playwright E2E (brings up static + minio)
```

| Target | What it does |
|---|---|
| `make install` | `npm install` inside the `tools` container |
| `make test` | Run Vitest unit tests |
| `make e2e` | Bring up static server + MinIO, run Playwright |
| `make shell` | Open a bash shell in the `tools` container |
| `make up` / `make down` | Start / stop the long-running services |
| `make clean` | `down -v` — wipe volumes (`node_modules`, MinIO data) |

The static server is exposed on host port **8888** by default
(http://localhost:8888 once `make up` is running). Override with
`WEBGALLERY_STATIC_PORT=...` if 8888 is taken on your machine. MinIO is on
**9000** (S3 API) and **9001** (admin console).

### Pre-commit hook

`make install` configures git to use `.githooks/`. Committing then
triggers `make lint test` — about 5 s once images are cached. Skip with
`git commit --no-verify` only for genuine emergencies.

### Working on this repo (incl. AI agents)

Conventions for everyone — humans and AI agents — live in
[`AGENTS.md`](./AGENTS.md). Read it before opening a PR. (`CLAUDE.md` is a
symlink to the same file so Claude Code picks it up automatically.)
