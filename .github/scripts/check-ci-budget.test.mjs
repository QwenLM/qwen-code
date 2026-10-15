import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseTriggers,
  parseJobs,
  measureWorkflow,
  parseBaseline,
  checkBudget,
} from './check-ci-budget.mjs';

// A workflow whose `on` key YAML parses as boolean true, which is why the
// parser accepts both spellings.
const BARE_ON = `name: 'x'
on:
  pull_request:
    paths: ['packages/**']
jobs:
  build:
    timeout-minutes: 10
    runs-on: ubuntu-latest
`;

const TRUE_ON = BARE_ON.replace(/^on:/, 'true:');

describe('parseTriggers', () => {
  it('reads both `on:` and `true:` spellings identically', () => {
    assert.deepEqual(parseTriggers(BARE_ON), ['pull_request']);
    assert.deepEqual(parseTriggers(TRUE_ON), ['pull_request']);
  });

  it('stops at the next top-level key so job names are not read as triggers', () => {
    assert.deepEqual(parseTriggers(`${BARE_ON}\njobs:\n  pull_request:\n`), [
      'pull_request',
    ]);
  });

  it('returns [] when there is no trigger block', () => {
    assert.deepEqual(parseTriggers("name: 'x'\njobs: {}\n"), []);
  });
});

describe('parseJobs', () => {
  it('captures the job-level timeout-minutes', () => {
    assert.deepEqual(parseJobs(BARE_ON), [
      { name: 'build', timeoutMinutes: 10 },
    ]);
  });

  it('ignores a step-level timeout-minutes, which is not the job budget', () => {
    const src = `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: 'true'
        timeout-minutes: 3
`;
    assert.deepEqual(parseJobs(src), [{ name: 'build', timeoutMinutes: null }]);
  });

  it('returns null when there is no jobs block, so callers fail closed', () => {
    assert.equal(parseJobs("name: 'x'\n"), null);
  });
});

describe('measureWorkflow', () => {
  it('returns null for a workflow with no PR-stage trigger', () => {
    assert.equal(
      measureWorkflow(
        "on:\n  schedule:\n    - cron: '* * * * *'\njobs:\n  a:\n",
      ),
      null,
    );
  });

  it('counts merge_group as PR-stage', () => {
    const m = measureWorkflow(
      'on:\n  merge_group:\njobs:\n  a:\n    timeout-minutes: 5\n',
    );
    assert.deepEqual(m.triggers, ['merge_group']);
    assert.equal(m.timeoutMinutes, 5);
  });

  it('names the jobs that declare no timeout', () => {
    const m = measureWorkflow(
      'on:\n  pull_request:\njobs:\n  a:\n  b:\n    timeout-minutes: 4\n',
    );
    assert.equal(m.jobCount, 2);
    assert.equal(m.timeoutMinutes, 4);
    assert.deepEqual(m.jobsWithoutTimeout, ['a']);
  });
});

describe('parseBaseline', () => {
  it('skips comments and blank lines', () => {
    const { entries, errors } = parseBaseline(
      '# note\n\n2 20 0 pull_request a.yml\n',
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(entries.get('a.yml'), {
      jobCount: 2,
      timeoutMinutes: 20,
      jobsWithoutTimeout: 0,
      triggers: 'pull_request',
    });
  });

  it('reports a malformed line instead of skipping it, which would fail open', () => {
    const { errors } = parseBaseline('2 20 pull_request a.yml\n');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /expected '<jobs>/);
  });

  it('rejects a leading-zero count that bash would read as octal', () => {
    const { errors } = parseBaseline('02 20 0 pull_request a.yml\n');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /decimal integers without leading zeros/);
  });
});

describe('checkBudget', () => {
  let dir;
  let wfDir;
  let baselineFile;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ci-budget-'));
    wfDir = join(dir, '.github', 'workflows');
    mkdirSync(wfDir, { recursive: true });
    baselineFile = join(wfDir, '.ci-budget');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (baseSha = '') =>
    checkBudget({ workflowDir: wfDir, baselineFile, baseSha });

  it('passes when the workflow matches its recorded budget', () => {
    writeFileSync(join(wfDir, 'a.yml'), BARE_ON);
    writeFileSync(baselineFile, '1 10 0 pull_request a.yml\n');
    const { errors, ledger } = run();
    assert.deepEqual(errors, []);
    assert.equal(ledger.length, 1);
  });

  it('fails when a PR adds a job without bumping the ledger', () => {
    writeFileSync(
      join(wfDir, 'a.yml'),
      `${BARE_ON}  test:\n    timeout-minutes: 7\n`,
    );
    writeFileSync(baselineFile, '1 10 0 pull_request a.yml\n');
    const { errors } = run();
    assert.equal(errors.length, 1);
    assert.match(errors[0], /PR-stage jobs 1 → 2/);
    assert.match(errors[0], /declared timeout-minutes 10 → 17/);
  });

  it('fails when a new job drops its timeout-minutes, worth 360 min of runner', () => {
    writeFileSync(
      join(wfDir, 'a.yml'),
      `${BARE_ON}  test:\n    runs-on: ubuntu-latest\n`,
    );
    writeFileSync(baselineFile, '1 10 0 pull_request a.yml\n');
    const { errors } = run();
    assert.equal(errors.length, 1);
    assert.match(errors[0], /jobs with no timeout-minutes 0 → 1/);
  });

  it('fails on a new PR-stage workflow with no ledger entry', () => {
    writeFileSync(join(wfDir, 'a.yml'), BARE_ON);
    writeFileSync(join(wfDir, 'new.yml'), BARE_ON);
    writeFileSync(baselineFile, '1 10 0 pull_request a.yml\n');
    const { errors } = run();
    assert.equal(errors.length, 1);
    assert.match(errors[0], /new\.yml has no entry/);
    assert.match(errors[0], /1 10 0 pull_request new\.yml/);
  });

  it('ignores a workflow that is not PR-stage', () => {
    writeFileSync(join(wfDir, 'a.yml'), BARE_ON);
    writeFileSync(
      join(wfDir, 'nightly.yml'),
      "on:\n  schedule:\n    - cron: '* * * * *'\njobs:\n  x:\n",
    );
    writeFileSync(baselineFile, '1 10 0 pull_request a.yml\n');
    const { errors, ledger } = run();
    assert.deepEqual(errors, []);
    assert.deepEqual(
      ledger.map((l) => l.file),
      ['a.yml'],
    );
  });

  it('warns to reclaim slack when a workflow shrinks, so the saving is not banked', () => {
    writeFileSync(
      join(wfDir, 'a.yml'),
      'on:\n  pull_request:\njobs:\n  build:\n    timeout-minutes: 4\n',
    );
    writeFileSync(baselineFile, '1 10 0 pull_request a.yml\n');
    const { errors, warnings } = run();
    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0],
      /lower its .* entry to '1 4 0 pull_request a\.yml'/,
    );
  });

  it('warns when the ledger records a workflow that stopped being PR-stage', () => {
    writeFileSync(
      join(wfDir, 'a.yml'),
      "on:\n  schedule:\n    - cron: '* * * * *'\njobs:\n  x:\n",
    );
    writeFileSync(baselineFile, '1 10 0 pull_request a.yml\n');
    const { errors, warnings } = run();
    assert.deepEqual(errors, []);
    assert.match(warnings[0], /no longer triggers on/);
  });

  it('fails closed when the ledger file is missing', () => {
    writeFileSync(join(wfDir, 'a.yml'), BARE_ON);
    const { errors } = run();
    assert.equal(errors.length, 1);
    assert.match(errors[0], /is missing or unreadable/);
  });

  it('fails closed when an unresolvable base SHA leaves staleness undecidable', () => {
    writeFileSync(
      join(wfDir, 'a.yml'),
      `${BARE_ON}  test:\n    timeout-minutes: 7\n`,
    );
    writeFileSync(baselineFile, '1 10 0 pull_request a.yml\n');
    // Point git at a directory that is no repository, so neither rev-parse nor
    // the fetch fallback can reach a remote: the suite runs in the repo itself,
    // and a dep-free lane must not depend on the network. The ratchet must not
    // downgrade the error to a stale-baseline warning.
    const savedGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = join(dir, 'not-a-repo.git');
    try {
      const { errors } = run('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
      assert.equal(errors.length, 1);
      assert.match(errors[0], /grew its PR-stage CI budget/);
    } finally {
      if (savedGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedGitDir;
    }
  });
});
