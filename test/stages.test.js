import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStatus, stagePath } from '../src/stages.js';

const DAY = 86_400_000;
const ago = days => new Date(Date.now() - days * DAY).toISOString();
const ev = (days, stage, manual = false) => ({ date: ago(days), stage, ...(manual && { manual }) });

test('computeStatus: moves forward through the pipeline', () => {
  assert.equal(computeStatus([ev(10, 'applied'), ev(5, 'oa'), ev(1, 'interview')]), 'interview');
});

test('computeStatus: a late confirmation email does not undo progress', () => {
  assert.equal(computeStatus([ev(10, 'applied'), ev(5, 'interview'), ev(1, 'applied')]), 'interview');
});

test('computeStatus: terminal stages always apply and stick', () => {
  assert.equal(computeStatus([ev(10, 'applied'), ev(5, 'interview'), ev(3, 'rejected')]), 'rejected');
  assert.equal(computeStatus([ev(10, 'applied'), ev(5, 'rejected'), ev(1, 'oa')]), 'rejected');
});

test('computeStatus: order comes from dates, not array position', () => {
  assert.equal(computeStatus([ev(1, 'interview'), ev(10, 'applied')]), 'interview');
});

test('computeStatus: a manual change always wins, even backwards', () => {
  assert.equal(computeStatus([ev(10, 'applied'), ev(5, 'interview'), ev(1, 'applied', true)]), 'applied');
  assert.equal(computeStatus([ev(10, 'rejected'), ev(1, 'interview', true)]), 'interview');
});

const app = (events, extra = {}) => ({ events, appliedAt: events[0].date, status: computeStatus(events), ...extra });

test('stagePath: ends in the terminal stage', () => {
  assert.deepEqual(stagePath(app([ev(30, 'applied'), ev(20, 'oa'), ev(10, 'rejected')]), { ghostDays: 21 }),
    ['applied', 'oa', 'rejected']);
});

test('stagePath: silence past the ghost threshold is "no response"', () => {
  assert.deepEqual(stagePath(app([ev(30, 'applied')]), { ghostDays: 21 }), ['applied', 'no_response']);
  assert.deepEqual(stagePath(app([ev(5, 'applied')]), { ghostDays: 21 }), ['applied', 'in_progress']);
});

test('stagePath: your own edits do not reset the ghost clock', () => {
  const a = app([ev(30, 'applied'), ev(1, 'applied', true)]);
  assert.deepEqual(stagePath(a, { ghostDays: 21 }), ['applied', 'no_response']);
});

test('stagePath: a manual correction rewinds a misread stage', () => {
  const a = app([ev(30, 'applied'), ev(25, 'interview'), ev(10, 'applied', true)]);
  assert.deepEqual(stagePath(a, { ghostDays: 21 }), ['applied', 'no_response']);
});

test('stagePath: never repeats or goes backwards, so the Sankey has no cycles', () => {
  const a = app([ev(30, 'applied'), ev(25, 'interview'), ev(20, 'oa'), ev(15, 'interview'), ev(1, 'applied')]);
  assert.deepEqual(stagePath(a, { ghostDays: 21 }), ['applied', 'interview', 'in_progress']);
});
