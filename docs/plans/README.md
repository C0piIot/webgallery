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
| [#15](https://github.com/C0piIot/webgallery/issues/15) | [Sync controller + BroadcastChannel + connectivity](./issue-15-sync-controller.md) |
| [#16](https://github.com/C0piIot/webgallery/issues/16) | [Retry/backoff + per-file error states](./issue-16-retry.md) |
| [#17](https://github.com/C0piIot/webgallery/issues/17) | [Local tab — sync_index render + live status badges](./issue-17-local-tab.md) |
| [#18](https://github.com/C0piIot/webgallery/issues/18) | [Remote tab — ListObjectsV2 + gallery_cache + offline](./issue-18-remote-tab.md) |
| [#19](https://github.com/C0piIot/webgallery/issues/19) | [Detail view + delete](./issue-19-detail.md) |
| [#20](https://github.com/C0piIot/webgallery/issues/20) | [CSP meta + SW caching pass + update banner](./issue-20-csp-sw.md) |
| [#21](https://github.com/C0piIot/webgallery/issues/21) | [PWA manifest icons + installability](./issue-21-icons.md) |
| [#22](https://github.com/C0piIot/webgallery/issues/22) | [Empty / error / loading states sweep](./issue-22-states.md) |
| [#23](https://github.com/C0piIot/webgallery/issues/23) | [SW update banner: SKIP_WAITING handshake](./issue-23-sw-update.md) |
| [#24](https://github.com/C0piIot/webgallery/issues/24) | [Local-tab media previews (parity with Remote)](./issue-24-local-previews.md) |
| [#28](https://github.com/C0piIot/webgallery/issues/28) | [Local thumbnails from disk](./issue-28-local-disk-thumbs.md) |
| [#29](https://github.com/C0piIot/webgallery/issues/29) | [Local thumb badge fills the ratio container](./issue-29-thumb-overlap.md) |
| [#26](https://github.com/C0piIot/webgallery/issues/26) | [Export / import bucket configuration as JSON](./issue-26-config-export-import.md) |
| [#27](https://github.com/C0piIot/webgallery/issues/27) | [In-app Help / About page](./issue-27-help-page.md) |
| [#30](https://github.com/C0piIot/webgallery/issues/30) | [Content-Disposition on upload](./issue-30-content-disposition.md) |
| [#31](https://github.com/C0piIot/webgallery/issues/31) | [Delete confirm should show the friendly filename](./issue-31-delete-confirm-filename.md) |
| [#32](https://github.com/C0piIot/webgallery/issues/32) | [Fix isFsaAvailable ReferenceError on setup-folders](./issue-32-fsa-alias-bug.md) |
