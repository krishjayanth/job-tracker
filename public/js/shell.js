// The frame around every page: sidebar, Sync button and theme.
// The dashboard's scripts are plain scripts loaded in order (see index.html), sharing one
// global scope: a file may use what an earlier one defines, and anything at all from inside
// functions that run later.

// Clicking the link you're on still takes you there (e.g. back up to the applications).
$('#sidebar').addEventListener('click', e => {
  const link = e.target.closest('a[href^="#/"]');
  if (link && link.getAttribute('href') === location.hash) route();
});

// On small screens the sidebar slides in over the page.
function openNav() {
  $('#sidebar').classList.add('open');
  $('#nav-scrim').hidden = false;
  $('#nav-toggle').setAttribute('aria-expanded', 'true');
}
function closeNav() {
  if (!$('#sidebar').classList.contains('open')) return;
  $('#sidebar').classList.remove('open');
  $('#nav-scrim').hidden = true;
  $('#nav-toggle').setAttribute('aria-expanded', 'false');
}
$('#nav-toggle').onclick = openNav;
$('#nav-scrim').onclick = closeNav;
route();

$('#sync-btn').onclick = async () => {
  const btn = $('#sync-btn');
  btn.disabled = true;
  btn.classList.add('spin');
  btn.querySelector('span').textContent = 'Syncing';
  try { await api('POST', '/api/sync'); } catch { /* shown via banner */ }
  btn.disabled = false;
  btn.classList.remove('spin');
  btn.querySelector('span').textContent = 'Sync';
  load();
};

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderSankey, 150); });
// Theme: Light, Dark or System (Settings → Appearance), kept on this device. The page head
// applies it before the first paint; colours come from CSS variables when things are drawn,
// so redraw whenever it changes.
const systemLight = matchMedia('(prefers-color-scheme: light)');
const themePick = () => { try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; } };
function applyTheme() {
  const pick = themePick();
  document.documentElement.dataset.theme = pick === 'system' ? (systemLight.matches ? 'light' : 'dark') : pick;
  document.querySelectorAll('input[name="theme"]').forEach(r => { r.checked = r.value === pick; });
  render();
}
document.querySelectorAll('input[name="theme"]').forEach(r => {
  r.checked = r.value === themePick();
  r.addEventListener('change', () => {
    try { r.value === 'system' ? localStorage.removeItem('theme') : localStorage.setItem('theme', r.value); } catch {}
    applyTheme();
  });
});
systemLight.addEventListener('change', () => { if (themePick() === 'system') applyTheme(); });
// Another open tab changed it.
addEventListener('storage', e => { if (e.key === 'theme') applyTheme(); });
