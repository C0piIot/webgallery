// Bootstrap for index.html. Real Local/Remote tab behavior lands in
// issues #17 and #18. For now this handles the tab toggle and the
// FSA-missing fallback for the Local tab (per docs/architecture.md →
// Capability and connectivity awareness).

import './lib/register-sw.js';
import { hasFsa, renderFsaExplainer } from './lib/capability.js';

const TABS = ['local', 'remote'];

if (!hasFsa()) {
  renderFsaExplainer(document.getElementById('pane-local'));
}

function showTab(name) {
  if (!TABS.includes(name)) name = 'local';
  for (const t of TABS) {
    document.getElementById(`tab-${t}`).classList.toggle('active', t === name);
    document.getElementById(`pane-${t}`).classList.toggle('active', t === name);
    document.getElementById(`pane-${t}`).classList.toggle('show', t === name);
  }
  const url = new URL(location.href);
  url.searchParams.set('tab', name);
  history.replaceState(null, '', url);
}

for (const t of TABS) {
  document.getElementById(`tab-${t}`).addEventListener('click', () => showTab(t));
}

showTab(new URL(location.href).searchParams.get('tab') || 'local');
