# Plan — Issue #10: setup-folders.html picker / list / remove

## Context

The user-facing front of `lib/folders.js` (#9). Before this issue the folders page is a placeholder; after it lands, the user can grant the app access to local folders, see what's registered, hand-re-grant a permission that's lapsed, and remove folders they no longer want backed up.

This is the smaller of the two M3 pages — the heavy logic is in `lib/folders.js`. The form mostly orchestrates clicks and renders.

## Approach

### 1. HTML layout — Bootstrap-only, mobile-first

```
[Add folder]  (primary button)
[Add error]   (red text, hidden by default)

[FSA-missing notice]  (alert-warning, hidden when FSA available)

[Folder list]
  - row: <label> + <handle.name> + permission badge + [Re-grant?] + [Remove]
  - ...

[Empty state]  ("No folders configured. Add one to start backup.")
```

Permission badge per row:
- Granted → `badge bg-success` "✓ Granted"
- Prompt / unknown → `badge bg-warning` "⚠ Permission needed"
- Denied → `badge bg-danger` "✗ Permission denied"

The Re-grant button only appears when state is not `granted`. Remove is always present.

### 2. Behavior wiring (`setup-folders.js`)

```js
import './lib/register-sw.js';
import {
  isFsaAvailable, addFolder, listFolders, removeFolder, ensurePermissions,
} from './lib/folders.js';
```

Per-page-load flow:
1. If `!isFsaAvailable()`, show the FSA-missing alert and disable the Add button. List + remove still work for any handles already persisted, even though they're useless without FSA — but disable Re-grant since it can't succeed.
2. Otherwise wire `Add folder` to `onAdd`.
3. Render the list.

#### `onAdd`
```js
async function onAdd() {
  hideError();
  try {
    await addFolder();
    await render();
  } catch (err) {
    if (err.name === 'AbortError') return;   // user dismissed picker
    showError(err.message ?? String(err));
  }
}
```
Cancelling the OS picker throws `AbortError`; we swallow it silently — that's not an error, just "the user changed their mind."

#### `render`
```js
async function render() {
  const folders = await listFolders();
  emptyEl.classList.toggle('d-none', folders.length > 0);
  foldersEl.replaceChildren(
    ...await Promise.all(folders.map(makeRow)),
  );
}
```

#### `makeRow`
Each row reads the handle's permission state via `handle.queryPermission({ mode: 'read' })` (no request — that needs a user gesture and would prompt on every page load otherwise). The state drives the badge + whether the Re-grant button appears.

Rows are built with `document.createElement` calls — no innerHTML for label / handle.name (avoid HTML injection if a label happens to contain `<`).

#### Re-grant + Remove

Event delegation on the list container:
```js
foldersEl.addEventListener('click', (e) => {
  const regrant = e.target.closest('[data-action="regrant"]');
  if (regrant) return onRegrant(Number(regrant.dataset.id));
  const remove = e.target.closest('[data-action="remove"]');
  if (remove) return onRemove(Number(remove.dataset.id));
});

async function onRegrant(id) {
  const f = (await listFolders()).find((x) => x.id === id);
  if (!f) return;
  await ensurePermissions(f.handle);   // user-gesture context
  await render();
}

async function onRemove(id) {
  await removeFolder(id);
  await render();
}
```

`ensurePermissions` is called inside the click handler — that satisfies the user-gesture requirement.

### 3. E2E test hook (`?e2e=1`)

Real `showDirectoryPicker` is essentially undriveable from Playwright (OS-native dialog). The acceptance calls for an `?e2e=1` injection point on `window`.

The synthetic handle has to be **structured-cloneable** for IDB persistence to round-trip — which rules out our `vi.fn`-bearing test handles from #9. The trick: **OPFS handles** (`navigator.storage.getDirectory()`) are real `FileSystemDirectoryHandle`s with internal slots, so they clone correctly *and* their `queryPermission` always returns `'granted'`. Perfect for tests.

The hook in `setup-folders.js`, gated on `?e2e=1`:

```js
if (new URL(location).searchParams.get('e2e') === '1') {
  globalThis.__test_inject_folders__ = async (name) => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getDirectoryHandle(name, { create: true });
    globalThis.showDirectoryPicker = async () => handle;
  };
}
```

E2E spec then does:
```js
await page.goto('/setup-folders.html?e2e=1');
await page.evaluate((name) => window.__test_inject_folders__(name), 'photos-test');
await page.getByRole('button', { name: /add folder/i }).click();
```

The hook short-circuits `showDirectoryPicker` for the next call to return an OPFS subdirectory; the rest of the flow (addFolder → IDB persist → render) runs against real browser primitives.

### 4. E2E tests — `e2e/setup-folders.spec.js`

Three tests:

1. **Empty state visible initially.** Goto page, assert empty-state copy is visible, list is empty.
2. **Add → list → remove.** Inject a fake handle named `photos-test`, click Add, assert row is visible with the right label and a Granted badge, click Remove, assert empty state is back.
3. **Add two, remove one, the other survives.** Confirms event-delegation routes to the right id.

(I'm skipping a "re-grant" e2e test for now — OPFS handles always return `granted`, so we can't realistically exercise a denied-then-regrant flow without much heavier mocking. Re-grant logic is exercised in the `lib/folders.js` unit tests from #9.)

### 5. Service Worker shell

Both `setup-folders.html` and `setup-folders.js` change content; both already in `SHELL`. Bump `sw.js` `VERSION` from `v6` → `v7`.

### 6. Verification

1. **`make lint`** — passes.
2. **`make test`** — 45/45 unit stays green (no unit-test changes for #10).
3. **`make e2e`** — existing 7 (4 smoke + 3 storage) plus 3 new folder tests = 10/10 green.
4. **CI** — push triggers the workflow; lint + unit + e2e all green.

If any test fails, that's the verification — fix and re-run.

### 7. Commit + close

One commit (`Closes #10`) covering: rewritten `setup-folders.html` + `setup-folders.js`, new `e2e/setup-folders.spec.js`, `sw.js` version bump, plus `docs/plans/issue-10-setup-folders.md` and the index update.

## Files

**Created:**
- `e2e/setup-folders.spec.js`
- `docs/plans/issue-10-setup-folders.md` (frozen copy of this plan)

**Modified:**
- `setup-folders.html` — replace placeholder body with Add button, FSA-missing alert, list container, empty state.
- `setup-folders.js` — render, add, regrant, remove flows; `?e2e=1` injection hook.
- `sw.js` — bump `VERSION` to `v7`.
- `docs/plans/README.md` — add #10 to the index.

## Out of scope for this issue (handled later)

- **Capability-aware page gating** beyond a simple alert — the full per-surface explainer panel pattern is **#11**.
- **Re-grant prompting on page load** for folders that need it — better as a Local-tab affordance in **#17** since that's where the user notices the problem.
- **Per-folder rename / label edit** — defer until users ask.
- **Reordering / drag-to-reorder** — defer.
- **Folder-level filters** (e.g. "only files with extension X") — defer.

## Sources / references

- `docs/architecture.md` — *Pages* (`setup-folders.html`); *Capability and connectivity awareness* (per-surface table for FSA-missing fallback).
- `docs/requirements.md` — *Backup source*.
- Issue #10 acceptance criteria.
- `lib/folders.js` (#9) — `isFsaAvailable`, `addFolder`, `listFolders`, `removeFolder`, `ensurePermissions`.
- `docs/plans/issue-04-dev-tooling.md` — `?e2e=1` injection hook convention.
