// Generic retry-with-exponential-backoff helper.
//
// Used by the sync worker (#15) to make transient upload failures
// self-heal without burning the whole file. The classifier
// (`isTransientError`) is conservative: only signals that genuinely
// indicate "try again later" trigger a retry. Permanent errors —
// auth, signature mismatch, bad request — fail immediately.

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY = 1000;
const DEFAULT_MAX_DELAY = 60_000;

const defaultDelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {{
 *   maxAttempts?: number,
 *   baseDelay?: number,
 *   maxDelay?: number,
 *   isTransient?: (err: unknown) => boolean,
 *   onRetry?: (err: unknown, attempt: number, delayMs: number) => void,
 *   delayFn?: (ms: number) => Promise<void>,
 * }} [opts]
 * @returns {Promise<T>}
 */
export async function retryWithBackoff(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelay = opts.baseDelay ?? DEFAULT_BASE_DELAY;
  const maxDelay = opts.maxDelay ?? DEFAULT_MAX_DELAY;
  const isTransient = opts.isTransient ?? isTransientError;
  const onRetry = opts.onRetry;
  const delayFn = opts.delayFn ?? defaultDelayFn;

  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const isLast = attempt === maxAttempts - 1;
      if (!isTransient(err) || isLast) throw err;
      const delay = Math.min(maxDelay, baseDelay * 2 ** attempt);
      onRetry?.(err, attempt, delay);
      await delayFn(delay);
    }
  }
  // Unreachable (the loop either returns or throws).
  throw lastErr;
}

/**
 * Default classifier. Network errors and 5xx / 429 retry; everything
 * else fails fast.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransientError(err) {
  if (err && typeof err === 'object' && err.name === 'BucketError') {
    const status = /** @type {{status?: number}} */ (err).status;
    return typeof status === 'number' && (status >= 500 || status === 429);
  }
  // fetch() rejects with TypeError for network / DNS failures.
  return err instanceof TypeError;
}
