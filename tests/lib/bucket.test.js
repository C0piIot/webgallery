// Unit tests for lib/bucket.js. globalThis.fetch is stubbed; aws4fetch
// internally calls it, so we assert URL / method / body / key headers on
// the captured Request instead of asserting exact signed Authorization
// values (which depend on the wall-clock timestamp).

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createBucketClient, BucketError } from '../../lib/bucket.js';

const baseConfig = {
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'my-bucket',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  pathStyle: false,
};

beforeEach(() => {
  // Default behavior: 200 OK with empty body. Tests override per-call with
  // mockResolvedValueOnce. Captured calls live on globalThis.fetch.mock.calls.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 200 })),
  );
});

// First request from the captured fetch calls (each test makes one call).
function firstReq() {
  return globalThis.fetch.mock.calls[0][0];
}

describe('lib/bucket.js', () => {
  test('put: virtual-hosted URL + content-type + metadata headers', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      new Response('', { status: 200, headers: { etag: '"abc"' } }),
    );
    const client = createBucketClient(baseConfig);
    const result = await client.put('media/foo.jpg', 'hi', {
      contentType: 'image/jpeg',
      metadata: { filename: 'foo.jpg', captured: '2025-01-01' },
    });
    expect(result).toEqual({ etag: 'abc' });
    const req = firstReq();
    const url = new URL(req.url);
    expect(req.method).toBe('PUT');
    expect(url.host).toBe('my-bucket.s3.example.com');
    expect(url.pathname).toBe('/media/foo.jpg');
    expect(req.headers.get('content-type')).toBe('image/jpeg');
    expect(req.headers.get('x-amz-meta-filename')).toBe('foo.jpg');
    expect(req.headers.get('x-amz-meta-captured')).toBe('2025-01-01');
  });

  test('put: path-style puts bucket in the path, not the host', async () => {
    const client = createBucketClient({ ...baseConfig, pathStyle: true });
    await client.put('media/foo.jpg', 'hi', { contentType: 'image/jpeg' });
    const url = new URL(firstReq().url);
    expect(url.host).toBe('s3.example.com');
    expect(url.pathname).toBe('/my-bucket/media/foo.jpg');
  });

  test('get: GET URL correct, returns the underlying Response', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      new Response('hello', { status: 200 }),
    );
    const client = createBucketClient(baseConfig);
    const res = await client.get('media/foo.jpg');
    expect(firstReq().method).toBe('GET');
    expect(new URL(firstReq().url).pathname).toBe('/media/foo.jpg');
    expect(await res.text()).toBe('hello');
  });

  test('head (200): parses size, content-type, etag, metadata', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: {
          'content-length': '12345',
          'content-type': 'image/jpeg',
          'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
          etag: '"def"',
          'x-amz-meta-filename': 'foo.jpg',
          'x-amz-meta-captured-at': '2025-01-01',
        },
      }),
    );
    const client = createBucketClient(baseConfig);
    const meta = await client.head('media/foo.jpg');
    expect(firstReq().method).toBe('HEAD');
    expect(meta.size).toBe(12345);
    expect(meta.contentType).toBe('image/jpeg');
    expect(meta.etag).toBe('def');
    expect(meta.metadata).toEqual({
      filename: 'foo.jpg',
      'captured-at': '2025-01-01',
    });
  });

  test('head (404): rejects with BucketError carrying status 404', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      new Response(null, { status: 404, statusText: 'Not Found' }),
    );
    const client = createBucketClient(baseConfig);
    let err;
    try {
      await client.head('missing');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BucketError);
    expect(err.status).toBe(404);
  });

  test('list: GET with list-type=2 + prefix; parses Contents', async () => {
    const xml = `<?xml version="1.0"?>
<ListBucketResult>
  <Contents><Key>media/a.jpg</Key><Size>10</Size><LastModified>X</LastModified><ETag>"e1"</ETag></Contents>
  <Contents><Key>media/b.jpg</Key><Size>20</Size><LastModified>Y</LastModified><ETag>"e2"</ETag></Contents>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`;
    globalThis.fetch.mockResolvedValueOnce(new Response(xml, { status: 200 }));
    const client = createBucketClient(baseConfig);
    const out = await client.list({ prefix: 'media/' });
    const url = new URL(firstReq().url);
    expect(url.searchParams.get('list-type')).toBe('2');
    expect(url.searchParams.get('prefix')).toBe('media/');
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toMatchObject({
      key: 'media/a.jpg',
      size: 10,
      etag: 'e1',
    });
    expect(out.isTruncated).toBe(false);
  });

  test('list: continuation-token round-trips', async () => {
    const xml = `<?xml version="1.0"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>NEXT</NextContinuationToken>
</ListBucketResult>`;
    globalThis.fetch.mockResolvedValueOnce(new Response(xml, { status: 200 }));
    const client = createBucketClient(baseConfig);
    const out = await client.list({ continuationToken: 'TOKEN' });
    const url = new URL(firstReq().url);
    expect(url.searchParams.get('continuation-token')).toBe('TOKEN');
    expect(out.continuationToken).toBe('NEXT');
    expect(out.isTruncated).toBe(true);
  });

  test('delete: DELETE URL correct', async () => {
    const client = createBucketClient(baseConfig);
    await client.delete('media/foo.jpg');
    expect(firstReq().method).toBe('DELETE');
    expect(new URL(firstReq().url).pathname).toBe('/media/foo.jpg');
  });

  test('error mapping: 403 with S3 XML body → BucketError code/message', async () => {
    const xml = `<?xml version="1.0"?>
<Error>
  <Code>SignatureDoesNotMatch</Code>
  <Message>The signature is wrong</Message>
</Error>`;
    globalThis.fetch.mockResolvedValueOnce(new Response(xml, { status: 403 }));
    const client = createBucketClient(baseConfig);
    let err;
    try {
      await client.get('foo');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BucketError);
    expect(err.status).toBe(403);
    expect(err.code).toBe('SignatureDoesNotMatch');
    expect(err.message).toBe('The signature is wrong');
  });

  test('createMultipartUpload: POST ?uploads, returns uploadId', async () => {
    const xml =
      '<InitiateMultipartUploadResult><UploadId>UP1</UploadId></InitiateMultipartUploadResult>';
    globalThis.fetch.mockResolvedValueOnce(new Response(xml, { status: 200 }));
    const client = createBucketClient(baseConfig);
    const out = await client.createMultipartUpload('media/big.mp4');
    expect(firstReq().method).toBe('POST');
    expect(new URL(firstReq().url).searchParams.has('uploads')).toBe(true);
    expect(out.uploadId).toBe('UP1');
  });

  test('uploadPart: PUT with partNumber + uploadId, returns etag', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      new Response(null, { status: 200, headers: { etag: '"part1"' } }),
    );
    const client = createBucketClient(baseConfig);
    const out = await client.uploadPart('media/big.mp4', 'UP1', 1, 'chunk');
    const url = new URL(firstReq().url);
    expect(firstReq().method).toBe('PUT');
    expect(url.searchParams.get('partNumber')).toBe('1');
    expect(url.searchParams.get('uploadId')).toBe('UP1');
    expect(out).toEqual({ partNumber: 1, etag: 'part1' });
  });

  test('completeMultipartUpload: POSTs parts XML, returns final etag', async () => {
    const xml =
      '<CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>';
    globalThis.fetch.mockResolvedValueOnce(new Response(xml, { status: 200 }));
    const client = createBucketClient(baseConfig);
    const out = await client.completeMultipartUpload('media/big.mp4', 'UP1', [
      { partNumber: 1, etag: 'a' },
      { partNumber: 2, etag: 'b' },
    ]);
    expect(firstReq().method).toBe('POST');
    expect(new URL(firstReq().url).searchParams.get('uploadId')).toBe('UP1');
    expect(out.etag).toBe('final');
    const body = await firstReq().text();
    expect(body).toContain('<PartNumber>1</PartNumber>');
    expect(body).toContain('<PartNumber>2</PartNumber>');
  });

  test('abortMultipartUpload: DELETE with uploadId', async () => {
    const client = createBucketClient(baseConfig);
    await client.abortMultipartUpload('media/big.mp4', 'UP1');
    expect(firstReq().method).toBe('DELETE');
    expect(new URL(firstReq().url).searchParams.get('uploadId')).toBe('UP1');
  });
});
