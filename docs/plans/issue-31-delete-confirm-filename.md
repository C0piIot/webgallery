# Plan — Issue #31: Delete confirm shows hash instead of friendly filename

## Bug

In the Remote-tab detail dialog, the `confirm()` shown when clicking Delete reads `Delete <hash>.<ext>?` instead of `Delete <original-filename>?`. The dialog *heading* already shows the friendly name (filled async by the `refine` HEAD) but the confirm prompt uses the closure-captured filename from dialog open, which is just the bucket key's last segment (= the hash).

## Fix

In `openDetail`, change the delete-button click handler to read the currently-displayed filename out of `#detail-filename` at click time. Falls back to the captured hash-name if the heading is empty.

```js
deleteBtn.addEventListener('click', () => {
  const displayName = document.getElementById('detail-filename').textContent
    || filename;
  onDelete(key, displayName);
});
```

Same source of truth as what the user is looking at when they click.

## Tests

E2E `e2e/remote-tab.spec.js` gets a new test:

- Upload a known file (`__test_upload__`) with a recognizable name.
- Open Remote tab, wait for the card, click it, wait for the dialog heading to show the friendly name.
- Listen for `page.on('dialog')`, click Delete, assert the dialog message contains the friendly name (not the hash). Dismiss the dialog so the object stays.
- Cleanup via `__test_delete__`.

No unit tests; behavior is DOM-coupled.

## Files

**Created**
- `docs/plans/issue-31-delete-confirm-filename.md` (this file).

**Modified**
- `index.js` — read displayed filename at click time.
- `e2e/remote-tab.spec.js` — new test.
- `sw.js` — `VERSION` v26 → v27.
- `docs/plans/README.md` — index entry for #31.

## Verification

1. `make lint` / `make test` — no unit changes.
2. `make e2e` — new test passes; existing tests unchanged.
3. Manual smoke: click Delete on a remote photo, confirm prompt shows the human filename.
