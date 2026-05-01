# Plan — Issue #20: CSP meta + SW caching pass + version-activation flow

## Context

First piece of M6 (PWA + polish). Three related concerns:

1. **CSP** — locks down what the page can load and execute. Until now the only protection was "we don't include CDN URLs at runtime." A `<meta http-equiv="Content-Security-Policy">` on each page makes the rule enforceable: any code or vendored asset that tries to reach a non-allowed origin gets blocked by the browser, not just by convention.
2. **SW caching pass** — the precache list and the v1 `cache.addAll(SHELL)` flow already work (#2); this is a polish pass to confirm coverage and tighten the activation flow.
3. **"Update available — reload" banner** — when a new `sw.js` `VERSION` ships, users currently get the new bytes only after closing every open tab and re-opening. The banner gives them a one-click path: detect a `waiting` SW, show a Bootstrap toast, click → reload → new SW activates.

After this issue ships, M6 has only #21 (icons + install prompt) and #22 (empty/error states sweep) left to go.

## Trade-offs we're committing to

### Bucket origin in `connect-src` is dynamic — CSP can't be specific

The bucket origin is whatever the user pasted into `setup-storage.html`. CSP `<meta>` is static at page-parse time. Three options considered:

- **Inject CSP via Service Worker response headers** at runtime, reading the bucket origin from IndexedDB. Technically possible but complex; the SW would need to handle config reads and cache invalidation when config changes. Defer until we have evidence the broad policy below is exploitable.
- **Hardcode common providers (AWS, R2, B2…)** — brittle (B2 is region-specific, R2 is account-specific) and surprising for users running self-hosted MinIO at a LAN IP.
- **Broad scheme-level allow for `connect-src` / `img-src` / `media-src`** combined with a strict `script-src 'self'` — the actual XSS-load-bearing rule. **This is what we ship.**

The compromise is honest: scripts/styles are strictly own-origin only, but bucket-flavored sources (connect / img / media) accept any HTTPS origin (and `http://localhost:*` / `127.0.0.1:*` for dev MinIO). Combined with `lib/config.js`'s endpoint validation (which limits `http://` to single-label hosts and `.local`), the actual surface that can be reached is bounded enough.

### `style-src 'self' 'unsafe-inline'` — needed for inline styles

We have a few inline `style="..."` attributes (dialog `max-width`, sentinel `height: 1px`) and JS-set `element.style.foo = bar` (cards' `cursor: pointer`, dialog media `object-fit`). All trigger `style-src-attr` enforcement. Two paths:

- Eliminate every inline style and write a tiny CSS file → violates the "no app-specific CSS file" rule from #1.
- Allow `'unsafe-inline'` in `style-src` → weakens style-side CSP but doesn't enable JS execution. CSS injection is bounded by `img-src` (data exfil via `background: url(...)` is gated on what `img-src` allows).

We take the second. Documented; revisit if we ever need a stylesheet anyway.

## Approach

### 1. CSP meta (identical on all three HTML pages)

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  script-src 'self';
  worker-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https: http:;
  media-src 'self' blob: https: http:;
  connect-src 'self' https: http:;
  manifest-src 'self';
  frame-src 'none';
  object-src 'none';
  base-uri 'self';
  form-action 'none';
">
```

(Single line in HTML — multiline above is for readability.)

Goes inside `<head>` as the first `<meta http-equiv>`, before any `<link>` or `<script>` so the browser applies it before loading anything. Same content on all three pages.

Decisions encoded:
- `default-src 'self'` — anything not explicitly allowed must be same-origin.
- `script-src 'self'` — strict; vendored libs are same-origin, no inline scripts, no `eval`.
- `worker-src 'self'` — sync worker module loads from our origin only.
- `style-src 'self' 'unsafe-inline'` — see trade-off above.
- `img-src 'self' data: blob: https: http:` — `data:` for inline data URLs, `blob:` for runtime-generated URLs. **`http:` is broad** — needed because Docker-internal hostnames (e.g. `http://minio:9000` in the test environment) and self-hosted MinIO/NAS deployments don't fit the `localhost`/`127.0.0.1` pattern. The actual security floor for HTTP is enforced upstream in `lib/config.js`'s endpoint validator (only single-label hosts and `*.local` accepted for `http://`).
- `media-src` — same pattern for `<video>` sources.
- `connect-src` — `fetch`/XHR/WebSocket allow-list, same broad shape as above.
- `frame-src 'none'`, `object-src 'none'` — no `<iframe>`, no plugins.
- `base-uri 'self'`, `form-action 'none'` — defense in depth against weird base/form injection tricks.

### 2. SW caching pass — audit + tweak

`SHELL` in `sw.js` already contains every page, every lib/, every vendor file, the manifest. Audit pass:

- All 3 HTMLs ✓
- All 3 page bootstrap JS (`index.js`, `setup-storage.js`, `setup-folders.js`) ✓
- `lib/*.js` ✓ (db, bucket, config, folders, capability, walker, hash, upload, sync, sync-worker, retry, remote-list, register-sw, connectivity)
- `vendor/aws4fetch.js`, `vendor/bootstrap.min.css`, `vendor/noble-hashes/{sha2,_md,_u64,utils}.js` ✓
- `manifest.webmanifest` ✓

No changes needed beyond what we've maintained issue-by-issue. The pass simply documents the audit in the plan.

### 3. Update-available banner

Extend `lib/register-sw.js` to wire the SW lifecycle into a small Bootstrap-styled toast that appears in the bottom-right when a new SW is in `waiting` state.

```js
async function setupUpdateBanner() {
  const reg = await navigator.serviceWorker.ready;

  // Already-waiting SW (e.g., user opened a new tab while update queued).
  if (reg.waiting && navigator.serviceWorker.controller) {
    showBanner();
    return;
  }

  reg.addEventListener('updatefound', () => {
    const installing = reg.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        showBanner();
      }
    });
  });
}

function showBanner() {
  if (document.getElementById('sw-update-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'sw-update-banner';
  banner.className =
    'alert alert-info position-fixed bottom-0 end-0 m-3 mb-3 d-flex align-items-center gap-2 shadow';
  banner.setAttribute('role', 'status');
  banner.style.zIndex = '9999';
  const text = document.createElement('span');
  text.textContent = 'A new version is available.';
  banner.appendChild(text);
  const btn = document.createElement('button');
  btn.className = 'btn btn-sm btn-primary';
  btn.textContent = 'Reload';
  btn.addEventListener('click', () => location.reload());
  banner.appendChild(btn);
  document.body.appendChild(banner);
}
```

`location.reload()` causes the page to re-load fresh; on the new load, the old SW has no clients controlling it and the waiting SW activates naturally. We don't `skipWaiting` from inside the banner — that requires `postMessage`-ing the waiting SW + handling `controllerchange`, which is more code for an indistinguishable user experience.

Wired into the existing module:

```js
// lib/register-sw.js
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => {
    console.warn('SW registration failed:', err);
  });
  setupUpdateBanner().catch(() => { /* best-effort */ });
}
```

The banner has minimal styling (Bootstrap alert + position-fixed). Two small inline styles (`zIndex` set in JS), already covered by our `'unsafe-inline'` allowance.

### 4. Tests

#### Unit — none new

The CSP tag is HTML; testing is e2e. The banner is DOM-bound and depends on real SW lifecycle events, also e2e/manual.

#### E2E — `e2e/csp.spec.js` (new, 1 test)

```js
test('every page ships a CSP meta with the expected directives', async ({ page }) => {
  for (const path of [
    '/',
    '/setup-storage.html',
    '/setup-folders.html',
  ]) {
    await page.goto(path);
    const csp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content');
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'none'");
  }
});
```

For the "regression: off-origin asset is blocked" angle: rather than try to make the page issue a deliberate off-origin request (we don't have any, so we'd be inventing test-only code that contradicts what we're testing), we settle for **asserting the policy text is present**. The browser enforces the rule; our test confirms the rule is shipped.

The "update available" banner needs SW lifecycle to fire correctly, which is hard to make happen reliably in a Playwright run without two separate page loads against two distinct SW versions. Manual smoke test: bump `VERSION`, deploy, visit live site, see the banner. **No automated coverage** for this path; covered by manual verification at deploy time.

### 5. Service Worker shell

`lib/register-sw.js` content changes (banner machinery added). Already in `SHELL`. Bump `sw.js` `VERSION` from `v16` → `v17`.

### 6. Verification

1. `make lint` — passes.
2. `make test` — 113/113 unit (no changes).
3. `make e2e` — 21 → 22 e2e (one new CSP regression test).
4. CI green.
5. Manual smoke against the live site: bump `VERSION` to `v18` in a follow-up commit, redeploy, observe the banner appears in any open tab; click Reload, new bytes load.

### 7. Commit + close

One commit (`Closes #20`) covering: three HTML CSP meta tags, `lib/register-sw.js` update banner, `e2e/csp.spec.js`, `sw.js` version bump, plus `docs/plans/issue-20-csp-sw.md` and the index update.

## Files

**Created:**
- `e2e/csp.spec.js`
- `docs/plans/issue-20-csp-sw.md` (frozen copy of this plan)

**Modified:**
- `index.html`, `setup-storage.html`, `setup-folders.html` — `<meta http-equiv="Content-Security-Policy" content="…">` in `<head>`, identical content.
- `lib/register-sw.js` — add `setupUpdateBanner` and call after registration.
- `sw.js` — bump `VERSION` to `v17`.
- `docs/plans/README.md` — add #20 to the index.

## Out of scope for this issue (handled later)

- **Per-installation CSP** with the user's specific bucket origin in `connect-src` instead of `https:`. Requires SW-injected CSP headers. Defer until the broad policy proves inadequate.
- **Subresource Integrity (SRI) hashes on vendor files.** Vendored files are same-origin, so SRI doesn't add much beyond what `script-src 'self'` already provides. Worth revisiting if/when we ever load anything cross-origin.
- **CSP report-uri / report-to.** No reporting endpoint to send violations to (we have no backend). Could add a console-only report eventually.
- **`skipWaiting`-driven instant activation.** The current banner-then-reload flow is cleaner — the user sees that an update is available before swap. Skipping waiting can break in-flight state.
- **`Permissions-Policy` header.** Only relevant if our page embeds powerful APIs we want to deny to children; we don't have iframes.
- **HTTPS Strict-Transport-Security.** Set by the host (GitHub Pages already serves with HSTS).

## Sources / references

- `docs/architecture.md` — *Static bundle* → Service Worker, *Cache busting*; *Capability and connectivity awareness*.
- `docs/requirements.md` — *Security model* (no third-party origins, strict CSP).
- Issue #20 acceptance criteria.
- `sw.js` (#2) — existing precache + version flow being polished.
- `lib/register-sw.js` (#2) — extended here with the banner machinery.
- [MDN — Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP).
