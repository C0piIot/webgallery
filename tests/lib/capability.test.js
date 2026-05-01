// @vitest-environment happy-dom

// Unit tests for lib/capability.js. happy-dom gives us a real
// `document` for the renderFsaExplainer DOM-injection tests; the
// FSA-presence checks just toggle globalThis.showDirectoryPicker.

import { describe, test, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  delete globalThis.showDirectoryPicker;
});

describe('lib/capability.js', () => {
  test('hasFsa returns false when showDirectoryPicker is absent', async () => {
    const { hasFsa } = await import('../../lib/capability.js');
    expect(hasFsa()).toBe(false);
  });

  test('hasFsa returns true when showDirectoryPicker is present', async () => {
    globalThis.showDirectoryPicker = vi.fn();
    const { hasFsa } = await import('../../lib/capability.js');
    expect(hasFsa()).toBe(true);
  });

  test('hasFsa is cached after first call', async () => {
    globalThis.showDirectoryPicker = vi.fn();
    const { hasFsa } = await import('../../lib/capability.js');
    expect(hasFsa()).toBe(true);
    delete globalThis.showDirectoryPicker;
    // Second call still returns true because the answer is cached.
    expect(hasFsa()).toBe(true);
  });

  test('_resetForTesting clears the cache', async () => {
    globalThis.showDirectoryPicker = vi.fn();
    const { hasFsa, _resetForTesting } = await import('../../lib/capability.js');
    expect(hasFsa()).toBe(true);
    delete globalThis.showDirectoryPicker;
    _resetForTesting();
    expect(hasFsa()).toBe(false);
  });

  test('renderFsaExplainer replaces target with an alert containing the heading', async () => {
    const { renderFsaExplainer } = await import('../../lib/capability.js');
    const target = document.createElement('div');
    target.appendChild(document.createElement('span'));
    target.lastChild.textContent = 'old content';

    renderFsaExplainer(target);

    const alert = target.querySelector('.alert.alert-info');
    expect(alert).not.toBeNull();
    expect(alert.querySelector('.alert-heading').textContent).toMatch(
      /file system access/i,
    );
    // Old content is gone.
    expect(target.textContent).not.toMatch(/old content/);
  });

  test('renderFsaExplainer is a no-op when target is null', async () => {
    const { renderFsaExplainer } = await import('../../lib/capability.js');
    expect(() => renderFsaExplainer(null)).not.toThrow();
  });
});
