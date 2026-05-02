// Smoke E2E — verifies the static shells from #1 load correctly and the
// Local/Remote tab toggle wired up by index.js works end-to-end. Backfills
// the smoke check that issue #1 deferred until tooling existed.

import { test, expect } from '@playwright/test';

const MINIO = {
  endpoint: process.env.MINIO_ENDPOINT || 'http://localhost:9000',
  region: 'us-east-1',
  bucket: process.env.MINIO_BUCKET || 'test-bucket',
  prefix: 'e2e-smoke',
  accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  pathStyle: true,
};

// /index.html now redirects to setup-storage when no config is saved
// (see issue #22). Seed a config so the gallery actually loads.
async function seedConfig(page) {
  await page.goto('/setup-storage.html?e2e=1');
  await page.evaluate(async (config) => {
    await window.__test_save_config__(config);
  }, MINIO);
}

// Each nav link is matched by its exact accessible name to avoid the
// substring overlap with the "webgallery" brand text.

test('home page loads with active Gallery nav', async ({ page }) => {
  await seedConfig(page);
  await page.goto('/');
  await expect(
    page.getByRole('link', { name: 'Gallery', exact: true }),
  ).toHaveClass(/active/);
});

test('storage setup page loads with active Storage nav', async ({ page }) => {
  await page.goto('/setup-storage.html');
  await expect(
    page.getByRole('link', { name: 'Storage', exact: true }),
  ).toHaveClass(/active/);
});

test('folders setup page loads with active Folders nav', async ({ page }) => {
  await page.goto('/setup-folders.html');
  await expect(
    page.getByRole('link', { name: 'Folders', exact: true }),
  ).toHaveClass(/active/);
});

test('Local/Remote tabs switch and update URL', async ({ page }) => {
  // Tab buttons carry role="tab", not role="button".
  await seedConfig(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Remote' }).click();
  await expect(page.getByRole('tab', { name: 'Remote' })).toHaveClass(/active/);
  await expect(page).toHaveURL(/[?&]tab=remote/);
});

test('help page loads with content sections', async ({ page }) => {
  await page.goto('/help.html');
  await expect(
    page.getByRole('heading', { name: /what this is/i }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: /security model/i }),
  ).toBeVisible();
});

test('Storage page links to Help (always-visible link)', async ({ page }) => {
  await page.goto('/setup-storage.html');
  await page.getByRole('link', { name: /Read the Help page/i }).first().click();
  await expect(page).toHaveURL(/help\.html$/);
});

test('Storage welcome alert links to Help', async ({ page }) => {
  await page.goto('/setup-storage.html?welcome=1');
  await page
    .locator('#welcome-alert')
    .getByRole('link', { name: /Read the Help page/i })
    .click();
  await expect(page).toHaveURL(/help\.html$/);
});
