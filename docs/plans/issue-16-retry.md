# Plan — Issue #16: Retry/backoff + per-file error states

## Context

Final piece of M4. Today the worker (#15) treats every upload error as terminal — one failure → `status: errored`, `file-error` broadcast, move on. That's brittle in practice: a flaky cellular network or a momentary 5xx from the bucket shouldn't cost a file upload. This issue wraps the upload step in a transient-aware retry loop with exponential backoff so transient failures self-heal, while permanent failures (auth, signature, malformed key) bail out fast.

The `controller.retry(path)` glue from #15 already marks the entry pending in `sync_index`; nothing further is needed for manual retry in #16. The real work here is the *automatic* retry path.

## Approach

### 1. `lib/retry.js` — generic helper

```js
// retryWithBackoff(fn, opts) — runs fn(attempt), retrying on
// transient errors with exponential backoff capped at maxDelay.
//
// fn:        async (attempt: number) => T
// opts:
//   maxAttempts:  default 5 (1 initial + up to 4 retries)
//   baseDelay:    default 1000 ms
//   maxDelay:     default 60_000 ms
//   isTransient:  (err) => boolean — defaults to isTransientError below
//   onRetry:      (err, attempt, delayMs) => void — observability hook
//   delayFn:      (ms) => Promise<void> — overridable for tests
//
// Throws the most recent error if every attempt fails OR if a
// non-transient error is hit at any attempt.

export async function retryWithBackoff(fn, opts = {}) { ... }

// Default classifier. Network errors and 5xx/429 retry; everything
// else fails fast.
export function isTransientError(err) {
  if (err?.name === 'BucketError') {
    return err.status >= 500 || err.status === 429;
  }
  // fetch() rejects with TypeError for network / DNS failures.
  return err instanceof TypeError;
}
```

The classifier is conservative: only known-transient signals are retried. 4xx (auth, signature mismatch, NoSuchBucket, etc.) are permanent — repeating them just burns time.

### 2. Wiring into the sync worker

In `lib/sync-worker.js#processEntry`, the upload step already broadcasts `progress` events. Wrap **only the upload call** in the retry loop (hashing is deterministic CPU work — no need to retry).

```js
// Before:
const result = await _uploadFile(client, { ...entry, hash }, opts);

// After:
const result = await retryWithBackoff(
  (attempt) => {
    if (attempt > 0) {
      _broadcast({
        type: 'file-retry',
        path: entry.path,
        attempt,
      });
    }
    return _uploadFile(client, { ...entry, hash }, opts);
  },
  {
    isTransient: isTransientError,
    onRetry: (err, attempt, delayMs) => {
      _broadcast({
        type: 'file-retry-scheduled',
        path: entry.path,
        attempt: attempt + 1,
        delayMs,
        error: err?.message ?? String(err),
      });
    },
  },
);
```

Two new BroadcastChannel event shapes for #16:

```js
{ type: 'file-retry-scheduled', path, attempt, delayMs, error }
{ type: 'file-retry',           path, attempt }
```

`file-retry-scheduled` fires *before* the delay (so the UI can show "retrying in N s"); `file-retry` fires when the retry attempt actually starts. The Local tab in #17 will show a "retry N/5" badge driven by these.

The terminal behavior is unchanged: if the retry loop ultimately throws, `processEntry`'s outer `catch` writes `status: errored` and broadcasts `file-error` — same as today.

### 3. Injected dependencies (testability)

`runSync(deps)` already takes overridable functions. Add two more:

- `deps.retry` — defaults to `retryWithBackoff`. Tests can substitute a no-delay version or skip retries entirely.
- `deps.isTransient` — defaults to `isTransientError`. Tests vary the classifier to exercise edge cases.

Default `delayFn` uses `setTimeout`; tests pass `() => Promise.resolve()` so the suite doesn't actually sleep.

### 4. Tests — `tests/lib/retry.test.js` (~7 cases, retry helper)

```js
import { describe, test, expect, vi } from 'vitest';
import { retryWithBackoff, isTransientError } from '../../lib/retry.js';
```

- **Succeeds on first attempt** — fn resolves once; called once.
- **Retries until success** — fn rejects with transient twice, then resolves; called 3×.
- **Stops on permanent error** — fn rejects with `{name:'BucketError', status:403}`; called once; throws the same error.
- **Throws after maxAttempts** — fn always rejects with transient; called `maxAttempts` times; throws the last error.
- **Backoff schedule respected** — capture `delayFn` args; with `baseDelay:100, maxDelay:1000`, 6 transient failures → delays `[100, 200, 400, 800, 1000, 1000]` (cap at 1000).
- **`onRetry` invoked with `(err, attempt, delayMs)`** — fires once per scheduled retry, not on the initial call.
- **`isTransientError` classification** — BucketError 500/429 transient; 403/404 permanent; TypeError transient; plain Error permanent.

### 5. Tests — extend `tests/lib/sync-worker.test.js` (~3 new cases)

Reuse the mocked-deps pattern. Pass a custom `retry` that records attempts so tests stay deterministic.

- **Transient upload error: retried, eventually succeeds, broadcasts file-retry events** — `_uploadFile` rejects twice with `{name:'BucketError', status:503}`, then resolves; assert `file-retry` broadcast count, `sync_index` final status `'uploaded'`, `file-error` not broadcast.
- **Permanent upload error: single attempt, terminates, marked errored** — `_uploadFile` rejects once with `{name:'BucketError', status:403}`; assert `_uploadFile` called once, `sync_index` status `'errored'`, `file-error` broadcast.
- **All-transient exhaustion: attempts capped, eventually marked errored** — `_uploadFile` always rejects with 503; assert called `maxAttempts` times, `sync_index` status `'errored'`, last error message preserved.

### 6. E2E — `e2e/sync.spec.js` extension (1 new test)

Use Playwright's `page.route()` to make MinIO transiently fail the **first** PUT for a key, then allow subsequent attempts through. The retry loop kicks in inside the worker; sync still completes. Verifies the full stack — worker → fetch → page route → MinIO — handles transient failures correctly.

```js
test('retries past a transient PUT failure and completes', async ({ page }) => {
  await page.goto('/setup-storage.html?e2e=1');

  // Stub MinIO PUTs to fail the first time per key, then succeed.
  const failedOnce = new Set();
  await page.route('**/test-bucket/**', async (route, request) => {
    if (request.method() === 'PUT' && !failedOnce.has(request.url())) {
      failedOnce.add(request.url());
      await route.fulfill({
        status: 503,
        contentType: 'application/xml',
        body: '<?xml version="1.0"?><Error><Code>SlowDown</Code><Message>retry me</Message></Error>',
      });
      return;
    }
    await route.continue();
  });

  // Same setup as the happy path, single file.
  // ... __test_save_config__, __test_seed_folder__, __test_clear_sync_index__ ...
  const events = await page.evaluate(() => window.__test_sync_run__());
  expect(events.filter((e) => e.type === 'file-retry')).toHaveLength(1);
  expect(events.filter((e) => e.type === 'file-uploaded')).toHaveLength(1);
});
```

Caveat: `page.route()` only intercepts the **page** context's requests, not the Worker's. Workers have their own network stack. If `page.route` doesn't apply, fall back to a unit-style test where we substitute the BucketClient via a `?e2e=1` hook that returns a flaky client. I'll attempt page.route first and pivot if it doesn't work — Playwright 1.42+ added `serviceWorkers: 'allow'` and Worker request interception is an active area; we'll see at run time.

If neither route-interception nor hook-injection works cleanly, we settle for unit-test coverage of the retry path and skip the e2e for #16. The unit tests are exhaustive; the e2e is gravy.

### 7. Service Worker shell

`lib/retry.js` joins `SHELL`. Bump `sw.js` `VERSION` from `v12` → `v13`.

### 8. Verification

1. `make lint` — passes.
2. `make test` — 97 → ~107 unit (7 retry + 3 sync-worker).
3. `make e2e` — 18 → 19 e2e if the route interception works; else stays at 18.
4. CI green.

### 9. Commit + close

One commit (`Closes #16`) covering: `lib/retry.js`, `tests/lib/retry.test.js`, `lib/sync-worker.js` retry wiring, `tests/lib/sync-worker.test.js` additions, `e2e/sync.spec.js` extension (or note the deferral), `sw.js` version bump, plus `docs/plans/issue-16-retry.md` and the index update.

## Files

**Created:**
- `lib/retry.js`
- `tests/lib/retry.test.js`
- `docs/plans/issue-16-retry.md` (frozen copy of this plan)

**Modified:**
- `lib/sync-worker.js` — wrap `_uploadFile` call in `retryWithBackoff`; emit `file-retry` and `file-retry-scheduled` events; expose `retry` and `isTransient` as injectable deps.
- `tests/lib/sync-worker.test.js` — three new cases for retry behavior.
- `e2e/sync.spec.js` — one new test (transient PUT 503 → retry → success), with the route-interception caveat above.
- `sw.js` — bump `VERSION` to `v13`; add `./lib/retry.js` to `SHELL`.
- `docs/plans/README.md` — add #16 to the index.

## Out of scope for this issue (handled later)

- **Retry of the HEAD-check inside `lib/upload.js`.** A 5xx on HEAD would bubble out of `uploadFile`, get caught by the retry loop in #16, and trigger a fresh HEAD-then-upload — which is correct. No need to retry HEAD separately.
- **Retry of `ListObjectsV2` calls** (Remote tab in #18). The same `retryWithBackoff` helper will compose there if we want it; not in #16's scope.
- **Jittered backoff** (random delay component). Pure exponential is fine for v1; jitter matters when many clients hit one bucket simultaneously, which doesn't apply to our single-user deployment.
- **Per-file retry counter persisted across sync runs.** The retry counter today is in-memory per attempt-cluster — a file that errored on this run starts fresh next run. Persisting attempt counts is over-engineering for v1.
- **Manual-retry-while-running** (`controller.retry(path)` flipping the file pending and the worker noticing mid-walk). Today: `retry(path)` marks the entry pending; next sync run re-processes. The Local tab in #17 will surface "Run again" alongside per-row Retry buttons. Adequate for v1.
- **Auto-resume on online** with retry of just the previously-errored entries (vs. full re-walk). The current model re-walks; the `sync_index` skip-if-uploaded check makes this cheap. Smarter is later.

## Sources / references

- `docs/architecture.md` — *Sync flow* step 5 ("retried with backoff; a file that fails repeatedly is reported and the worker moves on rather than wedging the whole sync").
- Issue #16 acceptance criteria.
- `lib/sync-worker.js` (#15) — `processEntry`, the place the retry wraps.
- `lib/bucket.js` (#6) — `BucketError.status` is what `isTransientError` reads.
- `lib/upload.js` (#14) — the function being retried.
