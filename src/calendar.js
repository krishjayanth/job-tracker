// The calendar: open deadlines and the interview times you entered, as items for the
// Calendar page and as a private .ics feed that Google Calendar (or any calendar app)
// can subscribe to. The feed's address is a long random token, so it works without
// signing in; resetting it stops the old address.
import crypto from 'node:crypto';

const CLOSED = new Set(['rejected', 'withdrawn']);
export const INTERVIEW_MINUTES = 60; // how long an interview is shown as, without a known end

// What a deadline is for, by where the application stands.
const DUE_LABEL = { oa: 'Assessment due', interview: 'Reply due', offer: 'Offer reply due' };
export const dueLabel = status => DUE_LABEL[status] || 'Deadline';

// An interview time you typed, as an ISO time, or null if it isn't one.
export function typedInterview(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  const when = new Date(value);
  return isNaN(when) ? null : when.toISOString();
}

// Everything that belongs on the calendar. A closed application keeps an interview that
// already happened (it's history) but not one still to come.
export function calendarItems(applications, now = Date.now()) {
  const items = [];
  for (const a of applications) {
    if (a.deadline) items.push({ kind: 'deadline', app: a, at: a.deadline });
    if (a.interviewAt && !(CLOSED.has(a.status) && Date.parse(a.interviewAt) > now)) {
      items.push({ kind: 'interview', app: a, at: a.interviewAt });
    }
  }
  return items.sort((x, y) => x.at.localeCompare(y.at));
}

export const newFeedToken = () => crypto.randomBytes(24).toString('base64url');
export const looksLikeFeedToken = t => /^[A-Za-z0-9_-]{32}$/.test(t);

// ---- .ics ----------------------------------------------------------------------

// Text values escape \ ; , and newlines (RFC 5545 §3.3.11).
const text = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const utc = iso => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// Lines longer than 75 bytes continue on the next line after a space; never split a character.
function fold(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

// The date (YYYYMMDD) an instant falls on in a time zone, and the day after it.
function localDay(iso, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const get = type => Number(parts.find(p => p.type === type).value);
  const day = new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  return [fmt(day), fmt(new Date(day.getTime() + 86_400_000))];
}

// 11:59 PM where you are means "by the end of the day": an all-day event, not one at midnight.
function endOfDay(iso, timeZone) {
  const t = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  return t === '23:59';
}

export function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

// The feed for one person's applications. `link` is where "Open in nuj" points.
export function buildIcs(applications, { timeZone = 'UTC', link = '', now = Date.now() } = {}) {
  const tz = validTimeZone(timeZone) ? timeZone : 'UTC';
  const stamp = utc(new Date(now).toISOString());
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//nuj//Job applications//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:nuj', `X-WR-TIMEZONE:${tz}`,
    'X-WR-CALDESC:Assessment deadlines and interviews from your job applications',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
  ];
  for (const { kind, app, at } of calendarItems(applications, now)) {
    const what = kind === 'interview' ? 'Interview' : dueLabel(app.status);
    const details = [app.role, app.jobId && `Job ID ${app.jobId}`, app.url, link && `Open in nuj: ${link}`].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT', `UID:${app.id}-${kind}@nuj`, `DTSTAMP:${stamp}`);
    if (kind === 'deadline' && endOfDay(at, tz)) {
      const [day, next] = localDay(at, tz);
      lines.push(`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${next}`, 'TRANSP:TRANSPARENT');
    } else {
      const end = new Date(Date.parse(at) + (kind === 'interview' ? INTERVIEW_MINUTES : 0) * 60_000).toISOString();
      lines.push(`DTSTART:${utc(at)}`, `DTEND:${utc(end)}`);
      if (kind === 'deadline') lines.push('TRANSP:TRANSPARENT');
    }
    lines.push(`SUMMARY:${text(`${what} · ${app.company}`)}`);
    if (details) lines.push(`DESCRIPTION:${text(details)}`);
    if (app.url) lines.push(`URL:${app.url.replace(/\s/g, '')}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
