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

async function seedConfig(page) {
  // The index page now redirects to setup-storage when no config is
  // saved. These FSA tests are about UI gating, not the welcome funnel,
  // so seed a config first via the ?e2e=1 helpers.
  await page.goto('/setup-storage.html?e2e=1');
  await page.evaluate(async (config) => {
    await window.__test_save_config__(config);
  }, MINIO);
}

test('/ redirects to setup-storage when no config is saved', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/setup-storage\.html\?welcome=1$/);
  await expect(page.locator('#welcome-alert')).toBeVisible();
});

test('Local tab shows the FSA explainer when File System Access is missing', async ({
  page,
}) => {
  await deleteFsa(page);
  await seedConfig(page);
  await page.goto('/?tab=local');
  await expect(page.getByText(/needs File System Access/i)).toBeVisible();
});

test('Remote tab is unaffected when FSA is missing', async ({ page }) => {
  await deleteFsa(page);
  await seedConfig(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Remote' }).click();
  // Remote pane has its own controls (Refresh + offline pill + grid)
  // and does NOT show the FSA explainer — that's the point of the
  // graceful-degradation rule.
  await expect(page.locator('#remote-refresh')).toBeVisible();
  await expect(page.locator('#pane-remote')).not.toContainText(
    /needs File System Access/i,
  );
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
