// E2E for the Local tab. Reuses the ?e2e=1 helpers on setup-storage to
// configure MinIO + seed an OPFS folder + run a sync, then navigates to
// index.html and asserts the cards rendered with Uploaded badges.

import { test, expect } from '@playwright/test';

const MINIO = {
  endpoint: process.env.MINIO_ENDPOINT || 'http://localhost:9000',
  region: 'us-east-1',
  bucket: process.env.MINIO_BUCKET || 'test-bucket',
  prefix: 'e2e-local-tab',
  accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  pathStyle: true,
};

test.setTimeout(60_000);

test('Local tab renders a card per file with the right badges after a sync', async ({
  page,
}) => {
  await page.goto('/setup-storage.html?e2e=1');

  // Configure storage, seed an OPFS folder with two files, run sync.
  const events = await page.evaluate(
    async ({ config }) => {
      await window.__test_save_config__(config);
      await window.__test_clear_sync_index__();
      await window.__test_seed_folder__({
        folderName: 'local-tab-test',
        files: [
          { name: 'a.txt', content: 'alpha' },
          { name: 'b.txt', content: 'bravo' },
        ],
      });
      return window.__test_sync_run__();
    },
    { config: MINIO },
  );

  const uploaded = events.filter((e) => e.type === 'file-uploaded');
  expect(uploaded).toHaveLength(2);

  // Switch to index.html → Local tab and verify two cards with Uploaded
  // badges. IndexedDB persists across navigations.
  await page.goto('/index.html?e2e=1&tab=local');

  await expect(page.locator('#local-grid .col')).toHaveCount(2);
  for (const name of ['a.txt', 'b.txt']) {
    const card = page.locator(`#local-grid [data-path="${name}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator('[data-role="status"]')).toContainText(
      /Uploaded/i,
    );
  }

  // Cleanup: delete uploaded objects.
  for (const u of uploaded) {
    await page.goto('/setup-storage.html?e2e=1');
    await page.evaluate(
      async ({ key, config }) => window.__test_delete__({ key, config }),
      { key: `${MINIO.prefix}/media/${u.hash}.txt`, config: MINIO },
    );
  }
});
