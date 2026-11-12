// Starts the page: live updates from the server, then the first load.
// The dashboard's scripts are plain scripts loaded in order (see index.html), sharing one
// global scope: a file may use what an earlier one defines, and anything at all from inside
// functions that run later.

// Live updates: the server pings whenever a sync or edit changes the data. After the
// stream drops (a deploy restarts the server) anything missed is fetched on reconnecting.
// A stream the server refused (signed out) doesn't retry on its own: load() then finds out
// and sends you to sign in, and otherwise the stream is opened again a little later.
//
// Each stream starts with a fingerprint of the dashboard's files. If it changes after a
// reconnect, a deploy brought new code: this page stops refreshing with its old code (which
// may not understand the new data) and asks to be reloaded.
let pageBuild = null; // the fingerprint this page was loaded with
let outdated = false; // newer code is live
function listen() {
  const events = new EventSource('/api/events');
  let dropped = false;
  events.addEventListener('build', e => {
    if (!pageBuild) pageBuild = e.data;
    else if (e.data !== pageBuild) return newVersion();
    if (dropped) load().catch(() => {});
    dropped = false;
  });
  events.onerror = () => {
    dropped = true;
    if (events.readyState !== EventSource.CLOSED || outdated) return;
    load().catch(() => {});
    setTimeout(listen, 10_000);
  };
  events.onmessage = e => {
    if (outdated) return;
    load().catch(() => {});
    if (e.data === 'reports' && view === 'reports') loadReports();
    if (view === 'developer') loadDeveloper();
    if (view === 'resume') loadResume();
  };
}
listen();

// A newer version of nuj is live. In a background tab nothing is lost by loading it now;
// otherwise a bar asks, so a half-typed note or open sheet isn't thrown away.
function newVersion() {
  if (outdated) return;
  outdated = true;
  const safeToReload = () => !document.querySelector('dialog[open]');
  if (document.hidden && safeToReload()) return location.reload();
  document.addEventListener('visibilitychange', () => { if (document.hidden && safeToReload()) location.reload(); });
  const bar = Object.assign(document.createElement('div'), { className: 'update-bar' });
  bar.setAttribute('role', 'status');
  bar.innerHTML = `${icon('refresh')}<span>nuj has been updated. Reload to keep going with the latest version.</span><button class="btn btn-sm btn-primary" type="button">Reload</button>`;
  bar.querySelector('button').addEventListener('click', () => location.reload());
  document.body.append(bar);
}
// Keep relative times ("synced 2m ago") fresh.
setInterval(renderGmail, 30_000);

load();
