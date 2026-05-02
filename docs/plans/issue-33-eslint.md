# Plan — Issue #33: Add ESLint to the lint pipeline

## Goal

Catch undefined references at lint time so #32-style bugs (`ReferenceError: isFsaAvailable is not defined`) fail CI / pre-commit instead of crashing in the user's browser.

## Approach

### 1. Dependencies (dev-only, Docker tools image)

Add to `package.json` devDeps:

- `eslint` (the runner — version 9.x, flat-config era).
- `@eslint/js` (the recommended preset — includes `no-undef`, `no-unused-vars`, `no-unreachable`, etc.).
- `globals` (the standard env-globals dictionary, used per-file).

### 2. Flat config — `eslint.config.js`

Four file groups:

| Files | Globals | Notes |
|---|---|---|
| `index.js`, `setup-*.js`, `help.js`, `lib/*.js` (except `sync-worker.js`) | `browser` | Default — DOM, fetch, IndexedDB, etc. |
| `sw.js` | `serviceworker` | `self`, `caches`, `clients`, no `window`. |
| `lib/sync-worker.js` | `worker` | `self`, `postMessage`, no `window`. |
| `tests/**/*.js`, `e2e/**/*.js`, `playwright.config.js` | `node` + `browser` | Vitest / Playwright runners; tests use both contexts (e.g. e2e fixtures use Node `Buffer`, page evaluations use browser globals). |

Skip: `vendor/**`, `node_modules/**`, `test-results/**`, `playwright-report/**`.

Rules: extend `js.configs.recommended`. Adjust if it surfaces too much:
- Likely `no-unused-vars` will warn on `_`-prefixed variables (e.g. `function (_ev)` patterns) — set `argsIgnorePattern: '^_'` if needed.
- Likely `no-empty` will hit a few empty `catch {}` blocks — those are intentional (swallowed error in best-effort paths). If the count is small (< 5), keep them with `catch { /* intentional */ }` block-comments to satisfy the rule.

### 3. Wire into `make lint`

`package.json` scripts:

```json
"lint": "eslint .",
```

`make lint` is unchanged (it just shells out to `npm run lint`).

`node --check` goes away — ESLint's parser catches syntax errors with much better messages.

### 4. Fix surfaced issues

When the new lint runs against the current tree, expect:

- A handful of `no-unused-vars` flags (legitimately unused parameters or imports). Either delete or prefix with `_`.
- Possible `no-undef` flags in tests where `vi`, `describe`, `test`, `expect` are imported but the linter doesn't know that (we'll handle via the `node` env + Vitest's named imports — should already work).
- Maybe `no-empty` on intentional swallows.

Triage and fix each rather than disabling rules wholesale.

## Tests

No new tests for the linter itself. Verification: 123 unit + 34 e2e still pass after the cleanup pass.

## Files

**Created**
- `eslint.config.js`.
- `docs/plans/issue-33-eslint.md` (this file).

**Modified**
- `package.json` — devDeps + lint script.
- Whatever source files surface lint errors during the cleanup pass.
- `docs/plans/README.md` — index entry for #33.

(No `sw.js` bump — pure tooling change, no shipped JS edits unless a fix is required.)

## Verification

1. `make install` to pull the new devDeps.
2. `make lint` — ESLint runs; tree is clean.
3. `make test` / `make e2e` — still 123 / 34 passing.
4. CI — same flow.
5. Sanity check: temporarily reintroduce the #32 bug (`isFsaAvailable()` somewhere unimported); `make lint` should now fail with `no-undef`.

## Risks

- **Rule noise**: the recommended preset is sane but might surface 30+ findings on first run. Plan to triage in a single pass; if any rule is so noisy it would derail the change, downgrade it to `warn` or disable it with a comment explaining why.
- **Globals coverage**: I might miss a global some file uses (e.g. `URL`, `fetch`, `Blob` are browser globals; the `browser` env should cover them). If something legitimate trips `no-undef`, add the global to the env override rather than disabling the rule.
