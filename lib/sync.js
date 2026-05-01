// Sync controller — main-page side. Owns the Worker that runs the
// actual sync loop (lib/sync-worker.js). Listens on a BroadcastChannel
// for the worker's status events and re-fans them to in-page
// subscribers. Bridges connectivity changes to pause/resume commands.
//
// Per docs/architecture.md → Sync trigger model: started by the main
// page when storage + folders are configured AND hasFsa() is true.
// The Local tab (#17) is the typical caller.

import { hasFsa } from './capability.js';
import { isOnline, onChange } from './connectivity.js';

const CHANNEL = 'webgallery:sync';

export function createSyncController({ workerUrl } = {}) {
  let worker = null;
  let channel = null;
  let unsubConnectivity = null;
  const typeListeners = new Map(); // type -> Set<cb>
  const allListeners = new Set();
  let started = false;

  function send(type, payload) {
    if (!worker) return;
    worker.postMessage({ type, ...(payload ?? {}) });
  }

  function emit(msg) {
    for (const cb of allListeners) {
      try { cb(msg); } catch { /* never block */ }
    }
    const set = typeListeners.get(msg.type);
    if (set) {
      for (const cb of set) {
        try { cb(msg); } catch { /* never block */ }
      }
    }
  }

  function start() {
    if (!hasFsa()) {
      throw new Error('FSA not available; cannot start sync');
    }
    if (started) return;
    started = true;

    const url = workerUrl ?? new URL('./sync-worker.js', import.meta.url);
    worker = new Worker(url, { type: 'module' });
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e) => emit(e.data);

    unsubConnectivity = onChange((online) => {
      send(online ? 'resume' : 'pause');
    });

    send('start', { online: isOnline() });
  }

  function stop() {
    if (!started) return;
    send('stop');
    worker?.terminate();
    worker = null;
    channel?.close();
    channel = null;
    unsubConnectivity?.();
    unsubConnectivity = null;
    started = false;
  }

  function pause() { send('pause'); }
  function resume() { send('resume'); }
  function retry(path) { send('retry', { path }); }

  // Kick off a fresh sync run. If the controller hasn't been started
  // yet, this does the full setup. If the worker is already idle from
  // a previous run, it just posts another 'start' — the worker accepts
  // that when state is 'idle' and ignores it otherwise.
  function rewalk() {
    if (!started) {
      start();
    } else {
      send('start', { online: isOnline() });
    }
  }

  function on(type, cb) {
    if (type === '*') {
      allListeners.add(cb);
      return () => allListeners.delete(cb);
    }
    if (!typeListeners.has(type)) typeListeners.set(type, new Set());
    const set = typeListeners.get(type);
    set.add(cb);
    return () => set.delete(cb);
  }

  return { start, stop, pause, resume, retry, rewalk, on };
}
