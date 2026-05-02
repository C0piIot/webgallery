# Plan — Issue #23: SW update banner "Reload" leaves the banner stuck

## Bug

After a deploy bumps `sw.js` `VERSION`, the "A new version is available." banner appears, but clicking **Reload** doesn't clear it — the banner reappears immediately, and the page is still served by the old SW. Reported during manual smoke after the v18→v19 bump in #22.

## Root cause

`lib/register-sw.js:60` wires the button to `location.reload()`. There is no handshake with the waiting SW, and `sw.js` has no `message` listener for `SKIP_WAITING`. Sequence:

1. New SW installs → `waiting` (old SW still controls clients).
2. User clicks Reload → soft reload preserves the controller → old SW serves the precached old shell.
3. New SW remains `waiting`. Page bootstraps; `reg.waiting` still truthy → banner shown again.

CSP / scope / cache headers were ruled out — this is purely a missing handshake.

## Fix (the standard PWA dance)

1. **`sw.js`** — add a `message` listener:

   ```js
   self.addEventListener('message', (event) => {
     if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
   });
   ```

   Combined with the existing `self.clients.claim()` in the activate handler, this is enough for the new SW to take over in-flight clients.

2. **`lib/register-sw.js`** — pass the waiting worker into `showBanner` and rewrite the click handler:

   ```js
   btn.addEventListener('click', () => {
     btn.disabled = true;
     btn.textContent = 'Reloading…';
     navigator.serviceWorker.addEventListener(
       'controllerchange',
       () => location.reload(),
       { once: true },
     );
     waiting.postMessage({ type: 'SKIP_WAITING' });
   });
   ```

   Reloading *before* `controllerchange` would just re-serve the old shell from the still-active old SW. The `{ once: true }` guard prevents it firing on later natural controllerchanges.

3. **Bump `VERSION`** v19 → v20 since `sw.js` content changed.

## Tests

### Unit — none

The change is pure SW lifecycle wiring; e2e is the right level.

### E2E — new `e2e/sw-update.spec.js`

Exercises the full real-world flow against the actual `sw.js` + `register-sw.js`. The challenge is forcing Chrome to detect a new version mid-test:

- Tried `page.route` / `context.route` to swap the served body — `reg.update()` doesn't reliably re-fetch through the route in headless Chromium (`installing`/`waiting` stay undefined; only the initial install fetch goes through the handler).
- Settled on **mutating `sw.js` on disk** during the test. Python's `http.server` reads the file fresh on each request, so the next `reg.update()` sees different bytes and the SW lifecycle proceeds normally. `beforeEach` snapshots the original; `afterEach` restores it unconditionally so a failure can't leave `sw.js` corrupted.

Test asserts:
- Banner appears after the bump.
- Clicking Reload triggers a page reload.
- After reload, no banner is present (no longer a waiting worker).
- `navigator.serviceWorker.controller.scriptURL` ends in `sw.js` (sanity check that the swap actually happened — guards against false-positive where the page reloaded but the SW didn't change).

## Files

**Created:**
- `docs/plans/issue-23-sw-update.md` (this file).
- `e2e/sw-update.spec.js`.

**Modified:**
- `sw.js` — add `message` handler; bump `VERSION` to `v20`.
- `lib/register-sw.js` — `showBanner(waiting)` signature; click handler does the postMessage + controllerchange dance.
- `docs/plans/README.md` — index entry for #23.

## Verification

1. `make lint` — passes.
2. `make test` — 113 unit tests (no changes).
3. `make e2e` — 27 tests (was 26, +1).
4. CI green.
5. Manual smoke at deploy: configure a config; bump VERSION on a follow-up commit; observe banner; click Reload; banner clears and new code takes over.

## Out of scope

- **Periodic background update checks.** Browsers do their own (≤24h cadence); we don't need a custom timer.
- **"What's new" content** in the banner. Plain "A new version is available." is enough for v1; if releases get more user-visible we can add a release-notes link.
- **Auto-reload without prompt.** Risky if the user is mid-upload; the explicit Reload click is the right default.
