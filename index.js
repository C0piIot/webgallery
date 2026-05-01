// Bootstrap for index.html. Real behavior (Local sync_index render, Remote
// gallery, infinite scroll) lands in issues #17 and #18. For now, this only
// handles the Local/Remote tab toggle.

const TABS = ['local', 'remote'];

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
