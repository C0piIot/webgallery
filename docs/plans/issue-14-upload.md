# Plan — Issue #14: Uploader: HEAD-then-PUT with multipart for >50 MB

## Context

Third piece of M4. The walker (#12) emits `{path, name, size, mtime, file}`; the hasher (#13) computes a hex SHA-256. This issue takes those plus the `BucketClient` from #6 and pushes the bytes to S3 — via single PUT for small files and the multipart sequence for large ones — under the content-addressable key the architecture commits to (`{prefix}/media/{sha256}.{ext}`). It also closes the loop on dedup: HEAD before PUT, skip if already there.

After this lands, every other module that uses BucketClient at all (#15 sync controller, #18 Remote tab, #19 detail+delete) inherits a tested upload path, and the recommended lifecycle policy for incomplete multipart cleanup is documented for users.

## Approach

### 1. API

```js
// lib/upload.js
//
// Uploads a single file to S3-compatible storage under
// {prefix}/media/{sha256}.{ext}. HEAD-checks first to skip duplicates.
// Switches to multipart when file.size > threshold.
//
// @param client   - BucketClient from createBucketClient(config)
// @param entry    - { path, name, size, hash, file, capturedAt? }
// @param opts     - { prefix, threshold?, partSize?, onProgress?, signal? }
// @returns        - { skipped: true } if the object already exists,
//                   { skipped: false, etag } after upload.
export async function uploadFile(client, entry, opts);
```

`entry` is the shape downstream of walker + hasher. `capturedAt` is optional ISO-8601; the actual EXIF / mp4 metadata extraction is **not** in #14 — for now the caller passes it through (or `undefined`). This keeps #14 focused on the bytes-to-bucket path.

`opts.threshold` defaults to 50 MB; `opts.partSize` defaults to 8 MB. Both override-able for tests (so we don't have to ship multi-MB fixtures to exercise multipart) and for tuning later.

### 2. Key + headers construction

```js
function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i < 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

function keyFor(prefix, hash, name) {
  const ext = extOf(name);
  return ext ? `${prefix}/media/${hash}.${ext}` : `${prefix}/media/${hash}`;
}

function metaFor(entry) {
  const m = {
    filename: entry.name,
    'source-path': entry.path,
  };
  if (entry.capturedAt) m['captured-at'] = entry.capturedAt;
  return m;
}

function contentTypeFor(entry) {
  // Browser-populated File.type wins; fall back to a small lookup;
  // octet-stream as a final default.
  if (entry.file.type) return entry.file.type;
  return EXT_MIME[extOf(entry.name)] ?? 'application/octet-stream';
}

const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', avi: 'video/x-msvideo',
  m4v: 'video/x-m4v',
};
```

The metadata namespace is what `lib/bucket.js` already emits as `x-amz-meta-*` headers. No surprises here; matches the architecture's *Object layout*.

### 3. Flow

```js
export async function uploadFile(client, entry, opts) {
  const prefix = opts.prefix;
  const threshold = opts.threshold ?? 50 * 1024 * 1024;
  const partSize = opts.partSize ?? 8 * 1024 * 1024;
  const onProgress = opts.onProgress;
  const signal = opts.signal;

  if (!prefix) throw new Error('prefix is required');
  if (!entry.hash) throw new Error('entry.hash is required');

  const key = keyFor(prefix, entry.hash, entry.name);
  const metadata = metaFor(entry);
  const contentType = contentTypeFor(entry);

  // 1. HEAD-check for dedup. 200 → skip. 404 (BucketError, status 404) → continue.
  try {
    await client.head(key);
    return { skipped: true };
  } catch (err) {
    if (err?.status !== 404) throw err;
  }

  signal?.throwIfAborted?.();

  // 2. Single PUT vs multipart by size.
  if (entry.size <= threshold) {
    const { etag } = await client.put(key, entry.file, {
      contentType,
      metadata,
    });
    if (onProgress) onProgress(entry.size, entry.size);
    return { skipped: false, etag };
  }
  return await uploadMultipart(client, entry, {
    key, contentType, metadata, partSize, onProgress, signal,
  });
}
```

Multipart helper:

```js
async function uploadMultipart(client, entry, ctx) {
  const { key, contentType, metadata, partSize, onProgress, signal } = ctx;
  const { uploadId } = await client.createMultipartUpload(key, {
    contentType, metadata,
  });
  const parts = [];
  let uploaded = 0;
  try {
    let partNumber = 1;
    for (let offset = 0; offset < entry.size; offset += partSize) {
      signal?.throwIfAborted?.();
      const end = Math.min(offset + partSize, entry.size);
      const slice = entry.file.slice(offset, end);
      const { etag } = await client.uploadPart(key, uploadId, partNumber, slice);
      parts.push({ partNumber, etag });
      uploaded = end;
      if (onProgress) onProgress(uploaded, entry.size);
      partNumber++;
    }
    const { etag } = await client.completeMultipartUpload(key, uploadId, parts);
    return { skipped: false, etag };
  } catch (err) {
    try { await client.abortMultipartUpload(key, uploadId); } catch { /* swallow */ }
    throw err;
  }
}
```

Decisions baked in:
- **Sequential parts.** v1 doesn't parallelize. Simpler, correct; #16's retry/backoff layer will mostly hide latency. Parallelism is a follow-up if it earns its weight.
- **Abort-on-any-error during multipart.** Per the issue: "aborts on permanent failure." The uploader treats any error as permanent at its level — the controller (#15) and retry layer (#16) decide whether to *re-attempt* the whole file. Splitting "transient vs permanent" inside the uploader would duplicate logic.
- **`entry.file.slice(offset, end)`** uses the `Blob.slice` interface — works on `File` and on test `Blob`s alike, doesn't materialize the whole file.
- **No streaming PUT body.** The uploader passes the full `Blob` (or slice) to `client.put` / `client.uploadPart`; aws4fetch hashes it for SigV4 signing. For multipart, each part is at most `partSize` bytes (~8 MB) — well within the "never load whole file" rule.

### 4. README — lifecycle policy snippet

Add a new "Recommended bucket setup" subsection under the existing "Running tests locally" / "Working on this repo" cluster (or its own section near the top, before "Stack"):

```markdown
## Recommended bucket setup

The uploader uses S3 multipart for files larger than 50 MB. If a multipart
upload is interrupted (network drop, browser tab closure), the parts that
were already uploaded sit in the bucket as orphaned chunks until cleaned
up. Add this lifecycle rule to your bucket so they're auto-cleaned after
seven days:

\`\`\`json
{
  "Rules": [
    {
      "ID": "abort-incomplete-multipart",
      "Status": "Enabled",
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    }
  ]
}
\`\`\`

Apply via your provider's console or CLI (e.g. `aws s3api
put-bucket-lifecycle-configuration`, `mc ilm rule add`).
```

### 5. Tests — `tests/lib/upload.test.js` (unit)

Mocked `BucketClient` (a plain object with `vi.fn()` for `head` / `put` / `createMultipartUpload` / `uploadPart` / `completeMultipartUpload` / `abortMultipartUpload`). No real network, no real bucket.

Cases (~10):

- **Skips upload when HEAD returns 200** — `client.head` resolves; `client.put` not called; result `{ skipped: true }`.
- **HEAD 404 → single PUT** — `client.head` rejects with `{status: 404}`; `client.put` called once with `key={prefix}/media/{hash}.{ext}`; result `{ skipped: false, etag }`.
- **HEAD non-404 error rethrown** — `client.head` rejects with `{status: 500}`; `uploadFile` rejects with the same error; nothing else called.
- **Single PUT: key, content-type, and metadata headers** — assert `key` ends in `/{hash}.jpg`, `contentType` is `image/jpeg` (from `file.type`), metadata is `{filename, source-path}` (no captured-at when entry omits it).
- **`captured-at` metadata included when entry has it** — entry with `capturedAt: '2025-01-15T00:00:00Z'` → metadata includes that key.
- **Extension fallback** — `name: 'IMG_0001'` (no extension) → key has no trailing dot.
- **Multipart triggered above threshold** — 1 KB threshold + 4 KB Blob → `createMultipartUpload` called once, `uploadPart` 4 times (parts 1..4), `completeMultipartUpload` once with 4 parts. `client.put` not called.
- **Multipart aborts on `uploadPart` failure** — second part rejects → `abortMultipartUpload` called with the same uploadId; the original error propagates.
- **Multipart progress callback fires per part** — for the same 1 KB threshold + 4 KB Blob, `onProgress` called 4 times with monotonic byte counts ending at file.size.
- **Single-PUT progress callback fires once at completion** — `onProgress` called exactly once with `(file.size, file.size)`.

### 6. Tests — `e2e/upload.spec.js` (real MinIO)

Drives `uploadFile` from a Playwright `page.evaluate` against a small Blob built in the page. Three cases:

1. **Single PUT round-trip** — small Blob, default threshold; assert HEAD on the resulting key returns 200, size + content-type + metadata match.
2. **Multipart round-trip with tiny threshold** — `threshold: 100`, `partSize: 32`, ~200-byte Blob (2 full + 1 partial parts) → completes; HEAD returns 200; size matches; metadata matches.
3. **Second call is a no-op** — same content uploaded again returns `{ skipped: true }`; only HEAD is called (we can verify by counting BucketClient method invocations exposed via a debug mode, OR simpler: just assert the function returns `{ skipped: true }`).

Test mechanics:

- The test page is `setup-storage.html?e2e=1` (already has `?e2e=1` machinery in #10's setup-folders; we can extend that pattern). Reuses `lib/bucket.js` + `lib/hash.js` + `lib/upload.js` already loaded by the page.
- Helper exposed under `?e2e=1`: `window.__test_upload__(blobData, name, opts)` does the hash + uploadFile.
- After upload, the test calls another helper that does `client.head(key)` and returns the metadata for assertion.

Endpoints come from the same `MINIO_*` env vars the storage spec uses.

### 7. Service Worker shell

`lib/upload.js` joins `SHELL`. Bump `sw.js` `VERSION` from `v10` → `v11`.

### 8. Verification

1. `make lint` — passes.
2. `make test` — 69 → ~79 unit (10 new). Existing tests untouched.
3. `make e2e` — 14 → 17 e2e. New cases run against the real MinIO compose service.
4. CI green.

If any test fails, that's the verification — fix and re-run.

### 9. Commit + close

One commit (`Closes #14`) covering: `lib/upload.js`, `tests/lib/upload.test.js`, `e2e/upload.spec.js`, the README lifecycle section, page hook(s) for the e2e, `sw.js` version bump, plus `docs/plans/issue-14-upload.md` and the index update.

## Files

**Created:**
- `lib/upload.js`
- `tests/lib/upload.test.js`
- `e2e/upload.spec.js`
- `docs/plans/issue-14-upload.md` (frozen copy of this plan)

**Modified:**
- `README.md` — add the "Recommended bucket setup" section with the lifecycle JSON.
- `setup-storage.js` — extend the existing `?e2e=1` exposure pattern with `__test_upload__` / `__test_head__` helpers (gated, only reachable with `?e2e=1`).
- `sw.js` — bump `VERSION` to `v11`, add `./lib/upload.js` to `SHELL`.
- `docs/plans/README.md` — add #14 to the index.

## Out of scope for this issue (handled later)

- **EXIF / mp4 metadata extraction for `capturedAt`.** Not in #14. Caller passes `capturedAt` if it has one (the controller / future metadata module supplies). The architecture's *Object layout* commits to `x-amz-meta-captured-at` being set "when extractable" — we ship the plumbing now, the extractor later.
- **Per-file retry / backoff on transient failures.** That's **#16**. The uploader rethrows; the retry layer catches + decides.
- **Streaming PUT body** (writable-stream upload with per-byte progress for single PUT). Browser support is uneven and we don't need it for v1.
- **Parallel part uploads** — sequential is fine. Revisit if multipart durations become a UX problem.
- **EnableSyncCollection / change-tracking** for incremental uploads — handled at the controller level via `sync_index` lookups (#15), not here.
- **Resuming an interrupted multipart upload** — drops on the floor for v1. Lifecycle rule cleans the orphan; the next sync re-creates from scratch. Resumable uploads are a real feature but a sizable one; defer.

## Sources / references

- `docs/architecture.md` — *Sync flow* step 4 (HEAD-then-PUT with multipart over threshold); *Talking to S3* (multipart shape, lifecycle recommendation); *Object layout* (key + metadata schema).
- Issue #14 acceptance criteria.
- `lib/bucket.js` (#6) — `head` / `put` / multipart methods consumed here.
- `lib/walker.js` (#12) — entry shape produced upstream.
- `lib/hash.js` (#13) — hex hash produced upstream.
- AWS S3 docs on `AbortIncompleteMultipartUpload` lifecycle rule.
