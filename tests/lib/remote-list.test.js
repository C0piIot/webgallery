// Unit tests for lib/remote-list.js — reconcile() against a mocked
// BucketClient + the standard fake-indexeddb pattern.

import { IDBFactory } from 'fake-indexeddb';
import { describe, test, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
});

function fakeClient(pages) {
  // pages: array of { items, continuationToken? } returned in sequence.
  const calls = [];
  let i = 0;
  return {
    calls,
    list: vi.fn(async (args) => {
      calls.push(args);
      const page = pages[i++] ?? { items: [], continuationToken: undefined };
      return page;
    }),
  };
}

const PREFIX = 'phone';

async function readAll(db) {
  const out = [];
  await db.iterate('gallery_cache', (r) => out.push(r));
  return out;
}

describe('lib/remote-list.js — reconcile', () => {
  test('empty bucket + empty cache → no upserts, no removals', async () => {
    const db = await import('../../lib/db.js');
    const { reconcile } = await import('../../lib/remote-list.js');
    const client = fakeClient([{ items: [], continuationToken: undefined }]);

    const { added, removed } = await reconcile(client, PREFIX, db);

    expect(added).toEqual([]);
    expect(removed).toEqual([]);
    expect(await readAll(db)).toEqual([]);
  });

  test('first sync of a non-empty bucket: every item ends up in cache + added', async () => {
    const db = await import('../../lib/db.js');
    const { reconcile } = await import('../../lib/remote-list.js');
    const items = [
      { key: 'phone/media/a.jpg', size: 100, lastModified: '1', etag: 'e1' },
      { key: 'phone/media/b.jpg', size: 200, lastModified: '2', etag: 'e2' },
    ];
    const client = fakeClient([{ items, continuationToken: undefined }]);

    const { added, removed } = await reconcile(client, PREFIX, db);

    expect(removed).toEqual([]);
    expect(added.map((x) => x.key).sort()).toEqual([
      'phone/media/a.jpg',
      'phone/media/b.jpg',
    ]);
    const cached = await readAll(db);
    expect(cached.map((r) => r.key).sort()).toEqual([
      'phone/media/a.jpg',
      'phone/media/b.jpg',
    ]);
  });

  test('bucket adds a new key: only that one is in `added`; others are upserts (idempotent)', async () => {
    const db = await import('../../lib/db.js');
    const { reconcile } = await import('../../lib/remote-list.js');
    // Pre-populate cache with one item.
    await db.put(
      'gallery_cache',
      { key: 'phone/media/a.jpg', size: 100, lastModified: '1', etag: 'e1' },
    );

    const client = fakeClient([
      {
        items: [
          { key: 'phone/media/a.jpg', size: 100, lastModified: '1', etag: 'e1' },
          { key: 'phone/media/c.jpg', size: 300, lastModified: '3', etag: 'e3' },
        ],
        continuationToken: undefined,
      },
    ]);

    const { added, removed } = await reconcile(client, PREFIX, db);
    expect(added.map((x) => x.key)).toEqual(['phone/media/c.jpg']);
    expect(removed).toEqual([]);
    expect((await readAll(db)).map((r) => r.key).sort()).toEqual([
      'phone/media/a.jpg',
      'phone/media/c.jpg',
    ]);
  });

  test('bucket removes a key: it lands in `removed` and is deleted from cache', async () => {
    const db = await import('../../lib/db.js');
    const { reconcile } = await import('../../lib/remote-list.js');
    await db.put('gallery_cache', { key: 'phone/media/a.jpg', size: 100, lastModified: '1', etag: 'e1' });
    await db.put('gallery_cache', { key: 'phone/media/b.jpg', size: 200, lastModified: '2', etag: 'e2' });

    const client = fakeClient([
      {
        items: [
          { key: 'phone/media/a.jpg', size: 100, lastModified: '1', etag: 'e1' },
        ],
        continuationToken: undefined,
      },
    ]);

    const { added, removed } = await reconcile(client, PREFIX, db);
    expect(added).toEqual([]);
    expect(removed.map((r) => r.key)).toEqual(['phone/media/b.jpg']);
    expect((await readAll(db)).map((r) => r.key)).toEqual(['phone/media/a.jpg']);
  });

  test('multi-page list is followed via continuationToken until exhausted', async () => {
    const db = await import('../../lib/db.js');
    const { reconcile } = await import('../../lib/remote-list.js');
    const client = fakeClient([
      {
        items: [
          { key: 'phone/media/a.jpg', size: 100, lastModified: '1', etag: 'e1' },
        ],
        continuationToken: 'NEXT',
      },
      {
        items: [
          { key: 'phone/media/b.jpg', size: 200, lastModified: '2', etag: 'e2' },
        ],
        continuationToken: undefined,
      },
    ]);

    const { added } = await reconcile(client, PREFIX, db);
    expect(added).toHaveLength(2);
    expect(client.list).toHaveBeenCalledTimes(2);
    // Second call carries the continuation token from the first response.
    expect(client.calls[1].continuationToken).toBe('NEXT');
  });
});
