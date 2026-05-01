# Plan — Issue #4: Dev tooling: Dockerfile + compose (tools / static / minio) + Makefile

## Context

`tests/lib/db.test.js` (committed in #3) can't actually run yet — Vitest, `@playwright/test`, and `fake-indexeddb` are dev-tooling deps that #4 is responsible for installing. The user established the constraint up front: **Docker for tooling on the host, no Node required locally**. Same toolchain runs in CI (#5).

After #4 ships:
- `make install` lays down `node_modules` in a named docker volume.
- `make test` runs Vitest against `tests/**/*.test.js` — `lib/db.test.js`'s nine cases turn green.
- `make e2e` brings up a static file server + a MinIO instance and runs Playwright against the live shell — a small smoke spec verifies the three pages and the Local/Remote tab toggle (the smoke E2E that #1 deferred).
- The same `package.json` scripts back the GitHub Actions workflow in #5.

## Versions to pin

Latest stable on npm (verified at planning time):

| Package | Version |
|---|---|
| `@playwright/test` | `1.59.1` |
| `vitest` | `4.1.5` |
| `fake-indexeddb` | `6.2.5` |

The Playwright Docker image tag must match the npm package version exactly (otherwise the bundled browsers diverge). I'll use `mcr.microsoft.com/playwright:v1.59.1-noble` (Ubuntu 24.04 LTS).

## Approach

### 1. `docker-compose.yml`

Three long-running services + one one-shot init container.

```yaml
services:
  tools:
    image: mcr.microsoft.com/playwright:v1.59.1-noble
    working_dir: /repo
    volumes:
      - .:/repo
      - tools_node_modules:/repo/node_modules
    environment:
      PLAYWRIGHT_BASE_URL: http://static:8080
      MINIO_ENDPOINT: http://minio:9000
      MINIO_BUCKET: test-bucket
      MINIO_ACCESS_KEY: minioadmin
      MINIO_SECRET_KEY: minioadmin
    # No depends_on — make targets bring up static/minio for E2E only.

  static:
    image: caddy:2-alpine
    command: caddy file-server --listen :8080 --root /repo
    volumes:
      - .:/repo:ro
    ports:
      - "8080:8080"

  minio:
    image: minio/minio:latest
    command: server /data --console-address :9001
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
      MINIO_API_CORS_ALLOW_ORIGIN: "*"
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio_data:/data

  minio-init:
    image: minio/mc:latest
    depends_on: [minio]
    entrypoint: >
      /bin/sh -c "
      until mc alias set local http://minio:9000 minioadmin minioadmin >/dev/null 2>&1; do sleep 1; done;
      mc mb -p local/test-bucket >/dev/null;
      echo 'minio init complete';
      "

volumes:
  tools_node_modules:
  minio_data:
```

Decisions baked in:
- **CORS via env var**, not `mc admin config`. `MINIO_API_CORS_ALLOW_ORIGIN=*` is recognized by recent MinIO. Server-wide; applies to all buckets/origins. Fine for a local test instance.
- **Repo mounted read-only into `static`**, read-write into `tools`. `tools` writes test artifacts into the repo (Playwright reports), `static` only serves files.
- **`node_modules` lives on a named volume** (`tools_node_modules`). Repo's `node_modules` directory is shadowed inside the container — it never appears on the host.
- **Ports exposed for human use** (8080 / 9000 / 9001); test traffic uses internal service-name DNS (`http://static:8080`, `http://minio:9000`).
- **`tools` has no `depends_on`.** Keeps `make test` fast — it doesn't need static or minio. The Makefile brings them up explicitly for `make e2e`.

### 2. `package.json`

```json
{
  "name": "webgallery",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "e2e": "playwright test",
    "e2e:ui": "playwright test --ui"
  },
  "devDependencies": {
    "@playwright/test": "^1.59.1",
    "fake-indexeddb": "^6.2.5",
    "vitest": "^4.1.5"
  }
}
```

`type: "module"` matches the runtime ESM that lib/db.js and the page bootstraps already use.

### 3. `vitest.config.js`

Minimal, explicit:

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
```

Default Node environment — `db.test.js` doesn't need DOM. Add `happy-dom` later if/when a unit test needs it.

### 4. `playwright.config.js`

```js
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 0,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:8080',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
```

No `webServer` block — the Makefile is responsible for ensuring `static` is up before invoking `npm run e2e`.

### 5. `Makefile`

```make
.PHONY: install test test-watch e2e shell up down clean logs

install:
	docker compose run --rm tools npm install

test:
	docker compose run --rm tools npm test

test-watch:
	docker compose run --rm tools npm run test:watch

e2e:
	docker compose up -d static minio minio-init
	docker compose run --rm tools npm run e2e

shell:
	docker compose run --rm tools bash

up:
	docker compose up -d static minio

down:
	docker compose down

clean:
	docker compose down -v

logs:
	docker compose logs -f
```

### 6. `e2e/smoke.spec.js`

Closes the smoke-E2E item that #1 deferred. Four tests:

```js
import { test, expect } from '@playwright/test';

test('home page loads with active Gallery nav', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Gallery' })).toHaveClass(/active/);
});

test('storage setup page loads with active Storage nav', async ({ page }) => {
  await page.goto('/setup-storage.html');
  await expect(page.getByRole('link', { name: 'Storage' })).toHaveClass(/active/);
});

test('folders setup page loads with active Folders nav', async ({ page }) => {
  await page.goto('/setup-folders.html');
  await expect(page.getByRole('link', { name: 'Folders' })).toHaveClass(/active/);
});

test('Local/Remote tabs switch and update URL', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Remote' }).click();
  await expect(page.getByRole('button', { name: 'Remote' })).toHaveClass(/active/);
  await expect(page).toHaveURL(/[?&]tab=remote/);
});
```

### 7. `.gitignore` additions

Append:

```
# Node + tooling
/node_modules/
/coverage/
/test-results/
/playwright-report/
/.vitest/
```

### 8. `README.md` — "Running tests locally" section

One concise table + a two-step quickstart:

```markdown
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
| `make clean` | `down -v` — wipe volumes (node_modules, MinIO data) |
```

### 9. End-to-end verification

After implementation:
1. `make install` — builds the volume with `node_modules`. Confirms `package.json` is parsed and Playwright/Vitest/fake-indexeddb install cleanly. Also sanity-checks Docker is on the host.
2. `make test` — Vitest discovers `tests/lib/db.test.js`, runs its nine cases. All pass. (This validates issue #3's tests retroactively.)
3. `make e2e` — static + minio + minio-init come up, Playwright runs `e2e/smoke.spec.js`. Four tests pass.
4. `git push` — `Closes #4`, issue auto-closes.

If any of (2), (3) fails, the failure is the verification: the issue isn't done until both green.

### 10. `docs/plans/` — design-log convention

Establishes a permanent home for issue plans in the repo so design rationale lives alongside the code and is browseable on GitHub. Each issue's plan is committed in the same change that closes it.

- `docs/plans/README.md` — one-line convention note + table of contents linking each `issue-NN-<slug>.md`.
- `docs/plans/issue-01-skeleton.md` — backfilled from this conversation's plan for #1 (Vendor Bootstrap CSS + aws4fetch + page shells).
- `docs/plans/issue-02-pwa-manifest-sw.md` — backfilled for #2 (PWA manifest + Service Worker app-shell cache).
- `docs/plans/issue-03-lib-db.md` — backfilled for #3 (`lib/db.js` IndexedDB wrapper + unit test).
- `docs/plans/issue-04-dev-tooling.md` — copy of this plan, frozen at the state that gets approved.

Backfilled plans are reconstructed faithfully from the conversation; structure mirrors the originals (Context / Approach / Files / Verification / Out of scope).

Going forward, the workflow becomes: plan-mode produces the working plan in `~/.claude/plans/...`, and on approval I save the final plan to `docs/plans/issue-NN-<slug>.md` as part of the implementation commit. The transient plan-mode file stays scratch.

## Files

**Created:**
- `docker-compose.yml`
- `package.json`
- `vitest.config.js`
- `playwright.config.js`
- `Makefile`
- `e2e/smoke.spec.js`
- `docs/plans/README.md`
- `docs/plans/issue-01-skeleton.md` (backfill)
- `docs/plans/issue-02-pwa-manifest-sw.md` (backfill)
- `docs/plans/issue-03-lib-db.md` (backfill)
- `docs/plans/issue-04-dev-tooling.md` (this plan)

**Modified:**
- `.gitignore` — append node/tooling section.
- `README.md` — append "Running tests locally" section; brief link to `docs/plans/`.

(`sw.js` does **not** need its `VERSION` bumped. None of the new files are part of the served runtime shell — they're dev-only or docs-only and live outside `SHELL`.)

## Out of scope for this issue (handled later)

- **GitHub Actions workflow** — **#5**. Same `make` / `npm` scripts will back it.
- **Real E2E coverage** for sync, gallery, etc. — covered by the issues that own those features.
- **CI badges, dependabot, etc.** — later polish.

## Sources

- [Playwright @playwright/test on npm](https://www.npmjs.com/package/@playwright/test) — pinned 1.59.1.
- [Vitest on npm](https://www.npmjs.com/package/vitest) — pinned 4.1.5.
- [fake-indexeddb on npm](https://www.npmjs.com/package/fake-indexeddb) — pinned 6.2.5.
