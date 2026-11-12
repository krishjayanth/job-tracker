// Resume insights: your versions, the resume preview, the AI's review and grade, comparing
// two versions, Check a job, and Check fit (tailoring your resume to one job).
// The dashboard's scripts are plain scripts loaded in order (see index.html), sharing one
// global scope: a file may use what an earlier one defines, and anything at all from inside
// functions that run later.

// ---------------------------------------------------------------- resume insights
// Your resume versions and the AI's review, from /api/resume. The server works it out
// on every request, so it follows each sync and edit (the live update reloads it).
let resume = null; // { versions, insights: { total, currentId, byVersion }, limits, ai, review, preview, jobFit }
let resumeShowAll = {}; // what you've opened ("Acted on or set aside"), kept across redraws

// Live updates arrive often during a sync. Redrawing the page each time would drop your
// place (focus, what you'd opened), so it only redraws when something actually changed.
let resumeJson = '';
async function loadResume() {
  let data;
  try {
    data = await api('GET', '/api/resume');
    // Showing an older version in the preview: lay that one out instead.
    if (reviewId && reviewId !== data.preview?.versionId) {
      if (data.versions.some(v => v.id === reviewId)) data.preview = await api('GET', `/api/resume/${reviewId}?preview=1`);
      else reviewId = null;
    }
  } catch (err) {
    resumeJson = '';
    $('#resume-body').innerHTML = `<p class="resume-error">${icon('alert')}${esc(err.message)}</p>`;
    return;
  }
  const json = JSON.stringify(data);
  if (json === resumeJson && $('#resume-body').childElementCount) return;
  resumeJson = view === 'resume' ? json : ''; // a hidden page isn't drawn, so it isn't up to date
  resume = data;
  renderResume();
}

// The control you were on, by its data attributes, so a redraw can put focus back on it.
function focusKey() {
  const el = document.activeElement;
  if (!el || !$('#resume-body').contains(el)) return null;
  const attrs = [...el.attributes].filter(a => a.name.startsWith('data-'));
  return attrs.length ? attrs.map(a => `[${a.name}="${CSS.escape(a.value)}"]`).join('') : null;
}

function renderResume() {
  if (view !== 'resume' || !resume) return;
  const { versions, insights: ins } = resume;
  const since = $('#resume-since');
  if (!versions.length) {
    since.textContent = '';
    $('#resume-body').innerHTML = resumeEmptyHtml();
    return;
  }
  since.textContent = !ins.total && resume.ai?.available ? 'No applications yet, so the AI grades your resume on its own for now.' : '';
  const key = focusKey();
  $('#resume-body').innerHTML = versionsHtml() + resumeReviewHtml() + jobCheckHtml();
  attachPdfPages();
  if (key) $('#resume-body').querySelector(key)?.focus();
}
// "Acted on or set aside" stays open across redraws once you open it.
$('#view-resume').addEventListener('toggle', e => {
  if (e.target.matches('.sg-decided')) resumeShowAll.decided = e.target.open;
}, true);

function resumeEmptyHtml() {
  return `
    <section class="resume-drop" id="resume-drop" aria-labelledby="drop-title">
      <span class="drop-icon">${icon('upload')}</span>
      <h2 id="drop-title">Add your resume</h2>
      <p>Drop a PDF or Word file here, or choose one. Then ask the AI what to change, or check how well it fits a job you're applying to.</p>
      <div class="drop-actions">
        <button class="btn btn-primary" type="button" data-resume-file>${icon('upload')}Choose a file</button>
        <button class="btn" type="button" data-resume-paste>Paste text instead</button>
      </div>
      <span class="fine">${icon('shield')}nuj keeps the text, and a PDF so it can show you its pages. Only you can see them.</span>
    </section>`;
}

function versionsHtml() {
  const { versions, insights: ins, limits } = resume;
  const cards = [...versions].reverse().map(v => {
    const g = ins.byVersion.find(x => x.key === v.id);
    const current = v.id === ins.currentId;
    return `
      <li class="version${current ? ' current' : ''}">
        <div class="v-top"><strong>${esc(v.name)}</strong>${current ? '<span class="v-tag">Current</span>' : ''}</div>
        <span class="v-date">Sending since ${shortDate(`${v.usedFrom}T12:00:00`)} · ${v.words} words</span>
        <span class="v-stats">${g ? appCount(g.total) : 'No applications yet'}</span>
        <div class="v-actions">
          <button class="btn btn-sm" type="button" data-version-edit="${esc(v.id)}" aria-label="Edit ${esc(v.name)}">Edit</button>
          ${g ? `<button class="btn btn-sm btn-quiet" type="button" data-only="version:${esc(v.id)}" aria-label="Show applications sent with ${esc(v.name)}">Show applications</button>` : ''}
          <button class="btn btn-sm btn-quiet btn-danger" type="button" data-version-delete="${esc(v.id)}" aria-label="Delete ${esc(v.name)}">${icon('trash')}</button>
        </div>
      </li>`;
  }).join('');
  const full = versions.length >= limits.versions;
  return `
    <section class="panel" aria-labelledby="versions-title">
      <div class="panel-head">
        <div class="head-text"><h2 id="versions-title">Versions</h2>
          <span class="hint">Each application counts toward the version you were sending when you applied. You can change it in the application's panel.</span></div>
        <button class="btn btn-sm" type="button" data-version-add ${full ? `disabled title="You can keep up to ${limits.versions} versions"` : ''}>${icon('plus')}<span>New version</span></button>
      </div>
      <ul class="versions">${cards}</ul>
    </section>`;
}

// "Show applications" on a version: the table, filtered to the ones sent with it.
function showOnly(spec) {
  const [kind, ...rest] = spec.split(':');
  const g = kind === 'version' && resume.insights.byVersion.find(x => x.key === rest.join(':'));
  const v = g && resume.versions.find(x => x.id === g.key);
  if (!v) return;
  only = { label: `Resume: ${v.name}`, ids: new Set(g.ids) };
  filter = 'all';
  month = 'all';
  renderMonths();
  renderTabs();
  renderTable();
  go('#/applications');
}

$('#view-resume').addEventListener('click', async e => {
  const t = e.target;
  if (t.closest('[data-resume-file]')) return $('#rv-file').click();
  if (t.closest('[data-resume-paste]') || t.closest('[data-version-add]')) return openVersionDialog();
  const o = t.closest('[data-only]');
  if (o) return showOnly(o.dataset.only);
  const edit = t.closest('[data-version-edit]');
  if (edit) return openVersionDialog({ id: edit.dataset.versionEdit });
  const del = t.closest('[data-version-delete]');
  if (del) {
    del.disabled = true;
    try {
      const { removed, moved } = await api('DELETE', `/api/resume/${del.dataset.versionDelete}`);
      if (compareId === removed.id) compareId = null;
      await loadResume();
      const where = moved?.count && moved.to ? ` Its ${appCount(moved.count)} now count toward ${moved.to}.` : '';
      toast(`Deleted ${removed.name}.${where}`, () => api('POST', '/api/resume', removed).then(loadResume), { ms: 12_000 });
    } catch (err) {
      del.disabled = false;
      toast(err.message);
    }
  }
});

// Dropping a file on the empty page reads it, the same as choosing one.
$('#view-resume').addEventListener('dragover', e => {
  const drop = e.target.closest('#resume-drop');
  if (!drop) return;
  e.preventDefault();
  drop.classList.add('over');
});
$('#view-resume').addEventListener('dragleave', e => {
  const drop = e.target.closest('#resume-drop');
  if (drop && !drop.contains(e.relatedTarget)) drop.classList.remove('over');
});
$('#view-resume').addEventListener('drop', e => {
  const drop = e.target.closest('#resume-drop');
  if (!drop) return;
  e.preventDefault();
  drop.classList.remove('over');
  const file = e.dataTransfer.files[0];
  if (file) takeResumeFile(file);
});

// ---- the version sheet: add one, or edit one (name, date, text) ----
const resumeDialog = $('#resume-dialog');
let editingVersion = null; // the version being edited, or null for a new one
const resumeMsg = (text, tone = '') => { const el = $('#resume-msg'); el.className = `key-msg ${tone}`; el.textContent = text; };
const defaultVersionName = () => `Resume, ${new Date().toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;

function countResumeText() {
  const n = $('#rv-text').value.length, max = resume?.limits.text ?? 40_000;
  const el = $('#rv-count');
  el.textContent = n ? `${n.toLocaleString()} of ${max.toLocaleString()} characters` : '';
  el.classList.toggle('over', n > max);
}
$('#rv-text').addEventListener('input', countResumeText);

let sheetFile = null; // { file, kind } read into the sheet, kept with the version on save
async function openVersionDialog({ id = null, text = '', note = '', file = null } = {}) {
  sheetFile = file;
  if (!id && resume && resume.versions.length >= resume.limits.versions) {
    return toast(`You can keep up to ${resume.limits.versions} versions. Delete one to add another`);
  }
  let v = null;
  if (id) {
    try { v = await api('GET', `/api/resume/${id}`); } catch (err) { return toast(err.message); }
  }
  editingVersion = id;
  $('#resume-dialog-title').textContent = v ? `Edit ${v.name}` : 'Add a resume version';
  $('#resume-dialog-sub').textContent = v
    ? 'Change its name, the date you started sending it, or its text. Read a new file to replace the text.'
    : text ? 'Check the text nuj read from your file and fix anything that came out wrong.'
      + (file?.kind === 'pdf' ? ' The PDF is kept too, so you can see its pages here.' : '')
      : 'Paste your resume, or read it from a PDF or Word file. A PDF is kept so you can see its pages here.';
  $('#rv-name').value = v?.name ?? (resume?.versions.length ? '' : defaultVersionName());
  $('#rv-name').placeholder = defaultVersionName();
  $('#rv-from').value = v?.usedFrom ?? isoDate(new Date().toISOString());
  $('#rv-text').value = v?.text ?? text;
  $('#resume-save').textContent = v ? 'Save changes' : 'Save version';
  $('#resume-save').disabled = false;
  resumeMsg(note);
  countResumeText();
  resumeDialog.showModal();
  (v || text ? $('#rv-name') : $('#rv-text')).focus();
}

async function readResumeFile(file) {
  if (file.size > 5 * 1024 * 1024) throw new Error('That file is too big. nuj takes resumes up to 5 MB');
  const res = await fetch('/api/resume/extract', {
    method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    noteError(`POST /api/resume/extract → ${res.status} ${data.error || res.statusText}`);
    throw new ApiError(data.error || "nuj couldn't read that file. Try again, or paste the text");
  }
  return data;
}

// A file chosen or dropped: into the open sheet, or open the sheet with it.
async function takeResumeFile(file) {
  const inSheet = resumeDialog.open;
  const drop = $('#resume-drop');
  if (inSheet) resumeMsg(`Reading ${file.name}…`); else drop?.classList.add('busy');
  try {
    const { text, cut, kind } = await readResumeFile(file);
    const note = cut ? 'Only the first 40,000 characters fit, so the end was left out.' : '';
    if (inSheet) {
      sheetFile = { file, kind };
      $('#rv-text').value = text;
      countResumeText();
      resumeMsg(note || `Read ${file.name}. Check the text below.`, note ? '' : 'ok');
    } else {
      await openVersionDialog({ text, note, file: { file, kind } });
    }
  } catch (err) {
    if (inSheet) resumeMsg(err.message, 'err'); else toast(err.message);
  } finally {
    drop?.classList.remove('busy');
  }
}
$('#rv-file-btn').addEventListener('click', () => $('#rv-file').click());
$('#rv-file').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = ''; // choosing the same file again still counts
  if (file) takeResumeFile(file);
});

$('#resume-form').addEventListener('submit', async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  if (!body.text.trim()) return resumeMsg('Add the text of your resume', 'err');
  const btn = $('#resume-save');
  btn.disabled = true;
  resumeMsg('Saving…');
  try {
    const saved = editingVersion
      ? await api('PATCH', `/api/resume/${editingVersion}`, body)
      : await api('POST', '/api/resume', body);
    // A PDF is kept to show its pages; text from a Word file means an old PDF no longer matches.
    let pdfProblem = '';
    if (sheetFile?.kind === 'pdf') await uploadPdf(saved.id, sheetFile.file).catch(err => { pdfProblem = err.message; });
    else if (sheetFile?.kind === 'docx' && saved.pdf) await api('DELETE', `/api/resume/${saved.id}/pdf`).catch(() => {});
    resumeDialog.close();
    toast(pdfProblem || (editingVersion ? `Saved ${saved.name}` : `Added ${saved.name}`));
    resumeJson = '';
    await loadResume();
  } catch (err) {
    btn.disabled = false;
    resumeMsg(err.message, 'err');
  }
});
resumeDialog.addEventListener('click', e => {
  if (e.target === e.currentTarget || e.target.closest('[data-close-dialog]')) resumeDialog.close();
});

// ---- AI: the review of your resume, and the consent asked before anything is sent ----
// How many AI runs are left today, in words ('' for the owner, who has no limit).
function aiLeftText(ai) {
  if (!ai || ai.unlimited) return '';
  if (!ai.left) return `None left today. More ${resetTime(ai.resetsAt)}`;
  return `${ai.left} of ${ai.limit} left today`;
}
const resetTime = iso => {
  const hours = Math.max(1, Math.round((Date.parse(iso) - Date.now()) / 3_600_000));
  return hours >= 20 ? 'tomorrow' : `in about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
};
const SG_STATE = { done: 'Done', dismissed: 'Skipped' };

// How a score reads, in words and as a colour.
const gradeWord = n => (n >= 90 ? 'Excellent' : n >= 80 ? 'Strong' : n >= 70 ? 'Decent' : n >= 60 ? 'Needs work' : 'Weak');
const gradeTone = n => (n >= 80 ? 'good' : n >= 65 ? 'fair' : 'poor');

// A ring that fills to the score, with the number in the middle. It draws itself in the
// first time a review is shown, not on every redraw.
let ringsDrawn = new Set();
function scoreRingHtml(score, { size = 92, label, key = '' } = {}) {
  const r = 42, c = 2 * Math.PI * r;
  const animate = key && !ringsDrawn.has(key);
  if (animate) ringsDrawn.add(key);
  return `<div class="score-ring ${gradeTone(score)}${animate ? ' draw' : ''}" style="--size:${size}px" role="img" aria-label="${esc(label ?? `${score} out of 100`)}">
    <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="track" cx="50" cy="50" r="${r}"/><circle class="fill" cx="50" cy="50" r="${r}"
      style="--dash:${c.toFixed(1)};--to:${(c * (1 - score / 100)).toFixed(1)}"/></svg>
    <span class="score-num" aria-hidden="true">${score}</span></div>`;
}

// X, Y and Z of "Accomplished [X] as measured by [Y], by doing [Z]": the ones a bullet is
// missing are crossed out.
const XYZ_NAME = { X: 'the result', Y: 'a measure', Z: 'how' };
function xyzHtml(missing = []) {
  return `<span class="xyz-set">${['X', 'Y', 'Z'].map(p => {
    const miss = missing.includes(p);
    return `<span class="xyz ${miss ? 'miss' : 'ok'}" title="${miss ? 'Missing' : 'Has'} ${p}: ${XYZ_NAME[p]}">${p}<span class="sr-only">${miss ? ' missing' : ' present'}: ${XYZ_NAME[p]}</span></span>`;
  }).join('')}</span>`;
}

function rubricHtml(rubric) {
  return `<ul class="rubric">${rubric.map(r => `
    <li>
      <div class="rb-top"><span class="rb-name">${esc(r.name)}</span><span class="rb-score"><b>${r.score}</b>/10</span></div>
      <div class="rb-track" aria-hidden="true"><i class="${gradeTone(r.score * 10)}" style="width:${r.score * 10}%"></i></div>
      ${r.note ? `<p class="rb-note">${esc(r.note)}</p>` : ''}
    </li>`).join('')}</ul>`;
}

const stateButtons = (id, state, name) => state === 'open'
  ? `<button class="btn btn-sm btn-quiet" type="button" data-item="${esc(id)}" data-item-state="done" aria-label="Done: ${esc(name)}">${icon('check')}Done</button>
     <button class="btn btn-sm btn-quiet" type="button" data-item="${esc(id)}" data-item-state="dismissed" aria-label="Skip: ${esc(name)}">Skip</button>`
  : `<span class="dim">${SG_STATE[state]}</span>
     <button class="btn btn-sm btn-quiet" type="button" data-item="${esc(id)}" data-item-state="open" aria-label="Undo: ${esc(name)}">Undo</button>`;

// One bullet that fails the XYZ test: what's missing, the line, and its rewrite.
// `here`: the preview shows the version it was graded on, so the line can be found.
function bulletFixHtml(b, here, versionId) {
  return `
    <li class="fix ${b.state}" data-sg-card="${esc(b.id)}">
      <div class="fix-top">${xyzHtml(b.missing)}<span class="fix-note">${esc(b.note)}</span></div>
      <p class="fix-from">${esc(b.line)}</p>
      ${b.rewrite ? `<p class="fix-to">${esc(b.rewrite)}</p>` : ''}
      <div class="sg-actions">
        ${b.state === 'open' && b.rewrite && here && b.at >= 0 ? useRewriteHtml(versionId, { from: b.line, to: b.rewrite }, b.id) : ''}
        ${b.state === 'open' && b.rewrite ? `<button class="btn btn-sm btn-quiet" type="button" data-copy="${esc(b.rewrite)}">${icon('check', 'icon copied')}<span>Copy</span></button>` : ''}
        ${b.state === 'open' && here && b.at >= 0 ? `<button class="icon-btn" type="button" data-sg-locate="${esc(b.id)}" title="Show in your resume" aria-label="Show this bullet in your resume">${icon('search')}</button>` : ''}
        <span class="sg-push">${stateButtons(b.id, b.state, b.line.slice(0, 60))}</span>
      </div>
    </li>`;
}

function appPointHtml(s) {
  return `
    <li class="suggestion ${s.state}" data-sg-card="${esc(s.id)}">
      <strong class="sg-title">${esc(s.title)}</strong>
      <p class="sg-why">${esc(s.why)}</p>
      <p class="sg-change">${esc(s.change)}</p>
      <div class="sg-actions">${stateButtons(s.id, s.state, s.title)}</div>
    </li>`;
}

// While the AI grades: what it's doing, in turn (the review takes a while).
const GRADING_STEPS = ['Skimming it like a recruiter would', 'Scoring the rubric', 'Checking every bullet against XYZ', 'Cross-checking your skills', 'Writing the rewrites'];
let grading = false, gradingTimer = null;
function gradingHtml() {
  return `<div class="grading" role="status"><span class="grading-dot" aria-hidden="true">${icon('sparkles')}</span><span class="grading-text shimmer">${GRADING_STEPS[0]}…</span></div>
    <div class="grade-card skeleton" aria-hidden="true"><i class="sk-ring"></i><div><i></i><i></i><i></i></div></div>`;
}

function reviewHtml(r) {
  const { ai, review: rv } = resume;
  if (!ai?.available) return '';
  const hasApps = resume.insights.total > 0;
  const noneLeft = !ai.unlimited && !ai.left;
  const fresh = Boolean(rv?.upToDate);
  const label = grading ? 'Grading' : !rv ? 'Grade my resume' : fresh ? 'Up to date' : 'Grade again';
  const head = `
      <div class="sg-head">
        <h3 id="sg-title">Review</h3>
        <button class="btn btn-sm${rv ? '' : ' btn-primary'}${grading ? ' busy' : ''}" type="button" data-grade ${fresh || noneLeft || grading ? 'disabled' : ''}
          ${fresh ? 'title="Nothing has changed since this review"' : ''}>${icon('sparkles')}<span>${label}</span></button>
      </div>`;
  const revoke = ai.consent ? '<button class="meta-link sg-revoke" type="button" data-ai-revoke>Stop sending my resume to OpenAI</button>' : '';
  if (grading) return `<div class="review-sg">${head}${gradingHtml()}</div>`;
  if (!rv) {
    return `<div class="review-sg">${head}
      <p class="hint sg-intro">A strict recruiter's read of your resume: a score out of 100, five rubric scores, every bullet that fails the XYZ formula with a rewrite, and skills you list but never show.${hasApps ? ' It also looks at how your applications went.' : ''}${aiLeftText(ai) ? ` <span id="ai-left">${aiLeftText(ai)}.</span>` : ''}</p>
      ${revoke}</div>`;
  }
  const here = rv.versionId === r.versionId;
  const open = rv.bullets.filter(b => b.state === 'open');
  const points = rv.fromApplications.filter(x => x.state === 'open');
  const decided = [...rv.bullets, ...rv.fromApplications].filter(x => x.state !== 'open');
  const delta = rv.previous ? rv.score - rv.previous.score : 0;
  return `
    <div class="review-sg">
      ${head}
      ${!here ? `<p class="sg-note">${icon('alert')}Graded on ${esc(rv.version)}. Show that version to see its bullets marked.</p>` : ''}
      ${!rv.upToDate ? `<p class="sg-note">${icon('alert')}Your resume or applications have changed since this review ${timeAgo(rv.at)}. Grade again to see where you stand.</p>` : ''}
      <div class="grade-card">
        ${scoreRingHtml(rv.score, { label: `Score ${rv.score} out of 100, grade ${rv.grade}`, key: rv.at })}
        <div class="grade-text">
          <div class="grade-line"><span class="grade-letter ${gradeTone(rv.score)}">${esc(rv.grade)}</span><span class="grade-word">${gradeWord(rv.score)}</span>
            ${delta ? `<span class="grade-delta ${delta > 0 ? 'up' : 'down'}" title="Since your last review (${esc(rv.previous.version)}, ${timeAgo(rv.previous.at)})">${delta > 0 ? '+' : '−'}${Math.abs(delta)}</span>` : ''}</div>
          <p class="grade-skim">${esc(rv.skim)}</p>
          <span class="hint">${esc(rv.version)} · ${timeAgo(rv.at)}${aiLeftText(ai) ? ` · <span id="ai-left">${aiLeftText(ai)}</span>` : ''}</span>
        </div>
      </div>
      ${rv.biggestWeakness ? `<div class="weakness">${icon('target')}<div><strong>Biggest thing holding it back</strong><p>${esc(rv.biggestWeakness)}</p></div></div>` : ''}
      <section class="rv-block" aria-labelledby="rubric-title"><h4 id="rubric-title">Rubric</h4>${rubricHtml(rv.rubric)}</section>
      ${rv.unprovenSkills.length ? `<section class="rv-block" aria-labelledby="ghost-title"><h4 id="ghost-title">Skills you list but never show <span class="num">${rv.unprovenSkills.length}</span></h4>
        <p class="hint">Use each in a bullet that shows what you did with it, or take it off your skills line.</p>
        <div class="kw-list">${rv.unprovenSkills.map(k => `<span class="kw ghost">${esc(k)}</span>`).join('')}</div></section>` : ''}
      <section class="rv-block" aria-labelledby="fix-title"><h4 id="fix-title">Bullets to fix <span class="num">${open.length}</span></h4>
        ${open.length ? `<p class="hint">Each misses part of “Accomplished <b>X</b> as measured by <b>Y</b>, by doing <b>Z</b>”. Swap the [X%] and [N] in a rewrite for your real numbers.</p>
          <ul class="fixes">${open.map(b => bulletFixHtml(b, here, rv.versionId)).join('')}</ul>`
          : `<p class="dim sg-empty">${rv.bullets.length ? "You've gone through every bullet. Grade again to see your new score." : 'Every bullet passes the XYZ test.'}</p>`}
      </section>
      ${points.length ? `<section class="rv-block" aria-labelledby="apps-title"><h4 id="apps-title">From your applications</h4>
        <ul class="suggestions">${points.map(appPointHtml).join('')}</ul></section>` : ''}
      ${decided.length ? `<details class="sg-decided" ${resumeShowAll.decided ? 'open' : ''}><summary>Done or skipped <span class="dim num">${decided.length}</span>${icon('chevron')}</summary>
        <ul class="fixes">${decided.map(x => ('line' in x ? bulletFixHtml(x, here, rv.versionId) : appPointHtml(x))).join('')}</ul></details>` : ''}
      ${revoke}
    </div>`;
}

// Before the first AI run: say what goes to OpenAI and ask. `then` runs once allowed.
const consentDialog = $('#ai-consent');
let afterConsent = null;
function withConsent(run) {
  const ai = resume?.ai ?? state.ai;
  if (ai?.consent) return run();
  afterConsent = run;
  $('#ai-consent-limit').textContent = ai && !ai.unlimited ? ` You get ${ai.limit} a day.` : '';
  consentDialog.showModal();
}
$('#ai-consent-allow').addEventListener('click', async () => {
  const btn = $('#ai-consent-allow');
  btn.disabled = true;
  try {
    const { ai } = await api('POST', '/api/insights/consent', { allow: true });
    state.ai = ai;
    if (resume) resume.ai = ai;
    consentDialog.close();
    const run = afterConsent;
    afterConsent = null;
    run?.();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});
consentDialog.addEventListener('click', e => {
  if (e.target === e.currentTarget || e.target.closest('[data-close-dialog]')) consentDialog.close();
});
consentDialog.addEventListener('close', () => { afterConsent = null; });

async function gradeResume() {
  grading = true;
  renderResume();
  let step = 0;
  gradingTimer = setInterval(() => {
    const el = $('#resume-body .grading-text');
    step = (step + 1) % GRADING_STEPS.length;
    if (el) el.textContent = `${GRADING_STEPS[step]}…`;
  }, 2200);
  let note;
  try {
    const r = await api('POST', '/api/insights/review');
    note = r.cached ? 'Your review is already up to date' : null;
  } catch (err) {
    note = err.message;
  }
  clearInterval(gradingTimer);
  grading = false;
  resumeJson = '';
  await loadResume();
  if (note) toast(note);
  else if (resume.review) toast(`Graded ${resume.review.grade}, ${resume.review.score} out of 100`);
}

$('#view-resume').addEventListener('click', async e => {
  const t = e.target;
  if (t.closest('[data-grade]')) return withConsent(gradeResume);
  const pick = t.closest('[data-item-state]');
  if (pick) {
    pick.disabled = true;
    try {
      await api('PATCH', `/api/insights/review/items/${pick.dataset.item}`, { state: pick.dataset.itemState });
    } catch (err) {
      toast(err.message);
    }
    return loadResume();
  }
  const revoke = t.closest('[data-ai-revoke]');
  if (revoke) {
    revoke.disabled = true;
    try {
      const { ai } = await api('POST', '/api/insights/consent', { allow: false });
      state.ai = ai;
      toast("nuj won't send your resume to OpenAI. Your review stays here");
    } catch (err) {
      revoke.disabled = false;
      return toast(`Couldn't change that: ${err.message}`);
    }
    return loadResume();
  }
});

// ---- the PDF itself: real pages, with the same highlights drawn on top ----
// PDF.js draws each page once (kept per version and upload); the highlights are placed by
// finding each line's words in the PDF's own text, so they sit on the real lines.
let pdfLibrary = null;
const pdfDocs = new Map(); // "<version id>:<uploaded at>" -> Promise<{ pages, total }>
let reviewMode = 'pdf'; // 'pdf' or 'text' when the version has a PDF
const PDF_MAX_PAGES = 6;

function pdfLib() {
  pdfLibrary ??= import('/vendor/pdfjs/pdf.min.mjs').then(lib => {
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    return lib;
  });
  return pdfLibrary;
}

function pdfDoc(versionId, at) {
  const key = `${versionId}:${at}`;
  if (!pdfDocs.has(key)) {
    pdfDocs.set(key, (async () => {
      const lib = await pdfLib();
      const task = lib.getDocument({ url: `/api/resume/${versionId}/pdf`, isEvalSupported: false });
      const doc = await task.promise;
      const pages = [];
      for (let n = 1; n <= Math.min(doc.numPages, PDF_MAX_PAGES); n++) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        // Sharp at the width it's shown, on high-density screens too.
        const vp = page.getViewport({ scale: Math.min(3, (820 * Math.min(devicePixelRatio || 1, 2)) / base.width) });
        const canvas = Object.assign(document.createElement('canvas'), { width: Math.ceil(vp.width), height: Math.ceil(vp.height), className: 'pdf-canvas' });
        canvas.setAttribute('aria-hidden', 'true');
        await page.render({ canvas, viewport: vp }).promise;
        // Each run of text, as a share of the page, so the highlights scale with it.
        const items = (await page.getTextContent()).items.filter(i => i.str?.trim()).map(i => {
          const tx = lib.Util.transform(vp.transform, i.transform);
          const size = Math.hypot(tx[2], tx[3]);
          return { text: i.str, l: tx[4] / vp.width, t: (tx[5] - size * 0.95) / vp.height, w: (i.width * vp.scale) / vp.width, h: (size * 1.25) / vp.height };
        });
        pages.push({ canvas, ratio: vp.height / vp.width, items });
      }
      const total = doc.numPages;
      // The drawings and text positions are all that's needed now.
      task.destroy();
      return { pages, total };
    })().catch(err => {
      pdfDocs.delete(key);
      throw err;
    }));
  }
  return pdfDocs.get(key);
}

const looseText = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}+#%]+/gu, ' ').trim();
const measurer = document.createElement('canvas').getContext('2d');
measurer.font = '100px Helvetica, Arial, sans-serif';
const measure = s => measurer.measureText(s).width || 1;

// Where each line of the version's text sits in the PDF, as boxes (shares of the page).
// Lines are looked for in reading order, so a repeated line finds its own place.
function placeLines(doc, lines) {
  let all = '';
  const parts = [];
  doc.pages.forEach((p, page) => p.items.forEach(item => {
    const t = looseText(item.text);
    if (!t) return;
    if (all) all += ' ';
    // Measured in its own letters (capitals are wider); same positions as the lowercase form.
    parts.push({ page, item, text: item.text.replace(/[^\p{L}\p{N}+#%]+/gu, ' ').trim(), start: all.length, end: all.length + t.length });
    all += t;
  }));
  // How far into a run some text reaches, by its width rather than its letter count ("W"
  // is wider than "i"), measured in a sans-serif like most resumes use.
  const share = (p, n) => n <= 0 ? 0 : n >= p.end - p.start ? 1 : measure(p.text.slice(0, n)) / measure(p.text);
  const boxes = (from, to) => {
    const found = parts.filter(p => p.start < to && from < p.end).map(p => {
      const a = share(p, from - p.start), b = share(p, to - p.start);
      return { page: p.page, l: p.item.l + p.item.w * a, t: p.item.t, w: p.item.w * (b - a), h: p.item.h };
    });
    // Runs on the same printed line become one box.
    const merged = [];
    for (const r of found) {
      const last = merged.at(-1);
      if (last && last.page === r.page && Math.abs(last.t - r.t) < last.h * 0.5) {
        const right = Math.max(last.l + last.w, r.l + r.w);
        last.l = Math.min(last.l, r.l);
        last.w = right - last.l;
      } else merged.push({ ...r });
    }
    return merged;
  };
  const placed = new Map();
  let cursor = 0;
  lines.forEach((l, i) => {
    if (l.kind === 'blank') return;
    let body = looseText(l.text.slice(l.at));
    if (body.length < 3) return;
    let at = all.indexOf(body, cursor);
    if (at < 0) at = all.indexOf(body);
    if (at < 0) { // laid out differently in the PDF: settle for its start
      body = body.slice(0, 40);
      at = all.indexOf(body, cursor);
    }
    if (at < 0) return;
    cursor = at + body.length;
    placed.set(i, { line: boxes(at, at + body.length) });
  });
  return placed;
}

const boxStyle = b => `left:${(b.l * 100).toFixed(2)}%;top:${(b.t * 100).toFixed(2)}%;width:${(b.w * 100).toFixed(2)}%;height:${(b.h * 100).toFixed(2)}%`;

function pdfPagesHtml(r, doc) {
  const placed = placeLines(doc, r.lines);
  const bySg = suggestionsByLine(r);
  const marks = doc.pages.map(() => []);
  const notes = doc.pages.map(() => '');
  let missing = 0;
  r.lines.forEach((l, i) => {
    const sgs = bySg.get(i) || [];
    if (!sgs.length) return;
    const spot = placed.get(i);
    if (!spot?.line.length) { missing++; return; }
    const ids = ` data-sg-ids="${sgs.map(s => esc(s.id)).join(' ')}"`;
    for (const b of spot.line) marks[b.page].push(`<span class="pdf-line is-sg${reviewOpen === i ? ' open' : ''}"${ids} style="${boxStyle(b)}"></span>`);
    // One button over the whole line, so it can be clicked or reached with Tab.
    const first = spot.line[0];
    const lastBox = spot.line.filter(b => b.page === first.page).at(-1);
    const hit = { ...first, h: lastBox.t + lastBox.h - first.t, w: Math.max(...spot.line.filter(b => b.page === first.page).map(b => b.l + b.w)) - first.l };
    const why = sgs[0]?.note || 'needs a fix';
    marks[first.page].push(`<button type="button" class="pdf-hit" data-ln="${i}"${ids} aria-expanded="${reviewOpen === i}" style="${boxStyle(hit)}"
      aria-label="${esc(l.text.slice(l.at).slice(0, 80))}: ${why}"></button>`);
    if (reviewOpen === i) {
      notes[first.page] = `<div class="pdf-note" style="top:calc(${((hit.t + hit.h) * 100).toFixed(2)}% + 6px)">
        <button class="icon-btn pdf-note-close" type="button" data-ln="${i}" aria-label="Close">${icon('x')}</button>${lineNoteHtml(l, i, sgs)}</div>`;
    }
  });
  const pages = doc.pages.map((p, n) => `
    <div class="pdf-page" data-page="${n}" style="aspect-ratio:1/${p.ratio.toFixed(4)}">
      <div class="pdf-slot"></div><div class="pdf-marks">${marks[n].join('')}</div>${notes[n]}
    </div>`).join('');
  return `${pages}
    ${doc.total > doc.pages.length ? `<p class="pdf-foot">Showing the first ${doc.pages.length} of ${doc.total} pages.</p>` : ''}
    ${missing ? `<p class="pdf-foot">${icon('alert')}${missing} highlighted ${missing === 1 ? 'line isn\'t' : 'lines aren\'t'} where nuj expected in this PDF. <button class="meta-link" type="button" data-review-mode="text">See them in the text view</button></p>` : ''}`;
}

// The page area for a version: its PDF when it has one (drawn once loaded), else the text
// with a prompt to add the PDF.
function previewHtml(r) {
  const v = resume.versions.find(x => x.id === r.versionId);
  if (compareId) return compareHtml(r);
  if (v?.pdf && !v.pdf.stale && reviewMode === 'pdf') {
    const key = `${v.id}:${v.pdf.at}`;
    const ready = pdfReady.get(key);
    if (!ready) {
      pdfDoc(v.id, v.pdf.at).then(doc => { keepPdf(key, doc); renderResume(); })
        .catch(() => { pdfFailed.add(key); reviewMode = 'text'; renderResume(); });
      return '<div class="pdf-view loading" aria-busy="true"><div class="pdf-page pdf-skeleton" style="aspect-ratio:1/1.294"></div><span class="sr-only">Loading your PDF</span></div>';
    }
    return `<div class="pdf-view" data-pdf-key="${esc(key)}">${pdfPagesHtml(r, ready)}</div>`;
  }
  const failed = v?.pdf && pdfFailed.has(`${v.id}:${v.pdf.at}`);
  return `${v?.pdf?.stale ? `
    <div class="pdf-ask">
      <span class="drop-icon">${icon('file')}</span>
      <div><strong>Your PDF is from before you edited the text</strong><span>So here's the text instead. Upload the PDF of the edited ${esc(r.name)} to see its pages again.</span></div>
      <button class="btn btn-sm" type="button" data-pdf-upload="${esc(r.versionId)}">${icon('upload')}<span>Upload new PDF</span></button>
    </div>` : !v?.pdf ? `
    <div class="pdf-ask">
      <span class="drop-icon">${icon('file')}</span>
      <div><strong>See your real resume here</strong><span>Upload the PDF of ${esc(r.name)} and nuj shows its pages, with the AI's review marked on them.</span></div>
      <button class="btn btn-sm" type="button" data-pdf-upload="${esc(r.versionId)}">${icon('upload')}<span>Upload PDF</span></button>
    </div>` : failed ? `<p class="pdf-foot">${icon('alert')}nuj couldn't open this PDF, so here's its text.</p>` : ''}
    <article class="paper" aria-label="${esc(r.name)}">${paperHtml(r)}</article>`;
}
const pdfReady = new Map(); // key -> drawn document, once loaded
const pdfFailed = new Set();
// Each drawn page is a large image, so only the last couple of PDFs looked at are kept.
const PDF_KEEP = 2;
function keepPdf(key, doc) {
  pdfReady.delete(key);
  pdfReady.set(key, doc);
  for (const [old, drawn] of pdfReady) {
    if (pdfReady.size <= PDF_KEEP) break;
    for (const p of drawn.pages) p.canvas.width = p.canvas.height = 0; // frees the image now
    pdfReady.delete(old);
    pdfDocs.delete(old);
  }
}

// After a redraw, put each page's drawing back in its place (the canvases are kept, not redrawn).
function attachPdfPages() {
  const view = $('#resume-body .pdf-view[data-pdf-key]');
  const doc = view && pdfReady.get(view.dataset.pdfKey);
  if (!doc) return;
  view.querySelectorAll('.pdf-page').forEach(el => el.querySelector('.pdf-slot').append(doc.pages[Number(el.dataset.page)].canvas));
}

// Upload the PDF for a version that came from Word or was pasted.
let pdfFor = null;
$('#rv-pdf').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !pdfFor) return;
  try {
    await uploadPdf(pdfFor, file);
    reviewMode = 'pdf';
    toast('Added the PDF');
  } catch (err) {
    toast(err.message);
  }
  resumeJson = '';
  loadResume();
});
async function uploadPdf(versionId, file) {
  if (file.size > 5 * 1024 * 1024) throw new Error('That file is too big. nuj takes resumes up to 5 MB');
  const res = await fetch(`/api/resume/${versionId}/pdf`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    noteError(`PUT /api/resume/${versionId}/pdf → ${res.status} ${data.error || res.statusText}`);
    throw new ApiError(data.error || "nuj couldn't save that PDF. Try again");
  }
  return data;
}

// ---- the resume preview: your resume as a page, with the AI's review marked ----
// Lines come laid out from the server (src/insights.js layoutLines). Bullets the review
// says to fix are highlighted; select one to read what's missing and its rewrite.
let reviewId = null;     // the version shown; null means the current one
let reviewOpen = null;   // the line whose notes are open

// Bullets still to fix on the version on show, by line.
function suggestionsByLine(r) {
  const rv = resume.review;
  const byLine = new Map();
  if (rv?.versionId !== r.versionId) return byLine;
  for (const b of rv.bullets) {
    if (b.state === 'open' && b.at >= 0) byLine.set(b.at, [...(byLine.get(b.at) || []), b]);
  }
  return byLine;
}

// A line's own text, after any bullet.
const lineText = l => esc(l.text.slice(l.at));

// What the review says about one bullet, opened under it.
function lineNoteHtml(l, i, sgs) {
  const notes = sgs.map(b => `<li class="ln-sg">${icon('sparkles')}<div><strong>${esc(b.note || "Doesn't pass the XYZ test")}</strong>${xyzHtml(b.missing)}
      ${b.rewrite ? `<div class="ln-try"><span class="ln-try-label">Try</span><span>${esc(b.rewrite)}</span>
        <span class="ln-try-actions">${useRewriteHtml(resume.preview.versionId, { from: b.line, to: b.rewrite }, b.id)}
          <button class="btn btn-sm btn-quiet" type="button" data-copy="${esc(b.rewrite)}">${icon('check', 'icon copied')}<span>Copy</span></button></span></div>` : ''}
      <button class="meta-link" type="button" data-sg-show="${esc(b.id)}">Go to this in the review</button></div></li>`);
  return `<div class="ln-note" id="ln-note-${i}"><ul>${notes.join('')}</ul></div>`;
}

function paperHtml(r) {
  const bySg = suggestionsByLine(r);
  return r.lines.map((l, i) => {
    if (l.kind === 'blank') return '';
    const sgs = bySg.get(i) || [];
    const flagged = sgs.length > 0;
    const open = flagged && reviewOpen === i;
    const gap = i > 0 && r.lines[i - 1].kind === 'blank' && l.kind !== 'heading' ? ' gap' : '';
    const cls = `ln ${l.kind}${gap}${flagged ? ' flagged is-sg' : ''}${open ? ' open' : ''}`;
    const attrs = flagged
      ? ` role="button" tabindex="0" data-ln="${i}" aria-expanded="${open}" ${open ? `aria-controls="ln-note-${i}"` : ''} data-sg-ids="${sgs.map(s => esc(s.id)).join(' ')}"`
      : '';
    const why = sgs[0]?.note || 'needs a fix';
    return `<div class="${cls}"${attrs}>${l.kind === 'bullet' ? '<span class="ln-dot" aria-hidden="true"></span>' : ''}<span class="ln-text">${lineText(l)}</span>${
      flagged ? `<span class="ln-flag">${icon('sparkles')}<span class="sr-only">: ${why}</span></span>` : ''}</div>${open ? lineNoteHtml(l, i, sgs) : ''}`;
  }).join('');
}

function resumeReviewHtml() {
  const r = resume.preview;
  if (!r) return '';
  const hint = compareId
    ? 'What changed between the two versions: lines the later one added are marked +, lines it took out −.'
    : resume.ai?.available
      ? 'Bullets the review says to fix are highlighted. Select one to see what it misses and a rewrite.'
      : 'Your resume as nuj read it.';
  return `
    <section class="panel review" aria-labelledby="review-title">
      <div class="panel-head">
        <div class="head-text"><h2 id="review-title">Your resume</h2>
          <span class="hint">${hint}</span></div>
        <div class="review-tools">
          ${resume.versions.length > 1 ? `<label class="select-wrap"><select data-review-version aria-label="Version to show">
            ${[...resume.versions].reverse().map(v => `<option value="${esc(v.id)}" ${v.id === r.versionId ? 'selected' : ''}>${esc(v.name)}${v.id === resume.insights.currentId ? ' (current)' : ''}</option>`).join('')}
          </select>${icon('chevron', 'icon chev')}</label>` : ''}
          ${resume.versions.length > 1 ? `<label class="select-wrap"><select data-compare aria-label="Compare with another version">
            <option value="">Compare with…</option>
            ${[...resume.versions].reverse().filter(v => v.id !== r.versionId).map(v => `<option value="${esc(v.id)}" ${v.id === compareId ? 'selected' : ''}>Compare with ${esc(v.name)}</option>`).join('')}
          </select>${icon('chevron', 'icon chev')}</label>` : ''}
          ${!compareId && resume.versions.find(v => v.id === r.versionId)?.pdf && !resume.versions.find(v => v.id === r.versionId).pdf.stale ? `<div class="review-mode" role="group" aria-label="Show">
            ${[['pdf', 'PDF'], ['text', 'Text']].map(([m, label]) => `<button type="button" data-review-mode="${m}" aria-pressed="${reviewMode === m}">${label}</button>`).join('')}
          </div>` : ''}
          <button class="btn btn-sm btn-quiet review-wide" type="button" data-review-wide aria-pressed="${reviewWide}" title="${reviewWide ? 'Put the review back beside the page' : 'Show the page wider, with the review under it'}">${icon('expand')}<span>${reviewWide ? 'Narrower' : 'Wider'}</span></button>
          <button class="btn btn-sm" type="button" data-version-edit="${esc(r.versionId)}" aria-label="Edit the text of ${esc(r.name)}">Edit text</button>
        </div>
      </div>
      <div class="review-grid${reviewWide ? ' wide' : ''}">
        <div class="review-page">${previewHtml(r)}</div>
        <aside class="review-side" aria-label="Review">${reviewHtml(r)}</aside>
      </div>
    </section>`;
}

// Light up the bullet a review card is about while you point at it or tab to it.
function lightLines(id, on) {
  for (const el of document.querySelectorAll(`#resume-body [data-sg-ids~="${CSS.escape(id)}"]`)) el.classList.toggle('lit', on);
}
$('#view-resume').addEventListener('mouseover', e => {
  const card = e.target.closest('[data-sg-card]');
  if (card && !card.contains(e.relatedTarget)) lightLines(card.dataset.sgCard, true);
});
$('#view-resume').addEventListener('mouseout', e => {
  const card = e.target.closest('[data-sg-card]');
  if (card && !card.contains(e.relatedTarget)) lightLines(card.dataset.sgCard, false);
});
$('#view-resume').addEventListener('focusin', e => {
  const card = e.target.closest('[data-sg-card]');
  if (card) lightLines(card.dataset.sgCard, true);
});
$('#view-resume').addEventListener('focusout', e => {
  const card = e.target.closest('[data-sg-card]');
  if (card && !card.contains(e.relatedTarget)) lightLines(card.dataset.sgCard, false);
});

// Scroll something into view and give it a brief pulse, so the eye finds it.
function flash(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  el.classList.remove('flash');
  requestAnimationFrame(() => el.classList.add('flash'));
}

function toggleLine(i) {
  reviewOpen = reviewOpen === i ? null : i;
  renderResume();
  $(`#resume-body [data-ln="${i}"]`)?.focus();
}

$('#view-resume').addEventListener('click', async e => {
  const t = e.target;
  const mode = t.closest('[data-review-mode]');
  if (mode) { reviewMode = mode.dataset.reviewMode; reviewOpen = null; return renderResume(); }
  if (t.closest('[data-review-wide]')) {
    reviewWide = !reviewWide;
    try { localStorage.setItem('nuj-review-wide', reviewWide ? '1' : ''); } catch { /* not kept; fine */ }
    return renderResume();
  }
  const upload = t.closest('[data-pdf-upload]');
  if (upload) { pdfFor = upload.dataset.pdfUpload; return $('#rv-pdf').click(); }
  const ln = t.closest('[data-ln]');
  if (ln) return toggleLine(Number(ln.dataset.ln));
  const show = t.closest('[data-sg-show]');
  if (show) return flash($(`#resume-body [data-sg-card="${CSS.escape(show.dataset.sgShow)}"]`));
  const locate = t.closest('[data-sg-locate]');
  if (locate) {
    const id = locate.dataset.sgLocate;
    const first = $(`#resume-body .ln[data-sg-ids~="${CSS.escape(id)}"], #resume-body .pdf-line[data-sg-ids~="${CSS.escape(id)}"]`);
    lightLines(id, true);
    return flash(first);
  }
});
$('#view-resume').addEventListener('keydown', e => {
  if (e.key === 'Escape' && reviewOpen != null && !document.querySelector('dialog[open]')) return toggleLine(reviewOpen);
  const ln = e.target.closest('[data-ln]');
  if (!ln || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  toggleLine(Number(ln.dataset.ln));
});
$('#view-resume').addEventListener('change', async e => {
  if (e.target.matches('[data-compare]')) {
    compareId = e.target.value || null;
    reviewOpen = null;
    return renderResume();
  }
  if (!e.target.matches('[data-review-version]')) return;
  reviewId = e.target.value === resume.insights.currentId ? null : e.target.value;
  if (compareId === e.target.value) compareId = null;
  reviewOpen = null;
  reviewMode = 'pdf';
  resumeJson = '';
  await loadResume();
});

// The page shown wider, with the review under it, for reading a PDF on a laptop.
let reviewWide = false;
try { reviewWide = localStorage.getItem('nuj-review-wide') === '1'; } catch { /* private window */ }

// ---- a suggested rewrite, put into the version's text ----
// The same button for the review and Check fit. The server swaps the line (keeping its
// bullet) and hands back the old text, so Undo can put it back. `item`: the graded bullet
// it fixes, marked done along with it.
function useRewriteHtml(versionId, rewrite, item = '') {
  if (!versionId) return '';
  return `<button class="btn btn-sm" type="button" data-use-rewrite="${esc(versionId)}" data-from="${esc(rewrite.from)}" data-to="${esc(rewrite.to)}"
    ${item ? `data-fixes="${esc(item)}"` : ''} title="Put this line into your resume in place of the old one">Use this</button>`;
}
document.addEventListener('click', async e => {
  const use = e.target.closest('[data-use-rewrite]');
  if (!use) return;
  use.disabled = true;
  const item = use.dataset.fixes;
  try {
    const { version, before } = await api('POST', `/api/resume/${use.dataset.useRewrite}/rewrite`, { from: use.dataset.from, to: use.dataset.to });
    if (item) await api('PATCH', `/api/insights/review/items/${item}`, { state: 'done' }).catch(() => {});
    reviewOpen = null;
    resumeJson = '';
    if (view === 'resume') await loadResume();
    use.textContent = 'Used';
    // A rewrite can hold [X%] or [N] where only you know the real number.
    const fillIn = /\[[^\]]{1,6}\]/.test(use.dataset.to) ? '. Edit its text to fill in the [ ] with your real number' : '';
    toast(`Changed the line in ${version.name}${fillIn || (version.pdf?.stale ? '. Upload its new PDF when you have one' : '')}`, async () => {
      await api('PATCH', `/api/resume/${version.id}`, { text: before });
      if (item) await api('PATCH', `/api/insights/review/items/${item}`, { state: 'open' }).catch(() => {});
      resumeJson = '';
      if (view === 'resume') await loadResume();
    }, { ms: 10_000 });
  } catch (err) {
    use.disabled = false;
    toast(err.message);
  }
});

// Copy a rewrite, on the Resume page or in an application's panel.
document.addEventListener('click', async e => {
  const copy = e.target.closest('[data-copy]');
  if (!copy) return;
  try {
    await navigator.clipboard.writeText(copy.dataset.copy);
    copy.classList.add('done');
    const label = copy.querySelector('span');
    if (label) label.textContent = 'Copied';
  } catch {
    toast("Couldn't copy. Select the text and copy it yourself");
  }
});

// ---- comparing two versions: what changed, line by line ----
let compareId = null; // the version the one on show is compared with
const versionTexts = new Map(); // "<id>:<updated at>" -> Promise<text>
function versionText(v) {
  const key = `${v.id}:${v.updatedAt}`;
  if (!versionTexts.has(key)) {
    versionTexts.set(key, api('GET', `/api/resume/${v.id}`).then(x => x.text).catch(err => { versionTexts.delete(key); throw err; }));
  }
  return versionTexts.get(key);
}
const loadedTexts = new Map(); // same keys, once loaded

// Lines in both, only in the older one, or only in the newer one, in order (a longest
// common run of lines, the way a diff does it). Blank lines and spacing don't count.
function diffLines(a, b) {
  const clean = t => t.split('\n').map(l => l.trim()).filter(Boolean);
  const x = clean(a), y = clean(b);
  const n = x.length, m = y.length;
  const same = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    same[i][j] = x[i] === y[j] ? same[i + 1][j + 1] + 1 : Math.max(same[i + 1][j], same[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push(['same', x[i]]); i++; j++; }
    else if (same[i + 1][j] >= same[i][j + 1]) out.push(['gone', x[i++]]);
    else out.push(['new', y[j++]]);
  }
  while (i < n) out.push(['gone', x[i++]]);
  while (j < m) out.push(['new', y[j++]]);
  return out;
}

function compareHtml(r) {
  const shown = resume.versions.find(v => v.id === r.versionId);
  const other = resume.versions.find(v => v.id === compareId);
  if (!shown || !other) { compareId = null; return previewHtml(r); }
  const keys = [shown, other].map(v => `${v.id}:${v.updatedAt}`);
  if (!keys.every(k => loadedTexts.has(k))) {
    Promise.all([shown, other].map(versionText))
      .then(([a, b]) => { loadedTexts.set(keys[0], a); loadedTexts.set(keys[1], b); renderResume(); })
      .catch(err => { compareId = null; toast(err.message); renderResume(); });
    return '<div class="paper diff loading" aria-busy="true"><span class="sr-only">Loading both versions</span></div>';
  }
  // Older first, so "new" means what the later version added.
  const [older, newer] = shown.usedFrom < other.usedFrom || (shown.usedFrom === other.usedFrom && shown.createdAt < other.createdAt) ? [shown, other] : [other, shown];
  const rows = diffLines(loadedTexts.get(`${older.id}:${older.updatedAt}`), loadedTexts.get(`${newer.id}:${newer.updatedAt}`));
  const added = rows.filter(([k]) => k === 'new').length, gone = rows.filter(([k]) => k === 'gone').length;
  const count = v => appCount(resume.insights.byVersion.find(g => g.key === v.id)?.total ?? 0);
  // Long runs of unchanged lines fold away, leaving two lines of context on each side.
  const html = [];
  for (let k = 0; k < rows.length;) {
    if (rows[k][0] !== 'same') {
      const [kind, text] = rows[k++];
      html.push(`<div class="diff-ln ${kind}"><span class="diff-mark" aria-hidden="true">${kind === 'new' ? '+' : '−'}</span><span class="sr-only">${kind === 'new' ? `Added in ${esc(newer.name)}: ` : `Taken out of ${esc(older.name)}: `}</span>${esc(text)}</div>`);
      continue;
    }
    let end = k;
    while (end < rows.length && rows[end][0] === 'same') end++;
    const run = rows.slice(k, end).map(([, text]) => text);
    const keepTop = k === 0 ? 0 : 2, keepBottom = end === rows.length ? 0 : 2;
    if (run.length > keepTop + keepBottom + 1) {
      for (const text of run.slice(0, keepTop)) html.push(`<div class="diff-ln same">${esc(text)}</div>`);
      html.push(`<div class="diff-fold">${run.length - keepTop - keepBottom} lines the same</div>`);
      for (const text of run.slice(run.length - keepBottom)) html.push(`<div class="diff-ln same">${esc(text)}</div>`);
    } else {
      for (const text of run) html.push(`<div class="diff-ln same">${esc(text)}</div>`);
    }
    k = end;
  }
  return `
    <div class="diff-head">
      <span><span class="diff-mark gone" aria-hidden="true">−</span><strong>${esc(older.name)}</strong> <span class="dim">· since ${shortDate(`${older.usedFrom}T12:00:00`)} · ${count(older)}</span></span>
      <span><span class="diff-mark new" aria-hidden="true">+</span><strong>${esc(newer.name)}</strong> <span class="dim">· since ${shortDate(`${newer.usedFrom}T12:00:00`)} · ${count(newer)}</span></span>
    </div>
    <article class="paper diff" aria-label="What changed from ${esc(older.name)} to ${esc(newer.name)}">
      ${added || gone ? html.join('') : '<p class="dim">The two versions have the same text.</p>'}
    </article>
    <p class="pdf-foot">${added} ${added === 1 ? 'line' : 'lines'} added and ${gone} taken out. <button class="meta-link" type="button" data-compare-stop>Stop comparing</button></p>`;
}
$('#view-resume').addEventListener('click', e => {
  if (!e.target.closest('[data-compare-stop]')) return;
  compareId = null;
  renderResume();
});

// ---- Check a job: how well your resume fits a job you haven't applied to yet ----
let jobDraft = null; // what you've typed, kept across redraws (null: show the last one checked)
function jobCheckHtml() {
  const { ai, jobFit, preview } = resume;
  if (!ai?.available || !preview) return '';
  const text = jobDraft ?? jobFit?.posting ?? '';
  return `
    <section class="panel job-check" aria-labelledby="job-title">
      <div class="panel-head">
        <div class="head-text"><h2 id="job-title">Check a job</h2>
          <span class="hint">Paste a job description and a recruiter for that company scores how well ${esc(preview.name)} matches, names the missing keywords and red flags, and rewrites your bullets for it.</span></div>
      </div>
      <form class="job-form" data-job-form>
        <textarea name="posting" rows="6" maxlength="20000" data-job-posting placeholder="Paste the job description from the posting" aria-label="Job description">${esc(text)}</textarea>
        <div class="job-actions">
          <button class="btn btn-sm btn-primary" type="submit" data-job-check>${icon('sparkles')}<span>${jobFit && text === jobFit.posting ? 'Check again' : 'Check fit'}</span></button>
          <span class="hint">Uses AI.${aiLeftText(ai) ? ` ${aiLeftText(ai)}.` : ''}</span>
          ${jobFit ? '<button class="btn btn-sm btn-quiet" type="button" data-job-clear>Clear</button>' : ''}
        </div>
      </form>
      ${jobFit ? fitHtml(jobFit, jobFit.versionId) : ''}
    </section>`;
}
$('#view-resume').addEventListener('input', e => {
  if (e.target.matches('[data-job-posting]')) jobDraft = e.target.value;
});
$('#view-resume').addEventListener('submit', e => {
  if (!e.target.matches('[data-job-form]')) return;
  e.preventDefault();
  const posting = e.target.elements.posting.value;
  if (!posting.trim()) return toast('Paste the job description first');
  withConsent(async () => {
    const btn = $('[data-job-check]');
    btn.disabled = true;
    btn.classList.add('busy');
    try {
      const r = await api('POST', '/api/insights/fit', { posting, versionId: resume.preview?.versionId });
      if (r.cached) toast('Nothing has changed since you checked this job');
      jobDraft = null;
    } catch (err) {
      toast(err.message);
    }
    resumeJson = '';
    await loadResume();
  });
});
$('#view-resume').addEventListener('click', async e => {
  if (!e.target.closest('[data-job-clear]')) return;
  try {
    await api('DELETE', '/api/insights/fit');
    jobDraft = null;
  } catch (err) {
    toast(err.message);
  }
  resumeJson = '';
  await loadResume();
});

// ---- Check fit, in an application's panel ----
const FIT_LABEL = { strong: 'Strong match', partial: 'Partial match', weak: 'Weak match' };
// `versionId`: the version it was checked against, so a rewrite can be put straight into it.
// Answers from before tailoring have no score, red flags or skipped sections.
function fitHtml(fit, versionId) {
  const scored = Number.isFinite(fit.score);
  const chips = (list, cls) => list.map(x => `<span class="fit-chip ${cls}">${esc(x)}</span>`).join('');
  const missing = fit.missingKeywords ?? fit.missing ?? [];
  return `
    <div class="fit">
      <div class="fit-top">
        ${scored ? scoreRingHtml(fit.score, { size: 58, label: `Match ${fit.score} out of 100`, key: `fit:${fit.at}` }) : ''}
        <div class="fit-head-text"><span class="fit-match ${fit.match}"><i aria-hidden="true"></i>${FIT_LABEL[fit.match]}</span>
          <span class="hint">Against ${esc(fit.versionName)} · ${timeAgo(fit.at)}</span></div>
      </div>
      ${fit.summary ? `<p>${esc(fit.summary)}</p>` : ''}
      ${fit.redFlags?.length ? `<div class="fit-group"><span class="fit-label">Red flags a hiring manager spots in 10 seconds</span>
        <ol class="red-flags">${fit.redFlags.map(f => `<li>${icon('alert')}<span>${esc(f)}</span></li>`).join('')}</ol></div>` : ''}
      ${missing.length ? `<div class="fit-group"><span class="fit-label">${fit.missingKeywords ? 'Top missing keywords' : 'Not in your resume'}</span><div class="fit-chips">${chips(missing, 'gap')}</div></div>` : ''}
      ${fit.matched?.length ? `<div class="fit-group"><span class="fit-label">Your resume shows</span><div class="fit-chips">${chips(fit.matched, 'have')}</div></div>` : ''}
      ${fit.rewrites.length ? `<div class="fit-group"><span class="fit-label">Bullets rewritten for this job</span>
        <ol class="rewrites">${fit.rewrites.map(r => `<li><span class="from">${esc(r.from)}</span><span class="to">${esc(r.to)}</span>${r.why ? `<span class="why">${esc(r.why)}</span>` : ''}
          <span class="rewrite-use">${versionId ? useRewriteHtml(versionId, r) : ''}<button class="btn btn-sm btn-quiet" type="button" data-copy="${esc(r.to)}">${icon('check', 'icon copied')}<span>Copy</span></button></span></li>`).join('')}</ol></div>` : ''}
      ${fit.skipped?.length ? `<div class="fit-group"><span class="fit-label">What gets skipped by an ATS or a tired reader</span>
        ${fit.skipped.map(x => `<div class="skip">
          <div class="skip-head"><strong>${esc(x.section)}</strong><button class="btn btn-sm btn-quiet" type="button" data-copy="${esc(x.rewrite)}">${icon('check', 'icon copied')}<span>Copy rewrite</span></button></div>
          <p class="why">${esc(x.why)}</p><pre class="skip-rewrite">${esc(x.rewrite)}</pre></div>`).join('')}</div>` : ''}
    </div>`;
}

function fitFieldHtml(a) {
  if (!state.ai?.available || !state.resumes?.length) return '';
  return `
    <div class="field wide fit-field">
      <div class="fit-head">
        <button class="btn btn-sm" type="button" id="fit-btn">${icon('sparkles')}<span>${a.fit ? 'Check fit again' : 'Check fit'}</span></button>
        <span class="hint" id="fit-left">${a.fit ? '' : 'A recruiter for this company scores your resume against the job description and rewrites your bullets for it, using AI.'} ${aiLeftText(state.ai)}</span>
      </div>
      <div id="fit-result" aria-live="polite">${a.fit ? fitHtml(a.fit, a.resumeVersion) : ''}</div>
    </div>`;
}
