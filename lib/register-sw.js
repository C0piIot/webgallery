// Register the Service Worker. Imported as a side-effect from each page
// bootstrap. Safe to import multiple times — subsequent registrations of
// the same script are a no-op.
//
// Also wires the "update available — reload" banner: when the SW
// detects a newer sw.js (its content has changed), the new SW installs
// in the background and waits. We surface that with a small Bootstrap
// alert anchored to the bottom-right of the viewport. Click → reload →
// new SW activates naturally.

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => {
    console.warn('SW registration failed:', err);
  });
  setupUpdateBanner().catch(() => {
    /* best-effort */
  });
}

async function setupUpdateBanner() {
  const reg = await navigator.serviceWorker.ready;

  // Tab opened while an update was already waiting from a previous
  // session.
  if (reg.waiting && navigator.serviceWorker.controller) {
    showBanner();
    return;
  }

  reg.addEventListener('updatefound', () => {
    const installing = reg.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (
        installing.state === 'installed' &&
        navigator.serviceWorker.controller
      ) {
        showBanner();
      }
    });
  });
}

function showBanner() {
  if (document.getElementById('sw-update-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'sw-update-banner';
  banner.className =
    'alert alert-info position-fixed bottom-0 end-0 m-3 d-flex align-items-center gap-2 shadow';
  banner.setAttribute('role', 'status');
  banner.style.zIndex = '9999';

  const text = document.createElement('span');
  text.textContent = 'A new version is available.';
  banner.appendChild(text);

  const btn = document.createElement('button');
  btn.className = 'btn btn-sm btn-primary';
  btn.textContent = 'Reload';
  btn.addEventListener('click', () => location.reload());
  banner.appendChild(btn);

  document.body.appendChild(banner);
}
