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
// per call), logs the gh-visible env channels the hermetic-pin witness
// asserts on, fails when GH_FAIL=1, and holds the tick in flight for
// GH_SLEEP_SECONDS (default 0) so kill-topology tests can land mid-tick.
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
      '# The in-flight stamp witness: record, FROM INSIDE the bounded',
      '# window, whether heartbeat-tick-inflight brackets this call.',
      'if [ -f "${HB_WORKDIR:-/nonexistent}/heartbeat-tick-inflight" ]; then',
      '  printf \'INFLIGHT=yes CONTENT=%s\\n\' "$(cat "${HB_WORKDIR}/heartbeat-tick-inflight" 2>/dev/null)" >> "${GH_RECORD_DIR}/stamp.log"',
      'else',
      '  printf \'INFLIGHT=no CONTENT=\\n\' >> "${GH_RECORD_DIR}/stamp.log"',
      'fi',
      "printf 'GH_HOST=%s GH_CONFIG_DIR=%s CFG_EXISTS=%s CFG_ENTRIES=%s GITHUB_TOKEN=%s GH_TOKEN=%s GH_ENTERPRISE_TOKEN=%s\\n' \\",
      '  "${GH_HOST:-}" "${GH_CONFIG_DIR:-}" \\',
      '  "$([ -d "${GH_CONFIG_DIR:-/nonexistent}" ] && echo yes || echo no)" \\',
      '  "$(ls -1A "${GH_CONFIG_DIR:-/nonexistent}" 2>/dev/null | wc -l | tr -d \' \')" \\',
      '  "${GITHUB_TOKEN:-}" "${GH_TOKEN:-}" "${GH_ENTERPRISE_TOKEN:-}" \\',
      '  >> "${GH_RECORD_DIR}/gh-env.log"',
      '[ "${GH_FAIL:-0}" = "1" ] && exit 1',
      'sleep "${GH_SLEEP_SECONDS:-0}"',
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

  it('ignores a non-numeric NOW_EPOCH plant instead of evaluating it', () => {
    // NOW_EPOCH is the test-only clock override — no production launcher
    // sets it, so a value can only arrive through an env plant. Bash
    // arithmetic expansion recursively evaluates the variable's value, so
    // a planted value's embedded command substitution would EXECUTE inside
    // the PAT-holding body subcommand; the numeric guard must drop it and
    // fall back to the real clock.
    const probe = join(freshTmp(), 'pwned');
    const body = runBody(bodyEnv({ NOW_EPOCH: `HOME[$(touch "${probe}")]` }));
    assert.ok(!existsSync(probe), 'a planted NOW_EPOCH must not execute');
    assert.match(body, /Running for \d+ min/);
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
    // The loop pins its tick PATH from the launcher-supplied TRUSTED_PATH
    // (af-148): the fakes travel through that capture, never through an
    // ambient PATH the tick no longer trusts.
    const trustedPath = `${gh.bin}:${process.env.PATH}`;
    return {
      env: {
        ...process.env,
        PATH: trustedPath,
        TRUSTED_PATH: trustedPath,
        GH_RECORD_DIR: gh.records,
        GITHUB_TOKEN: 'fake',
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
      // Gate on CONTENT, not existence: `exec >> heartbeat.log` creates
      // the file empty and the first line forks `date -u` before writing,
      // so an existence-gated poll can land in the exists-but-empty
      // window, read '' and throw on the match below — a red lane with
      // no product defect.
      const ok = await waitFor(() => {
        const log = join(workdir, 'heartbeat.log');
        return (
          existsSync(log) &&
          readFileSync(log, 'utf8').includes('heartbeat started')
        );
      }, 8000);
      assert.ok(ok, 'the loop must start and log its parameters');
      const logText = readFileSync(join(workdir, 'heartbeat.log'), 'utf8');
      assert.match(logText, /interval 600s max_age 20400s/);
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
      // The gh PATCH call specifically must be bounded. The pid-identity
      // read now ALSO runs under timeout, so find the gh call rather than
      // assuming it is the first recorded one.
      const ghCall = timeoutCalls.find((c) => c[1] === 'gh');
      assert.ok(ghCall, 'the gh PATCH must run under timeout');
      assert.equal(ghCall[0], '60', 'the gh bound must be 60s');
      // R10-3: the pid-identity self-check must ALSO be a bounded read, so
      // a planted FIFO at heartbeat.pid cannot block the loop inside the
      // tick, past the age cap. The shim proves the read ran under
      // `timeout 5 cat` against the pid file.
      const pidRead = timeoutCalls.find((c) => c[0] === '5' && c[1] === 'cat');
      assert.ok(pidRead, 'the pid-identity read must run under timeout 5');
      assert.ok(
        pidRead.some((a) => a.endsWith('heartbeat.pid')),
        `the bounded read must target heartbeat.pid: ${pidRead.join(' ')}`,
      );
      // The in-flight stamp WRITE is bounded the same way: a planted
      // FIFO at heartbeat-tick-inflight must not block the redirect
      // open inside every tick (the twin guard above pins the same
      // doctrine for the pid-file read).
      const stampWrite = timeoutCalls.find(
        (c) =>
          c[0] === '5' &&
          c[1] === 'bash' &&
          c.some((a) => a.endsWith('heartbeat-tick-inflight')),
      );
      assert.ok(stampWrite, 'the stamp write must run under timeout 5');
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

  it('refuses to loop without a gh token — no immortal never-pulsing loop', async () => {
    // The header contract names GITHUB_TOKEN among the loop's needs: a
    // launch without it must fail fast like any other missing input, not
    // live to the age cap logging "PATCH failed" every tick while the
    // status comment freezes.
    const dir = freshTmp();
    const gh = fakeGhBin(dir);
    const { env, workdir } = loopEnv(dir, gh);
    delete env.GITHUB_TOKEN;
    delete env.GH_TOKEN;
    delete env.GH_ENTERPRISE_TOKEN;
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
    assert.match(stderr, /GITHUB_TOKEN is required/);
    // Fail fast BEFORE registering anything: no pid file, no log.
    assert.ok(!existsSync(join(workdir, 'heartbeat.pid')));
    assert.ok(!existsSync(join(workdir, 'heartbeat.log')));
  });

  it('refuses a GH_TOKEN-only launch — the pins drop that channel before gh', async () => {
    // The hermetic pins unset GH_TOKEN/GH_ENTERPRISE_TOKEN before any gh
    // call, so accepting them at the fail-fast check would admit a launch
    // the pins then leave credential-less — an immortal loop logging
    // "PATCH failed" every tick and never pulsing. Auth rides on the
    // step-level GITHUB_TOKEN only.
    const dir = freshTmp();
    const gh = fakeGhBin(dir);
    const { env, workdir } = loopEnv(dir, gh);
    delete env.GITHUB_TOKEN;
    env.GH_TOKEN = 'planted';
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
    assert.match(stderr, /GITHUB_TOKEN is required/);
    assert.ok(!existsSync(join(workdir, 'heartbeat.pid')));
  });

  it('refuses to loop without TRUSTED_PATH — no tick on an unpinned PATH', async () => {
    // The tick's PATH pin comes from the launcher's step-level capture;
    // a launch without it must fail fast like any other missing input,
    // never run its ticks resolving externals through an ambient,
    // plantable PATH.
    const dir = freshTmp();
    const gh = fakeGhBin(dir);
    const { env, workdir } = loopEnv(dir, gh);
    delete env.TRUSTED_PATH;
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
    assert.match(stderr, /TRUSTED_PATH is required/);
    // Fail fast BEFORE registering anything: no pid file, no log.
    assert.ok(!existsSync(join(workdir, 'heartbeat.pid')));
    assert.ok(!existsSync(join(workdir, 'heartbeat.log')));
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

  it('pins the tick PATH from TRUSTED_PATH — a plant ahead of it is never resolved', async () => {
    // The loop holds the bot PAT and resolves its tick externals by name;
    // the ambient PATH carries same-UID-writable dirs ahead of the system
    // ones (the job's own $GITHUB_PATH append puts ${RUNNER_TEMP}/qwen-bin
    // there; pool hosts carry writable _work/_temp entries). Witness the
    // pin from the tick's own resolution: a planted gh FIRST on the
    // ambient PATH (outside TRUSTED_PATH) must never run, while the gh
    // inside TRUSTED_PATH still serves every tick.
    const dir = freshTmp();
    const gh = fakeGhBin(dir);
    const plantDir = join(dir, 'plant');
    mkdirSync(plantDir, { recursive: true });
    const plantLog = join(dir, 'plant-exfil.log');
    writeFileSync(
      join(plantDir, 'gh'),
      [
        '#!/usr/bin/env bash',
        `printf 'PLANTED_GH_EXECUTED GITHUB_TOKEN=%s\\n' "\${GITHUB_TOKEN:-}" >> "${plantLog}"`,
        'exit 0',
      ].join('\n'),
    );
    chmodSync(join(plantDir, 'gh'), 0o755);
    const { env } = loopEnv(dir, gh, {
      PATH: `${plantDir}:${gh.bin}:${process.env.PATH}`,
    });
    const child = startLoop(env);
    try {
      const ok = await waitFor(() => readCalls(gh.records).length >= 1, 8000);
      assert.ok(ok, 'the gh inside TRUSTED_PATH must serve the tick');
      assert.ok(
        !existsSync(plantLog),
        'a plant on the ambient PATH must never be resolved',
      );
    } finally {
      killGroup(child);
    }
  });

  it('pins gh hermetically for every tick — a fresh config dir per call, removed after', async () => {
    // The loop holds the bot PAT in env and calls gh on a shared host: a
    // planted http_unix_socket in the default ~/.config/gh would deliver
    // the tick's Authorization header to a planted listener, and a planted
    // GH_TOKEN would outrank the step-level GITHUB_TOKEN. Witness the
    // af-112 pins from the tick's own point of view: the fake gh records
    // what it actually sees. R11-1: RUNNER_TEMP is same-UID-writable, so
    // the dir must be minted milliseconds BEFORE each call (a watcher that
    // knows the stable prefix cannot pre-seed a random path) and removed
    // right AFTER — a dir reused across ticks is plantable between calls,
    // and the loop's 600s sleep before the first call made that window a
    // certainty, not a race.
    const dir = freshTmp();
    const gh = fakeGhBin(dir);
    const poisonedConfig = join(dir, 'poisoned-gh-config');
    const runnerTemp = join(dir, 'runner-temp');
    mkdirSync(poisonedConfig, { recursive: true });
    mkdirSync(runnerTemp, { recursive: true });
    const { env, workdir } = loopEnv(dir, gh, {
      GH_HOST: 'evil.example',
      GH_TOKEN: 'planted-token',
      GH_ENTERPRISE_TOKEN: 'planted-enterprise-token',
      GH_CONFIG_DIR: poisonedConfig,
      RUNNER_TEMP: runnerTemp,
    });
    const child = startLoop(env);
    try {
      // The fake gh writes a tick's call record BEFORE it appends the env
      // line, so the gate must cover what the assertion below reads — a
      // call-count gate alone can pass in the window before that append
      // lands, and the unretried read then sees one line instead of two.
      const ok = await waitFor(
        () =>
          readCalls(gh.records).length >= 2 &&
          readFileSync(join(gh.records, 'gh-env.log'), 'utf8')
            .trim()
            .split('\n').length >= 2,
        8000,
      );
      assert.ok(ok, 'expected at least two PATCH calls and two env-log lines');
      const lines = readFileSync(join(gh.records, 'gh-env.log'), 'utf8')
        .trim()
        .split('\n');
      assert.ok(lines.length >= 2, 'every tick must log its gh-visible env');
      const dirs = [];
      for (const line of lines) {
        assert.ok(line.startsWith('GH_HOST=github.com '), line);
        const cfg = line.match(/GH_CONFIG_DIR=(\S*) /)?.[1];
        assert.ok(cfg, line);
        assert.ok(cfg.startsWith(runnerTemp), line);
        dirs.push(cfg);
        // The mint precedes the call (the dir exists, empty of any plant,
        // when gh loads its config) — witnessed by gh itself, since the
        // post-call removal races any after-the-fact filesystem assertion.
        assert.ok(line.includes(' CFG_EXISTS=yes '), line);
        assert.ok(line.includes(' CFG_ENTRIES=0 '), line);
        // GITHUB_TOKEN is the loop's SOLE credential channel now — witness
        // the surviving channel reaches gh, not only that the planted ones
        // do not: a scrub broadened to drop it would keep this suite green
        // while every production tick fails authentication.
        assert.ok(
          line.includes(' GITHUB_TOKEN=fake'),
          `the step-level GITHUB_TOKEN must reach gh: ${line}`,
        );
        assert.ok(line.endsWith(' GH_TOKEN= GH_ENTERPRISE_TOKEN='), line);
        assert.ok(!line.includes('planted'), line);
        assert.ok(!line.includes('evil.example'), line);
        assert.ok(!line.includes(poisonedConfig), line);
      }
      // Every tick mints its OWN dir: a config.yml planted into one tick's
      // dir is inert for every later tick because the path is never reused.
      assert.equal(
        new Set(dirs).size,
        dirs.length,
        'each tick must mint a fresh GH_CONFIG_DIR',
      );
      // Clean self-exit (the pid removal lands between ticks, before any
      // further mint), then witness the post-call removal: no minted dir
      // outlives its gh call.
      rmSync(join(workdir, 'heartbeat.pid'));
      const code = await awaitExit(child, 8000);
      assert.equal(code, 0, 'the loop must end cleanly on pid removal');
      const leftovers = readdirSync(runnerTemp).filter((name) =>
        name.startsWith('autofix-gh-config.'),
      );
      assert.deepEqual(
        leftovers,
        [],
        'minted gh config dirs must not outlive their gh call',
      );
    } finally {
      killGroup(child);
    }
  });

  it('skips the tick on a failed config mint — never gh against a shared config', async () => {
    // Fail CLOSED, the af-112 doctrine: a failing mktemp must skip the
    // tick's gh call, never run gh with the PAT against an unpinned config
    // (an empty GH_CONFIG_DIR falls back to the shared attacker-writable
    // ~/.config/gh), and never stop the pulse — a skip degrades one tick,
    // the age cap still bounds the loop. A fail-open mutant (bare
    // assignment continuing on the empty value) would record gh calls and
    // fail here.
    const dir = freshTmp();
    const gh = fakeGhBin(dir);
    const { env, workdir } = loopEnv(dir, gh, {
      RUNNER_TEMP: join(dir, 'no-such-runner-temp'),
    });
    const child = startLoop(env);
    try {
      // Several tick intervals at the 1s test interval.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      assert.equal(
        readCalls(gh.records).length,
        0,
        'a failed mint must skip the gh call entirely',
      );
      assert.ok(child.exitCode === null, 'a failed mint must not end the loop');
      const logText = readFileSync(join(workdir, 'heartbeat.log'), 'utf8');
      assert.match(logText, /gh config mint failed; skipping this tick/);
    } finally {
      killGroup(child);
    }
  });

  it('stamps each tick in flight around the gh call and clears it after', async () => {
    // finalize's drain relies on heartbeat-tick-inflight bracketing
    // every gh call: the fake gh observes the stamp FROM INSIDE the
    // bounded window (present, with a numeric epoch), and the stamp
    // must not outlive a clean loop exit — a stale stamp would make
    // finalize wait the full bound for a request that already ended.
    const dir = freshTmp();
    const gh = fakeGhBin(dir);
    const { env, workdir } = loopEnv(dir, gh);
    const child = startLoop(env);
    try {
      const ok = await waitFor(
        () =>
          readCalls(gh.records).length >= 2 &&
          existsSync(join(gh.records, 'stamp.log')) &&
          readFileSync(join(gh.records, 'stamp.log'), 'utf8').trim().split('\n')
            .length >= 2,
        8000,
      );
      assert.ok(
        ok,
        'expected at least two PATCH calls with stamp observations',
      );
      const stamps = readFileSync(join(gh.records, 'stamp.log'), 'utf8')
        .trim()
        .split('\n');
      for (const line of stamps) {
        assert.ok(line.startsWith('INFLIGHT=yes CONTENT='), line);
        assert.match(line.split('CONTENT=')[1], /^\d+$/, line);
      }
      // End the loop cleanly; the stamp must be gone afterwards.
      rmSync(join(workdir, 'heartbeat.pid'));
      const code = await awaitExit(child, 8000);
      assert.equal(code, 0, 'the loop must end cleanly on pid removal');
      assert.ok(
        !existsSync(join(workdir, 'heartbeat-tick-inflight')),
        'the stamp must not outlive the loop',
      );
    } finally {
      killGroup(child);
    }
  });

  // The mid-tick kill-topology witness needs coreutils `timeout` (which
  // gives the tick its own process group) and procps pkill/pgrep (the
  // session kill and its oracle); hosts without them still carry the
  // pinned statement list in the workflow test.
  const haveSessionKillTools =
    spawnSync('bash', [
      '-c',
      'command -v timeout >/dev/null && command -v pkill >/dev/null && command -v pgrep >/dev/null',
    ]).status === 0;

  function processAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it(
    'a session kill empties the whole loop even when it lands mid-tick',
    {
      skip: haveSessionKillTools
        ? false
        : 'requires coreutils timeout + procps pkill/pgrep',
    },
    async () => {
      // Each tick's `timeout 60 gh` subtree runs in its OWN process group
      // (coreutils timeout default) inside the loop's setsid session, so a
      // group+pid kill landing mid-tick leaves it alive holding the token
      // for up to 60s — the witness that drove the session kill at every
      // killer. Part 1 proves the escape, part 2 proves the fix. The real
      // (unshimmed) timeout runs — no fake timeout on PATH here — and a
      // slow fake gh holds the tick in flight.
      const dir = freshTmp();
      const gh = fakeGhBin(dir);
      const { env } = loopEnv(dir, gh, { GH_SLEEP_SECONDS: '15' });
      const child = startLoop(env);
      const pid = child.pid;
      try {
        const inFlight = await waitFor(
          () => readCalls(gh.records).length >= 1,
          8000,
        );
        assert.ok(inFlight, 'the slow gh must put a tick in flight');
        // Part 1 — the defect: group+pid kills alone leave the tick
        // subtree alive in the loop's session.
        spawnSync('bash', [
          '-c',
          `kill -- -${pid} 2>/dev/null || true; kill ${pid} 2>/dev/null || true`,
        ]);
        const escaped = await waitFor(
          () =>
            !processAlive(pid) &&
            spawnSync('pgrep', ['-s', String(pid)]).status === 0,
          5000,
        );
        assert.ok(escaped, 'the mid-tick subtree must escape a group+pid kill');
        // Part 2 — the fix: the session kill reaches everything sharing
        // the loop's session.
        spawnSync('bash', ['-c', `pkill -TERM -s ${pid} 2>/dev/null || true`]);
        const emptied = await waitFor(
          () => spawnSync('pgrep', ['-s', String(pid)]).status !== 0,
          5000,
        );
        assert.ok(emptied, 'the session kill must empty the loop session');
      } finally {
        spawnSync('bash', ['-c', `pkill -KILL -s ${pid} 2>/dev/null || true`]);
        killGroup(child);
      }
    },
  );

  it(
    'a planted FIFO at heartbeat.pid cannot block the loop past the bounded read',
    {
      skip: haveSessionKillTools
        ? false
        : 'requires coreutils timeout (the bounded-read guard)',
    },
    async () => {
      // R10-3: WORKDIR is sandbox-writable, so an attacker can replace
      // heartbeat.pid with a FIFO whose open blocks cat indefinitely —
      // stalling the loop inside the tick, past the age cap. The bounded
      // `timeout 5 cat` must kill the read, and the identity mismatch
      // (empty != $$) must then end the loop cleanly. Real coreutils
      // timeout runs here — no shim on PATH in this test.
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
        spawnSync('mkfifo', [join(workdir, 'heartbeat.pid')]);
        const code = await awaitExit(child, 15000);
        assert.equal(
          code,
          0,
          'the bounded read must end the loop cleanly, not block it',
        );
        const logText = readFileSync(join(workdir, 'heartbeat.log'), 'utf8');
        assert.match(logText, /self-exit: pid file removed or replaced/);
      } finally {
        killGroup(child);
      }
    },
  );

  it(
    'a planted FIFO at heartbeat-tick-inflight cannot block the loop past the bounded write',
    {
      skip: haveSessionKillTools
        ? false
        : 'requires coreutils timeout (the bounded-write guard)',
    },
    async () => {
      // WORKDIR is sandbox-writable, so a FIFO planted at the stamp
      // path would block an unguarded `date > file` redirect open
      // inside EVERY tick — stalling the loop past the age cap. The
      // bounded `timeout 5 bash -c` write must give up, and the tick
      // must proceed to its PATCH (degrading to the pre-drain race,
      // never stopping the pulse). Real coreutils timeout runs here —
      // no shim on PATH in this test.
      const dir = freshTmp();
      const gh = fakeGhBin(dir);
      const { env, workdir } = loopEnv(dir, gh);
      spawnSync('mkfifo', [join(workdir, 'heartbeat-tick-inflight')]);
      const child = startLoop(env);
      try {
        // 1s interval + the 5s write bound: the first PATCH lands
        // around 6-7s in.
        const ok = await waitFor(
          () => readCalls(gh.records).length >= 1,
          20000,
        );
        assert.ok(ok, 'the bounded stamp write must not stall the tick');
        assert.ok(child.exitCode === null, 'the loop must keep pulsing');
      } finally {
        killGroup(child);
      }
    },
  );
});
