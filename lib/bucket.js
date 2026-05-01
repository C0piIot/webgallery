// BucketClient — single seam for every S3 / S3-compatible call. Wraps
// aws4fetch's AwsClient for SigV4 signing; isolates provider quirks
// (path-style vs virtual-hosted, etc.). Per architecture:
// docs/architecture.md → Talking to S3.
//
// Usage:
//   import { createBucketClient } from './bucket.js';
//   const client = createBucketClient({
//     endpoint: 'https://s3.amazonaws.com',
//     region: 'us-east-1',
//     bucket: 'my-bucket',
//     accessKeyId: '...',
//     secretAccessKey: '...',
//     pathStyle: false,         // true for MinIO/B2; false for AWS S3
//   });
//   await client.put('media/abc.jpg', blob, { contentType: 'image/jpeg' });

import { AwsClient } from '../vendor/aws4fetch.js';

export class BucketError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'BucketError';
    this.status = status;
    this.code = code;
  }
}

function urlFor(config, key, query) {
  const u = new URL(config.endpoint);
  const encodedKey = key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  if (config.pathStyle) {
    u.pathname = `/${config.bucket}/${encodedKey}`;
  } else {
    u.host = `${config.bucket}.${u.host}`;
    u.pathname = `/${encodedKey}`;
  }
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

async function ensureOk(res) {
  if (res.ok) return res;
  // HEAD has no body; everything else may carry an S3 error XML payload.
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  const code =
    text.match(/<Code>([^<]+)<\/Code>/)?.[1] ||
    res.statusText ||
    'UnknownError';
  const message =
    text.match(/<Message>([^<]+)<\/Message>/)?.[1] ||
    text ||
    res.statusText ||
    `HTTP ${res.status}`;
  throw new BucketError(res.status, code, message);
}

function unescapeXml(s) {
  return s == null
    ? s
    : s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

function parseListXml(xml) {
  const items = [];
  for (const c of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
    items.push({
      key: unescapeXml(c.match(/<Key>([\s\S]*?)<\/Key>/)?.[1]),
      size: parseInt(c.match(/<Size>(\d+)<\/Size>/)?.[1] ?? '0', 10),
      lastModified: c.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1],
      etag: c.match(/<ETag>"?([^"<]+)"?<\/ETag>/)?.[1],
    });
  }
  const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const continuationToken = xml.match(
    /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/,
  )?.[1];
  return { items, isTruncated, continuationToken };
}

function parseUploadIdXml(xml) {
  return xml.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
}

function parseEtagXml(xml) {
  return xml.match(/<ETag>"?([^"<]+)"?<\/ETag>/)?.[1];
}

function stripQuotes(s) {
  return s == null ? s : s.replace(/^"|"$/g, '');
}

function metaHeaders(metadata) {
  const out = {};
  if (!metadata) return out;
  for (const [k, v] of Object.entries(metadata)) {
    if (v == null) continue;
    out[`x-amz-meta-${k.toLowerCase()}`] = String(v);
  }
  return out;
}

function readMetadataFromHeaders(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    if (k.toLowerCase().startsWith('x-amz-meta-')) {
      out[k.slice('x-amz-meta-'.length)] = v;
    }
  }
  return out;
}

export function createBucketClient(config) {
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: config.region,
  });

  async function signedFetch(url, init) {
    return aws.fetch(url, init);
  }

  async function put(key, body, { contentType, metadata } = {}) {
    const headers = { ...metaHeaders(metadata) };
    if (contentType) headers['content-type'] = contentType;
    const res = await signedFetch(urlFor(config, key), {
      method: 'PUT',
      body,
      headers,
    });
    await ensureOk(res);
    return { etag: stripQuotes(res.headers.get('etag')) };
  }

  async function get(key) {
    const res = await signedFetch(urlFor(config, key), { method: 'GET' });
    await ensureOk(res);
    return res;
  }

  async function head(key) {
    const res = await signedFetch(urlFor(config, key), { method: 'HEAD' });
    await ensureOk(res);
    const len = res.headers.get('content-length');
    return {
      size: len == null ? undefined : parseInt(len, 10),
      contentType: res.headers.get('content-type') || undefined,
      lastModified: res.headers.get('last-modified') || undefined,
      etag: stripQuotes(res.headers.get('etag')) || undefined,
      metadata: readMetadataFromHeaders(res.headers),
    };
  }

  async function list({ prefix, continuationToken, maxKeys } = {}) {
    const url = urlFor(config, '', {
      'list-type': '2',
      prefix,
      'continuation-token': continuationToken,
      'max-keys': maxKeys,
    });
    const res = await signedFetch(url, { method: 'GET' });
    await ensureOk(res);
    const xml = await res.text();
    return parseListXml(xml);
  }

  async function del(key) {
    const res = await signedFetch(urlFor(config, key), { method: 'DELETE' });
    await ensureOk(res);
  }

  async function createMultipartUpload(key, { contentType, metadata } = {}) {
    const headers = { ...metaHeaders(metadata) };
    if (contentType) headers['content-type'] = contentType;
    const res = await signedFetch(urlFor(config, key, { uploads: '' }), {
      method: 'POST',
      headers,
    });
    await ensureOk(res);
    const uploadId = parseUploadIdXml(await res.text());
    if (!uploadId) {
      throw new BucketError(500, 'MalformedResponse', 'No UploadId in response');
    }
    return { uploadId };
  }

  async function uploadPart(key, uploadId, partNumber, body) {
    const url = urlFor(config, key, {
      partNumber: String(partNumber),
      uploadId,
    });
    const res = await signedFetch(url, { method: 'PUT', body });
    await ensureOk(res);
    return { partNumber, etag: stripQuotes(res.headers.get('etag')) };
  }

  async function completeMultipartUpload(key, uploadId, parts) {
    const body =
      '<CompleteMultipartUpload>' +
      parts
        .map(
          (p) =>
            `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`,
        )
        .join('') +
      '</CompleteMultipartUpload>';
    const res = await signedFetch(urlFor(config, key, { uploadId }), {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body,
    });
    await ensureOk(res);
    const xml = await res.text();
    return { etag: parseEtagXml(xml) };
  }

  async function abortMultipartUpload(key, uploadId) {
    const res = await signedFetch(urlFor(config, key, { uploadId }), {
      method: 'DELETE',
    });
    await ensureOk(res);
  }

  return {
    put,
    get,
    head,
    list,
    delete: del,
    createMultipartUpload,
    uploadPart,
    completeMultipartUpload,
    abortMultipartUpload,
  };
}
