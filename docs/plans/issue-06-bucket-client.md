# Plan — Issue #6: lib/bucket.js BucketClient (put/get/head/list/delete + multipart)

## Context

Single seam between the app and S3-compatible storage. Every other module that touches the bucket — `lib/config.js` (test connection in #7/#8), the uploader in the sync worker (#14), the Remote tab listing (#18), the detail view + delete (#19) — talks through this file. Provider quirks (path-style vs virtual-hosted, MinIO/R2/B2/AWS differences) live here and only here.

This issue ships the wrapper. Concrete usage by callers (and a real MinIO round-trip end-to-end) lands with **#14 uploader** which the issue explicitly acknowledges: "E2E with MinIO — full coverage lands with #14".

## Approach

### 1. Reuse the vendored `aws4fetch`

Already at `vendor/aws4fetch.js`. Exports `AwsClient` and `AwsV4Signer`. We only need `AwsClient`:

```js
new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region })
  .fetch(url, init)   // signs via SigV4, calls global fetch
```

`bucket.js` constructs one `AwsClient` per `createBucketClient(config)` call, then routes everything through `aws.fetch(...)`. No globals, no module-level state.

### 2. URL construction (the one place provider quirks live)

```js
function urlFor({ endpoint, bucket, pathStyle }, key, query) {
  const u = new URL(endpoint);
  if (pathStyle) {
    u.pathname = `/${bucket}/${key}`;
  } else {
    u.host = `${bucket}.${u.host}`;
    u.pathname = `/${key}`;
  }
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) u.searchParams.set(k, v);
    }
  }
  return u.toString();
}
```

`pathStyle` defaults are picked by **`lib/config.js`** at storage-setup time per provider (true for MinIO/B2, false for AWS S3); `bucket.js` just respects whatever it's handed.

Keys are URL-component-encoded inside `urlFor` so prefixes like `phone/media/abc.jpg` work without manual escaping.

### 3. The exported API (matches the issue's acceptance list)

```js
export function createBucketClient(config) {
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: config.region,
  });
  // ... helpers below ...
  return { put, get, head, list, delete: del,
           createMultipartUpload, uploadPart,
           completeMultipartUpload, abortMultipartUpload };
}
```

Method shapes:

```js
// put(key, body, { contentType?, metadata?: { [k]: v } }) → { etag }
// get(key) → Response (caller picks .blob/.arrayBuffer/.text)
// head(key) → { size, contentType, lastModified, etag, metadata: { [k]: v } }
// list({ prefix?, continuationToken?, maxKeys? } = {})
//   → { items: [{ key, size, lastModified, etag }], isTruncated, continuationToken? }
// delete(key) → void

// Multipart (used by #14 for files > 50 MB):
// createMultipartUpload(key, { contentType?, metadata? }) → { uploadId }
// uploadPart(key, uploadId, partNumber, body) → { etag, partNumber }
// completeMultipartUpload(key, uploadId, parts) → { etag }
// abortMultipartUpload(key, uploadId) → void
```

`metadata` keys are emitted as `x-amz-meta-<name>` request headers. `head` rebuilds the same shape from the response by stripping the prefix.

### 4. `BucketError` + response → error mapping

```js
export class BucketError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'BucketError';
    this.status = status;
    this.code = code;
  }
}

async function ensureOk(res) {
  if (res.ok) return res;
  const text = await res.text();
  const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1] || res.statusText || 'UnknownError';
  const message = text.match(/<Message>([^<]+)<\/Message>/)?.[1] || text || res.statusText;
  throw new BucketError(res.status, code, message);
}
```

S3's error XML is well-defined and stable; regex parsing avoids needing DOMParser (which Node doesn't have without a polyfill). HEAD returns no body, so `code` falls back to `statusText` for 404s — `code: 'Not Found'` is enough information for the caller.

### 5. List response parsing (regex, no DOM)

```js
function parseListXml(xml) {
  const items = [];
  for (const c of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
    items.push({
      key: c.match(/<Key>([\s\S]*?)<\/Key>/)?.[1],
      size: parseInt(c.match(/<Size>(\d+)<\/Size>/)?.[1] ?? '0', 10),
      lastModified: c.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1],
      etag: c.match(/<ETag>"?([^"<]+)"?<\/ETag>/)?.[1],
    });
  }
  const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const continuationToken =
    xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1];
  return { items, isTruncated, continuationToken };
}
```

S3's response uses entity-encoded keys (`&amp;`); we'll add a small unescape (`.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')`) on `key` and `lastModified`. Other fields don't contain reserved characters.

### 6. Multipart sketch

- `createMultipartUpload`: `POST {url}?uploads`. Parse `<UploadId>` from XML.
- `uploadPart`: `PUT {url}?partNumber={n}&uploadId={id}` with body chunk. Read `ETag` from response headers (no XML).
- `completeMultipartUpload`: `POST {url}?uploadId={id}` with body:
  ```xml
  <CompleteMultipartUpload>
    <Part><PartNumber>1</PartNumber><ETag>...</ETag></Part>
    ...
  </CompleteMultipartUpload>
  ```
  Parse final `<ETag>` from response.
- `abortMultipartUpload`: `DELETE {url}?uploadId={id}`.

These are scaffolded with the right shape but won't have heavy unit-test coverage in #6 — #14 exercises them with real bytes against MinIO.

### 7. Tests — `tests/lib/bucket.test.js`

Pattern: stub `globalThis.fetch` per test; `aws4fetch` internally calls it. Assert URL shape, method, body, and key headers. Don't assert exact `Authorization` — signing varies with timestamp.

Cases (one per method, plus error mapping):

- **put**: `PUT` URL ends in `/{key}`, body matches, `Content-Type` set, `x-amz-meta-*` headers when metadata passed.
- **get**: `GET` URL correct; returns the underlying Response unchanged.
- **head (200)**: `HEAD` URL correct; returns `{ size, contentType, lastModified, etag, metadata }` parsed from response headers.
- **head (404)**: rejects with `BucketError` carrying `status: 404`.
- **list (basic)**: `GET` URL has `list-type=2` and `prefix` query params; parses three `<Contents>` blocks.
- **list (continuation)**: passes `continuation-token`; surfaces returned `NextContinuationToken`.
- **delete**: `DELETE` URL correct.
- **path-style vs virtual-hosted**: same `put` call, `pathStyle: false` puts bucket in the host; `pathStyle: true` puts it in the path.
- **error mapping**: a `403 <Error><Code>SignatureDoesNotMatch</Code><Message>...</Message></Error>` response → `BucketError` with `status:403, code:'SignatureDoesNotMatch'`.
- **multipart create**: `POST ?uploads` returns `<UploadId>...` → `{ uploadId }`.

Multipart upload/complete/abort are sanity-checked once each (URL + method) so the next issue (#14) doesn't inherit a broken contract.

Total ~12 tests, ~80 lines of test code.

### 8. Service Worker shell

`lib/bucket.js` joins the precached shell so the module loads offline once anything imports it. Bump `sw.js` `VERSION` from `v2` → `v3` and add `./lib/bucket.js` to `SHELL`.

### 9. Verification end-to-end

1. **Unit tests:** `make test` — all existing 9 db tests stay green, plus the ~12 new bucket tests pass.
2. **Lint:** `make lint` — `node --check lib/bucket.js` passes (caught by the pre-commit hook anyway).
3. **CI:** push triggers the workflow; lint + unit + e2e jobs all green. The smoke E2E spec from #4 is unaffected; bucket-level e2e lands with #14.

If any test fails, that's the verification — fix and re-run.

### 10. Commit + close

One commit (`Closes #6`) covering: `lib/bucket.js`, `tests/lib/bucket.test.js`, `sw.js` version bump, and `docs/plans/issue-06-bucket-client.md` per the design-log convention. `docs/plans/README.md` index updated.

## Files

**Created:**
- `lib/bucket.js`
- `tests/lib/bucket.test.js`
- `docs/plans/issue-06-bucket-client.md` (frozen copy of this plan)

**Modified:**
- `sw.js` — bump `VERSION` to `v3`, add `./lib/bucket.js` to `SHELL`.
- `docs/plans/README.md` — add #6 to the index.

## Out of scope for this issue (handled later)

- **Real MinIO round-trip integration tests** — full coverage with **#14** uploader, which exercises put/multipart/head against MinIO end-to-end.
- **Provider auto-detection** (which `pathStyle` per endpoint) — lives in `lib/config.js` (#7) and the storage setup form (#8). `bucket.js` just respects the boolean.
- **Presigned URLs / read paths via signed query strings** — not required for v1; can be added later if the bucket needs to be private *and* media must render in `<img>`.
- **Retry logic** — `aws4fetch` already retries 5xx by default. Per-file retry/backoff for the sync pipeline is **#16**.
- **Streaming uploads / progress** — surfaced by the uploader in **#14**, not the BucketClient itself.

## Sources / references

- `docs/architecture.md` — *Talking to S3* (signing seam, multipart, CORS).
- `vendor/aws4fetch.js` — `AwsClient` constructor signature confirmed.
- Issue #6 acceptance criteria.
