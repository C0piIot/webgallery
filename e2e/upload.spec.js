// E2E for lib/upload.js against the live MinIO that `make e2e` brings
// up. Drives the uploader from the page via window.__test_upload__,
// exposed by setup-storage.js when the URL has ?e2e=1.

import { test, expect } from '@playwright/test';

const MINIO = {
  endpoint: process.env.MINIO_ENDPOINT || 'http://localhost:9000',
  region: 'us-east-1',
  bucket: process.env.MINIO_BUCKET || 'test-bucket',
  prefix: 'e2e-upload',
  accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  pathStyle: true,
};

async function loadPage(page) {
  await page.goto('/setup-storage.html?e2e=1');
}

test('single PUT round-trip: object lands with correct metadata', async ({
  page,
}) => {
  await loadPage(page);
  const out = await page.evaluate(
    async ({ name, content, config, opts }) =>
      window.__test_upload__({ name, content, config, opts }),
    {
      name: 'small.txt',
      content: 'hello world (single put)',
      config: MINIO,
      opts: { contentType: 'text/plain', prefix: MINIO.prefix },
    },
  );
  expect(out.result.skipped).toBe(false);
  expect(out.result.etag).toBeTruthy();

  const meta = await page.evaluate(
    async ({ key, config }) => window.__test_head__({ key, config }),
    { key: out.key, config: MINIO },
  );
  expect(meta.size).toBe('hello world (single put)'.length);
  expect(meta.contentType).toBe('text/plain');
  expect(meta.contentDisposition).toBe('attachment; filename="small.txt"');
  expect(meta.metadata.filename).toBe('small.txt');
  expect(meta.metadata['source-path']).toBe('e2e/small.txt');

  // Cleanup so re-runs start clean.
  await page.evaluate(
    async ({ key, config }) => window.__test_delete__({ key, config }),
    { key: out.key, config: MINIO },
  );
});

test('multipart round-trip (11 MiB blob, 5 MiB parts → 3 parts)', async ({
  page,
}) => {
  await loadPage(page);
  // S3 / MinIO require parts >= 5 MiB except the last. 11 MiB at 5 MiB
  // parts gives us 5 + 5 + 1 — exercises the multipart code path
  // against real storage. Bytes are generated in-page to avoid pushing
  // 11 MiB through Playwright's serialization layer.
  const out = await page.evaluate(
    async (args) => window.__test_upload__(args),
    {
      name: 'big.bin',
      byteCount: 11 * 1024 * 1024,
      fill: 0xab,
      config: MINIO,
      opts: {
        contentType: 'application/octet-stream',
        prefix: MINIO.prefix,
        threshold: 1024,
        partSize: 5 * 1024 * 1024,
      },
    },
  );
  expect(out.result.skipped).toBe(false);
  expect(out.result.etag).toBeTruthy();

  const meta = await page.evaluate(
    async ({ key, config }) => window.__test_head__({ key, config }),
    { key: out.key, config: MINIO },
  );
  expect(meta.size).toBe(11 * 1024 * 1024);
  expect(meta.metadata.filename).toBe('big.bin');
  expect(meta.contentDisposition).toBe('attachment; filename="big.bin"');

  await page.evaluate(
    async ({ key, config }) => window.__test_delete__({ key, config }),
    { key: out.key, config: MINIO },
  );
});

test('second upload of identical content is a no-op (skipped: true)', async ({
  page,
}) => {
  await loadPage(page);
  const args = {
    name: 'dedup.txt',
    content: 'identical content for dedup',
    config: MINIO,
    opts: { contentType: 'text/plain', prefix: MINIO.prefix },
  };
  const first = await page.evaluate(
    async (a) => window.__test_upload__(a),
    args,
  );
  expect(first.result.skipped).toBe(false);

  const second = await page.evaluate(
    async (a) => window.__test_upload__(a),
    args,
  );
  expect(second.result).toEqual({ skipped: true });
  expect(second.key).toBe(first.key);

  await page.evaluate(
    async ({ key, config }) => window.__test_delete__({ key, config }),
    { key: first.key, config: MINIO },
  );
});
