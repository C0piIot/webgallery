// Unit tests for lib/sync.js controller. We don't spin up real Web
// Workers — they'd need a separate JS realm and a real sync-worker.js
// load path. Instead we stub the global Worker/BroadcastChannel
// constructors with lightweight fakes, and we stub
// lib/capability.js + lib/connectivity.js via vi.mock so the
// controller's hooks are observable.

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/capability.js', () => ({
  hasFsa: vi.fn(() => true),
}));

vi.mock('../../lib/connectivity.js', () => {
  let cb = null;
  return {
    isOnline: vi.fn(() => true),
    onChange: vi.fn((fn) => {
      cb = fn;
      return () => { cb = null; };
    }),
    _emitForTests: (online) => cb?.(online),
  };
});

let workers;
let channels;

class FakeWorker {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.posts = [];
    this.terminated = false;
    workers.push(this);
  }
  postMessage(msg) { this.posts.push(msg); }
  terminate() { this.terminated = true; }
}

class FakeChannel {
  constructor(name) {
    this.name = name;
    this.posts = [];
    this.closed = false;
    this.onmessage = null;
    channels.push(this);
  }
  postMessage(msg) { this.posts.push(msg); }
  close() { this.closed = true; }
}

beforeEach(async () => {
  workers = [];
  channels = [];
  globalThis.Worker = FakeWorker;
  globalThis.BroadcastChannel = FakeChannel;
  vi.resetModules();
  // Reset the capability stub default to true.
  const cap = await import('../../lib/capability.js');
  cap.hasFsa.mockImplementation(() => true);
});

async function freshController() {
  const { createSyncController } = await import('../../lib/sync.js');
  return createSyncController({ workerUrl: 'mock://sync-worker' });
}

describe('lib/sync.js controller', () => {
  test('start() throws when hasFsa() is false', async () => {
    const cap = await import('../../lib/capability.js');
    cap.hasFsa.mockImplementation(() => false);
    const c = await freshController();
    expect(() => c.start()).toThrow(/FSA not available/i);
    expect(workers).toHaveLength(0);
  });

  test('start() creates a Worker and posts {type:start, online}', async () => {
    const c = await freshController();
    c.start();
    expect(workers).toHaveLength(1);
    expect(workers[0].posts).toEqual([{ type: 'start', online: true }]);
  });

  test('start() is idempotent — second call is a no-op', async () => {
    const c = await freshController();
    c.start();
    c.start();
    expect(workers).toHaveLength(1);
  });

  test('stop() terminates the worker, closes channel, is idempotent', async () => {
    const c = await freshController();
    c.start();
    c.stop();
    expect(workers[0].terminated).toBe(true);
    expect(channels[0].closed).toBe(true);
    // Second stop is a no-op (no throw, no extra messages).
    expect(() => c.stop()).not.toThrow();
  });

  test('pause / resume / retry post the right command messages', async () => {
    const c = await freshController();
    c.start();
    workers[0].posts.length = 0; // ignore the start
    c.pause();
    c.resume();
    c.retry('a.jpg');
    expect(workers[0].posts).toEqual([
      { type: 'pause' },
      { type: 'resume' },
      { type: 'retry', path: 'a.jpg' },
    ]);
  });

  test('connectivity offline → posts pause; online → posts resume', async () => {
    const c = await freshController();
    c.start();
    workers[0].posts.length = 0;
    const conn = await import('../../lib/connectivity.js');
    conn._emitForTests(false);
    conn._emitForTests(true);
    expect(workers[0].posts).toEqual([{ type: 'pause' }, { type: 'resume' }]);
  });

  test('on(*) and on(type) re-fan BroadcastChannel events to listeners', async () => {
    const c = await freshController();
    c.start();
    const seenAll = [];
    const seenUploaded = [];
    c.on('*', (m) => seenAll.push(m));
    c.on('file-uploaded', (m) => seenUploaded.push(m));

    // Simulate the worker broadcasting on the channel.
    const ch = channels[0];
    ch.onmessage({ data: { type: 'state', state: 'running' } });
    ch.onmessage({ data: { type: 'file-uploaded', path: 'a.jpg' } });

    expect(seenAll).toEqual([
      { type: 'state', state: 'running' },
      { type: 'file-uploaded', path: 'a.jpg' },
    ]);
    expect(seenUploaded).toEqual([{ type: 'file-uploaded', path: 'a.jpg' }]);
  });
});
