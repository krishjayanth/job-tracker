import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs, calendarItems, typedInterview, newFeedToken, looksLikeFeedToken, validTimeZone } from '../src/calendar.js';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const app = (extra = {}) => ({ id: 'a1', company: 'Contoso', role: 'Software Engineer Intern', jobId: '', url: '', status: 'oa', ...extra });
// The feed's lines, with folded lines joined back up.
const lines = ics => ics.replace(/\r\n /g, '').split('\r\n');

test('calendarItems: open deadlines and interviews, soonest first', () => {
  const items = calendarItems([
    app({ id: 'a', deadline: '2026-10-30T23:59:00.000Z' }),
    app({ id: 'b', status: 'interview', interviewAt: '2026-10-28T14:00:00.000Z' }),
    app({ id: 'c' }),
  ], NOW);
  assert.deepEqual(items.map(i => [i.app.id, i.kind]), [['b', 'interview'], ['a', 'deadline']]);
});

test('calendarItems: a closed application keeps a past interview but drops one still to come', () => {
  const past = app({ id: 'p', status: 'rejected', interviewAt: '2026-10-20T14:00:00.000Z' });
  const future = app({ id: 'f', status: 'withdrawn', interviewAt: '2026-11-02T14:00:00.000Z' });
  assert.deepEqual(calendarItems([past, future], NOW).map(i => i.app.id), ['p']);
});

test('typedInterview: needs a date and a time', () => {
  assert.equal(typedInterview('2026-11-02T14:00:00.000Z'), '2026-11-02T14:00:00.000Z');
  assert.equal(typedInterview('2026-11-02'), null);
  assert.equal(typedInterview('soon'), null);
  assert.equal(typedInterview(''), null);
  assert.equal(typedInterview(42), null);
});

test('buildIcs: an interview is an hour-long timed event', () => {
  const ics = lines(buildIcs([app({ status: 'interview', interviewAt: '2026-11-02T14:00:00.000Z' })], { now: NOW }));
  assert.ok(ics.includes('DTSTART:20261102T140000Z'));
  assert.ok(ics.includes('DTEND:20261102T150000Z'));
  assert.ok(ics.includes('SUMMARY:Interview · Contoso'));
  assert.ok(ics.includes('UID:a1-interview@nuj'));
});

test('buildIcs: a deadline at the end of your day is all-day on your date', () => {
  // 11:59 PM in New York on Oct 30 is already Oct 31 in UTC.
  const ics = lines(buildIcs([app({ deadline: '2026-10-31T03:59:00.000Z' })], { timeZone: 'America/New_York', now: NOW }));
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20261030'));
  assert.ok(ics.includes('DTEND;VALUE=DATE:20261031'));
  assert.ok(ics.includes('SUMMARY:Assessment due · Contoso'));
});

test('buildIcs: a deadline with a time stays at that time', () => {
  const ics = lines(buildIcs([app({ deadline: '2026-10-30T21:00:00.000Z' })], { timeZone: 'America/New_York', now: NOW }));
  assert.ok(ics.includes('DTSTART:20261030T210000Z'));
});

test('buildIcs: escapes text, folds long lines and uses CRLF', () => {
  const raw = buildIcs([app({ company: 'Smith, Jones; & Co', role: 'A'.repeat(120), interviewAt: '2026-11-02T14:00:00.000Z' })], { now: NOW });
  assert.ok(lines(raw).includes('SUMMARY:Interview · Smith\\, Jones\\; & Co'));
  for (const line of raw.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.ok(raw.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(raw));
});

test('buildIcs: an unknown time zone falls back to UTC', () => {
  assert.equal(validTimeZone('Not/AZone'), false);
  assert.ok(lines(buildIcs([], { timeZone: 'Not/AZone', now: NOW })).includes('X-WR-TIMEZONE:UTC'));
});

test('feed tokens are long, random and checked by shape', () => {
  const a = newFeedToken(), b = newFeedToken();
  assert.notEqual(a, b);
  assert.ok(looksLikeFeedToken(a));
  assert.equal(looksLikeFeedToken('../etc/passwd'), false);
});
