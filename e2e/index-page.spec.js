// E2E for index.html's capability gating, plus a sanity-check that
// setup-storage stays unaffected when FSA is missing. Per
// docs/architecture.md → Capability and connectivity awareness.

import { test, expect } from '@playwright/test';

const MINIO = {
  endpoint: process.env.MINIO_ENDPOINT || 'http://localhost:9000',
  region: 'us-east-1',
  bucket: process.env.MINIO_BUCKET || 'test-bucket',
  prefix: 'e2e',
  accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
};

async function deleteFsa(page) {
  await page.addInitScript(() => {
    delete window.showDirectoryPicker;
  });
}

test('Local tab shows the FSA explainer when File System Access is missing', async ({
  page,
}) => {
  await deleteFsa(page);
  await page.goto('/?tab=local');
  await expect(page.getByText(/needs File System Access/i)).toBeVisible();
});

test('Remote tab is unaffected when FSA is missing', async ({ page }) => {
  await deleteFsa(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Remote' }).click();
  // Today the Remote pane is a placeholder; the point is it loads
  // without the FSA explainer ever appearing.
  await expect(page.locator('#pane-remote')).toContainText(/coming soon/i);
});

test('Storage page works fully when FSA is missing', async ({ page }) => {
  await deleteFsa(page);
  await page.goto('/setup-storage.html');
  await page.getByLabel('Endpoint').fill(MINIO.endpoint);
  await page.getByLabel('Region').fill(MINIO.region);
  await page.getByLabel('Bucket').fill(MINIO.bucket);
  await page.getByLabel('Prefix').fill(MINIO.prefix);
  await page.getByLabel('Access key ID').fill(MINIO.accessKeyId);
  await page.getByLabel('Secret access key').fill(MINIO.secretAccessKey);
  const pathStyle = page.getByLabel('Path-style URLs');
  if (!(await pathStyle.isChecked())) await pathStyle.check();

  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText(/connection ok/i)).toBeVisible();
});
