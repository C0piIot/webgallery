// Sync engine — runs inside a Web Worker started by lib/sync.js.
//
// Two layers in one file:
//  1. runSync(deps) — pure async function. Walks → hashes → uploads,
//     writes per-file state to sync_index, broadcasts on the
//     BroadcastChannel. Every dependency is overridable so tests drive
//     it directly without spawning a Worker.
//  2. self.onmessage glue — only registers when this module is loaded
//     inside a Worker (no `window`, has `self`). Tests never hit it.

import { walkFolder } from './walker.js';
import { hashFile } from './hash.js';
import { uploadFile } from './upload.js';
import { createBucketClient } from './bucket.js';
import { loadConfig } from './config.js';
import { listFolders, ensurePermissions } from './folders.js';
import * as db from './db.js';
import { retryWithBackoff, isTransientError } from './retry.js';

const CHANNEL = 'webgallery:sync';

// Module-level state — only meaningful when this file is loaded inside
// a real Worker. The pause gate is the mechanism that lets the
// command-handler block runSync mid-loop.
let state = 'idle'; // 'idle' | 'running' | 'paused' | 'stopped'
let pauseGate = Promise.resolve();
let pauseGateResolve = null;

const channel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;

function defaultBroadcast(msg) {
  channel?.postMessage(msg);
}

async function gate() {
  if (state === 'stopped') throw new Error('stopped');
  while (state === 'paused') {
    await pauseGate;
    if (state === 'stopped') throw new Error('stopped');
  }
}

function pauseLoop(broadcast) {
  if (state !== 'running') return;
  state = 'paused';
  pauseGate = new Promise((resolve) => {
    pauseGateResolve = resolve;
  });
  broadcast({ type: 'state', state, reason: 'paused' });
}

function resumeLoop(broadcast) {
  if (state !== 'paused') return;
  state = 'running';
  pauseGateResolve?.();
  pauseGateResolve = null;
  broadcast({ type: 'state', state });
}

export async function runSync(deps = {}) {
  const _loadConfig = deps.loadConfig ?? loadConfig;
  const _listFolders = deps.listFolders ?? listFolders;
  const _ensurePerms = deps.ensurePermissions ?? ensurePermissions;
  const _walkFolder = deps.walkFolder ?? walkFolder;
  const _hashFile = deps.hashFile ?? hashFile;
  const _uploadFile = deps.uploadFile ?? uploadFile;
  const _createClient = deps.createBucketClient ?? createBucketClient;
  const _db = deps.db ?? db;
  const _broadcast = deps.broadcast ?? defaultBroadcast;
  const _retry = deps.retry ?? retryWithBackoff;
  const _isTransient = deps.isTransient ?? isTransientError;
  const _retryOpts = deps.retryOpts ?? {};

  state = 'running';
  _broadcast({ type: 'state', state: 'running' });

  const config = await _loadConfig();
  if (!config) {
    state = 'idle';
    _broadcast({ type: 'state', state: 'idle', reason: 'no-config' });
    return;
  }
  const folders = await _listFolders();
  if (!folders.length) {
    state = 'idle';
    _broadcast({ type: 'state', state: 'idle', reason: 'no-folders' });
    return;
  }

  const client = _createClient(config);

  for (const folder of folders) {
    await gate();
    const granted = await _ensurePerms(folder.handle).catch(() => false);
    if (!granted) {
      _broadcast({
        type: 'folder-error',
        folder: folder.label,
        error: 'permission-denied',
      });
      continue;
    }

    let count = 0;
    for await (const batch of _walkFolder(folder.handle)) {
      for (const entry of batch) {
        await gate();
        await processEntry(
          entry,
          folder,
          config,
          client,
          _db,
          _hashFile,
          _uploadFile,
          _broadcast,
          { retry: _retry, isTransient: _isTransient, retryOpts: _retryOpts },
        );
        count++;
      }
      _broadcast({ type: 'walking', folder: folder.label, count });
    }
  }

  state = 'idle';
  _broadcast({ type: 'state', state: 'idle', reason: 'completed' });
}

async function processEntry(
  entry,
  folder,
  config,
  client,
  _db,
  _hashFile,
  _uploadFile,
  _broadcast,
  retryCtx,
) {
  const existing = await _db.get('sync_index', entry.path);
  if (
    existing &&
    existing.size === entry.size &&
    existing.mtime === entry.mtime &&
    existing.status === 'uploaded'
  ) {
    return;
  }

  await _db.put('sync_index', {
    path: entry.path,
    folderId: folder.id,
    folderLabel: folder.label,
    size: entry.size,
    mtime: entry.mtime,
    hash: existing?.hash,
    status: 'pending',
  });

  try {
    _broadcast({ type: 'progress', path: entry.path, phase: 'hashing' });
    const hash = await _hashFile(entry.file);

    _broadcast({ type: 'progress', path: entry.path, phase: 'uploading' });
    const result = await retryCtx.retry(
      (attempt) => {
        if (attempt > 0) {
          _broadcast({ type: 'file-retry', path: entry.path, attempt });
        }
        return _uploadFile(
          client,
          { ...entry, hash },
          {
            prefix: config.prefix,
            onProgress: (uploaded, total) =>
              _broadcast({
                type: 'progress',
                path: entry.path,
                phase: 'uploading',
                uploaded,
                total,
              }),
          },
        );
      },
      {
        ...retryCtx.retryOpts,
        isTransient: retryCtx.isTransient,
        onRetry: (err, attempt, delayMs) => {
          _broadcast({
            type: 'file-retry-scheduled',
            path: entry.path,
            attempt: attempt + 1,
            delayMs,
            error: err?.message ?? String(err),
          });
        },
      },
    );

    await _db.put('sync_index', {
      path: entry.path,
      folderId: folder.id,
      folderLabel: folder.label,
      size: entry.size,
      mtime: entry.mtime,
      hash,
      status: 'uploaded',
      uploadedAt: Date.now(),
    });
    _broadcast({
      type: 'file-uploaded',
      path: entry.path,
      hash,
      key: `${config.prefix}/media/${hash}`,
      skipped: result.skipped,
    });
  } catch (err) {
    await _db.put('sync_index', {
      path: entry.path,
      folderId: folder.id,
      folderLabel: folder.label,
      size: entry.size,
      mtime: entry.mtime,
      status: 'errored',
      error: err?.message ?? String(err),
    });
    _broadcast({
      type: 'file-error',
      path: entry.path,
      error: err?.message ?? String(err),
    });
  }
}

// postMessage glue — runs only inside a Web Worker context (has `self`,
// no `window`). Plain module imports in tests skip this branch.
if (
  typeof self !== 'undefined' &&
  typeof self.addEventListener === 'function' &&
  typeof window === 'undefined'
) {
  self.addEventListener('message', async (e) => {
    const data = e.data ?? {};
    const { type } = data;
    if (type === 'start') {
      if (state !== 'idle') return;
      if (data.online === false) pauseLoop(defaultBroadcast);
      try {
        await runSync();
      } catch (err) {
        if (err?.message !== 'stopped') {
          defaultBroadcast({
            type: 'state',
            state: 'errored',
            reason: err?.message ?? String(err),
          });
        }
      }
    } else if (type === 'pause') {
      pauseLoop(defaultBroadcast);
    } else if (type === 'resume') {
      resumeLoop(defaultBroadcast);
    } else if (type === 'stop') {
      state = 'stopped';
      pauseGateResolve?.();
      defaultBroadcast({ type: 'state', state });
    } else if (type === 'retry') {
      const path = data.path;
      if (!path) return;
      const r = await db.get('sync_index', path);
      if (r) await db.put('sync_index', { ...r, status: 'pending' });
    }
  });
}
