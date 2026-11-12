// The owner's Developer page: server health, accounts, feedback and errors.
// The dashboard's scripts are plain scripts loaded in order (see index.html), sharing one
// global scope: a file may use what an earlier one defines, and anything at all from inside
// functions that run later.

// ---------------------------------------------------------------- developer page
// The owner's view of every account and everything that went wrong. Accounts show
// counts and dates only, never anyone's applications or emails.
let dev = { server: null, accounts: [], errors: [] };
let accountFilter = 'all';
let errorFilter = 'open';
let errorSource = 'all';
const devOpen = new Set(); // rows expanded: 'a:<id>' for accounts, 'e:<id>' for errors
let devPoll = null;

async function loadDeveloper() {
  try {
    dev = await api('GET', '/api/dev/overview');
  } catch {
    location.hash = '#/'; // not the owner
    return;
  }
  renderHealth();
  renderAccounts();
  renderFeedbackResults();
  renderErrors();
  // While something is re-scanning, keep its progress moving; otherwise live updates do.
  clearTimeout(devPoll);
  if (view === 'developer' && dev.accounts.some(a => a.busy) && !dev.server.demo) devPoll = setTimeout(loadDeveloper, 5000);
}

// A status dot (after 21st.dev's Status Dot): a steady colour, and a slow ripple only while
// something is actually happening, so motion always means "working on it".
const TONE = { ok: 'offer', warn: 'interview', err: 'rejected', off: 'withdrawn', busy: 'oa' };
const sdot = (tone, label = '') => `<span class="sdot${tone === 'busy' ? ' live' : ''}" style="--c:var(--${TONE[tone]})"${label ? ` role="img" aria-label="${esc(label)}"` : ' aria-hidden="true"'}></span>`;

const duration = ms => {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};

function renderHealth() {
  const s = dev.server;
  const cronAge = s.lastCronAt ? Date.now() - Date.parse(s.lastCronAt) : null;
  // A free Render service sleeps without the pinger; it should call every ~10 minutes.
  const cronTone = s.demo || !s.cronConfigured ? 'off' : cronAge === null || cronAge > 25 * 60_000 ? 'warn' : 'ok';
  const items = [
    ['Server', `${sdot('ok')}Up ${duration(Date.now() - Date.parse(s.startedAt))}`, `Since ${new Date(s.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`],
    ['Version', s.version ? `<span class="mono">${esc(s.version)}</span>` : 'Local', `Node ${esc(s.node)}`],
    ['Storage', { postgres: 'Postgres', files: 'Local files', memory: 'Memory' }[s.storage], `${s.memoryMb} MB in use`],
    ['Sync round', s.demo ? 'Off in demo' : s.lastSyncPassAt ? timeAgo(s.lastSyncPassAt) : 'Not yet', `Every ${s.syncMinutes} min while awake`],
    ['Pinger', `${sdot(cronTone)}${s.demo ? 'Off in demo' : !s.cronConfigured ? 'Not set up' : s.lastCronAt ? timeAgo(s.lastCronAt) : 'No call yet'}`,
      s.cronConfigured || s.demo ? 'Keeps the free service awake' : 'Set CRON_SECRET (docs/DEPLOY.md)'],
    // Resume insights' AI runs on the server's OpenAI key, so its use is worth watching.
    ['Resume AI', s.insights.available ? `${sdot(s.insights.runs >= s.insights.serverLimit ? 'warn' : 'ok')}${s.insights.runs} of ${s.insights.serverLimit} today` : `${sdot('off')}Not set up`,
      s.insights.available ? `${s.insights.limited} hit the limit of ${s.insights.dailyLimit} · ${s.insights.withResume} with a resume` : 'Set OPENAI_API_KEY (docs/DEPLOY.md)'],
  ];
  $('#dev-health').innerHTML = items.map(([k, v, sub]) => `<div><dt>${k}</dt><dd><span class="v">${v}</span><span class="sub">${sub}</span></dd></div>`).join('');
}

// ---- accounts
const GMAIL_STATE = { connected: ['ok', 'Connected'], expired: ['err', 'Sign-in expired'], off: ['off', 'Not connected'] };
function accountGmail(a) {
  if (a.busy) {
    const what = a.busy.mode === 'rescan' ? 'Re-scanning' : 'Syncing';
    return `${sdot('busy')}<span>${what}${a.busy.total ? ` <span class="num dim">${a.busy.done}/${a.busy.total}</span>` : ''}</span>`;
  }
  const [tone, label] = GMAIL_STATE[a.gmail];
  return `${sdot(tone)}<span>${label}</span>`;
}
function accountSorting(a) {
  const s = a.sorting;
  if (s.problem === 'rejected') return '<span class="bad">Groq key rejected</span>';
  if (s.problem === 'unreadable') return '<span class="bad">Groq key unreadable</span>';
  if (s.by === 'groq') return `Groq<span class="dim"> · ${s.key === 'server' ? 'server key' : 'own key'}</span>`;
  return a.setupDone ? 'Rules' : '<span class="dim">Not chosen yet</span>';
}
const ACCOUNT_TABS = [
  ['all', 'With access', a => a.allowed],
  ['attention', 'Needs you', a => a.attention.length > 0],
  ['quiet', 'Away 2+ weeks', a => a.allowed && (!a.lastSeenAt || Date.now() - Date.parse(a.lastSeenAt) > 14 * 86_400_000)],
  ['removed', 'No access', a => !a.allowed],
];
function renderAccounts() {
  const all = dev.accounts;
  const attention = all.filter(a => a.attention.length).length;
  $('#accounts-hint').textContent = `${all.filter(a => a.allowed).length} with access${attention ? ` · ${attention} need${attention === 1 ? 's' : ''} you` : ''}`;
  $('#account-tabs').innerHTML = ACCOUNT_TABS.map(([id, label, fits]) =>
    `<button class="tab" role="tab" type="button" aria-selected="${accountFilter === id}" data-account-filter="${id}">${label}<span class="n">${all.filter(fits).length}</span></button>`).join('');
  const q = $('#accounts-search').value.trim().toLowerCase();
  const fits = ACCOUNT_TABS.find(t => t[0] === accountFilter)[2];
  // Who needs you first, then whoever was around most recently.
  const shown = all.filter(a => fits(a) && (!q || (a.email || '').toLowerCase().includes(q)))
    .sort((a, b) => (b.attention.length > 0) - (a.attention.length > 0) || (b.lastSeenAt || '').localeCompare(a.lastSeenAt || ''));
  $('#account-rows').innerHTML = shown.length ? shown.map(accountRow).join('')
    : `<tr><td colspan="7"><div class="empty"><strong>${q ? 'No account matches' : accountFilter === 'attention' ? 'Every account is working' : 'No one here'}</strong>${q ? 'Try part of the address.' : 'Accounts show up once someone signs in.'}</div></td></tr>`;
}
function accountTone(a) {
  if (!a.allowed) return 'off';
  if (a.gmail === 'expired' || a.lastSyncError || a.sorting.problem) return 'err';
  return a.attention.length ? 'warn' : 'ok';
}
function accountRow(a) {
  const open = devOpen.has(`a:${a.id}`);
  const errs = dev.errors.filter(g => g.users.includes(a.id));
  const canRead = a.allowed && a.gmail === 'connected' && a.setupDone;
  return `
    <tr class="dev-row${open ? ' open' : ''}${a.allowed ? '' : ' gone'}" data-account="${esc(a.id)}" tabindex="0" aria-expanded="${open}">
      <td><div class="who">${sdot(accountTone(a), a.attention[0] || (a.allowed ? 'Working' : 'No access'))}<div class="who-t">
        <span class="who-email">${esc(a.email || a.id)}</span>
        <span class="who-sub">${a.owner ? 'You · ' : ''}${a.attention.length
          ? `<span class="${accountTone(a) === 'err' ? 'bad' : 'warn'}">${esc(a.attention[0])}</span>${a.attention.length > 1 ? ` <span class="dim">+${a.attention.length - 1} more</span>` : ''}`
          : a.joinedAt ? `Joined ${shortDate(a.joinedAt)}` : ''}</span>
      </div></div></td>
      <td class="date">${a.lastSeenAt ? timeAgo(a.lastSeenAt) : '<span class="dim">Never</span>'}</td>
      <td><div class="state">${accountGmail(a)}</div></td>
      <td class="sorting">${accountSorting(a)}</td>
      <td class="n-col num">${a.applications}<span class="dim"> · ${a.emails} emails</span></td>
      <td class="date">${a.lastSyncError ? `<span class="bad" title="${esc(a.lastSyncError)}">Failed</span>` : a.lastSync ? timeAgo(a.lastSync) : '<span class="dim">Never</span>'}</td>
      <td class="chev">${icon('chevron')}</td>
    </tr>
    <tr class="dev-more${open ? ' open' : ''}" aria-hidden="${!open}"><td colspan="7"><div class="reveal"><div>
      <div class="dev-detail">
        <dl>
          ${a.attention.length ? `<dt>Needs you</dt><dd>${a.attention.map(esc).join(' · ')}</dd>` : ''}
          ${a.lastSyncError ? `<dt>Last sync error</dt><dd class="mono">${esc(a.lastSyncError)}</dd>` : ''}
          <dt>Joined</dt><dd>${a.joinedAt ? new Date(a.joinedAt).toLocaleString() : '—'}</dd>
          <dt>Last seen</dt><dd>${a.lastSeenAt ? new Date(a.lastSeenAt).toLocaleString() : 'Never'}</dd>
          <dt>Last sync</dt><dd>${a.lastSync ? new Date(a.lastSync).toLocaleString() : 'Never'}</dd>
          <dt>To check</dt><dd>${a.toCheck ? `${a.toCheck} application${a.toCheck === 1 ? '' : 's'} with an email to confirm` : 'Nothing'}</dd>
          ${errs.length ? `<dt>Errors</dt><dd><button class="link-btn" type="button" data-show-errors="${esc(a.id)}">${errs.length} kind${errs.length === 1 ? '' : 's'}, ${errs.reduce((n, g) => n + g.count, 0)} times in all</button></dd>` : ''}
          ${a.reports ? `<dt>Reports</dt><dd><a class="link-btn" href="#/reports">${a.reports} open</a></dd>` : ''}
        </dl>
        <div class="report-actions">
          ${a.email ? `<button class="btn btn-sm" type="button" data-copy-email="${esc(a.email)}">${icon('mail')}Copy email</button>` : ''}
          ${canRead ? `<button class="btn btn-sm" type="button" data-account-sync="${esc(a.id)}"${a.busy ? ' disabled' : ''}>${icon('refresh')}Sync now</button>
          <button class="btn btn-sm" type="button" data-rescan-account="${esc(a.id)}" data-who="${esc(a.email || 'this account')}"${a.busy ? ' disabled' : ''} title="Read their emails again with the current sorting. Their edits are kept and a backup is made first">${icon('refresh')}Re-scan their emails</button>` : ''}
          ${a.allowed ? (a.feedbackAsked
            ? `<button class="btn btn-sm ask-btn asked" type="button" disabled>${icon('star')}Asked ${timeAgo(a.feedbackAsked)}, not seen yet</button>`
            : `<button class="btn btn-sm ask-btn" type="button" data-ask-feedback="${esc(a.id)}" data-who="${esc(a.email || 'them')}">${icon('star')}Ask how it’s going</button>`) : ''}
          ${a.owner ? '' : `<button class="btn btn-sm btn-quiet btn-danger" type="button" data-account-delete="${esc(a.id)}">${icon('trash')}<span>Delete account</span></button>`}
        </div>
        ${a.allowed ? '' : `<p class="dev-note">Not on ALLOWED_EMAIL: they can't sign in and aren't synced. Their data stays until it's deleted.</p>`}
      </div>
    </div></div></td></tr>`;
}
// Open or close one row in place, so the reveal animates instead of the list re-rendering.
function toggleDevRow(key) {
  const open = !devOpen.has(key);
  if (open) devOpen.add(key); else devOpen.delete(key);
  const id = CSS.escape(key.slice(2));
  if (key.startsWith('a:')) {
    const row = $(`tr[data-account="${id}"]`);
    row?.classList.toggle('open', open);
    row?.setAttribute('aria-expanded', open);
    row?.nextElementSibling?.classList.toggle('open', open);
    row?.nextElementSibling?.setAttribute('aria-hidden', !open);
  } else {
    const item = $(`[data-error="${id}"]`);
    item?.classList.toggle('open', open);
    item?.querySelector('.dev-err-line')?.setAttribute('aria-expanded', open);
    item?.querySelector('.dev-more')?.classList.toggle('open', open);
    item?.querySelector('.dev-more')?.setAttribute('aria-hidden', !open);
  }
}
$('#account-tabs').addEventListener('click', e => {
  const t = e.target.closest('[data-account-filter]');
  if (t) { accountFilter = t.dataset.accountFilter; renderAccounts(); }
});
$('#accounts-search').addEventListener('input', renderAccounts);
$('#account-rows').addEventListener('keydown', e => {
  const row = e.target.closest('tr[data-account]');
  if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleDevRow(`a:${row.dataset.account}`); }
});
$('#account-rows').addEventListener('click', async e => {
  const copy = e.target.closest('[data-copy-email]');
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copyEmail); toast(`Copied ${copy.dataset.copyEmail}`); }
    catch { toast("Couldn't copy. Select the address instead"); }
    return;
  }
  // "3 kinds of error": show just those, opened, in the Errors list below.
  const showErrors = e.target.closest('[data-show-errors]');
  if (showErrors) {
    const ids = dev.errors.filter(g => g.users.includes(showErrors.dataset.showErrors)).map(g => g.id);
    errorFilter = 'all';
    errorSource = 'all';
    $('#errors-search').value = '';
    ids.forEach(id => devOpen.add(`e:${id}`));
    renderErrors();
    $(`[data-error="${CSS.escape(ids[0])}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const askOne = e.target.closest('[data-ask-feedback]');
  if (askOne) {
    askOne.disabled = true;
    try {
      await api('POST', '/api/dev/feedback', { to: askOne.dataset.askFeedback });
      toast(`Asked ${askOne.dataset.who}. They’ll see it the next time they open nuj`);
      loadDeveloper();
    } catch (err) {
      toast(err.message);
      askOne.disabled = false;
    }
    return;
  }
  const sync = e.target.closest('[data-account-sync]');
  if (sync) {
    sync.disabled = true;
    try {
      await api('POST', `/api/accounts/${encodeURIComponent(sync.dataset.accountSync)}/sync`);
      toast('Checking their Gmail now');
      setTimeout(loadDeveloper, 4000);
    } catch (err) {
      toast(err.message);
      sync.disabled = false;
    }
    return;
  }
  const rescan = e.target.closest('[data-rescan-account]');
  if (rescan) {
    rescan.disabled = true;
    try {
      await api('POST', `/api/accounts/${encodeURIComponent(rescan.dataset.rescanAccount)}/rescan`);
      toast(`Re-scanning ${rescan.dataset.who}'s emails. Progress shows here`);
      loadDeveloper();
    } catch (err) {
      toast(err.message);
      rescan.disabled = false;
    }
    return;
  }
  // Deleting someone's account can't be undone, so it takes a second click, as your own does.
  const del = e.target.closest('[data-account-delete]');
  if (del) {
    const label = del.querySelector('span');
    if (!del.classList.contains('confirming')) {
      del.classList.add('confirming');
      label.textContent = 'Click again to delete for good';
      setTimeout(() => { if (del.isConnected) { del.classList.remove('confirming'); label.textContent = 'Delete account'; } }, 5000);
      return;
    }
    del.disabled = true;
    try {
      await api('DELETE', `/api/accounts/${encodeURIComponent(del.dataset.accountDelete)}`);
      toast('Account deleted. Take them off ALLOWED_EMAIL too, or they start afresh at their next sign-in');
      loadDeveloper();
    } catch (err) {
      toast(err.message);
      del.disabled = false;
    }
    return;
  }
  const row = e.target.closest('tr[data-account]');
  if (row && !e.target.closest('a, button')) toggleDevRow(`a:${row.dataset.account}`);
});

// ---- feedback: ask one person (from their row) or everyone, and read what they said
const ENJOY = { yes: ['Enjoying it', 'offer'], okay: ['It’s okay', 'interview'], no: ['Not really', 'rejected'] };
const SORTED = { right: ['Mostly right', 'offer'], some: ['A few mistakes', 'interview'], wrong: ['Often wrong', 'rejected'], unsure: ['Not sure', 'withdrawn'] };
let fbShowAll = false;
const miniStars = (rating, label = true) => `<span class="mini-stars"${label ? ` role="img" aria-label="${rating} out of 5 stars"` : ' aria-hidden="true"'}>${
  [1, 2, 3, 4, 5].map(i => icon('star', `icon ${i <= Math.round(rating) ? 'on' : 'off'}`)).join('')}</span>`;
// One thin bar split by answer, with a legend under it.
function split(counts, names) {
  const total = Object.values(counts).reduce((n, v) => n + v, 0);
  const parts = Object.entries(names).filter(([k]) => counts[k]);
  if (!total) return '<span class="dim">No answers yet</span>';
  return `<div class="split" aria-hidden="true">${parts.map(([k, [, tone]]) => `<i style="--c:var(--${tone});flex:${counts[k]}"></i>`).join('')}</div>
    <div class="split-legend">${parts.map(([k, [label, tone]]) => `<span style="--c:var(--${tone})">${label} <span class="num">${counts[k]}</span></span>`).join('')}</div>`;
}
function renderFeedbackResults() {
  const { summary: s, asks } = dev.feedback;
  $('#fb-summary').innerHTML = `
    <div><dt>Rating</dt><dd>${s.rating === null ? '<span class="dim">No answers yet</span>'
      : `<div class="fb-rating"><span class="value">${s.rating}</span>${miniStars(s.rating)}</div><span class="hint">From ${s.answers} answer${s.answers === 1 ? '' : 's'}</span>`}</dd></div>
    <div><dt>Enjoying nuj</dt><dd>${split(s.enjoying, ENJOY)}</dd></div>
    <div><dt>Email sorting</dt><dd>${split(s.sorting, SORTED)}</dd></div>`;
  // Each time you asked, and how many have answered.
  $('#fb-asks').innerHTML = asks.map(a => {
    const answered = a.answers.length;
    const waiting = a.stoppedAt ? 0 : a.asked - answered - a.skipped;
    return `<li class="fb-ask">
      <span class="what">${a.everyone ? 'Asked everyone' : `Asked ${esc(a.who || 'one person')}`}</span>
      <span>${shortDate(a.createdAt)}</span>
      <span class="num">${answered} of ${a.asked} answered${a.skipped ? ` · ${a.skipped} said not now` : ''}${waiting > 0 ? ` · ${waiting} yet to see it` : ''}${a.stoppedAt ? ' · stopped' : ''}</span>
      ${waiting > 0 ? `<button class="btn btn-sm btn-quiet" type="button" data-stop-ask="${esc(a.id)}">Stop asking</button>` : ''}
    </li>`;
  }).join('');
  const answers = asks.flatMap(a => a.answers).sort((x, y) => y.at.localeCompare(x.at));
  const unread = answers.filter(x => !x.readAt);
  $('#fb-tabs').innerHTML = [['new', 'New', unread.length], ['all', 'All', answers.length]].map(([id, label, n]) =>
    `<button class="tab" role="tab" type="button" aria-selected="${fbFilter === id}" data-fb-filter="${id}">${label}<span class="n">${n}</span></button>`).join('');
  $('#fb-read-all').hidden = unread.length < 2;
  const list = fbFilter === 'new' ? unread : answers;
  const shown = fbShowAll ? list : list.slice(0, 12);
  $('#fb-answers').innerHTML = list.length ? shown.map(x => `
    <li class="fb-answer${x.readAt ? '' : ' unread'}">
      <div class="report-head">
        ${x.readAt ? '' : '<span class="sdot" style="--c:var(--oa)" role="img" aria-label="New"></span>'}
        <span class="report-from">${esc(x.email || 'An account since deleted')}</span>
        ${miniStars(x.rating)}
        <span class="report-when" title="${esc(new Date(x.at).toLocaleString())}">${timeAgo(x.at)}</span>
      </div>
      <div class="fb-tags">
        <span style="--c:var(--${ENJOY[x.enjoying][1]})">${ENJOY[x.enjoying][0]}</span>
        ${x.sorting ? `<span style="--c:var(--${SORTED[x.sorting][1]})">Sorting: ${SORTED[x.sorting][0].toLowerCase()}</span>` : ''}
      </div>
      ${x.comment ? `<p class="report-message">${esc(x.comment)}</p>` : ''}
      <div class="report-actions">
        <button class="btn btn-sm${x.readAt ? ' btn-quiet' : ''}" type="button" data-fb-read="${x.readAt ? 'unread' : 'read'}" data-ask="${esc(x.askId)}" data-user="${esc(x.userId)}">${x.readAt ? 'Mark unread' : `${icon('check')}Mark read`}</button>
      </div>
    </li>`).join('') + (list.length > shown.length ? `<li><button class="btn btn-sm btn-quiet" type="button" data-fb-all>Show all ${list.length} answers</button></li>` : '')
    : fbFilter === 'new' && answers.length
      ? `<li class="action-empty"><strong>All caught up</strong>You've read every answer. They're all under All.</li>`
      : `<li class="action-empty"><strong>No answers yet</strong>Ask everyone, or one person from their row in Accounts.</li>`;
  $('#ask-everyone').disabled = !dev.accounts.some(a => a.allowed && !a.owner);
}
let fbFilter = 'new';
async function setRead(items, read) {
  try {
    await api('POST', '/api/dev/feedback/read', { items, read });
  } catch (err) {
    toast(err.message);
  }
  await loadDeveloper();
}
$('#fb-tabs').addEventListener('click', e => {
  const t = e.target.closest('[data-fb-filter]');
  if (t) { fbFilter = t.dataset.fbFilter; fbShowAll = false; renderFeedbackResults(); }
});
$('#fb-answers').addEventListener('click', async e => {
  if (e.target.closest('[data-fb-all]')) { fbShowAll = true; renderFeedbackResults(); return; }
  const b = e.target.closest('[data-fb-read]');
  if (!b) return;
  b.disabled = true;
  const items = [{ askId: b.dataset.ask, userId: b.dataset.user }];
  const read = b.dataset.fbRead === 'read';
  try {
    await setRead(items, read);
    if (read) toast('Marked read', () => setRead(items, false));
  } catch (err) {
    toast(err.message);
    b.disabled = false;
  }
});
$('#fb-read-all').addEventListener('click', async () => {
  const items = dev.feedback.asks.flatMap(a => a.answers).filter(x => !x.readAt).map(x => ({ askId: x.askId, userId: x.userId }));
  $('#fb-read-all').disabled = true;
  try {
    await setRead(items, true);
    toast(`Marked ${items.length} answers read`, () => setRead(items, false));
  } catch (err) {
    toast(err.message);
  }
  $('#fb-read-all').disabled = false;
});
$('#fb-asks').addEventListener('click', async e => {
  const stop = e.target.closest('[data-stop-ask]');
  if (!stop) return;
  stop.disabled = true;
  await api('POST', `/api/dev/feedback/${stop.dataset.stopAsk}/stop`).catch(err => toast(err.message));
  toast('Stopped. Anyone who hadn’t seen it won’t be asked');
  loadDeveloper();
});
// It pops up for everyone, so the first click says how many and the second sends it.
$('#ask-everyone').addEventListener('click', async () => {
  const btn = $('#ask-everyone');
  const label = btn.querySelector('span');
  const n = dev.accounts.filter(a => a.allowed && !a.owner).length;
  if (!btn.classList.contains('confirming')) {
    btn.classList.add('confirming');
    label.textContent = `Ask all ${n}? Click again`;
    setTimeout(() => { btn.classList.remove('confirming'); label.textContent = 'Ask everyone'; }, 5000);
    return;
  }
  btn.classList.remove('confirming');
  label.textContent = 'Ask everyone';
  btn.disabled = true;
  try {
    const { asked } = await api('POST', '/api/dev/feedback', { to: 'everyone' });
    toast(`Asked ${asked} ${asked === 1 ? 'person' : 'people'}. They’ll see it the next time they open nuj`);
    loadDeveloper();
  } catch (err) {
    toast(err.message);
  }
  btn.disabled = false;
});

// ---- errors (after 21st.dev's Interactive Logs Table: level, source, message and count on
// one line; open it for when it happened and to whom)
const SOURCE_LABEL = { sync: 'Sync', gmail: 'Gmail', groq: 'Groq', server: 'Server', 'sign-in': 'Sign-in', rescan: 'Re-scan', browser: 'Browser' };
const ERROR_TABS = [['open', 'Open', g => g.status === 'open'], ['resolved', 'Resolved', g => g.status === 'resolved'], ['all', 'All', () => true]];
function renderErrors() {
  const all = dev.errors;
  $('#error-tabs').innerHTML = ERROR_TABS.map(([id, label, fits]) =>
    `<button class="tab" role="tab" type="button" aria-selected="${errorFilter === id}" data-error-filter="${id}">${label}<span class="n">${all.filter(fits).length}</span></button>`).join('');
  const inTab = all.filter(ERROR_TABS.find(t => t[0] === errorFilter)[2]);
  const sources = Object.keys(SOURCE_LABEL).filter(src => inTab.some(g => g.source === src));
  if (errorSource !== 'all' && !sources.includes(errorSource)) errorSource = 'all';
  $('#error-sources').hidden = sources.length < 2;
  $('#error-sources').innerHTML = [['all', 'Everywhere', inTab.length], ...sources.map(src => [src, SOURCE_LABEL[src], inTab.filter(g => g.source === src).length])]
    .map(([id, label, n]) => `<button class="dev-chip" type="button" aria-pressed="${errorSource === id}" data-error-source="${id}">${label}<span class="num">${n}</span></button>`).join('');
  const q = $('#errors-search').value.trim().toLowerCase();
  // Errors before warnings, then the most recent.
  const shown = inTab.filter(g => (errorSource === 'all' || g.source === errorSource) && (!q || g.message.toLowerCase().includes(q)))
    .sort((a, b) => (a.level === 'error' ? 0 : 1) - (b.level === 'error' ? 0 : 1) || b.lastAt.localeCompare(a.lastAt));
  $('#error-list').innerHTML = shown.length ? shown.map(errorRow).join('')
    : `<li class="action-empty"><strong>${q ? 'No error matches' : errorFilter === 'open' ? 'Nothing is broken' : 'Nothing here'}</strong>${q ? 'Try fewer words.' : 'Errors from syncing, Groq, the server and people’s browsers show up here.'}</li>`;
}
const emailOf = (g, userId) => g.emails?.[g.users.indexOf(userId)] || null;
function errorRow(g) {
  const open = devOpen.has(`e:${g.id}`);
  const who = g.users.length ? `${g.users.length} account${g.users.length === 1 ? '' : 's'}` : 'No account';
  return `
    <li class="dev-err ${g.level} st-${g.status}${open ? ' open' : ''}" data-error="${esc(g.id)}">
      <button class="dev-err-line" type="button" aria-expanded="${open}">
        ${icon('chevron', 'icon chev')}
        <span class="lvl">${g.level === 'error' ? 'Error' : 'Warning'}</span>
        <span class="src">${SOURCE_LABEL[g.source] || esc(g.source)}</span>
        <span class="msg">${esc(g.message)}${g.regressed ? ' <span class="back">Back again</span>' : ''}</span>
        <span class="count num" title="${g.count} times">×${g.count}</span>
        <span class="who-n">${who}</span>
        <time class="when" datetime="${esc(g.lastAt)}" title="${esc(new Date(g.lastAt).toLocaleString())}">${timeAgo(g.lastAt)}</time>
      </button>
      <div class="dev-more reveal${open ? ' open' : ''}" aria-hidden="${!open}"><div>
        <div class="dev-detail">
          <p class="dev-msg mono">${esc(g.message)}</p>
          <dl>
            <dt>First seen</dt><dd>${new Date(g.firstAt).toLocaleString()}</dd>
            <dt>Last seen</dt><dd>${new Date(g.lastAt).toLocaleString()}</dd>
            ${g.resolvedAt && g.status === 'resolved' ? `<dt>Resolved</dt><dd>${new Date(g.resolvedAt).toLocaleString()}</dd>` : ''}
            <dt>Accounts</dt><dd>${g.users.length ? g.users.map(id => esc(emailOf(g, id) || id)).join(', ') : 'Not tied to an account'}</dd>
            <dt>Latest</dt><dd><ol class="dev-samples">${g.samples.map(smp => `<li>
              <time class="num">${new Date(smp.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
              <span>${esc(smp.userId ? emailOf(g, smp.userId) || 'a deleted account' : 'no account')}${smp.detail ? `<span class="dim"> · ${esc(smp.detail)}</span>` : ''}</span></li>`).join('')}</ol></dd>
          </dl>
          <div class="report-actions">
            <button class="btn btn-sm" type="button" data-error-status="${esc(g.id)}" data-to="${g.status === 'open' ? 'resolved' : 'open'}">${icon(g.status === 'open' ? 'check' : 'refresh')}${g.status === 'open' ? 'Mark resolved' : 'Reopen'}</button>
            <button class="btn btn-sm btn-quiet btn-danger" type="button" data-error-delete="${esc(g.id)}">${icon('trash')}Delete</button>
          </div>
        </div>
      </div></div>
    </li>`;
}
$('#error-tabs').addEventListener('click', e => {
  const t = e.target.closest('[data-error-filter]');
  if (t) { errorFilter = t.dataset.errorFilter; renderErrors(); }
});
$('#error-sources').addEventListener('click', e => {
  const c = e.target.closest('[data-error-source]');
  if (c) { errorSource = c.dataset.errorSource; renderErrors(); }
});
$('#errors-search').addEventListener('input', renderErrors);
$('#error-list').addEventListener('click', async e => {
  const status = e.target.closest('[data-error-status]');
  if (status) {
    status.disabled = true;
    const { errorStatus: id, to } = status.dataset;
    try {
      await api('PATCH', `/api/dev/errors/${id}`, { status: to });
    } catch (err) {
      status.disabled = false;
      return toast(err.message);
    }
    await loadDeveloper();
    toast(to === 'resolved' ? 'Marked resolved. It opens again if it comes back' : 'Reopened', async () => {
      await api('PATCH', `/api/dev/errors/${id}`, { status: to === 'resolved' ? 'open' : 'resolved' });
      await loadDeveloper();
    });
    return;
  }
  // Like a report: gone at once, deleted for good once the Undo has had its chance.
  const del = e.target.closest('[data-error-delete]');
  if (del) {
    const id = del.dataset.errorDelete;
    const kept = dev.errors;
    dev.errors = kept.filter(g => g.id !== id);
    renderErrors();
    const timer = setTimeout(() => api('DELETE', `/api/dev/errors/${id}`).catch(() => {}), UNDO_SHOW_MS + 300);
    toast('Error deleted', async () => {
      clearTimeout(timer);
      dev.errors = kept;
      renderErrors();
    });
    return;
  }
  const line = e.target.closest('.dev-err-line');
  if (line) toggleDevRow(`e:${line.closest('[data-error]').dataset.error}`);
});
// Keep the uptime and "3m ago" times fresh while the page is open.
setInterval(() => { if (view === 'developer' && dev.server) renderHealth(); }, 30_000);
