// Unit tests for lib/config.js. Same fake-indexeddb pattern as db.test.js
// — fresh IDBFactory per test plus vi.resetModules() so the cached
// dbPromise inside lib/db.js is dropped between tests.

import { IDBFactory } from 'fake-indexeddb';
import { describe, test, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
});

const validConfig = () => ({
  endpoint: 'https://s3.amazonaws.com',
  region: 'us-east-1',
  bucket: 'my-bucket',
  prefix: 'phone',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
});

describe('lib/config.js', () => {
  test('loadConfig returns null initially', async () => {
    const { loadConfig } = await import('../../lib/config.js');
    expect(await loadConfig()).toBeNull();
  });

  test('hasConfig returns false initially', async () => {
    const { hasConfig } = await import('../../lib/config.js');
    expect(await hasConfig()).toBe(false);
  });

  test('saveConfig + loadConfig round-trip preserves the record', async () => {
    const { saveConfig, loadConfig } = await import('../../lib/config.js');
    const c = validConfig();
    await saveConfig(c);
    const loaded = await loadConfig();
    expect(loaded).toMatchObject(c);
  });

  test('hasConfig becomes true after saveConfig', async () => {
    const { saveConfig, hasConfig } = await import('../../lib/config.js');
    await saveConfig(validConfig());
    expect(await hasConfig()).toBe(true);
  });

  test('clearConfig wipes the record', async () => {
    const { saveConfig, clearConfig, loadConfig } = await import(
      '../../lib/config.js'
    );
    await saveConfig(validConfig());
    await clearConfig();
    expect(await loadConfig()).toBeNull();
  });

  test('validateConfig flags every missing required field at once', async () => {
    const { validateConfig } = await import('../../lib/config.js');
    const errors = validateConfig({});
    const fields = errors.map((e) => e.field).sort();
    expect(fields).toEqual([
      'accessKeyId',
      'bucket',
      'endpoint',
      'prefix',
      'region',
      'secretAccessKey',
    ]);
  });

  test('validateConfig rejects an unparseable endpoint URL', async () => {
    const { validateConfig } = await import('../../lib/config.js');
    const errors = validateConfig({ ...validConfig(), endpoint: 'not a url' });
    expect(errors.find((e) => e.field === 'endpoint')).toBeDefined();
  });

  test('validateConfig allows http:// for local hosts; rejects public http://', async () => {
    const { validateConfig } = await import('../../lib/config.js');
    // Loopback + single-label + .local all accepted (Docker, k8s, mDNS).
    expect(
      validateConfig({ ...validConfig(), endpoint: 'http://localhost:9000' }),
    ).toEqual([]);
    expect(
      validateConfig({ ...validConfig(), endpoint: 'http://127.0.0.1:9000' }),
    ).toEqual([]);
    expect(
      validateConfig({ ...validConfig(), endpoint: 'http://minio:9000' }),
    ).toEqual([]);
    expect(
      validateConfig({ ...validConfig(), endpoint: 'http://nas.local:9000' }),
    ).toEqual([]);
    // Anything with a dot that isn't .local still needs https://.
    const bad = validateConfig({
      ...validConfig(),
      endpoint: 'http://example.com',
    });
    expect(bad.find((e) => e.field === 'endpoint')).toBeDefined();
  });

  test('saveConfig throws ConfigError carrying the same errors validateConfig returns', async () => {
    const { saveConfig, validateConfig, ConfigError } = await import(
      '../../lib/config.js'
    );
    const bad = { ...validConfig(), bucket: '' };
    let err;
    try {
      await saveConfig(bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.errors).toEqual(validateConfig(bad));
  });

  test('defaultPathStyle: AWS endpoint → false; non-AWS → true; malformed → true', async () => {
    const { defaultPathStyle } = await import('../../lib/config.js');
    expect(defaultPathStyle('https://s3.amazonaws.com')).toBe(false);
    expect(defaultPathStyle('https://s3.us-west-2.amazonaws.com')).toBe(false);
    expect(defaultPathStyle('https://minio.example.com')).toBe(true);
    expect(defaultPathStyle('http://localhost:9000')).toBe(true);
    expect(defaultPathStyle('not a url')).toBe(true);
  });

  test('saveConfig fills pathStyle via defaultPathStyle when omitted', async () => {
    const { saveConfig, loadConfig } = await import('../../lib/config.js');
    await saveConfig(validConfig()); // AWS → false
    expect((await loadConfig()).pathStyle).toBe(false);
  });

  test('saveConfig respects explicit pathStyle from caller', async () => {
    const { saveConfig, loadConfig } = await import('../../lib/config.js');
    await saveConfig({ ...validConfig(), pathStyle: true });
    expect((await loadConfig()).pathStyle).toBe(true);
  });
});
