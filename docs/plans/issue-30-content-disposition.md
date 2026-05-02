# Plan — Issue #30: `Content-Disposition` on upload

## Bug-shaped feature

Hash-keyed objects in the bucket download with hash names from the provider's web console (`abc123def....jpg`). Set `Content-Disposition: attachment; filename="<original>"` on every upload so direct downloads land with the human-friendly filename instead.

The original filename is already stored as `x-amz-meta-filename` (since #14) but custom metadata isn't honored by browser download UIs — `Content-Disposition` is.

## Approach

### 1. `lib/bucket.js` — accept `contentDisposition` on PUT + multipart create

Today `put(key, body, { contentType, metadata })` and `createMultipartUpload(key, { contentType, metadata })` set Content-Type and `x-amz-meta-*`. Add an optional `contentDisposition` field that becomes the `Content-Disposition` request header. (No need on `uploadPart` — disposition only matters on the initiating call.)

### 2. `lib/upload.js` — build the header value, pass it through

```js
function contentDispositionFor(entry) {
  // Strip characters that break the quoted-string form.
  const safe = entry.name.replace(/["\\\r\n]/g, '_');
  // RFC 5987: non-ASCII names need filename* with UTF-8 percent-encoding.
  // ASCII-only names use the simpler quoted form.
  if (/^[\x20-\x7e]+$/.test(safe)) {
    return `attachment; filename="${safe}"`;
  }
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(entry.name)}`;
}
```

Both single-PUT and multipart-create callsites pass `contentDisposition: contentDispositionFor(entry)`.

### 3. CSP / CORS

No change. Same origin still owns the bucket; we're adding a request header that we already sign.

## Tests

### Unit — `tests/lib/upload.test.js`

- ASCII filename → `attachment; filename="IMG_1234.jpg"`.
- Non-ASCII filename (e.g. `名前.jpg`) → both `filename=` (sanitized) and `filename*=UTF-8''<encoded>` present.
- Filename with quote/backslash → quote+backslash replaced with `_` in the quoted form.
- `client.put` mock receives `contentDisposition`.
- `client.createMultipartUpload` mock receives `contentDisposition`.

### E2E — extend `e2e/upload.spec.js`

After the existing single-PUT test asserts metadata, also assert the `HEAD` response carries `Content-Disposition` with the original filename. Same for the multipart test.

## Files

**Created**
- `docs/plans/issue-30-content-disposition.md` (this file).

**Modified**
- `lib/bucket.js` — `put` and `createMultipartUpload` accept `contentDisposition`.
- `lib/upload.js` — `contentDispositionFor` helper; passed through both upload paths.
- `tests/lib/upload.test.js` — assert header shape + plumbing.
- `tests/lib/bucket.test.js` — assert the header lands on the actual PUT request.
- `e2e/upload.spec.js` — HEAD asserts on Content-Disposition.
- `docs/plans/README.md` — index entry for #30.

(No SW bump needed — only `lib/*.js` source changed; those are already in `SHELL`. But VERSION must still bump because file contents changed: v25 → v26.)

## Verification

1. `make lint` / `make test` — new unit assertions pass; existing 120 still pass.
2. `make e2e` — extended PUT + multipart tests pass.
3. Manual smoke at deploy: upload a photo, click the hash key in the B2 console → file saves as the original name.

## Out of scope

- Backfilling existing objects. Old uploads stay hash-named on download. A one-shot migration that copies each object onto itself with the new header is possible but not worth it for v1.
- Other download-UX headers (`Cache-Control`, etc.).

## Risks

- **Provider quirks**: B2 / R2 accept arbitrary headers signed by SigV4; AWS S3 documents `Content-Disposition` as a standard PUT request header. MinIO honors it. Low risk.
- **Filename character-class corner cases**: emoji/CJK/RTL filenames — covered by the `filename*=UTF-8''...` fallback and the quote-stripping regex.
