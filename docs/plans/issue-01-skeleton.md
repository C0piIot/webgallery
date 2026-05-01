# Plan — Issue #1: Vendor Bootstrap CSS + aws4fetch + HTML shells with shared nav

## Context

First scaffolding step for the webgallery PWA. Nearly every later issue lands files into the structure this issue creates. Before this, the repo had only a hand-styled placeholder `index.html` that GitHub Pages was serving from `main`.

This issue covers three concerns:
- **Vendor third-party deps** under `vendor/` so the runtime never reaches a CDN — matches the "no third-party origins at runtime" rule in `docs/architecture.md` (*Static bundle*).
- **Three HTML shells** with a shared Bootstrap top nav so navigation works from day one.
- **Stub ES modules** so each page has a `<script type="module">` hook for later issues to fill.

After this issue, Pages serves the real shell instead of the placeholder.

## Decision: skip Bootstrap's JS bundle

Vendor **only Bootstrap's CSS**, not its JS bundle. Saves ~80 KB and one dep. Two consequences, both cheap to handle:

- **Always-expanded navbar.** Use `navbar-expand` (no breakpoint) instead of `navbar-expand-md`. Three short labels (Gallery / Storage / Folders) fit horizontally on phone viewports without a toggler.
- **Vanilla JS for Local/Remote tabs.** ~10 lines in `index.js` swap `.active` classes between tab buttons and `.tab-pane` panels. Bootstrap's `.nav-tabs` / `.tab-pane` CSS still does the visual work.

Future implication: when #19 lands the detail view, use the native `<dialog>` element instead of a Bootstrap modal. If we ever want Bootstrap dropdowns / popovers / tooltips / carousel, we re-vendor the JS or write each one ourselves.

## Approach

### 1. Vendor pinned third-party files

Download once from jsDelivr, commit verbatim:

| Path | Source | Approx. size |
|---|---|---|
| `vendor/bootstrap.min.css` | `https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css` | ~230 KB |
| `vendor/aws4fetch.js` | `https://cdn.jsdelivr.net/npm/aws4fetch@1.0.20/dist/aws4fetch.esm.mjs` | ~8 KB |

`vendor/README.md` records source URL + version per file so future upgrades are mechanical.

### 2. Shared navbar (hardcoded per page)

A Bootstrap navbar repeated identically in each page (~10 lines × 3 pages — cheaper than a JS-driven nav for a 3-page MPA). Each page hardcodes `class="nav-link active"` + `aria-current="page"` on its own link.

### 3. Page shells (common template)

Each HTML page includes a viewport meta, the vendored Bootstrap CSS, the shared navbar, a `<main class="container py-3">` placeholder, and `<script type="module" src="./<page>.js"></script>`. Page-specific bodies are placeholders pointing at the issues that will fill them (#8, #10, #17, #18).

### 4. Stub JS modules

- `setup-storage.js`, `setup-folders.js` — single comment + `export {};`.
- `index.js` — same plus ~10 lines that read `?tab=` from the URL on load and toggle the `active` class between the two tab buttons / `.tab-pane` panels. Click handlers update `history.replaceState` so the URL stays in sync. Only behavior #1 ships.

### 5. Manual smoke verification

`python3 -m http.server` from the repo root. Verify each page loads with no console errors, navbar fits on narrow viewport, nav links navigate, active link is highlighted on each page, vendor files load with 200, tabs toggle, `?tab=remote` URL renders Remote active.

The "smoke E2E loading each page and asserting nav links work" item is **deferred to land with #4 / #5** (dev tooling + CI). #1's checklist doesn't require it; manual verification is enough to close.

### 6. Commit + close

One commit with a `Closes #1` trailer. Pushing to `main` auto-closes the issue and triggers the Pages redeploy.

## Files

**Created:** `vendor/bootstrap.min.css`, `vendor/aws4fetch.js`, `vendor/README.md`, `setup-storage.html`, `setup-storage.js`, `setup-folders.html`, `setup-folders.js`, `index.js`

**Modified:** `index.html` (full rewrite — replaces the current placeholder)

## Verification end-to-end

1. After `git push`, Pages redeploys (~1–2 min).
2. Visit `https://c0piiot.github.io/webgallery/` on mobile Chrome and a desktop browser.
   - Navbar renders inline on both, no toggler.
   - Three nav links navigate between the three pages.
   - Active link highlighted on each page.
   - On `index.html`, clicking Local / Remote toggles tabs without a reload; `?tab=...` URL is bookmarkable.
   - No 404s for `vendor/*` in the network tab.
3. Issue #1 closed automatically by the commit trailer.

## Out of scope

- Service Worker + `manifest.webmanifest` — **#2**.
- Strict CSP meta — full lockdown lands in **#20**.
- Form fields, picker, real tab content — **#8, #10, #17, #18**.
- Automated tests / CI — **#4, #5**.

## Sources

- [Bootstrap 5.3 download docs](https://getbootstrap.com/docs/5.3/getting-started/download/) — version 5.3.8.
- [aws4fetch on npm](https://www.npmjs.com/package/aws4fetch) — version 1.0.20.
