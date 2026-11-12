// The Calendar page and your calendar feed.
// The dashboard's scripts are plain scripts loaded in order (see index.html), sharing one
// global scope: a file may use what an earlier one defines, and anything at all from inside
// functions that run later.

// ---------------------------------------------------------------- calendar
// Open deadlines (the same ones as "Needs your action") and the interview times you
// entered, on a month grid with the next two weeks listed under it. The server's
// calendar feed (src/calendar.js) puts the same things on Google Calendar.
const DUE_LABEL = { oa: 'Assessment due', interview: 'Reply due', offer: 'Offer reply due' };
const INTERVIEW_MINUTES = 60;
let calMonth = null; // the first day of the month shown

// A closed application keeps an interview that already happened, not one still to come.
function calItems() {
  const now = Date.now();
  const items = [];
  for (const a of state.applications) {
    if (a.deadline) items.push({ kind: 'deadline', a, at: a.deadline });
    if (a.interviewAt && !(['rejected', 'withdrawn'].includes(a.status) && Date.parse(a.interviewAt) > now)) {
      items.push({ kind: 'interview', a, at: a.interviewAt });
    }
  }
  return items.sort((x, y) => x.at.localeCompare(y.at));
}
const itemWhat = it => it.kind === 'interview' ? 'Interview' : DUE_LABEL[it.a.status] || 'Deadline';
const clockTime = iso => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
// A deadline with no time is due by the end of its day.
const itemTime = it => it.kind === 'interview' ? clockTime(it.at) : dueTime(it.at);
const exactTime = iso => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// "later", "soon", "overdue"... for a chip's colour; a past interview just fades.
const itemLevel = it => it.kind === 'deadline' ? dueInfo(it.at)?.level || 'later'
  : Date.parse(it.at) < Date.now() ? 'past' : 'later';

// Google's "new event" page, filled in. Nothing reaches Google until you press Save there.
const gcalStamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function googleLink(it) {
  const start = new Date(it.at);
  let dates;
  if (it.kind === 'deadline' && !dueTime(it.at)) {
    const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    dates = `${isoDate(start).replace(/-/g, '')}/${isoDate(next).replace(/-/g, '')}`;
  } else {
    const end = new Date(start.getTime() + (it.kind === 'interview' ? INTERVIEW_MINUTES : 0) * 60_000);
    dates = `${gcalStamp(start)}/${gcalStamp(end)}`;
  }
  const details = [it.a.role, it.a.jobId && `Job ID ${it.a.jobId}`, it.a.url].filter(Boolean).join('\n');
  return `https://calendar.google.com/calendar/render?${new URLSearchParams({ action: 'TEMPLATE', text: `${itemWhat(it)} · ${it.a.company}`, dates, details })}`;
}

function calChip(it) {
  const time = itemTime(it);
  const label = `${itemWhat(it)} · ${it.a.company} · ${exactTime(it.at)}`;
  const c = it.kind === 'interview' ? 'interview' : it.a.status;
  return `<button class="cal-chip ${it.kind} ${itemLevel(it)}" type="button" data-open="${it.a.id}" style="--c:${color(c)}" title="${esc(label)}" aria-label="${esc(label)}">${it.kind === 'interview' ? '<i class="cal-dot"></i>' : icon('clock')}${time ? `<span class="t num">${time}</span>` : ''}<span class="co">${esc(it.a.company)}</span></button>`;
}

const CAL_SHOWN = 3; // chips per day before "+N more"
function renderCalendar() {
  const items = calItems();
  const today = startOfDay(new Date());
  const week = today.getTime() + 7 * 86_400_000;
  const soon = items.filter(it => Date.parse(it.at) >= today && Date.parse(it.at) < week).length;
  $('#cal-count').textContent = soon || '';
  if (view !== 'calendar') return;

  calMonth ??= new Date(today.getFullYear(), today.getMonth(), 1);
  const byDay = new Map();
  for (const it of items) {
    const key = isoDate(it.at);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(it);
  }
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const lead = new Date(y, m, 1).getDay();
  const weeks = Math.ceil((lead + new Date(y, m + 1, 0).getDate()) / 7);
  const days = Array.from({ length: weeks * 7 }, (_, i) => new Date(y, m, 1 - lead + i));
  $('#cal-title').textContent = calMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('#cal-grid').innerHTML = `
    ${days.slice(0, 7).map(d => `<div class="cal-wd" aria-hidden="true">${d.toLocaleDateString(undefined, { weekday: 'short' })}</div>`).join('')}
    ${days.map(d => {
      const list = byDay.get(isoDate(d)) || [];
      const isToday = d.getTime() === today.getTime();
      const label = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
      return `<div class="cal-day${d.getMonth() !== m ? ' out' : ''}${isToday ? ' today' : ''}${d < today ? ' past' : ''}${list.length > CAL_SHOWN ? ' crowded' : ''}" aria-label="${esc(label)}${list.length ? `, ${list.length} ${list.length === 1 ? 'item' : 'items'}` : ''}">
        <span class="cal-num num"${isToday ? ' aria-current="date"' : ''}>${d.getDate()}</span>
        <div class="cal-items">${list.map(calChip).join('')}${list.length > CAL_SHOWN ? `<button class="cal-more" type="button" data-cal-more>+${list.length - CAL_SHOWN} more</button>` : ''}</div>
      </div>`;
    }).join('')}`;

  // The next two weeks, with anything overdue first so it isn't lost off the grid.
  const end = today.getTime() + 14 * 86_400_000;
  const upcoming = items.filter(it => {
    const t = Date.parse(it.at);
    return (t >= today && t < end) || (it.kind === 'deadline' && itemLevel(it) === 'overdue');
  });
  const groups = new Map();
  for (const it of upcoming) {
    const key = Date.parse(it.at) < today ? 'overdue' : isoDate(it.at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const dayName = key => {
    if (key === 'overdue') return 'Overdue';
    const d = new Date(`${key}T00:00`);
    const diff = Math.round((d - today) / 86_400_000);
    const date = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    return diff === 0 ? `Today · ${date}` : diff === 1 ? `Tomorrow · ${date}` : date;
  };
  $('#agenda-hint').textContent = upcoming.length ? `${upcoming.length} ${upcoming.length === 1 ? 'item' : 'items'}` : '';
  $('#agenda').innerHTML = upcoming.length ? [...groups].map(([key, list]) => `
    <li class="agenda-day${key === 'overdue' ? ' overdue' : ''}">
      <div class="agenda-date">${dayName(key)}</div>
      <ul>${list.map(it => {
        const time = itemTime(it);
        const c = it.kind === 'interview' ? 'interview' : it.a.status;
        return `<li class="agenda-row ${it.kind} ${itemLevel(it)}" data-open="${it.a.id}" role="button" tabindex="0" style="--c:${color(c)}">
          <span class="agenda-time num">${key === 'overdue' ? shortDate(it.at) : time || 'End of day'}</span>
          <span class="agenda-what">
            <span class="co">${esc(it.a.company)}</span>
            <span class="why">${itemWhat(it)}${it.a.role ? ` · ${esc(it.a.role)}` : ''}</span>
          </span>
          <a class="btn btn-sm btn-quiet agenda-add" href="${esc(googleLink(it))}" target="_blank" rel="noopener" title="Add this to Google Calendar">${icon('calendar')}<span>Add to Google</span></a>
        </li>`;
      }).join('')}</ul>
    </li>`).join('')
    : `<li class="action-empty"><strong>Nothing in the next two weeks.</strong>Deadlines from assessment and interview emails show up here. To put an interview on the calendar, open its application and add the date and time.</li>`;
}

$('#view-calendar').addEventListener('click', e => {
  const nav = e.target.closest('[data-cal-nav]');
  if (nav) {
    const step = Number(nav.dataset.calNav);
    const now = new Date();
    calMonth = step ? new Date(calMonth.getFullYear(), calMonth.getMonth() + step, 1) : new Date(now.getFullYear(), now.getMonth(), 1);
    return renderCalendar();
  }
  const more = e.target.closest('[data-cal-more]');
  if (more) {
    more.closest('.cal-day').classList.add('expanded');
    return more.remove();
  }
  if (e.target.closest('a')) return; // "Add to Google" opens in a new tab
  const item = e.target.closest('[data-open]');
  if (item) openById(item.dataset.open);
});
$('#view-calendar').addEventListener('keydown', e => {
  const item = e.target.closest('.agenda-row');
  if (item && e.target === item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openById(item.dataset.open); }
});

// Settings → Calendar: one private link with every deadline and interview, for Google
// Calendar ("From URL") or any calendar app.
function renderFeed() {
  const feed = state.calendarFeed;
  $('#feed-status').textContent = feed
    ? 'In Google Calendar, go to Other calendars → + → From URL and paste this link. Google checks it for changes every few hours. Anyone with the link can see your deadlines and interviews, so keep it private.'
    : 'Put your deadlines and interviews on Google Calendar, Apple Calendar or Outlook. New ones appear there on their own.';
  $('#feed-actions').innerHTML = feed
    ? `<button class="btn" type="button" id="feed-reset" title="Make a new link; the old one stops working">${icon('refresh')}Reset link</button>
       <button class="btn btn-quiet btn-danger" type="button" id="feed-off">Turn off</button>`
    : `<button class="btn btn-primary" type="button" id="feed-create">${icon('calendar')}Create link</button>`;
  $('#feed-url-row').hidden = !feed;
  if (feed) $('#feed-url').value = feed.url;
}
$('#calendar-feed').addEventListener('click', async e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.id === 'feed-copy') {
    try {
      await navigator.clipboard.writeText($('#feed-url').value);
      toast('Calendar link copied');
    } catch {
      $('#feed-url').select(); // the clipboard was refused: leave it selected to copy by hand
    }
    return;
  }
  if (!['feed-create', 'feed-reset', 'feed-off'].includes(btn.id)) return;
  btn.disabled = true;
  try {
    if (btn.id === 'feed-off') {
      await api('DELETE', '/api/calendar-feed');
      toast('Calendar link turned off');
    } else {
      // Your time zone, so a deadline at the end of your day is an all-day event on the right date.
      await api('POST', '/api/calendar-feed', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      toast(btn.id === 'feed-reset' ? 'New link made. Paste it into your calendar again' : 'Calendar link ready');
    }
    await load();
  } catch (err) {
    btn.disabled = false;
    toast(err.message);
  }
});
$('#feed-url').addEventListener('focus', e => e.target.select());
// "Add all to Google Calendar" on the Calendar page: to the link in Settings.
$('[data-feed-link]').addEventListener('click', e => {
  e.preventDefault();
  go('#/settings');
  requestAnimationFrame(() => $('#calendar-feed').scrollIntoView({ behavior: 'smooth', block: 'start' }));
});
