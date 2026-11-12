// Starts the page: live updates from the server, then the first load.
// The dashboard's scripts are plain scripts loaded in order (see index.html), sharing one
// global scope: a file may use what an earlier one defines, and anything at all from inside
// functions that run later.

// Live updates: the server pings whenever a sync or edit changes the data. After the
// stream drops (a deploy restarts the server) anything missed is fetched on reconnecting.
// A stream the server refused (signed out) doesn't retry on its own: load() then finds out
// and sends you to sign in, and otherwise the stream is opened again a little later.
function listen() {
  const events = new EventSource('/api/events');
  let dropped = false;
  events.onopen = () => {
    if (dropped) load().catch(() => {});
    dropped = false;
  };
  events.onerror = () => {
    dropped = true;
    if (events.readyState !== EventSource.CLOSED) return;
    load().catch(() => {});
    setTimeout(listen, 10_000);
  };
  events.onmessage = e => {
    load().catch(() => {});
    if (e.data === 'reports' && view === 'reports') loadReports();
    if (view === 'developer') loadDeveloper();
    if (view === 'resume') loadResume();
  };
}
listen();
// Keep relative times ("synced 2m ago") fresh.
setInterval(renderGmail, 30_000);

load();
