const STAGE_LABEL = {
  applied: 'Applied', oa: 'Assessment', interview: 'Interview', offer: 'Offer',
  rejected: 'Rejected', withdrawn: 'Withdrawn', no_response: 'No response', in_progress: 'Waiting',
};
const STATUS_ORDER = ['applied', 'oa', 'interview', 'offer', 'rejected', 'withdrawn'];
const NODE_ORDER = ['applied', 'oa', 'interview', 'offer', 'in_progress', 'no_response', 'withdrawn', 'rejected'];
// Stages where the next move is usually yours.
const ACTION_STAGES = { oa: 'Assessment to complete', interview: 'Interview in progress', offer: 'Offer to respond to' };

const color = s => getComputedStyle(document.documentElement).getPropertyValue(`--${s}`).trim();

let state = { applications: [], gmail: {} };
let filter = 'all';
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

function avatarColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 52% 50%)`;
}
const initials = name => name.replace(/[^\p{L}\p{N}\s&]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
const avatar = (name, size = '') => `<span class="avatar ${size}" style="background:${avatarColor(name)}" aria-hidden="true">${esc(initials(name))}</span>`;
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
  state = await fetch('/api/state').then(r => r.json());
  render();
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

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
  if (openId) refreshDrawerTimeline();
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
  const banner = $('#banner');
  banner.innerHTML = '';
  if (!g.configured) {
    el.innerHTML = `<span class="dot off"></span> Gmail not set up`;
    banner.innerHTML = `<div class="banner">${icon('mail')}<div><strong>Connect Gmail to update automatically.</strong>
      Put your Google OAuth <code>credentials.json</code> in the project folder and restart; the README has the
      3-minute setup. You can still add applications by hand.</div></div>`;
  } else if (!g.connected) {
    el.innerHTML = `<span class="dot off"></span> <a href="/auth/google">Connect Gmail</a>`;
  } else {
    const err = g.lastSyncError;
    el.innerHTML = `<span class="dot ${err ? 'err' : ''}"></span>
      <span>${err ? 'Sync failed' : `Synced ${timeAgo(g.lastSync)}`}</span>
      <span class="via">· ${esc(g.classifier)}</span>`;
    if (err) {
      const enableUrl = err.match(/https:\/\/console\.developers\.google\.com\/apis\/api\/gmail\.googleapis\.com\/\S+?(?=\s|$)/)?.[0];
      banner.innerHTML = `<div class="banner error">${icon('alert')}<div>${enableUrl
        ? `<strong>The Gmail API isn't turned on for your Google Cloud project.</strong>
           <a href="${esc(enableUrl)}" target="_blank" rel="noopener">Turn it on</a>, wait a minute, then click Sync.`
        : `<strong>Gmail sync failed:</strong> ${esc(err.replace(/\.+$/, ''))}.
           If your sign-in expired, <a href="/auth/google">reconnect Gmail</a>.`}</div></div>`;
    }
  }
  $('#sync-btn').hidden = !g.connected;
}

function renderSummary() {
  const apps = state.applications;
  const el = $('#summary-line');
  if (!apps.length) {
    el.textContent = state.gmail.connected
      ? 'No applications found yet. New application emails will appear here automatically.'
      : 'Add your first application, or connect Gmail to fill this in automatically.';
    return;
  }
  const heard = apps.filter(a => a.status !== 'applied' || a.events.some(e => e.stage !== 'applied')).length;
  const active = apps.filter(a => !['offer', 'rejected', 'withdrawn'].includes(a.status)).length;
  const reachedInterview = apps.filter(a => a.path.includes('interview') || a.status === 'offer').length;
  const offers = apps.filter(a => a.status === 'offer').length;
  const since = apps.map(a => a.appliedAt).sort()[0];
  const parts = [
    `<strong class="num">${apps.length}</strong> applications since ${shortDate(since)}`,
    `<strong class="num">${Math.round((heard / apps.length) * 100)}%</strong> heard back`,
    `<strong class="num">${active}</strong> still open`,
    `<strong class="num">${reachedInterview}</strong> reached interview`,
  ];
  if (offers) parts.push(`<strong class="num">${offers}</strong> ${offers === 1 ? 'offer' : 'offers'}`);
  el.innerHTML = parts.join('<span class="sep" aria-hidden="true">/</span>');
}

function renderSankey() {
  const apps = state.applications;
  $('#flow-caption').textContent = apps.length ? `No reply after ${state.ghostDays} days counts as “No response”` : '';
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
function drawSankey(el, apps, { large }) {
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
    .extent([[1, 6], [width - labelSpace, height - 6]])({ nodes: nodes.map(d => ({ ...d })), links: links.map(d => ({ ...d })) });

  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('height', height)
    .attr('role', 'img').attr('aria-label', 'Flow of applications between stages');
  const defs = svg.append('defs');

  svg.append('g').selectAll('path').data(graph.links).join('path')
    .attr('class', 'link')
    .attr('d', d3.sankeyLinkHorizontal())
    .attr('stroke', (d, i) => {
      const id = `grad-${large ? 'l' : 's'}-${i}`;
      const g = defs.append('linearGradient').attr('id', id).attr('gradientUnits', 'userSpaceOnUse')
        .attr('x1', d.source.x1).attr('x2', d.target.x0);
      g.append('stop').attr('offset', '0%').attr('stop-color', color(d.source.id));
      g.append('stop').attr('offset', '100%').attr('stop-color', color(d.target.id));
      return `url(#${id})`;
    })
    .attr('stroke-width', d => Math.max(1.5, d.width))
    .append('title').text(d =>
      `${STAGE_LABEL[d.source.id]} → ${STAGE_LABEL[d.target.id]}: ${d.value} (${Math.round((d.value / d.source.value) * 100)}% of ${STAGE_LABEL[d.source.id]})`);

  const total = apps.length;
  const node = svg.append('g').selectAll('g').data(graph.nodes).join('g').attr('class', 'node');
  if (large) {
    node.attr('tabindex', 0)
      .attr('role', 'button')
      .attr('aria-label', d => `${STAGE_LABEL[d.id]}: ${d.value}. Show in table`)
      .on('click', (e, d) => filterByNode(d.id))
      .on('keydown', (e, d) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); filterByNode(d.id); } });
  }
  node.append('rect')
    .attr('x', d => d.x0).attr('y', d => d.y0)
    .attr('width', d => d.x1 - d.x0).attr('height', d => Math.max(3, d.y1 - d.y0))
    .attr('rx', 3)
    .attr('fill', d => color(d.id));
  const label = node.append('text')
    .attr('class', 'node-label')
    .attr('x', d => d.x1 + 8)
    .attr('y', d => (d.y0 + d.y1) / 2)
    .attr('dy', '0.35em');
  label.append('tspan').text(d => STAGE_LABEL[d.id] + '  ');
  label.append('tspan').attr('class', 'node-count')
    .text(d => d.id === 'applied' || narrow ? d.value : `${d.value} · ${Math.round((d.value / total) * 100)}%`);
}

function filterByNode(id) {
  filter = STATUS_ORDER.includes(id) ? id : (id === 'no_response' || id === 'in_progress') ? 'applied' : 'all';
  month = 'all'; // the chart covers every month
  if ($('#flow-dialog').open) $('#flow-dialog').close();
  renderMonths();
  renderTabs();
  renderTable();
  $('#apps-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderActions() {
  const items = state.applications
    .filter(a => ACTION_STAGES[a.status])
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  $('#action-count').textContent = items.length || '';
  $('#action-list').innerHTML = items.length
    ? items.map(a => `
      <li><button class="action-item" data-open="${a.id}" type="button">
        ${avatar(a.company, 'sm')}
        <span class="what">
          <span class="co">${esc(a.company)}</span>
          <span class="why" style="display:block">${ACTION_STAGES[a.status]}${a.role ? ` · ${esc(a.role)}` : ''}</span>
        </span>
        <span class="age">${timeAgo(a.lastActivity)}</span>
      </button></li>`).join('')
    : `<li class="action-empty">Nothing waiting on you right now. Assessments, interviews and offers show up here as their emails arrive.</li>`;
}

function renderTabs() {
  const counts = Object.fromEntries(STATUS_ORDER.map(s => [s, 0]));
  const scoped = state.applications.filter(inMonth);
  scoped.forEach(a => counts[a.status]++);
  const total = scoped.length;
  const tabs = [['all', 'All', total, 'accent'], ...STATUS_ORDER.map(s => [s, STAGE_LABEL[s], counts[s], s])];
  $('#stage-tabs').innerHTML = tabs.map(([id, label, n, c]) => `
    <button class="tab ${n === 0 && id !== 'all' ? 'zero' : ''}" role="tab" aria-selected="${filter === id}" data-filter="${id}" type="button">
      ${id === 'all' ? '' : `<span class="dot" style="--c:${color(c)}"></span>`}${label}<span class="n">${n}</span>
    </button>`).join('');
  const bar = $('#stage-bar');
  bar.classList.toggle('filtered', filter !== 'all');
  bar.innerHTML = STATUS_ORDER.filter(s => counts[s]).map(s =>
    `<span class="${filter === s ? 'on' : ''}" style="--c:${color(s)};flex-grow:${counts[s]}" title="${STAGE_LABEL[s]}: ${counts[s]}"></span>`).join('');
}

function sortValue(a, key) {
  if (key === 'status') return STATUS_ORDER.indexOf(a.status);
  if (key === 'company') return a.company.toLowerCase();
  return a[key] || '';
}

function renderTable() {
  const q = query.trim().toLowerCase();
  const rows = state.applications
    .filter(inMonth)
    .filter(a => filter === 'all' || a.status === filter)
    .filter(a => !q || [a.company, a.role, a.jobId].some(v => (v || '').toLowerCase().includes(q)))
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
    <tr data-id="${a.id}" tabindex="0" class="${fresh ? 'fresh' : ''}">
      <td>
        <div class="company">${avatar(a.company)}
          <div style="min-width:0"><div class="name">${esc(a.company)}</div><div class="sub">${esc(a.role)}</div></div>
        </div>
      </td>
      <td class="col-role">
        <div class="role">${a.role ? esc(a.role) : '<span class="dim">No role found</span>'}</div>
        ${a.jobId ? `<div class="jobid">ID ${esc(a.jobId)}</div>` : ''}
      </td>
      <td>${statusSelect(a)}</td>
      <td class="col-applied date">${shortDate(a.appliedAt)}</td>
      <td class="col-latest latest">
        <div class="when">${timeAgo(a.lastActivity)}</div>
        ${last?.subject ? `<div class="what" title="${esc(decode(last.subject))}">${esc(decode(last.subject))}</div>` : ''}
      </td>
    </tr>`;
  }).join('');

  document.querySelectorAll('.sort').forEach(b => {
    b.classList.toggle('asc', b.dataset.sort === sort.key && sort.dir === 'asc');
    b.classList.toggle('desc', b.dataset.sort === sort.key && sort.dir === 'desc');
    b.closest('th').setAttribute('aria-sort', b.dataset.sort === sort.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });

  const empty = $('#empty');
  empty.hidden = rows.length > 0;
  if (!state.applications.length) {
    empty.innerHTML = `<strong>No applications yet</strong>
      ${state.gmail.connected ? 'Application emails from Gmail will appear here automatically.' : 'Connect Gmail, or add one by hand.'}
      <div><button class="btn btn-primary" type="button" data-add>${icon('plus')}Add application</button></div>`;
  } else {
    empty.innerHTML = `<strong>No matches</strong>${q ? `Nothing matches “${esc(query.trim())}”` : 'No applications'}${filter !== 'all' ? ` in ${STAGE_LABEL[filter]}` : ''}${month !== 'all' ? ` applied in ${monthLabel(month)}` : ''}.
      <div><button class="btn" type="button" data-clear>Clear filters</button></div>`;
  }
}

// ---------------------------------------------------------------- drawer
let openId = null;
let lastFocus = null;

function timelineHtml(a) {
  return [...a.events].reverse().map(e => `
    <li style="--c:${color(e.stage)}">
      <span class="tdot"></span>
      <div class="thead">
        <span class="tstage">${STAGE_LABEL[e.stage]}${e.manual ? ' · set by you' : ''}</span>
        <span class="tdate">${new Date(e.date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
      </div>
      <div class="tsubject">${esc(decode(e.subject || STAGE_LABEL[e.stage]))}</div>
      ${e.snippet ? `<div class="tsnippet">${esc(decode(e.snippet))}</div>` : ''}
      ${e.messageId ? `<a class="tlink" href="https://mail.google.com/mail/u/0/#all/${e.messageId}" target="_blank" rel="noopener">Open in Gmail ${icon('external')}</a>` : ''}
    </li>`).join('');
}

function refreshDrawerTimeline() {
  const a = state.applications.find(x => x.id === openId);
  const list = $('#drawer .timeline');
  if (a && list) list.innerHTML = timelineHtml(a);
}

function openDrawer(app) {
  const isNew = !app;
  const a = app || { company: '', role: '', jobId: '', url: '', notes: '', status: 'applied', events: [] };
  openId = isNew ? null : a.id;
  lastFocus = document.activeElement;

  $('#drawer').innerHTML = `
    <div class="drawer-head">
      <div class="drawer-title">
        ${isNew ? '' : avatar(a.company, 'lg')}
        <div class="t">
          <h2 id="drawer-title">${isNew ? 'Add application' : esc(a.company)}</h2>
          ${isNew ? '<div class="s">Track a job you applied to outside Gmail</div>' : `<div class="s">${esc(a.role) || 'No role found'}</div>`}
        </div>
        <button class="icon-btn" data-close type="button" aria-label="Close">${icon('x')}</button>
      </div>
      ${isNew ? '' : `<div class="drawer-meta">
        ${pill(a.status)}
        ${a.jobId ? `<span class="num">ID ${esc(a.jobId)}</span>` : ''}
        <span>Applied ${shortDate(a.appliedAt)}</span>
        ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${icon('link')}Job posting</a>` : ''}
      </div>`}
    </div>
    <div class="drawer-body">
      <form id="app-form" novalidate>
        <div class="section-title">Details</div>
        <div class="fields">
          <div class="field"><label for="f-company">Company</label><input id="f-company" name="company" required value="${esc(a.company)}" placeholder="e.g. Stripe"></div>
          <div class="field"><label for="f-status">Status</label>
            <select id="f-status" name="status">${STATUS_ORDER.map(s => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${STAGE_LABEL[s]}</option>`).join('')}</select>
          </div>
          <div class="field wide"><label for="f-role">Role</label><input id="f-role" name="role" value="${esc(a.role)}" placeholder="e.g. Software Engineer Intern"></div>
          <div class="field"><label for="f-jobid">Job ID</label><input id="f-jobid" name="jobId" value="${esc(a.jobId)}" placeholder="e.g. R-574294"></div>
          <div class="field"><label for="f-url">Job posting link</label><input id="f-url" name="url" type="url" value="${esc(a.url)}" placeholder="https://"></div>
          <div class="field wide"><label for="f-notes">Notes</label><textarea id="f-notes" name="notes" placeholder="Referral, recruiter name, salary range…">${esc(a.notes)}</textarea></div>
        </div>
      </form>
      ${isNew ? '' : `<div><div class="section-title">Timeline</div><ul class="timeline">${timelineHtml(a)}</ul></div>`}
    </div>
    <div class="drawer-foot">
      ${isNew ? '<span></span>' : `<button class="btn btn-danger" id="delete-btn" type="button">${icon('trash')}Delete</button>`}
      <div class="right">
        <span id="saved-note"></span>
        <button class="btn" data-close type="button">${isNew ? 'Cancel' : 'Close'}</button>
        <button class="btn btn-primary" id="save-btn" type="button" ${isNew ? '' : 'disabled'}>${isNew ? 'Add application' : 'Save changes'}</button>
      </div>
    </div>`;

  const form = $('#app-form');
  const saveBtn = $('#save-btn');
  const initial = JSON.stringify(Object.fromEntries(new FormData(form)));
  form.addEventListener('input', () => {
    if (!isNew) saveBtn.disabled = JSON.stringify(Object.fromEntries(new FormData(form))) === initial;
    $('#saved-note').innerHTML = '';
  });
  form.addEventListener('submit', e => { e.preventDefault(); saveBtn.click(); });

  saveBtn.onclick = async () => {
    const companyInput = $('#f-company');
    if (!companyInput.value.trim()) { companyInput.focus(); companyInput.setCustomValidity('Company is required'); companyInput.reportValidity(); companyInput.setCustomValidity(''); return; }
    const data = Object.fromEntries(new FormData(form));
    saveBtn.disabled = true;
    try {
      if (isNew) {
        await api('POST', '/api/applications', data);
        closeDrawer();
      } else {
        const updated = await api('PATCH', `/api/applications/${a.id}`, data);
        await load();
        openDrawer(state.applications.find(x => x.id === updated.id));
        $('#saved-note').innerHTML = `<span class="saved-note">${icon('check')}Saved</span>`;
        return;
      }
      await load();
    } catch (err) {
      saveBtn.disabled = false;
      $('#saved-note').innerHTML = `<span class="saved-note" style="color:var(--danger)">${esc(err.message)}</span>`;
    }
  };

  if (!isNew) {
    const del = $('#delete-btn');
    del.onclick = async () => {
      if (!del.classList.contains('confirming')) {
        del.classList.add('confirming');
        del.innerHTML = `${icon('trash')}Click again to delete`;
        setTimeout(() => { if (del.isConnected) { del.classList.remove('confirming'); del.innerHTML = `${icon('trash')}Delete`; } }, 4000);
        return;
      }
      await api('DELETE', `/api/applications/${a.id}`);
      closeDrawer();
      load();
    };
  }

  $('#scrim').hidden = false;
  const drawer = $('#drawer');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  (isNew ? $('#f-company') : drawer.querySelector('[data-close]')).focus();
}

function closeDrawer() {
  openId = null;
  $('#scrim').hidden = true;
  const drawer = $('#drawer');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  lastFocus?.focus?.();
}

// ---------------------------------------------------------------- events
const openById = id => openDrawer(state.applications.find(a => a.id === id));

$('#add-btn').onclick = () => openDrawer(null);
$('#scrim').onclick = closeDrawer;
$('#drawer').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeDrawer(); });
$('#action-list').addEventListener('click', e => {
  const item = e.target.closest('[data-open]');
  if (item) openById(item.dataset.open);
});

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
  if (sel) setStatus(sel.dataset.statusFor, sel.value);
});

$('#stage-tabs').addEventListener('click', e => {
  const tab = e.target.closest('[data-filter]');
  if (!tab) return;
  filter = tab.dataset.filter;
  renderTabs();
  renderTable();
});
document.querySelector('thead').addEventListener('click', e => {
  const b = e.target.closest('.sort');
  if (!b) return;
  const key = b.dataset.sort;
  sort = sort.key === key
    ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: key === 'company' || key === 'status' ? 'asc' : 'desc' };
  renderTable();
});
$('#empty').addEventListener('click', e => {
  if (e.target.closest('[data-add]')) openDrawer(null);
  if (e.target.closest('[data-clear]')) {
    filter = 'all'; month = 'all'; query = ''; $('#search').value = '';
    renderMonths(); renderTabs(); renderTable();
  }
});
$('#month').addEventListener('change', e => {
  month = e.target.value;
  renderMonths();
  renderTabs();
  renderTable();
});

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
$('#sankey').addEventListener('click', openFlowDialog);
$('#expand-flow').addEventListener('click', openFlowDialog);
$('#flow-dialog').addEventListener('click', e => {
  // Clicks on the backdrop land on the <dialog> element itself.
  if (e.target === e.currentTarget || e.target.closest('[data-close-dialog]')) e.currentTarget.close();
});
$('#search').addEventListener('input', e => { query = e.target.value; renderTable(); });

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#drawer').classList.contains('open')) closeDrawer();
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === '/' && !typing && !$('#drawer').classList.contains('open') && !$('#flow-dialog').open) {
    e.preventDefault();
    $('#search').focus();
  }
});

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
// Chart colours come from CSS variables, so redraw when the system theme flips.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);

// Live updates: the server pings whenever a sync or edit changes the data.
new EventSource('/api/events').onmessage = () => load();
// Keep relative times ("synced 2m ago") fresh.
setInterval(renderGmail, 30_000);

load();
