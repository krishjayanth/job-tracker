// Dates in someone's own time zone. A deadline like "Oct 9 at 11:59 PM" means 11:59 PM
// where the person reading it is, not where the server is (Render's clock is UTC). Each
// person's zone comes from their browser (db.timeZone); without one, the server's own zone
// is used, as before.

const SERVER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

export const zoneOr = tz => (validTimeZone(tz) ? tz : SERVER_ZONE);

// Zones as emails write them. Senders write "EST" year-round when they mean Eastern time,
// so each maps to the place's zone, which follows daylight saving.
const ZONE_WORDS = {
  et: 'America/New_York', est: 'America/New_York', edt: 'America/New_York', eastern: 'America/New_York',
  ct: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago', central: 'America/Chicago',
  mt: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver', mountain: 'America/Denver',
  pt: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pacific: 'America/Los_Angeles',
  utc: 'UTC', gmt: 'UTC',
};
export const ZONE_PATTERN = Object.keys(ZONE_WORDS).join('|');
export const zoneFromWord = word => ZONE_WORDS[String(word || '').toLowerCase()] ?? null;

// The calendar date and clock time an instant shows in a zone (month from 0, like Date).
export function partsIn(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zoneOr(timeZone), hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(date);
  const get = type => Number(parts.find(p => p.type === type).value);
  return { year: get('year'), month: get('month') - 1, day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

// The instant a wall-clock time in a zone stands for. Day and month may run over (day 32
// is the 1st of the next month), as with Date.UTC. The zone's offset is checked twice, so
// a time on the day the clocks change still lands right.
export function zonedTime({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const wall = Date.UTC(year, month, day, hour, minute);
  const offsetAt = t => {
    const p = partsIn(new Date(t), timeZone);
    return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  return new Date(t);
}

// 11:59 PM on a calendar date in a zone: what "by Oct 12" means.
export const endOfDayIn = ({ year, month, day }, timeZone) => zonedTime({ year, month, day, hour: 23, minute: 59 }, timeZone);
