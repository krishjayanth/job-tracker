import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoDb } from '../src/demo.js';
import { computeStatus, stagePath, isStage } from '../src/stages.js';

test('demo data covers every outcome the dashboard shows', () => {
  const { applications } = buildDemoDb();
  const ends = new Set();
  for (const a of applications) {
    assert.ok(a.events.every(e => isStage(e.stage)), a.company);
    a.status = computeStatus(a.events);
    a.appliedAt = a.events[0].date;
    ends.add(stagePath(a, { ghostDays: 21 }).at(-1));
  }
  assert.deepEqual([...ends].sort(), ['in_progress', 'no_response', 'offer', 'rejected', 'withdrawn']);
});

test('demo data has open deadlines and no links into a real inbox', () => {
  const { applications } = buildDemoDb();
  const events = applications.flatMap(a => a.events);
  assert.ok(events.some(e => e.deadline && Date.parse(e.deadline) > Date.now()));
  assert.ok(events.every(e => !e.messageId));
});
