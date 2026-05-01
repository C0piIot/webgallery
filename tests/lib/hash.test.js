// Unit tests for lib/hash.js. Node 22+ provides Blob globally, and
// Blob.stream() returns a real ReadableStream — close enough to File
// for the hasher's purposes (which only touches .size and .stream()).

import { describe, test, expect, vi } from 'vitest';
import { hashFile } from '../../lib/hash.js';

// FIPS 180-4 / NIST reference vectors.
const VECTORS = {
  '': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  abc: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  'The quick brown fox jumps over the lazy dog':
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
};

describe('lib/hash.js', () => {
  for (const [input, expected] of Object.entries(VECTORS)) {
    test(`known vector: ${JSON.stringify(input)}`, async () => {
      const hex = await hashFile(new Blob([input]));
      expect(hex).toBe(expected);
    });
  }

  test('streaming integrity: multi-chunk Blob hashes the same as single-chunk', async () => {
    const single = new Blob(['The quick brown fox jumps over the lazy dog']);
    // A four-part Blob with the same total bytes — Blob's stream() may
    // emit chunks based on internal sizing, but content must match.
    const parts = new Blob([
      'The quick brown ',
      'fox jumps ',
      'over the ',
      'lazy dog',
    ]);
    const a = await hashFile(single);
    const b = await hashFile(parts);
    expect(a).toBe(b);
    expect(a).toBe(VECTORS['The quick brown fox jumps over the lazy dog']);
  });

  test('progress callback: monotonically increasing, ends at total', async () => {
    // Multi-MB content makes Blob.stream() emit multiple chunks.
    const bytes = new Uint8Array(2 * 1024 * 1024).fill(0xab);
    const file = new Blob([bytes]);
    const calls = [];
    await hashFile(file, (n, total) => calls.push([n, total]));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.at(-1)).toEqual([file.size, file.size]);
    // Strictly increasing.
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i][0]).toBeGreaterThan(calls[i - 1][0]);
    }
  });

  test('progress callback is optional (no throw without it)', async () => {
    const file = new Blob(['hello']);
    await expect(hashFile(file)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  test('output is lowercase hex of length 64', async () => {
    const hex = await hashFile(new Blob(['anything']));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  test('progress callback fires at least once even for tiny inputs', async () => {
    const file = new Blob(['x']);
    const cb = vi.fn();
    await hashFile(file, cb);
    expect(cb).toHaveBeenCalled();
    expect(cb.mock.calls.at(-1)).toEqual([1, 1]);
  });
});
