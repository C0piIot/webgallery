// Unit tests for lib/upload.js. Mocked BucketClient (no real network).
// Files are real Blobs with a `name` property (matches the entry shape
// the walker emits).

import { describe, test, expect, vi } from 'vitest';
import { uploadFile, keyFor, contentDispositionFor } from '../../lib/upload.js';

function fakeClient(overrides = {}) {
  return {
    head: vi.fn(async () => {
      const e = new Error('not found');
      e.status = 404;
      throw e;
    }),
    put: vi.fn(async () => ({ etag: 'put-etag' })),
    createMultipartUpload: vi.fn(async () => ({ uploadId: 'UP1' })),
    uploadPart: vi.fn(async (key, uploadId, partNumber) => ({
      partNumber,
      etag: `part-etag-${partNumber}`,
    })),
    completeMultipartUpload: vi.fn(async () => ({ etag: 'complete-etag' })),
    abortMultipartUpload: vi.fn(async () => undefined),
    ...overrides,
  };
}

function entryFor(content, { name = 'IMG_0001.jpg', hash = 'abc', path = 'DCIM/IMG_0001.jpg', mime = 'image/jpeg', capturedAt } = {}) {
  const blob = new Blob([content], { type: mime });
  return {
    path,
    name,
    size: blob.size,
    hash,
    file: blob,
    capturedAt,
  };
}

const PREFIX = 'phone';

describe('lib/upload.js', () => {
  test('skips upload when HEAD returns 200', async () => {
    const client = fakeClient({ head: vi.fn(async () => ({ size: 5 })) });
    const result = await uploadFile(client, entryFor('hello'), { prefix: PREFIX });
    expect(result).toEqual({ skipped: true });
    expect(client.put).not.toHaveBeenCalled();
  });

  test('HEAD 404 → single PUT with computed key', async () => {
    const client = fakeClient();
    const result = await uploadFile(client, entryFor('hello'), { prefix: PREFIX });
    expect(client.put).toHaveBeenCalledTimes(1);
    const [key, body, putOpts] = client.put.mock.calls[0];
    expect(key).toBe(`${PREFIX}/media/abc.jpg`);
    expect(body.size).toBe(5);
    expect(putOpts.contentType).toBe('image/jpeg');
    expect(putOpts.metadata).toEqual({
      filename: 'IMG_0001.jpg',
      'source-path': 'DCIM/IMG_0001.jpg',
    });
    expect(result).toEqual({ skipped: false, etag: 'put-etag' });
  });

  test('HEAD non-404 error rethrown', async () => {
    const err500 = Object.assign(new Error('server'), { status: 500 });
    const client = fakeClient({ head: vi.fn(async () => { throw err500; }) });
    await expect(
      uploadFile(client, entryFor('hello'), { prefix: PREFIX }),
    ).rejects.toBe(err500);
    expect(client.put).not.toHaveBeenCalled();
  });

  test('captured-at metadata included when entry has it', async () => {
    const client = fakeClient();
    const entry = entryFor('hi', { capturedAt: '2025-01-15T00:00:00Z' });
    await uploadFile(client, entry, { prefix: PREFIX });
    expect(client.put.mock.calls[0][2].metadata['captured-at']).toBe(
      '2025-01-15T00:00:00Z',
    );
  });

  test('extension fallback: name with no extension → key has no trailing dot', async () => {
    const client = fakeClient();
    const entry = entryFor('hello', { name: 'IMG_0001', mime: '' });
    await uploadFile(client, entry, { prefix: PREFIX });
    expect(client.put.mock.calls[0][0]).toBe(`${PREFIX}/media/abc`);
  });

  test('keyFor helper: with and without extension', () => {
    expect(keyFor('phone', 'abc', 'foo.jpg')).toBe('phone/media/abc.jpg');
    expect(keyFor('phone', 'abc', 'foo')).toBe('phone/media/abc');
    expect(keyFor('phone', 'abc', 'IMG.JPEG')).toBe('phone/media/abc.jpeg');
  });

  test('multipart triggered above threshold (4KB blob, 1KB threshold, 1KB parts)', async () => {
    const client = fakeClient();
    const big = new Uint8Array(4 * 1024).fill(0xab);
    const entry = entryFor(big, { name: 'big.bin', mime: 'application/octet-stream' });
    const result = await uploadFile(client, entry, {
      prefix: PREFIX,
      threshold: 1024,
      partSize: 1024,
    });
    expect(client.put).not.toHaveBeenCalled();
    expect(client.createMultipartUpload).toHaveBeenCalledTimes(1);
    expect(client.uploadPart).toHaveBeenCalledTimes(4);
    // Part numbers are 1..4 in order.
    expect(client.uploadPart.mock.calls.map((c) => c[2])).toEqual([1, 2, 3, 4]);
    expect(client.completeMultipartUpload).toHaveBeenCalledTimes(1);
    const [, , parts] = client.completeMultipartUpload.mock.calls[0];
    expect(parts).toEqual([
      { partNumber: 1, etag: 'part-etag-1' },
      { partNumber: 2, etag: 'part-etag-2' },
      { partNumber: 3, etag: 'part-etag-3' },
      { partNumber: 4, etag: 'part-etag-4' },
    ]);
    expect(result).toEqual({ skipped: false, etag: 'complete-etag' });
  });

  test('multipart aborts on uploadPart failure; original error propagates', async () => {
    const boom = new Error('bad part');
    const client = fakeClient({
      uploadPart: vi
        .fn()
        .mockResolvedValueOnce({ partNumber: 1, etag: 'p1' })
        .mockRejectedValueOnce(boom),
    });
    const big = new Uint8Array(4 * 1024).fill(0xab);
    await expect(
      uploadFile(client, entryFor(big, { name: 'big.bin' }), {
        prefix: PREFIX,
        threshold: 1024,
        partSize: 1024,
      }),
    ).rejects.toBe(boom);
    expect(client.abortMultipartUpload).toHaveBeenCalledTimes(1);
    expect(client.abortMultipartUpload).toHaveBeenCalledWith(
      `${PREFIX}/media/abc.bin`,
      'UP1',
    );
    expect(client.completeMultipartUpload).not.toHaveBeenCalled();
  });

  test('multipart progress callback fires per part with monotonic byte counts', async () => {
    const client = fakeClient();
    const big = new Uint8Array(4 * 1024).fill(0xab);
    const onProgress = vi.fn();
    await uploadFile(client, entryFor(big, { name: 'big.bin' }), {
      prefix: PREFIX,
      threshold: 1024,
      partSize: 1024,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledTimes(4);
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
      1024, 2048, 3072, 4096,
    ]);
    expect(onProgress.mock.calls.at(-1)).toEqual([4096, 4096]);
  });

  test('single-PUT progress callback fires once at completion', async () => {
    const client = fakeClient();
    const onProgress = vi.fn();
    await uploadFile(client, entryFor('hello'), {
      prefix: PREFIX,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(5, 5);
  });

  test('contentDispositionFor: ASCII filename uses simple quoted form', () => {
    expect(contentDispositionFor({ name: 'IMG_1234.jpg' }))
      .toBe('attachment; filename="IMG_1234.jpg"');
  });

  test('contentDispositionFor: non-ASCII filename uses RFC 5987 filename*', () => {
    const got = contentDispositionFor({ name: '名前.jpg' });
    expect(got).toMatch(/filename="[^"]*\.jpg"/);
    expect(got).toContain(`filename*=UTF-8''${encodeURIComponent('名前.jpg')}`);
  });

  test('contentDispositionFor: quotes/backslashes/CRLF replaced with underscores', () => {
    expect(contentDispositionFor({ name: 'we"ird\\name.jpg' }))
      .toBe('attachment; filename="we_ird_name.jpg"');
  });

  test('single PUT carries Content-Disposition with the original filename', async () => {
    const client = fakeClient();
    await uploadFile(client, entryFor('hello'), { prefix: PREFIX });
    expect(client.put.mock.calls[0][2].contentDisposition)
      .toBe('attachment; filename="IMG_0001.jpg"');
  });

  test('multipart createMultipartUpload carries Content-Disposition', async () => {
    const client = fakeClient();
    // 4KB blob > 1KB threshold → multipart path.
    const big = entryFor('x'.repeat(4096), { name: 'big.bin' });
    await uploadFile(client, big, {
      prefix: PREFIX, threshold: 1024, partSize: 1024,
    });
    expect(client.createMultipartUpload.mock.calls[0][1].contentDisposition)
      .toBe('attachment; filename="big.bin"');
  });
});
