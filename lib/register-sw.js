// Register the Service Worker. Imported as a side-effect from each page
// bootstrap. Safe to import multiple times — subsequent registrations of
// the same script are a no-op.

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => {
    console.warn('SW registration failed:', err);
  });
}
