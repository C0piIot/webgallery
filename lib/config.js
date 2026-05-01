// Storage config persistence + validation. Reads/writes a single record
// at the fixed key 'storage' in the `config` object store (see lib/db.js).
//
// The shape matches what lib/bucket.js's createBucketClient(config)
// expects — pass a loaded object straight through, no translation.

import * as db from './db.js';

const STORE = 'config';
const KEY = 'storage';

const REQUIRED_FIELDS = [
  'endpoint',
  'region',
  'bucket',
  'prefix',
  'accessKeyId',
  'secretAccessKey',
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export class ConfigError extends Error {
  constructor(errors) {
    super(
      errors
        .map((e) => `${e.field}: ${e.message}`)
        .join('; ') || 'invalid config',
    );
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

export function validateConfig(c) {
  const errors = [];
  if (c == null || typeof c !== 'object') {
    return [{ field: '_root', message: 'must be an object' }];
  }

  for (const f of REQUIRED_FIELDS) {
    const v = c[f];
    if (typeof v !== 'string' || v.trim() === '') {
      errors.push({ field: f, message: 'is required' });
    }
  }

  if (typeof c.endpoint === 'string' && c.endpoint.trim() !== '') {
    let url;
    try {
      url = new URL(c.endpoint);
    } catch {
      errors.push({ field: 'endpoint', message: 'must be a valid URL' });
    }
    if (url) {
      if (url.protocol === 'http:') {
        if (!LOCAL_HOSTS.has(url.hostname)) {
          errors.push({
            field: 'endpoint',
            message: 'http:// is only allowed for localhost / 127.0.0.1',
          });
        }
      } else if (url.protocol !== 'https:') {
        errors.push({
          field: 'endpoint',
          message: 'must use http:// (localhost only) or https://',
        });
      }
    }
  }

  if (
    'pathStyle' in c &&
    c.pathStyle !== undefined &&
    typeof c.pathStyle !== 'boolean'
  ) {
    errors.push({ field: 'pathStyle', message: 'must be boolean if set' });
  }

  return errors;
}

export function defaultPathStyle(endpoint) {
  try {
    const host = new URL(endpoint).host;
    // AWS S3 (real or accelerated): virtual-hosted by default.
    if (/(^|\.)amazonaws\.com$/i.test(host)) return false;
    // Everything else (MinIO, B2, R2 raw endpoint, local dev): path-style.
    return true;
  } catch {
    return true;
  }
}

export async function loadConfig() {
  const v = await db.get(STORE, KEY);
  return v ?? null;
}

export async function hasConfig() {
  return (await loadConfig()) != null;
}

export async function saveConfig(c) {
  const errors = validateConfig(c);
  if (errors.length) throw new ConfigError(errors);

  const record = {
    endpoint: c.endpoint.trim(),
    region: c.region.trim(),
    bucket: c.bucket.trim(),
    prefix: c.prefix.trim(),
    accessKeyId: c.accessKeyId.trim(),
    secretAccessKey: c.secretAccessKey,
    pathStyle:
      typeof c.pathStyle === 'boolean'
        ? c.pathStyle
        : defaultPathStyle(c.endpoint),
  };
  await db.put(STORE, record, KEY);
}

export async function clearConfig() {
  await db.del(STORE, KEY);
}
