// Unit tests for lib/retry.js. Tests inject an instant `delayFn` so
// the suite never actually sleeps.

import { describe, test, expect, vi } from 'vitest';
import { retryWithBackoff, isTransientError } from '../../lib/retry.js';

const noDelay = () => Promise.resolve();

function transientErr(status = 503, message = 'transient') {
  const e = new Error(message);
  e.name = 'BucketError';
  e.status = status;
  return e;
}

function permanentErr(status = 403, message = 'permanent') {
  const e = new Error(message);
  e.name = 'BucketError';
  e.status = status;
  return e;
}

describe('lib/retry.js', () => {
  test('succeeds on first attempt — fn called once', async () => {
    const fn = vi.fn(async () => 'ok');
    const result = await retryWithBackoff(fn, { delayFn: noDelay });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries until success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientErr())
      .mockRejectedValueOnce(transientErr())
      .mockResolvedValueOnce('ok');
    const result = await retryWithBackoff(fn, { delayFn: noDelay });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('stops on permanent error — single attempt', async () => {
    const err = permanentErr(403);
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      retryWithBackoff(fn, { delayFn: noDelay }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('throws after maxAttempts on persistent transient', async () => {
    const fn = vi.fn().mockRejectedValue(transientErr(503, 'still bad'));
    await expect(
      retryWithBackoff(fn, { maxAttempts: 4, delayFn: noDelay }),
    ).rejects.toThrow(/still bad/);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  test('backoff schedule respected (cap at maxDelay)', async () => {
    const delays = [];
    const delayFn = vi.fn(async (ms) => {
      delays.push(ms);
    });
    const fn = vi.fn().mockRejectedValue(transientErr(503));
    await expect(
      retryWithBackoff(fn, {
        maxAttempts: 7,
        baseDelay: 100,
        maxDelay: 1000,
        delayFn,
      }),
    ).rejects.toBeDefined();
    // 7 attempts → 6 delays before giving up.
    // Pure expo: 100, 200, 400, 800, 1600 (capped 1000), 3200 (capped 1000)
    expect(delays).toEqual([100, 200, 400, 800, 1000, 1000]);
  });

  test('onRetry invoked with (err, attempt, delayMs) per scheduled retry', async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientErr(503, 'a'))
      .mockRejectedValueOnce(transientErr(503, 'b'))
      .mockResolvedValueOnce('ok');
    await retryWithBackoff(fn, {
      baseDelay: 10,
      onRetry,
      delayFn: noDelay,
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][1]).toBe(0); // attempt
    expect(onRetry.mock.calls[0][2]).toBe(10); // delay
    expect(onRetry.mock.calls[1][1]).toBe(1);
    expect(onRetry.mock.calls[1][2]).toBe(20);
  });

  test('isTransientError classification', () => {
    expect(isTransientError(transientErr(500))).toBe(true);
    expect(isTransientError(transientErr(503))).toBe(true);
    expect(isTransientError(transientErr(429))).toBe(true);
    expect(isTransientError(permanentErr(400))).toBe(false);
    expect(isTransientError(permanentErr(403))).toBe(false);
    expect(isTransientError(permanentErr(404))).toBe(false);
    expect(isTransientError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransientError(new Error('weird'))).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });
});
