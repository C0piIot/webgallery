# Plan — Issue #2: PWA manifest + Service Worker app-shell cache (versioned)

## Context

Issue #1 shipped the page shells; #2 makes the site behave like a PWA:

- **Offline shell.** A Service Worker that precaches the HTML/JS/CSS that make up the app, so reloading offline still renders the navbar and the empty Local/Remote panels. The full offline UX (Remote tab from `gallery_cache`, sync pause/resume) lands in #15/#18; #2 just gets the chrome to load offline.
- **Installable.** A `manifest.webmanifest` so Android Chrome treats the site as a PWA. Icons land in #21 — #2 ships a minimal but valid manifest.
- **Versioned cache.** From `docs/architecture.md` *Static bundle* → *Cache busting*: bumping a constant in `sw.js` activates a new cache and evicts the old one. No hashed filenames; the SW does the cache-keying work.

This is the foundation for the deeper #20 caching pass (CSP meta + update-available banner) and #21 (real icons + install prompt).

## Approach

### 1. `manifest.webmanifest`

Hand-written, root-level. Minimal but complete enough that browsers parse it:

```json
{
  "name": "webgallery",
  "short_name": "webgallery",
  "description": "Personal photo and video gallery + backup. No backend.",
  "start_url": "./index.html",
  "scope": "./",
  "display": "standalone",
  "orientation": "any",
  "theme_color": "#212529",
  "background_color": "#ffffff"
}
```

`theme_color: #212529` matches Bootstrap's `bg-dark` navbar. **No icons array** — deferred to #21. Lighthouse will flag this; expected.

Each HTML page gets `<link rel="manifest" href="./manifest.webmanifest">` plus a `<meta name="theme-color" content="#212529">` in `<head>`.

### 2. `sw.js` (root-level, scope = repo root)

Hand-written, ~50 lines. Three responsibilities: precache the shell, evict old caches, serve from cache for shell URLs.

Decisions baked in:

- **Cache-first for same-origin GETs.** Returns cached if hit, falls through to network if miss. New deploys ride a `VERSION` bump.
- **Cross-origin requests pass through untouched.** S3 bucket reads stay out of the cache (per architecture: large media + range-request caching mismatch).
- **`clients.claim()` on activate.** First install takes control of the page that registered it without a hard reload.
- **No `skipWaiting()`.** Updates wait for the next page load to activate (graceful). The "update available — reload" banner is #20's job.
- **Old-cache eviction is scoped to our prefix** (`webgallery-shell-`).

### 3. `lib/register-sw.js`

Tiny side-effect module that introduces the `lib/` directory. Imported by each page bootstrap as `import './lib/register-sw.js';`. The module checks `'serviceWorker' in navigator` and registers `./sw.js`.

### 4. Manual smoke verification

`python3 -m http.server` from the repo root, then in Chrome DevTools:

- **Application → Service Workers**: `sw.js` activated.
- **Application → Cache Storage**: `webgallery-shell-v1` populated with all SHELL entries.
- **Application → Manifest**: parsed; only icon-related warnings (deferred to #21).
- **Network → Offline → reload**: each page renders fully, requests served from `(ServiceWorker)`.
- **Bump `VERSION` to `v2`**: reload twice — old cache disappears, new one populated.

GitHub Pages verification once pushed: at `https://c0piiot.github.io/webgallery/`, repeat the offline-reload check.

### 5. Commit + close

One commit with a `Closes #2` trailer.

## Files

**Created:** `sw.js`, `manifest.webmanifest`, `lib/register-sw.js`

**Modified:** `index.html`, `setup-storage.html`, `setup-folders.html` (add manifest link + theme-color meta), `index.js`, `setup-storage.js`, `setup-folders.js` (add `import './lib/register-sw.js';`).

## Verification end-to-end

1. After `git push`, Pages redeploys.
2. Visit `https://c0piiot.github.io/webgallery/`:
   - Service Workers shows registered + activated.
   - Cache Storage shows `webgallery-shell-v1`.
   - Offline reload renders each page from cache.
3. Issue #2 closed via the commit trailer.

## Out of scope

- Manifest **icons** + `beforeinstallprompt` capture — **#21**.
- **CSP meta** + the **"update available — reload" banner** — **#20**.

## Sources / references

- `docs/architecture.md` — *Static bundle (no build step)* → Service Worker, PWA manifest, Cache busting.
- Issue #2 acceptance criteria.
