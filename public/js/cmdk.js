// The command menu (⌘K / Ctrl+K).
// The dashboard's scripts are plain scripts loaded in order (see index.html), sharing one
// global scope: a file may use what an earlier one defines, and anything at all from inside
// functions that run later.

// ---------------------------------------------------------------- command menu (⌘K / Ctrl+K)
// One box for everything: an application, a page, or an action. Each item runs the same
// code its button does (clicking it, where there is one), so nothing here can drift.
const cmdk = $('#cmdk');
const cmdkInput = $('#cmdk-input');
const cmdkList = $('#cmdk-list');
const isMac = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
$('#cmdk-open .cmdk-key').textContent = isMac ? '⌘K' : 'Ctrl K';
$('#cmdk-open').setAttribute('aria-keyshortcuts', isMac ? 'Meta+K' : 'Control+K');

let cmdkItems = []; // what the list shows now, in order
let cmdkActive = 0;
let cmdkReturn = null; // where focus goes back to on close

function go(href) {
  if ((location.hash || '#/') === href) route(); // already there: still scroll to it
  else location.hash = href;
}
const pickTheme = value => document.querySelector(`input[name="theme"][value="${value}"]`).click();
const showStage = id => {
  go('#/applications');
  $(`#stage-tabs [data-filter="${id}"]`)?.click();
};

// Everything the menu can do right now. Apps only list the newest few until you type.
function cmdkSources() {
  const theme = themePick();
  const apps = [...state.applications].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)).map(a => ({
    group: 'Applications', label: a.company, sub: a.role || '', stage: a.status,
    keywords: [a.role, a.jobId, STAGE_LABEL[a.status]].filter(Boolean).join(' '),
    run: () => openById(a.id),
  }));
  const pages = [
    ['Dashboard', '#/', 'dashboard'],
    ['Applications', '#/applications', 'list'],
    ['Calendar', '#/calendar', 'calendar', 'deadlines interviews schedule google'],
    ['Resume insights', '#/resume', 'file', 'cv keywords skills versions'],
    ['Settings', '#/settings', 'sliders', 'appearance gmail groq key ignored senders account'],
    !$('#reports-link').hidden && ['Reports', '#/reports', 'flag', 'invite requests problems'],
    !$('#developer-link').hidden && ['Developer', '#/developer', 'terminal', 'accounts users errors server health logs'],
  ].filter(Boolean).map(([label, href, ic, keywords = '']) => ({ group: 'Go to', label, icon: ic, keywords: `page ${keywords}`, run: () => go(href) }));
  const actions = [
    { label: 'Add application', icon: 'plus', keywords: 'new create', run: () => $('#add-btn').click() },
    { label: 'Add a resume version', icon: 'file', keywords: 'upload cv resume new', run: () => { go('#/resume'); openVersionDialog(); } },
    !$('#sync-btn').hidden && { label: 'Sync now', icon: 'refresh', keywords: 'gmail refresh check email', run: () => $('#sync-btn').click() },
    !$('#export-btn').disabled && { label: 'Export to Excel', icon: 'download', sub: `The ${visibleRows.length} ${visibleRows.length === 1 ? 'application' : 'applications'} in the table`, keywords: 'download xlsx spreadsheet', run: () => $('#export-btn').click() },
    { label: 'Search the table', icon: 'search', keywords: 'find filter notes emails', shortcut: ['/'], run: focusSearch },
    { label: 'Report a problem', icon: 'flag', keywords: 'bug feedback help', run: () => $('#report-open').click() },
    ...[['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']].map(([value, name, ic]) => ({
      label: `Theme: ${name}`, icon: ic, current: value === theme,
      keywords: 'appearance colour color mode', run: () => pickTheme(value),
    })),
  ].filter(Boolean).map(x => ({ group: 'Actions', ...x }));
  const stages = [['all', 'All applications'], ...TAB_ORDER.map(s => [s, TAB_LABEL[s]])].map(([id, name]) => ({
    group: 'Filter', label: id === 'all' ? 'Show all applications' : `Show ${name}`, dot: id === 'all' ? null : id,
    keywords: 'filter stage status tab', run: () => showStage(id),
  }));
  return { apps, rest: [...pages, ...actions, ...stages] };
}

// How well one word matches some text: the start beats the start of a word beats anywhere.
function wordScore(word, text) {
  const t = text.toLowerCase();
  if (t.startsWith(word)) return 3;
  if (new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t)) return 2;
  return t.includes(word) ? 1 : 0;
}
// Every word has to match the label or keywords; the label counts double. A single word
// can also match its letters in order ("lnkd" → LinkedIn), ranked last.
function cmdkScore(item, words) {
  let total = 0;
  for (const w of words) {
    const s = Math.max(wordScore(w, item.label) * 2, wordScore(w, item.keywords || ''), wordScore(w, item.sub || ''));
    if (s) { total += s; continue; }
    const letters = words.length === 1 && w.length > 1 && new RegExp([...w].map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')).test(item.label.toLowerCase());
    if (!letters) return 0;
    total += .5;
  }
  return total;
}

function cmdkFilter() {
  const words = cmdkInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const { apps, rest } = cmdkSources();
  let items;
  if (!words.length) {
    items = [...rest.filter(x => x.group !== 'Filter'), ...apps.slice(0, 6), ...rest.filter(x => x.group === 'Filter')];
  } else {
    const scored = [...apps.slice(0, 400), ...rest].map(item => ({ item, score: cmdkScore(item, words) })).filter(x => x.score);
    // Best match first within a group, and the group with the best match first.
    const groups = new Map();
    for (const x of scored.sort((a, b) => b.score - a.score)) {
      if (!groups.has(x.item.group)) groups.set(x.item.group, []);
      if (groups.get(x.item.group).length < 50) groups.get(x.item.group).push(x.item);
    }
    items = [...groups.values()].flat();
  }
  cmdkItems = items;
  cmdkActive = 0;
  cmdkRender();
}

function cmdkRender() {
  if (!cmdkItems.length) {
    cmdkList.innerHTML = `<div class="cmdk-empty" role="presentation">No results.</div>`;
    cmdkInput.setAttribute('aria-expanded', 'false');
    cmdkInput.removeAttribute('aria-activedescendant');
    return;
  }
  const groups = [];
  cmdkItems.forEach((item, i) => {
    if (groups.at(-1)?.name !== item.group) groups.push({ name: item.group, rows: [] });
    groups.at(-1).rows.push([item, i]);
  });
  cmdkList.innerHTML = groups.map((g, gi) => `
    ${gi ? '<div class="cmdk-sep" role="presentation"></div>' : ''}
    <div class="cmdk-group" role="group" aria-labelledby="cmdk-g${gi}">
      <div class="cmdk-heading" id="cmdk-g${gi}" role="presentation">${g.name}</div>
      ${g.rows.map(([item, i]) => `
      <div class="cmdk-item" role="option" id="cmdk-o${i}" data-i="${i}" aria-selected="false">
        ${item.dot ? `<i class="cmdk-dot" style="--c:${color(item.dot)}"></i>` : icon(item.icon || 'file')}
        <span class="cmdk-text">
          <span class="cmdk-label">${esc(item.label)}</span>
          ${item.stage || item.sub ? `<span class="cmdk-sub">${item.stage ? pill(item.stage) : ''}${item.sub ? `<span>${esc(item.sub)}</span>` : ''}</span>` : ''}
        </span>
        ${item.current ? `<span class="cmdk-current">${icon('check')}Current</span>` : ''}
        ${item.shortcut ? `<span class="cmdk-keys">${item.shortcut.map(k => `<kbd>${esc(k)}</kbd>`).join('')}</span>` : ''}
      </div>`).join('')}
    </div>`).join('');
  cmdkInput.setAttribute('aria-expanded', 'true');
  cmdkSelect(cmdkActive);
}

function cmdkSelect(i, { scroll = true } = {}) {
  cmdkList.querySelector('[aria-selected="true"]')?.setAttribute('aria-selected', 'false');
  cmdkActive = (i + cmdkItems.length) % cmdkItems.length; // loops top ↔ bottom
  const el = $(`#cmdk-o${cmdkActive}`);
  el.setAttribute('aria-selected', 'true');
  cmdkInput.setAttribute('aria-activedescendant', el.id);
  if (!scroll) return;
  if (cmdkActive === 0) cmdkList.scrollTop = 0; // keep the first heading in view too
  else el.scrollIntoView({ block: 'nearest' });
}

function openCmdk() {
  if (cmdk.open) return;
  cmdkReturn = document.activeElement;
  cmdkInput.value = '';
  cmdkFilter();
  cmdk.classList.remove('closing');
  cmdk.showModal();
  cmdkInput.focus();
}
// Closes with a quick fade, then hands focus back and runs whatever was picked.
function closeCmdk(then) {
  if (!cmdk.open || cmdk.classList.contains('closing')) return;
  const done = () => {
    cmdk.classList.remove('closing');
    cmdk.close();
    cmdkReturn?.focus?.({ preventScroll: true });
    then?.();
  };
  if (reduceMotion.matches || then) return done(); // an action shouldn't wait on a fade
  cmdk.classList.add('closing');
  setTimeout(done, 110);
}
const cmdkRun = i => { const item = cmdkItems[i]; if (item) closeCmdk(item.run); };

cmdkInput.addEventListener('input', cmdkFilter);
cmdk.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return closeCmdk(); } // not the drawer behind it too
  if (!cmdkItems.length) return;
  const moves = { ArrowDown: cmdkActive + 1, ArrowUp: cmdkActive - 1, Home: 0, End: cmdkItems.length - 1 };
  if (e.key in moves && !(e.key in { Home: 1, End: 1 } && cmdkInput.value)) { e.preventDefault(); cmdkSelect(moves[e.key]); }
  else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); cmdkRun(cmdkActive); }
});
cmdk.addEventListener('cancel', e => { e.preventDefault(); closeCmdk(); }); // other close requests, like Android's back
cmdk.addEventListener('click', e => {
  if (e.target === cmdk) return closeCmdk(); // the backdrop
  const item = e.target.closest('.cmdk-item');
  if (item) cmdkRun(Number(item.dataset.i));
});
cmdkList.addEventListener('mousedown', e => e.preventDefault()); // keep typing in the box
cmdkList.addEventListener('pointermove', e => {
  const item = e.target.closest('.cmdk-item');
  if (item && Number(item.dataset.i) !== cmdkActive) cmdkSelect(Number(item.dataset.i), { scroll: false });
});
$('#cmdk-open').addEventListener('click', openCmdk);
// ⌘K / Ctrl+K opens and closes it from anywhere except while typing elsewhere (the table
// search is fine) or with another dialog up.
document.addEventListener('keydown', e => {
  if (e.key.toLowerCase() !== 'k' || !(isMac ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return;
  if (cmdk.open) { e.preventDefault(); return closeCmdk(); }
  const el = document.activeElement;
  const typing = el && el !== $('#search') && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
  if (typing || document.querySelector('dialog[open]')) return;
  e.preventDefault();
  openCmdk();
});
