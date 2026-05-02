// Upload a single file to S3-compatible storage under
// {prefix}/media/{sha256}.{ext}. HEAD-checks first to skip duplicates.
// Switches to multipart when file.size > threshold.
//
// Pure function over a BucketClient — no IndexedDB, no Web Worker
// concerns. The sync controller (#15) and retry layer (#16) wrap this
// with per-file state and backoff.

const DEFAULT_THRESHOLD = 50 * 1024 * 1024;
const DEFAULT_PART_SIZE = 8 * 1024 * 1024;

const EXT_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
};

function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i < 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

export function keyFor(prefix, hash, name) {
  const ext = extOf(name);
  return ext ? `${prefix}/media/${hash}.${ext}` : `${prefix}/media/${hash}`;
}

function metaFor(entry) {
  const m = {
    filename: entry.name,
    'source-path': entry.path,
  };
  if (entry.capturedAt) m['captured-at'] = entry.capturedAt;
  return m;
}

function contentTypeFor(entry) {
  if (entry.file?.type) return entry.file.type;
  return EXT_MIME[extOf(entry.name)] ?? 'application/octet-stream';
}

// `Content-Disposition` lets the browser save direct downloads (from
// the bucket's web console, presigned URL clicks, etc.) under the
// original filename instead of the hash-keyed name we store under.
// RFC 5987: ASCII-only names use the simpler quoted form; non-ASCII
// names need a `filename*` with UTF-8 percent-encoding (with a
// sanitized ASCII fallback for old clients).
export function contentDispositionFor(entry) {
  const name = entry?.name ?? '';
  const sanitized = name.replace(/["\\\r\n]/g, '_');
  if (/^[\x20-\x7e]+$/.test(sanitized)) {
    return `attachment; filename="${sanitized}"`;
  }
  return `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * @param {object} client - BucketClient (lib/bucket.js).
 * @param {{ path, name, size, hash, file, capturedAt? }} entry
 * @param {{ prefix: string, threshold?: number, partSize?: number,
 *           onProgress?: (uploaded: number, total: number) => void,
 *           signal?: AbortSignal }} opts
 * @returns {Promise<{ skipped: boolean, etag?: string }>}
 */
export async function uploadFile(client, entry, opts = {}) {
  if (!opts.prefix) throw new Error('opts.prefix is required');
  if (!entry?.hash) throw new Error('entry.hash is required');

  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const partSize = opts.partSize ?? DEFAULT_PART_SIZE;
  const { onProgress, signal } = opts;

  const key = keyFor(opts.prefix, entry.hash, entry.name);
  const metadata = metaFor(entry);
  const contentType = contentTypeFor(entry);
  const contentDisposition = contentDispositionFor(entry);

  // 1. HEAD for dedup.
  try {
    await client.head(key);
    return { skipped: true };
  } catch (err) {
    if (err?.status !== 404) throw err;
  }

  signal?.throwIfAborted?.();

  // 2. Single PUT vs multipart.
  if (entry.size <= threshold) {
    const { etag } = await client.put(key, entry.file, {
      contentType,
      contentDisposition,
      metadata,
    });
    if (onProgress) onProgress(entry.size, entry.size);
    return { skipped: false, etag };
  }

  return uploadMultipart(client, entry, {
    key,
    contentType,
    contentDisposition,
    metadata,
    partSize,
    onProgress,
    signal,
  });
}

async function uploadMultipart(client, entry, ctx) {
  const {
    key, contentType, contentDisposition, metadata, partSize, onProgress, signal,
  } = ctx;

  const { uploadId } = await client.createMultipartUpload(key, {
    contentType,
    contentDisposition,
    metadata,
  });
  const parts = [];
  try {
    let partNumber = 1;
    for (let offset = 0; offset < entry.size; offset += partSize) {
      signal?.throwIfAborted?.();
      const end = Math.min(offset + partSize, entry.size);
      const slice = entry.file.slice(offset, end);
      const { etag } = await client.uploadPart(key, uploadId, partNumber, slice);
      parts.push({ partNumber, etag });
      if (onProgress) onProgress(end, entry.size);
      partNumber++;
    }
    const { etag } = await client.completeMultipartUpload(key, uploadId, parts);
    return { skipped: false, etag };
  } catch (err) {
    try {
      await client.abortMultipartUpload(key, uploadId);
    } catch {
      /* swallow — already in error path */
    }
    throw err;
  }
}
