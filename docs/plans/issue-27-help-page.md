# Plan — Issue #27: In-app Help / About page

## Scope (in / out)

**In**
- New static page `help.html` matching the existing page shell (CSP meta, Bootstrap, navbar, register-sw + install glue).
- Four sections: **What this is** / **S3 primer** / **Provider comparison** / **Security model**.
- Security section spells out the maintainer-trust risk (any future commit by the repo owner runs in users' browsers) and gives three concrete mitigations + a copyable IAM-policy snippet + a copyable CORS snippet.
- "Help" link added to the navbar on every page (`index.html`, `setup-storage.html`, `setup-folders.html`, and `help.html` itself with `active` aria state).
- Welcome alert on `setup-storage.html?welcome=1` gets a small "Read the Help page first" link so brand-new users see it before pasting credentials.
- Page is precached in `sw.js` so it works offline once visited.

**Out (deferred)**
- Per-provider step-by-step bucket / CORS / IAM walkthroughs. We give the templates and link to provider docs; the rest is too provider-specific to maintain inline.
- An interactive "Generate IAM policy" form. Templating the JSON copy with the user's bucket+prefix would be nice but adds JS surface that doesn't exist on this page today; YAGNI.
- A separate FAQ. If/when patterns emerge from real questions, add a section; not preemptive.
- Localization. App is English-only.

## Content outline

```
H1  webgallery
P   One-paragraph "what this is" — PWA, no backend, talks directly
    to a bucket the user provides, photos + videos, runs in
    Chrome on Android + desktop.

H2  How storage works (S3 primer)
P   Two short paragraphs: what an S3 bucket is, what S3-compatible
    means.

H2  Picking a provider
TABLE  Provider | Storage cost | Egress cost | Good for
       AWS S3   | $$$          | $$$         | Ubiquitous, ecosystem.
       R2       | $$           | Free        | Cheapest TCO if you read often.
       B2       | $            | $           | Cheapest at-rest storage.
       MinIO    | (self-host)  | (self-host) | Full control, advanced users.
P   No affiliate links. Pricing is approximate; check provider page
    for current rates.

H2  Security model
P   Lead-in: fully client-side, HTML+JS comes from GitHub Pages
    under the maintainer's account. If the maintainer pushes
    malicious JS — or their account is hacked — the new code runs
    in your browser on next load and can read S3 credentials out
    of IndexedDB.
P   CSP partially mitigates (no third-party origins, vendored
    deps) but does NOT prevent first-party JS from misbehaving.
    You're trusting whoever controls the Pages source.

H3  Mitigations, strongest first
OL  1. Fork and self-host.
    2. Least-privilege credentials.
    3. Bucket versioning + CORS hardening.

H3  Example IAM policy (AWS-flavored)
H3  Example CORS configuration
H3  Standing recommendations (HTTPS, no bucket reuse, watch billing).
```

## Files

**Created**
- `help.html` — the new page.
- `docs/plans/issue-27-help-page.md` (this file).

**Modified**
- `index.html`, `setup-storage.html`, `setup-folders.html` — add a `<li><a href="./help.html">Help</a></li>` to the navbar; the active page sets `aria-current="page"` + `active` class.
- `setup-storage.html` — welcome alert text adds an inline link to `./help.html`.
- `sw.js` — add `./help.html` to `SHELL`; bump `VERSION` v24 → v25.
- `docs/plans/README.md` — index entry for #27.

## Tests

### Unit — none

The page is static HTML; no extractable logic.

### E2E — extend `e2e/smoke.spec.js`

Two new tests, mirroring the existing nav-link smoke pattern: assert the Help nav link gets `active` on `/help.html`, and assert it's reachable from each of the other pages (with a seeded config so the index-page redirect doesn't pre-empt that part of the test).

## Verification

1. `make lint` / `make test` — no unit changes.
2. `make e2e` — 30 → 32 (2 new tests).
3. Manual smoke at deploy: open `/help.html`, scan for typos and broken markup. Click Help from each of the other three pages. Check that IAM/CORS snippets are properly escaped and copy-paste cleanly.

## Risks

- **Content drift**: pricing tiers and provider names go stale. Mitigation: avoid specific dollar figures; rely on `$/$$/$$$` shorthand; link to provider pricing pages so live data is one click away.
- **Trust framing tone**: "your maintainer might attack you" reads aggressive. Favor straightforward language ("you're trusting whoever controls the Pages source") over alarmist.
- **Page bloat**: easy to keep adding sections. Strict scope to the four sections above; FAQ + walkthroughs are deferred.
