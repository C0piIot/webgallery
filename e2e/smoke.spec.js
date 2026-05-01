// Smoke E2E — verifies the static shells from #1 load correctly and the
// Local/Remote tab toggle wired up by index.js works end-to-end. Backfills
// the smoke check that issue #1 deferred until tooling existed.

import { test, expect } from '@playwright/test';

// Each nav link is matched by its exact accessible name to avoid the
// substring overlap with the "webgallery" brand text.

test('home page loads with active Gallery nav', async ({ page }) => {
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
  await page.goto('/');
  await page.getByRole('tab', { name: 'Remote' }).click();
  await expect(page.getByRole('tab', { name: 'Remote' })).toHaveClass(/active/);
  await expect(page).toHaveURL(/[?&]tab=remote/);
});
