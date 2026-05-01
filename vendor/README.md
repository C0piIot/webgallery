# vendor/

Third-party dependencies vendored as static files. The runtime never reaches a
CDN — every byte the browser executes ships from this origin (see
`docs/architecture.md` *Static bundle*).

| File | Source | Version |
|---|---|---|
| `bootstrap.min.css` | https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css | 5.3.8 |
| `aws4fetch.js` | https://cdn.jsdelivr.net/npm/aws4fetch@1.0.20/dist/aws4fetch.esm.mjs | 1.0.20 |
| `noble-hashes/{sha2,_md,_u64,utils}.js` | https://cdn.jsdelivr.net/npm/@noble/hashes@2.2.0/{file}.js | 2.2.0 |

## Updating

1. Download the new file at the URL with the bumped version.
2. Overwrite the file in this directory.
3. Strip any trailing `//# sourceMappingURL=...` (or `/*# sourceMappingURL=...*/`
   for CSS) comment — we don't vendor the corresponding `.map` files, and
   the comment makes Vite (under Vitest) emit a noisy "Failed to load
   source map" warning during CI.
4. Bump the version in this README.
5. Commit.

Bootstrap's JavaScript bundle is intentionally **not** vendored — the app uses
Bootstrap's CSS only. See the architecture doc *Static bundle* note for the
rationale.
