const STAGE_LABEL = {
  applied: 'Applied', oa: 'Assessment', interview: 'Interview', offer: 'Offer',
  rejected: 'Rejected', withdrawn: 'Withdrawn', no_response: 'No response', in_progress: 'Waiting',
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
let visibleRows = []; // what the table currently shows, for export
let sort = { key: 'lastActivity', dir: 'desc' };
let seen = null; // id -> lastActivity, to highlight rows that change live

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const decoder = document.createElement('textarea');
const decode = s => { decoder.innerHTML = s ?? ''; return decoder.value; }; // Gmail snippets arrive HTML-escaped
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

const pill = s => `<span class="pill" style="--c:${color(s)}">${STAGE_LABEL[s]}</span>`;
const latestEvent = a => a.events.at(-1);

function statusSelect(a, extra = '') {
  return `<span class="status-select" style="--c:${color(a.status)}">
    <select data-status-for="${a.id}" aria-label="Status for ${esc(a.company)}" ${extra}>
      ${STATUS_ORDER.map(s => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${STAGE_LABEL[s]}</option>`).join('')}
    </select>${icon('chevron')}</span>`;
}

// ---------------------------------------------------------------- data
async function load() {
  const res = await fetch('/api/state');
  if (res.status === 401) return location.assign('/login'); // signed out or session expired
  state = await res.json();
  render();
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    noteError(`${method} ${url} → ${res.status} ${data.error || res.statusText}`);
    throw new Error(data.error || res.statusText);
  }
  return data;
}

// The last few things that went wrong in this tab, attached to problem reports.
const recentErrors = [];
function noteError(text) {
  recentErrors.push(`${new Date().toLocaleTimeString()} ${text}`);
  if (recentErrors.length > 10) recentErrors.shift();
}
window.addEventListener('error', e => noteError(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', e => noteError(`Unhandled: ${e.reason?.message || e.reason}`));

async function setStatus(id, status) {
  await api('PATCH', `/api/applications/${id}`, { status });
  await load();
}

// ---------------------------------------------------------------- render
function render() {
  renderGmail();
  renderSummary();
  renderSankey();
  renderActions();
  renderMonths();
  renderTabs();
  renderTable();
  if (openId) refreshDrawer();
}

function renderMonths() {
  const counts = new Map();
  for (const a of state.applications) {
    const k = monthKey(a.appliedAt);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  if (month !== 'all' && !counts.has(month)) month = 'all';
  const keys = [...counts.keys()].sort().reverse();
  $('#month').innerHTML = `<option value="all">All months</option>` +
    keys.map(k => `<option value="${k}" ${k === month ? 'selected' : ''}>${monthLabel(k)} · ${counts.get(k)}</option>`).join('');
  $('#month').value = month;
  $('#month').closest('.select-wrap').classList.toggle('active', month !== 'all');
}

function renderGmail() {
  const g = state.gmail;
  const el = $('#gmail-status');
  banners = [];
  if (!g.configured) {
    el.innerHTML = `<span class="dot off"></span> Gmail not set up`;
    addBanner(BANNER.setup, `<div class="banner">${icon('mail')}<div><strong>Connect Gmail to update automatically.</strong>
      Google sign-in isn't configured yet: set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>
      (or add <code>credentials.json</code> when running locally). docs/DEPLOY.md has the steps. You can still add applications by hand.</div></div>`);
  } else if (!g.connected) {
    el.innerHTML = `<span class="dot off"></span> <a href="/auth/google?gmail=1">Connect Gmail</a>`;
    if (g.lastSyncError) {
      addBanner(BANNER.error, `<div class="banner error">${icon('alert')}<div><strong>${esc(g.lastSyncError)}.</strong>
        <a href="/auth/google?gmail=1">Reconnect Gmail</a> to keep syncing.</div></div>`);
    }
  } else {
    const err = g.lastSyncError;
    const p = g.progress;
    const statusText = p
      ? `${p.mode === 'rescan' ? 'Re-scanning' : 'Syncing'} <span class="progress-text">${p.done} / ${p.total || '…'}</span>`
      : err ? 'Sync failed' : `Synced ${timeAgo(g.lastSync)}`;
    el.innerHTML = `<span class="dot ${err && !p ? 'err' : ''}"></span>
      <span>${statusText}</span>
      <span class="via">· ${esc(g.classifier)}</span>`;
    $('#rescan-btn').disabled = p?.mode === 'rescan';
    if (err) {
      const enableUrl = err.match(/https:\/\/console\.developers\.google\.com\/apis\/api\/gmail\.googleapis\.com\/\S+?(?=\s|$)/)?.[0];
      addBanner(BANNER.error, `<div class="banner error">${icon('alert')}<div>${enableUrl
        ? `<strong>The Gmail API isn't turned on for your Google Cloud project.</strong>
           <a href="${esc(enableUrl)}" target="_blank" rel="noopener">Turn it on</a>, wait a minute, then click Sync.`
        : `<strong>Gmail sync failed:</strong> ${esc(err.replace(/\.+$/, ''))}.
           If your sign-in expired, <a href="/auth/google?gmail=1">reconnect Gmail</a>.`}</div></div>`);
    }
  }
  $('#sync-btn').hidden = !g.connected;
  $('#rescan-btn').disabled = !g.connected || g.progress?.mode === 'rescan';
  $('#account').hidden = !state.user;
  $('#account-email').textContent = state.user || '';
  $('#side-user-row').hidden = !state.user;
  $('#side-user').textContent = state.user || '';
  $('#reports-link').hidden = !state.reports;
  // The badge counts everything waiting for you there: open reports and invite requests.
  $('#reports-count').textContent = (state.reports?.open || 0) + (state.reports?.requests || 0) || '';
  $('#delete-section').hidden = state.demo;
  renderSettings();
  renderProgress();
  renderSetup();
  renderWhatsNew();
  renderGroq();
  drawBanners();
}

// Banners stack, most important first: things that are broken, then what to do next,
// then tips. Tips only show when nothing more important is up, so they never bury an error.
const BANNER = { error: 0, setup: 1, tip: 2 };
let banners = [];
const addBanner = (priority, html) => banners.push({ priority, html });
function drawBanners() {
  const list = banners.sort((a, b) => a.priority - b.priority);
  const shown = list.some(b => b.priority < BANNER.tip) ? list.filter(b => b.priority < BANNER.tip) : list;
  $('#banner').innerHTML = shown.slice(0, 3).map(b => b.html).join('');
}

// The first sync and full re-scans can take minutes, so they get a card on the page
// with how far along they are; everyday syncs stay a line in the top bar.
function renderProgress() {
  const g = state.gmail;
  const p = g.progress;
  const el = $('#sync-progress');
  const big = p && (p.mode === 'rescan' || !g.lastSync);
  el.hidden = !big;
  if (!big) return;
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const found = state.applications.length;
  el.innerHTML = `
    <div class="sync-progress-head">
      <strong>${p.mode === 'rescan' ? 'Re-scanning your emails' : 'Reading your inbox for the first time'}</strong>
      <span class="num">${p.total ? `${p.done} of ${p.total} emails` : 'Finding application emails…'}</span>
    </div>
    <div class="progress-track" role="progressbar" aria-label="Emails read" aria-valuemin="0" aria-valuemax="${p.total || 0}" aria-valuenow="${p.done}">
      <span style="width:${p.total ? pct : 4}%"></span>
    </div>
    <p>${found ? `${found} ${found === 1 ? 'application' : 'applications'} found so far. They appear below as they're found.` : "Applications appear below as they're found."}
      You can leave this page; it carries on.</p>`;
}

// Settings: Gmail, AI sorting, ignored senders, help and account in one place.
function renderSettings() {
  const g = state.gmail;
  $('#set-gmail-status').innerHTML = !g.configured ? "Google sign-in isn't set up on this server, so Gmail can't be connected."
    : !g.connected ? 'Not connected. nuj only updates when you add applications by hand.'
    : `Connected (read-only). ${g.lastSyncError ? `Last sync failed: ${esc(g.lastSyncError)}.` : `Last synced ${timeAgo(g.lastSync)}.`} Checks for new emails every ${g.syncMinutes || 5} minutes.`;
  $('#set-gmail-actions').innerHTML = !g.configured ? ''
    : !g.connected ? `<a class="btn btn-primary" href="/auth/google?gmail=1">${icon('mail')}Connect Gmail</a>`
    : `<button class="btn" type="button" id="disconnect-btn">Disconnect</button>`;
  const blocked = state.blockedSenders || [];
  $('#blocked-empty').hidden = blocked.length > 0;
  $('#blocked-list').innerHTML = blocked.map(d =>
    `<li><span>${esc(d)}</span><button class="btn btn-sm btn-quiet" type="button" data-unblock="${esc(d)}">Read again</button></li>`).join('');
  // A dot on Settings when something there needs you.
  $('#settings-dot').hidden = !(g.lastSyncError || state.groq?.problem);
}

// After an update: what changed, once. Closing it in any way marks it as seen.
let whatsNewShown = false;
function renderWhatsNew() {
  const w = state.whatsNew;
  const dialog = $('#whats-new');
  if (!w || whatsNewShown || state.needsSetup || document.querySelector('dialog[open]')) return;
  whatsNewShown = true;
  $('#whats-new-title').textContent = w.title;
  $('#whats-new-rescan').hidden = !w.rescan;
  $('#whats-new-rescan').textContent = w.rescan || '';
  $('#whats-new-list').innerHTML = w.items.map(i => `<li><strong>${esc(i.title)}</strong><span>${esc(i.text)}</span></li>`).join('');
  dialog.showModal();
}
$('#whats-new').addEventListener('click', e => {
  if (e.target === e.currentTarget || e.target.closest('[data-close-dialog]')) e.currentTarget.close();
});
$('#whats-new').addEventListener('close', () => {
  state.whatsNew = null;
  api('POST', '/api/whats-new/seen').catch(() => {});
});

// First run: nothing is read until you choose a Groq key or the built-in rules.
let setupAsked = false;
function renderSetup() {
  const dialog = $('#setup-dialog');
  if (!state.needsSetup) {
    if (dialog.open) dialog.close();
    return;
  }
  addBanner(BANNER.setup, `<div class="banner">${icon('mail')}<div><strong>nuj hasn't read any email yet.</strong>
    Choose how it should sort your application emails to start tracking. <a href="#" data-open-setup>Choose now</a></div></div>`);
  const server = state.groq?.source === 'server' && !state.groq.problem;
  $('#setup-server').hidden = !server;
  $('#setup-key-form').hidden = server;
  $('#setup-get-key').hidden = server;
  $('#setup-days').textContent = state.gmail.initialDays || 90;
  // Ask once per visit; after that the banner brings it back.
  if (!setupAsked && !dialog.open) {
    setupAsked = true;
    dialog.showModal();
  }
}
const setupMsg = (text, tone = '') => { $('#setup-msg').className = `key-msg ${tone}`; $('#setup-msg').textContent = text; };
async function startTracking(how) {
  await api('POST', '/api/setup');
  $('#setup-dialog').close();
  toast(`Reading your inbox with ${how}. Applications appear as they're found`);
  load();
}
$('#banner').addEventListener('click', e => {
  if (!e.target.closest('[data-open-setup]')) return;
  e.preventDefault();
  $('#setup-dialog').showModal();
});
$('#setup-rules').onclick = async e => {
  e.target.disabled = true;
  try { await startTracking('the built-in rules'); } catch (err) { setupMsg(err.message, 'err'); }
  e.target.disabled = false;
};
$('#setup-use-server').onclick = async e => {
  e.target.disabled = true;
  try { await startTracking('AI sorting'); } catch (err) { setupMsg(err.message, 'err'); }
  e.target.disabled = false;
};
$('#setup-key-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#setup-key');
  const key = input.value.trim();
  if (!key) { setupMsg('Paste your Groq key, or start with the built-in rules.', 'err'); return input.focus(); }
  if (!key.startsWith('gsk_')) { setupMsg('Groq keys start with gsk_. Check it was copied in full.', 'err'); return input.focus(); }
  const btn = e.submitter || e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.classList.add('busy');
  setupMsg('Checking the key with Groq…');
  try {
    await api('PUT', '/api/groq-key', { key });
    input.value = '';
    await startTracking('AI sorting');
  } catch (err) {
    setupMsg(err.message, 'err');
    input.focus();
  }
  btn.disabled = false;
  btn.classList.remove('busy');
});

// Your Groq key: where it stands (sidebar, menu, settings sheet), and a banner when it needs you.
function renderGroq() {
  const k = state.groq;
  $('#groq-section').hidden = !k;
  if (!k) return;
  const ending = k.last4 ? ` ending in <strong>…${esc(k.last4)}</strong>` : '';
  // tone: on (AI is reading), off (built-in rules), err (needs you)
  const [tone, title, short, detail] =
    k.problem === 'unreadable' ? ['err', 'Your key needs adding again', 'Needs your key', `Your saved key${ending} can't be read any more because the server's secret changed. Paste it again below.`]
    : k.problem === 'rejected' ? ['err', 'Groq stopped accepting the key', 'Key rejected', `Groq refused ${k.source === 'own' ? `your key${ending}` : "this server's key"}, so emails are sorted by the built-in rules until you add a new one.`]
    : k.source === 'own' ? ['on', 'On, using your key', `Your key …${esc(k.last4 || '')}`, `Emails are read by Groq with your key${ending}. Paste a new one below to replace it.`]
    : k.source === 'server' ? ['on', "On, using this server's key", "Server's key", `Emails are read by Groq with this server's key. You can add your own instead.`]
    : ['off', 'Off, using built-in rules', 'Built-in rules', 'Add a free Groq key to have an AI read each email more carefully.'];
  $('#groq-state').dataset.tone = tone;
  $('#groq-state-title').textContent = title;
  $('#groq-status').innerHTML = detail;
  $('#groq-menu-title').innerHTML = `<i class="dot ${tone}"></i>${esc(title)}`;
  $('#groq-menu-status').innerHTML = detail;
  $('#groq-menu-btn').lastChild.textContent = k.source === 'own' || k.problem ? 'Manage key' : 'Add a key';
  $('#groq-key').placeholder = k.source === 'own' ? 'Paste a new key to replace it' : 'gsk_…';
  $('#groq-form button[type="submit"]').textContent = k.source === 'own' && !k.problem ? 'Replace key' : 'Save key';
  $('#groq-remove').hidden = k.source !== 'own';

  if (k.problem) {
    addBanner(BANNER.error, `<div class="banner error">${icon('alert')}<div><strong>${k.problem === 'unreadable' ? "Your Groq key needs adding again." : 'Groq stopped accepting your API key.'}</strong>
      Emails are sorted by the built-in rules for now. <a href="#" data-open-groq>Add a new key</a></div></div>`);
  } else if (!k.source && state.gmail.connected && !state.needsSetup && !dismissed('groq-hint')) {
    addBanner(BANNER.tip, `<div class="banner">${icon('alert')}<div><strong>Sort emails more accurately with Groq.</strong>
      nuj is using its built-in rules. With a free Groq API key, an AI reads each email to work out the company, job and stage.
      <a href="#" data-open-groq>Add a key</a> · <a href="#" data-dismiss="groq-hint">Not now</a></div></div>`);
  }
}

const dismissed = name => { try { return localStorage.getItem(`dismissed:${name}`) === '1'; } catch { return false; } };
$('#banner').addEventListener('click', e => {
  if (e.target.closest('[data-open-groq]')) {
    e.preventDefault();
    openGroq();
  }
  const dismiss = e.target.closest('[data-dismiss]');
  if (dismiss) {
    e.preventDefault();
    try { localStorage.setItem(`dismissed:${dismiss.dataset.dismiss}`, '1'); } catch {}
    dismiss.closest('.banner')?.remove();
  }
});

// How to show a deadline. A passed deadline stays until you mark it done (or a later
// email moves things on): "Overdue" for two weeks, then "Missed", sorted after the rest.
function dueInfo(deadline) {
  if (!deadline) return null;
  const ms = Date.parse(deadline) - Date.now();
  const days = Math.ceil(ms / 86_400_000);
  if (ms < 0) {
    const late = Math.floor(-ms / 86_400_000);
    if (late >= 14) return { level: 'missed', text: `Missed · ${shortDate(deadline)}` };
    return { level: 'overdue', text: late ? `Overdue by ${late} ${late === 1 ? 'day' : 'days'}` : 'Overdue' };
  }
  const end = new Date(deadline);
  const today = new Date();
  const sameDay = end.toDateString() === today.toDateString();
  const tomorrow = new Date(today.getTime() + 86_400_000).toDateString() === end.toDateString();
  if (sameDay) return { level: 'urgent', text: `Due today${end.getHours() < 23 ? `, ${end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}` };
  if (tomorrow) return { level: 'urgent', text: 'Due tomorrow' };
  if (days <= 4) return { level: 'soon', text: `Due in ${days} days` };
  return { level: 'later', text: `Due ${shortDate(deadline)}` };
}
const dueChip = deadline => {
  const d = dueInfo(deadline);
  return d ? `<span class="due ${d.level}">${icon('clock')}${d.text}</span>` : '';
};

// When an application first reached any of these stages, from the company's own emails.
const firstReached = (a, stages) => a.events.find(e => !e.manual && stages.includes(e.stage))?.date;

function renderSummary() {
  const apps = state.applications;
  const line = $('#summary-line');
  const kpis = $('#kpis');
  line.hidden = apps.length > 0;
  kpis.hidden = !apps.length;
  $('#since').textContent = apps.length ? `Tracking since ${shortDate(apps.map(a => a.appliedAt).sort()[0])}` : '';
  if (!apps.length) {
    line.textContent = state.gmail.connected
      ? 'No applications found yet. New application emails will appear here automatically.'
      : 'Add your first application, or connect Gmail to fill this in automatically.';
    return;
  }

  // "This month" is the calendar month, so the numbers match the month filter below.
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const thisMonth = iso => Boolean(iso) && iso >= monthStart;
  const heardBack = ['oa', 'interview', 'offer', 'rejected', 'withdrawn'];

  const heard = apps.filter(a => a.status !== 'applied' || a.events.some(e => e.stage !== 'applied')).length;
  const active = apps.filter(a => !['offer', 'rejected', 'withdrawn'].includes(a.status)).length;
  const reachedInterview = apps.filter(a => a.path.includes('interview') || a.status === 'offer').length;
  const offers = apps.filter(a => a.status === 'offer').length;
  $('#since').textContent += ` · ${active} still open`;

  // Each step: how many got there, and what share of all applications that is.
  const share = n => `${Math.round((n / apps.length) * 100)}%`;
  const newThisMonth = n => n ? `+${n} this month` : 'None this month';
  const steps = [
    ['Applied', apps.length, 'var(--applied)', newThisMonth(apps.filter(a => thisMonth(a.appliedAt)).length)],
    ['Heard back', heard, null, `${share(heard)} replied · ${newThisMonth(apps.filter(a => thisMonth(firstReached(a, heardBack))).length)}`],
    ['Interview', reachedInterview, 'var(--interview)', `${share(reachedInterview)} of applications`],
    ['Offer', offers, 'var(--offer)', offers ? `${share(offers)} of applications` : 'None yet'],
  ];
  kpis.innerHTML = steps.map(([label, value, c, sub]) => `
    <li>
      <span class="p-label"><i class="${c ? '' : 'hollow'}" style="${c ? `--c:${c}` : ''}"></i>${label}</span>
      <span class="p-value">${value}</span>
      <span class="p-sub">${sub}</span>
    </li>`).join('');
}

function renderSankey() {
  if (view !== 'dashboard') return; // drawn when you come back; a hidden chart has no width
  const apps = state.applications;
  $('#flow-caption').textContent = apps.length ? `Click a stage to filter · no reply after ${state.ghostDays} days counts as “No response”` : '';
  drawSankey($('#sankey'), apps, { large: false });
  if ($('#flow-dialog').open) drawSankey($('#sankey-large'), apps, { large: true });
}

function openFlowDialog() {
  if (!state.applications.length) return;
  const dialog = $('#flow-dialog');
  $('#flow-dialog-caption').textContent =
    `Click a stage to see those applications · no reply after ${state.ghostDays} days counts as “No response”`;
  dialog.showModal();
  drawSankey($('#sankey-large'), state.applications, { large: true });
}

// The small chart is a preview (click to enlarge); the large one is interactive.
// Where every stage and flow is on screen right now, even mid-glide. A redraw starts from
// here, so an update arriving straight after another carries on instead of snapping.
function liveLayout(el) {
  const svg = el.querySelector('svg');
  if (!svg || !el.layout) return el.layout;
  const nodes = new Map();
  const links = new Map();
  for (const g of svg.querySelectorAll('.node')) {
    const rect = g.querySelector('rect');
    const y = Number(rect.getAttribute('y'));
    nodes.set(g.__data__.id, { y0: y, y1: y + Number(rect.getAttribute('height')), x0: g.__data__.x0 });
  }
  for (const path of svg.querySelectorAll('.link')) {
    const d = path.__data__;
    links.set(`${d.source.id}>${d.target.id}`, { d: path.getAttribute('d'), w: Number(path.getAttribute('stroke-width')) });
  }
  return { width: el.layout.width, nodes, links };
}

function drawSankey(el, apps, { large }) {
  const prev = liveLayout(el);
  el.innerHTML = '';
  if (!apps.length) {
    el.innerHTML = `<div class="action-empty">Your application flow appears here once you have applications.</div>`;
    return;
  }

  const linkCounts = new Map();
  const nodeIds = new Set();
  for (const a of apps) {
    a.path.forEach(s => nodeIds.add(s));
    for (let i = 0; i < a.path.length - 1; i++) {
      const key = `${a.path[i]}>${a.path[i + 1]}`;
      linkCounts.set(key, (linkCounts.get(key) || 0) + 1);
    }
  }
  const nodes = [...nodeIds].map(id => ({ id }));
  const links = [...linkCounts].map(([k, value]) => {
    const [source, target] = k.split('>');
    return { source, target, value };
  });

  const pad = large ? 44 : 0; // .sankey-large's horizontal padding
  const width = el.clientWidth - pad;
  const height = large
    ? Math.max(380, Math.min(innerHeight - 170, 640))
    : Math.max(230, Math.min(400, 120 + nodes.length * 32));
  const narrow = width < 560;
  const labelSpace = large ? (narrow ? 130 : 200) : (narrow ? 118 : 150);
  const graph = d3.sankey()
    .nodeId(d => d.id)
    .nodeWidth(large ? 16 : 12)
    .nodePadding(large ? 30 : 20)
    .nodeSort((a, b) => NODE_ORDER.indexOf(a.id) - NODE_ORDER.indexOf(b.id))
    .extent([[1, narrow ? 26 : 6], [width - labelSpace, height - 6]])({ nodes: nodes.map(d => ({ ...d })), links: links.map(d => ({ ...d })) });

  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('height', height)
    .attr('role', 'img').attr('aria-label', 'Flow of applications between stages');
  const defs = svg.append('defs');

  // A hairline gap between neighbouring flows keeps them reading as separate strands.
  const strokeWidth = d => Math.max(1.2, d.width - (large ? 2 : 1.5));
  const linkPath = d3.sankeyLinkHorizontal();
  const linkKey = d => `${d.source.id}>${d.target.id}`;
  const link = svg.append('g').selectAll('path').data(graph.links).join('path')
    .attr('class', 'link')
    .attr('d', linkPath)
    // Flows are a neutral wash (CSS); a flow shows its stages' colours when picked out.
    .each((d, i) => {
      const id = `grad-${large ? 'l' : 's'}-${i}`;
      const g = defs.append('linearGradient').attr('id', id).attr('gradientUnits', 'userSpaceOnUse')
        .attr('x1', d.source.x1).attr('x2', d.target.x0);
      g.append('stop').attr('offset', '0%').attr('stop-color', color(d.source.id));
      g.append('stop').attr('offset', '100%').attr('stop-color', color(d.target.id));
      d.paint = `url(#${id})`;
    })
    .attr('stroke-width', strokeWidth);

  const total = apps.length;
  const node = svg.append('g').selectAll('g').data(graph.nodes).join('g').attr('class', 'node');
  // Click a stage, on either chart, to see those applications in the table.
  node.attr('tabindex', 0)
    .attr('role', 'button')
    .attr('aria-label', d => `${STAGE_LABEL[d.id]}: ${d.value}. Show in table`)
    .on('click', (e, d) => filterByNode(d.id))
    .on('keydown', (e, d) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); filterByNode(d.id); } });
  node.append('rect')
    .attr('x', d => d.x0).attr('y', d => d.y0)
    .attr('width', d => d.x1 - d.x0).attr('height', d => Math.max(3, d.y1 - d.y0))
    .attr('rx', 3)
    .attr('fill', d => color(d.id));
  // On a narrow chart there's no room beside the middle columns, so their labels sit above the bar.
  const above = d => narrow && d.sourceLinks.length > 0;
  const label = node.append('text')
    .attr('class', d => `node-label${above(d) ? ' above' : ''}`)
    .attr('x', d => !above(d) ? d.x1 + 8 : d.depth === 0 ? d.x0 : (d.x0 + d.x1) / 2)
    .attr('y', d => above(d) ? d.y0 - 7 : (d.y0 + d.y1) / 2)
    .attr('text-anchor', d => !above(d) ? null : d.depth === 0 ? 'start' : 'middle')
    .attr('dy', d => above(d) ? 0 : '0.35em');
  label.append('tspan').text(d => STAGE_LABEL[d.id] + '  ');
  label.append('tspan').attr('class', 'node-count')
    .text(d => d.id === 'applied' || narrow ? d.value : `${d.value} · ${Math.round((d.value / total) * 100)}%`);

  // Hover: focus one stage or flow, and explain it.
  const tip = el.appendChild(Object.assign(document.createElement('div'), { className: 'flow-tip' }));
  tip.setAttribute('aria-hidden', 'true');
  const pct = (n, of) => `${Math.round((n / of) * 100)}%`;
  const nodeTip = d => {
    const from = d.targetLinks.map(l =>
      `<div class="tl">${l.value} from ${STAGE_LABEL[l.source.id]} · ${pct(l.value, l.source.value)} of them</div>`).join('');
    return `<div class="tt"><i style="--c:${color(d.id)}"></i>${STAGE_LABEL[d.id]}</div>
      <div class="tn"><strong>${d.value}</strong> ${d.value === 1 ? 'application' : 'applications'} · ${pct(d.value, total)} of all</div>
      ${from || '<div class="tl">Every application starts here</div>'}`;
  };
  const linkTip = l => `<div class="tt"><i style="--c:${color(l.target.id)}"></i>${STAGE_LABEL[l.source.id]} → ${STAGE_LABEL[l.target.id]}</div>
    <div class="tn"><strong>${l.value}</strong> ${l.value === 1 ? 'application' : 'applications'}</div>
    <div class="tl">${pct(l.value, l.source.value)} of ${STAGE_LABEL[l.source.id]} · ${pct(l.value, total)} of all</div>`;

  const highlight = (onLinks, onNodes) => {
    svg.classed('focusing', onLinks.length > 0 || onNodes.length > 0);
    link.classed('on', l => onLinks.includes(l)).style('stroke', l => onLinks.includes(l) ? l.paint : null);
    node.classed('on', n => onNodes.includes(n));
  };
  const nodeFocus = d => [[...d.sourceLinks, ...d.targetLinks],
    [d, ...d.sourceLinks.map(l => l.target), ...d.targetLinks.map(l => l.source)]];
  const picked = graph.nodes.find(n => n.id === flow);
  const rest = () => picked ? highlight(...nodeFocus(picked)) : highlight([], []);
  rest();
  const focus = (onLinks, onNodes, html, event) => {
    highlight(onLinks, onNodes);
    tip.innerHTML = html;
    moveTip(event);
    tip.classList.add('show');
  };
  const moveTip = event => {
    const box = el.getBoundingClientRect();
    let x = event.clientX - box.left + el.scrollLeft + 14;
    const y = event.clientY - box.top + el.scrollTop + 14;
    if (x + tip.offsetWidth > el.scrollWidth - 4) x -= tip.offsetWidth + 28;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };
  const blur = () => {
    rest();
    tip.classList.remove('show');
  };
  node.on('pointerenter', (e, d) => focus(...nodeFocus(d), nodeTip(d), e));
  link.on('pointerenter', (e, l) => focus([l], [l.source, l.target], linkTip(l), e));
  node.on('pointermove', moveTip);
  link.on('pointermove', moveTip);
  node.on('pointerleave', blur);
  link.on('pointerleave', blur);

  // Remember the layout this draw settles on (its width decides whether to glide next time).
  el.layout = {
    width,
    nodes: new Map(graph.nodes.map(d => [d.id, { y0: d.y0, y1: d.y1, x0: d.x0 }])),
    links: new Map(graph.links.map(d => [linkKey(d), { d: linkPath(d), w: strokeWidth(d) }])),
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // A live update: every stage and flow glides from where it was to where it is now, and
  // anything new fades in, so you see what changed instead of the chart being swapped.
  // A resize redraws as is: gliding while you drag a window edge only lags.
  if (el.dataset.drawn) {
    if (!prev || prev.width !== width) return;
    const glide = sel => sel.transition().duration(480).ease(d3.easeCubicOut);
    node.each(function (d) {
      const was = prev.nodes.get(d.id);
      const g = d3.select(this);
      if (!was) return void glide(g.style('opacity', 0)).style('opacity', 1);
      if (was.y0 === d.y0 && was.y1 === d.y1) return;
      glide(g.select('rect').attr('y', was.y0).attr('height', Math.max(3, was.y1 - was.y0)))
        .attr('y', d.y0).attr('height', Math.max(3, d.y1 - d.y0));
      const shift = (was.y0 + was.y1) / 2 - (d.y0 + d.y1) / 2;
      glide(g.select('text').attr('transform', `translate(0,${shift})`)).attr('transform', 'translate(0,0)');
    });
    link.each(function (d) {
      const was = prev.links.get(linkKey(d));
      const path = d3.select(this);
      if (!was) return void glide(path.style('opacity', 0)).style('opacity', 1);
      glide(path.attr('d', was.d).attr('stroke-width', was.w))
        .attr('d', linkPath(d)).attr('stroke-width', strokeWidth(d));
    });
    return;
  }

  // Draw the flows in once, the first time this chart appears.
  el.dataset.drawn = '1';
  const ease = 'cubic-bezier(.16, 1, .3, 1)';
  if (prev) return; // drawn before, just without the flourish (reduced motion was on)
  link.each(function (d) {
    const len = this.getTotalLength();
    this.style.strokeDasharray = `${len} ${len}`;
    this.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
      { duration: 900, delay: 120 + d.source.depth * 160, easing: ease, fill: 'backwards' })
      .finished.then(() => { this.style.strokeDasharray = ''; }, () => {});
  });
  node.each(function (d) {
    this.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, delay: d.depth * 160, easing: ease, fill: 'backwards' });
  });
}

// What a chart stage means as a filter: everything passed through Applied, so that one
// clears it; the middle stages are "reached"; the end stages are where they ended up.
const FLOW_LABEL = { oa: 'Reached assessment', interview: 'Reached interview', offer: 'Got an offer', in_progress: 'Waiting', no_response: 'No response', rejected: 'Rejected', withdrawn: 'Withdrawn' };
function filterByNode(id) {
  flow = id === 'applied' ? null : id;
  filter = 'all';
  month = 'all'; // the chart covers every month
  renderSankey();
  if ($('#flow-dialog').open) $('#flow-dialog').close();
  renderMonths();
  renderTabs();
  renderTable();
  $('#apps-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Only things you can clear: an open deadline (mark it done) or an email nuj wasn't sure
// about (say it's right, or fix it). An interview with no date isn't a to-do until it has one.
const needsAction = a => Boolean(dueInfo(a.deadline) || a.needsReview);

function renderActions() {
  // Deadlines first, soonest at the top; then emails to check, newest first.
  const items = state.applications
    .filter(needsAction)
    .sort((a, b) => {
      // Missed deadlines go last: still there to clear, but not ahead of what's coming up.
      const missed = x => dueInfo(x.deadline)?.level === 'missed';
      if (missed(a) !== missed(b)) return missed(a) ? 1 : -1;
      const da = dueInfo(a.deadline) ? a.deadline : null, db = dueInfo(b.deadline) ? b.deadline : null;
      if (da && db) return da.localeCompare(db);
      if (da || db) return da ? -1 : 1;
      return b.lastActivity.localeCompare(a.lastActivity);
    });
  $('#action-count').textContent = items.length || '';
  $('#action-list').innerHTML = items.length
    ? items.map(a => {
      const due = dueInfo(a.deadline);
      // Warm when it's due within a day.
      const tone = due && (due.level === 'urgent' || due.level === 'overdue') ? 'urgent' : '';
      const why = due ? ACTION_STAGES[a.status] || 'Next step to complete' : 'An email here needs a quick check: is it filed correctly?';
      return `
      <li class="action-row ${tone}" data-row="${a.id}"><div class="action-item" data-open="${a.id}" role="button" tabindex="0">
        <span class="what">
          <span class="co">${esc(a.company)}</span>
          <span class="why" style="display:block">${why}${a.role ? ` · ${esc(a.role)}` : ''}</span>
        </span>
        <span class="action-side">
          ${due
            ? `${dueChip(a.deadline)}<button class="done-btn" type="button" data-done="${a.id}" title="Mark this deadline as done">${icon('check')}Done</button>`
            : `<span class="check-chip">Check filing</span><button class="done-btn" type="button" data-looks-right="${a.id}" title="Its emails are filed under the right application">${icon('check')}Yes, it's right</button>`}
        </span>
      </div></li>`;
    }).join('')
    : `<li class="action-empty"><strong>You're all caught up.</strong>Deadlines from assessment and interview emails show up here, along with any email nuj wasn't sure how to file. Add a deadline to an application to track it here.</li>`;
}

// A short note at the bottom of the screen, with Undo for things you can take back.
let toastTimer;
function toast(text, undo) {
  let el = $('#toast');
  if (!el) {
    el = Object.assign(document.createElement('div'), { id: 'toast', className: 'toast' });
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  // With Undo, a bar along the bottom runs down over UNDO_SHOW_MS: when it's empty, Undo is gone.
  el.innerHTML = `${icon('check')}<span>${esc(text)}</span>${undo
    ? `<button type="button" data-undo>Undo</button><i class="toast-timer" style="animation-duration:${UNDO_SHOW_MS}ms" aria-hidden="true"></i>`
    : ''}`;
  el.querySelector('[data-undo]')?.addEventListener('click', async () => {
    el.classList.remove('show');
    await undo();
    load();
  }, { once: true });
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), undo ? UNDO_SHOW_MS : 4500);
}
const UNDO_SHOW_MS = 5000;

// Everything except the stage tab: month, search and chart stage. Tab counts use it,
// so a tab's number is how many you'd see by clicking it.
const inView = a => inMonth(a) && matchesQuery(a) && (!flow || a.path.includes(flow));

function renderTabs() {
  const counts = Object.fromEntries(TAB_ORDER.map(s => [s, 0]));
  const scoped = state.applications.filter(inView);
  scoped.forEach(a => counts[tabOf(a)]++);
  const total = scoped.length;
  const tabs = [['all', 'All', total, 'accent'], ...TAB_ORDER.map(s => [s, STAGE_LABEL[s], counts[s], s])];
  // The underline is one element that stays put across renders, so it can slide.
  const strip = $('#stage-tabs');
  strip.querySelectorAll('.tab').forEach(t => t.remove());
  strip.insertAdjacentHTML('afterbegin', tabs.map(([id, label, n]) => `
    <button class="tab ${n === 0 && id !== 'all' ? 'zero' : ''}" role="tab" aria-selected="${filter === id}" data-filter="${id}" type="button">
      ${label}<span class="n">${n}</span>
    </button>`).join(''));
  moveTabIndicator();
  const bar = $('#stage-bar');
  bar.classList.toggle('filtered', filter !== 'all');
  bar.innerHTML = TAB_ORDER.filter(s => counts[s]).map(s =>
    `<span class="${filter === s ? 'on' : ''}" style="--c:${color(s)};flex-grow:${counts[s]}" title="${STAGE_LABEL[s]}: ${counts[s]}"></span>`).join('');
}

// Slide the underline to the selected tab, from wherever it is now (a click mid-slide
// redirects it). It jumps instead on first placement and resizes, and during a View
// Transition, which moves it itself.
function moveTabIndicator({ instant = false } = {}) {
  const line = $('#tab-indicator');
  const tab = $('#stage-tabs .tab[aria-selected="true"]');
  if (!tab) return;
  const jump = instant || !line.dataset.placed || document.documentElement.classList.contains('vt');
  if (jump) line.classList.add('instant');
  line.style.transform = `translateX(${tab.offsetLeft}px) scaleX(${tab.offsetWidth})`;
  line.dataset.placed = '1';
  if (jump) { void line.offsetWidth; line.classList.remove('instant'); }
}
new ResizeObserver(() => moveTabIndicator({ instant: true })).observe($('#stage-tabs'));
document.fonts?.ready.then(() => moveTabIndicator({ instant: true }));

// Filtering the table: rows that stay slide to their new places, new ones fade in, the
// rest of the page holds still (View Transitions). Instant where unsupported or when
// reduced motion is on.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
function withTransition(update) {
  if (!document.startViewTransition || reduceMotion.matches) return update();
  const root = document.documentElement;
  root.classList.add('vt');
  document.startViewTransition(update).finished.finally(() => root.classList.remove('vt'));
}
const MAX_ROWS_TO_MOVE = 150; // past this, rows cross-fade as a block rather than one by one

function sortValue(a, key) {
  if (key === 'status') return STATUS_ORDER.indexOf(a.status);
  if (key === 'company') return a.company.toLowerCase();
  return a[key] || '';
}

// Search: every word has to appear somewhere in the application (company, role, ID, notes or an email subject).
const searchText = a => [a.company, a.role, a.jobId, a.notes, ...a.events.map(e => decode(e.subject))].join('\n').toLowerCase();
const queryWords = () => query.trim().toLowerCase().split(/\s+/).filter(Boolean);
const matchesQuery = a => {
  const words = queryWords();
  if (!words.length) return true;
  const text = searchText(a);
  return words.every(w => text.includes(w));
};
// Escape, then mark where the search words appear.
function hl(text) {
  const t = String(text ?? '');
  const words = queryWords();
  if (!words.length) return esc(t);
  const lower = t.toLowerCase();
  const hit = new Array(t.length).fill(false);
  for (const w of words) for (let i = lower.indexOf(w); i !== -1; i = lower.indexOf(w, i + 1)) hit.fill(true, i, i + w.length);
  let out = '', i = 0;
  while (i < t.length) {
    let j = i;
    while (j < t.length && hit[j] === hit[i]) j++;
    out += hit[i] ? `<mark>${esc(t.slice(i, j))}</mark>` : esc(t.slice(i, j));
    i = j;
  }
  return out;
}
// When the match is only in the notes, show the bit of notes that matched.
function notesMatch(a, words) {
  const notes = a.notes || '';
  if (!words.length || !words.some(w => notes.toLowerCase().includes(w))) return '';
  if ([a.company, a.role, a.jobId].join(' ').toLowerCase().includes(words[0])) return '';
  const at = Math.max(0, notes.toLowerCase().indexOf(words.find(w => notes.toLowerCase().includes(w))) - 24);
  return `<div class="match-note">Notes: ${at ? '…' : ''}${hl(notes.slice(at, at + 90))}${notes.length > at + 90 ? '…' : ''}</div>`;
}

function renderFilterChips(shown, total) {
  const chips = [];
  if (query.trim()) chips.push(['query', `“${esc(query.trim())}”`]);
  if (flow) chips.push(['flow', `<i class="dot" style="--c:${color(flow)}"></i>${FLOW_LABEL[flow] || STAGE_LABEL[flow]}`]);
  if (filter !== 'all') chips.push(['filter', `<i class="dot" style="--c:${color(filter)}"></i>${STAGE_LABEL[filter]}`]);
  if (month !== 'all') chips.push(['month', monthLabel(month)]);
  $('#results-line').textContent = !total ? '' : chips.length ? `${shown} of ${total}` : `${total}`;
  const el = $('#filter-chips');
  el.hidden = !chips.length;
  el.innerHTML = chips.map(([k, label]) =>
    `<span class="chip">${label}<button type="button" data-unfilter="${k}" aria-label="Remove this filter">${icon('x')}</button></span>`).join('') +
    (chips.length > 1 ? `<button class="chip-clear" type="button" data-unfilter="all">Clear all</button>` : '');
}
function setQuery(value) {
  query = value;
  $('#search').value = value;
  $('#search-clear').hidden = !value;
  renderTabs(); // their counts follow the search
  renderTable();
}

function renderTable() {
  const words = queryWords();
  const rows = state.applications
    .filter(inView)
    .filter(a => filter === 'all' || tabOf(a) === filter)
    .sort((a, b) => {
      const x = sortValue(a, sort.key), y = sortValue(b, sort.key);
      const cmp = x < y ? -1 : x > y ? 1 : 0;
      return sort.dir === 'asc' ? cmp : -cmp;
    });

  visibleRows = rows;
  $('#export-btn').disabled = rows.length === 0;
  const prev = seen;
  seen = new Map(state.applications.map(a => [a.id, a.lastActivity]));

  $('#rows').innerHTML = rows.map(a => {
    const last = latestEvent(a);
    const fresh = prev && prev.get(a.id) !== a.lastActivity;
    return `
    <tr data-id="${a.id}" tabindex="0" class="${fresh ? 'fresh' : ''}"${rows.length <= MAX_ROWS_TO_MOVE ? ` style="view-transition-name:r-${a.id}"` : ''}>
      <td>
        <div class="company">
          <div style="min-width:0"><div class="name">${hl(a.company)}${a.needsReview ? `<span class="check-chip" title="An email here may be filed under the wrong application">Check filing</span>` : ''}</div><div class="sub">${hl(a.role)}</div></div>
        </div>
      </td>
      <td class="col-role">
        <div class="role">${a.role ? hl(a.role) : '<span class="dim">No role found</span>'}</div>
        ${a.jobId ? `<div class="jobid">ID ${hl(a.jobId)}</div>` : ''}
        ${notesMatch(a, words)}
      </td>
      <td>${statusSelect(a)}${dueChip(a.deadline) ? `<div>${dueChip(a.deadline)}</div>` : ''}</td>
      <td class="col-applied date">${shortDate(a.appliedAt)}</td>
      <td class="col-latest latest">
        <div class="when">${timeAgo(a.lastActivity)}</div>
        ${last?.subject ? `<div class="what" title="${esc(decode(last.subject))}">${hl(decode(last.subject))}</div>` : ''}
      </td>
    </tr>`;
  }).join('');

  document.querySelectorAll('.sort').forEach(b => {
    b.classList.toggle('asc', b.dataset.sort === sort.key && sort.dir === 'asc');
    b.classList.toggle('desc', b.dataset.sort === sort.key && sort.dir === 'desc');
    b.closest('th').setAttribute('aria-sort', b.dataset.sort === sort.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });

  renderFilterChips(rows.length, state.applications.length);
  $('#side-count').textContent = state.applications.length || '';
  const q = query.trim();
  const empty = $('#empty');
  empty.hidden = rows.length > 0;
  if (!state.applications.length) {
    empty.innerHTML = `<strong>No applications yet</strong>
      ${state.gmail.connected ? 'Application emails from Gmail will appear here automatically.' : 'Connect Gmail, or add one by hand.'}
      <div><button class="btn btn-primary" type="button" data-add>${icon('plus')}Add application</button></div>`;
  } else {
    empty.innerHTML = `<strong>No matches</strong>${q ? `Nothing matches “${esc(q)}”` : 'No applications'}${filter !== 'all' ? ` in ${STAGE_LABEL[filter]}` : ''}${month !== 'all' ? ` applied in ${monthLabel(month)}` : ''}.
      ${q ? '<div class="empty-tip">Search looks through companies, roles, job IDs, your notes and email subjects.</div>' : ''}
      <div><button class="btn" type="button" data-clear>Clear filters</button></div>`;
  }
}

// ---------------------------------------------------------------- drawer
let openId = null;
let lastFocus = null;

const needsCheck = e => e.review?.length && !e.reviewed;

function timelineHtml(a) {
  return [...a.events].reverse().map(e => `
    <li style="--c:${color(e.stage)}">
      <span class="tdot"></span>
      <div class="thead">
        <span class="tstage">${STAGE_LABEL[e.stage]}${e.manual ? ' · set by you' : ''}${needsCheck(e) ? ' · <span class="tcheck">check filing</span>' : ''}</span>
        <span class="tdate">${new Date(e.date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
      </div>
      <div class="tsubject">${esc(decode(e.subject || STAGE_LABEL[e.stage]))}</div>
      ${e.summary ? `<div class="tsnippet">${esc(e.summary)}</div>` : e.snippet ? `<div class="tsnippet">${esc(decode(e.snippet))}</div>` : ''}
      ${!e.manual ? `<div class="tlinks">
        ${e.messageId ? `<a class="tlink" href="https://mail.google.com/mail/u/0/#all/${e.messageId}" target="_blank" rel="noopener">Open in Gmail ${icon('external')}</a>` : ''}
        <button class="tlink" type="button" data-fix="${e.id}">${needsCheck(e) ? 'Check filing' : 'Filed correctly?'}</button>
      </div>${filerHtml(a, e)}`
      : a.events.length > 1 ? `<div class="tlinks"><button class="tlink" type="button" data-remove-event="${e.id}" title="Remove this change; the emails decide the status again">${icon('trash')}Remove</button></div>` : ''}
    </li>`).join('');
}

// "Filed correctly?" One flow everywhere an email might be in the wrong place, with the
// same answers: Yes, it's right / Move it / New application / Not a job. Hidden until you open it.
function filerHtml(a, e) {
  const others = state.applications
    .filter(x => x.id !== a.id)
    .sort((x, y) => x.company.localeCompare(y.company) || (x.role || '').localeCompare(y.role || ''));
  // Splitting off: the other emails here can go along. Later ones start ticked, since a
  // second application usually begins with its own "thanks for applying".
  const siblings = a.events.filter(x => x !== e && !x.manual).sort((x, y) => y.date.localeCompare(x.date));
  return `
    <div class="filer" data-filer="${e.id}" hidden>
      <div class="filer-q">Is this email filed under the right application?</div>
      <div class="filer-choices" role="group" aria-label="Filed correctly?">
        <button class="btn btn-sm" type="button" data-confirm="${e.id}">${icon('check')}Yes, it's right</button>
        <button class="btn btn-sm" type="button" data-filer-show="move" aria-expanded="false">Move it</button>
        <button class="btn btn-sm" type="button" data-filer-show="split" aria-expanded="false">New application</button>
        <button class="btn btn-sm" type="button" data-filer-show="notjob" aria-expanded="false">Not a job</button>
      </div>
      <div class="filer-pane" data-pane="move" hidden>
        <div class="field"><label for="move-${e.id}">Move it to</label>
          <select id="move-${e.id}" data-move-to>
            <option value="">Choose an application…</option>
            ${others.map(x => `<option value="${x.id}">${esc(x.company)}${x.role ? ` · ${esc(x.role)}` : ''}${x.jobId ? ` (${esc(x.jobId)})` : ''}</option>`).join('')}
            <option value="new">A new application…</option>
          </select>
        </div>
        <div class="filer-actions"><button class="btn btn-primary btn-sm" type="button" data-move="${e.id}" disabled>Move email</button></div>
      </div>
      <div class="filer-pane" data-pane="split" hidden>
        <p class="filer-note">Applied more than once, or a different job? Split this email off into an application of its own. Its stage comes from the emails it takes.</p>
        <div class="fields">
          <div class="field"><label for="new-co-${e.id}">Company</label><input id="new-co-${e.id}" data-new="company" value="${esc(a.company)}" placeholder="e.g. Stripe"></div>
          <div class="field"><label for="new-role-${e.id}">Role</label><input id="new-role-${e.id}" data-new="role" value="${esc(a.role || '')}" placeholder="Optional"></div>
        </div>
        ${siblings.length ? `<fieldset class="split-also">
          <legend>Also move</legend>
          ${siblings.map(x => `<label class="check-row"><input type="checkbox" data-also="${x.id}"${x.date > e.date ? ' checked' : ''}>
            <span><strong>${esc(decode(x.subject || STAGE_LABEL[x.stage]))}</strong>
            <small>${STAGE_LABEL[x.stage]} · ${shortDate(x.date)}</small></span></label>`).join('')}
        </fieldset>` : ''}
        <div class="filer-actions"><button class="btn btn-primary btn-sm" type="button" data-split="${e.id}">Split into new application</button></div>
      </div>
      <div class="filer-pane" data-pane="notjob" hidden>
        <p class="filer-note">The email is removed from ${esc(a.company)} and won't be added again.</p>
        ${e.blockable ? `<label class="check-row"><input type="checkbox" data-also-block="${esc(e.blockable)}">
          <span><strong>Also ignore everything from ${esc(e.blockable)}</strong>
          <small>For senders that never send job emails, like a landlord or a utility. Removes their other emails too.</small></span></label>` : ''}
        <div class="filer-actions"><button class="btn btn-primary btn-sm" type="button" data-ignore="${e.id}">Remove email</button></div>
      </div>
    </div>`;
}

// Emails sorting wasn't sure about: why, and the same three answers.
function reviewHtml(a) {
  const flagged = a.events.filter(needsCheck).reverse();
  if (!flagged.length) return '';
  return `
    <div class="review-card">
      <div class="review-head">${icon('alert')}Check filing</div>
      ${flagged.map(e => `
        <div class="review-item">
          <div class="tsubject">${esc(decode(e.subject))}</div>
          ${e.summary ? `<div class="review-summary">${esc(e.summary)}</div>` : ''}
          <ul class="review-reasons">${e.review.map(r => `<li>${esc(r.text)}</li>`).join('')}</ul>
          ${e.reasoning ? `<details class="review-why"><summary>How the email was read</summary><p>${esc(e.reasoning)}</p></details>` : ''}
          <div class="filer-actions">
            <button class="btn btn-sm" type="button" data-confirm="${e.id}">${icon('check')}Yes, it's right</button>
            <button class="btn btn-sm btn-quiet" type="button" data-fix="${e.id}" data-show="move">Move it</button>
            <button class="btn btn-sm btn-quiet" type="button" data-fix="${e.id}" data-show="split">New application</button>
            <button class="btn btn-sm btn-quiet" type="button" data-fix="${e.id}" data-show="notjob">Not a job</button>
          </div>
        </div>`).join('')}
    </div>`;
}

async function assignEmail(eventId, body) {
  const fromId = openId;
  const { app: to, undo } = await api('POST', `/api/emails/${eventId}/assign`, body);
  await load();
  // Stay on this application if it's still here; otherwise follow the email.
  const next = state.applications.find(x => x.id === fromId) || state.applications.find(x => x.id === to?.id);
  if (next) openDrawer(next); else closeDrawer();
  return { undo, fromId };
}

// A message with Undo for something the server can put back (see /api/undo). Undoing
// reopens the application it happened to, so you see it's back.
function undoToast(text, token, reopenId) {
  toast(text, token && (async () => {
    await api('POST', `/api/undo/${token}`);
    await load();
    const a = reopenId && state.applications.find(x => x.id === reopenId);
    if (a) openDrawer(a);
  }));
}

// Live updates refresh what the panel shows about the application, but never the
// fields you might be typing in, or a "Filed correctly?" answer you're halfway through.
function refreshDrawer() {
  const a = state.applications.find(x => x.id === openId);
  if (!a || $('#drawer .filer:not([hidden])')) return;
  $('#drawer .drawer-head').innerHTML = drawerHeadHtml(a);
  $('#drawer .review-slot').innerHTML = reviewHtml(a);
  $('#drawer .timeline').innerHTML = timelineHtml(a);
}

function drawerHeadHtml(a) {
  return `
    <div class="drawer-title">
      <div class="t">
        <h2 id="drawer-title">${esc(a.company)}</h2>
        <div class="s">${esc(a.role) || 'No role found'}</div>
      </div>
      <button class="icon-btn" data-close type="button" aria-label="Close">${icon('x')}</button>
    </div>
    <div class="drawer-meta">
      ${statusSelect(a)}
      ${dueChip(a.deadline)}
      <span>Applied ${shortDate(a.appliedAt)}</span>
      ${a.jobId ? `<span class="num">ID ${esc(a.jobId)}</span>` : ''}
      ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${icon('link')}Job posting</a>` : ''}
    </div>`;
}

function detailFieldsHtml(a, isNew) {
  const status = `<div class="field"><label for="f-status">Status</label>
    <select id="f-status" name="status">${STATUS_ORDER.map(s => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${STAGE_LABEL[s]}</option>`).join('')}</select></div>`;
  return `
    <div class="fields">
      <div class="field"><label for="f-company">Company</label><input id="f-company" name="company" required value="${esc(a.company)}" placeholder="e.g. Stripe" autocomplete="off"></div>
      ${isNew ? status : `<div class="field"><label for="f-jobid">Job ID</label><input id="f-jobid" name="jobId" value="${esc(a.jobId)}" placeholder="e.g. R-574294" autocomplete="off"></div>`}
      <div class="field wide"><label for="f-role">Role</label><input id="f-role" name="role" value="${esc(a.role)}" placeholder="e.g. Software Engineer Intern" autocomplete="off"></div>
      ${isNew ? `<div class="field"><label for="f-jobid">Job ID</label><input id="f-jobid" name="jobId" value="" placeholder="e.g. R-574294" autocomplete="off"></div>` : ''}
      <div class="field${isNew ? '' : ' wide'}"><label for="f-url">Job posting link</label><input id="f-url" name="url" type="url" value="${esc(a.url)}" placeholder="https://" autocomplete="off"></div>
      ${isNew ? '' : `<div class="field wide"><label for="f-deadline">Deadline</label>
        <div class="deadline-field">
          <input id="f-deadline" name="deadline" type="date" value="${a.deadline ? isoDate(a.deadline) : ''}">
          ${a.deadline ? `<button class="btn" type="button" id="deadline-done">${icon('check')}Mark done</button>` : ''}
        </div></div>`}
      <div class="field wide"><label for="f-notes">Notes</label><textarea id="f-notes" name="notes" placeholder="Referral, recruiter name, salary range…">${esc(a.notes)}</textarea></div>
    </div>`;
}

const savedNote = (text, tone = '') => {
  const el = $('#saved-note');
  if (el) el.innerHTML = text ? `<span class="saved-note ${tone}">${tone === 'ok' ? icon('check') : ''}${esc(text)}</span>` : '';
};

// Adding an application: one form and an Add button, since there's nothing to save into yet.
function openNewDrawer() {
  openId = null;
  lastFocus = document.activeElement;
  const a = { company: '', role: '', jobId: '', url: '', notes: '', status: 'applied' };
  $('#drawer').innerHTML = `
    <div class="drawer-head">
      <div class="drawer-title">
        <div class="t"><h2 id="drawer-title">Add application</h2><div class="s">Track a job you applied to outside Gmail</div></div>
        <button class="icon-btn" data-close type="button" aria-label="Close">${icon('x')}</button>
      </div>
    </div>
    <form id="app-form" class="drawer-body" novalidate>${detailFieldsHtml(a, true)}</form>
    <div class="drawer-foot">
      <span id="saved-note"></span>
      <div class="right">
        <button class="btn" data-close type="button">Cancel</button>
        <button class="btn btn-primary" form="app-form" type="submit" id="save-btn">Add application</button>
      </div>
    </div>`;
  $('#app-form').addEventListener('submit', async e => {
    e.preventDefault();
    const company = $('#f-company');
    if (!company.value.trim()) {
      company.setCustomValidity('Company is required');
      company.reportValidity();
      company.setCustomValidity('');
      return company.focus();
    }
    const btn = $('#save-btn');
    btn.disabled = true;
    try {
      const created = await api('POST', '/api/applications', Object.fromEntries(new FormData(e.target)));
      closeDrawer();
      await load();
      toast(`Added ${created.company}`);
    } catch (err) {
      btn.disabled = false;
      savedNote(err.message, 'err');
    }
  });
  showDrawer($('#f-company'));
}

function openDrawer(app) {
  if (!app) return openNewDrawer();
  const a = app;
  openId = a.id;
  lastFocus = document.activeElement;

  // What happened first (any email to check, then the timeline); the details you can
  // edit come last, and save on their own as you change them.
  $('#drawer').innerHTML = `
    <div class="drawer-head">${drawerHeadHtml(a)}</div>
    <div class="drawer-body">
      <div class="review-slot">${reviewHtml(a)}</div>
      <section>
        <div class="section-row">
          <div class="section-title">Timeline</div>
          ${a.events.some(e => !e.manual && e.messageId) ? `<button class="btn btn-sm" id="rescan-app" type="button" title="Read this application's emails again, in case one was sorted wrong">${icon('refresh')}<span>Re-scan emails</span></button>` : ''}
        </div>
        <p id="rescan-note" class="rescan-note" role="status" hidden></p>
        <ul class="timeline">${timelineHtml(a)}</ul>
      </section>
      <section>
        <div class="section-row">
          <div class="section-title">Details</div>
          <span id="saved-note" role="status"></span>
        </div>
        <form id="app-form" novalidate>${detailFieldsHtml(a, false)}</form>
      </section>
    </div>
    <div class="drawer-foot">
      <button class="btn btn-quiet btn-danger" id="delete-btn" type="button">${icon('trash')}Delete application</button>
      <button class="meta-link" type="button" data-report="${a.id}">${icon('flag')}Report a problem</button>
    </div>`;

  // Each field saves when you leave it; notes also save as you pause typing.
  const form = $('#app-form');
  const saved = Object.fromEntries(new FormData(form));
  let notesTimer;
  const saveField = async input => {
    const { name, value } = input;
    if (value === saved[name]) return;
    if (name === 'company' && !value.trim()) {
      input.value = saved.company;
      return savedNote("Company can't be empty", 'err');
    }
    if (name === 'url' && value && !input.checkValidity()) return savedNote('Links need to start with https://', 'err');
    saved[name] = value;
    savedNote('Saving…');
    try {
      await api('PATCH', `/api/applications/${a.id}`, { [name]: value });
      await load();
      // A new deadline shows or hides "Mark done".
      if (name === 'deadline') openDrawer(state.applications.find(x => x.id === a.id));
      savedNote('Saved', 'ok');
    } catch (err) {
      savedNote(err.message, 'err');
    }
  };
  form.addEventListener('change', e => { if (e.target.name) saveField(e.target); });
  form.addEventListener('input', e => {
    if (e.target.name !== 'notes') return;
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => saveField(e.target), 900);
  });
  form.addEventListener('submit', e => e.preventDefault());

  $('#deadline-done')?.addEventListener('click', async () => {
    await api('PATCH', `/api/applications/${a.id}`, { deadlineDone: true });
    await load();
    openDrawer(state.applications.find(x => x.id === a.id));
    savedNote('Deadline done', 'ok');
  });

  // Read this application's emails again with the current classifier (e.g. after adding a Groq key).
  $('#rescan-app')?.addEventListener('click', async () => {
    const btn = $('#rescan-app');
    const n = a.events.filter(e => !e.manual && e.messageId).length;
    btn.disabled = true;
    btn.classList.add('spin');
    btn.querySelector('span').textContent = 'Re-scanning…';
    const note = (text, tone = '') => { const el = $('#rescan-note'); if (!el) return; el.hidden = false; el.className = `rescan-note ${tone}`; el.textContent = text; };
    note(`Reading ${n} ${n === 1 ? 'email' : 'emails'} again…`);
    try {
      const r = await api('POST', `/api/applications/${a.id}/rescan`);
      await load();
      openDrawer(state.applications.find(x => x.id === a.id));
      note(r.changed
        ? `Re-read ${r.emails} ${r.emails === 1 ? 'email' : 'emails'} · ${r.changed} sorted differently now.`
        : `Re-read ${r.emails} ${r.emails === 1 ? 'email' : 'emails'} · nothing changed.${r.notJob ? ` ${r.notJob} no longer look like application emails; use “Filed correctly?” to remove them.` : ''}`, 'ok');
      if (r.changed && a.events.some(e => e.manual)) {
        $('#rescan-note').textContent += ' A status you set by hand still wins; change it at the top if needed.';
      }
    } catch (err) {
      btn.disabled = false;
      btn.classList.remove('spin');
      btn.querySelector('span').textContent = 'Re-scan emails';
      note(err.message, 'err');
    }
  });

  // Deleting happens at once; the message offers Undo.
  $('#delete-btn').onclick = async () => {
    $('#delete-btn').disabled = true;
    const { undo } = await api('DELETE', `/api/applications/${a.id}`);
    closeDrawer();
    await load();
    undoToast(`Deleted ${a.company}`, undo, a.id);
  };

  showDrawer($('#drawer [data-close]'));
}

function showDrawer(focusEl) {
  $('#scrim').hidden = false;
  const drawer = $('#drawer');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  setBehindDrawer(true);
  focusEl?.focus();
}

// While the panel is open, the page behind it can't be tabbed to or clicked.
function setBehindDrawer(inert) {
  $('.shell').inert = inert;
  $('#sidebar').inert = inert;
}

function closeDrawer() {
  openId = null;
  $('#scrim').hidden = true;
  const drawer = $('#drawer');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  setBehindDrawer(false);
  lastFocus?.focus?.();
}

// The table's column names stick just under its sticky head, whose height changes with
// the filters shown, so keep that height in a CSS variable.
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty('--apps-sticky-h', `${Math.round(entry.target.offsetHeight)}px`);
}).observe($('#apps-sticky'));

// ---------------------------------------------------------------- events
const openById = id => openDrawer(state.applications.find(a => a.id === id));

$('#add-btn').onclick = () => openDrawer(null);
$('#scrim').onclick = closeDrawer;
$('#drawer').addEventListener('click', async e => {
  if (e.target.closest('[data-close]')) return closeDrawer();
  const fix = e.target.closest('[data-fix]');
  if (fix) {
    // The timeline's "Filed correctly?" and the check card's "Move it" / "Not a job" open
    // the same picker; the card's buttons go straight to their answer.
    const filer = $(`#drawer [data-filer="${fix.dataset.fix}"]`);
    filer.hidden = fix.dataset.show ? false : !filer.hidden;
    if (fix.dataset.show) showFilerPane(filer, fix.dataset.show);
    if (!filer.hidden) filer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  const pane = e.target.closest('[data-filer-show]');
  if (pane) return showFilerPane(pane.closest('.filer'), pane.dataset.filerShow);
  const remove = e.target.closest('[data-remove-event]');
  if (remove) {
    const id = openId;
    remove.disabled = true;
    remove.closest('li').classList.add('leaving');
    try {
      const { removed } = await api('DELETE', `/api/applications/${id}/events/${remove.dataset.removeEvent}`);
      await load();
      const a = state.applications.find(x => x.id === id);
      if (a && openId === id) openDrawer(a);
      toast(`Removed “${STAGE_LABEL[removed.stage]}” · now ${STAGE_LABEL[a.status]}`, async () => {
        await api('POST', `/api/applications/${id}/events`, removed);
        await load();
        const back = state.applications.find(x => x.id === id);
        if (back && openId === id) openDrawer(back);
      });
    } catch (err) {
      remove.disabled = false;
      remove.closest('li').classList.remove('leaving');
      $('#saved-note').innerHTML = `<span class="saved-note" style="color:var(--danger)">${esc(err.message)}</span>`;
    }
    return;
  }
  const button = e.target.closest('[data-confirm], [data-move], [data-split], [data-ignore]');
  if (!button) return;
  button.disabled = true;
  try {
    if (button.dataset.confirm) {
      await assignEmail(button.dataset.confirm, { action: 'confirm' });
      return toast('Thanks. That email is filed correctly');
    }
    if (button.dataset.ignore) {
      // "Not a job", optionally for everything from that sender.
      const block = button.closest('.filer').querySelector('[data-also-block]:checked');
      if (block) {
        const id = openId;
        const { domain, removed, undo } = await api('POST', '/api/blocked-senders', { domain: block.dataset.alsoBlock });
        await load();
        const a = state.applications.find(x => x.id === id);
        if (a) openDrawer(a); else closeDrawer();
        return undoToast(`Ignoring ${domain} · removed ${removed} ${removed === 1 ? 'email' : 'emails'}`, undo, id);
      }
      const { undo, fromId } = await assignEmail(button.dataset.ignore, { action: 'ignore' });
      return undoToast('Removed: not a job email', undo, fromId);
    }
    const filer = button.closest('.filer');
    if (button.dataset.move) {
      const to = filer.querySelector('[data-move-to]').value;
      const { undo, fromId } = await assignEmail(button.dataset.move, { action: 'move', to });
      return undoToast(`Moved to ${state.applications.find(x => x.id === to)?.company || 'the other application'}`, undo, fromId);
    }
    // Split off, then show the new application: that's where the emails went.
    const company = filer.querySelector('[data-new="company"]');
    if (!company.value.trim()) { button.disabled = false; return company.focus(); }
    const also = [...filer.querySelectorAll('[data-also]:checked')].map(x => x.dataset.also);
    const fromId = openId;
    const { app: created, undo } = await api('POST', `/api/emails/${button.dataset.split}/assign`, {
      action: 'new', company: company.value, role: filer.querySelector('[data-new="role"]').value, also,
    });
    await load();
    openById(created.id);
    const n = also.length + 1;
    undoToast(`Split ${n} ${n === 1 ? 'email' : 'emails'} into a new application at ${created.company}`, undo, fromId);
  } catch (err) {
    button.disabled = false;
    savedNote(err.message, 'err');
    toast(err.message);
  }
});

// Inside "Filed correctly?": show the Move or Not-a-job step.
function showFilerPane(filer, which) {
  filer.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== which; });
  filer.querySelectorAll('[data-filer-show]').forEach(b => b.setAttribute('aria-expanded', b.dataset.filerShow === which));
  filer.querySelector({ move: '[data-move-to]', split: '[data-new="company"]' }[which] || '[data-ignore]')?.focus();
}
$('#drawer').addEventListener('change', async e => {
  // Status at the top of the panel saves at once, the same as in the table.
  const status = e.target.closest('select[data-status-for]');
  if (status) {
    await setStatus(status.dataset.statusFor, status.value);
    return toast(`Status set to ${STAGE_LABEL[status.value]}`);
  }
  const pick = e.target.closest('[data-move-to]');
  if (!pick) return;
  const filer = pick.closest('.filer');
  // "A new application…" is the split step, so it can take other emails along.
  if (pick.value === 'new') { pick.value = ''; showFilerPane(filer, 'split'); }
  filer.querySelector('[data-move]').disabled = !pick.value;
});
// Resolving a row: it folds away at once, then the server catches up.
const foldRow = id => $(`#action-list [data-row="${id}"]`)?.classList.add('leaving');
$('#action-list').addEventListener('click', async e => {
  const done = e.target.closest('[data-done]');
  if (done) {
    const a = state.applications.find(x => x.id === done.dataset.done);
    // A deadline you typed is put back as typed; one from an email is simply reopened.
    const restore = a.manualDeadline ? { deadline: isoDate(a.manualDeadline) } : { deadlineDone: false };
    done.disabled = true;
    foldRow(a.id);
    try {
      await api('PATCH', `/api/applications/${a.id}`, { deadlineDone: true });
      toast(`${a.company}: deadline marked done`, () => api('PATCH', `/api/applications/${a.id}`, restore));
    } catch (err) {
      toast(err.message);
    }
    return load();
  }
  const right = e.target.closest('[data-looks-right]');
  if (right) {
    const a = state.applications.find(x => x.id === right.dataset.looksRight);
    right.disabled = true;
    foldRow(a.id);
    try {
      for (const ev of a.events.filter(needsCheck)) await api('POST', `/api/emails/${ev.id}/assign`, { action: 'confirm' });
      toast(`${a.company}: filed correctly`);
    } catch (err) {
      toast(err.message);
    }
    return load();
  }
  const item = e.target.closest('[data-open]');
  if (item) openById(item.dataset.open);
});
$('#action-list').addEventListener('keydown', e => {
  const item = e.target.closest('[data-open]');
  if (item && e.target === item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openById(item.dataset.open); }
});

// ---------------------------------------------------------------- settings page
$('#blocked-list').addEventListener('click', async e => {
  const b = e.target.closest('[data-unblock]');
  if (!b) return;
  b.disabled = true;
  await api('DELETE', `/api/blocked-senders/${encodeURIComponent(b.dataset.unblock)}`);
  toast(`nuj will read ${b.dataset.unblock} again`);
  load();
});
$('#rescan-btn').onclick = async () => {
  $('#rescan-btn').disabled = true;
  try {
    await api('POST', '/api/rescan');
    toast('Re-scanning your emails. Progress shows at the top of the page');
  } catch (err) {
    toast(err.message);
  }
  load();
};

// Disconnecting is rendered with the Gmail row, so listen on the page. Two clicks,
// like the other things here that are hard to undo.
$('#view-settings').addEventListener('click', async e => {
  const btn = e.target.closest('#disconnect-btn');
  if (!btn) return;
  if (!btn.classList.contains('confirming')) {
    btn.classList.add('confirming', 'btn-danger');
    btn.textContent = 'Click again to disconnect';
    setTimeout(() => { if (btn.isConnected) { btn.classList.remove('confirming', 'btn-danger'); btn.textContent = 'Disconnect'; } }, 4000);
    return;
  }
  btn.disabled = true;
  try {
    await api('POST', '/api/disconnect');
    toast('Gmail disconnected. Your applications stay');
  } catch (err) {
    toast(err.message);
  }
  load();
});

// AI email sorting sheet (your Groq key)
const groqDialog = $('#groq-dialog');
function openGroq() {
  closeNav();
  groqMsg('');
  groqDialog.showModal();
  $('#groq-key').focus();
}
$('#groq-menu-btn').onclick = openGroq;
groqDialog.addEventListener('click', e => {
  if (e.target === e.currentTarget || e.target.closest('[data-close-dialog]')) groqDialog.close();
});
groqDialog.addEventListener('close', () => {
  $('#groq-key').value = '';
  setReveal(false);
});

const groqMsg = (text, tone = '') => { $('#groq-msg').className = `key-msg ${tone}`; $('#groq-msg').textContent = text; };
const setReveal = on => {
  $('#groq-key').type = on ? 'text' : 'password';
  const btn = $('#groq-reveal');
  btn.setAttribute('aria-pressed', on);
  btn.setAttribute('aria-label', on ? 'Hide key' : 'Show key');
  btn.innerHTML = icon(on ? 'eye-off' : 'eye');
};
$('#groq-reveal').onclick = () => setReveal($('#groq-key').type === 'password');
// Check the shape as you type, so a half-copied key is caught before Groq is asked.
$('#groq-key').addEventListener('input', e => {
  const v = e.target.value.trim();
  e.target.closest('.key-input').classList.toggle('invalid', v.length > 3 && !v.startsWith('gsk_'));
  groqMsg(v.length > 3 && !v.startsWith('gsk_') ? 'Groq keys start with gsk_. Check it was copied in full.' : '');
});
$('#groq-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#groq-key');
  const key = input.value.trim();
  if (!key) return input.focus();
  const save = e.submitter || $('#groq-form button[type="submit"]');
  save.disabled = true;
  save.classList.add('busy');
  groqMsg('Checking the key with Groq…', 'pending');
  try {
    await api('PUT', '/api/groq-key', { key });
    input.value = '';
    setReveal(false);
    groqMsg('Saved. New emails will be read with your key.', 'ok');
    await load();
  } catch (err) {
    groqMsg(err.message, 'err');
    input.focus();
  }
  save.disabled = false;
  save.classList.remove('busy');
});
$('#groq-remove').onclick = async () => {
  const btn = $('#groq-remove');
  // Two clicks rather than a dialog on top of a dialog.
  if (!btn.classList.contains('confirming')) {
    btn.classList.add('confirming');
    btn.textContent = 'Click again to remove';
    setTimeout(() => { btn.classList.remove('confirming'); btn.textContent = 'Remove my key'; }, 4000);
    return;
  }
  btn.classList.remove('confirming');
  btn.textContent = 'Remove my key';
  await api('DELETE', '/api/groq-key');
  groqMsg('Removed. Emails will be sorted by the built-in rules.', 'ok');
  load();
};

// Two clicks, like deleting an application, since it can't be undone.
$('#delete-account-btn').onclick = async () => {
  const btn = $('#delete-account-btn');
  if (!btn.classList.contains('confirming')) {
    btn.classList.add('confirming');
    btn.textContent = 'Click again to delete everything';
    setTimeout(() => { btn.classList.remove('confirming'); btn.textContent = 'Delete my account'; }, 5000);
    return;
  }
  btn.disabled = true;
  try {
    await api('DELETE', '/api/account');
    location.assign(state.user ? '/welcome' : '/');
  } catch (err) {
    btn.disabled = false;
    alert(err.message);
  }
};

const rowsEl = $('#rows');
rowsEl.addEventListener('click', e => {
  if (e.target.closest('.status-select')) return; // changing status inline, not opening
  const tr = e.target.closest('tr[data-id]');
  if (tr) openById(tr.dataset.id);
});
rowsEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.target.tagName !== 'TR') return;
  openById(e.target.dataset.id);
});
rowsEl.addEventListener('change', e => {
  const sel = e.target.closest('select[data-status-for]');
  if (sel) setStatus(sel.dataset.statusFor, sel.value).then(() => toast(`Status set to ${STAGE_LABEL[sel.value]}`));
});

$('#stage-tabs').addEventListener('click', e => {
  const tab = e.target.closest('[data-filter]');
  if (!tab) return;
  withTransition(() => {
    filter = tab.dataset.filter;
    renderTabs();
    renderTable();
  });
});
document.querySelector('thead').addEventListener('click', e => {
  const b = e.target.closest('.sort');
  if (!b) return;
  const key = b.dataset.sort;
  // Re-sorting is where rows moving to their new places helps most.
  withTransition(() => {
    sort = sort.key === key
      ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'company' || key === 'status' ? 'asc' : 'desc' };
    renderTable();
  });
});
$('#empty').addEventListener('click', e => {
  if (e.target.closest('[data-add]')) openDrawer(null);
  if (e.target.closest('[data-clear]')) clearFilters('all');
});
function clearFilters(which) {
  if (which === 'filter' || which === 'all') filter = 'all';
  if ((which === 'flow' || which === 'all') && flow) { flow = null; renderSankey(); }
  if (which === 'month' || which === 'all') month = 'all';
  if (which === 'query' || which === 'all') { query = ''; $('#search').value = ''; $('#search-clear').hidden = true; }
  renderMonths(); renderTabs(); renderTable();
}
$('#filter-chips').addEventListener('click', e => {
  const b = e.target.closest('[data-unfilter]');
  if (b) withTransition(() => clearFilters(b.dataset.unfilter));
});
$('#month').addEventListener('change', e => withTransition(() => {
  month = e.target.value;
  renderMonths();
  renderTabs();
  renderTable();
}));

// Excel export of exactly what the table shows.
$('#export-btn').onclick = async () => {
  const btn = $('#export-btn');
  const label = btn.querySelector('span');
  btn.disabled = true;
  label.textContent = 'Exporting…';
  const parts = ['job-applications', month !== 'all' && month, filter !== 'all' && STAGE_LABEL[filter].toLowerCase()].filter(Boolean);
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: visibleRows.map(a => a.id), filename: parts.join('-') }),
    });
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    const link = Object.assign(document.createElement('a'), { href: url, download: `${parts.join('-')}.xlsx` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = visibleRows.length === 0;
    label.textContent = 'Export';
  }
};

// Large chart dialog
$('#expand-flow').addEventListener('click', openFlowDialog);
$('#flow-dialog').addEventListener('click', e => {
  // Clicks on the backdrop land on the <dialog> element itself.
  if (e.target === e.currentTarget || e.target.closest('[data-close-dialog]')) e.currentTarget.close();
});
$('#search').addEventListener('input', e => setQuery(e.target.value));
// Esc empties the search first, then leaves it.
$('#search').addEventListener('keydown', e => {
  if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); }
  else if (e.key === 'Escape') e.target.blur();
});
$('#search-clear').addEventListener('click', () => { setQuery(''); $('#search').focus(); });

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#drawer').classList.contains('open')) closeDrawer();
  if (e.key === 'Escape' && $('#sidebar').classList.contains('open')) closeNav();
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === '/' && !typing && !$('#drawer').classList.contains('open') && !$('#flow-dialog').open && !groqDialog.open) {
    e.preventDefault();
    if (view !== 'dashboard') location.hash = '#/applications';
    $('#search').focus();
  }
});

// ---------------------------------------------------------------- sections (sidebar)
// Planned sections: listed now so the sidebar shows where nuj is going, each with a
// "coming soon" page saying what it will do.
const SOON = {
  analytics: {
    label: 'Analytics', icon: 'chart', c: 'applied', preview: 'bars',
    blurb: 'See which applications turn into interviews, how fast companies reply, and how your search changes week to week.',
    points: ['Response and interview rates by month', 'Average time to hear back, by company', 'Which roles and sources work best for you'],
  },
  calendar: {
    label: 'Calendar', icon: 'calendar', c: 'interview', preview: 'calendar',
    blurb: 'Every assessment deadline and interview from your inbox, on one calendar you can add to Google Calendar.',
    points: ['Deadlines and interviews pulled from emails', 'Reminders before anything is due', 'Sync to Google Calendar'],
  },
  contacts: {
    label: 'Contacts', icon: 'users', c: 'oa', preview: 'list',
    blurb: 'The recruiters and interviewers you hear from, linked to their applications, so you know who to follow up with.',
    points: ['Recruiters found in your application emails', 'Last contact and follow-up nudges', 'Notes for each person'],
  },
  goals: {
    label: 'Goals', icon: 'target', c: 'offer', preview: 'rings',
    blurb: 'Set a weekly target for applications and follow-ups, and watch your streak build.',
    points: ['Weekly application targets', 'Streaks and progress at a glance', 'A gentle nudge when you fall behind'],
  },
  resume: {
    label: 'Resume insights', icon: 'file', c: 'in_progress', preview: 'list',
    blurb: 'Compare the roles that move forward with the ones that don’t, and see what to sharpen in your resume.',
    points: ['Patterns in roles that reach interviews', 'Keywords from postings you applied to', 'Suggestions you choose to act on'],
  },
};
$('#soon-links').innerHTML = Object.entries(SOON).map(([id, s]) =>
  `<a class="side-link upcoming" href="#/${id}" data-view="${id}">${icon(s.icon)}${s.label}<span class="soon-tag">Soon</span></a>`).join('');

function soonPreview(kind, c) {
  const bars = [38, 62, 46, 80, 54, 70, 92];
  if (kind === 'bars') return `<div class="ghost-kpis">${'<span></span>'.repeat(3)}</div>
    <div class="ghost-bars">${bars.map((h, i) => `<span style="--h:${h}%;--d:${i}"></span>`).join('')}</div>`;
  if (kind === 'calendar') return `<div class="ghost-cal">${Array.from({ length: 28 }, (_, i) =>
    `<span class="${[4, 9, 17, 22].includes(i) ? 'on' : ''}" style="--d:${i % 7}"></span>`).join('')}</div>`;
  if (kind === 'rings') return `<div class="ghost-rings">${[72, 45, 88].map((p, i) =>
    `<svg viewBox="0 0 40 40" style="--d:${i}"><circle cx="20" cy="20" r="16"/><circle class="on" cx="20" cy="20" r="16" pathLength="100" style="stroke-dasharray:${p} 100"/></svg>`).join('')}</div>`;
  return `<div class="ghost-list">${[78, 62, 70, 54].map((w, i) => `<span style="--w:${w}%;--d:${i}"><i></i><b></b></span>`).join('')}</div>`;
}

function renderSoon(id) {
  const s = SOON[id];
  $('#soon').style.setProperty('--c', color(s.c));
  $('#soon').innerHTML = `
    <div class="soon-icon">${icon(s.icon)}</div>
    <span class="soon-badge"><i></i>Coming soon</span>
    <h1>${s.label}</h1>
    <p class="soon-blurb">${s.blurb}</p>
    <div class="soon-preview" aria-hidden="true">${soonPreview(s.preview, s.c)}</div>
    <ul class="soon-points">${s.points.map(p => `<li>${icon('check')}${p}</li>`).join('')}</ul>
    <p class="soon-note">We're building this now. It will appear here once it's ready, using the applications you already track.</p>
    <a class="btn" href="#/">${icon('back')}Back to dashboard</a>`;
}

let view = 'dashboard';
function route() {
  const id = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const soon = SOON[id];
  const page = id === 'reports' || id === 'settings' ? id : null; // pages of their own
  const prev = view;
  if (view !== (soon ? id : page || 'dashboard') && $('#drawer').classList.contains('open')) closeDrawer(); // a new page, not the panel on top of it
  view = soon ? id : page || 'dashboard';
  $('#view-dashboard').hidden = view !== 'dashboard';
  $('#view-soon').hidden = !soon;
  $('#view-reports').hidden = page !== 'reports';
  $('#view-settings').hidden = page !== 'settings';
  if (soon) renderSoon(id);
  if (page === 'reports') loadReports();
  const current = soon || page ? id : id === 'applications' ? 'applications' : 'dashboard';
  document.querySelectorAll('.side-link').forEach(l => {
    if (l.dataset.view === current) l.setAttribute('aria-current', 'page'); else l.removeAttribute('aria-current');
  });
  closeNav();
  if (view === 'dashboard' && prev !== 'dashboard') renderSankey(); // its width was 0 while hidden
  if (id === 'applications') requestAnimationFrame(() => $('#apps-title').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  else window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- problem reports
// Anyone can send one (sidebar, menu, or an application's panel); the owner reads them on Reports.
const reportDialog = $('#report-dialog');
let reportAppId = null;
function openReport(appId) {
  closeNav();
  const a = appId && state.applications.find(x => x.id === appId);
  reportAppId = a ? a.id : null;
  $('#report-app-row').hidden = !a;
  $('#report-app-name').textContent = a ? a.company : '';
  $('#report-include-app').checked = false; // its emails are only shared if you say so
  $('#report-form').querySelector(`input[value="${a ? 'sorting' : 'bug'}"]`).checked = true;
  reportMsg('');
  $('#report-send').disabled = false;
  reportDialog.showModal();
  $('#report-message').focus();
}
const reportMsg = (text, tone = '') => { $('#report-msg').className = `key-msg ${tone}`; $('#report-msg').textContent = text; };
document.addEventListener('click', e => {
  const b = e.target.closest('[data-report]');
  if (b) openReport(b.dataset.report);
});
reportDialog.addEventListener('click', e => {
  if (e.target === e.currentTarget || e.target.closest('[data-close-dialog]')) reportDialog.close();
});
$('#report-form').addEventListener('submit', async e => {
  e.preventDefault();
  const message = $('#report-message').value.trim();
  if (!message) { reportMsg('Tell us what went wrong first.', 'err'); return $('#report-message').focus(); }
  const a = reportAppId && state.applications.find(x => x.id === reportAppId);
  const context = {};
  if ($('#report-include-tech').checked) {
    Object.assign(context, {
      view: location.hash || '#/', url: location.pathname, userAgent: navigator.userAgent,
      classifier: state.gmail?.classifier, syncError: state.gmail?.lastSyncError, errors: recentErrors,
    });
  }
  if (a && $('#report-include-app').checked) {
    context.app = {
      company: a.company, role: a.role, status: a.status,
      timeline: a.events.map(ev => `${isoDate(ev.date)} ${STAGE_LABEL[ev.stage]}${ev.manual ? ' (set by you)' : ''}: ${decode(ev.subject || '')}`),
    };
  } else if (a) {
    context.app = { company: a.company, status: a.status };
  }
  const btn = $('#report-send');
  btn.disabled = true;
  btn.classList.add('busy');
  try {
    await api('POST', '/api/reports', { kind: new FormData(e.target).get('kind'), message, context });
    $('#report-message').value = '';
    reportDialog.close();
    toast('Report sent. Thanks for letting us know');
  } catch (err) {
    reportMsg(err.message, 'err');
    btn.disabled = false;
  }
  btn.classList.remove('busy');
});

// The owner's list of reports.
const REPORT_KIND = { sorting: 'Sorted wrong', bug: 'Something broke', other: 'Idea or other' };
const REPORT_TONE = { sorting: 'interview', bug: 'rejected', other: 'applied' };
let allReports = [];
let reportFilter = 'open';
const pendingDeletes = new Set(); // deleted here, waiting out the Undo
async function loadReports() {
  let stats;
  try {
    [{ reports: allReports }, stats, { requests }] = await Promise.all([
      api('GET', '/api/reports'), api('GET', '/api/reports/stats'), api('GET', '/api/access-requests')]);
  } catch {
    location.hash = '#/'; // not the owner
    return;
  }
  renderReports();
  renderQuality(stats);
  renderRequests();
}

// Invite requests from the landing page.
const STAGE_NAMES = { starting: 'Just starting', applying: 'Applying', interviewing: 'Interviewing', other: 'Something else' };
let requests = [];
let requestFilter = 'pending';
function renderRequests() {
  const counts = { pending: 0, invited: 0, dismissed: 0 };
  requests.forEach(r => counts[r.status]++);
  $('#request-tabs').innerHTML = [['pending', 'Waiting'], ['invited', 'Invited'], ['dismissed', 'Dismissed']]
    .map(([id, label]) => `<button class="tab" role="tab" type="button" aria-selected="${requestFilter === id}" data-request-filter="${id}">${label}<span class="n">${counts[id]}</span></button>`).join('');
  const shown = requests.filter(r => r.status === requestFilter);
  $('#request-list').innerHTML = shown.length ? shown.map(r => `
    <li class="report">
      <div class="report-head">
        <span class="report-from">${esc(r.name)}</span>
        <span class="request-email">${esc(r.email)}</span>
        <span class="report-when" title="${esc(new Date(r.createdAt).toLocaleString())}">${timeAgo(r.updatedAt || r.createdAt)}</span>
      </div>
      <p class="report-message"><span class="request-stage">${STAGE_NAMES[r.stage] || 'Something else'}</span>${r.note ? ` · ${esc(r.note)}` : ''}</p>
      <div class="report-actions">
        <button class="btn btn-sm" type="button" data-copy-email="${esc(r.email)}">${icon('mail')}Copy email</button>
        ${r.status !== 'invited' ? `<button class="btn btn-sm" type="button" data-request-status="${r.id}" data-to="invited">${icon('check')}Mark invited</button>` : ''}
        ${r.status !== 'dismissed' ? `<button class="btn btn-sm btn-quiet" type="button" data-request-status="${r.id}" data-to="dismissed">Dismiss</button>` : ''}
        ${r.status !== 'pending' ? `<button class="btn btn-sm btn-quiet" type="button" data-request-status="${r.id}" data-to="pending">Back to waiting</button>` : ''}
      </div>
    </li>`).join('')
    : `<li class="action-empty"><strong>${requestFilter === 'pending' ? 'No one waiting' : 'Nothing here'}</strong>Requests from the landing page's invite form show up here.</li>`;
}
$('#request-tabs').addEventListener('click', e => {
  const t = e.target.closest('[data-request-filter]');
  if (t) { requestFilter = t.dataset.requestFilter; renderRequests(); }
});
$('#request-list').addEventListener('click', async e => {
  const copy = e.target.closest('[data-copy-email]');
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copyEmail); toast(`Copied ${copy.dataset.copyEmail}`); }
    catch { toast("Couldn't copy. Select the address instead"); }
    return;
  }
  const b = e.target.closest('[data-request-status]');
  if (!b) return;
  b.disabled = true;
  const was = requests.find(r => r.id === b.dataset.requestStatus)?.status;
  await api('PATCH', `/api/access-requests/${b.dataset.requestStatus}`, { status: b.dataset.to });
  await loadReports();
  // Moving a request between lists can be put back the same way.
  toast(b.dataset.to === 'invited' ? 'Marked invited' : b.dataset.to === 'dismissed' ? 'Dismissed' : 'Back to waiting', async () => {
    await api('PATCH', `/api/access-requests/${b.dataset.requestStatus}`, { status: was });
    await loadReports();
  });
});

// Fixes people make to sorting. "Confirmed" means it was right, so it isn't a fix.
const FIX_KINDS = { moved: 'moved to another application', notJob: 'marked not an application', statusChanged: 'status changed',
  deleted: 'applications deleted', senderBlocked: 'senders ignored' };
function renderQuality({ accounts, withAi, emails, corrections: c }) {
  const fixes = Object.keys(FIX_KINDS).reduce((n, k) => n + (c[k] || 0), 0);
  const rate = emails ? Math.round((fixes / emails) * 1000) / 10 : 0;
  $('#quality').innerHTML = [
    ['Emails sorted', emails],
    ['Fixed by people', fixes, emails ? `${rate}% of emails` : ''],
    ['Confirmed right', c.confirmed || 0, 'from the "Check" list'],
    ['Accounts on AI sorting', `${withAi}<small> of ${accounts}</small>`],
  ].map(([label, value, sub]) => `<div class="kpi"><dt>${label}</dt><dd><span class="value">${value}</span>${sub ? `<span class="delta">${sub}</span>` : ''}</dd></div>`).join('');
  const parts = Object.entries(FIX_KINDS).filter(([k]) => c[k]).map(([k, label]) => `${c[k]} ${label}`);
  $('#quality-detail').textContent = parts.length ? parts.join(' · ') : 'No fixes yet.';
}
function renderReports() {
  const counts = { open: 0, resolved: 0 };
  const reports = allReports.filter(r => !pendingDeletes.has(r.id));
  reports.forEach(r => counts[r.status]++);
  $('#report-tabs').innerHTML = [['open', 'Open', counts.open], ['resolved', 'Resolved', counts.resolved], ['all', 'All', reports.length]]
    .map(([id, label, n]) => `<button class="tab" role="tab" type="button" aria-selected="${reportFilter === id}" data-report-filter="${id}">${label}<span class="n">${n}</span></button>`).join('');
  const shown = reports.filter(r => reportFilter === 'all' || r.status === reportFilter);
  $('#report-list').innerHTML = shown.length ? shown.map(r => {
    const c = r.context || {};
    const details = [
      c.app && ['Application', `${esc(c.app.company)}${c.app.role ? ` · ${esc(c.app.role)}` : ''}${c.app.status ? ` · ${STAGE_LABEL[c.app.status] || esc(c.app.status)}` : ''}`],
      c.app?.timeline?.length && ['Timeline', `<ol>${c.app.timeline.map(t => `<li>${esc(t)}</li>`).join('')}</ol>`],
      c.errors?.length && ['Recent errors', `<ol class="mono">${c.errors.map(t => `<li>${esc(t)}</li>`).join('')}</ol>`],
      c.syncError && ['Last sync error', esc(c.syncError)],
      c.classifier && ['Sorting', esc(c.classifier)],
      c.view && ['Page', esc(c.view)],
      c.userAgent && ['Browser', esc(c.userAgent)],
    ].filter(Boolean);
    return `
    <li class="report ${r.status}">
      <div class="report-head">
        <span class="pill" style="--c:${color(REPORT_TONE[r.kind] || 'applied')}">${REPORT_KIND[r.kind] || 'Other'}</span>
        <span class="report-from">${esc(r.email || 'Unknown sender')}</span>
        <span class="report-when" title="${esc(new Date(r.createdAt).toLocaleString())}">${timeAgo(r.createdAt)}</span>
      </div>
      <p class="report-message">${esc(r.message)}</p>
      ${details.length ? `<details class="report-details"><summary>Details</summary>
        <dl>${details.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></details>` : ''}
      <div class="report-actions">
        ${r.email ? `<a class="btn btn-sm" href="mailto:${esc(r.email)}?subject=${encodeURIComponent('Your nuj report')}">${icon('mail')}Reply</a>` : ''}
        <button class="btn btn-sm" type="button" data-report-status="${r.id}" data-to="${r.status === 'open' ? 'resolved' : 'open'}">${icon(r.status === 'open' ? 'check' : 'refresh')}${r.status === 'open' ? 'Mark resolved' : 'Reopen'}</button>
        <button class="btn btn-sm btn-quiet btn-danger" type="button" data-report-delete="${r.id}">${icon('trash')}Delete</button>
      </div>
    </li>`;
  }).join('') : `<li class="action-empty"><strong>${reportFilter === 'open' ? 'No open reports' : 'Nothing here'}</strong>When someone uses "Report a problem", it shows up here.</li>`;
}
$('#report-tabs').addEventListener('click', e => {
  const t = e.target.closest('[data-report-filter]');
  if (t) { reportFilter = t.dataset.reportFilter; renderReports(); }
});
$('#report-list').addEventListener('click', async e => {
  const status = e.target.closest('[data-report-status]');
  if (status) {
    status.disabled = true;
    await api('PATCH', `/api/reports/${status.dataset.reportStatus}`, { status: status.dataset.to });
    return loadReports();
  }
  // Deleting a report hides it at once and only deletes it for good once the Undo
  // in the message has had its chance.
  const del = e.target.closest('[data-report-delete]');
  if (del) {
    const id = del.dataset.reportDelete;
    pendingDeletes.add(id);
    renderReports();
    const timer = setTimeout(async () => {
      if (!pendingDeletes.has(id)) return;
      await api('DELETE', `/api/reports/${id}`).catch(() => {});
      pendingDeletes.delete(id);
      loadReports();
    }, UNDO_SHOW_MS + 300); // just after the Undo goes
    toast('Report deleted', async () => {
      clearTimeout(timer);
      pendingDeletes.delete(id);
      renderReports();
    });
  }
});
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
// Colours come from CSS variables when things are drawn, so redraw when the system theme flips.
matchMedia('(prefers-color-scheme: light)').addEventListener('change', render);

// Live updates: the server pings whenever a sync or edit changes the data.
new EventSource('/api/events').onmessage = e => {
  load();
  if (e.data === 'reports' && view === 'reports') loadReports();
};
// Keep relative times ("synced 2m ago") fresh.
setInterval(renderGmail, 30_000);

load();
