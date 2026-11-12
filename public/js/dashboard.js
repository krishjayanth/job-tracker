// The dashboard: banners and sync progress, the summary, the chart, Needs your action,
// the toast, the stage tabs and the applications table.
// The dashboard's scripts are plain scripts loaded in order (see index.html), sharing one
// global scope: a file may use what an earlier one defines, and anything at all from inside
// functions that run later.

// ---------------------------------------------------------------- render
function render() {
  renderGmail();
  renderSummary();
  renderSankey();
  renderActions();
  renderMonths();
  renderTabs();
  renderTable();
  renderCalendar();
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
  $('#developer-link').hidden = !state.reports;
  // What's waiting for you there: open errors and answers you haven't read.
  $('#developer-count').textContent = (state.reports?.errors || 0) + (state.reports?.feedback || 0) || '';
  // The badge counts everything waiting for you there: open reports and invite requests.
  $('#reports-count').textContent = (state.reports?.open || 0) + (state.reports?.requests || 0) || '';
  $('#delete-section').hidden = state.demo;
  renderSettings();
  renderProgress();
  renderSetup();
  renderWhatsNew();
  renderFeedback();
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
  renderFeed();
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
  renderFeedback(); // waiting its turn behind the release notes
});
// "How's nuj going?": questions the owner asked you, shown once when you open nuj (not
// in the middle of a visit, when a live update brings them in). Closing them without
// sending is "Not now", and they don't come back.
let feedbackAsk; // undefined until the first load of this visit; then the ask or null
function renderFeedback() {
  if (feedbackAsk === undefined) feedbackAsk = state.feedback || null;
  const dialog = $('#feedback-dialog');
  if (!feedbackAsk || dialog.open || state.needsSetup || document.querySelector('dialog[open]')) return;
  $('#feedback-form').reset();
  setStars(0);
  $('#feedback-msg').textContent = '';
  // Without Gmail there's no sorting to judge.
  $('#feedback-sorting').hidden = !state.gmail?.connected && !state.demo;
  dialog.showModal();
}
const STAR_WORDS = ['', 'Poor', 'Fair', 'Good', 'Very good', 'Excellent'];
// Stars fill up to the one you point at, and to your choice when you're not pointing.
function setStars(n, preview = false) {
  const box = $('#feedback-stars');
  box.querySelectorAll('label').forEach((l, i) => l.classList.toggle('on', i < n));
  box.classList.toggle('preview', preview);
  $('#feedback-stars-word').textContent = STAR_WORDS[n];
}
const chosenStars = () => Number($('#feedback-form').elements.rating.value || 0);
$('#feedback-stars').addEventListener('pointerover', e => {
  const l = e.target.closest('label');
  if (l) setStars([...l.parentNode.querySelectorAll('label')].indexOf(l) + 1, true);
});
$('#feedback-stars').addEventListener('pointerleave', () => setStars(chosenStars()));
$('#feedback-stars').addEventListener('change', () => setStars(chosenStars()));
$('#feedback-form').addEventListener('change', () => { $('#feedback-msg').textContent = ''; }); // answered what it asked for

$('#feedback-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements;
  const sortingAsked = !$('#feedback-sorting').hidden;
  const msg = text => { $('#feedback-msg').className = 'key-msg err'; $('#feedback-msg').textContent = text; };
  if (!f.enjoying.value) return msg('Say whether you’re enjoying nuj');
  if (!f.rating.value) return msg('Pick a rating from 1 to 5 stars');
  if (sortingAsked && !f.sorting.value) return msg('Say how the email sorting is doing');
  const send = $('#feedback-send');
  send.disabled = true;
  try {
    await api('POST', `/api/feedback/${feedbackAsk.id}`, {
      enjoying: f.enjoying.value, rating: Number(f.rating.value),
      sorting: sortingAsked ? f.sorting.value : null, comment: f.comment.value,
    });
    // Settled before closing, so a live update arriving now can't bring the questions back.
    feedbackAsk = null;
    $('#feedback-dialog').close();
    toast('Thanks! That helps make nuj better');
  } catch (err) {
    msg(err.message);
  }
  send.disabled = false;
});
$('#feedback-skip').onclick = () => $('#feedback-dialog').close();
$('#feedback-dialog').addEventListener('click', e => {
  if (e.target === e.currentTarget || e.target.closest('[data-close-dialog]')) e.currentTarget.close();
});
// Closed any way but Send: that's "Not now".
$('#feedback-dialog').addEventListener('close', () => {
  if (!feedbackAsk) return;
  const { id } = feedbackAsk;
  feedbackAsk = null;
  api('POST', `/api/feedback/${id}/skip`).catch(() => {});
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
  const at = dueTime(deadline) ? `, ${dueTime(deadline)}` : '';
  if (sameDay) return { level: 'urgent', text: `Due today${at}` };
  if (tomorrow) return { level: 'urgent', text: `Due tomorrow${at}` };
  if (days <= 4) return { level: 'soon', text: `Due in ${days} days` };
  return { level: 'later', text: `Due ${shortDate(deadline)}${at}` };
}
// The chip's tooltip always gives the exact day and time, even when the chip says "in 3 days".
const dueChip = deadline => {
  const d = dueInfo(deadline);
  if (!d) return '';
  const exact = new Date(deadline).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `<span class="due ${d.level}" title="Due ${esc(exact)}">${icon('clock')}${d.text}</span>`;
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
    ['Applications', apps.length, 'var(--applied)', newThisMonth(apps.filter(a => thisMonth(a.appliedAt)).length)],
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
  // Drawn when you come back; a hidden chart has no width.
  if (view !== 'dashboard' || $('#view-dashboard').classList.contains('apps-only')) return;
  const apps = state.applications;
  $('#flow-caption').textContent = apps.length ? `Click a stage to filter · “Ongoing” is still under way · no reply after ${state.ghostDays} days is “No response”` : '';
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
const FLOW_LABEL = { oa: 'Reached assessment', interview: 'Reached interview', offer: 'Got an offer', in_progress: 'Ongoing', no_response: 'No response', rejected: 'Rejected', withdrawn: 'Withdrawn' };
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

// What's waiting on you: an open deadline (mark it done), an email nuj wasn't sure about
// (open it and say where it goes), an interview in the next INTERVIEW_AHEAD_DAYS, and an
// offer that came in over the last OFFER_FRESH_DAYS with no deadline of its own. The last
// two clear themselves: the interview passes, the offer ages out.
const INTERVIEW_AHEAD_DAYS = 14;
const OFFER_FRESH_DAYS = 14;
const DAY_MS = 86_400_000;
const isOpen = a => !['rejected', 'withdrawn'].includes(a.status);
const upcomingInterview = a => isOpen(a) && a.interviewAt && Date.parse(a.interviewAt) > Date.now() &&
  Date.parse(a.interviewAt) - Date.now() < INTERVIEW_AHEAD_DAYS * DAY_MS ? a.interviewAt : null;
const freshOffer = a => a.status === 'offer' && !dueInfo(a.deadline) &&
  Date.now() - Date.parse(firstReached(a, ['offer']) || a.lastActivity) < OFFER_FRESH_DAYS * DAY_MS;

// The one thing each row is about, most pressing first. `at` orders the dated ones.
function actionFor(a) {
  const due = dueInfo(a.deadline);
  if (due) return { kind: 'deadline', at: a.deadline, due };
  if (upcomingInterview(a)) return { kind: 'interview', at: a.interviewAt };
  if (a.needsReview) return { kind: 'review' };
  if (freshOffer(a)) return { kind: 'offer' };
  return null;
}
const needsAction = a => Boolean(actionFor(a));

function actionSideHtml(a, act) {
  if (act.kind === 'deadline') {
    return `${dueChip(a.deadline)}<button class="done-btn" type="button" data-done="${a.id}" title="You've done it: take this deadline off the list">${icon('check')}Mark done</button>`;
  }
  if (act.kind === 'interview') return interviewChip(a, { short: true });
  if (act.kind === 'offer') return `<span class="due later">${icon('check')}Offer</span>`;
  return `<button class="done-btn" type="button" data-open="${a.id}" title="See the email and say where it belongs">Review</button>`;
}

function actionWhy(a, act) {
  if (act.kind === 'deadline') return ACTION_STAGES[a.status] || 'Next step to complete';
  if (act.kind === 'interview') return 'Interview coming up';
  if (act.kind === 'offer') return 'Offer to respond to';
  // Which email, so you know what you're about to check.
  const flagged = a.events.filter(needsCheck).at(-1);
  return `Check where this email goes: “${esc(decode(flagged?.subject || 'an email'))}”`;
}

function renderActions() {
  // Dated things first, soonest at the top (missed deadlines after them); then emails to
  // check and offers, newest first.
  const items = state.applications
    .map(a => ({ a, act: actionFor(a) }))
    .filter(x => x.act)
    .sort((x, y) => {
      const missed = x => x.act.due?.level === 'missed';
      if (missed(x) !== missed(y)) return missed(x) ? 1 : -1;
      if (x.act.at && y.act.at) return x.act.at.localeCompare(y.act.at);
      if (x.act.at || y.act.at) return x.act.at ? -1 : 1;
      return y.a.lastActivity.localeCompare(x.a.lastActivity);
    });
  $('#action-count').textContent = items.length || '';
  $('#action-list').innerHTML = items.length
    ? items.map(({ a, act }) => {
      // Warm when it's due within a day.
      const tone = act.due && (act.due.level === 'urgent' || act.due.level === 'overdue') ? 'urgent' : '';
      return `
      <li class="action-row ${tone}" data-row="${a.id}"><div class="action-item" data-open="${a.id}" role="button" tabindex="0">
        <span class="what">
          <span class="co">${esc(a.company)}</span>
          <span class="why" style="display:block">${actionWhy(a, act)}${a.role ? ` · ${esc(a.role)}` : ''}</span>
        </span>
        <span class="action-side">${actionSideHtml(a, act)}</span>
      </div></li>`;
    }).join('')
    : `<li class="action-empty"><strong>You're all caught up.</strong>Deadlines, interviews coming up, new offers and any email nuj wasn't sure how to file show up here. Add a deadline or an interview time to an application to track it here.</li>`;
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
    try {
      await undo();
    } catch (err) {
      return toast(`Couldn't undo that: ${err.message}`);
    }
    load().catch(() => {});
  }, { once: true });
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), undo ? UNDO_SHOW_MS : 4500);
}
const UNDO_SHOW_MS = 5000;

// Everything except the stage tab: month, search and chart stage. Tab counts use it,
// so a tab's number is how many you'd see by clicking it.
const inView = a => inMonth(a) && matchesQuery(a) && (!flow || a.path.includes(flow)) && (!only || only.ids.has(a.id));

function renderTabs() {
  const counts = Object.fromEntries(TAB_ORDER.map(s => [s, 0]));
  const scoped = state.applications.filter(inView);
  scoped.forEach(a => counts[tabOf(a)]++);
  const total = scoped.length;
  const tabs = [['all', 'All', total, 'accent'], ...TAB_ORDER.map(s => [s, TAB_LABEL[s], counts[s], s])];
  // The underline is one element that stays put across renders, so it can slide.
  const strip = $('#stage-tabs');
  strip.querySelectorAll('.tab').forEach(t => t.remove());
  strip.insertAdjacentHTML('afterbegin', tabs.map(([id, label, n]) => `
    <button class="tab ${n === 0 && id !== 'all' ? 'zero' : ''}" role="tab" aria-selected="${filter === id}" data-filter="${id}" type="button"${TAB_TITLE[id] ? ` title="${TAB_TITLE[id]}"` : ''}>
      ${label}<span class="n">${n}</span>
    </button>`).join(''));
  moveTabIndicator();
  markMoreTabs();
  const bar = $('#stage-bar');
  bar.classList.toggle('filtered', filter !== 'all');
  bar.innerHTML = TAB_ORDER.filter(s => counts[s]).map(s =>
    `<span class="${filter === s ? 'on' : ''}" style="--c:${color(s)};flex-grow:${counts[s]}" title="${TAB_LABEL[s]}: ${counts[s]}"></span>`).join('');
}

// Fade the strip's right edge while there are tabs past it (see .stage-tabs.more).
function markMoreTabs() {
  const strip = $('#stage-tabs');
  strip.classList.toggle('more', strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
}
$('#stage-tabs').addEventListener('scroll', markMoreTabs, { passive: true });
window.addEventListener('resize', markMoreTabs);

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
  if (only) chips.push(['only', esc(only.label)]);
  if (flow) chips.push(['flow', `<i class="dot" style="--c:${color(flow)}"></i>${FLOW_LABEL[flow] || STAGE_LABEL[flow]}`]);
  if (filter !== 'all') chips.push(['filter', `<i class="dot" style="--c:${color(filter)}"></i>${TAB_LABEL[filter]}`]);
  if (month !== 'all') chips.push(['month', monthLabel(month)]);
  $('#results-line').textContent = !total ? '' : chips.length ? `${shown} of ${total}` : `${total}`;
  const el = $('#filter-chips');
  el.hidden = !chips.length;
  el.innerHTML = chips.map(([k, label]) =>
    `<span class="chip">${label}<button type="button" data-unfilter="${k}" aria-label="Remove this filter">${icon('x')}</button></span>`).join('') +
    (chips.length > 1 ? `<button class="chip-clear" type="button" data-unfilter="all">Clear all</button>` : '');
}
// On the No response tab: these have been silent for weeks, so offer to close them all at
// once (with Undo). Moving on is your call; nuj only marks them No response on its own.
function renderQuietNudge() {
  const el = $('#quiet-nudge');
  const quiet = filter === 'no_response' ? visibleRows : [];
  el.hidden = !quiet.length || selected.size > 0;
  if (el.hidden) return;
  el.innerHTML = `<span>No reply from these in over ${state.ghostDays} days. A short follow-up sometimes gets one; if you've moved on, close them so they stop counting as open.</span>
    <button class="btn btn-sm" type="button" id="close-quiet">Mark ${appCount(quiet.length)} as withdrawn</button>`;
}
$('#quiet-nudge').addEventListener('click', e => {
  if (!e.target.closest('#close-quiet')) return;
  const ids = visibleRows.filter(a => tabOf(a) === 'no_response').map(a => a.id);
  selected.clear();
  ids.forEach(id => selected.add(id));
  runBulk('status', { status: 'withdrawn' }, n => `${appCount(n)} marked as withdrawn`);
});

// How long since the company last wrote, for an application that's gone quiet.
const quietDays = a => {
  const last = a.events.filter(e => !e.manual).at(-1)?.date ?? a.appliedAt;
  return Math.floor((Date.now() - Date.parse(last)) / DAY_MS);
};
const quietNoteHtml = a => tabOf(a) === 'no_response'
  ? `<p class="nudge">${icon('clock')}<span>No reply in ${quietDays(a)} days. A short follow-up to the recruiter sometimes gets one. If you've moved on, set the status to Withdrawn.</span></p>` : '';

function setQuery(value) {
  query = value;
  $('#search').value = value;
  $('#search-clear').hidden = !value;
  renderTabs(); // their counts follow the search
  renderTable();
}

// Ticked rows, by id. Only rows the table is showing stay ticked, so an action never
// reaches something you can't see.
const selected = new Set();
let lastPicked = null; // where a Shift-click range starts
const appCount = n => `${n} ${n === 1 ? 'application' : 'applications'}`;

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
  const shown = new Set(rows.map(a => a.id));
  for (const id of selected) if (!shown.has(id)) selected.delete(id);
  const prev = seen;
  seen = new Map(state.applications.map(a => [a.id, a.lastActivity]));

  $('#rows').innerHTML = rows.map(a => {
    const last = latestEvent(a);
    const fresh = prev && prev.get(a.id) !== a.lastActivity;
    return `
    <tr data-id="${a.id}" tabindex="0" class="${fresh ? 'fresh' : ''}${selected.has(a.id) ? ' picked' : ''}"${rows.length <= MAX_ROWS_TO_MOVE ? ` style="view-transition-name:r-${a.id}"` : ''}>
      <td class="col-pick"><label class="pick"><input type="checkbox" data-pick="${a.id}" aria-label="Select ${esc(a.company)}"${selected.has(a.id) ? ' checked' : ''}></label></td>
      <td>
        <div class="company">
          <div style="min-width:0"><div class="name">${hl(a.company)}${a.needsReview ? `<span class="check-chip" title="An email here may be filed under the wrong application">Needs a check</span>` : ''}</div><div class="sub">${hl(a.role)}</div></div>
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
  renderSelection();
  $('#side-count').textContent = state.applications.length || '';
  const q = query.trim();
  const empty = $('#empty');
  empty.hidden = rows.length > 0;
  if (!state.applications.length) {
    empty.innerHTML = `<strong>No applications yet</strong>
      ${state.gmail.connected ? 'Application emails from Gmail will appear here automatically.' : 'Connect Gmail, or add one by hand.'}
      <div><button class="btn btn-primary" type="button" data-add>${icon('plus')}Add application</button></div>`;
  } else {
    empty.innerHTML = `<strong>No matches</strong>${q ? `Nothing matches “${esc(q)}”` : 'No applications'}${filter !== 'all' ? ` in ${TAB_LABEL[filter]}` : ''}${month !== 'all' ? ` applied in ${monthLabel(month)}` : ''}.
      ${q ? '<div class="empty-tip">Search looks through companies, roles, job IDs, your notes and email subjects.</div>' : ''}
      <div><button class="btn" type="button" data-clear>Clear filters</button></div>`;
  }
}
