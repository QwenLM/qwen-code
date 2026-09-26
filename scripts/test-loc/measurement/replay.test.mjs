import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';

const script = fileURLToPath(new URL('./replay.mjs', import.meta.url));
const pkg = 'packages/core';
const source = `${pkg}/src/example.ts`;
const testcase = `${pkg}/src/example.test.ts`;

function fixture(t, { collectionSuite = false } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'testloc-replay-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const write = (name, value) => {
    const file = path.join(repo, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  const git = (...args) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'core.hooksPath', path.join(repo, '.git/disabled-hooks'));
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Replay Test');
  write(source, 'export const broken = true;\n');
  write(testcase, "import { broken } from './example.js';\n");
  if (collectionSuite)
    write(
      `${pkg}/src/loading.test.ts`,
      "import { broken } from './example.js';\n",
    );
  git('add', '.');
  git('commit', '--quiet', '-m', 'initial');
  write(source, 'export const broken = false;\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'fix regression');
  const sha = git('rev-parse', 'HEAD');
  write(
    'corpus.json',
    JSON.stringify({
      corpus: [
        { sha, subject: 'fix regression', impl: [source], tests: [testcase] },
      ],
    }),
  );
  write(
    'node_modules/vitest/vitest.mjs',
    `
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const broken = fs.readFileSync('src/example.ts', 'utf8').includes('= true');
if (broken && process.env.TESTLOC_DELAY_FAULT === '1') {
  if (process.env.TESTLOC_GRANDCHILD === '1') {
    spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync("grandchild-ready",String(process.pid));setInterval(()=>{},1000)'], { stdio: 'inherit' });
  }
  fs.writeFileSync('fault-started', 'yes');
  await new Promise((resolve) => setTimeout(resolve, 30000));
}
const collectionMode = process.env.TESTLOC_COLLECTION_MODE;
const collectionFailure = collectionMode === 'health' || (broken && ['fault', 'suite-only', 'preexisting-only'].includes(collectionMode));
const envFailure = process.env.TESTLOC_ENV_FAILURE === '1' || collectionMode === 'preexisting-only';
const assertions = [
  { fullName: 'behavior', title: 'behavior', status: broken && !['suite-only', 'preexisting-only'].includes(collectionMode) ? 'failed' : 'passed' },
  { fullName: 'environment', title: 'environment', status: envFailure ? 'failed' : 'passed' },
];
if (process.env.TESTLOC_EMPTY_ASSERTIONS === '1' && broken) assertions.length = 0;
if (process.env.TESTLOC_MIXED_SKIPPED === '1') {
  assertions.push(...Array.from({ length: 1914 }, (_, index) => ({ fullName: 'passed ' + index, title: 'passed ' + index, status: 'passed' })));
  assertions.push(...['Darwin guard', 'root guard'].map((name) => ({ fullName: name, title: name, status: 'skipped' })));
}
if (process.env.TESTLOC_ONLY_SKIPPED) for (const assertion of assertions) assertion.status = process.env.TESTLOC_ONLY_SKIPPED;
const testResults = [{ name: path.resolve('src/example.test.ts'), status: assertions.some((a) => a.status === 'failed') ? 'failed' : 'passed', assertionResults: assertions }];
if (fs.existsSync('src/loading.test.ts')) testResults.push({
  name: path.resolve('src/loading.test.ts'), status: collectionFailure ? 'failed' : 'passed',
  message: collectionFailure ? 'imported export is not a function' : '',
  assertionResults: collectionFailure ? [] : [{ fullName: 'loading test', title: 'loading test', status: 'passed' }],
});
const allAssertions = testResults.flatMap((suite) => suite.assertionResults);
const failed = allAssertions.filter((a) => a.status === 'failed').length;
const pending = allAssertions.filter((a) => ['pending', 'skipped'].includes(a.status)).length;
const total = process.env.TESTLOC_EMPTY_ASSERTIONS === '1' && broken ? 2 : allAssertions.length;
const out = process.argv.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length);
if (process.env.TESTLOC_NO_FAULT_REPORT !== '1' || !broken) {
  fs.writeFileSync(out, JSON.stringify({ success: !failed && !collectionFailure, numTotalTests: total, numPassedTests: total - failed - pending, numFailedTests: failed, numPendingTests: pending, numTodoTests: 0, testResults }));
}
process.exitCode = failed || collectionFailure ? 1 : 0;
`,
  );
  const call = (command, out, env = {}) =>
    spawnSync(
      process.execPath,
      [
        script,
        command,
        '--repo',
        repo,
        '--out',
        path.join(repo, out),
        ...(command === 'prepare-faults'
          ? ['--corpus', path.join(repo, 'corpus.json')]
          : ['--plan', path.join(repo, 'plan.json')]),
      ],
      { encoding: 'utf8', env: { ...process.env, ...env } },
    );
  assert.equal(call('prepare-faults', 'plan.json').status, 0);
  return {
    repo,
    git,
    write,
    call,
    read: (name) => JSON.parse(fs.readFileSync(path.join(repo, name), 'utf8')),
  };
}

test('freezes candidates, detects new failures, and restores source and mode', (t) => {
  const f = fixture(t);
  const absolute = path.join(f.repo, source);
  fs.chmodSync(absolute, 0o755);
  f.git('add', source);
  f.git('commit', '--quiet', '-m', 'make executable');
  const result = f.call('run-faults', 'result.json', {
    TESTLOC_ENV_FAILURE: '1',
  });
  assert.equal(
    result.status,
    0,
    result.stderr || JSON.stringify(f.read('result.json')),
  );
  const [fault] = f.read('result.json').results;
  assert.equal(fault.status, 'detected');
  assert.equal(fault.failedTests, 1);
  assert.equal(fault.healthFailures, 1);
  assert.equal(fault.newFailures[0].test, 'behavior');
  assert.equal(f.read('plan.json').maxTests, 40);
  assert.deepEqual(f.read('plan.json').faults[0].candidateTests, [testcase]);
  assert.equal(
    fs.readFileSync(absolute, 'utf8'),
    'export const broken = false;\n',
  );
  assert.equal(fs.statSync(absolute).mode & 0o777, 0o755);
  assert.equal(f.git('status', '--porcelain', '--untracked-files=no'), '');
});

test('missing fresh fault report returns an error and restores implementation', (t) => {
  const f = fixture(t);
  const result = f.call('run-faults', 'result.json', {
    TESTLOC_NO_FAULT_REPORT: '1',
  });
  assert.equal(result.status, 2);
  assert.equal(f.read('result.json').results[0].status, 'no-result');
  assert.equal(f.git('status', '--porcelain', '--untracked-files=no'), '');
});

test('refuses a changed implementation before replaying a frozen plan', (t) => {
  const f = fixture(t);
  f.write(source, 'export const broken = false; // changed\n');
  f.git('add', source);
  f.git('commit', '--quiet', '-m', 'change implementation');
  const result = f.call('run-faults', 'result.json');
  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /Implementation or runtime configuration differs/,
  );
  assert.equal(fs.existsSync(path.join(f.repo, 'result.json')), false);
});

for (const [label, env] of [
  ['empty assertion collection', { TESTLOC_EMPTY_ASSERTIONS: '1' }],
  ['all skipped assertions', { TESTLOC_ONLY_SKIPPED: 'skipped' }],
  ['all pending assertions', { TESTLOC_ONLY_SKIPPED: 'pending' }],
]) {
  test(`rejects ${label} as capability evidence`, (t) => {
    const f = fixture(t);
    const result = f.call('run-faults', 'result.json', env);
    assert.equal(result.status, 2);
    assert.equal(f.read('result.json').results[0].status, 'no-result');
    assert.equal(f.read('result.json').complete, true);
    assert.equal(f.git('status', '--porcelain', '--untracked-files=no'), '');
  });
}

test('accepts passed and skipped assertions counted as pending in real Vitest reports', (t) => {
  const f = fixture(t);
  const result = f.call('run-faults', 'result.json', {
    TESTLOC_MIXED_SKIPPED: '1',
  });
  assert.equal(
    result.status,
    0,
    result.stderr || JSON.stringify(f.read('result.json')),
  );
  const [fault] = f.read('result.json').results;
  assert.equal(fault.status, 'detected');
  assert.equal(fault.failedTests, 1);
  assert.equal(fault.healthFailures, 0);
  assert.equal(fault.totalTests, 1918);
  const health = JSON.parse(fs.readFileSync(fault.healthReport, 'utf8'));
  assert.equal(health.success, true);
  assert.equal(health.numPassedTests, 1916);
  assert.equal(health.numPendingTests, 2);
  assert.equal(
    health.testResults[0].assertionResults.filter((a) => a.status === 'skipped')
      .length,
    2,
  );
  assert.equal(f.git('status', '--porcelain', '--untracked-files=no'), '');
});

test('SIGTERM terminates the owned process tree and restores an active injection', async (t) => {
  const f = fixture(t);
  const child = spawn(
    process.execPath,
    [
      script,
      'run-faults',
      '--repo',
      f.repo,
      '--plan',
      path.join(f.repo, 'plan.json'),
      '--out',
      path.join(f.repo, 'result.json'),
    ],
    {
      env: {
        ...process.env,
        TESTLOC_DELAY_FAULT: '1',
        TESTLOC_GRANDCHILD: '1',
      },
      stdio: 'ignore',
    },
  );
  t.after(() => child.kill('SIGKILL'));
  const closed = once(child, 'close');
  const marker = path.join(f.repo, pkg, 'grandchild-ready');
  for (let attempt = 0; !fs.existsSync(marker) && attempt < 500; attempt++)
    await setTimeout(20);
  assert.equal(fs.existsSync(marker), true, 'injected test process started');
  const grandchildPid = Number(fs.readFileSync(marker, 'utf8'));
  child.kill('SIGTERM');
  const [code] = await closed;
  assert.equal(code, 2);
  const processes = execFileSync('ps', ['-axo', 'pid=,stat='], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n');
  assert.equal(
    processes.some((line) => {
      const [pid, status] = line.trim().split(/\s+/);
      return Number(pid) === grandchildPid && !status.startsWith('Z');
    }),
    false,
    'grandchild has terminated',
  );
  assert.equal(f.read('result.json').complete, false);
  assert.equal(f.read('result.json').results[0].status, 'no-result');
  assert.equal(f.git('status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(
    fs.existsSync(path.join(f.repo, '.git/test-loc-replay.lock')),
    false,
  );
});

test('injected load errors remain visible while new real assertion failures detect the fault', (t) => {
  const f = fixture(t, { collectionSuite: true });
  const result = f.call('run-faults', 'result.json', {
    TESTLOC_COLLECTION_MODE: 'fault',
  });
  assert.equal(result.status, 0, result.stderr);
  const [fault] = f.read('result.json').results;
  assert.equal(fault.status, 'detected');
  assert.equal(fault.failedTests, 1);
  assert.equal(fault.newFailures[0].test, 'behavior');
  assert.deepEqual(fault.collectionFailures, [
    {
      file: `${pkg}/src/loading.test.ts`,
      message: 'imported export is not a function',
    },
  ]);
  assert.deepEqual(fault.failedFiles, [testcase]);
  assert.equal(f.git('status', '--porcelain', '--untracked-files=no'), '');
});

for (const mode of ['suite-only', 'preexisting-only', 'health']) {
  test(`collection failure in ${mode} phase cannot count as detected`, (t) => {
    const f = fixture(t, { collectionSuite: true });
    const result = f.call('run-faults', 'result.json', {
      TESTLOC_COLLECTION_MODE: mode,
    });
    assert.equal(result.status, 2);
    const [fault] = f.read('result.json').results;
    assert.equal(fault.status, 'no-result');
    assert.equal(fault.collectionFailures.length, 1);
    assert.match(
      fault.reason,
      mode === 'health'
        ? /Health test collection failed/
        : /no new failed assertions/,
    );
    assert.equal(f.git('status', '--porcelain', '--untracked-files=no'), '');
  });
}

test('a signaled Stryker child cannot pass using a report it wrote before termination', (t) => {
  const f = fixture(t);
  for (const name of ['core', 'vitest-runner'])
    f.write(
      `runtime/node_modules/@stryker-mutator/${name}/package.json`,
      JSON.stringify({ version: '10.0.0' }),
    );
  f.write(
    'runtime/node_modules/@stryker-mutator/core/bin/stryker.js',
    `
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
fs.writeFileSync(config.jsonReporter.fileName, JSON.stringify({
  files: { 'src/example.ts': { source: fs.readFileSync('src/example.ts', 'utf8'), mutants: [{ status: 'Killed' }] } },
  testFiles: { 'src/example.test.ts': { tests: [{ id: '1', name: 'behavior' }] } },
}));
process.kill(process.pid, 'SIGTERM');
`,
  );
  const prepare = spawnSync(
    process.execPath,
    [
      script,
      'prepare-mutations',
      '--repo',
      f.repo,
      '--modules',
      'src/example.ts',
      '--out',
      path.join(f.repo, 'mutations-plan.json'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(prepare.status, 0, prepare.stderr);
  const run = spawnSync(
    process.execPath,
    [
      script,
      'run-mutations',
      '--repo',
      f.repo,
      '--runtime',
      path.join(f.repo, 'runtime'),
      '--plan',
      path.join(f.repo, 'mutations-plan.json'),
      '--out',
      path.join(f.repo, 'mutations-result.json'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 2);
  assert.match(run.stderr, /SIGTERM/);
  assert.equal(f.read('mutations-result.json').complete, false);
  assert.equal(f.git('status', '--porcelain', '--untracked-files=no'), '');
});
