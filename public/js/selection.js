// Ticking applications in the table and acting on several at once; filters and export.
// The dashboard's scripts are plain scripts loaded in order (see index.html), sharing one
// global scope: a file may use what an earlier one defines, and anything at all from inside
// functions that run later.

// ---------------------------------------------------------------- selection
// Tick rows to act on them together (after 21st.dev's Data Table Toolbar): set one status,
// export just those, or delete them, each with a single Undo.
function pickRows(id, on, range) {
  const ids = visibleRows.map(a => a.id);
  const from = ids.indexOf(lastPicked), to = ids.indexOf(id);
  const span = range && from !== -1 && to !== -1 ? ids.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
  for (const x of span) on ? selected.add(x) : selected.delete(x);
  lastPicked = id;
  renderSelection();
}
function clearSelection() {
  selected.clear();
  lastPicked = null;
  renderSelection();
}
function renderSelection() {
  const n = selected.size;
  renderQuietNudge();
  const all = $('#pick-all');
  all.checked = n > 0 && n === visibleRows.length;
  all.indeterminate = n > 0 && n < visibleRows.length;
  all.disabled = !visibleRows.length;
  document.querySelectorAll('#rows tr[data-id]').forEach(tr => {
    const on = selected.has(tr.dataset.id);
    tr.classList.toggle('picked', on);
    tr.querySelector('[data-pick]').checked = on;
  });
  const bar = $('#bulk-bar');
  const opening = bar.hidden && n > 0;
  bar.hidden = n === 0;
  $('#bulk-count').textContent = `${n} selected`;
  // The bar drops in when a selection starts; it leaves at once, so nothing lingers to misclick.
  if (opening && !reduceMotion.matches) {
    bar.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.23, 1, .32, 1)' });
  }
}
$('#pick-all').addEventListener('change', e => {
  if (e.target.checked) visibleRows.forEach(a => selected.add(a.id));
  else selected.clear();
  lastPicked = null;
  renderSelection();
});
// Esc lets go of the selection, unless it's closing something else first (it runs before them).
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !selected.size) return;
  if ($('#drawer').classList.contains('open') || document.querySelector('dialog[open]') || $('#sidebar').classList.contains('open')) return;
  if (e.target.closest?.('textarea, select, input:not([type="checkbox"])')) return;
  clearSelection();
}, { capture: true });

$('#bulk-status').innerHTML = `<option value="">Set status…</option>${STATUS_ORDER.map(s => `<option value="${s}">${STAGE_LABEL[s]}</option>`).join('')}`;
async function runBulk(action, extra, message) {
  const ids = [...selected];
  try {
    const { count, undo } = await api('POST', '/api/applications/bulk', { ids, action, ...extra });
    clearSelection();
    await load();
    undoToast(message(count), undo);
  } catch (err) {
    toast(err.message);
  }
}
$('#bulk-status').addEventListener('change', e => {
  const status = e.target.value;
  e.target.value = '';
  if (status) runBulk('status', { status }, n => `${appCount(n)} set to ${STAGE_LABEL[status]}`);
});
$('#bulk-delete').onclick = () => runBulk('delete', {}, n => `Deleted ${appCount(n)}`);
$('#bulk-export').onclick = () => exportRows(visibleRows.filter(a => selected.has(a.id)), $('#bulk-export'), ['selected']);
$('#bulk-clear').onclick = () => { clearSelection(); $('#pick-all').focus(); };
rowsEl.addEventListener('change', e => {
  const sel = e.target.closest('select[data-status-for]');
  if (sel) setStatus(sel.dataset.statusFor, sel.value).then(ok => ok && toast(`Status set to ${STAGE_LABEL[sel.value]}`));
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
  if (which === 'only' || which === 'all') only = null;
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

// Excel export of exactly what the table shows (or just the ticked rows, from the bulk bar).
$('#export-btn').onclick = () => exportRows(visibleRows, $('#export-btn'));
async function exportRows(rows, btn, extraName = []) {
  const label = btn.querySelector('span');
  btn.disabled = true;
  label.textContent = 'Exporting…';
  const parts = ['job-applications', month !== 'all' && month, filter !== 'all' && TAB_LABEL[filter].toLowerCase(), ...extraName].filter(Boolean);
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: rows.map(a => a.id), filename: parts.join('-') }),
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
    btn.disabled = btn === $('#export-btn') && visibleRows.length === 0;
    label.textContent = 'Export';
  }
}

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
    focusSearch();
  }
});
function focusSearch() {
  if (view !== 'dashboard') location.hash = '#/applications';
  $('#search').focus();
}
