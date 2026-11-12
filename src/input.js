// Checks for what the dashboard sends. Anyone signed in can call the API directly, so a
// field is only used once it's the right type and a sensible length, and every check
// runs before anything changes: a bad field never leaves an application half-updated.
// Errors are shown to the person, so they're in plain words.

export const LIMITS = { company: 200, role: 300, jobId: 100, url: 2000, notes: 10_000 };

const NAMES = { company: 'The company name', role: 'The role', jobId: 'The job ID', url: 'The link', notes: 'Notes' };

// Only http(s) links: anything else (javascript:, data:) would run in the page when clicked.
export const isWebLink = value => /^https?:\/\/[^\s]+$/i.test(value);

// The text fields in a body, trimmed. Returns { fields } with just the ones present, or
// { error }. `required` fields must be present and not empty.
export function textFields(body, keys, { required = [] } = {}) {
  const fields = {};
  for (const key of keys) {
    const value = body?.[key];
    if (value === undefined || value === null) {
      if (required.includes(key)) return { error: `${NAMES[key]} is required` };
      continue;
    }
    if (typeof value !== 'string') return { error: `${NAMES[key]} should be text` };
    const clean = value.trim();
    if (required.includes(key) && !clean) return { error: `${NAMES[key]} can't be empty` };
    if (clean.length > LIMITS[key]) return { error: `${NAMES[key]} is too long. Keep it under ${LIMITS[key].toLocaleString('en-US')} characters` };
    if (key === 'url' && clean && !isWebLink(clean)) return { error: 'Links need to start with https://' };
    fields[key] = clean;
  }
  return { fields };
}
