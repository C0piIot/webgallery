# Plan — Issue #12: Incremental directory walker (batched, yielding)

## Context

First piece of M4 (sync engine). The architecture doc (`docs/architecture.md` — *Known constraints / risks* and *Sync flow* step 2) is unambiguous: directory walking on Android Chrome **must** be incremental — pulled in small batches with the event loop yielded between them — or the browser hangs on a real DCIM with 10k+ files. This issue ships the walker in isolation; the hasher (#13), uploader (#14), and controller (#15) consume it later.

The walker is a tiny pure-data module: take a `FileSystemDirectoryHandle`, recurse, emit entries. No hashing, no IO beyond `getFile()` for size/mtime, no network.

## Approach

### 1. API

```js
// async generator. Each iteration yields a *batch* (array) of entries
// with up to `batchSize` items (default 32). Batches arrive
// incrementally; the walker yields control to the event loop between
// batches via the configured `yieldFn` (default: setTimeout 0).
//
// Entry shape: { path, name, size, mtime, file }
//   - path: full path relative to the root, "/" separator
//   - name: basename
//   - size: file.size
//   - mtime: file.lastModified (ms)
//   - file: the underlying File (for hashing/upload later)
export async function* walkFolder(rootHandle, options = {}) { ... }
```

Consumer code:

```js
for await (const batch of walkFolder(handle)) {
  for (const entry of batch) {
    // process one entry — hash, dedup-check, upload, etc.
  }
}
```

The "batches as the unit of iteration" choice:

- Makes the **batch boundary observable to tests** (assert `batch.length <= batchSize`) and to consumers that want to flush UI updates per batch.
- Keeps the **yield-to-event-loop point explicit** — one `await yieldFn()` per batch, not buried per-entry.
- Compromise: consumers do an inner `for` loop. Tiny ergonomic cost; net wins for the architectural property the issue is actually about.

### 2. Implementation sketch

```js
const DEFAULT_BATCH_SIZE = 32;
const defaultYield = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function* walkFolder(rootHandle, options = {}) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const yieldFn = options.yieldFn ?? defaultYield;

  let batch = [];
  for await (const entry of walkRecursive(rootHandle, '')) {
    batch.push(entry);
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
      await yieldFn();
    }
  }
  if (batch.length > 0) yield batch;
}

async function* walkRecursive(dirHandle, pathPrefix) {
  for await (const [name, handle] of dirHandle.entries()) {
    const path = pathPrefix ? `${pathPrefix}/${name}` : name;
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      yield {
        path,
        name,
        size: file.size,
        mtime: file.lastModified,
        file,
      };
    } else if (handle.kind === 'directory') {
      yield* walkRecursive(handle, path);
    }
  }
}
```

Notes:

- **No accumulator across recursion.** `walkRecursive` is itself an async generator; each level yields up. Memory is bounded to one batch + the recursion stack — no full file list ever materializes.
- **`yieldFn` is injectable.** Default uses `setTimeout(0)` (real macrotask boundary — the architecture's anti-hang measure). Tests pass their own `vi.fn()` to count calls without spying on global timers.
- **Skips entry kinds we don't recognize.** Currently only `file` and `directory` exist in the spec, but if a future kind appears it's silently ignored rather than crashing.
- **Path separator is `/`.** Matches POSIX and the URL-style key construction in `lib/bucket.js`. The `name` portion can contain anything FSA allows; we store it as-is (no normalization). Downstream modules that build object keys are responsible for any encoding.

### 3. File location

`lib/walker.js`. Flat under `lib/` to match the pattern (`lib/db.js`, `lib/bucket.js`, `lib/folders.js`, `lib/capability.js`). When the sync engine grows enough that subdirectories help — likely around #15 — we revisit grouping.

### 4. Tests — `tests/lib/walker.test.js`

Mocked `FileSystemDirectoryHandle`s: plain objects with `kind`, `entries()` async generator, and `getFile()`. Real FSA handles aren't available in Node Vitest — and not needed; the walker's contract is the iterator protocol.

Test helpers:

```js
function makeFile(name, size = 1, mtime = 0) {
  return {
    kind: 'file',
    getFile: async () => ({
      name, size, lastModified: mtime,
      // toy methods so "instanceof File" isn't required by the walker
    }),
  };
}

function makeDir(entries) {
  return {
    kind: 'directory',
    entries: async function* () {
      for (const pair of entries) yield pair;
    },
  };
}
```

Cases (~9):

1. **Empty directory** — generator completes with zero batches.
2. **Single file** — one batch of length 1; entry has correct `path`/`name`/`size`/`mtime`.
3. **Multiple files at root** — batch contents and ordering match insertion order.
4. **Nested structure** (`a/`, `a/b/`, `a/b/c.jpg`) — the file's `path` is `'a/b/c.jpg'`, leaves come out in DFS order.
5. **Default batch size is 32** — 100 files → first three batches have 32, last has 4.
6. **Custom batch size** — `batchSize: 5` → 23 files → batches of 5,5,5,5,3.
7. **`yieldFn` is invoked once per *complete* batch, not per entry** — count via injected `vi.fn()`. With 23 files at batch size 5, expect 4 invocations (after the four full batches; the final partial batch is yielded but no `yieldFn` call follows it).
8. **Stress: 1000 files in one directory** — completes; total entries === 1000; every batch has `length <= 32`.
9. **Stress: 100 directories × 10 files** — completes; all 1000 files emitted; paths form `dir-N/file-M.jpg` shape.

Each test runs in default Node environment (no DOM needed). No fake-indexeddb either — the walker doesn't touch IDB.

### 5. Service Worker shell

`lib/walker.js` is part of the runtime shell (the worker will import it from #15). Add to `SHELL`. Bump `sw.js` `VERSION` from `v8` → `v9`.

### 6. Verification

1. `make lint` — passes.
2. `make test` — 52 → ~61 unit (9 new). Existing tests untouched.
3. `make e2e` — 14/14 still green; no e2e-relevant code change in #12.
4. CI green.

If any test fails, that's the verification — fix and re-run.

### 7. Commit + close

One commit (`Closes #12`) covering: `lib/walker.js`, `tests/lib/walker.test.js`, `sw.js` version bump, plus `docs/plans/issue-12-walker.md` and the index update.

## Files

**Created:**
- `lib/walker.js`
- `tests/lib/walker.test.js`
- `docs/plans/issue-12-walker.md` (frozen copy of this plan)

**Modified:**
- `sw.js` — bump `VERSION` to `v9`, add `./lib/walker.js` to `SHELL`.
- `docs/plans/README.md` — add #12 to the index.

## Out of scope for this issue (handled later)

- **Hashing** — `tests/lib/hash.test.js` and `lib/hash.js` are **#13**. The walker emits the `File` object; the hasher consumes it.
- **Skipping unchanged files via the `sync_index`** — done in the sync controller (#15) before invoking the walker, not inside it. Walker stays "what's in the directory tree, period."
- **Filtering by extension / file type** — defer until users ask.
- **Symlink / shortcut handling** — FSA spec doesn't expose them as a separate kind on Android Chrome; nothing to do.
- **Live updates / re-walking on directory changes** — re-runs are triggered by the controller when sync starts; the walker itself is a one-shot enumerator.

## Sources / references

- `docs/architecture.md` — *Sync flow* step 2 (the batching rule), *Known constraints / risks* (large directories hang Android Chrome).
- Issue #12 acceptance criteria.
- [MDN — `FileSystemDirectoryHandle.entries()`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemDirectoryHandle/entries) for the iterator contract.
