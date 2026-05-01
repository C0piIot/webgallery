// Capture beforeinstallprompt → reveal #install-btn → on click,
// prompt the user to install the PWA. Idempotent across pages — each
// page bootstrap imports this for side effects.
//
// Window-level listeners + document-level click delegation make timing
// forgiving: they're attached once when the module loads (long before
// any DOMContentLoaded race) and respond when the matching ids appear.

let deferredPrompt = null;

function btn() {
  return document.getElementById('install-btn');
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  btn()?.classList.remove('d-none');
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  btn()?.classList.add('d-none');
});

document.addEventListener('click', async (e) => {
  if (e.target?.id !== 'install-btn') return;
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  try {
    await deferredPrompt.userChoice;
  } finally {
    deferredPrompt = null;
    btn()?.classList.add('d-none');
  }
});
