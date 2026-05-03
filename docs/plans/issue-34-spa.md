# Plan — Issue #34: Convert to SPA so FSA permissions survive navigation

## Why

Chrome's permission-persistence policy says non-installed sites lose access "when the site is closed or navigated away from." On Chrome Android the persistent-permissions feature shipped in Chrome 122 (desktop) appears not to have rolled out — even installed PWAs hit the per-document expiry on cross-page navigation. Empirically confirmed on a real device.

The lasting fix is **one document for the whole app session**. Hash-routed SPA, no per-page reloads, FSA grant lives as long as the tab does.

Ride-along benefits:
- Eliminates the welcome-redirect flicker (`location.replace`) and the back-button awkwardness around it.
- Smoother tab transitions; no FOUC between Local/Remote/Storage/Folders/Help.
- Service-Worker SHELL gets smaller (one HTML, fewer redundant page shells).

## Scope (in / out)

**In**
- Hash routing (`#/local`, `#/remote`, `#/storage`, `#/folders`, `#/help`) — works on static GitHub Pages without server config.
- One `index.html` shell holds the navbar, the `<main>` container, and the shared `<dialog>` for detail view.
- Four view modules (`views/gallery.js`, `views/storage.js`, `views/folders.js`, `views/help.js`), each exporting `init(container, params)` and a cleanup function.
- A small home-grown router in `lib/router.js` (~80 lines, no dep).
- The four old HTML pages (`setup-storage.html`, `setup-folders.html`, `help.html`) get deleted; legacy bookmarks lose. Acceptable since we haven't released v1.
- E2E tests updated to use hash URLs (`/?e2e=1#/storage`).

**Out**
- htmx or any client-side dep. Vanilla router fits the "no build step" floor; 80 lines isn't worth a 16 KB dep.
- HTML5 history API. Static GH Pages can't 404-fallback to `index.html`; URL cosmetics aren't worth the duplication required.
- Per-route lazy module loading. App fits in one bundle.
- Multi-tab session sharing.

## Architecture

### `index.html` shell

Navbar (no Help link, per #27) + `<main id="view">` container + shared `<dialog id="detail-dialog">`. Loads `app.js`. Bootstrap CSS, CSP, manifest stay as-is. `data-route` attributes on nav links let the router toggle `active`.

### `lib/router.js` (~80 LOC)

```
createRouter({ routes, titles, container }) → { start, navigate }
  - listens for 'hashchange' + initial parse
  - hash like '#/storage?welcome=1' parses to { path: '/storage', params: URLSearchParams }
  - on route change: call previous view's teardown, then call new view's init(container, params)
  - sets document.title from titles map
  - toggles 'active' on navbar links via data-route
  - replaceState helper for welcome redirect
```

### View modules

Each existing page becomes a view module that exports `init(container, params)` returning a teardown function. HTML inlined as template literals. CSP allows this (no inline scripts; inline HTML is just innerHTML).

| Old | New |
|---|---|
| `index.html` + `index.js` | `views/gallery.js` |
| `setup-storage.html` + `setup-storage.js` | `views/storage.js` |
| `setup-folders.html` + `setup-folders.js` | `views/folders.js` |
| `help.html` + `help.js` | `views/help.js` |

Listeners use `AbortController`; teardown calls `ctrl.abort()` for one-line listener cleanup. Subscriptions (BroadcastChannel, IntersectionObservers, object URLs) get explicit teardown.

### `app.js`

Imports register-sw + install. Boots the router. Welcome-funnel: if no config and not already on `/storage`, replace hash to `#/storage?welcome=1`. If `?e2e=1` is present, dynamic-import `lib/test-hooks.js` so the helpers attach unconditionally.

### Service Worker

SHELL replaces the per-page list with `index.html`, `app.js`, `lib/*.js`, `views/*.js`, vendor + icons + manifest. `VERSION` v28 → v29. SkipWaiting handshake from #23 handles the smooth cutover.

### CSP / Manifest
No change.

## Tests

### Unit
123 unit tests test pure `lib/` modules; should pass unchanged.

### E2E
Mechanical URL updates across every `e2e/*.spec.js`:

| Before | After |
|---|---|
| `/setup-storage.html?e2e=1` | `/?e2e=1#/storage` |
| `/setup-folders.html?e2e=1` | `/?e2e=1#/folders` |
| `/index.html?tab=local` | `/#/local` |
| `/index.html?tab=remote` | `/#/remote` |
| `/help.html` | `/#/help` |

Test helpers (`__test_save_config__`, `__test_upload__`, etc.) move to `lib/test-hooks.js`. Page-evaluation calls don't change. Welcome-redirect test asserts new hash URL.

## Files

**Created**
- `lib/router.js`
- `lib/test-hooks.js`
- `views/gallery.js`, `views/storage.js`, `views/folders.js`, `views/help.js`
- `app.js`
- `docs/plans/issue-34-spa.md` (this file)

**Modified**
- `index.html` (SPA shell)
- `sw.js` (SHELL + VERSION)
- Every file in `e2e/` (URL updates)
- `docs/plans/README.md` (index entry)
- `docs/architecture.md` (per-page shell section becomes "SPA shell + views + hash router")

**Deleted**
- `setup-storage.html`, `setup-storage.js`
- `setup-folders.html`, `setup-folders.js`
- `help.html`, `help.js`
- `index.js` (content moves into `views/gallery.js` + `app.js`)

## Verification

1. `make lint` / `make test` — 123 unit tests pass.
2. `make e2e` — 34 e2e pass after URL updates.
3. Manual smoke at deploy:
   - Chrome Android, install PWA, add folder, navigate Gallery → Storage → Folders → Gallery: permission survives, Local-tab thumbs stay disk-resolved.
   - Welcome funnel: clear site data, visit `/`, expect `/#/storage?welcome=1`.
   - Detail dialog opens/closes cleanly across views.
   - Back/forward navigation across hash routes preserves state.

## Risks

- **Cleanup correctness**: missed listener / observer = leak. Mitigation: AbortController per view, abort on teardown.
- **Sync controller lifecycle**: keep running across views; only the Local-view BroadcastChannel listener tears down per route. Worker continues walking/uploading.
- **Modal mid-route-change**: gallery teardown closes the dialog if open.
- **Old bookmarks**: pre-v1, accept the break. If we later care, add stub HTML files with meta-refresh.
- **One big diff**: atomic conversion. Single commit, generous use of unit + e2e as safety net.

## Sequencing (single commit)

1. Build `lib/router.js` + minimal `index.html` + `app.js` mounting "hello world". Confirm hash routing.
2. Port `views/help.js` (simplest, validates the round-trip).
3. Port `views/storage.js` with `?welcome=1` handling.
4. Port `views/folders.js`.
5. Port `views/gallery.js` (Local + Remote tabs + detail dialog).
6. Wire `app.js` welcome redirect.
7. Move test hooks to `lib/test-hooks.js`.
8. Update `sw.js` SHELL + bump VERSION.
9. Delete old HTML/JS files.
10. Walk every e2e spec, update URLs, ensure 34 pass.
11. Update `docs/architecture.md`.
12. Single commit, push, verify CI.
