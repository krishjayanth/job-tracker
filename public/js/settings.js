// Settings: Gmail, re-scan, ignored senders, AI sorting (your Groq key) and your account.
// The dashboard's scripts are plain scripts loaded in order (see index.html), sharing one
// global scope: a file may use what an earlier one defines, and anything at all from inside
// functions that run later.

// ---------------------------------------------------------------- settings page
$('#blocked-list').addEventListener('click', async e => {
  const b = e.target.closest('[data-unblock]');
  if (!b) return;
  b.disabled = true;
  try {
    await api('DELETE', `/api/blocked-senders/${encodeURIComponent(b.dataset.unblock)}`);
    toast(`nuj will read ${b.dataset.unblock} again`);
  } catch (err) {
    b.disabled = false;
    toast(err.message);
  }
  load().catch(() => {});
});
// Ask before something slow or permanent. With `typeWord`, the button only works once that
// word is typed, for things that can't be undone. Resolves true when confirmed.
function confirmAction({ title, text, action, danger = false, typeWord = null }) {
  const dialog = $('#confirm-dialog');
  const go = $('#confirm-go');
  const typed = $('#confirm-type');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  go.textContent = action;
  go.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  $('#confirm-type-row').hidden = !typeWord;
  $('#confirm-type-label').textContent = typeWord ? `Type ${typeWord} to confirm` : '';
  typed.value = '';
  go.disabled = Boolean(typeWord);
  typed.oninput = () => { go.disabled = typed.value.trim().toLowerCase() !== typeWord; };
  return new Promise(resolve => {
    let ok = false;
    $('#confirm-form').onsubmit = e => {
      if (go.disabled) return e.preventDefault();
      ok = true;
    };
    dialog.onclick = e => { if (e.target === dialog || e.target.closest('[data-close-dialog]')) dialog.close(); };
    dialog.addEventListener('close', () => resolve(ok), { once: true });
    dialog.showModal();
    (typeWord ? typed : $('#confirm-dialog [data-close-dialog].btn')).focus();
  });
}

$('#rescan-btn').onclick = async () => {
  const ok = await confirmAction({
    title: 'Re-scan all your emails?',
    text: 'nuj reads every application email again with your current sorting. It can take a few minutes. Your status changes, renames, notes and deadlines are kept, and a backup is made first.',
    action: 'Re-scan',
  });
  if (!ok) return;
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
  try {
    await api('DELETE', '/api/groq-key');
  } catch (err) {
    return groqMsg(err.message, 'err');
  }
  groqMsg('Removed. Emails will be sorted by the built-in rules.', 'ok');
  load().catch(() => {});
};

// It can't be undone, so it's confirmed in a dialog by typing a word, not by a click that a
// double-click could get through.
$('#delete-account-btn').onclick = async () => {
  const btn = $('#delete-account-btn');
  const ok = await confirmAction({
    title: 'Delete your account?',
    text: "This deletes your applications, resumes, Groq key and problem reports from nuj, and cancels its Gmail access. It can't be undone.",
    action: 'Delete everything',
    danger: true,
    typeWord: 'delete',
  });
  if (!ok) return;
  btn.disabled = true;
  try {
    await api('DELETE', '/api/account');
    location.assign(state.user ? '/welcome' : '/');
  } catch (err) {
    btn.disabled = false;
    toast(`Couldn't delete your account: ${err.message}`);
  }
};

const rowsEl = $('#rows');
rowsEl.addEventListener('click', e => {
  const pick = e.target.closest('[data-pick]');
  if (pick) return pickRows(pick.dataset.pick, pick.checked, e.shiftKey);
  if (e.target.closest('.status-select, .col-pick')) return; // changing status or ticking, not opening
  const tr = e.target.closest('tr[data-id]');
  if (tr) openById(tr.dataset.id);
});
rowsEl.addEventListener('keydown', e => {
  if (e.target.tagName !== 'TR') return;
  if (e.key === 'Enter') openById(e.target.dataset.id);
  // Space ticks the focused row, like a checkbox; Shift+Space ticks the range.
  if (e.key === ' ') {
    e.preventDefault();
    pickRows(e.target.dataset.id, !selected.has(e.target.dataset.id), e.shiftKey);
  }
});
