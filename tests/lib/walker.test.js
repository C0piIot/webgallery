// Unit tests for lib/walker.js. Mocked FSA-shaped handles — the walker's
// contract is the iterator protocol, not real File objects.

import { describe, test, expect, vi } from 'vitest';
import { walkFolder } from '../../lib/walker.js';

function makeFile(name, size = 1, mtime = 0) {
  return {
    kind: 'file',
    getFile: async () => ({ name, size, lastModified: mtime }),
  };
}

function makeDir(entries) {
  return {
    kind: 'directory',
    entries: async function* () {
      for (const pair of entries) yield pair;
    },
  };
}

async function collect(iter) {
  const batches = [];
  for await (const b of iter) batches.push(b);
  return batches;
}

describe('lib/walker.js', () => {
  test('empty directory yields zero batches', async () => {
    const root = makeDir([]);
    expect(await collect(walkFolder(root))).toEqual([]);
  });

  test('single file: one batch of length 1 with correct fields', async () => {
    const root = makeDir([['a.jpg', makeFile('a.jpg', 100, 555)]]);
    const batches = await collect(walkFolder(root));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0]).toMatchObject({
      path: 'a.jpg',
      name: 'a.jpg',
      size: 100,
      mtime: 555,
    });
    expect(batches[0][0].file).toBeDefined();
  });

  test('multiple files at root: contents and ordering match insertion', async () => {
    const root = makeDir([
      ['a.jpg', makeFile('a.jpg')],
      ['b.jpg', makeFile('b.jpg')],
      ['c.jpg', makeFile('c.jpg')],
    ]);
    const batches = await collect(walkFolder(root));
    expect(batches.flat().map((e) => e.name)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
  });

  test('nested structure: paths are slash-joined; DFS order', async () => {
    // a/                 ← directory
    //   b/               ← directory
    //     c.jpg          ← file (deepest first by DFS)
    //   leaf.jpg         ← file (after b/)
    // root.jpg
    const root = makeDir([
      [
        'a',
        makeDir([
          ['b', makeDir([['c.jpg', makeFile('c.jpg', 10)]])],
          ['leaf.jpg', makeFile('leaf.jpg', 20)],
        ]),
      ],
      ['root.jpg', makeFile('root.jpg', 30)],
    ]);
    const entries = (await collect(walkFolder(root))).flat();
    expect(entries.map((e) => e.path)).toEqual([
      'a/b/c.jpg',
      'a/leaf.jpg',
      'root.jpg',
    ]);
  });

  test('default batch size is 32: 100 files → 32, 32, 32, 4', async () => {
    const files = Array.from({ length: 100 }, (_, i) => [
      `f${i}.jpg`,
      makeFile(`f${i}.jpg`),
    ]);
    const root = makeDir(files);
    const batches = await collect(walkFolder(root));
    expect(batches.map((b) => b.length)).toEqual([32, 32, 32, 4]);
  });

  test('custom batch size: 23 files at batchSize 5 → 5,5,5,5,3', async () => {
    const files = Array.from({ length: 23 }, (_, i) => [
      `f${i}.jpg`,
      makeFile(`f${i}.jpg`),
    ]);
    const root = makeDir(files);
    const batches = await collect(walkFolder(root, { batchSize: 5 }));
    expect(batches.map((b) => b.length)).toEqual([5, 5, 5, 5, 3]);
  });

  test('yieldFn called once per *complete* batch (not after the partial tail)', async () => {
    const files = Array.from({ length: 23 }, (_, i) => [
      `f${i}.jpg`,
      makeFile(`f${i}.jpg`),
    ]);
    const root = makeDir(files);
    const yieldFn = vi.fn(() => Promise.resolve());
    await collect(walkFolder(root, { batchSize: 5, yieldFn }));
    // 23 / 5 = 4 complete batches → 4 yields. The trailing 3-entry batch
    // is yielded but not followed by a yieldFn call.
    expect(yieldFn).toHaveBeenCalledTimes(4);
  });

  test('stress: 1000 files in one directory; no batch exceeds the size', async () => {
    const files = Array.from({ length: 1000 }, (_, i) => [
      `f${i}.jpg`,
      makeFile(`f${i}.jpg`),
    ]);
    const root = makeDir(files);
    const batches = await collect(walkFolder(root, { yieldFn: () => Promise.resolve() }));
    const total = batches.reduce((s, b) => s + b.length, 0);
    expect(total).toBe(1000);
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(32);
    }
  });

  test('stress: 100 directories × 10 files; all 1000 emitted with shape paths', async () => {
    const dirs = Array.from({ length: 100 }, (_, di) => [
      `dir-${di}`,
      makeDir(
        Array.from({ length: 10 }, (_, fi) => [
          `f${fi}.jpg`,
          makeFile(`f${fi}.jpg`),
        ]),
      ),
    ]);
    const root = makeDir(dirs);
    const entries = (
      await collect(walkFolder(root, { yieldFn: () => Promise.resolve() }))
    ).flat();
    expect(entries).toHaveLength(1000);
    expect(entries[0].path).toBe('dir-0/f0.jpg');
    expect(entries.at(-1).path).toBe('dir-99/f9.jpg');
  });
});
