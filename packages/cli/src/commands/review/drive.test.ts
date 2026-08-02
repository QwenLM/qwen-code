/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Three facts this command exists to make deterministic, and one it must never
// fake. The measurements behind them, from 260 maintainer-verification
// sessions: 81% waited with `sleep`, 74% captured one screenful with no way to
// know the command had finished, 87% cleaned up by hand.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  runDrive,
  wrapScript,
  sentinelExitCode,
  trimCapture,
  DRIVE_SENTINEL,
  type ExecResult,
} from './drive.js';

const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });
const fail = (stderr = ''): ExecResult => ({ status: 1, stdout: '', stderr });

/**
 * A fake tmux + shell. `log` records every argv so a test can assert on the
 * lifecycle itself — which is the only way to pin "cleanup happens even when
 * the drive fails", since nothing in the report says so.
 */
function harness(opts: {
  tmuxAvailable?: boolean;
  readyAfter?: number;
  sessionStarts?: boolean;
  paneWrites?: string[];
}) {
  const log: string[][] = [];
  let readyCalls = 0;
  let poll = 0;
  const pane = opts.paneWrites ?? [];
  const exec = (cmd: string, args: string[]): ExecResult => {
    log.push([cmd, ...args]);
    if (cmd === 'tmux' && args[0] === '-V')
      return opts.tmuxAvailable === false ? fail() : ok('tmux 3.4');
    if (cmd === 'sleep') return ok();
    if (cmd === 'bash') {
      readyCalls++;
      return readyCalls >= (opts.readyAfter ?? 1) ? ok() : fail();
    }
    if (cmd === 'tmux' && args[2] === 'new-session')
      return opts.sessionStarts === false ? fail('no server') : ok();
    return ok();
  };
  // The pane log is read from disk by runDrive; emulate growth by writing it.
  return {
    exec,
    log,
    nextPane: () => pane[Math.min(poll++, pane.length - 1)] ?? '',
  };
}

describe('the sentinel', () => {
  it('carries the exit code on the same line it announces completion', () => {
    // Two facts read from one capture. A capture holding the marker but not the
    // code would report `completed` with an unknown result.
    expect(wrapScript('true')).toContain(`${DRIVE_SENTINEL} rc=`);
    expect(sentinelExitCode(`x\n${DRIVE_SENTINEL} rc=0\n`)).toBe(0);
    expect(sentinelExitCode(`x\n${DRIVE_SENTINEL} rc=17\n`)).toBe(17);
  });

  it('is absent until it is really there — a partial capture yields null', () => {
    expect(sentinelExitCode('still running…')).toBeNull();
    expect(sentinelExitCode(`${DRIVE_SENTINEL} rc=`)).toBeNull();
  });

  it("reads the LAST occurrence, so the script's own output cannot decide the code", () => {
    // The trap writes the real sentinel last, by construction. A drive script
    // that cats a previous log — or replays a capture — emits a
    // sentinel-shaped line of its own, and taking the first match would let
    // that text set the exit code this command reports.
    const replayed = `${DRIVE_SENTINEL} rc=0\nnow the real run\n${DRIVE_SENTINEL} rc=42\n`;
    expect(sentinelExitCode(replayed)).toBe(42);
  });

  it('survives an explicit `exit N` — the way a drive script reports its result', () => {
    // The first version put the sentinel in a trailing `echo`, which `exit`
    // never reaches. Measured end to end: `echo failing; exit 17` came back
    // `timed-out` with a null exit code — a run that answered in milliseconds
    // reported as one that never finished. A `set +e` assertion did not catch
    // it, because `set +e` has no bearing on `exit`; the trap does.
    expect(wrapScript('exit 17')).toMatch(/^trap .* EXIT/);
  });
});

describe('the wrapper, driven for real', () => {
  // Four ways a script can leave, all of which a reviewer's drive script uses.
  // These run real bash — the harness tests above cannot see a shell semantic.
  const realExit = (script: string): number | null => {
    const r = spawnSync('bash', ['-c', wrapScript(script)], {
      encoding: 'utf8',
    });
    return sentinelExitCode(r.stdout ?? '');
  };

  it('reports the code for every exit path', () => {
    expect(realExit('echo ok')).toBe(0);
    expect(realExit('echo failing; exit 17')).toBe(17);
    expect(realExit('set -e; false; echo unreachable')).toBe(1);
    expect(realExit('exit 0')).toBe(0);
  });

  it('keeps the script output alongside the sentinel', () => {
    const r = spawnSync('bash', ['-c', wrapScript('echo hello-there')], {
      encoding: 'utf8',
    });
    expect(r.stdout).toContain('hello-there');
    expect(sentinelExitCode(r.stdout ?? '')).toBe(0);
  });
});

describe('the capture', () => {
  it('keeps the TAIL when it must trim, and says that it trimmed', () => {
    const big = 'x'.repeat(300_000) + 'THE-RESULT';
    const { text, truncated } = trimCapture(big);
    expect(truncated).toBe(true);
    expect(text).toContain('THE-RESULT');
    expect(text).toContain('omitted from the head');
  });

  it('leaves a capture under the cap exactly as it was', () => {
    const { text, truncated } = trimCapture('small output');
    expect(text).toBe('small output');
    expect(truncated).toBe(false);
  });
});

describe('readiness', () => {
  it('polls until the probe passes, and reports how long that took', () => {
    // The whole point: `sleep 2` on a slower machine captures an empty screen,
    // and an empty screen reads as "the feature does not work".
    const h = harness({ readyAfter: 3 });
    const r = runDrive({
      script: 'true',
      cwd: '/tmp',
      ready: 'curl -sf localhost:1/health',
      readyTimeout: 60,
      timeout: 1,
      server: 't1',
      exec: h.exec,
    });
    const probes = h.log.filter((l) => l[0] === 'bash').length;
    expect(probes).toBe(3);
    expect(r.readyAfterMs).not.toBeNull();
  });

  it('refuses to drive when readiness never arrives, and attributes nothing', () => {
    // `not-ready` is a third outcome, not a failure of the diff: nothing ran,
    // so nothing observed is evidence either way.
    const h = harness({ readyAfter: Number.MAX_SAFE_INTEGER });
    const r = runDrive({
      script: 'true',
      cwd: '/tmp',
      ready: 'false',
      readyTimeout: 0,
      timeout: 1,
      server: 't2',
      exec: h.exec,
    });
    expect(r.outcome).toBe('not-ready');
    expect(r.observed).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.note).toContain('nothing was driven');
    expect(h.log.some((l) => l[2] === 'new-session')).toBe(false);
  });
});

describe('cleanup', () => {
  it('kills a stale server BEFORE starting, and says it did', () => {
    // Inheriting another run's server means capturing another program's pane —
    // the one way this command could report an observation of the wrong thing.
    const h = harness({});
    const r = runDrive({
      script: 'true',
      cwd: '/tmp',
      readyTimeout: 1,
      timeout: 0,
      server: 't3',
      exec: h.exec,
    });
    const kills = h.log.filter((l) => l.includes('kill-server'));
    expect(kills.length).toBeGreaterThanOrEqual(2); // before and after
    expect(h.log.findIndex((l) => l.includes('kill-server'))).toBeLessThan(
      h.log.findIndex((l) => l.includes('new-session')),
    );
    expect(r.killedStale).toBe(true);
  });

  it('kills the server even when the drive never finishes', () => {
    // The 87% who cleaned up by hand are the 87% who remembered.
    const h = harness({});
    const r = runDrive({
      script: 'sleep 999',
      cwd: '/tmp',
      readyTimeout: 1,
      timeout: 0,
      server: 't4',
      exec: h.exec,
    });
    expect(r.outcome).toBe('timed-out');
    expect(
      h.log.filter((l) => l.includes('kill-server')).length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('the environment gate', () => {
  it('reports `unavailable`, not a finding, when tmux is missing', () => {
    const h = harness({ tmuxAvailable: false });
    const r = runDrive({
      script: 'true',
      cwd: '/tmp',
      readyTimeout: 1,
      timeout: 1,
      server: 't5',
      exec: h.exec,
    });
    expect(r.outcome).toBe('unavailable');
    expect(r.observed).toBe(false);
    expect(r.note).toContain('not a finding about the diff');
  });

  it('reports `unavailable` when the session will not start', () => {
    const h = harness({ sessionStarts: false });
    const r = runDrive({
      script: 'true',
      cwd: '/tmp',
      readyTimeout: 1,
      timeout: 1,
      server: 't6',
      exec: h.exec,
    });
    expect(r.outcome).toBe('unavailable');
    expect(r.note).toContain('not a finding');
  });
});

describe('a partial observation is never presented as a whole one', () => {
  it('a timed-out drive sets observed=false and says the capture is partial', () => {
    const h = harness({});
    const r = runDrive({
      script: 'sleep 999',
      cwd: '/tmp',
      readyTimeout: 1,
      timeout: 0,
      server: 't7',
      exec: h.exec,
    });
    expect(r.observed).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.note).toContain('PARTIAL');
    expect(r.note).toContain('not evidence that the run produced nothing');
  });
});
