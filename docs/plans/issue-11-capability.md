# Plan — Issue #11: lib/capability.js + graceful FSA-missing gating across surfaces

## Context

The capstone of M3. The architecture doc (`docs/architecture.md` *Capability and connectivity awareness*) commits to a graceful-degradation rule: when File System Access is missing, the Remote tab and storage setup keep working, while the Local tab and folder setup show an *explainer* panel rather than failing or hiding. This issue centralizes the capability check and applies the rule consistently across the three pages.

After this issue:
- `lib/capability.js` is the one place that decides "does this browser support FSA?".
- Every surface that depends on FSA (`index.html` Local tab, `setup-folders.html`) shows the same explainer panel when it's missing — same wording, same component, same look.
- `setup-storage.html` is unaffected.
- `lib/folders.js`'s existing `isFsaAvailable` becomes a re-export so we don't accumulate duplicate checks.

The acceptance also says the sync controller never starts the worker when no FSA. The controller doesn't exist yet (lands with #15), so for #11 we just commit to the rule in the docs and the controller honors it later.

## Approach

### 1. `lib/capability.js`

Two exports, both small:

```js
// Cached on first call so repeat callers don't re-probe globalThis.
let cached;
export function hasFsa() {
  if (cached === undefined) {
    cached = typeof globalThis.showDirectoryPicker === 'function';
  }
  return cached;
}

// Internal — exported only for tests so they can reset between cases.
export function _resetForTesting() {
  cached = undefined;
}

// Renders the standard "FSA missing" panel into the given container,
// replacing its contents. Bootstrap-only markup, zero custom CSS.
export function renderFsaExplainer(target) {
  target.replaceChildren(buildExplainer());
}

function buildExplainer() {
  const div = document.createElement('div');
  div.className = 'alert alert-info mb-0';
  div.setAttribute('role', 'alert');
  div.innerHTML = `
    <h5 class="alert-heading">Backup needs File System Access</h5>
    <p>
      This browser doesn't support the File System Access API, so the app
      can't read your local folders to back them up. The gallery still
      works — you can browse and view what's already in your bucket.
    </p>
    <hr>
    <p class="mb-0 small">
      Use Chrome 132+ on Android or desktop to enable backup.
    </p>
  `;
  return div;
}
```

`innerHTML` is fine here — the strings are static, no user content interpolated.

### 2. `lib/folders.js` — make `isFsaAvailable` a re-export

```diff
- export function isFsaAvailable() {
-   return typeof globalThis.showDirectoryPicker === 'function';
- }
+ export { hasFsa as isFsaAvailable } from './capability.js';
```

Keeps the existing public name (callers of `lib/folders.js` don't break), routes through the capability cache. Updates the JSDoc/comment in folders.js to say "delegates to lib/capability.js".

### 3. `index.html` Local tab

Both tabs already exist as Bootstrap `nav-tabs` (#1). The Local pane currently shows a placeholder:
```html
<div class="tab-pane" id="pane-local">
  <p class="text-muted mb-0">Local backup status — coming soon (see issue #17).</p>
</div>
```

In `index.js`, on bootstrap, check `hasFsa()`. If false, call `renderFsaExplainer(document.getElementById('pane-local'))`. The Remote pane is never touched. The tab buttons stay visible — clicking Local takes you to the explainer, clicking Remote takes you to the (still placeholder) gallery surface. URL `?tab=` behavior untouched.

When FSA is present, leave the placeholder as-is — #17 fills it with real content.

### 4. `setup-folders.html` / `setup-folders.js`

Drop the inline `<div id="unsupported">` alert from #10. Replace with the same panel pattern: when `hasFsa()` is false, the **whole content area below the heading** becomes the explainer (Add button + list + empty state hidden), so the page reads as one consistent message instead of "alert + greyed-out form".

```js
if (!hasFsa()) {
  renderFsaExplainer(document.getElementById('content'));
  return;  // skip the rest of bootstrap
}
// ... existing add/render wiring
```

The HTML wraps the existing list/buttons in a `<div id="content">` so the explainer can replace the whole section in one call.

The `?e2e=1` injection hook from #10 is unchanged (it's not gated on FSA — tests use it to *substitute* `showDirectoryPicker`, which causes `hasFsa()` to return true).

### 5. `setup-storage.html` / `setup-storage.js`

No code changes — that's the point of the per-surface table. Just add a comment in the JSDoc describing the page's intentional FSA-independence.

### 6. Sync controller note

The acceptance asks that the worker never start when FSA is missing. The controller is #15. Add a one-line note in `docs/architecture.md` *Sync trigger model* and `AGENTS.md`: "When `hasFsa()` is false, controllers must not start the worker." We'll honor it in #15. Nothing executable lands here.

### 7. Tests

**Unit — `tests/lib/capability.test.js`** (~5 cases):

```js
import { describe, test, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  delete globalThis.showDirectoryPicker;
  // Set up a minimal DOM-like target for renderFsaExplainer tests.
});
```

- `hasFsa()` returns `false` when `globalThis.showDirectoryPicker` is absent.
- `hasFsa()` returns `true` when present.
- `hasFsa()` is cached — a second call doesn't re-read `globalThis` (tested by reading once, deleting the global, and confirming the second call still returns true).
- `_resetForTesting` clears the cache.
- `renderFsaExplainer(target)` replaces target's contents with an `alert-info` containing the expected heading.

For the `renderFsaExplainer` test, Vitest defaults to Node which has no `document`. Use **`happy-dom`** as the test environment for this single file by adding a comment-pragma at the top:

```js
// @vitest-environment happy-dom
```

Add `happy-dom` to `package.json` `devDependencies`. Tiny dep, ~80KB; tests that don't need DOM stay on the default Node environment.

**Unit — `tests/lib/folders.test.js`**: trivial — the existing `isFsaAvailable` tests already pass; the re-export semantics are covered. No changes.

**E2E — extend `e2e/setup-folders.spec.js`** with one case that exercises the FSA-missing path:

```js
test('shows explainer when File System Access is missing', async ({ page }) => {
  await page.addInitScript(() => {
    delete window.showDirectoryPicker;
  });
  await page.goto('/setup-folders.html');
  await expect(page.getByText(/needs File System Access/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /add folder/i })).toBeHidden();
});
```

**E2E — new `e2e/index-page.spec.js`** (~3 cases):

- `Remote tab still works without FSA` — `addInitScript` deletes `showDirectoryPicker`, goto `/`, click Remote, expect the placeholder/loaded content. (Today the placeholder is fine.)
- `Local tab shows explainer without FSA` — same setup, click Local, expect the explainer.
- `Storage page works without FSA` — `addInitScript` deletes `showDirectoryPicker`, goto `/setup-storage.html`, fill MinIO, click Test connection, expect "Connection OK". Confirms storage truly is unaffected.

Total e2e suite: 10 → ~14 green.

### 8. Service Worker shell

`lib/capability.js` joins `SHELL`. Bump `sw.js` `VERSION` from `v7` → `v8`.

### 9. Verification

1. `make lint` — passes.
2. `make test` — 45 → ~50 unit (5 new in capability.test). Existing tests untouched.
3. `make e2e` — 10 → ~14 green.
4. CI green.

If any test fails, that's the verification — fix and re-run.

### 10. Commit + close

One commit (`Closes #11`) covering: `lib/capability.js`, `tests/lib/capability.test.js`, `lib/folders.js` re-export change, `index.html` (no change) + `index.js` (capability check + explainer call), `setup-folders.html` (wrap content) + `setup-folders.js` (use renderFsaExplainer instead of inline alert), new e2e cases, `package.json` (happy-dom devDep), `sw.js` version bump, plus `docs/plans/issue-11-capability.md` and the index update. Architecture doc gets a small note in *Sync trigger model* about the FSA gate (the per-surface table already exists — just an annotation that the controller honors it).

## Files

**Created:**
- `lib/capability.js`
- `tests/lib/capability.test.js`
- `e2e/index-page.spec.js`
- `docs/plans/issue-11-capability.md` (frozen copy of this plan)

**Modified:**
- `lib/folders.js` — `isFsaAvailable` becomes a re-export of `hasFsa`.
- `index.js` — call `renderFsaExplainer(pane-local)` when `!hasFsa()`.
- `setup-folders.html` — wrap content in `<div id="content">`; drop the inline `#unsupported` alert.
- `setup-folders.js` — use `renderFsaExplainer` on the wrapper instead of toggling the inline alert.
- `e2e/setup-folders.spec.js` — add the explainer-shown-when-FSA-missing case.
- `package.json` — add `happy-dom` to `devDependencies`.
- `sw.js` — bump `VERSION` to `v8`, add `./lib/capability.js` to `SHELL`.
- `docs/architecture.md` — small annotation in *Sync trigger model*: "controller honors `hasFsa()`."
- `AGENTS.md` — one-line bullet on the same rule.
- `docs/plans/README.md` — add #11 to the index.

## Out of scope for this issue (handled later)

- **Sync controller `hasFsa()` enforcement** — the rule lands here in docs; the executable check lives in **#15** when the controller exists.
- **Re-grant prompts on the Local tab** when permission lapses — that's **#17**.
- **Custom-element / web-component refactor** of the explainer panel — current surface is one DOM-injection function, not worth componentizing yet.
- **Capability checks beyond FSA** — multi-capability matrix (BroadcastChannel, Background Sync, OPFS) only earns its weight when we depend on more APIs. Today FSA is the only hard requirement.

## Sources / references

- `docs/architecture.md` — *Capability and connectivity awareness* (per-surface table); *Sync trigger model*.
- `docs/requirements.md` — *Graceful capability fallback*.
- Issue #11 acceptance criteria.
- `lib/folders.js` (#9) — existing `isFsaAvailable` heuristic, now delegated.
- `setup-folders.html` / `setup-folders.js` (#10) — existing inline FSA-missing alert being upgraded.
