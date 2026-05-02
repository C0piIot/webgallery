// E2E for setup-storage.html. Drives the form against the live MinIO
// brought up by `make e2e` (or the `services:` block in CI). Each test
// gets a fresh browser context, so IndexedDB starts empty.

import { test, expect } from '@playwright/test';

const MINIO = {
  endpoint: process.env.MINIO_ENDPOINT || 'http://localhost:9000',
  region: 'us-east-1',
  bucket: process.env.MINIO_BUCKET || 'test-bucket',
  prefix: 'e2e',
  accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
};

async function fill(page, c) {
  await page.getByLabel('Endpoint').fill(c.endpoint);
  await page.getByLabel('Region').fill(c.region);
  await page.getByLabel('Bucket').fill(c.bucket);
  await page.getByLabel('Prefix').fill(c.prefix);
  await page.getByLabel('Access key ID').fill(c.accessKeyId);
  await page.getByLabel('Secret access key').fill(c.secretAccessKey);
  // MinIO is path-style.
  const pathStyleToggle = page.getByLabel('Path-style URLs');
  if (!(await pathStyleToggle.isChecked())) {
    await pathStyleToggle.check();
  }
}

test('test connection: success against MinIO', async ({ page }) => {
  await page.goto('/setup-storage.html');
  await fill(page, MINIO);
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText(/connection ok/i)).toBeVisible();
});

test('test connection: bad credentials → clear error', async ({ page }) => {
  await page.goto('/setup-storage.html');
  await fill(page, { ...MINIO, secretAccessKey: 'wrong-secret-1234567890' });
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(
    page.getByText(/Signature|forbidden|not match|denied|403/i),
  ).toBeVisible();
});

test('save persists across reload', async ({ page }) => {
  await page.goto('/setup-storage.html');
  await fill(page, MINIO);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/^Saved\.?$/i)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Endpoint')).toHaveValue(MINIO.endpoint);
  await expect(page.getByLabel('Bucket')).toHaveValue(MINIO.bucket);
  await expect(page.getByLabel('Prefix')).toHaveValue(MINIO.prefix);
  await expect(page.getByLabel('Path-style URLs')).toBeChecked();
});

test('export downloads a JSON file with the current form values', async ({ page }) => {
  await page.goto('/setup-storage.html');
  await fill(page, MINIO);

  // The Export button asks via confirm(); auto-accept.
  page.once('dialog', (d) => d.accept());

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export config' }).click();
  const download = await downloadPromise;

  // Filename shape: webgallery-config-YYYY-MM-DD.json
  expect(download.suggestedFilename()).toMatch(
    /^webgallery-config-\d{4}-\d{2}-\d{2}\.json$/,
  );

  const path = await download.path();
  const fs = await import('node:fs/promises');
  const text = await fs.readFile(path, 'utf-8');
  const doc = JSON.parse(text);

  expect(doc.schemaVersion).toBe(1);
  expect(doc.config.endpoint).toBe(MINIO.endpoint);
  expect(doc.config.bucket).toBe(MINIO.bucket);
  expect(doc.config.secretAccessKey).toBe(MINIO.secretAccessKey);
  expect(doc.config.pathStyle).toBe(true);
});

test('import populates the form from a valid JSON file', async ({ page }) => {
  await page.goto('/setup-storage.html');

  const json = JSON.stringify({
    schemaVersion: 1,
    config: {
      endpoint: MINIO.endpoint,
      region: MINIO.region,
      bucket: MINIO.bucket,
      prefix: 'imported-prefix',
      pathStyle: true,
      accessKeyId: MINIO.accessKeyId,
      secretAccessKey: MINIO.secretAccessKey,
    },
  });

  await page.locator('#import-input').setInputFiles({
    name: 'webgallery-config.json',
    mimeType: 'application/json',
    buffer: Buffer.from(json),
  });

  await expect(page.getByText(/Imported\. Click Test connection/i)).toBeVisible();
  await expect(page.getByLabel('Endpoint')).toHaveValue(MINIO.endpoint);
  await expect(page.getByLabel('Bucket')).toHaveValue(MINIO.bucket);
  await expect(page.getByLabel('Prefix')).toHaveValue('imported-prefix');
  await expect(page.getByLabel('Secret access key')).toHaveValue(
    MINIO.secretAccessKey,
  );
  await expect(page.getByLabel('Path-style URLs')).toBeChecked();
});

test('import rejects an unknown schemaVersion without touching the form', async ({ page }) => {
  await page.goto('/setup-storage.html');
  // Pre-fill so we can verify nothing changed on the bad import.
  await page.getByLabel('Endpoint').fill('https://stays-put.example.com');

  const json = JSON.stringify({ schemaVersion: 999, config: {} });
  await page.locator('#import-input').setInputFiles({
    name: 'webgallery-config.json',
    mimeType: 'application/json',
    buffer: Buffer.from(json),
  });

  await expect(page.getByText(/Unsupported schemaVersion/i)).toBeVisible();
  await expect(page.getByLabel('Endpoint')).toHaveValue(
    'https://stays-put.example.com',
  );
});
