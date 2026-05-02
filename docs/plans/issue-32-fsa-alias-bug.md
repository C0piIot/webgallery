# Plan — Issue #32: `isFsaAvailable is not defined` in setup-folders

## Bug

`setup-folders.js:92` references `isFsaAvailable()` without importing it. Throws `ReferenceError` whenever a folder row renders in a state that isn't `granted`. Surfaces on Chrome Android where permission state expires more aggressively across page loads.

## Root cause + fix

CLAUDE.md says `hasFsa()` from `lib/capability.js` is the single source of truth for FSA capability detection. The `isFsaAvailable` re-export from `lib/folders.js` is a leftover alias that nothing should still be using. `setup-folders.js` already imports `hasFsa` — the call site just used the wrong name.

Three changes:

1. `setup-folders.js:92` — `isFsaAvailable()` → `hasFsa()`.
2. `lib/folders.js` — drop the re-export line (`export { hasFsa as isFsaAvailable }`).
3. `tests/lib/folders.test.js` — drop the two tests covering the alias. `hasFsa` itself is already tested in `tests/lib/capability.test.js` (6 tests).

## Tests

No new tests. Existing 34 e2e + the surviving folders unit tests cover the fix path. The bug was caught by a real device, not by tests, because:

- The `state !== 'granted'` branch only fires when permission is missing/prompt; e2e tests use OPFS which is always granted.
- `node --check` lint won't catch undefined references; that's a runtime issue, and we don't run a JS linter beyond syntax.

A future hardening pass might add `eslint --rule no-undef: 'error'` to catch this at CI; out of scope for this fix.

## Files

**Created**
- `docs/plans/issue-32-fsa-alias-bug.md` (this file).

**Modified**
- `setup-folders.js` — call `hasFsa()`.
- `lib/folders.js` — drop the alias re-export.
- `tests/lib/folders.test.js` — drop the two alias-smoke tests.
- `sw.js` — `VERSION` v27 → v28.
- `docs/plans/README.md` — index entry for #32.

## Verification

1. `make lint` / `make test` — passes (down from 125 → 123 unit tests after dropping the two alias tests).
2. `make e2e` — 34 still pass.
3. Manual: open setup-folders on Chrome Android with a previously-added folder; the page should render the Re-grant button without throwing.
