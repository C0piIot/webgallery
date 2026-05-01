# Plan — Issue #22: Empty / error / loading states sweep

## Context

Last issue in M6 — closes the project's planned scope. The acceptance reads as a checklist of UI states the app should never get wrong: blank screens, swallowed errors, missing offline indicators. Most of the items are *already* handled (#17 Local empty state, #18 Remote empty state + offline pill, #11 FSA explainer, #15 broadcast events for sync errors, #20 update banner). This issue is the **audit + the gaps**, not a from-scratch redesign.

## Audit (what's already covered vs. what isn't)

| Acceptance item | Status |
|---|---|
| **No storage config**: redirect to setup-storage | ❌ missing — today the app loads `/` with disabled buttons everywhere, no clear funnel into setup |
| **No folders configured**: Local tab CTA | ✅ #17 (`empty` div with copy pointing at Folders) |
| **Empty bucket**: Remote tab placeholder | ✅ #18 (`#remote-empty`) |
| **Loading states**: skeleton or spinner | ❌ Remote `Refresh` doesn't visually indicate it's running |
| **Failed connection** (Storage page) | ✅ #8 (alert-danger result pane) |
| **Failed upload** (Local tab cards) | ✅ #15+#17 (⚠️ Error badge with tooltip on the card) |
| **Failed list** (Remote refresh) | ✅ #18 (`updateSummary('refresh failed: …')`) |
| **Errors never silently disappear** | ⚠️ partial — `index.js` has a few `.catch(() => {})` that swallow without notice |
| **Offline pill consistency** across pages | ⚠️ Remote tab has it; **Local tab does not** |
| **Capability explainer reused for FSA-missing surfaces** | ✅ #11 (Local pane + setup-folders) |

So: four real gaps (no-config redirect, Local offline pill, Refresh loading state, swallowed catches) plus a small audit-and-document pass. Skeleton cards are explicitly out of scope — they'd need custom CSS, which violates the no-app-CSS rule from #1.

## Approach

### 1. Welcome funnel: redirect from `/` to setup-storage when no config

`index.js` currently bootstraps the Local + Remote tabs unconditionally. Add a top-of-bootstrap check: if `hasConfig()` is false **and** the page is `index.html` (not setup pages), `location.replace('./setup-storage.html?welcome=1')`. Use `replace` (not `assign`) so the back button doesn't return to a useless gallery.

`setup-storage.js` reads `?welcome=1` and shows a one-line Bootstrap alert above the form: "Welcome — set up your bucket connection to get started." Dismissible (Bootstrap `.alert-dismissible` markup, no Bootstrap JS needed — clicking the close button just removes the element).

### 2. Local-tab offline pill

Mirror Remote's pattern. Add `<span id="local-offline-pill">⚠️ Offline</span>` (Bootstrap `badge bg-warning text-dark d-none`) into the Local tab header alongside the Re-walk / Retry-errored buttons. Wire to `connectivity.onChange` inside `bootstrapLocalTab()` — same handler shape Remote uses. Disable Re-walk while offline (it'd just queue uploads that can't complete).

### 3. Remote refresh loading indicator

In `runReconcile()`, while the call is in-flight:
- Set `refreshBtn.textContent = 'Refreshing…'` and `refreshBtn.disabled = true`.
- Set `summary.textContent = 'Refreshing…'` so users see *something* updating.
- On finish (try/finally), restore the label and the regular summary.

For *cold-load* (`gallery_cache` empty + first auto-reconcile running): the empty-state placeholder remains hidden during the refresh window so users don't see "Nothing in the bucket yet" flash before cards appear.

### 4. Surface sync state reasons in the Local-tab summary

The worker already broadcasts `state: idle, reason: 'no-config' | 'no-folders' | 'completed'` via #15 and the controller's BroadcastChannel re-fan. The Local tab handler in #17 currently ignores the reason. Add:

```js
controller.on('state', (msg) => {
  if (msg.state !== 'idle') return;
  if (msg.reason === 'no-folders') summary.textContent = 'No folders configured. Add one in Folders.';
  if (msg.reason === 'no-config')  summary.textContent = 'No bucket configured. Set it up in Storage.';
  if (msg.reason === 'completed')  refreshGrid(); // existing behavior
});
```

`folder-error` events also currently land in the summary — leave that as-is, it's fine.

### 5. Stop swallowing errors silently

A grep across `index.js` finds three `.catch(() => {})` calls (presigning thumbnails, presigning detail-view media, the install-banner machinery in `lib/install.js`) and one `try { ... } catch {}` (the `client.delete` cleanup in tests). Audit each:

| Site | What we currently swallow | Decision |
|---|---|---|
| Remote card thumbnail presign fails | broken thumbnail, otherwise card OK | Add a single `console.warn` line for developers; don't surface to users (broken `<img>` already signals it). |
| Detail-view media presign fails | already-handled via "Could not sign URL" placeholder | Already correct. No change. |
| `setupUpdateBanner().catch(...)` in `lib/install.js` (and `lib/register-sw.js`) | best-effort PWA wiring | Keep. Logging would be noisy and not actionable. |
| `try { await abortMultipartUpload } catch {}` in `lib/upload.js` | already in error path; abort failure shouldn't override the original | Already correct. No change. |

So this turns out to be a near-no-change item — the swallows are intentional and the user-visible failures are surfaced elsewhere. One `console.warn` line added on the Remote-grid card presign path, the rest documented as audited.

### 6. Service Worker shell

`index.html` + `index.js` content changes; `setup-storage.js` content changes. All already in `SHELL`. Bump `sw.js` `VERSION` from `v18` → `v19`.

## Tests

### Unit — none new

Every change is DOM / connectivity / lifecycle-bound; e2e is the right level.

### E2E — extend three existing files (no new spec file)

**`e2e/index-page.spec.js` — add 1 new test, fix 2 existing:**

- New: **`/ redirects to setup-storage when no config`**. Goto `/` from a fresh context (no IndexedDB), assert URL settles on `/setup-storage.html?welcome=1` and the welcome banner is visible.
- The existing FSA tests (Local explainer + Remote unaffected) now need a `seedConfig` step before `goto('/')` — otherwise the new redirect kicks in. Single helper.

**`e2e/local-tab.spec.js` — add 1 new test:**

- **Offline pill appears on Local tab when offline**. Save config; navigate to `/index.html?tab=local`; toggle Playwright `context.setOffline(true)`; assert `#local-offline-pill` visible + Re-walk + Retry-errored disabled. Toggle back, assert pill hidden + Re-walk enabled.

**`e2e/remote-tab.spec.js` — extend the existing online/offline test:**

- After the back-online assertion, also assert `#remote-refresh` text is `Refresh` (i.e., the label is restored after the reconcile completes — proving the loading-state UX put it back). The transient "Refreshing…" state itself is too brief to assert reliably.

That's 2 new e2e tests, fixture/assertion tweaks on existing ones.

## Files

**Created:**
- `docs/plans/issue-22-states.md` (this file).

**Modified:**
- `index.js` — top-of-bootstrap `hasConfig()` redirect; Local-tab offline pill wiring; Remote `Refresh` loading-state UX; Local-tab state-event reason handling; one `console.warn` on presign failure.
- `index.html` — add `<span id="local-offline-pill">` to the Local tab header.
- `setup-storage.html` — add a `?welcome=1`-gated dismissible alert above the form.
- `setup-storage.js` — read `?welcome=1`, unhide the welcome alert, wire its dismiss button.
- `e2e/index-page.spec.js` — new redirect test + `seedConfig` helper for FSA tests.
- `e2e/local-tab.spec.js` — new offline-pill test.
- `e2e/remote-tab.spec.js` — assert resting Refresh label after reconcile.
- `sw.js` — bump `VERSION` to `v19`.
- `docs/plans/README.md` — add #22 to the index.

## Verification

1. `make lint` — passes.
2. `make test` — unit tests unchanged.
3. `make e2e` — adds redirect + Local offline pill tests.
4. CI green.
5. Manual smoke at deploy: clear site data on the live URL, visit `/`, expect redirect to `/setup-storage.html?welcome=1` with the welcome alert. Configure → arrive at gallery → toggle airplane mode → see Local + Remote pills.

## Out of scope for this issue (handled later)

- **Skeleton cards / shimmer** during initial load. Needs custom CSS (animation keyframes) which we don't ship; current "Refreshing…" text is enough.
- **First-run wizard** that walks through Storage → Folders → Done. Today the user navigates the tabs themselves; a wizard is polish.
- **Toast component** for transient messages. We use `alert` boxes inline; toasts would be nicer but Bootstrap's toast component requires its JS bundle.
- **Per-card retry / dismiss errored** in the Local tab. The bulk "Retry errored" button covers the common case; per-row affordances are a follow-up.
- **Granular progress percent** on uploads. We have a status badge and broadcast events; surfacing per-file `uploaded/total` as a progress bar is polish.
