// Pages that are on their way (#/analytics, #/contacts, #/goals).
// The dashboard's scripts are plain scripts loaded in order (see index.html), sharing one
// global scope: a file may use what an earlier one defines, and anything at all from inside
// functions that run later.

// ---------------------------------------------------------------- sections (sidebar)
// Planned sections: listed now so the sidebar shows where nuj is going, each with a
// "coming soon" page saying what it will do.
const SOON = {
  analytics: {
    label: 'Analytics', icon: 'chart', c: 'applied', preview: 'bars',
    blurb: 'See which applications turn into interviews, how fast companies reply, and how your search changes week to week.',
    points: ['Response and interview rates by month', 'Average time to hear back, by company', 'Which roles and sources work best for you'],
  },
  contacts: {
    label: 'Contacts', icon: 'users', c: 'oa', preview: 'list',
    blurb: 'The recruiters and interviewers you hear from, linked to their applications, so you know who to follow up with.',
    points: ['Recruiters found in your application emails', 'Last contact and follow-up nudges', 'Notes for each person'],
  },
  goals: {
    label: 'Goals', icon: 'target', c: 'offer', preview: 'rings',
    blurb: 'Set a weekly target for applications and follow-ups, and watch your streak build.',
    points: ['Weekly application targets', 'Streaks and progress at a glance', 'A gentle nudge when you fall behind'],
  },
};
// These pages aren't in the sidebar until they exist: links to things you can't use yet
// only crowd the ones you can. Their addresses (#/analytics...) still show what's coming.

function soonPreview(kind, c) {
  const bars = [38, 62, 46, 80, 54, 70, 92];
  if (kind === 'bars') return `<div class="ghost-kpis">${'<span></span>'.repeat(3)}</div>
    <div class="ghost-bars">${bars.map((h, i) => `<span style="--h:${h}%;--d:${i}"></span>`).join('')}</div>`;
  if (kind === 'rings') return `<div class="ghost-rings">${[72, 45, 88].map((p, i) =>
    `<svg viewBox="0 0 40 40" style="--d:${i}"><circle cx="20" cy="20" r="16"/><circle class="on" cx="20" cy="20" r="16" pathLength="100" style="stroke-dasharray:${p} 100"/></svg>`).join('')}</div>`;
  return `<div class="ghost-list">${[78, 62, 70, 54].map((w, i) => `<span style="--w:${w}%;--d:${i}"><i></i><b></b></span>`).join('')}</div>`;
}

function renderSoon(id) {
  const s = SOON[id];
  $('#soon').style.setProperty('--c', color(s.c));
  $('#soon').innerHTML = `
    <div class="soon-icon">${icon(s.icon)}</div>
    <span class="soon-badge"><i></i>Coming soon</span>
    <h1>${s.label}</h1>
    <p class="soon-blurb">${s.blurb}</p>
    <div class="soon-preview" aria-hidden="true">${soonPreview(s.preview, s.c)}</div>
    <ul class="soon-points">${s.points.map(p => `<li>${icon('check')}${p}</li>`).join('')}</ul>
    <p class="soon-note">We're building this now. It will appear here once it's ready, using the applications you already track.</p>
    <a class="btn" href="#/">${icon('back')}Back to dashboard</a>`;
}
