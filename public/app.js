const STAGE_LABEL = {
  applied: 'Applied', oa: 'Assessment', interview: 'Interview', offer: 'Offer',
  rejected: 'Rejected', withdrawn: 'Withdrawn', no_response: 'No response', in_progress: 'Waiting',
};
const STATUS_ORDER = ['applied', 'oa', 'interview', 'offer', 'rejected', 'withdrawn'];
const NODE_ORDER = ['applied', 'oa', 'interview', 'offer', 'in_progress', 'no_response', 'withdrawn', 'rejected'];
const color = s => getComputedStyle(document.documentElement).getPropertyValue(`--${s}`).trim();

let state = { applications: [], gmail: {} };
let filter = 'all';
let query = '';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function timeAgo(iso) {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
const shortDate = iso => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function avatarColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 52%)`;
}
const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
const pill = s => `<span class="pill" style="--c:${color(s)}">${STAGE_LABEL[s]}</span>`;

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

// ---------------------------------------------------------------- render
function render() {
  renderGmail();
  renderStats();
  renderSankey();
  renderFilters();
  renderTable();
}

function renderGmail() {
  const g = state.gmail;
  const el = $('#gmail-status');
  const banner = $('#banner');
  banner.innerHTML = '';
  if (!g.configured) {
    el.innerHTML = `<span class="dot off"></span> Gmail not set up`;
    banner.innerHTML = `<div class="banner"><strong>Connect Gmail to auto-update.</strong>
      Put your Google OAuth <code>credentials.json</code> in the project folder and restart the server —
      see the README for the 3-minute setup. You can still add applications by hand.</div>`;
  } else if (!g.connected) {
    el.innerHTML = `<span class="dot off"></span> <a href="/auth/google">Connect Gmail</a>`;
  } else {
    const err = g.lastSyncError;
    el.innerHTML = `<span class="dot ${err ? 'err' : ''}"></span>
      Gmail · ${err ? 'sync error' : `synced ${timeAgo(g.lastSync)}`}
      <span class="muted">(${esc(g.classifier)})</span>`;
    if (err) {
      const enableUrl = err.match(/https:\/\/console\.developers\.google\.com\/apis\/api\/gmail\.googleapis\.com\/\S+?(?=\s|$)/)?.[0];
      banner.innerHTML = enableUrl
        ? `<div class="banner error"><strong>The Gmail API isn't turned on for your Google Cloud project.</strong>
            <a href="${esc(enableUrl)}" target="_blank" rel="noopener">Enable it here</a>, wait a minute, then click Sync.</div>`
        : `<div class="banner error"><strong>Last Gmail sync failed:</strong> ${esc(err.replace(/\.+$/, ''))}.
            If your sign-in expired, <a href="/auth/google">reconnect Gmail</a>.</div>`;
    }
  }
  $('#sync-btn').hidden = !g.connected;
}

function renderStats() {
  const apps = state.applications;
  const total = apps.length;
  const reached = stage => apps.filter(a => a.path.includes(stage)).length;
  const responded = apps.filter(a => a.path.some(s => s !== 'applied' && s !== 'no_response' && s !== 'in_progress' && s !== 'withdrawn')).length;
  const interviews = reached('interview') + apps.filter(a => a.path.includes('offer') && !a.path.includes('interview')).length;
  const offers = reached('offer');
  const pct = n => (total ? `${Math.round((n / total) * 100)}%` : '—');
  const active = apps.filter(a => !['offer', 'rejected', 'withdrawn'].includes(a.status)).length;
  $('#stats').innerHTML = [
    ['Applications', total, `${active} active`],
    ['Response rate', pct(responded), `${responded} heard back`],
    ['Interviews', interviews, `${pct(interviews)} of applications`],
    ['Offers', offers, `${pct(offers)} of applications`],
  ].map(([label, value, sub]) => `
    <div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`).join('');
}

function renderSankey() {
  const el = $('#sankey');
  const apps = state.applications;
  el.innerHTML = '';
  $('#flow-caption').textContent = apps.length
    ? `“No response” = no reply after ${state.ghostDays} days`
    : '';
  if (!apps.length) {
    el.innerHTML = `<div class="empty">Your application flow will appear here once you have applications.</div>`;
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

  const width = el.clientWidth;
  const height = Math.max(240, Math.min(440, 140 + nodes.length * 34));
  const labelSpace = width < 600 ? 90 : 130;
  const sankey = d3.sankey()
    .nodeId(d => d.id)
    .nodeWidth(14)
    .nodePadding(22)
    .nodeSort((a, b) => NODE_ORDER.indexOf(a.id) - NODE_ORDER.indexOf(b.id))
    .extent([[2, 8], [width - labelSpace, height - 8]]);
  const graph = sankey({ nodes: nodes.map(d => ({ ...d })), links: links.map(d => ({ ...d })) });

  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('height', height);
  const defs = svg.append('defs');

  svg.append('g').selectAll('path').data(graph.links).join('path')
    .attr('class', 'link')
    .attr('d', d3.sankeyLinkHorizontal())
    .attr('stroke', (d, i) => {
      const id = `grad-${i}`;
      const g = defs.append('linearGradient').attr('id', id).attr('gradientUnits', 'userSpaceOnUse')
        .attr('x1', d.source.x1).attr('x2', d.target.x0);
      g.append('stop').attr('offset', '0%').attr('stop-color', color(d.source.id));
      g.append('stop').attr('offset', '100%').attr('stop-color', color(d.target.id));
      return `url(#${id})`;
    })
    .attr('stroke-width', d => Math.max(1.5, d.width))
    .append('title').text(d => `${STAGE_LABEL[d.source.id]} → ${STAGE_LABEL[d.target.id]}: ${d.value}`);

  const node = svg.append('g').selectAll('g').data(graph.nodes).join('g').attr('class', 'node');
  node.append('rect')
    .attr('x', d => d.x0).attr('y', d => d.y0)
    .attr('width', d => d.x1 - d.x0).attr('height', d => Math.max(3, d.y1 - d.y0))
    .attr('fill', d => color(d.id))
    .style('cursor', 'pointer')
    .on('click', (e, d) => { filterByNode(d.id); });
  const label = node.append('text')
    .attr('class', 'node-label')
    .attr('x', d => d.x1 + 8)
    .attr('y', d => (d.y0 + d.y1) / 2)
    .attr('dy', '0.35em');
  label.append('tspan').text(d => STAGE_LABEL[d.id] + ' ');
  label.append('tspan').attr('class', 'node-count').text(d => d.value);
}

function filterByNode(id) {
  filter = STATUS_ORDER.includes(id) ? id : id === 'no_response' || id === 'in_progress' ? 'applied' : 'all';
  renderFilters();
  renderTable();
  $('#filters').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderFilters() {
  const counts = Object.fromEntries(STATUS_ORDER.map(s => [s, 0]));
  state.applications.forEach(a => counts[a.status]++);
  const chips = [['all', 'All', state.applications.length], ...STATUS_ORDER.map(s => [s, STAGE_LABEL[s], counts[s]])];
  $('#filters').innerHTML = chips.map(([id, label, n]) =>
    `<button class="chip ${filter === id ? 'active' : ''}" data-filter="${id}">${label} <span class="n">${n}</span></button>`).join('');
}

function renderTable() {
  const q = query.toLowerCase();
  const rows = state.applications
    .filter(a => filter === 'all' || a.status === filter)
    .filter(a => !q || [a.company, a.role, a.jobId].some(v => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

  $('#rows').innerHTML = rows.map(a => `
    <tr data-id="${a.id}">
      <td><div class="company"><span class="avatar" style="background:${avatarColor(a.company)}">${esc(initials(a.company))}</span>${esc(a.company)}</div></td>
      <td><div class="role">${esc(a.role) || '<span class="muted">—</span>'}</div>${a.jobId ? `<div class="jobid">ID ${esc(a.jobId)}</div>` : ''}</td>
      <td>${pill(a.status)}</td>
      <td>${shortDate(a.appliedAt)}</td>
      <td>${timeAgo(a.lastActivity)}</td>
      <td class="source">${a.source === 'gmail' ? '✉ Gmail' : 'Manual'}</td>
    </tr>`).join('');

  const empty = $('#empty');
  empty.hidden = rows.length > 0;
  empty.textContent = state.applications.length
    ? 'No applications match this filter.'
    : state.gmail.connected
      ? 'No applications yet. New application emails will show up here automatically.'
      : 'No applications yet. Connect Gmail or add one manually.';
}

// ---------------------------------------------------------------- drawer
function openDrawer(app) {
  const isNew = !app;
  const a = app || { company: '', role: '', jobId: '', url: '', notes: '', status: 'applied', events: [] };
  const timeline = [...a.events].reverse().map(e => `
    <li style="--c:${color(e.stage)}">
      <span class="tdot"></span>
      <div class="tsubject">${esc(e.subject || STAGE_LABEL[e.stage])}</div>
      <div class="tmeta">${STAGE_LABEL[e.stage]} · ${new Date(e.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}${e.from ? ` · ${esc(e.from.replace(/<.*>/, '').trim())}` : ''}</div>
      ${e.messageId ? `<a href="https://mail.google.com/mail/u/0/#all/${e.messageId}" target="_blank" rel="noopener">Open in Gmail ↗</a>` : ''}
    </li>`).join('');

  $('#drawer').innerHTML = `
    <div class="drawer-head">
      <h2>${isNew ? 'Add application' : esc(a.company)}</h2>
      <button class="close" data-close aria-label="Close">×</button>
    </div>
    <form class="drawer-body" id="app-form">
      <div class="field"><label>Company</label><input name="company" required value="${esc(a.company)}"></div>
      <div class="field"><label>Role</label><input name="role" value="${esc(a.role)}"></div>
      <div class="field"><label>Job ID</label><input name="jobId" value="${esc(a.jobId)}" placeholder="e.g. R-574294"></div>
      <div class="field"><label>Status</label>
        <select name="status">${STATUS_ORDER.map(s => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${STAGE_LABEL[s]}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Job posting URL</label><input name="url" type="url" value="${esc(a.url)}" placeholder="https://"></div>
      <div class="field"><label>Notes</label><textarea name="notes">${esc(a.notes)}</textarea></div>
      ${isNew ? '' : `<div class="section-title">Timeline</div><ul class="timeline">${timeline}</ul>`}
    </form>
    <div class="drawer-foot">
      ${isNew ? '<span></span>' : '<button class="btn btn-danger" id="delete-btn">Delete</button>'}
      <div style="display:flex;gap:8px">
        <button class="btn" data-close>Cancel</button>
        <button class="btn btn-primary" id="save-btn">${isNew ? 'Add' : 'Save'}</button>
      </div>
    </div>`;

  $('#save-btn').onclick = async () => {
    const form = $('#app-form');
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form));
    try {
      if (isNew) await api('POST', '/api/applications', data);
      else await api('PATCH', `/api/applications/${a.id}`, data);
      closeDrawer();
      load();
    } catch (err) { alert(err.message); }
  };
  if (!isNew) {
    $('#delete-btn').onclick = async () => {
      if (!confirm(`Delete ${a.company}${a.role ? ` – ${a.role}` : ''}?`)) return;
      await api('DELETE', `/api/applications/${a.id}`);
      closeDrawer();
      load();
    };
  }
  $('#scrim').hidden = false;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#drawer input[name=company]').focus();
}

function closeDrawer() {
  $('#scrim').hidden = true;
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
}

// ---------------------------------------------------------------- events
$('#add-btn').onclick = () => openDrawer(null);
$('#scrim').onclick = closeDrawer;
$('#drawer').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeDrawer(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
$('#rows').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openDrawer(state.applications.find(a => a.id === tr.dataset.id));
});
$('#filters').addEventListener('click', e => {
  const chip = e.target.closest('[data-filter]');
  if (!chip) return;
  filter = chip.dataset.filter;
  renderFilters();
  renderTable();
});
$('#search').addEventListener('input', e => { query = e.target.value; renderTable(); });
$('#sync-btn').onclick = async () => {
  const btn = $('#sync-btn');
  btn.disabled = true;
  btn.textContent = '↻ Syncing…';
  try { await api('POST', '/api/sync'); } catch (err) { /* shown via banner */ }
  btn.disabled = false;
  btn.textContent = '↻ Sync';
  load();
};

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderSankey, 150); });

// Live updates: the server pings whenever a sync or edit changes the data.
new EventSource('/api/events').onmessage = () => load();
// Keep relative times ("synced 2m ago") fresh.
setInterval(renderGmail, 30_000);

load();
