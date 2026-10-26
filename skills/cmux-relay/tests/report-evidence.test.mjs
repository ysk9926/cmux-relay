import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReport } from '../scripts/lib/report.mjs';

const base = { taskId: 't', dispatchId: 'd', status: 'done', summary: 'complete', stage: 'verify', confidence: 'verified', verification: [{ command: 'node --test', result: 'pass' }] };
const receipt = { command: 'node --test', result: 'pass', approved: true, executed: true, exitCode: 0 };
const parse = (patch = {}, context = { taskId: 't', receipts: [receipt] }) => parseReport(JSON.stringify({ ...base, ...patch }), 'd', context);

test('verified requires trusted successful approved execution and matching claims', () => {
  assert.equal(parse().ok, true);
  for (const bad of [undefined, [], [{ ...receipt, approved: false }], [{ ...receipt, executed: false }], [{ ...receipt, exitCode: 1 }], [{ ...receipt, result: 'fail' }], [{ ...receipt, command: 'other' }], [{ ...receipt, dispatchId: 'other' }]]) {
    assert.equal(parse({}, { taskId: 't', receipts: bad }).ok, false);
  }
  for (const patch of [{ stage: 'work' }, { status: 'failed' }, { verification: [] }, { verification: [{ command: 'node --test', result: 'not_run' }] }, { verification: [...base.verification, { command: 'other', result: 'pass' }] }]) assert.equal(parse(patch).ok, false);
  assert.equal(parseReport(JSON.stringify({ ...base, receipts: [receipt] }), 'd').ok, false);
});

test('reject mismatched task context, axes and malformed report fields', () => {
  assert.equal(parse({}, { taskId: 'other', receipts: [receipt] }).reason, 'task-mismatch');
  for (const patch of [{ stage: undefined }, { confidence: undefined }, { stage: 'build' }, { confidence: 'certain' }, { taskId: 3 }, { summary: {} }, { changes: {} }, { changes: [{}] }, { verification: ['pass'] }, { questions: ['question'] }, { unmeasured: [42] }, { next: [] }]) assert.equal(parse(patch).ok, false, JSON.stringify(patch));
  assert.equal(parseReport('[]', 'd').reason, 'not-object');
});

test('legacy minimal reports remain readable and cannot become verified', () => {
  const result = parseReport(JSON.stringify({ dispatchId: 'd', status: 'done' }), 'd');
  assert.equal(result.ok, true);
  assert.equal(result.report.stage, 'work');
  assert.equal(result.report.confidence, 'reported_done');
  assert.equal(result.report.summary, '');
  assert.deepEqual(result.report.questions, []);
  assert.equal(parseReport(JSON.stringify({ dispatchId: 'd', status: 'needs_input' }), 'd').report.confidence, 'not_run');
});

test('explicit stage context is enforced while legacy omission remains compatible', () => {
  assert.equal(parse({}, { taskId: 't', stage: 'work', receipts: [receipt] }).reason, 'stage-mismatch');
  assert.equal(parse({}, { taskId: 't', stage: 'verify', receipts: [receipt] }).ok, true);
  assert.equal(parseReport(JSON.stringify({ taskId: 't', dispatchId: 'd', status: 'done' }), 'd', { taskId: 't', stage: 'plan' }).ok, true);
});

test('verified cannot omit unsuccessful or unapproved relevant receipts', () => {
  for (const extra of [{ ...receipt, command: 'other', result: 'fail', exitCode: 1 }, { ...receipt, command: 'other', approved: false }, { ...receipt, command: 'other', executed: false }]) {
    assert.equal(parse({}, { taskId: 't', receipts: [receipt, extra] }).ok, false);
  }
  assert.equal(parse({}, { taskId: 't', receipts: [receipt, { ...receipt, taskId: 'another', result: 'fail', exitCode: 1 }] }).ok, true);
});
