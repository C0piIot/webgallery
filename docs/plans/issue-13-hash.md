# Plan — Issue #13: Streamed file hasher (sha256)

## Context

Second piece of M4. The walker (#12) emits `File` objects; this issue produces the `sha256` for each that the uploader (#14) uses for content-addressable keys (`{prefix}/media/{sha256}.{ext}`) and dedup.

**Reality-check on the issue wording.** The acceptance criteria says "Streams via `crypto.subtle.digest` over chunks" — but Web Crypto's `digest()` is **one-shot**. There is no `init / update / finalize`. The constraint "never loads whole file into memory" is real (a 5 GB video on a phone with 6 GB RAM = OOM crash), but it can't be satisfied by Web Crypto alone. The issue was written assuming an API that doesn't exist; the architecture's *intent* — streaming, no full buffering — is what we honor.

**Resolution:** vendor a small, audited streaming SHA-256 implementation. Use it through a thin wrapper that consumes `File.stream()` chunk-by-chunk, calls `update()` per chunk, and finalizes once the stream ends.

## Approach

### 1. Vendor `@noble/hashes` SHA-256

Library choice rationale:
- **`@noble/hashes`**: audited (used by Bitcoin / Ethereum communities), pure JS, ESM-native in 2.x. Known SHA-256 implementation.
- The library publishes per-algorithm modules but they share helpers across files — naively vendoring `sha2.js` alone won't work.
- **`esm.sh`'s `?bundle` query** rebundles the requested module + all its transitive deps into a single self-contained ESM file. Download once, commit verbatim, no module-resolution pain.

Vendoring command (run once at install time, output committed):

```
curl -sSfL 'https://esm.sh/@noble/hashes@2/sha2?bundle&target=es2022' \
  > vendor/noble-sha256.js
```

`vendor/README.md` records the URL, version, and date. Updating is the same URL with a new version.

Approx size: ~10–15 KB (SHA-256 + utils + bytesToHex).

If the bundled file's size or a future esm.sh quirk becomes a problem, fallback options are documented (hash-wasm, hand-rolled SHA-256 with FIPS 180-4 vectors). Not needed for v1.

### 2. `lib/hash.js` — wrapper

```js
import { sha256 } from '../vendor/noble-sha256.js';

const HEX = '0123456789abcdef';

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0xf];
  }
  return s;
}

/**
 * Stream-hash a File / Blob to a hex SHA-256.
 *
 * @param {Blob} file — anything with .size and .stream() (File, Blob).
 * @param {(bytesHashed: number, total: number) => void} [onProgress]
 * @returns {Promise<string>} lowercase hex SHA-256
 */
export async function hashFile(file, onProgress) {
  const hasher = sha256.create();
  const total = file.size;
  let hashed = 0;
  const reader = file.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      hashed += value.byteLength;
      if (onProgress) onProgress(hashed, total);
    }
  } finally {
    reader.releaseLock();
  }
  return bytesToHex(hasher.digest());
}
```

Notes:
- **Memory bound** is one chunk at a time. The browser decides chunk size when streaming a File; we don't dictate it. Typical chunk sizes are ~256 KB — well under any "load whole file" concern.
- **Backpressure** is handled implicitly by the stream protocol. We never read ahead.
- **`releaseLock()`** in `finally` keeps the stream usable downstream (uploader will call `file.stream()` again to PUT the bytes — see #14).
- **`Uint8Array` from `reader.read()`** flows directly into `hasher.update()`. No copy.
- **Progress callback is optional**; absent callers pay no cost.

### 3. Tests — `tests/lib/hash.test.js`

Node 22 ships `Blob` globally, and `Blob.stream()` returns a real `ReadableStream`. Tests use `new Blob([...])` as the File stand-in.

Cases (~7):

- **Known vectors** — three FIPS 180-4 reference vectors:
  - empty string → `e3b0c442 9...` (the standard SHA-256 of empty input)
  - `'abc'` → `ba7816bf 8f01cfea ...`
  - `'The quick brown fox jumps over the lazy dog'` → `d7a8fbb3 07d78094 ...`
- **Streaming integrity** — a Blob assembled from multiple chunks (different boundaries between chunks vs the input bytes) hashes to the same value as a single-chunk Blob with the same content.
- **Progress callback** — for a multi-MB Blob, `onProgress` is called multiple times; values monotonically increase; final call's `hashed` equals `total`.
- **Progress callback is optional** — passing none doesn't throw.
- **Lowercase hex output** — result is `/^[0-9a-f]{64}$/`.

(Explicitly *not* testing 5 GB files in unit tests — too slow, impractical. Verification of the streaming property is by construction and by the multi-chunk integrity test.)

### 4. Service Worker shell

`lib/hash.js` and `vendor/noble-sha256.js` join `SHELL`. Bump `sw.js` `VERSION` from `v9` → `v10`.

### 5. Verification

1. `make lint` — passes.
2. `make test` — 61 → ~68 unit (7 new). Existing tests untouched.
3. `make e2e` — 14/14 still green; no e2e change in #13.
4. CI green.

If any test fails, that's the verification — fix and re-run.

### 6. Commit + close

One commit (`Closes #13`) covering: `vendor/noble-sha256.js`, `vendor/README.md` update, `lib/hash.js`, `tests/lib/hash.test.js`, `sw.js` version bump, plus `docs/plans/issue-13-hash.md` and the index update.

## Files

**Created:**
- `vendor/noble-sha256.js` — bundled `@noble/hashes` SHA-256 from `esm.sh`.
- `lib/hash.js`
- `tests/lib/hash.test.js`
- `docs/plans/issue-13-hash.md` (frozen copy of this plan)

**Modified:**
- `vendor/README.md` — add the new dep with source URL + version + date.
- `sw.js` — bump `VERSION` to `v10`; add `./lib/hash.js` and `./vendor/noble-sha256.js` to `SHELL`.
- `docs/plans/README.md` — add #13 to the index.

## Out of scope for this issue (handled later)

- **Hashing inside the worker** — `lib/hash.js` is environment-agnostic. The worker just imports it (#15).
- **Cache by `(path, size, mtime)`** — the `sync_index` lookup that decides whether to hash at all lives in the controller (#15). Hash is pure: same bytes in, same hash out, every time.
- **Web Streams transformer interface** — could later expose a `TransformStream` that emits chunks unchanged + the final hash on close. Not needed until something needs both bytes and hash in one pass; the uploader (#14) re-opens the stream for the PUT, which is cheaper than complicating the API.
- **Algorithm choice (SHA-256 vs BLAKE3 etc.)** — content-addressable keys lock us to SHA-256 for v1. Architecture explicitly names `sha256` in the key scheme.

## Sources / references

- `docs/architecture.md` — *Sync flow* step 3 (hash with `crypto.subtle.digest`); *Object layout* (key scheme).
- Issue #13 acceptance criteria.
- [`@noble/hashes`](https://www.npmjs.com/package/@noble/hashes) — vendored library.
- [`esm.sh` ?bundle docs](https://esm.sh) — single-file bundling of npm packages.
- FIPS 180-4 SHA-256 reference vectors (canonical test inputs).
