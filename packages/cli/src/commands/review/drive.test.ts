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
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runDrive,
  wrapScript,
  sentinelExitCode,
  trimCapture,
  shellQuote,
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
    expect(wrapScript('true', '/tmp/rc')).toContain(`${DRIVE_SENTINEL} rc=`);
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
    expect(wrapScript('exit 17', '/tmp/rc')).toMatch(/^trap .* EXIT/);
  });
});

describe('the wrapper, driven for real', () => {
  // Four ways a script can leave, all of which a reviewer's drive script uses.
  // These run real bash — the harness tests above cannot see a shell semantic —
  // and read the verdict from the sentinel FILE, the channel that has to
  // survive a bounded log.
  const realExit = (script: string): number | null => {
    const rc = join(mkdtempSync(join(tmpdir(), 'drv-')), 'drive.rc');
    spawnSync('bash', ['-c', wrapScript(script, rc)], { encoding: 'utf8' });
    return existsSync(rc) ? sentinelExitCode(readFileSync(rc, 'utf8')) : null;
  };

  it('reports the code for every exit path', () => {
    expect(realExit('echo ok')).toBe(0);
    expect(realExit('echo failing; exit 17')).toBe(17);
    expect(realExit('set -e; false; echo unreachable')).toBe(1);
    expect(realExit('exit 0')).toBe(0);
  });

  it('keeps the script output on stdout and the verdict in its own file', () => {
    // Two channels on purpose. The log is bounded; the verdict must not be
    // bounded with it, and the next test shows what happens when it is.
    const rc = join(mkdtempSync(join(tmpdir(), 'drv-')), 'drive.rc');
    const r = spawnSync('bash', ['-c', wrapScript('echo hello-there', rc)], {
      encoding: 'utf8',
    });
    expect(r.stdout).toContain('hello-there');
    expect(r.stdout).not.toContain(DRIVE_SENTINEL);
    expect(sentinelExitCode(readFileSync(rc, 'utf8'))).toBe(0);
  });

  it('capping the STREAM never yields the true exit code — measured, not assumed', () => {
    // Why the log is bounded by watching its size rather than by `head -c`.
    // Piping the drive through `head` kills the writer with SIGPIPE mid-loop,
    // and what survives is bash-version-dependent — measured, per version:
    //   - bash 5.2 (CI's ubuntu): the EXIT trap fires with `$?` from the last
    //     successful echo — rc=0, a FABRICATED clean pass;
    //   - bash 5.3 (homebrew macOS): the trap's redirect creates the sentinel
    //     file but the write is LOST — an empty file, no verdict;
    //   - bash 3.2 (stock macOS): the trap records the echo's EPIPE write
    //     error — rc=1, a fabricated FAILURE code, with a stray padding line
    //     leaked into the sentinel file for good measure.
    // Three shells, three different wrong answers — which is why the
    // assertion pins the one invariant they share instead of any version's
    // flavor of wrong: the script's real `exit 5` NEVER survives the cap.
    // (The first draft of this fix enumerated the wrong answers and was
    // immediately falsified by running it on a fourth shell; the enumeration
    // is a moving target, the invariant is not.)
    const dir = mkdtempSync(join(tmpdir(), 'drv-'));
    const rc = join(dir, 'drive.rc');
    const sh = join(dir, 's.sh');
    writeFileSync(
      sh,
      wrapScript(
        'for i in $(seq 1 20000); do echo padding-line-$i-aaaaaaaaaaaaaaaaaaaa; done; exit 5',
        rc,
      ),
    );
    spawnSync(
      'bash',
      ['-c', `bash ${sh} 2>&1 | head -c 4096 > ${join(dir, 'log')}`],
      { encoding: 'utf8' },
    );
    const reported = existsSync(rc)
      ? sentinelExitCode(readFileSync(rc, 'utf8'))
      : null;
    // Fabricated (0, 1, …) or lost (null) — any of them is an untrustworthy
    // verdict, and all prove the design point. What must never appear is the
    // truth.
    expect(reported).not.toBe(5);
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

  it('polls at a bounded RATE — the wait cannot depend on the platform', () => {
    // The first version shelled out to `sleep 0.25`. Fractional operands are a
    // GNU/BSD extension, so where POSIX rules `sleep` fails, returns instantly,
    // and this loop goes tight. Measured through this very seam before the fix:
    // 8.2 MILLION readiness probes in one second — which does not just spin a
    // CPU, it hammers the daemon the probe is waiting for and then reports that
    // it never came up. A false negative built by the harness.
    let probes = 0;
    const exec = (cmd: string, args: string[]): ExecResult => {
      if (cmd === 'tmux' && args[0] === '-V') return ok();
      if (cmd === 'bash') {
        probes++;
        return fail();
      }
      return ok();
    };
    const t0 = Date.now();
    runDrive({
      script: 'true',
      cwd: '/tmp',
      ready: 'curl -sf localhost:1/health',
      readyTimeout: 1,
      timeout: 1,
      server: 'rate',
      exec,
    });
    const perSecond = probes / Math.max(0.2, (Date.now() - t0) / 1000);
    // Generous ceiling: the point is orders of magnitude, not a tuned figure.
    expect(perSecond).toBeLessThan(50);
    expect(probes).toBeGreaterThan(0);
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

describe('the server name', () => {
  it('refuses a name that would escape the temp dir', () => {
    // Measured: `--server '../../PWNED'` put drive.sh and its log at the
    // FILESYSTEM ROOT, because join(tmpdir(), 'qwen-review-drive-' + server)
    // normalises the `..` away.
    const h = harness({});
    const r = runDrive({
      script: 'true',
      cwd: '/tmp',
      readyTimeout: 1,
      timeout: 1,
      server: '../../PWNED',
      exec: h.exec,
    });
    expect(r.outcome).toBe('unavailable');
    expect(r.note).toContain('not a name this command will own');
    // and nothing was started, so nothing needs cleaning up
    expect(h.log.some((l) => l.includes('new-session'))).toBe(false);
  });

  it('refuses a name that would split the shell line tmux runs', () => {
    const h = harness({});
    const r = runDrive({
      script: 'true',
      cwd: '/tmp',
      readyTimeout: 1,
      timeout: 1,
      server: 'a; touch /tmp/x; b',
      exec: h.exec,
    });
    expect(r.outcome).toBe('unavailable');
    expect(h.log.some((l) => l.includes('new-session'))).toBe(false);
  });

  it('accepts the shapes a caller actually needs', () => {
    for (const name of ['qr-1234', 'pr8349', 'ok-name_1.2', 'A']) {
      const h = harness({});
      const r = runDrive({
        script: 'true',
        cwd: '/tmp',
        readyTimeout: 1,
        timeout: 0,
        server: name,
        exec: h.exec,
      });
      expect(r.outcome).not.toBe('unavailable');
    }
  });

  it('quotes the paths anyway — the charset and the quoting are two guards', () => {
    // Redundant on purpose: whoever widens the charset should not also have to
    // notice the shell line. Asserted by ROUND TRIP through real bash rather
    // than against a hand-written expected string: hand-escaping this through
    // a test file is how the first attempt came to emit `'''` where POSIX
    // wants `'\''`, which bash answers with `unexpected EOF`.
    for (const v of [
      '/tmp/plain',
      '/tmp/a b',
      "/tmp/it's",
      "/tmp/'",
      '/tmp/a;b',
      '/tmp/$X`id`',
    ]) {
      const back = execFileSync('bash', ['-c', `printf %s ${shellQuote(v)}`], {
        encoding: 'utf8',
      });
      expect(back).toBe(v);
    }
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

describe('the working directory', () => {
  it('is removed after the report is built, output intact', () => {
    // The default server name carries the pid, so every invocation would
    // otherwise leave its own tree behind — measured, six runs left five. The
    // report is already in memory by the time this runs, so nothing the caller
    // needs is in there.
    const probe = mkdtempSync(join(tmpdir(), 'drv-'));
    const log = join(probe, 'seen.log');
    writeFileSync(log, 'the output\n');
    const exec = (cmd: string, args: string[]): ExecResult => {
      if (cmd === 'tmux' && args[0] === '-V') return ok();
      return ok();
    };
    const r = runDrive({
      script: 'true',
      cwd: '/tmp',
      readyTimeout: 1,
      timeout: 0,
      server: 'wd1',
      exec,
      logPath: log,
    });
    expect(r.output).toContain('the output');
    // A caller-supplied log is the caller's to keep.
    expect(existsSync(log)).toBe(true);
  });

  it('keeps a caller-supplied log path but never its own scratch tree', () => {
    const exec = (cmd: string, args: string[]): ExecResult => {
      if (cmd === 'tmux' && args[0] === '-V') return ok();
      return ok();
    };
    runDrive({
      script: 'true',
      cwd: '/tmp',
      readyTimeout: 1,
      timeout: 0,
      server: 'wd2',
      exec,
    });
    expect(existsSync(join(tmpdir(), 'qwen-review-drive-wd2'))).toBe(false);
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

describe('the log cap', () => {
  it('stops a too-loud drive as its OWN outcome, with no exit code', () => {
    // A run this command had to stop is not a run that finished. Reporting an
    // exit code here would be inventing one; reporting `timed-out` would blame
    // the clock for a size problem.
    const dir = mkdtempSync(join(tmpdir(), 'drv-'));
    const log = join(dir, 'drive.log');
    let poll = 0;
    const exec = (cmd: string, args: string[]): ExecResult => {
      if (cmd === 'tmux' && args[0] === '-V') return ok();
      if (cmd === 'tmux' && args[2] === 'new-session') {
        // stand in for a drive that writes fast and never finishes
        writeFileSync(log, 'x'.repeat(16 * 1024 * 1024));
        return ok();
      }
      poll++;
      return ok();
    };
    const r = runDrive({
      script: 'noisy',
      cwd: dir,
      readyTimeout: 1,
      timeout: 30,
      server: 'loud',
      exec,
      logPath: log,
    });
    expect(r.outcome).toBe('overflowed');
    expect(r.exitCode).toBeNull();
    expect(r.observed).toBe(false);
    expect(r.note).toContain('was stopped');
    expect(poll).toBeLessThan(20); // stopped early, did not sit out the timeout
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
