// Shared by every page: stage names, small helpers, loading the state and the API helper,
// and sending browser errors to the Developer page.
// The dashboard's scripts are plain scripts loaded in order (see index.html), sharing one
// global scope: a file may use what an earlier one defines, and anything at all from inside
// functions that run later.

const STAGE_LABEL = {
  applied: 'Applied', oa: 'Assessment', interview: 'Interview', offer: 'Offer',
  rejected: 'Rejected', withdrawn: 'Withdrawn', no_response: 'No response', in_progress: 'Ongoing',
};
// The tabs sort by where things stand now, so "Applied" there means "applied and not heard
// back yet", which reads as a count of everything you applied to. Its tab says what it is.
const TAB_LABEL = { ...STAGE_LABEL, applied: 'Awaiting reply' };
const TAB_TITLE = {
  applied: 'Applied, no reply yet',
  no_response: 'No reply for over three weeks',
};
const STATUS_ORDER = ['applied', 'oa', 'interview', 'offer', 'rejected', 'withdrawn'];
// The stage tabs: where each application stands now. "No response" is an application
// still at Applied that hasn't heard back, the same as the chart's "No response".
const TAB_ORDER = ['applied', 'oa', 'interview', 'offer', 'no_response', 'rejected', 'withdrawn'];
const tabOf = a => a.status === 'applied' && a.path?.at(-1) === 'no_response' ? 'no_response' : a.status;
const NODE_ORDER = ['applied', 'oa', 'interview', 'offer', 'in_progress', 'no_response', 'withdrawn', 'rejected'];
// Stages where the next move is usually yours.
const ACTION_STAGES = { oa: 'Assessment to complete', interview: 'Interview in progress', offer: 'Offer to respond to' };

const color = s => getComputedStyle(document.documentElement).getPropertyValue(`--${s}`).trim();

let state = { applications: [], gmail: {} };
let filter = 'all';
let flow = null; // a chart stage you clicked: only applications that went through it
let month = 'all'; // 'YYYY-MM' of the date applied
let query = '';
let only = null; // { label, ids }: a group picked on Resume insights (a resume version, a kind of role, a skill)
let visibleRows = []; // what the table currently shows, for export
let sort = { key: 'lastActivity', dir: 'desc' };
let seen = null; // id -> lastActivity, to highlight rows that change live

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const decoder = document.createElement('textarea');
const decode = s => { decoder.innerHTML = s ?? ''; return decoder.value; }; // Gmail snippets arrive HTML-escaped
// Only http(s) links become clickable: anything else (javascript:, data:) would run in the page.
const isWebLink = value => /^https?:\/\/[^\s]+$/i.test(value || '');
const icon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function timeAgo(iso) {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return shortDate(iso);
}
function shortDate(iso) {
  const d = new Date(iso);
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}
const monthKey = iso => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = key => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
};
const inMonth = a => month === 'all' || monthKey(a.appliedAt) === month;
// Local calendar date for <input type="date">.
const isoDate = iso => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// Local time of day for <input type="time">.
const isoTime = iso => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
// A deadline's time, like "5:00 PM", or '' when it's the end of the day (11:59 PM),
// which is what a date on its own means.
const dueTime = iso => {
  const d = new Date(iso);
  return d.getHours() === 23 && d.getMinutes() === 59 ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

const pill = s => `<span class="pill" style="--c:${color(s)}">${STAGE_LABEL[s]}</span>`;
const latestEvent = a => a.events.at(-1);

function statusSelect(a, extra = '') {
  return `<span class="status-select" style="--c:${color(a.status)}">
    <select data-status-for="${a.id}" aria-label="Status for ${esc(a.company)}" ${extra}>
      ${STATUS_ORDER.map(s => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${STAGE_LABEL[s]}</option>`).join('')}
    </select>${icon('chevron')}</span>`;
}

// ---------------------------------------------------------------- data
// Live updates can arrive in bursts, so loads never overlap: one asked for while another is
// running waits and runs once after it, and everyone waiting gets that newer state. An
// older answer can't land after a newer one and put stale data back on the page.
let loading = null, loadAgain = null;
function load() {
  if (loading) {
    loadAgain ??= loading.catch(() => {}).then(() => { loadAgain = null; return load(); });
    return loadAgain;
  }
  loading = (async () => {
    const res = await fetch('/api/state');
    if (res.status === 401) return location.assign('/login'); // signed out or session expired
    if (!res.ok) throw new Error(`Couldn't load your applications (${res.status})`);
    state = await res.json();
    render();
    rememberTimeZone();
  })().finally(() => { loading = null; });
  return loading;
}

// Tell the server this browser's time zone, so deadlines in emails are read as times where
// you are. Only when it's new or has changed (you travelled); a failure just tries next load.
function rememberTimeZone() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timeZone || state.demo || state.timeZone === timeZone) return;
  state.timeZone = timeZone;
  api('PUT', '/api/time-zone', { timeZone }).catch(() => { state.timeZone = null; });
}

class ApiError extends Error {}
async function api(method, url, body) {
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    noteError(`${method} ${url} → ${res.status} ${data.error || res.statusText}`);
    throw new ApiError(data.error || res.statusText);
  }
  return data;
}

// The last few things that went wrong in this tab, attached to problem reports.
const recentErrors = [];
function noteError(text) {
  recentErrors.push(`${new Date().toLocaleTimeString()} ${text}`);
  if (recentErrors.length > 10) recentErrors.shift();
}
// Crashes in the page also go to the owner's Developer page, once per message per visit.
const sentErrors = new Set();
function sendError(message, where) {
  if (!message || sentErrors.has(message) || sentErrors.size > 20) return;
  sentErrors.add(message);
  fetch('/api/client-errors', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, where, view: location.hash || '#/' }) }).catch(() => {});
}
window.addEventListener('error', e => {
  const where = `${(e.filename || '').split('/').pop()}:${e.lineno}`;
  noteError(`${e.message} (${where})`);
  sendError(e.message, where);
});
window.addEventListener('unhandledrejection', e => {
  const message = String(e.reason?.message || e.reason);
  noteError(`Unhandled: ${message}`);
  if (!(e.reason instanceof ApiError)) sendError(message, 'unhandled promise');
});

// Returns whether it saved. On failure the page reloads, which puts the old status back
// in the dropdown, and the message says why.
async function setStatus(id, status) {
  try {
    await api('PATCH', `/api/applications/${id}`, { status });
  } catch (err) {
    toast(`Couldn't change the status: ${err.message}`);
    await load().catch(() => {});
    return false;
  }
  await load().catch(() => {});
  return true;
}
