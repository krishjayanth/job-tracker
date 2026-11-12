// Which page is showing, from the address (#/settings and so on).
// The dashboard's scripts are plain scripts loaded in order (see index.html), sharing one
// global scope: a file may use what an earlier one defines, and anything at all from inside
// functions that run later.

let view = 'dashboard';
function route() {
  const id = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const soon = SOON[id];
  const page = ['reports', 'developer', 'settings', 'calendar', 'resume'].includes(id) ? id : null; // pages of their own
  const prev = view;
  if (view !== (soon ? id : page || 'dashboard') && $('#drawer').classList.contains('open')) closeDrawer(); // a new page, not the panel on top of it
  view = soon ? id : page || 'dashboard';
  $('#view-dashboard').hidden = view !== 'dashboard';
  $('#view-soon').hidden = !soon;
  $('#view-reports').hidden = page !== 'reports';
  $('#view-developer').hidden = page !== 'developer';
  $('#view-settings').hidden = page !== 'settings';
  $('#view-calendar').hidden = page !== 'calendar';
  $('#view-resume').hidden = page !== 'resume';
  if (soon) renderSoon(id);
  if (page === 'resume') loadResume();
  if (page === 'calendar') renderCalendar();
  if (page === 'reports') loadReports();
  if (page === 'developer') loadDeveloper();
  const current = soon || page ? id : id === 'applications' ? 'applications' : 'dashboard';
  document.querySelectorAll('.side-link').forEach(l => {
    if (l.dataset.view === current) l.setAttribute('aria-current', 'page'); else l.removeAttribute('aria-current');
  });
  closeNav();
  // Applications is the dashboard's table on its own: the summary and chart step aside.
  const appsOnly = id === 'applications';
  const wasAppsOnly = $('#view-dashboard').classList.contains('apps-only');
  $('#view-dashboard').classList.toggle('apps-only', appsOnly);
  if (view === 'dashboard' && (prev !== 'dashboard' || wasAppsOnly) && !appsOnly) renderSankey(); // its width was 0 while hidden
  window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', route);
