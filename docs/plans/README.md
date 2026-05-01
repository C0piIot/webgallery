# Design log

One file per closed issue, capturing the plan that was approved before
implementation. The intent is to keep design rationale browseable next to
the code instead of scattered across PR threads or transient plan files.

The workflow: I work the issue in plan mode (the plan-mode file is
scratch), and on approval the final plan is committed here as part of
the same change that closes the issue.

## Plans

| Issue | Plan |
|---|---|
| [#1](https://github.com/C0piIot/webgallery/issues/1) | [Skeleton — vendor Bootstrap CSS + aws4fetch + page shells](./issue-01-skeleton.md) |
| [#2](https://github.com/C0piIot/webgallery/issues/2) | [PWA manifest + Service Worker app-shell cache](./issue-02-pwa-manifest-sw.md) |
| [#3](https://github.com/C0piIot/webgallery/issues/3) | [`lib/db.js` IndexedDB wrapper + unit tests](./issue-03-lib-db.md) |
| [#4](https://github.com/C0piIot/webgallery/issues/4) | [Dev tooling — Docker compose + Vitest + Playwright](./issue-04-dev-tooling.md) |
| [#5](https://github.com/C0piIot/webgallery/issues/5) | [GitHub Actions CI + pre-commit hook](./issue-05-ci.md) |
| [#6](https://github.com/C0piIot/webgallery/issues/6) | [`lib/bucket.js` BucketClient over aws4fetch](./issue-06-bucket-client.md) |
| [#7](https://github.com/C0piIot/webgallery/issues/7) | [`lib/config.js` load/save storage config + prefix](./issue-07-config.md) |
| [#8](https://github.com/C0piIot/webgallery/issues/8) | [`setup-storage.html` form + connection test](./issue-08-setup-storage.md) |
| [#9](https://github.com/C0piIot/webgallery/issues/9) | [`lib/folders.js` FSA handle persistence + permission re-grant](./issue-09-folders.md) |
| [#10](https://github.com/C0piIot/webgallery/issues/10) | [`setup-folders.html` picker / list / remove](./issue-10-setup-folders.md) |
| [#11](https://github.com/C0piIot/webgallery/issues/11) | [`lib/capability.js` + graceful FSA-missing gating](./issue-11-capability.md) |
| [#12](https://github.com/C0piIot/webgallery/issues/12) | [Incremental directory walker (batched, yielding)](./issue-12-walker.md) |
| [#13](https://github.com/C0piIot/webgallery/issues/13) | [Streamed file hasher (sha256)](./issue-13-hash.md) |
| [#14](https://github.com/C0piIot/webgallery/issues/14) | [Uploader: HEAD-then-PUT with multipart for >50 MB](./issue-14-upload.md) |
