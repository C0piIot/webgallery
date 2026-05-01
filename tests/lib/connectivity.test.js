// @vitest-environment happy-dom

// Unit tests for lib/connectivity.js. happy-dom gives us window-style
// addEventListener and a navigator with onLine.

import { describe, test, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  // Restore navigator.onLine to true between tests.
  Object.defineProperty(navigator, 'onLine', {
    value: true,
    configurable: true,
    writable: true,
  });
});

describe('lib/connectivity.js', () => {
  test('isOnline returns navigator.onLine', async () => {
    const { isOnline } = await import('../../lib/connectivity.js');
    expect(isOnline()).toBe(true);
    Object.defineProperty(navigator, 'onLine', {
      value: false,
      configurable: true,
      writable: true,
    });
    expect(isOnline()).toBe(false);
  });

  test('onChange callback fires on online event', async () => {
    const { onChange } = await import('../../lib/connectivity.js');
    const cb = vi.fn();
    onChange(cb);
    window.dispatchEvent(new Event('online'));
    expect(cb).toHaveBeenCalledWith(true);
  });

  test('onChange callback fires on offline event', async () => {
    const { onChange } = await import('../../lib/connectivity.js');
    const cb = vi.fn();
    onChange(cb);
    window.dispatchEvent(new Event('offline'));
    expect(cb).toHaveBeenCalledWith(false);
  });

  test('returned unsubscribe stops further callbacks', async () => {
    const { onChange } = await import('../../lib/connectivity.js');
    const cb = vi.fn();
    const unsub = onChange(cb);
    window.dispatchEvent(new Event('online'));
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    window.dispatchEvent(new Event('offline'));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('_resetForTesting clears subscribers + cached registration', async () => {
    const { onChange, _resetForTesting } = await import('../../lib/connectivity.js');
    const cb = vi.fn();
    onChange(cb);
    _resetForTesting();
    window.dispatchEvent(new Event('online'));
    expect(cb).not.toHaveBeenCalled();
  });
});
