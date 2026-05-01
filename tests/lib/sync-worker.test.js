// Unit tests for lib/sync-worker.js — drive runSync(deps) directly,
// no Worker spawn. The Worker glue branch is skipped because Vitest's
// Node environment has no `self` matching the runtime's Worker shape.

import { describe, test, expect, vi } from 'vitest';
import { runSync } from '../../lib/sync-worker.js';

const CONFIG = {
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'b',
  prefix: 'phone',
  accessKeyId: 'X',
  secretAccessKey: 'Y',
  pathStyle: false,
};

function fakeDb(initial = []) {
  const store = new Map(initial.map((r) => [r.path, r]));
  return {
    get: vi.fn(async (_store, key) => store.get(key)),
    put: vi.fn(async (_store, value) => {
      store.set(value.path, value);
    }),
    _all: () => [...store.values()],
  };
}

function fakeWalker(entries) {
  return async function* (_handle) {
    yield entries;
  };
}

function entry(path, size = 100, mtime = 1) {
  return { path, name: path.split('/').pop(), size, mtime, file: new Blob([path]) };
}

describe('lib/sync-worker.js → runSync', () => {
  test('no config → broadcasts idle/no-config and returns', async () => {
    const broadcast = vi.fn();
    await runSync({
      loadConfig: async () => null,
      listFolders: async () => [],
      broadcast,
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: 'state',
      state: 'idle',
      reason: 'no-config',
    });
  });

  test('no folders → broadcasts idle/no-folders and returns', async () => {
    const broadcast = vi.fn();
    await runSync({
      loadConfig: async () => CONFIG,
      listFolders: async () => [],
      broadcast,
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: 'state',
      state: 'idle',
      reason: 'no-folders',
    });
  });

  test('happy path: walks, hashes, uploads, updates sync_index', async () => {
    const folder = { id: 1, label: 'photos', handle: { kind: 'directory' } };
    const entries = [entry('a.jpg'), entry('b.jpg')];
    const broadcast = vi.fn();
    const dbStub = fakeDb();
    const hashFile = vi.fn(async (f) => 'h-' + f.size);
    const uploadFile = vi.fn(async () => ({ skipped: false, etag: 'e' }));

    await runSync({
      loadConfig: async () => CONFIG,
      listFolders: async () => [folder],
      ensurePermissions: async () => true,
      walkFolder: fakeWalker(entries),
      hashFile,
      uploadFile,
      createBucketClient: () => ({ /* unused, uploadFile is mocked */ }),
      db: dbStub,
      broadcast,
    });

    expect(hashFile).toHaveBeenCalledTimes(2);
    expect(uploadFile).toHaveBeenCalledTimes(2);

    const records = dbStub._all();
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.status).toBe('uploaded');
      expect(r.hash).toMatch(/^h-/);
    }

    const uploaded = broadcast.mock.calls
      .map((c) => c[0])
      .filter((m) => m.type === 'file-uploaded');
    expect(uploaded.map((m) => m.path).sort()).toEqual(['a.jpg', 'b.jpg']);
  });

  test('permission denied → broadcasts folder-error, continues to next folder', async () => {
    const folderA = { id: 1, label: 'A', handle: { x: 1 } };
    const folderB = { id: 2, label: 'B', handle: { x: 2 } };
    const broadcast = vi.fn();
    const dbStub = fakeDb();
    const ensurePermissions = vi.fn(async (h) => h.x === 2); // grant only B
    const uploadFile = vi.fn(async () => ({ skipped: false, etag: 'e' }));

    await runSync({
      loadConfig: async () => CONFIG,
      listFolders: async () => [folderA, folderB],
      ensurePermissions,
      walkFolder: fakeWalker([entry('only.jpg')]),
      hashFile: async () => 'h',
      uploadFile,
      createBucketClient: () => ({}),
      db: dbStub,
      broadcast,
    });

    expect(broadcast).toHaveBeenCalledWith({
      type: 'folder-error',
      folder: 'A',
      error: 'permission-denied',
    });
    // Folder B's single entry got uploaded.
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  test('existing sync_index match (size+mtime+uploaded) → entry skipped', async () => {
    const folder = { id: 1, label: 'photos', handle: { kind: 'directory' } };
    const e = entry('cached.jpg', 200, 5);
    const broadcast = vi.fn();
    const dbStub = fakeDb([
      { path: 'cached.jpg', size: 200, mtime: 5, hash: 'old-hash', status: 'uploaded' },
    ]);
    const hashFile = vi.fn();
    const uploadFile = vi.fn();

    await runSync({
      loadConfig: async () => CONFIG,
      listFolders: async () => [folder],
      ensurePermissions: async () => true,
      walkFolder: fakeWalker([e]),
      hashFile,
      uploadFile,
      createBucketClient: () => ({}),
      db: dbStub,
      broadcast,
    });

    expect(hashFile).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  test('upload throws → sync_index marked errored, file-error broadcast', async () => {
    const folder = { id: 1, label: 'photos', handle: { kind: 'directory' } };
    const broadcast = vi.fn();
    const dbStub = fakeDb();
    const fail = new Error('upstream is sad');

    await runSync({
      loadConfig: async () => CONFIG,
      listFolders: async () => [folder],
      ensurePermissions: async () => true,
      walkFolder: fakeWalker([entry('boom.jpg')]),
      hashFile: async () => 'h',
      uploadFile: async () => { throw fail; },
      createBucketClient: () => ({}),
      db: dbStub,
      broadcast,
    });

    const r = dbStub._all().find((x) => x.path === 'boom.jpg');
    expect(r.status).toBe('errored');
    expect(r.error).toBe('upstream is sad');

    const errs = broadcast.mock.calls
      .map((c) => c[0])
      .filter((m) => m.type === 'file-error');
    expect(errs).toEqual([
      { type: 'file-error', path: 'boom.jpg', error: 'upstream is sad' },
    ]);
  });
});
