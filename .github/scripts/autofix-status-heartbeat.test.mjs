// Behavioral tests for the round-heartbeat script: the body text shape and
// the loop's pulse, self-exit bounds, and failure tolerance. The workflow
// wiring pins live in scripts/tests/qwen-autofix-workflow.test.js.
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const script = join(scriptsDir, 'autofix-status-heartbeat.sh');

const cleanups = [];
function freshTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'autofix-heartbeat-'));
  cleanups.push(dir);
  return dir;
}
afterEach(() => {
  while (cleanups.length) {
    rmSync(cleanups.pop(), { recursive: true, force: true });
  }
});

// A fake `gh` that records every invocation (NUL-separated argv, one file
// per call) and fails when GH_FAIL=1.
function fakeGhBin(dir) {
  const bin = join(dir, 'bin');
  const records = join(dir, 'calls');
  mkdirSync(bin, { recursive: true });
  mkdirSync(records, { recursive: true });
  const gh = join(bin, 'gh');
  writeFileSync(
    gh,
    [
      '#!/usr/bin/env bash',
      'set -u',
      'n=$(( $(ls -1 "${GH_RECORD_DIR}" | wc -l) + 1 ))',
      'for a in "$@"; do printf \'%s\\0\' "$a"; done > "${GH_RECORD_DIR}/call-${n}"',
      '[ "${GH_FAIL:-0}" = "1" ] && exit 1',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(gh, 0o755);
  return { bin, records };
}

function readCalls(records) {
  return readdirSync(records)
    .filter((name) => name.startsWith('call-'))
    .sort()
    .map((name) =>
      readFileSync(join(records, name), 'utf8').split('\0').filter(Boolean),
    );
}

// A fake `timeout` that records its argv and immediately execs its tail.
// Placed FIRST on PATH, it shadows coreutils `timeout` on Linux and
// supplies it on hosts without one (macOS dev), so the loop's black-hole
// guard is exercised deterministically on every host: the assertion is
// that `gh` runs UNDER `timeout <bound>`, which the shim proves by
// recording the duration and then running gh itself.
function fakeTimeoutBin(binDir, dir) {
  const records = join(dir, 'timeout-calls');
  mkdirSync(records, { recursive: true });
  const timeout = join(binDir, 'timeout');
  writeFileSync(
    timeout,
    [
      '#!/usr/bin/env bash',
      'set -u',
      'n=$(( $(ls -1 "${TIMEOUT_RECORD_DIR}" | wc -l) + 1 ))',
      'for a in "$@"; do printf \'%s\\0\' "$a"; done > "${TIMEOUT_RECORD_DIR}/call-${n}"',
      'shift',
      'exec "$@"',
    ].join('\n'),
  );
  chmodSync(timeout, 0o755);
  return records;
}

function bodyEnv(overrides = {}) {
  const workdir = overrides.HB_WORKDIR ?? freshTmp();
  return {
    HB_ROUND: '3',
    HB_CAP: '100',
    HB_URL: 'https://example.test/actions/runs/1/job/2',
    HB_WORKDIR: workdir,
    HB_START_EPOCH: '1000000',
    ...overrides,
  };
}

function runBody(env) {
  const res = spawnSync('bash', [script, 'body'], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

describe('autofix-status-heartbeat body', () => {
  it('renders the bilingual working comment with the starting state', () => {
    const body = runBody(bodyEnv({ NOW_EPOCH: '1000120' }));
    assert.ok(body.startsWith('<!-- autofix-status -->'));
    assert.ok(body.includes('round 3/100'));
    assert.ok(
      body.includes(
        '[Watch live progress](https://example.test/actions/runs/1/job/2)',
      ),
    );
    assert.ok(body.includes('⏱ Running for 2 min · agent starting'));
    assert.ok(body.includes('<summary>中文说明</summary>'));
    assert.ok(body.includes('第 3/100 轮'));
    assert.ok(body.includes('⏱ 已运行 2 分钟 · agent 准备中'));
    assert.ok(
      body.includes('this round posts its report here when it finishes.'),
    );
  });

  it('reports agent activity from the agent.log mtime', () => {
    const workdir = freshTmp();
    const log = join(workdir, 'agent.log');
    writeFileSync(log, '');
    // mtime 5 minutes (300s) before NOW_EPOCH=1000600 → active 5 min ago;
    // elapsed is from HB_START_EPOCH=1000000 → 10 min.
    utimesSync(log, 1000600 - 300, 1000600 - 300);
    const body = runBody(
      bodyEnv({ HB_WORKDIR: workdir, NOW_EPOCH: '1000600' }),
    );
    assert.ok(body.includes('⏱ Running for 10 min · agent active 5 min ago'));
    assert.ok(body.includes('⏱ 已运行 10 分钟 · agent 最近活动在 5 分钟前'));
  });

  it('clamps a future mtime to "active 0 min ago" instead of negative', () => {
    const workdir = freshTmp();
    const log = join(workdir, 'agent.log');
    writeFileSync(log, '');
    utimesSync(log, 1000600, 1000600);
    const body = runBody(
      bodyEnv({ HB_WORKDIR: workdir, NOW_EPOCH: '1000300' }),
    );
    assert.ok(body.includes('agent active 0 min ago'));
    assert.ok(body.includes('Running for 5 min'));
    assert.ok(body.includes('最近活动在 0 分钟前'));
  });

  it('clamps a clock skew before the start epoch to "Running for 0 min"', () => {
    const body = runBody(bodyEnv({ NOW_EPOCH: '999000' }));
    assert.ok(body.includes('Running for 0 min'));
    assert.ok(body.includes('已运行 0 分钟'));
  });

  it('refuses to run without its required environment', () => {
    const res = spawnSync('bash', [script, 'body'], {
      env: { ...process.env, HB_ROUND: '3' },
      encoding: 'utf8',
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /is required/);
  });

  it('rejects an unknown subcommand', () => {
    const res = spawnSync('bash', [script, 'bogus'], {
      env: process.env,
      encoding: 'utf8',
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /usage:/);
  });
});

describe('autofix-status-heartbeat loop', () => {
  function loopEnv(dir, gh, overrides = {}) {
    const workdir = join(dir, 'work');
    mkdirSync(workdir, { recursive: true });
    return {
      env: {
        ...process.env,
        PATH: `${gh.bin}:${process.env.PATH}`,
        GH_RECORD_DIR: gh.records,
        HB_REPO: 'octo/repo',
        HB_COMMENT_ID: '777',
        HB_ROUND: '2',
        HB_CAP: '100',
        HB_URL: 'https://example.test/run',
        HB_WORKDIR: workdir,
        HB_START_EPOCH: String(Math.floor(Date.now() / 1000)),
        HB_INTERVAL_SECONDS: '1',
        ...overrides,
      },
      workdir,
    };
  }

  function startLoop(env) {
    return spawn('bash', [script, 'loop'], {
      env,
      stdio: 'ignore',
      detached: true,
    });
  }

  async function waitFor(predicate, timeoutMs, stepMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
    return predicate();
  }

  // Resolves with the exit code, or 'timeout' after the budget. ALWAYS
  // clears its timer — a leftover setTimeout firing after the test ends
  // shows up as uncaughtException-style asynchronous activity in node:test.
  function awaitExit(child, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        killGroup(child);
        resolve('timeout');
      }, timeoutMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  function killGroup(child) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // the group is already gone — nothing left to kill
    }
  }

  it('PATCHes the same comment on every tick with growing elapsed time', async () => {
    const dir = freshTmp();
    const gh = fakeGhBin(dir);
    const { env, workdir } = loopEnv(dir, gh);
    const child = startLoop(env);
    try {
      const ok = await waitFor(() => readCalls(gh.records).length >= 2, 8000);
      assert.ok(ok, 'expected at least two PATCH calls');
      const calls = readCalls(gh.records);
      for (const argv of calls) {
        assert.ok(argv.includes('--method'));
        assert.ok(argv.includes('PATCH'));
        assert.ok(
          argv.includes('repos/octo/repo/issues/comments/777'),
          `unexpected PATCH target: ${argv.join(' ')}`,
        );
        const bodyArg = argv.find((a) => a.startsWith('body='));
        assert.ok(bodyArg, 'PATCH must carry -f body=...');
        assert.ok(bodyArg.includes('<!-- autofix-status -->'));
      }
      const bodyOf = (argv) => argv.find((a) => a.startsWith('body='));
      const m = (s) => s.match(/Running for (\d+) min/)?.[1];
      assert.ok(
        Number(m(bodyOf(calls.at(-1)))) >= Number(m(bodyOf(calls[0]))),
        'elapsed minutes must not go backwards between ticks',
      );
      // The loop registered its OWN pid — the value the killers must
      // target, so it must be the loop process itself.
      const pid = readFileSync(join(workdir, 'heartbeat.pid'), 'utf8').trim();
      assert.equal(pid, String(child.pid));
    } finally {
      killGroup(child);
    }
  });

  it('sleeps between ticks instead of busy-looping', async () => {
    const dir = freshTmp();
    const gh = fakeGhBin(dir);
    const { env } = loopEnv(dir, gh, { HB_INTERVAL_SECONDS: '1' });
    const child = startLoop(env);
    try {
      // With a 1s interval, ~2.5s of runtime yields 2-3 ticks; a sleep-less
      // busy loop would produce orders of magnitude more.
      await waitFor(() => readCalls(gh.records).length >= 2, 8000);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const count = readCalls(gh.records).length;
      assert.ok(
        count <= 5,
        `expected a bounded tick count with a 1s interval, got ${count}`,
      );
    } finally {
      killGroup(child);
    }
  });

  it('self-exits when the pid file disappears', async () => {
    const dir = freshTmp();
    const gh = fakeGhBin(dir);
    const { env, workdir } = loopEnv(dir, gh);
    const child = startLoop(env);
    try {
      const started = await waitFor(
        () => existsSync(join(workdir, 'heartbeat.pid')),
        8000,
      );
      assert.ok(started, 'the loop must register its pid first');
      rmSync(join(workdir, 'heartbeat.pid'));
      const code = await awaitExit(child, 8000);
      assert.equal(code, 0, 'a missing pid file must end the loop cleanly');
      const logText = readFileSync(join(workdir, 'heartbeat.log'), 'utf8');
      assert.match(logText, /self-exit: pid file removed/);
    } finally {
      killGroup(child);
    }
  });

  it('self-exits when the pid file is REPLACED by a newer round', async () => {
    // The orphan scenario: WORKDIR is PR-scoped, so the next round of the
    // same PR recreates heartbeat.pid at the same path. The old loop must
    // recognize the foreign pid and exit, not keep pulsing with its stale
    // launch env (alternating stale bodies onto the same comment).
    const dir = freshTmp();
    const gh = fakeGhBin(dir);
    const { env, workdir } = loopEnv(dir, gh);
    const child = startLoop(env);
    try {
      const started = await waitFor(
        () => existsSync(join(workdir, 'heartbeat.pid')),
        8000,
      );
      assert.ok(started, 'the loop must register its pid first');
      writeFileSync(join(workdir, 'heartbeat.pid'), '999999\n');
      const code = await awaitExit(child, 8000);
      assert.equal(code, 0, 'a replaced pid file must end the loop cleanly');
      const logText = readFileSync(join(workdir, 'heartbeat.log'), 'utf8');
      assert.match(logText, /self-exit: pid file removed or replaced/);
    } finally {
      killGroup(child);
    }
  });

  it('degrades malformed interval and age-cap overrides to defaults', async () => {
    const dir = freshTmp();
    const gh = fakeGhBin(dir);
    const { env, workdir } = loopEnv(dir, gh, {
      HB_INTERVAL_SECONDS: 'abc',
      HB_MAX_AGE_SECONDS: '0',
    });
    const child = startLoop(env);
    try {
      const ok = await waitFor(
        () => existsSync(join(workdir, 'heartbeat.log')),
        8000,
      );
      assert.ok(ok, 'the loop must start and log its parameters');
      const logText = readFileSync(join(workdir, 'heartbeat.log'), 'utf8');
      assert.match(logText, /interval 600s max_age 43200s/);
    } finally {
      killGroup(child);
    }
  });

  it('runs each PATCH under timeout so a black-holed request cannot outlive the age cap', async () => {
    // The age cap only runs BETWEEN ticks; a hung `gh api` inside a tick
    // would stall the loop there forever, holding the PAT past the cap.
    // The `timeout 60` wrapper is the guard — pin that gh actually runs
    // under it (the shim records the bound, then execs gh).
    const dir = freshTmp();
    const gh = fakeGhBin(dir);
    const timeoutRecords = fakeTimeoutBin(gh.bin, dir);
    const { env } = loopEnv(dir, gh, { TIMEOUT_RECORD_DIR: timeoutRecords });
    const child = startLoop(env);
    try {
      const ok = await waitFor(() => readCalls(gh.records).length >= 1, 8000);
      assert.ok(ok, 'the shim must exec gh through to its record');
      const timeoutCalls = readCalls(timeoutRecords);
      assert.ok(
        timeoutCalls.length >= 1,
        'gh must run UNDER timeout, not bare',
      );
      assert.equal(timeoutCalls[0][0], '60', 'the bound must be 60s');
      assert.equal(timeoutCalls[0][1], 'gh');
    } finally {
      killGroup(child);
    }
  });

  it('refuses to loop without its required environment', async () => {
    const dir = freshTmp();
    const gh = fakeGhBin(dir);
    const { env } = loopEnv(dir, gh);
    delete env.HB_COMMENT_ID;
    const child = spawn('bash', [script, 'loop'], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const code = await awaitExit(child, 8000);
    assert.equal(code, 2);
    assert.match(stderr, /HB_COMMENT_ID is required/);
  });

  it('refuses to loop when a BODY var is missing — no immortal unpulsing loop', async () => {
    // A launch missing a body var (HB_ROUND here) must fail fast, not
    // produce a loop that lives to the age cap logging "body composition
    // failed" every tick while the status comment freezes — the exact
    // "healthy round looks dead" failure this feature eliminates.
    const dir = freshTmp();
    const gh = fakeGhBin(dir);
    const { env, workdir } = loopEnv(dir, gh);
    delete env.HB_ROUND;
    const child = spawn('bash', [script, 'loop'], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const code = await awaitExit(child, 8000);
    assert.equal(code, 2);
    assert.match(stderr, /HB_ROUND is required/);
    // Fail fast BEFORE registering anything: no pid file, no log.
    assert.ok(!existsSync(join(workdir, 'heartbeat.pid')));
    assert.ok(!existsSync(join(workdir, 'heartbeat.log')));
  });

  it('self-exits at the age cap', async () => {
    const dir = freshTmp();
    const gh = fakeGhBin(dir);
    const { env, workdir } = loopEnv(dir, gh, {
      HB_MAX_AGE_SECONDS: '1',
      HB_START_EPOCH: String(Math.floor(Date.now() / 1000) - 5),
    });
    const child = startLoop(env);
    const code = await awaitExit(child, 8000);
    assert.equal(code, 0, 'the age cap must end the loop cleanly');
    const logText = readFileSync(join(workdir, 'heartbeat.log'), 'utf8');
    assert.match(logText, /self-exit: age/);
  });

  it('stops on the heartbeat-stop marker', async () => {
    const dir = freshTmp();
    const gh = fakeGhBin(dir);
    const { env, workdir } = loopEnv(dir, gh);
    const child = startLoop(env);
    try {
      writeFileSync(join(workdir, 'heartbeat-stop'), '');
      const code = await awaitExit(child, 8000);
      assert.equal(code, 0, 'the stop marker must end the loop cleanly');
    } finally {
      killGroup(child);
    }
  });

  it('keeps pulsing through a failing gh', async () => {
    const dir = freshTmp();
    const gh = fakeGhBin(dir);
    const { env, workdir } = loopEnv(dir, gh, { GH_FAIL: '1' });
    const child = startLoop(env);
    try {
      const ok = await waitFor(() => readCalls(gh.records).length >= 2, 8000);
      assert.ok(ok, 'a failing PATCH must not stop the loop');
      assert.ok(child.exitCode === null, 'loop must still be alive');
      const logText = readFileSync(join(workdir, 'heartbeat.log'), 'utf8');
      assert.match(logText, /PATCH failed; continuing/);
    } finally {
      killGroup(child);
    }
  });
});
