import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBudget, measureWorkflow } from './check-ci-budget.mjs';

const workflow = `on:
  pull_request:
jobs:
  build:
    timeout-minutes: 10
    steps:
      - run: echo ok
        timeout-minutes: 3
  test:
    runs-on: ubuntu-latest
`;

test('measures PR triggers and job-level timeouts, excluding scheduled workflows', () => {
  for (const trigger of [
    'pull_request',
    'pull_request_target',
    'merge_group',
  ]) {
    assert.deepEqual(
      measureWorkflow(workflow.replace('pull_request', trigger)),
      [2, 10, 1],
    );
  }
  assert.deepEqual(
    measureWorkflow(
      workflow
        .replace('pull_request:', "'pull_request' :")
        .replace('timeout-minutes: 10', '"timeout-minutes" : 10'),
    ),
    [2, 10, 1],
  );
  assert.equal(
    measureWorkflow(workflow.replace('pull_request', 'schedule')),
    null,
  );
  assert.throws(
    () => measureWorkflow('on: [pull_request]\njobs: {}'),
    /block-style/,
  );
  assert.throws(() => measureWorkflow('on:\n  pull_request:\n'), /block-style/);
  assert.deepEqual(
    measureWorkflow(workflow.replace('10', '${{ inputs.timeout }}')),
    [2, 0, 2],
  );
});

test('requires a ledger entry and enforces each budget dimension', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'ci.yml'), workflow);
  const ledger = join(dir, '.ci-budget');
  assert.throws(() => checkBudget(dir), /ENOENT/);

  for (const budget of ['2 10 1', '3 20 2']) {
    writeFileSync(ledger, `# budget\n${budget} ci.yml\n`);
    assert.deepEqual(checkBudget(dir), []);
  }
  for (const [budget, message] of [
    ['1 10 1', 'jobs 1 -> 2'],
    ['2 9 1', 'timeout-minutes 9 -> 10'],
    ['2 10 0', 'jobs without fixed timeout 0 -> 1'],
  ]) {
    writeFileSync(ledger, `${budget} ci.yml\n`);
    const errors = checkBudget(dir);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes(message));
  }
  writeFileSync(ledger, '');
  assert.match(checkBudget(dir)[0], /missing budget/);
  for (const invalid of ['bad entry', '2 10 1 ci.yml\n2 10 1 ci.yml']) {
    writeFileSync(ledger, invalid);
    assert.throws(() => checkBudget(dir), /Invalid budget entry/);
  }
});
