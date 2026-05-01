// Capability detection and the standard explainer panel rendered on
// surfaces that need a capability we don't have. Today the only thing
// gated is File System Access; the architecture's per-surface table
// (docs/architecture.md → Capability and connectivity awareness) tells
// us which pages call this and which don't.
//
// Cached on first call so repeat callers don't re-probe globalThis.
// Tests can reset via _resetForTesting.

let cached;

export function hasFsa() {
  if (cached === undefined) {
    cached = typeof globalThis.showDirectoryPicker === 'function';
  }
  return cached;
}

export function _resetForTesting() {
  cached = undefined;
}

// Replaces the contents of `target` with the standard "FSA missing"
// alert. Bootstrap-only markup, zero custom CSS. Strings are static
// (no user content interpolated) so innerHTML is safe here.
export function renderFsaExplainer(target) {
  if (!target) return;
  const div = document.createElement('div');
  div.className = 'alert alert-info mb-0';
  div.setAttribute('role', 'alert');
  div.innerHTML = `
    <h5 class="alert-heading">Backup needs File System Access</h5>
    <p>
      This browser doesn't support the File System Access API, so the app
      can't read your local folders to back them up. The gallery still
      works &mdash; you can browse and view what's already in your bucket.
    </p>
    <hr>
    <p class="mb-0 small">
      Use Chrome 132+ on Android or desktop to enable backup.
    </p>
  `;
  target.replaceChildren(div);
}
