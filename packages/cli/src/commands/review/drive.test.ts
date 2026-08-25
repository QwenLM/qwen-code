/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Three facts this command exists to make deterministic, and one it must never
// fake. The measurements behind them, from 260 maintainer-verification
// sessions: 81% waited with `sleep`, 74% captured one screenful with no way to
// know the command had finished, 87% cleaned up by hand.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runDrive,
  wrapScript,
  sentinelExitCode,
  trimCapture,
  shellQuote,
  driveCommand,
  DRIVE_SENTINEL,
  parseCaptureSpecs,
  extractCaptures,
  type ExecResult,
} from './drive.js';
import { BRIEFS } from './lib/agent-briefs.js';
import {
  writeStdoutLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';
import { reviewSourceRoots, reviewSourcesDigest } from './lib/stale-bundle.js';
import {
  FOREIGN_DIGEST,
  makeStaleBundleFixture,
  stampDigest,
} from './lib/test-utils.js';

// The handler's output goes through the same helpers the parse-args suite
// mocks; the wiring tests below intercept them so no real terminal is touched.
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
  writeStderrLineSafe: vi.fn(),
}));

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

/**
 * The fake tmux lifecycle shared by every test that fakes a drive:
 * `new-session` writes the drive log, then — unless the run must not
 * finish — the sentinel file. The protocol (log name, sentinel path,
 * sentinel line format) lives in ONE place, so a change to it cannot
 * leave a copy still modelling the old shape while passing.
 */
function driveExec(opts: {
  server: string;
  logText: string;
  finish?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'drv-cap-'));
  const logPath = join(dir, 'drive.log');
  const workDir = join(tmpdir(), `qwen-review-drive-${opts.server}`);
  const exec = (cmd: string, args: string[]): ExecResult => {
    if (cmd === 'tmux' && args[0] === '-V') return ok();
    if (cmd === 'tmux' && args[2] === 'new-session') {
      writeFileSync(logPath, opts.logText);
      if (opts.finish !== false) {
        mkdirSync(workDir, { recursive: true });
        writeFileSync(join(workDir, 'drive.rc'), `${DRIVE_SENTINEL} rc=0\n`);
      }
      return ok();
    }
    return ok();
  };
  return { dir, logPath, workDir, exec };
}

/** A full runDrive against a faked tmux lifecycle that writes `logText`. */
function driveWithLog(
  logText: string,
  opts: { server: string; capture?: string[]; finish?: boolean },
) {
  const { dir, logPath, workDir, exec } = driveExec({
    server: opts.server,
    logText,
    finish: opts.finish,
  });
  const report = runDrive({
    script: 'drive it',
    cwd: dir,
    readyTimeout: 1,
    timeout: opts.finish === false ? 0 : 30,
    server: opts.server,
    capture: opts.capture,
    exec,
    logPath,
  });
  rmSync(dir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  return report;
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

describe.skipIf(process.platform === 'win32')(
  'the wrapper, driven for real',
  () => {
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
  },
);

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

describe('--capture', () => {
  // The address a service BOUND is not the address it was asked for. `qwen
  // serve` handed a taken port prints `port 8931 is in use, trying 8932...`
  // and listens on the next one; a caller that keeps addressing 8931 reads a
  // different, stale process for the rest of the run while the drive completes
  // and looks clean. These pin the one thing that makes that detectable: the
  // value in the report came out of this run's own output.

  it('reports the address the service bound, not the one it was asked for', () => {
    const r = driveWithLog(
      [
        'port 8931 is in use, trying 8932...',
        'qwen serve listening on http://127.0.0.1:8932',
        'ready',
      ].join('\n'),
      {
        server: 'cap1',
        capture: ['baseUrl=listening on (http://\\S+)'],
      },
    );
    expect(r.outcome).toBe('completed');
    expect(r.captured).toEqual({ baseUrl: 'http://127.0.0.1:8932' });
    // The requested port appears in the log too; the capture must not be it.
    expect(r.captured?.['baseUrl']).not.toContain('8931');
  });

  it('reads the UNTRIMMED log, so a value printed at startup survives a noisy run', () => {
    // `trimCapture` keeps the TAIL, and the line a service prints when it binds
    // is at the HEAD. Capturing from the report's `output` would lose exactly
    // the value this flag exists for — on the loudest runs, which are the ones
    // most likely to need it.
    const head = 'listening on http://127.0.0.1:8432\n';
    const r = driveWithLog(head + 'x'.repeat(400_000), {
      server: 'cap2',
      capture: ['baseUrl=listening on (http://\\S+)'],
    });
    expect(r.truncated).toBe(true);
    expect(r.output).not.toContain('listening on');
    expect(r.captured).toEqual({ baseUrl: 'http://127.0.0.1:8432' });
  });

  it('names an unmatched pattern in the note instead of reporting a blank', () => {
    // null, never ''. A service that did not print what it was expected to
    // print is a different fact from one that printed nothing, and the note
    // has to say WHICH value a witness is about to quote by assumption.
    const r = driveWithLog('started, but quietly\n', {
      server: 'cap3',
      capture: ['baseUrl=listening on (http://\\S+)', 'pid=pid=(\\d+)'],
    });
    expect(r.captured).toEqual({ baseUrl: null, pid: null });
    expect(r.note).toContain('"baseUrl"');
    expect(r.note).toContain('"pid"');
    expect(r.note).toContain('addressed by assumption');
  });

  it('phrases a miss neutrally when the pattern matched but its group did not', () => {
    // "no output matched" is falsified by a declared group that did not
    // participate: the pattern's text IS present in the log, and a reader
    // grepping for it would blame the extraction instead of the pattern.
    const r = driveWithLog('b\n', {
      server: 'cap7',
      capture: ['v=(?:a(x))?b'],
    });
    expect(r.captured).toEqual({ v: null });
    expect(r.note).toContain('produced no value for "v"');
    expect(r.note).toContain(
      'the pattern never matched, or its group did not participate',
    );
    expect(r.note).not.toContain('no output matched');
  });

  it('captures on a drive that did NOT finish', () => {
    // A timed-out drive still bound its port, and that address is often what
    // explains where the rest of it went.
    const r = driveWithLog('listening on http://127.0.0.1:9001\n', {
      server: 'cap4',
      capture: ['baseUrl=listening on (http://\\S+)'],
      finish: false,
    });
    expect(r.observed).toBe(false);
    expect(r.captured).toEqual({ baseUrl: 'http://127.0.0.1:9001' });
  });

  it('omits the field entirely when nothing was asked for', () => {
    // An empty object would claim a result set; a drive that asked for nothing
    // has none.
    const r = driveWithLog('anything\n', { server: 'cap5' });
    expect(r.captured).toBeUndefined();
    expect(r.note).not.toContain('--capture');
  });

  it('refuses a malformed pattern before starting anything', () => {
    // Discovering it after a 300-second drive costs the drive. `tmux -V` is
    // the first thing runDrive would otherwise touch, so its absence from the
    // log is the proof that nothing was started.
    const seen: string[][] = [];
    const exec = (cmd: string, args: string[]): ExecResult => {
      seen.push([cmd, ...args]);
      return ok();
    };
    const r = runDrive({
      script: 's',
      cwd: '/tmp',
      readyTimeout: 1,
      timeout: 1,
      server: 'cap6',
      capture: ['baseUrl=[unclosed'],
      exec,
    });
    expect(r.outcome).toBe('unavailable');
    expect(r.note).toContain('not a valid regular expression');
    expect(r.note).toContain('Nothing was started.');
    expect(seen).toEqual([]);
  });

  it('rejects the whole set rather than dropping the bad entry', () => {
    // A silently dropped capture reports the others beside a missing key,
    // which reads as "the service never printed it" — the one meaning null is
    // reserved for.
    const bad = parseCaptureSpecs(['ok=a', '9bad=b']);
    expect('error' in bad).toBe(true);
    expect(parseCaptureSpecs(['a=x', 'a=y'])).toHaveProperty('error');
    expect(parseCaptureSpecs(['noequals'])).toHaveProperty('error');
    expect(parseCaptureSpecs(['empty='])).toHaveProperty('error');
    expect(
      parseCaptureSpecs(Array.from({ length: 9 }, (_, i) => `n${i}=x`)),
    ).toHaveProperty('error');
  });

  it('refuses a bare --capture — an empty ask must not pass as no ask', () => {
    // A bare flag or an empty array expansion parses to [], and without a
    // rejection the drive runs to its timeout and reports identically to
    // never having asked — the one malformed shape that would escape the
    // rejects-rather-than-skips rule.
    expect(parseCaptureSpecs([])).toHaveProperty('error');
    expect(parseCaptureSpecs(undefined)).toEqual({ specs: [] });
  });

  it('holds the length caps at their documented boundary', () => {
    // "A pattern of 1 to 200 characters" existed only in prose: deleting the
    // cap check survives the rest of this suite (mutation-verified).
    expect('specs' in parseCaptureSpecs(['p=' + 'x'.repeat(200)])).toBe(true);
    expect(parseCaptureSpecs(['p=' + 'x'.repeat(201)])).toHaveProperty('error');
    expect('specs' in parseCaptureSpecs([`n${'a'.repeat(31)}=x`])).toBe(true);
    expect(parseCaptureSpecs([`n${'a'.repeat(32)}=x`])).toHaveProperty('error');
  });

  it('splits on the first = only, so a pattern may hold its own', () => {
    const parsed = parseCaptureSpecs(['port=listening=(\\d+)']);
    expect('specs' in parsed).toBe(true);
    if (!('specs' in parsed)) throw new Error('unreachable');
    expect(parsed.specs[0].name).toBe('port');
    expect(parsed.specs[0].re.source).toBe('listening=(\\d+)');
  });

  it('prefers group 1, falls back to the whole match', () => {
    const grouped = parseCaptureSpecs(['a=on (\\d+)']);
    const whole = parseCaptureSpecs(['a=on \\d+']);
    if (!('specs' in grouped) || !('specs' in whole))
      throw new Error('unreachable');
    expect(extractCaptures('on 42', grouped.specs)).toEqual({ a: '42' });
    expect(extractCaptures('on 42', whole.specs)).toEqual({ a: 'on 42' });
    expect(extractCaptures('nothing', grouped.specs)).toEqual({ a: null });
  });

  it('reads the FIRST match when a log holds several', () => {
    // The sentinel takes the LAST occurrence because its decoys come from the
    // driven script's own text; the value this flag exists for is printed
    // once, at startup. Two occurrences are not exotic — a wrapper echoing
    // the startup line, or a script that restarts the service — and the
    // last-match mutant passes the rest of this suite (mutation-verified).
    const parsed = parseCaptureSpecs(['baseUrl=listening on (http://\\S+)']);
    if (!('specs' in parsed)) throw new Error('unreachable');
    expect(
      extractCaptures(
        'listening on http://127.0.0.1:1\nlistening on http://127.0.0.1:2\n',
        parsed.specs,
      ),
    ).toEqual({ baseUrl: 'http://127.0.0.1:1' });
  });

  it("keeps an empty group-1 as '' — a printed empty value is a measurement", () => {
    // The ?? is what distinguishes it from null: the || mutant turns an
    // empty group-1 into the whole match and passes the rest of this suite
    // (mutation-verified).
    const parsed = parseCaptureSpecs(['v=value: (.*)']);
    if (!('specs' in parsed)) throw new Error('unreachable');
    expect(extractCaptures('value: ', parsed.specs)).toEqual({ v: '' });
  });

  it('caps each captured VALUE — the one channel no other cap covers', () => {
    // Extraction reads the UNTRIMMED log before trimCapture, so one group
    // could otherwise carry megabytes into the report — written to BOTH
    // stdout and the --out file — and the brief tells agents to quote
    // captured values in the witness.
    const parsed = parseCaptureSpecs(['data=data=(.*)']);
    if (!('specs' in parsed)) throw new Error('unreachable');
    const out = extractCaptures(`data=${'d'.repeat(1_000_000)}`, parsed.specs);
    const v = out['data'] as string;
    expect(v.length).toBeLessThan(10_000);
    expect(v.startsWith('d'.repeat(4096))).toBe(true);
    expect(v).toContain('[truncated, 1000000 characters total]');
  });
});

describe('--capture: the invariants the docblocks claim', () => {
  const specsOf = (entries: string[]) => {
    const parsed = parseCaptureSpecs(entries);
    if (!('specs' in parsed))
      throw new Error(`unexpected error: ${parsed.error}`);
    return parsed.specs;
  };

  it('a declared group the match left unfilled is null, not the whole match', () => {
    // `m[1] ?? m[0]` reads as "group 1, or else the match", and for an OPTIONAL
    // group that is a silent substitution: the caller asked what `x` matched
    // and would receive the whole match under the same name, with nothing in
    // the report saying a different question had been answered.
    expect(extractCaptures('b', specsOf(['v=(?:a(x))?b']))).toEqual({
      v: null,
    });
    // ...while a pattern that declares NO group still yields the whole match.
    expect(extractCaptures('b', specsOf(['v=(?:ax)?b']))).toEqual({ v: 'b' });
  });

  it('keeps an empty capture as "", which is a measurement, not an absence', () => {
    // The two are different claims and the report must not merge them: `null`
    // is "nothing was captured", `''` is "the group captured zero characters".
    expect(extractCaptures('pid=abc', specsOf(['pid=pid=(\\d*)']))).toEqual({
      pid: '',
    });
    expect(extractCaptures('pid=abc', specsOf(['pid=pid=(\\d+)']))).toEqual({
      pid: null,
    });
  });

  it('takes the FIRST match, so a restart later in the log cannot rewrite it', () => {
    // Every other capture test has exactly one occurrence, where first and last
    // are the same value — which pins nothing about the rule the docblock
    // states. This one differs on purpose.
    const log = [
      'listening on http://127.0.0.1:8932',
      'restarting',
      'listening on http://127.0.0.1:9999',
    ].join('\n');
    expect(extractCaptures(log, specsOf(['u=listening on (\\S+)']))).toEqual({
      u: 'http://127.0.0.1:8932',
    });
  });

  it('rejects a pattern past the length cap, not just an empty one', () => {
    // The cap's lower bound was pinned and its upper bound was not, so the
    // number could drift to anything without a test noticing.
    expect(parseCaptureSpecs([`v=${'a'.repeat(200)}`])).toHaveProperty('specs');
    expect(parseCaptureSpecs([`v=${'a'.repeat(201)}`])).toHaveProperty('error');
  });
});

describe('--capture and the head-trim are reconciled in the note', () => {
  it('says captures survive the trim, for the matched and the missed alike', () => {
    // Without this the report reads as a self-contradiction: "early output is
    // missing" sits directly beside a value that came OUT of the missing head,
    // and beside a null the reader would reasonably blame the trim for.
    const r = driveWithLog(
      `listening on http://127.0.0.1:8432\n${'x'.repeat(400_000)}`,
      {
        server: 'trim1',
        capture: ['baseUrl=listening on (\\S+)', 'pid=pid=(\\d+)'],
      },
    );

    expect(r.truncated).toBe(true);
    expect(r.captured).toEqual({
      baseUrl: 'http://127.0.0.1:8432',
      pid: null,
    });
    // the trim clause, the reconciliation, and the named miss — in that order
    expect(r.note).toContain('trimmed at the head');
    expect(r.note).toContain('--capture reads the untrimmed log');
    expect(r.note).toContain('"pid"');
    expect(r.note.indexOf('trimmed at the head')).toBeLessThan(
      r.note.indexOf('--capture reads the untrimmed log'),
    );
    expect(r.note.indexOf('--capture reads the untrimmed log')).toBeLessThan(
      r.note.indexOf('"pid"'),
    );
  });

  it('scopes the reconciliation to completed drives', () => {
    // The clause points at "the head-trim above" — emitted only in the
    // completed note — and claims "the whole run". An overflowed drive was
    // stopped at the log cap, so extraction never saw past it and a null
    // there is NOT a miss against the whole run; the clause must not fire.
    const r = driveWithLog('x'.repeat(9 * 1024 * 1024), {
      server: 'trim3',
      capture: ['baseUrl=listening on (\\S+)'],
      finish: false,
    });
    expect(r.outcome).toBe('overflowed');
    expect(r.truncated).toBe(true);
    expect(r.captured).toEqual({ baseUrl: null });
    expect(r.note).not.toContain('--capture reads the untrimmed log');
  });

  it('stays silent on a timed-out drive too', () => {
    // The run had not ended either, so the same two claims do not hold.
    const r = driveWithLog(
      `listening on http://127.0.0.1:9001\n${'x'.repeat(400_000)}`,
      {
        server: 'trim4',
        capture: ['baseUrl=listening on (\\S+)'],
        finish: false,
      },
    );
    expect(r.outcome).toBe('timed-out');
    expect(r.truncated).toBe(true);
    expect(r.note).not.toContain('--capture reads the untrimmed log');
  });

  it('adds no reconciliation when nothing was trimmed', () => {
    // The clause is scoped to the case it explains; a short log gets no
    // sentence about a trim that did not happen.
    const r = runDrive({
      script: 's',
      cwd: '/tmp',
      readyTimeout: 1,
      timeout: 0,
      server: 'trim2',
      capture: ['v=nope'],
      exec: harness({}).exec,
    });
    expect(r.truncated).toBe(false);
    expect(r.note).not.toContain('--capture reads the untrimmed log');
  });
});

describe("the verify brief's bound-address recipe actually captures", () => {
  // The recipe is what agents copy, and a recipe that cannot work is worse
  // than none: measured on the first version of it, the service was redirected
  // to a file of its own, so `captured.baseUrl` came back null on every
  // faithful run while the miss note said the value "was never measured".
  //
  // So this runs the brief's OWN text rather than a retyped copy — the script
  // body and the capture pattern are both extracted from it — under the same
  // redirect contract runDrive imposes (`bash <script> > <log> 2>&1`). No tmux
  // is involved: what broke was the shell, and the shell is what this drives.
  const briefText = () =>
    Object.values(BRIEFS.verify)
      .filter((v): v is string => typeof v === 'string')
      .join('\n\n');

  const recipe = () => {
    const text = briefText();
    const start = text.indexOf("--capture 'baseUrl=");
    expect(start).toBeGreaterThan(-1);
    const fence = text.indexOf('```', start);
    const body = text.slice(text.lastIndexOf('```bash', start), fence);
    const pattern = /--capture '([^']+)'/.exec(body)?.[1];
    const script = /--script '([\s\S]*?)'\s*$/m.exec(body)?.[1];
    // If either is missing the brief no longer teaches the recipe at all,
    // which is a change this test exists to make somebody notice.
    expect(pattern).toBeTruthy();
    expect(script).toBeTruthy();
    return { pattern: pattern as string, script: script as string };
  };

  const have = (bin: string) =>
    spawnSync('sh', ['-lc', `command -v ${bin}`]).status === 0;

  it.skipIf(!have('curl') || !have('mktemp'))(
    "puts the service's own address in the drive log, not the response body",
    async () => {
      const { pattern, script } = recipe();
      const dir = mkdtempSync(join(tmpdir(), 'drv-recipe-'));
      // A service whose RESPONSE BODY also carries a listening-on line: if the
      // capture came from the request rather than the service, this is the
      // address it would report, and the assertion below would catch it.
      const svc = join(dir, 'svc.mjs');
      writeFileSync(
        svc,
        [
          "import http from 'node:http';",
          "const s=http.createServer((_q,r)=>{r.writeHead(200);r.end('listening on http://127.0.0.1:59999\\n')});",
          "s.listen(0,'127.0.0.1',()=>console.log(`svc listening on http://127.0.0.1:${s.address().port}`));",
          'setTimeout(()=>process.exit(0),5000);',
        ].join('\n'),
      );

      const filled = script
        .replace(
          '<start the service; --port 0 wherever it allows one>',
          `${JSON.stringify(process.execPath)} ${JSON.stringify(svc)}`,
        )
        .replace('<the endpoint the claim is about>', 'whatever');
      const scriptPath = join(dir, 'recipe.sh');
      writeFileSync(scriptPath, filled);
      const logPath = join(dir, 'drive.log');

      // Exactly what runDrive does with the script it is given.
      const ran = spawnSync(
        'bash',
        ['-lc', `bash ${shellQuote(scriptPath)} > ${shellQuote(logPath)} 2>&1`],
        { cwd: dir, timeout: 30_000, encoding: 'utf8' },
      );
      // Thrown rather than asserted so the shell's own stderr reaches the
      // failure message — a recipe that dies takes its reason with it.
      if (ran.status !== 0) {
        throw new Error(`the recipe exited ${ran.status}: ${ran.stderr}`);
      }

      // `pattern` already carries its `name=` prefix, straight from the brief.
      const parsed = parseCaptureSpecs([pattern]);
      if (!('specs' in parsed)) throw new Error(parsed.error);
      const captured = extractCaptures(
        readFileSync(logPath, 'utf8'),
        parsed.specs,
      );

      // The whole point: a value, and the SERVICE's value.
      expect(captured['baseUrl']).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(captured['baseUrl']).not.toContain('59999');
      // ...and the recipe left nothing behind in the working directory.
      expect(
        readdirSync(dir).filter((f) => f.endsWith('.log') && f !== 'drive.log'),
      ).toEqual([]);

      // On Windows the backgrounded service keeps the working directory
      // busy (EBUSY) until its self-exit timer fires; retry the removal
      // until the handle is released.
      for (let attempt = 0; ; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch (error) {
          if (attempt >= 40) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    },
  );
});

describe('--capture reaches runDrive through the real CLI seam', () => {
  // The handler casts `argv as unknown as DriveArgs`, which type-checks
  // whatever the option is called. Rename `DriveArgs.capture` — or the yargs
  // option — and `--capture` silently stops working end to end while every
  // runDrive test above stays green and tsc exits 0. This drives the real
  // builder with a real flag string and asserts the value lands in the report
  // the handler prints.
  it('parses the flag and the captured value reaches the printed report', async () => {
    const { default: yargs } = await import('yargs');
    const { dir, logPath, workDir, exec } = driveExec({
      server: 'seam1',
      logText: 'listening on http://127.0.0.1:8932\n',
    });

    const argv = (
      yargs([
        'drive',
        '--script',
        'true',
        '--cwd',
        dir,
        '--server',
        'seam1',
        '--capture',
        'baseUrl=listening on (\\S+)',
      ]).command({
        ...driveCommand,
        handler: () => {},
      }) as unknown as { parseSync: () => Record<string, unknown> }
    ).parseSync();

    // The flag string reached the option name the handler reads.
    expect(argv['capture']).toEqual(['baseUrl=listening on (\\S+)']);

    vi.mocked(writeStdoutLine).mockClear();
    const originalExit = process.exitCode;
    try {
      (driveCommand.handler as (a: unknown) => void)({
        ...argv,
        readyTimeout: 1,
        timeout: 30,
        exec,
        logPath,
      });
    } finally {
      process.exitCode = originalExit;
      rmSync(dir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }

    const printed = vi.mocked(writeStdoutLine).mock.calls.at(-1)?.[0] as string;
    expect(JSON.parse(printed).captured).toEqual({
      baseUrl: 'http://127.0.0.1:8932',
    });
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

describe('drive warns when the bundle is not built from these sources', () => {
  // The wiring is what is under test: the notice derives from
  // `process.argv[1]` and leaves through `writeStderrLineSafe` BEFORE
  // `runDrive` runs — a missing seam there would ship while every `runDrive`
  // test above stayed green. tmux is gated off through the exec seam, so the
  // drive itself goes nowhere and nothing real is spawned.
  let repo: string;
  let argv1: string;

  const exec = (cmd: string, args: string[]): ExecResult =>
    cmd === 'tmux' && args[0] === '-V'
      ? { status: 1, stdout: '', stderr: '' }
      : { status: 0, stdout: '', stderr: '' };

  // Real bindings by construction: this file never mocks `node:fs`.
  const realFs = { mkdtempSync, mkdirSync, writeFileSync };

  beforeEach(() => {
    ({ repo, argv1 } = makeStaleBundleFixture(realFs, 'drive-stale-'));
    vi.mocked(writeStderrLineSafe).mockClear();
    vi.mocked(writeStdoutLine).mockClear();
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const stamp = (digest: string) => stampDigest(realFs, repo, digest);
  const run = () => {
    const originalArgv = process.argv[1];
    const originalExit = process.exitCode;
    process.argv[1] = argv1;
    try {
      (driveCommand.handler as (a: unknown) => void)({
        script: 'true',
        cwd: repo,
        readyTimeout: 1,
        timeout: 1,
        server: 'wiring',
        exec,
        _: ['review', 'drive'],
      });
    } finally {
      process.argv[1] = originalArgv;
      process.exitCode = originalExit;
    }
  };

  it('warns when the stamp does not match the sources', () => {
    stamp(FOREIGN_DIGEST);
    run();
    expect(vi.mocked(writeStderrLineSafe).mock.calls[0]?.[0]).toContain(
      'NOT built from the review sources',
    );
    // …and BEFORE the first result: relocating the loop below `runDrive`
    // keeps every substring assertion green while the warning lands only once
    // the reviewer has already consumed results measured from the stale
    // bundle — the failure mode this check exists to prevent.
    expect(
      vi.mocked(writeStderrLineSafe).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(writeStdoutLine).mock.invocationCallOrder[0]);
  });

  it('says nothing when the stamp matches', () => {
    stamp(reviewSourcesDigest(repo, reviewSourceRoots(repo))!);
    run();
    expect(writeStderrLineSafe).not.toHaveBeenCalled();
  });

  it('says it could not check when sources exist but the stamp does not', () => {
    // The brief unmeasured form: the state of every existing checkout the
    // day this ships — sources on disk, no stamp beside the bundle yet.
    run();
    const line = vi.mocked(writeStderrLineSafe).mock.calls[0]?.[0] as string;
    expect(line).toContain('could not check whether the bundle is current');
    expect(line).toContain('Rebuild with `npm run bundle` to record one.');
  });

  it('prints the one-line form — the full paragraph belongs to parse-args', () => {
    // One review can invoke `drive` many times, and each invocation prints
    // into an agent's tool output; the repeat keeps the trigger and the
    // remedy and drops the explanation.
    stamp(FOREIGN_DIGEST);
    run();
    const line = vi.mocked(writeStderrLineSafe).mock.calls[0]?.[0] as string;
    expect(line).toContain('NOT built from the review sources');
    expect(line).toContain('npm run bundle');
    expect(line).not.toContain('runs the BUILT bundle, not the working tree');
  });

  it('still drives — the notice is a diagnostic, not a gate', () => {
    stamp(FOREIGN_DIGEST);
    run();
    expect(writeStdoutLine).toHaveBeenCalled();
  });
});
