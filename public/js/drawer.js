// An application's panel: its timeline, "Wrong application?", the details you can edit, and
// the clicks and changes inside it.
// The dashboard's scripts are plain scripts loaded in order (see index.html), sharing one
// global scope: a file may use what an earlier one defines, and anything at all from inside
// functions that run later.

// ---------------------------------------------------------------- drawer
let openId = null;
let lastFocus = null;

const needsCheck = e => e.review?.length && !e.reviewed;

function timelineHtml(a) {
  return [...a.events].reverse().map(e => `
    <li style="--c:${color(e.stage)}">
      <span class="tdot"></span>
      <div class="thead">
        <span class="tstage">${STAGE_LABEL[e.stage]}${e.manual ? ' · set by you' : ''}${needsCheck(e) ? ' · <span class="tcheck">needs a check</span>' : ''}</span>
        <span class="tdate">${new Date(e.date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
      </div>
      <div class="tsubject">${esc(decode(e.subject || STAGE_LABEL[e.stage]))}</div>
      ${e.summary ? `<div class="tsnippet">${esc(e.summary)}</div>` : e.snippet ? `<div class="tsnippet">${esc(decode(e.snippet))}</div>` : ''}
      ${!e.manual ? `<div class="tlinks">
        ${e.messageId ? `<a class="tlink" href="https://mail.google.com/mail/u/0/#all/${e.messageId}" target="_blank" rel="noopener">Open in Gmail ${icon('external')}</a>` : ''}
        <button class="tlink${needsCheck(e) ? '' : ' quiet-fix'}" type="button" data-fix="${e.id}">${needsCheck(e) ? 'Check where it goes' : 'Wrong application?'}</button>
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
      <div class="filer-choices" role="group" aria-label="Where this email goes">
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
      <div class="review-head">${icon('alert')}Is this email in the right place?</div>
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
  if (!a) return;
  syncDrawerFields(a);
  if ($('#drawer .filer:not([hidden])')) return;
  $('#drawer .drawer-head').innerHTML = drawerHeadHtml(a);
  $('#drawer .review-slot').innerHTML = reviewHtml(a) + quietNoteHtml(a);
  $('#drawer .timeline').innerHTML = timelineHtml(a);
}

// What the open panel's fields last saved or showed (set by openDrawer).
let drawerSaved = null;
// A change made somewhere else (another tab, a sync naming the role) reaches the panel's
// boxes, so saving from here can't put the old value back. A box you're in, or have
// changed and not saved yet, is left alone: what you're typing wins.
function syncDrawerFields(a) {
  const form = $('#drawer #app-form');
  if (!form || !drawerSaved) return;
  const values = {
    company: a.company, role: a.role || '', jobId: a.jobId || '', url: a.url || '', notes: a.notes || '',
    posting: a.posting || '', resumeId: a.resumeId || '',
    deadline: a.deadline ? isoDate(a.deadline) : '', deadlineTime: a.deadline ? isoTime(a.deadline) : '',
    interview: a.interviewAt ? isoDate(a.interviewAt) : '', interviewTime: a.interviewAt ? isoTime(a.interviewAt) : '',
  };
  for (const [name, value] of Object.entries(values)) {
    const input = form.elements[name];
    if (!input || input === document.activeElement || input.value !== drawerSaved[name] || input.value === value) continue;
    input.value = value;
    drawerSaved[name] = value;
  }
  setExtra('#deadline-extra', deadlineExtraHtml(a));
  setExtra('#interview-extra', interviewExtraHtml(a));
}
// Only when it changed, so a button isn't swapped out from under a click.
function setExtra(sel, html) {
  const el = $(sel);
  if (!el || el.dataset.html === html) return;
  el.innerHTML = html;
  el.dataset.html = html;
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
      ${statusSelect(a, 'title="Change the status"')}
      ${dueChip(a.deadline)}
      ${interviewChip(a)}
      <span>Applied ${shortDate(a.appliedAt)}</span>
      ${a.jobId ? `<span class="num">ID ${esc(a.jobId)}</span>` : ''}
      ${isWebLink(a.url) ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${icon('link')}Job posting</a>` : ''}
    </div>`;
}

// An interview still to come, with its day and time.
// `short` leaves out the word "Interview", where the row already says it.
const interviewChip = (a, { short = false } = {}) => a.interviewAt && Date.parse(a.interviewAt) > Date.now() && !['rejected', 'withdrawn'].includes(a.status)
  ? `<span class="due later interview-chip" title="Interview ${esc(exactTime(a.interviewAt))}"><i class="cal-dot"></i>${short ? '' : 'Interview '}${shortDate(a.interviewAt)}, ${clockTime(a.interviewAt)}</span>` : '';

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
          <input id="f-deadline" name="deadline" type="date" value="${a.deadline ? isoDate(a.deadline) : ''}" aria-describedby="deadline-note">
          <input id="f-deadline-time" name="deadlineTime" type="time" value="${a.deadline ? isoTime(a.deadline) : ''}" aria-label="Deadline time (optional)" title="Optional: leave empty for the end of the day">
          <span id="deadline-extra">${deadlineExtraHtml(a)}</span>
        </div>
        <p class="field-note" id="deadline-note">${DATE_HINTS.deadline}</p></div>
      <div class="field wide"><label for="f-interview">Interview</label>
        <div class="deadline-field">
          <input id="f-interview" name="interview" type="date" value="${a.interviewAt ? isoDate(a.interviewAt) : ''}" aria-describedby="interview-note">
          <input id="f-interview-time" name="interviewTime" type="time" value="${a.interviewAt ? isoTime(a.interviewAt) : ''}" aria-label="Interview time">
          <span id="interview-extra">${interviewExtraHtml(a)}</span>
        </div>
        <p class="field-note" id="interview-note">${DATE_HINTS.interview}</p></div>`}
      <div class="field wide"><label for="f-notes">Notes</label><textarea id="f-notes" name="notes" placeholder="Referral, recruiter name, salary range…">${esc(a.notes)}</textarea></div>
      ${isNew ? '' : resumeFieldsHtml(a)}
    </div>`;
}

// The buttons beside the deadline and interview, which change with what's saved. The boxes
// themselves are left alone, so saving never moves you out of the one you're in.
const deadlineExtraHtml = a => a.deadline ? `<button class="btn" type="button" id="deadline-done">${icon('check')}Mark done</button>` : '';
const interviewExtraHtml = a => a.interviewAt
  ? `<a class="btn" href="${esc(googleLink({ kind: 'interview', a, at: a.interviewAt }))}" target="_blank" rel="noopener" title="Add this interview to Google Calendar">${icon('calendar')}Add to Google</a>` : '';

// The line under the deadline and interview boxes: a hint normally, a problem in red.
const DATE_HINTS = {
  deadline: 'Time is optional: no time means the end of that day.',
  interview: 'Needs a date and a time, so it can go on your calendar.',
};
function fieldNote(which, text = null) {
  const el = $(`#${which}-note`);
  if (!el) return;
  el.textContent = text || DATE_HINTS[which];
  el.classList.toggle('err', Boolean(text));
}

// For Resume insights: which resume this went out with, and the job description if you
// paste it (the emails rarely say much about the role).
function resumeFieldsHtml(a) {
  const versions = state.resumes || [];
  const day = isoDate(a.appliedAt);
  const byDate = versions.filter(v => v.usedFrom <= day).at(-1) ?? versions[0];
  const words = (a.posting?.match(/\S+/g) || []).length;
  return `
    ${versions.length ? `<div class="field wide"><label for="f-resume">Resume sent</label>
      <select id="f-resume" name="resumeId">
        <option value="">From the date you applied (${esc(byDate.name)})</option>
        ${versions.map(v => `<option value="${esc(v.id)}" ${a.resumeId === v.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}
      </select></div>` : ''}
    <details class="field wide posting-field" ${a.posting ? 'open' : ''}>
      <summary>Job description <span class="dim">${words ? `${words} words` : 'Optional, for Resume insights'}</span>${icon('chevron')}</summary>
      <textarea id="f-posting" name="posting" rows="7" maxlength="20000" aria-label="Job description" placeholder="Paste the job description from the posting. Resume insights uses it to find the skills this role asks for.">${esc(a.posting)}</textarea>
    </details>
    ${fitFieldHtml(a)}`;
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
      <div class="review-slot">${reviewHtml(a)}${quietNoteHtml(a)}</div>
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
  drawerSaved = saved;
  let notesTimer;
  const saveField = async input => {
    const { name, value } = input;
    if (value === saved[name]) return;
    if (name === 'company' && !value.trim()) {
      input.value = saved.company;
      return savedNote("Company can't be empty", 'err');
    }
    if (name === 'url' && value.trim() && !isWebLink(value.trim())) return savedNote('Links need to start with https://', 'err');
    // The date and time boxes save together as one deadline, worked out in your own time
    // zone. No time means the end of the day; a time with no date waits for the date.
    const isDeadline = name === 'deadline' || name === 'deadlineTime';
    const day = form.elements.deadline?.value;
    if (isDeadline) fieldNote('deadline');
    if (name === 'deadlineTime' && !day) return fieldNote('deadline', 'Pick a date for the deadline too');
    // An interview needs both a date and a time; clearing the date removes it.
    const isInterview = name === 'interview' || name === 'interviewTime';
    const iDay = form.elements.interview?.value, iTime = form.elements.interviewTime?.value;
    if (isInterview) fieldNote('interview');
    if (isInterview && iDay && !iTime) return fieldNote('interview', 'Add the interview time too');
    if (isInterview && !iDay && iTime) return fieldNote('interview', 'Pick a date for the interview too');
    const body = isDeadline
      ? { deadline: day ? new Date(`${day}T${form.elements.deadlineTime.value || '23:59'}`).toISOString() : '' }
      : isInterview ? { interviewAt: iDay ? new Date(`${iDay}T${iTime}`).toISOString() : '' }
      : { [name]: value };
    saved[name] = value;
    savedNote('Saving…');
    try {
      await api('PATCH', `/api/applications/${a.id}`, body);
      await load();
      // A new deadline shows or hides "Mark done" (and an interview its calendar link),
      // updated in place so you stay in the box you were in.
      const now = state.applications.find(x => x.id === a.id);
      if (now && isDeadline) setExtra('#deadline-extra', deadlineExtraHtml(now));
      if (now && isInterview) setExtra('#interview-extra', interviewExtraHtml(now));
      savedNote('Saved', 'ok');
    } catch (err) {
      saved[name] = undefined; // not saved: leaving the box again tries again
      if (isDeadline || isInterview) fieldNote(isDeadline ? 'deadline' : 'interview', err.message);
      else savedNote(err.message, 'err');
    }
  };
  form.addEventListener('change', e => { if (e.target.name) saveField(e.target); });
  form.addEventListener('input', e => {
    if (e.target.name !== 'notes' && e.target.name !== 'posting') return;
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => saveField(e.target), 900);
  });
  form.addEventListener('submit', e => e.preventDefault());

  // "Mark done" comes and goes with the deadline, so it's listened for on the form.
  form.addEventListener('click', async e => {
    const done = e.target.closest('#deadline-done');
    if (!done) return;
    done.disabled = true;
    try {
      await api('PATCH', `/api/applications/${a.id}`, { deadlineDone: true });
      await load();
      const now = state.applications.find(x => x.id === a.id);
      form.elements.deadline.value = now?.deadline ? isoDate(now.deadline) : '';
      form.elements.deadlineTime.value = now?.deadline ? isoTime(now.deadline) : '';
      saved.deadline = form.elements.deadline.value;
      saved.deadlineTime = form.elements.deadlineTime.value;
      setExtra('#deadline-extra', now ? deadlineExtraHtml(now) : '');
      savedNote('Deadline done', 'ok');
    } catch (err) {
      done.disabled = false;
      fieldNote('deadline', err.message);
    }
  });

  // Check fit. A job description still being typed is saved first, so the AI sees all of it.
  $('#fit-btn')?.addEventListener('click', () => withConsent(async () => {
    const btn = $('#fit-btn');
    const posting = form.elements.posting;
    if (!posting.value.trim()) {
      posting.closest('details').open = true;
      posting.focus();
      return savedNote('Paste the job description first');
    }
    clearTimeout(notesTimer);
    if (posting.value !== saved.posting) await saveField(posting);
    btn.disabled = true;
    btn.classList.add('busy');
    try {
      const { fit, ai } = await api('POST', `/api/applications/${a.id}/fit`);
      state.ai = ai;
      $('#fit-result').innerHTML = fitHtml(fit);
      $('#fit-left').textContent = aiLeftText(ai);
      btn.querySelector('span').textContent = 'Check fit again';
      load();
    } catch (err) {
      savedNote(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  }));

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
        : `Re-read ${r.emails} ${r.emails === 1 ? 'email' : 'emails'} · nothing changed.${r.notJob ? ` ${r.notJob} no longer look like application emails; use “Wrong application?” on each to remove them.` : ''}`, 'ok');
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
    const btn = $('#delete-btn');
    btn.disabled = true;
    let undo;
    try {
      ({ undo } = await api('DELETE', `/api/applications/${a.id}`));
    } catch (err) {
      btn.disabled = false;
      return toast(`Couldn't delete ${a.company}: ${err.message}`);
    }
    closeDrawer();
    await load().catch(() => {});
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
    if (await setStatus(status.dataset.statusFor, status.value)) toast(`Status set to ${STAGE_LABEL[status.value]}`);
    return;
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
    const restore = a.manualDeadline ? { deadline: a.manualDeadline } : { deadlineDone: false };
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
  const item = e.target.closest('[data-open]');
  if (item) openById(item.dataset.open);
});
$('#action-list').addEventListener('keydown', e => {
  const item = e.target.closest('[data-open]');
  if (item && e.target === item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openById(item.dataset.open); }
});
