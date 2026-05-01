// Service Worker — app-shell cache.
//
// Bump VERSION whenever any precached asset changes. The new SW installs a
// fresh cache on next page load; the old one is evicted on activate. Clients
// pick up new files on the load after the SW activates. Per architecture:
// docs/architecture.md → Static bundle → Cache busting.

const VERSION = 'v18';
const CACHE = `webgallery-shell-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './setup-storage.html',
  './setup-folders.html',
  './index.js',
  './setup-storage.js',
  './setup-folders.js',
  './lib/register-sw.js',
  './lib/db.js',
  './lib/bucket.js',
  './lib/config.js',
  './lib/folders.js',
  './lib/capability.js',
  './lib/walker.js',
  './lib/hash.js',
  './lib/upload.js',
  './lib/connectivity.js',
  './lib/sync.js',
  './lib/sync-worker.js',
  './lib/retry.js',
  './lib/remote-list.js',
  './lib/install.js',
  './icons/icon.svg',
  './vendor/bootstrap.min.css',
  './vendor/aws4fetch.js',
  './vendor/noble-hashes/sha2.js',
  './vendor/noble-hashes/_md.js',
  './vendor/noble-hashes/_u64.js',
  './vendor/noble-hashes/utils.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('webgallery-shell-') && n !== CACHE)
        .map((n) => caches.delete(n)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cached = await caches.match(req);
    return cached || fetch(req);
  })());
});
