// Online/offline awareness — a small helper around navigator.onLine
// + the `online` and `offline` window events.
//
// Lazy registration: nothing happens at module load; the listener is
// attached on the first onChange() call, so importing this module has
// zero side effects in tests / build steps.

let registered = false;
const subscribers = new Set();

function ensureRegistered() {
  if (registered) return;
  if (typeof globalThis.addEventListener !== 'function') return;
  registered = true;
  globalThis.addEventListener('online', () => notify(true));
  globalThis.addEventListener('offline', () => notify(false));
}

function notify(online) {
  for (const cb of subscribers) {
    try {
      cb(online);
    } catch {
      /* never block other subscribers on a single throw */
    }
  }
}

export function isOnline() {
  if (typeof navigator !== 'undefined' && 'onLine' in navigator) {
    return navigator.onLine;
  }
  return true;
}

export function onChange(cb) {
  ensureRegistered();
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function _resetForTesting() {
  registered = false;
  subscribers.clear();
}
