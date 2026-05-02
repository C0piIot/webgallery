// E2E for the Remote tab. Pre-populates MinIO via the existing
// __test_upload__ helper, then opens index.html?tab=remote and asserts
// the gallery renders + handles offline / online transitions.

import { test, expect } from '@playwright/test';

const MINIO = {
  endpoint: process.env.MINIO_ENDPOINT || 'http://localhost:9000',
  region: 'us-east-1',
  bucket: process.env.MINIO_BUCKET || 'test-bucket',
  prefix: 'e2e-remote',
  accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  pathStyle: true,
};

test.setTimeout(60_000);

test('Remote tab renders cards, transitions to offline, refreshes on reconnect', async ({
  page, context,
}) => {
  await page.goto('/setup-storage.html?e2e=1');

  // Save config so the Remote tab can build a BucketClient on its own.
  // Pre-populate the bucket with three small files via __test_upload__.
  await page.evaluate(async (config) => {
    await window.__test_save_config__(config);
  }, MINIO);

  const keys = [];
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    const out = await page.evaluate(
      async (args) => window.__test_upload__(args),
      {
        name,
        content: `content of ${name}`,
        config: MINIO,
        opts: { contentType: 'text/plain', prefix: MINIO.prefix },
      },
    );
    keys.push(out.key);
  }

  // Open Remote tab. Auto-reconcile fires on first open while online +
  // configured, populating gallery_cache → cards.
  await page.goto('/index.html?tab=remote');
  await expect(page.locator('#remote-grid .col')).toHaveCount(3, {
    timeout: 15_000,
  });

  // Toggle offline → pill appears, Refresh disables, cards stay (cache).
  await context.setOffline(true);
  await expect(page.locator('#remote-offline-pill')).toBeVisible();
  await expect(page.locator('#remote-refresh')).toBeDisabled();
  await expect(page.locator('#remote-grid .col')).toHaveCount(3);

  // Back online → pill hides, Refresh re-enables and shows the
  // resting "Refresh" label (verified post-reconcile, since the
  // "Refreshing…" state is too brief to assert reliably).
  await context.setOffline(false);
  await expect(page.locator('#remote-offline-pill')).toBeHidden();
  await expect(page.locator('#remote-refresh')).toBeEnabled();
  await expect(page.locator('#remote-refresh')).toHaveText('Refresh');

  // Cleanup.
  await page.goto('/setup-storage.html?e2e=1');
  for (const key of keys) {
    await page.evaluate(
      async (a) => window.__test_delete__(a),
      { key, config: MINIO },
    );
  }
});

test('delete confirm shows the friendly filename, not the hash', async ({
  page,
}) => {
  await page.goto('/setup-storage.html?e2e=1');
  await page.evaluate(async (config) => {
    await window.__test_save_config__(config);
  }, MINIO);

  const out = await page.evaluate(
    async (args) => window.__test_upload__(args),
    {
      name: 'human-name.txt',
      content: 'hello',
      config: MINIO,
      opts: { contentType: 'text/plain', prefix: MINIO.prefix },
    },
  );

  await page.goto('/index.html?tab=remote');
  await expect(page.locator('#remote-grid .col')).toHaveCount(1, {
    timeout: 15_000,
  });

  // Open the card. The dialog opens with the hash-keyed filename
  // initially, then refines to the friendly name from HEAD metadata.
  await page.locator('#remote-grid .col').click();
  await expect(page.locator('#detail-dialog[open]')).toBeVisible();
  await expect(page.locator('#detail-filename')).toHaveText('human-name.txt');

  // Listen for the confirm() dialog and dismiss so the object stays
  // for cleanup. We capture its message before dismissing.
  let dialogMessage = null;
  page.once('dialog', async (dialog) => {
    dialogMessage = dialog.message();
    await dialog.dismiss();
  });

  await page.locator('#detail-delete').click();
  // Loop until the dialog has been observed (Playwright fires it
  // synchronously, but allow one tick).
  await expect.poll(() => dialogMessage).toContain('human-name.txt');
  expect(dialogMessage).not.toMatch(/[a-f0-9]{40,}/);

  // Cleanup.
  await page.goto('/setup-storage.html?e2e=1');
  await page.evaluate(
    async (a) => window.__test_delete__(a),
    { key: out.key, config: MINIO },
  );
});
