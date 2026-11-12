// Problem reports: sending one, and the owner's Reports page.
// The dashboard's scripts are plain scripts loaded in order (see index.html), sharing one
// global scope: a file may use what an earlier one defines, and anything at all from inside
// functions that run later.

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
        ${r.userId ? `<button class="btn btn-sm" type="button" data-rescan-account="${esc(r.userId)}" data-who="${esc(r.email || 'this account')}" title="Read their emails again with the current sorting. Their edits are kept and a backup is made first">${icon('refresh')}Re-scan their emails</button>` : ''}
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
  const rescan = e.target.closest('[data-rescan-account]');
  if (rescan) {
    rescan.disabled = true;
    try {
      await api('POST', `/api/accounts/${encodeURIComponent(rescan.dataset.rescanAccount)}/rescan`);
      toast(`Re-scanning ${rescan.dataset.who}'s emails. Their dashboard updates as it goes`);
    } catch (err) {
      toast(err.message);
    }
    rescan.disabled = false;
    return;
  }
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
