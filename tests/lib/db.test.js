// Unit tests for lib/db.js. Runs under Vitest with `fake-indexeddb` providing
// a fresh in-memory IDB factory per test (toolchain installed in #4).

import { IDBFactory } from 'fake-indexeddb';
import { describe, test, expect, beforeEach, vi } from 'vitest';

// Each test gets a brand-new IDB universe AND a freshly-evaluated copy of
// lib/db.js (so its module-level dbPromise cache doesn't leak across tests).
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
});

describe('lib/db.js', () => {
  test('open() is idempotent — second call returns the same instance', async () => {
    const { open } = await import('../../lib/db.js');
    const a = await open();
    const b = await open();
    expect(a).toBe(b);
  });

  test('all five stores exist after open()', async () => {
    const { open } = await import('../../lib/db.js');
    const db = await open();
    expect([...db.objectStoreNames].sort()).toEqual([
      'config',
      'folders',
      'gallery_cache',
      'sync_index',
      'uploaded',
    ]);
  });

  test('config: out-of-line key — put with explicit key, get back', async () => {
    const { put, get } = await import('../../lib/db.js');
    await put('config', { endpoint: 'https://s3.amazonaws.com' }, 'storage');
    expect(await get('config', 'storage')).toEqual({
      endpoint: 'https://s3.amazonaws.com',
    });
  });

  test('sync_index: keyPath round-trip', async () => {
    const { put, get } = await import('../../lib/db.js');
    const rec = { path: '/photos/a.jpg', size: 1234, mtime: 1, hash: 'abc' };
    await put('sync_index', rec);
    expect(await get('sync_index', '/photos/a.jpg')).toEqual(rec);
  });

  test('del removes records', async () => {
    const { put, get, del } = await import('../../lib/db.js');
    await put('uploaded', { hash: 'x', key: 'k', size: 1 });
    expect(await get('uploaded', 'x')).toBeDefined();
    await del('uploaded', 'x');
    expect(await get('uploaded', 'x')).toBeUndefined();
  });

  test('iterate visits every record', async () => {
    const { put, iterate } = await import('../../lib/db.js');
    for (const k of ['a', 'b', 'c']) {
      await put('uploaded', { hash: k, key: k, size: 1 });
    }
    const seen = [];
    await iterate('uploaded', (v) => { seen.push(v.hash); });
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
  });

  test('iterate stops when callback returns false', async () => {
    const { put, iterate } = await import('../../lib/db.js');
    for (const k of ['a', 'b', 'c']) {
      await put('uploaded', { hash: k, key: k, size: 1 });
    }
    let count = 0;
    await iterate('uploaded', () => {
      count++;
      if (count === 2) return false;
    });
    expect(count).toBe(2);
  });

  test('tx readwrite happy path commits both stores', async () => {
    const { tx, get } = await import('../../lib/db.js');
    await tx(['sync_index', 'uploaded'], 'readwrite', async (t) => {
      await t.sync_index.put({ path: '/a', size: 1, mtime: 1, hash: 'h' });
      await t.uploaded.put({ hash: 'h', key: 'k', size: 1 });
    });
    expect(await get('sync_index', '/a')).toMatchObject({ hash: 'h' });
    expect(await get('uploaded', 'h')).toMatchObject({ key: 'k' });
  });

  test('tx rolls back when callback throws', async () => {
    const { tx, get } = await import('../../lib/db.js');
    await expect(
      tx(['sync_index', 'uploaded'], 'readwrite', async (t) => {
        await t.sync_index.put({ path: '/a', size: 1, mtime: 1, hash: 'h' });
        await t.uploaded.put({ hash: 'h', key: 'k', size: 1 });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await get('sync_index', '/a')).toBeUndefined();
    expect(await get('uploaded', 'h')).toBeUndefined();
  });
});
