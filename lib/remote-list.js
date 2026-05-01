// Reconcile the bucket's media listing against gallery_cache.
//
// Pure data plane — no DOM. The Remote tab calls reconcile() when it
// boots online and on user-initiated refresh; the diff (`added` /
// `removed`) drives the UI's incremental re-render.
//
// Per architecture: docs/architecture.md → Main page flow (Remote tab),
// IndexedDB stores (gallery_cache).

const STORE = 'gallery_cache';

/**
 * Walk the bucket via paginated ListObjectsV2 over `{prefix}/media/`
 * and reconcile against the local gallery_cache store.
 *
 * @param {object} client  - BucketClient (must support .list).
 * @param {string} prefix  - Top-level user prefix (no trailing slash).
 * @param {object} db      - lib/db.js module.
 * @returns {Promise<{ added: object[], removed: object[] }>}
 */
export async function reconcile(client, prefix, db) {
  const liveKeys = new Set();
  const liveItems = [];
  let token;
  do {
    const page = await client.list({
      prefix: `${prefix}/media/`,
      continuationToken: token,
      maxKeys: 1000,
    });
    for (const it of page.items) {
      liveKeys.add(it.key);
      liveItems.push(it);
    }
    token = page.continuationToken;
  } while (token);

  const cached = [];
  await db.iterate(STORE, (r) => {
    cached.push(r);
  });
  const cachedKeys = new Set(cached.map((r) => r.key));

  const removed = cached.filter((r) => !liveKeys.has(r.key));
  const added = liveItems.filter((it) => !cachedKeys.has(it.key));

  await db.tx([STORE], 'readwrite', async (t) => {
    for (const r of removed) {
      await t[STORE].del(r.key);
    }
    for (const it of liveItems) {
      await t[STORE].put({
        key: it.key,
        size: it.size,
        lastModified: it.lastModified,
        etag: it.etag,
      });
    }
  });

  return { added, removed };
}
