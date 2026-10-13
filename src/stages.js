// Pipeline stages, in the order an application normally moves through them.
export const STAGES = ['applied', 'oa', 'interview', 'offer', 'rejected', 'withdrawn'];
export const TERMINAL = new Set(['offer', 'rejected', 'withdrawn']);
const RANK = { applied: 0, oa: 1, interview: 2, offer: 3, rejected: 9, withdrawn: 9 };

export function isStage(s) {
  return STAGES.includes(s);
}

// Walk an application's events in date order and work out where it stands now.
// Forward-only for progress stages (a late "thanks for applying" email doesn't undo an
// interview); terminal stages always apply; manual edits always win.
export function computeStatus(events) {
  let status = 'applied';
  for (const e of [...events].sort((a, b) => a.date.localeCompare(b.date))) {
    const movesForward = !TERMINAL.has(status) && RANK[e.stage] >= RANK[status];
    if (e.manual || TERMINAL.has(e.stage) || movesForward) {
      status = e.stage;
    }
  }
  return status;
}

// The ordered list of stages an application passed through, for the Sankey chart.
// Always starts at "applied" and only ever moves forward, so the graph has no cycles.
// A manual status change is a correction: it rewinds the path to that stage, so
// setting a misread "interview" back to "applied" removes the interview step.
export function stagePath(app, { ghostDays }) {
  const path = ['applied'];
  const sorted = [...app.events].sort((a, b) => a.date.localeCompare(b.date));
  for (const e of sorted) {
    if (e.manual && !TERMINAL.has(e.stage)) {
      while (path.length > 1 && RANK[path.at(-1)] >= RANK[e.stage]) path.pop();
      if (e.stage !== 'applied') path.push(e.stage);
    } else if (!TERMINAL.has(e.stage) && RANK[e.stage] > RANK[path.at(-1)]) {
      path.push(e.stage);
    }
  }
  if (TERMINAL.has(app.status)) {
    path.push(app.status);
  } else {
    // Silence is measured from the company's last email, not from your own edits.
    const lastHeard = sorted.filter(e => !e.manual).at(-1)?.date ?? app.appliedAt;
    const idleDays = (Date.now() - Date.parse(lastHeard)) / 86_400_000;
    path.push(app.status === 'applied' && idleDays > ghostDays ? 'no_response' : 'in_progress');
  }
  return path;
}
