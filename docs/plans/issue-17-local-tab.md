# Plan — Issue #17: Local tab — sync_index render + live status badges

## Context

First piece of M5. M4 shipped the full sync engine (#12–#16); #17 turns it into something the user actually sees. The Local tab in `index.html` becomes a card grid of every file the worker has touched, with status badges driven live by the BroadcastChannel events the worker already emits. The same tab also hosts the user-facing controls — **Re-walk** (kick a sync run) and **Retry errored** (re-enqueue every errored path then run again).

Per the architecture's per-surface FSA gate (#11), when `hasFsa()` is false the Local tab keeps showing the explainer panel; nothing in this issue changes that.

## Two small upstream tweaks

### Add `folderLabel` to `sync_index` records

The acceptance asks the card to show the **source folder**. Today's `sync_index` record has `path / size / mtime / hash / status / error / uploadedAt` — no folder reference. The path is relative to the user-selected folder root (e.g. `DCIM/IMG_0001.jpg`), so without the folder's friendly label we can't say "in your *Phone* library."

Smallest fix: `lib/sync-worker.js#processEntry` already takes the `folder` object as part of its outer `for` loop. Pass `folder.label` through and write it into the record. Backward-compat is trivial — old records simply lack the field; the UI renders `—` then.

### Add `controller.rewalk()` to `lib/sync.js`

The current controller is "start once, idempotent." For the Re-walk button we want "kick another run." A new method posts a `start` message; the worker accepts it whenever its state is `'idle'` (i.e., the previous run finished). One-liner.

```js
function rewalk() {
  if (!started) start();
  else send('start', { online: isOnline() });
}
```

Both tweaks are tiny and the right home for them is here, not as a follow-up — they're load-bearing for the UI we're building.

## Approach

### 1. `index.html` — Local pane structure

Replace the placeholder copy with a header strip + card-grid container + empty state. The Remote pane is untouched.

```html
<div class="tab-pane" id="pane-local">
  <div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
    <div id="local-summary" class="text-muted small"></div>
    <div class="btn-group btn-group-sm">
      <button id="local-retry-errored" type="button" class="btn btn-outline-warning" disabled>Retry errored</button>
      <button id="local-rewalk" type="button" class="btn btn-primary" disabled>Re-walk</button>
    </div>
  </div>
  <div id="local-grid" class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-3"></div>
  <div id="local-empty" class="text-muted text-center py-4 d-none">
    Nothing indexed yet. Add a folder in Storage → Folders, then click Re-walk.
  </div>
</div>
```

`row-cols-1 row-cols-md-2 row-cols-lg-3` gives the responsive grid — one column on phones, two on tablet, three on desktop — using only Bootstrap utility classes.

### 2. `index.js` — Local tab logic

Builds on the existing tab-toggle / FSA-gate code. New behavior:

```js
import * as db from './lib/db.js';
import { hasConfig } from './lib/config.js';
import { hasFsa } from './lib/capability.js';
import { createSyncController } from './lib/sync.js';
```

Page boot extension (under the existing `if (!hasFsa())` branch — only runs when FSA is present):

```js
const controller = createSyncController();
const grid    = document.getElementById('local-grid');
const empty   = document.getElementById('local-empty');
const summary = document.getElementById('local-summary');
const rewalkBtn = document.getElementById('local-rewalk');
const retryBtn  = document.getElementById('local-retry-errored');

await renderLocal();
wireControls();
subscribeBroadcast();
```

`renderLocal()` reads every `sync_index` row, sorts by `mtime` desc (proxy for capture date — the real EXIF/mp4 extractor is a future issue; the architecture's *Object layout* notes capture-date is set "when extractable"), and rebuilds the grid. Empty state shows when zero rows.

`wireControls()` enables both buttons whenever the bucket is configured (`hasConfig()`); wires `local-rewalk` → `controller.rewalk()` and `local-retry-errored` → iterate sync_index for errored paths, post `controller.retry(path)` for each, then `controller.rewalk()`.

`subscribeBroadcast()` calls `controller.on('*', onEvent)` once. The handler dispatches per event type:

| Event | DOM update |
|---|---|
| `state` | Updates `#local-summary` and the Re-walk button label/disabled. |
| `walking` | Re-renders only when new paths appear (we'll skip re-render if no new rows; cheaper just to re-read sync_index periodically — see below). |
| `progress` | Sets the badge on the matching card to ⏳ Hashing / ⬆️ Uploading. Optionally sets a tiny progress bar for `phase: uploading` when `total` is known. |
| `file-retry-scheduled` / `file-retry` | Sets badge to ⏳ Retrying (with a tooltip on the message). |
| `file-uploaded` | Sets badge to ✅ Uploaded; flips status. |
| `file-error` | Sets badge to ⚠️ Error; tooltip = error message. |
| `folder-error` | Updates summary to flag the bad folder; doesn't crash a card lookup. |

Card lookup uses `data-path` attributes. When an event arrives for a path not yet in the grid (a *new* file just hashed/uploaded), the handler appends a fresh card. Full re-render is reserved for explicit Re-walk completion.

### 3. Card markup

Tiny generator function:

```js
function renderCard(record) {
  const filename = record.path.split('/').pop();
  const folder = record.folderLabel ?? '—';
  const date = record.mtime ? new Date(record.mtime).toLocaleDateString() : '—';
  const size = formatBytes(record.size);
  const card = document.createElement('div');
  card.className = 'col';
  card.dataset.path = record.path;
  card.innerHTML = `
    <div class="card h-100">
      <div class="card-body p-3">
        <div class="d-flex justify-content-between align-items-start gap-2">
          <h6 class="card-title mb-1 text-truncate" title="${escape(filename)}">${escape(filename)}</h6>
          <span class="badge" data-role="status"></span>
        </div>
        <div class="text-muted small mb-0">
          <div class="text-truncate" title="${escape(folder)}">${escape(folder)}</div>
          <div>${date} · ${size}</div>
        </div>
      </div>
    </div>
  `;
  setBadge(card, record.status, record.error);
  return card;
}
```

Bootstrap classes only. `escape()` sanitizes filename / folder / error message (paths aren't user-trusted enough to inject raw — this is a backup tool, but safety is cheap).

`setBadge(card, status, error?)` swaps `bg-secondary / bg-success / bg-warning / bg-danger` plus emoji + label and `title` (tooltip) for the error case.

```js
const BADGES = {
  pending:    { cls: 'bg-secondary',           text: '⏳ Pending'   },
  hashing:    { cls: 'bg-secondary',           text: '⏳ Hashing'   },
  uploading:  { cls: 'bg-info text-dark',      text: '⬆️ Uploading' },
  retrying:   { cls: 'bg-warning text-dark',   text: '⏳ Retrying'  },
  uploaded:   { cls: 'bg-success',             text: '✅ Uploaded'  },
  errored:    { cls: 'bg-danger',              text: '⚠️ Error'    },
};
```

`formatBytes(n)` is a 6-line helper returning `'1.2 MB'`-style strings.

### 4. Service Worker shell

`lib/sync.js` and `lib/sync-worker.js` already in `SHELL`. The new content is in `index.js` / `index.html` (also already in `SHELL`). Bump `sw.js` `VERSION` from `v13` → `v14` since their bytes change.

### 5. Tests

#### Unit — none new

The Local-tab logic is DOM-bound and the data path it consumes (sync_index reads, BroadcastChannel events) is already covered by `db.test.js` and `sync-worker.test.js`. Adding heavy DOM-driven unit tests for one page's UI bookkeeping is low ROI; e2e is the right level for this feature.

The single existing change to a unit test: `tests/lib/sync-worker.test.js`'s "happy path" already inspects sync_index records — it should also now see `folderLabel: 'photos'`. Adjust that assertion (or `toMatchObject` it so the field is optional).

#### E2E — `e2e/local-tab.spec.js` (1 test)

Reuses the patterns from `e2e/sync.spec.js`. Setup → run sync → switch to index.html?tab=local → verify cards.

```js
test('Local tab shows a card per file with the right badges after a sync', async ({ page }) => {
  await page.goto('/setup-storage.html?e2e=1');

  // Save MinIO config + seed an OPFS folder + clear sync_index.
  await page.evaluate(async (args) => {
    await window.__test_save_config__(args.config);
    await window.__test_clear_sync_index__();
    await window.__test_seed_folder__({
      folderName: 'local-tab-test',
      files: [
        { name: 'a.txt', content: 'alpha' },
        { name: 'b.txt', content: 'bravo' },
      ],
    });
  }, { config: MINIO });

  // Run sync to completion.
  await page.evaluate(() => window.__test_sync_run__());

  // Navigate to Local tab and assert two cards with Uploaded badges.
  await page.goto('/index.html?tab=local');
  await expect(page.locator('#local-grid .col')).toHaveCount(2);
  await expect(page.locator('[data-path="a.txt"] [data-role="status"]'))
    .toContainText(/uploaded/i);
  await expect(page.locator('[data-path="b.txt"] [data-role="status"]'))
    .toContainText(/uploaded/i);

  // Cleanup — delete uploaded objects via __test_delete__ ...
});
```

(One e2e test is plenty for this — the live-update path is exercised by the sync e2e via BroadcastChannel; the Local tab just *renders* what's already proven correct.)

### 6. Service Worker bump

Reasoning above — bump to `v14`.

### 7. Verification

1. `make lint` — passes.
2. `make test` — 107/107 unit (one assertion adjustment in sync-worker.test.js).
3. `make e2e` — 18 → 19 e2e (one new `e2e/local-tab.spec.js`).
4. CI green.

### 8. Commit + close

One commit (`Closes #17`) covering: the upstream tweaks (sync-worker `folderLabel`, controller `rewalk`), `index.html` Local pane rewrite, `index.js` Local tab logic, the new e2e, sync-worker test adjustment, `sw.js` version bump, plus `docs/plans/issue-17-local-tab.md` and the index update.

## Files

**Created:**
- `e2e/local-tab.spec.js`
- `docs/plans/issue-17-local-tab.md` (frozen copy of this plan)

**Modified:**
- `lib/sync-worker.js` — `processEntry` writes `folderLabel` into `sync_index` records.
- `lib/sync.js` — add `controller.rewalk()`.
- `index.html` — replace the Local pane placeholder with summary + buttons + grid + empty state.
- `index.js` — render cards, wire buttons, subscribe to BroadcastChannel events, live-update badges.
- `tests/lib/sync-worker.test.js` — adjust the happy-path assertion to expect (or accept) `folderLabel` on the record.
- `sw.js` — bump `VERSION` to `v14`.
- `docs/plans/README.md` — add #17 to the index.

## Out of scope for this issue (handled later)

- **EXIF / mp4 `capturedAt` extraction.** Architecture says "when extractable"; nobody extracts yet. We sort by `mtime` (file system last-modified) which is a fine proxy for fresh photos. Future issue can fill `capturedAt` in `sync_index` and switch the sort key.
- **Per-file progress bar** for the `progress` event with `uploaded/total`. Card shows the badge state; the percentage display is a polish pass — defer until users ask.
- **Manual per-row Retry / Skip buttons.** "Retry errored" is bulk; per-row is a nice-to-have. Defer.
- **Virtualized grid for 10k+ files.** Today's renderer is a simple build-all-cards pass. With ~hundreds of records it's fine; an IntersectionObserver-driven virtualization or pagination is the answer at scale. Same call as the Remote tab in #18.
- **"X of Y uploading" live counters in the summary.** Will fall out trivially from the broadcast event subscription if someone wants it; not in v1.
- **Card click → detail view.** The detail view is for the Remote tab (#19). Local tab cards are read-only status indicators.

## Sources / references

- `docs/architecture.md` — *Main page flow* → Local tab; *Capability and connectivity awareness*; *IndexedDB stores* (`sync_index`).
- Issue #17 acceptance criteria.
- `lib/sync.js` (#15) — controller; we add one method here.
- `lib/sync-worker.js` (#15) — emits the events the tab subscribes to; one field added to records here.
- `lib/db.js` (#3) — `iterate('sync_index', cb)` for the initial render.
- `lib/capability.js` (#11) — `hasFsa()` continues to gate the tab.
- `lib/config.js` (#7) — `hasConfig()` decides whether the Re-walk button is enabled.
