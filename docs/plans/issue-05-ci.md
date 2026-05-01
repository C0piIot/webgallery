# Plan — Issue #5: GitHub Actions CI + pre-commit hook

## Context

#4 just shipped the local toolchain (`make install / test / e2e`) and verified everything green. #5 takes the same `npm` scripts and runs them on every push / PR via GitHub Actions, so a broken main is caught before it lands.

The user added a request beyond #5's original scope: a **pre-commit hook stored in the repo** that runs lint + unit tests on every commit. That gives fast local feedback before push, and ensures whatever we'd catch in CI also gets caught earlier — without forcing every contributor to remember `make test` by hand.

The hook lives at `.githooks/pre-commit` and is activated automatically by appending a `git config core.hooksPath .githooks` line to `make install`. One-time setup, then it's wired up on every clone.

After #5 ships:
- `git commit ...` → hook runs `make lint test`; fails the commit if either is red. Skippable with `--no-verify` for emergencies.
- `git push` / PR → GitHub Actions runs lint + unit + e2e jobs in parallel.
- All three surfaces (local, hook, CI) call the same `npm run lint` / `npm test` / `npm run e2e`.

## Approach

### 1. Add a `lint` script

`package.json` gains:

```json
"scripts": {
  "lint": "find . \\( -path ./node_modules -o -path ./test-results -o -path ./playwright-report \\) -prune -o -name '*.js' -print | xargs -L1 node --check"
}
```

Cheap, no extra deps. `node --check` parses each JS file and reports syntax errors — catches the obvious kind of breakage before any test runs. Acceptance criteria for #5 explicitly says "placeholder is OK if no linter is added yet"; ESLint/Prettier are a later upgrade if/when they're worth their weight.

### 2. `.github/workflows/ci.yml`

Three jobs, parallel, on push to `main` and on `pull_request`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci
      - run: npm run lint

  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci
      - run: npm test

  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - name: Bring up static + MinIO
        run: docker compose up -d static minio minio-init
      - name: Wait for static server
        run: |
          for i in $(seq 1 30); do
            curl -fsS http://localhost:8888 >/dev/null && break
            sleep 1
          done
      - run: npm run e2e
        env:
          PLAYWRIGHT_BASE_URL: http://localhost:8888
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7
```

Decisions baked in:
- **Native Node for `lint` and `unit`.** They don't need static or MinIO — running them on the runner is faster than spinning up Docker every time.
- **`docker compose up` for e2e.** The runner runs Playwright natively but uses our existing compose file to launch `static` and `minio`. Reuses what local already has; no parallel CI-only docker-compose definition.
- **Public-repo Linux minutes are unlimited**, so we don't need to budget. Three parallel jobs is fine.
- **`actions/setup-node` cache: 'npm'** speeds up subsequent runs (~10s saved on `npm ci`).
- **Playwright report uploaded on failure** for debugging from the GitHub UI.

### 3. `.githooks/pre-commit`

A small shell script, executable bit committed:

```sh
#!/bin/sh
# Pre-commit hook — runs lint + unit tests before allowing a commit.
# Wired up by `make install` (sets git core.hooksPath to .githooks).
# Skip in emergencies: git commit --no-verify

set -e
echo "→ pre-commit: lint"
make lint
echo "→ pre-commit: unit tests"
make test
```

Runs through the existing Makefile, which routes to Docker — same toolchain as everywhere else. Cold start is ~3–5 s once images are cached. Acceptable for the safety it buys.

E2E is **not** in the hook — too slow (Docker compose up + Playwright install + browser tests = 30+ s). E2E is what CI is for.

### 4. Auto-wire the hooks via `make install`

The `install` target gains one line so a fresh clone gets the hook automatically once the contributor runs the standard install command:

```make
install:
	docker compose run --rm tools npm install
	git config core.hooksPath .githooks
```

`git config` is a per-repo write, idempotent, harmless on re-run.

### 5. README addition

A short subsection under "Running tests locally":

```markdown
### Pre-commit hook

`make install` configures git to use `.githooks/`. Committing then triggers
`make lint test` — about 5 s once images are cached. Skip with
`git commit --no-verify` only for genuine emergencies.
```

### 6. Verification end-to-end

After implementation:

1. **Local:** `npm run lint` passes (no syntax errors anywhere).
2. **Local:** `make install` reruns and `git config --get core.hooksPath` returns `.githooks`.
3. **Local hook:** trivial commit (e.g., touch a doc file) — hook runs `make lint test`, both pass, commit completes.
4. **Local hook (negative):** introduce a temporary syntax error in a `.js` file — `git commit` blocks; revert, commit succeeds.
5. **Push:** CI runs all three jobs; all green. Hover the commit on GitHub to confirm the green checkmark.
6. **Push (negative, optional):** before merging, push a deliberately broken branch to a draft PR — confirm CI fails on it. Skip if the PR overhead isn't worth it for #5.

If any step fails, that's the verification — fix and re-run.

### 7. `AGENTS.md` + `CLAUDE.md` symlink

Adds an agent-readable guide at the repo root so any AI agent picking up work knows the conventions we've already settled. `CLAUDE.md` is a symlink to it, so Claude Code auto-loads the same file via its native convention while the canonical name stays vendor-neutral.

`AGENTS.md` content (compact, action-oriented — not a re-statement of the architecture doc):

- **Plans live in `docs/plans/`.** Every issue's approved plan ships as `docs/plans/issue-NN-<slug>.md` in the same commit that closes it. The plan-mode scratch file (`~/.claude/plans/...`) is transient.
- **Keep docs current.** `docs/requirements.md` and `docs/architecture.md` are the source of truth; updates to them ride along with the change that makes them true. Update `docs/plans/README.md` when adding a new plan file.
- **No build step at runtime.** Anything the served pages import must already be vendored (`vendor/`) with a pinned version recorded in `vendor/README.md`. Tests can use Node tooling; the runtime stays buildless.
- **Bootstrap only, no app CSS.** UI styling comes from the vendored Bootstrap 5 CSS; v1 ships no app-specific stylesheet. If a layout can't be expressed with Bootstrap utilities and components, rethink the layout.
- **Bump `sw.js` `VERSION`** whenever a file in the SW `SHELL` array changes (added, removed, contents changed). Skipping bumps strands users on stale caches.
- **Issue closure ritual.** One coherent chunk per commit, ending with `Closes #N`. Pre-commit hook (`make lint test`) runs automatically after `make install`; don't `--no-verify` casually.
- **No third-party origins at runtime.** Same-origin only — vendored files only. Don't link a CDN.
- **Never commit secrets.** Credentials live in IndexedDB on each device; the repo is public.

The file ends with a one-line pointer back to `docs/architecture.md` for the deeper context.

`CLAUDE.md` is a git-tracked **symlink** pointing at `AGENTS.md` (`ln -s AGENTS.md CLAUDE.md`). Git stores it as a `120000` mode entry. Linux / macOS resolve it transparently; Windows users with symlink support enabled get the file, others see the symlink target as text — acceptable since we don't target Windows for runtime.

### 8. Commit + close

One commit (`Closes #5`) covering: workflow file, hook file, lint script, Makefile install line, README update, AGENTS.md + CLAUDE.md symlink, and the design log copy at `docs/plans/issue-05-ci.md`.

## Files

**Created:**
- `.github/workflows/ci.yml`
- `.githooks/pre-commit` (executable bit set)
- `AGENTS.md`
- `CLAUDE.md` — symlink to `AGENTS.md`
- `docs/plans/issue-05-ci.md` (frozen copy of this plan, per the convention from #4)

**Modified:**
- `package.json` — add `"lint"` script.
- `Makefile` — append `git config core.hooksPath .githooks` to `install`.
- `README.md` — add the "Pre-commit hook" subsection; brief link to `AGENTS.md`.
- `docs/plans/README.md` — add #5 to the index.

## Out of scope for this issue (handled later)

- **Real linter** (ESLint, Prettier, stylelint) — `node --check` is the placeholder; upgrading is a later cleanup if it earns its weight.
- **Branch protection rules** on GitHub requiring CI to pass — repo-settings change, not a code change. Worth doing once the workflow has a stable green run.
- **Performance baselines, Lighthouse-CI, accessibility checks** — niceties for later.
- **Dependabot / Renovate** — dependency upgrade automation, separate concern.

## Sources / references

- `docs/architecture.md` — *Static bundle*, *Capability and connectivity awareness* (informs what we test).
- Issue #5 acceptance criteria.
- The GitHub Actions docs for `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`.
