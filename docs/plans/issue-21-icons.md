# Plan — Issue #21: PWA manifest icons + installability check

## Context

Second piece of M6. The manifest from #2 is "minimally valid" — it has name / short_name / start_url / display / theme_color / background_color but no `icons` array, so Chrome refuses to install the PWA. This issue adds the icon set, an in-app **Install** button captured from `beforeinstallprompt`, and a regression test that validates the manifest shape.

## Decisions

### One SVG covers it (no PNG generation)

Chrome 87+ accepts SVG as an installable manifest icon. One file at `/icons/icon.svg` with `purpose: "any maskable"` and `sizes: "any"` satisfies Chrome's installability heuristic and renders crisply at every size — desktop launcher, Android home screen, splash screen, browser tab favicon.

The alternative (raster PNGs at 192×192 / 512×512 / 512×512 maskable) would require adding image-tooling to the dev container or shipping pre-rendered fixtures. Given we don't have a real logo yet and v1 is single-user, an SVG placeholder is the right level of effort. PNG raster icons can land later as a small follow-up if any consumer rejects the SVG.

### Placeholder design

Photo-gallery app: a `📷` emoji centered on a Bootstrap-`bg-dark` (#212529) square. Emoji rendering is OS-dependent at install time, but at *icon-generation* time it's the SVG's text element which is just a glyph code point — every browser shipping SVG support renders it. Centered with a 25% margin so the maskable safe zone (40%-radius circle from center) is respected.

### Install button placement

Inline in the navbar of each page, hidden by default (`d-none`), unhidden when `beforeinstallprompt` fires. Same affordance on every page so users can install from wherever they happen to be.

A floating button (similar to the SW update banner) was considered; rejected because a navbar button is more discoverable and matches the existing Storage / Folders nav style.

### `beforeinstallprompt` handling lives in `lib/install.js`

A small new module — sibling to `lib/register-sw.js`. Imported as a side-effect from each page bootstrap. Captures the deferred prompt, wires the navbar button click → `prompt()`, hides on `appinstalled`.

## Approach

### 1. `icons/icon.svg`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="webgallery">
  <rect width="512" height="512" fill="#212529"/>
  <text x="256" y="335" font-size="220" text-anchor="middle"
        font-family="-apple-system, system-ui, sans-serif"
        dominant-baseline="middle">📷</text>
</svg>
```

Roughly 350 bytes. The `<text>` baseline tweak keeps the camera glyph visually centered.

### 2. `manifest.webmanifest` additions

Append `icons`:

```json
{
  ...existing fields...,
  "icons": [
    {
      "src": "./icons/icon.svg",
      "type": "image/svg+xml",
      "sizes": "any",
      "purpose": "any maskable"
    }
  ]
}
```

### 3. Favicon link on every page

`<link rel="icon" href="./icons/icon.svg" type="image/svg+xml">` next to the existing `<link rel="manifest">` on all three pages. Same icon, browser tab gets the camera. Tiny touch.

### 4. `lib/install.js`

```js
// Capture beforeinstallprompt → reveal #install-btn → on click,
// prompt the user. Idempotent across pages — each page bootstrap
// imports this for side effects.

let deferredPrompt = null;

function btn() {
  return document.getElementById('install-btn');
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  btn()?.classList.remove('d-none');
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  btn()?.classList.add('d-none');
});

document.addEventListener('click', async (e) => {
  if (e.target?.id !== 'install-btn') return;
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  try {
    await deferredPrompt.userChoice;
  } finally {
    deferredPrompt = null;
    btn()?.classList.add('d-none');
  }
});
```

`document.click` delegation is forgiving of when the button is rendered (HTML / dynamically inserted). Importing the module before or after DOMContentLoaded both work — the listeners are at `window`/`document` level.

### 5. Install button in each navbar

Append after the existing `<ul class="navbar-nav">`:

```html
<button id="install-btn" type="button"
        class="btn btn-sm btn-outline-light ms-auto d-none">Install</button>
```

`ms-auto` pushes it to the right end of the navbar; `d-none` keeps it hidden until the install event fires.

### 6. Page bootstraps

`index.js`, `setup-storage.js`, `setup-folders.js` each gain:

```js
import './lib/install.js';
```

Side-effect import — the module wires its listeners on load.

### 7. Service Worker shell

Three new shell entries:
- `./icons/icon.svg`
- `./lib/install.js`

Bump `sw.js` `VERSION` from `v17` → `v18`.

### 8. Tests

#### Unit — none new

The install logic is event-driven and platform-gated; not productively unit-testable in vitest.

#### E2E — `e2e/manifest.spec.js` (new, 2 cases)

```js
test('manifest has the required PWA fields and a valid icon entry', async ({ page }) => {
  const res = await page.request.get('/manifest.webmanifest');
  expect(res.status()).toBe(200);
  const m = await res.json();
  expect(m.name).toBeTruthy();
  expect(m.short_name).toBeTruthy();
  expect(m.start_url).toBeTruthy();
  expect(m.display).toBe('standalone');
  expect(m.icons).toBeInstanceOf(Array);
  expect(m.icons.length).toBeGreaterThan(0);
  const icon = m.icons[0];
  expect(icon.src).toBeTruthy();
  expect(icon.sizes).toBeTruthy();
  expect(icon.purpose).toMatch(/maskable/);
  // Icon resource resolves.
  const iconRes = await page.request.get(new URL(icon.src, res.url()).href);
  expect(iconRes.status()).toBe(200);
});

test('every page has a hidden Install button in the navbar', async ({ page }) => {
  for (const p of ['/', '/setup-storage.html', '/setup-folders.html']) {
    await page.goto(p);
    const btn = page.locator('#install-btn');
    await expect(btn).toHaveCount(1);
    await expect(btn).toBeHidden();   // hidden until beforeinstallprompt fires
  }
});
```

The acceptance lists "install prompt fires under Playwright." That's flaky — Chromium gates `beforeinstallprompt` behind engagement heuristics that don't reliably trigger in headless. The two assertions above test the **contract** (manifest correctness + button presence/hidden state) without depending on the prompt actually firing during a CI run. The integrated end-to-end behavior is verified manually at deploy time (open the live site in real Chrome on Android, observe the Add-to-Home-Screen prompt, observe the Install button appear).

### 9. Verification

1. `make lint` — passes.
2. `make test` — 113/113 unit (no changes).
3. `make e2e` — 22 → 24 e2e (two new manifest tests).
4. CI green.
5. Manual smoke at deploy time: open `https://c0piiot.github.io/webgallery/` in real Chrome on Android, expect Install option in the menu and the in-app button after engagement.

### 10. Commit + close

One commit (`Closes #21`) covering: new `icons/icon.svg`, `lib/install.js`, `e2e/manifest.spec.js`, `manifest.webmanifest` icons array, three HTML files (favicon link + navbar Install button), three page bootstraps (one-line install.js import each), `sw.js` version bump, plus `docs/plans/issue-21-icons.md` and the index update.

## Files

**Created:**
- `icons/icon.svg`
- `lib/install.js`
- `e2e/manifest.spec.js`
- `docs/plans/issue-21-icons.md` (frozen copy of this plan)

**Modified:**
- `manifest.webmanifest` — add `icons` array.
- `index.html`, `setup-storage.html`, `setup-folders.html` — add favicon `<link>` + Install `<button>` in navbar.
- `index.js`, `setup-storage.js`, `setup-folders.js` — `import './lib/install.js';`.
- `sw.js` — bump `VERSION` to `v18`; add `./icons/icon.svg` and `./lib/install.js` to `SHELL`.
- `docs/plans/README.md` — add #21 to the index.

## Out of scope for this issue (handled later)

- **Real logo.** Placeholder camera-emoji-on-dark is fine for v1; a designed mark is a follow-up if the project takes on visual identity.
- **Raster PNG icons** (192/512/512-maskable). Add only if some consumer rejects the SVG. Modern Chrome / Android accept SVG.
- **Lighthouse-CI in the workflow.** Worth doing as part of a "polish + monitoring" pass; outside this issue.
- **iOS-specific `apple-touch-icon`** PNG and meta tags. iOS Safari doesn't read manifest icons; we'd need a separate PNG. Out of scope since v1 targets Chrome on Android per `docs/architecture.md` *Known constraints*.
- **Browser-fired prompt under Playwright e2e.** Engagement heuristics make this flaky; manual verification at deploy time covers it.

## Sources / references

- `docs/architecture.md` — *Static bundle* → PWA manifest; *Known constraints* (Chrome on Android primary).
- `manifest.webmanifest` (#2) — minimal manifest being completed here.
- Issue #21 acceptance criteria.
- [Chrome installability docs](https://web.dev/articles/installable-manifest) for icon requirements.
