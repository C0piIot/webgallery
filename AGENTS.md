# Working agreements for agents on this repo

Compact rules. They exist so any AI agent picking up work matches the
conventions the humans already settled. This is not a re-statement of the
architecture doc — see [`docs/architecture.md`](./docs/architecture.md) for
that.

## Plans live in `docs/plans/`

Every issue's approved plan ships as `docs/plans/issue-NN-<slug>.md` in
the same commit that closes the issue. The plan-mode scratch file (under
`~/.claude/plans/...` for Claude Code) is transient and not committed.
Update [`docs/plans/README.md`](./docs/plans/README.md) — the design-log
index — whenever a new plan file lands.

## Keep documentation current

- [`docs/requirements.md`](./docs/requirements.md) and
  [`docs/architecture.md`](./docs/architecture.md) are the source of truth
  for what the app does and how it's built.
- Updates to them ride along with the change that makes them true. Don't
  let docs drift from code; "documentation later" rarely happens.
- The issue tracker holds future work. The design log holds past
  decisions. Together they replace ad-hoc design notes scattered in PR
  threads.

## No build step at runtime

- Anything the served pages import must already be vendored under
  `vendor/` with a pinned version recorded in
  [`vendor/README.md`](./vendor/README.md). Don't link a CDN, don't
  bundle.
- Tests can use Node tooling (Vitest, Playwright); the runtime stays
  buildless.

## UI styling: Bootstrap only

- v1 ships **no app-specific CSS file**. Styling comes from the vendored
  Bootstrap 5 CSS — utilities and components only.
- If a layout can't be expressed with Bootstrap, rethink the layout
  before reaching for custom CSS.
- Icons are Unicode emoji rendered by the OS — no icon font.

## Service Worker shell version

Bump `VERSION` in [`sw.js`](./sw.js) whenever a file in the `SHELL` array
changes — added, removed, or contents changed. Skipping bumps strands
users on stale caches.

## Capability gating

`hasFsa()` from [`lib/capability.js`](./lib/capability.js) is the single
source of truth for "does this browser support File System Access". Any
surface that depends on FSA — the Local tab, the folder-setup page, and
the sync controller (when it lands) — checks `hasFsa()` and falls back
to `renderFsaExplainer(target)` for the standard panel. Don't accumulate
parallel checks elsewhere.

## Issue / commit hygiene

- One coherent chunk per commit. End the commit message with `Closes #N`
  so pushing to `main` auto-closes the issue.
- Pre-commit hook (`make lint test`) is wired up automatically by
  `make install`. Don't `--no-verify` casually.
- Use `make install / test / e2e` locally — same scripts run in CI
  ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)). If it fails
  in CI, it fails in the hook too; reproduce locally before re-pushing.

## Security

- **No third-party origins at runtime.** Vendored files only. Don't link
  a CDN from any HTML, JS, or CSS the browser executes.
- **Never commit secrets.** The repo is public. Credentials live in each
  user's IndexedDB on their device.
- **CSP** must remain origin-only; the user's bucket origin is the only
  allowed `connect-src` / `img-src` / `media-src` exception (configured
  per-installation, not in the static HTML).

---

For deeper context on what we're building and why, start with
[`README.md`](./README.md) and
[`docs/architecture.md`](./docs/architecture.md).
