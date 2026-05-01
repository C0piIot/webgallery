// E2E for the Remote detail dialog + delete. Pre-populates MinIO with
// one file via __test_upload__, opens the Remote tab, clicks the card,
// asserts the dialog is visible with metadata, accepts the native
// confirm() and clicks Delete, then verifies the card disappears AND
// HEAD against the bucket returns 404.

import { test, expect } from '@playwright/test';

const MINIO = {
  endpoint: process.env.MINIO_ENDPOINT || 'http://localhost:9000',
  region: 'us-east-1',
  bucket: process.env.MINIO_BUCKET || 'test-bucket',
  prefix: 'e2e-detail',
  accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  pathStyle: true,
};

test.setTimeout(60_000);

test('Remote card → detail dialog → Delete removes from grid + bucket', async ({
  page,
}) => {
  await page.goto('/setup-storage.html?e2e=1');

  await page.evaluate(async (config) => window.__test_save_config__(config), MINIO);
  const out = await page.evaluate(
    async (args) => window.__test_upload__(args),
    {
      name: 'pic.txt',
      content: 'detail-view content',
      config: MINIO,
      opts: { contentType: 'text/plain', prefix: MINIO.prefix },
    },
  );

  await page.goto('/index.html?tab=remote');
  await expect(page.locator('#remote-grid .col')).toHaveCount(1, {
    timeout: 15_000,
  });

  // Click the card → dialog opens with filename and Delete button.
  await page.locator('#remote-grid .col').click();
  const dialog = page.locator('#detail-dialog');
  await expect(dialog).toBeVisible();
  // Filename starts as the key's basename, then is refined by HEAD to
  // the original filename — assert either form.
  await expect(dialog.locator('#detail-filename')).toContainText(/pic|\.txt$/i);
  await expect(dialog.locator('#detail-delete')).toBeEnabled();

  // Accept the native confirm() and click Delete.
  page.once('dialog', (d) => d.accept());
  await dialog.locator('#detail-delete').click();

  // Dialog closes, card gone from grid.
  await expect(dialog).toBeHidden();
  await expect(page.locator('#remote-grid .col')).toHaveCount(0);

  // Bucket-side: HEAD now returns 404.
  await page.goto('/setup-storage.html?e2e=1');
  const headed = await page.evaluate(
    async ({ key, config }) => {
      try {
        await window.__test_head__({ key, config });
        return 'present';
      } catch (e) {
        return e?.status === 404 ? 'gone' : `error:${e?.status ?? 'unknown'}`;
      }
    },
    { key: out.key, config: MINIO },
  );
  expect(headed).toBe('gone');
});
