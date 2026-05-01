// Unit tests for lib/folders.js. Same fake-indexeddb pattern as the
// other lib tests — fresh IDBFactory + vi.resetModules() per test.
// FSA-shaped objects are plain JS mocks; structured clone round-trips
// them through IndexedDB just like any other object.

import { IDBFactory } from 'fake-indexeddb';
import { describe, test, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  delete globalThis.showDirectoryPicker;
});

// Real FileSystemDirectoryHandle is structured-cloneable in browsers via
// internal slots. fake-indexeddb does generic structured clone, which
// rejects function-bearing objects (e.g. vi.fn methods). Two helpers:
// - makeHandle: clone-safe, for lifecycle tests that round-trip through IDB.
// - makePermissionHandle: carries vi.fn methods, for permission-flow tests
//   where the handle is passed to ensurePermissions without going through IDB.
function makeHandle({ name = 'Photos' } = {}) {
  return { name, kind: 'directory' };
}

function makePermissionHandle({ name = 'Photos', perm = 'granted' } = {}) {
  return {
    name,
    kind: 'directory',
    queryPermission: vi.fn(async () => perm),
    requestPermission: vi.fn(async () => perm),
  };
}

describe('lib/folders.js', () => {
  test('isFsaAvailable: false when showDirectoryPicker missing, true when present', async () => {
    const { isFsaAvailable } = await import('../../lib/folders.js');
    expect(isFsaAvailable()).toBe(false);
    globalThis.showDirectoryPicker = vi.fn();
    expect(isFsaAvailable()).toBe(true);
  });

  test('addFolder rejects with a clear error when FSA is missing', async () => {
    const { addFolder } = await import('../../lib/folders.js');
    await expect(addFolder()).rejects.toThrow(/File System Access/i);
  });

  test('addFolder happy path: persists handle + label, returns record with id', async () => {
    const handle = makeHandle({ name: 'Photos' });
    globalThis.showDirectoryPicker = vi.fn(async () => handle);
    const { addFolder } = await import('../../lib/folders.js');
    const result = await addFolder();
    expect(result.id).toBeTypeOf('number');
    expect(result.label).toBe('Photos');
    expect(result.handle).toBe(handle);
    expect(globalThis.showDirectoryPicker).toHaveBeenCalledWith({ mode: 'read' });
  });

  test('addFolder uses caller label when provided', async () => {
    globalThis.showDirectoryPicker = vi.fn(async () => makeHandle({ name: 'Photos' }));
    const { addFolder } = await import('../../lib/folders.js');
    const result = await addFolder('My Photos');
    expect(result.label).toBe('My Photos');
  });

  test('addFolder falls back to handle.name when label is whitespace', async () => {
    globalThis.showDirectoryPicker = vi.fn(async () => makeHandle({ name: 'DCIM' }));
    const { addFolder } = await import('../../lib/folders.js');
    const result = await addFolder('   ');
    expect(result.label).toBe('DCIM');
  });

  test('listFolders returns persisted records in insertion order', async () => {
    globalThis.showDirectoryPicker = vi
      .fn()
      .mockResolvedValueOnce(makeHandle({ name: 'A' }))
      .mockResolvedValueOnce(makeHandle({ name: 'B' }));
    const { addFolder, listFolders } = await import('../../lib/folders.js');
    await addFolder();
    await addFolder();
    const list = await listFolders();
    expect(list.map((r) => r.label)).toEqual(['A', 'B']);
  });

  test('removeFolder removes the right record, leaves the others', async () => {
    globalThis.showDirectoryPicker = vi
      .fn()
      .mockResolvedValueOnce(makeHandle({ name: 'A' }))
      .mockResolvedValueOnce(makeHandle({ name: 'B' }));
    const { addFolder, listFolders, removeFolder } = await import(
      '../../lib/folders.js'
    );
    const a = await addFolder();
    await addFolder();
    await removeFolder(a.id);
    const list = await listFolders();
    expect(list.map((r) => r.label)).toEqual(['B']);
  });

  test('ensurePermissions returns true when state is granted (no requestPermission call)', async () => {
    const { ensurePermissions } = await import('../../lib/folders.js');
    const h = makePermissionHandle({ perm: 'granted' });
    expect(await ensurePermissions(h)).toBe(true);
    expect(h.queryPermission).toHaveBeenCalledWith({ mode: 'read' });
    expect(h.requestPermission).not.toHaveBeenCalled();
  });

  test('ensurePermissions calls requestPermission when state is prompt; propagates result', async () => {
    const { ensurePermissions } = await import('../../lib/folders.js');
    const h = makePermissionHandle({ perm: 'prompt' });
    h.requestPermission.mockResolvedValueOnce('granted');
    expect(await ensurePermissions(h)).toBe(true);
    expect(h.requestPermission).toHaveBeenCalledWith({ mode: 'read' });
  });

  test('ensurePermissions returns false when requestPermission yields denied', async () => {
    const { ensurePermissions } = await import('../../lib/folders.js');
    const h = makePermissionHandle({ perm: 'denied' });
    h.requestPermission.mockResolvedValueOnce('denied');
    expect(await ensurePermissions(h)).toBe(false);
  });

  test('ensurePermissions returns false defensively for null / wiped handle', async () => {
    const { ensurePermissions } = await import('../../lib/folders.js');
    expect(await ensurePermissions(null)).toBe(false);
    expect(await ensurePermissions({})).toBe(false);
  });
});
