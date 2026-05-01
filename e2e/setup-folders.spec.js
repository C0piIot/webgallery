// E2E for setup-folders.html. Uses the ?e2e=1 injection hook to swap
// showDirectoryPicker for a function that returns an OPFS subdirectory
// — a real FileSystemDirectoryHandle, structured-cloneable through IDB,
// with permissions always 'granted'. Each test runs in a fresh browser
// context so OPFS + IDB start empty.

import { test, expect } from '@playwright/test';

async function injectAndAdd(page, name) {
  await page.evaluate((n) => globalThis.__test_inject_folders__(n), name);
  await page.getByRole('button', { name: /add folder/i }).click();
}

test('empty state visible initially', async ({ page }) => {
  await page.goto('/setup-folders.html?e2e=1');
  await expect(
    page.getByText(/no folders configured/i),
  ).toBeVisible();
  await expect(page.locator('.list-group-item')).toHaveCount(0);
});

test('add → list (granted) → remove returns to empty', async ({ page }) => {
  await page.goto('/setup-folders.html?e2e=1');

  await injectAndAdd(page, 'photos-test');

  const row = page.locator('.list-group-item').filter({ hasText: 'photos-test' });
  await expect(row).toBeVisible();
  await expect(row.getByText(/granted/i)).toBeVisible();

  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText(/no folders configured/i)).toBeVisible();
});

test('two folders, remove one, the other survives', async ({ page }) => {
  await page.goto('/setup-folders.html?e2e=1');

  await injectAndAdd(page, 'folder-a');
  await injectAndAdd(page, 'folder-b');

  await expect(page.locator('.list-group-item')).toHaveCount(2);

  const rowA = page.locator('.list-group-item').filter({ hasText: 'folder-a' });
  await rowA.getByRole('button', { name: 'Remove' }).click();

  await expect(page.locator('.list-group-item')).toHaveCount(1);
  await expect(
    page.locator('.list-group-item').filter({ hasText: 'folder-b' }),
  ).toBeVisible();
});

test('shows the FSA explainer when File System Access is missing', async ({
  page,
}) => {
  await page.addInitScript(() => {
    delete window.showDirectoryPicker;
  });
  await page.goto('/setup-folders.html');
  await expect(page.getByText(/needs File System Access/i)).toBeVisible();
  // The Add button is gone — replaced by the explainer panel.
  await expect(page.getByRole('button', { name: /add folder/i })).toHaveCount(0);
});
