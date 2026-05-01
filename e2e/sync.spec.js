// E2E for the full sync pipeline against the live MinIO that
// `make e2e` brings up. Drives the sync controller from the page via
// the ?e2e=1 helpers exposed by setup-storage.js.

import { test, expect } from '@playwright/test';

const MINIO = {
  endpoint: process.env.MINIO_ENDPOINT || 'http://localhost:9000',
  region: 'us-east-1',
  bucket: process.env.MINIO_BUCKET || 'test-bucket',
  prefix: 'e2e-sync',
  accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  pathStyle: true,
};

test.setTimeout(60_000);

test('sync end-to-end: 3 files in an OPFS folder land in the bucket', async ({
  page,
}) => {
  await page.goto('/setup-storage.html?e2e=1');

  // Configure storage and seed an OPFS folder with 3 small files.
  const seeded = await page.evaluate(
    async ({ config, folderName, files }) => {
      await window.__test_save_config__(config);
      await window.__test_clear_sync_index__();
      await window.__test_seed_folder__({ folderName, files });
      return files.map((f) => f.name);
    },
    {
      config: MINIO,
      folderName: 'sync-e2e',
      files: [
        { name: 'a.txt', content: 'alpha contents' },
        { name: 'b.txt', content: 'bravo contents' },
        { name: 'c.txt', content: 'charlie contents' },
      ],
    },
  );
  expect(seeded).toEqual(['a.txt', 'b.txt', 'c.txt']);

  // Run sync. Resolves when the worker emits idle/completed.
  const events = await page.evaluate(() => window.__test_sync_run__());
  const uploaded = events.filter((e) => e.type === 'file-uploaded');
  expect(uploaded).toHaveLength(3);
  expect(uploaded.map((e) => e.path).sort()).toEqual([
    'a.txt',
    'b.txt',
    'c.txt',
  ]);

  // Verify each object exists in the bucket via the BucketClient.
  for (const u of uploaded) {
    const meta = await page.evaluate(
      async ({ key, config }) => window.__test_head__({ key, config }),
      { key: `${MINIO.prefix}/media/${u.hash}.txt`, config: MINIO },
    );
    expect(meta.size).toBeGreaterThan(0);
    expect(meta.metadata.filename).toBe(u.path.split('/').pop());
  }

  // Cleanup so re-runs start clean.
  for (const u of uploaded) {
    await page.evaluate(
      async ({ key, config }) => window.__test_delete__({ key, config }),
      { key: `${MINIO.prefix}/media/${u.hash}.txt`, config: MINIO },
    );
  }
});
