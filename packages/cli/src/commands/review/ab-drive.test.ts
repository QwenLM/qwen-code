/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// What makes an A/B's difference evidence is exactly what these tests pin:
// same bytes on both arms (one script, digested and pinned to those bytes),
// two DISTINCT trees whose identity is re-checked at use, a shared upstream
// owned end to end — bail paths included, liveness read from the session and
// the sentinel together — and an `observed` gate that goes false the moment a
// difference could be the harness's. The asymmetric fixtures (one arm fails,
// only one arm's upstream dies, one capture trimmed) are here because the
// gate is a conjunction, and `&&` vs `||` only differ on the asymmetric
// inputs no symmetric fixture ever produces.

import { describe, it, expect, vi, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { abDriveCommand, runAbDrive, type AbDriveArgs } from './ab-drive.js';
import { DRIVE_SENTINEL, LOG_MAX_BYTES, type ExecResult } from './drive.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStdoutLineSafe: vi.fn(),
  writeStderrLine: vi.fn(),
  writeStderrLineSafe: vi.fn(),
}));

// Every fixture path this suite creates, removed at the end — a suite that
// leaks a directory per test grows /tmp without bound across local runs and
// CI shards.
const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });
const fail = (stderr = ''): ExecResult => ({ status: 1, stdout: '', stderr });

function baseArgs(overrides: Partial<AbDriveArgs>): AbDriveArgs {
  return {
    script: 'true',
    // Two distinct trees on purpose — the command refuses a self-comparison.
    armA: tempDir('ab-arm-a-'),
    armB: tempDir('ab-arm-b-'),
    readyTimeout: 1,
    timeout: 1,
    sharedReadyTimeout: 1,
    sharedOnce: false,
    server: `t-${process.pid}`,
    ...overrides,
  };
}

/**
 * A fake tmux + shell that plays the run's own file protocol back at it. The
 * per-phase directories are mkdtemp'd by the code under test, so the harness
 * learns each phase's sentinel/log paths the only honest way: by parsing the
 * shell line the session was started with. "This session completed" is faked
 * by writing the sentinel file, "this script hangs" by withholding it, "this
 * upstream died at birth" by writing the SHARED sentinel, and "this upstream
 * was SIGKILLed / exec'd away" by failing `has-session` while writing no
 * sentinel at all. Probes are matched by a marker substring plus the AB_ARM
 * the poll command exports, so one harness can fail exactly one arm's probe.
 */
function harness(opts: {
  server: string;
  tmuxAvailable?: boolean;
  /** Shared sessions that die at birth: true = all of them, or a name list. */
  deadShared?: boolean | string[];
  /** Sessions whose `has-session` probe fails (SIGKILL / exec'd daemon). */
  vanishedSessions?: string[];
  /** Sessions whose `new-session` fails outright. */
  failSessions?: string[];
  /** Probes that fail: matched by marker substring, optionally per arm. */
  failProbes?: Array<{ marker: string; arm?: 'a' | 'b' }>;
  /** Arm sessions whose sentinel never appears — a script that hangs. */
  hang?: string[];
  /** Per-session exit code written into the fake sentinel (default 0). */
  rcBySession?: Record<string, number>;
  /** Per-session log content (default `${name} output\n`). */
  logBySession?: Record<string, string>;
  /** Called when a session starts — the TOCTOU hook. */
  onSession?: (name: string) => void;
}) {
  const log: string[][] = [];
  const bashCmds: string[] = [];
  const sharedDies = (name: string) =>
    opts.deadShared === true ||
    (Array.isArray(opts.deadShared) && opts.deadShared.includes(name));
  const exec = (cmd: string, args: string[]): ExecResult => {
    log.push([cmd, ...args]);
    if (cmd === 'tmux' && args[0] === '-V')
      return opts.tmuxAvailable === false ? fail() : ok('tmux 3.4');
    if (cmd === 'bash') {
      const probe = args[1] ?? '';
      bashCmds.push(probe);
      const arm = /AB_ARM=(a|b)/.exec(probe)?.[1];
      for (const f of opts.failProbes ?? []) {
        if (probe.includes(f.marker) && (!f.arm || f.arm === arm)) {
          return fail();
        }
      }
      return ok();
    }
    if (cmd === 'tmux' && args[2] === 'has-session') {
      return (opts.vanishedSessions ?? []).includes(args[4]) ? fail() : ok();
    }
    if (cmd === 'tmux' && args[2] === 'new-session') {
      const name = args[5];
      if ((opts.failSessions ?? []).includes(name)) return fail('no server');
      // The phase dir is mkdtemp'd by the code under test; recover the
      // sentinel/log paths from the shell line itself.
      const shellLine = args[args.length - 1];
      const m = /bash '([^']+)' > '([^']+)'/.exec(shellLine);
      if (m) {
        const rcPath = m[1].replace(/\.sh$/, '.rc');
        const logPath = m[2];
        const write = name.startsWith('arm-')
          ? !(opts.hang ?? []).includes(name)
          : sharedDies(name);
        if (write) {
          const rc = opts.rcBySession?.[name] ?? 0;
          writeFileSync(rcPath, `${DRIVE_SENTINEL} rc=${rc}\n`);
        }
        if (name.startsWith('arm-')) {
          writeFileSync(
            logPath,
            opts.logBySession?.[name] ?? `${name} output\n`,
          );
        }
      }
      opts.onSession?.(name);
      return ok();
    }
    return ok();
  };
  // Log rows are [cmd, ...args]: the tmux verb sits at index 3, the session
  // name at 6 (new-session) / 5 (kill-session).
  const events = () =>
    log
      .filter((l) => l[3] === 'new-session' || l[3] === 'kill-session')
      .map((l) => (l[3] === 'new-session' ? `new:${l[6]}` : `kill:${l[5]}`));
  return { exec, log, events, bashCmds };
}

describe('runAbDrive, harnessed', () => {
  it('refuses a server name it cannot safely own, starting nothing', () => {
    const h = harness({ server: 'x' });
    const r = runAbDrive(baseArgs({ server: '../../PWNED', exec: h.exec }));
    expect(r.observed).toBe(false);
    expect(r.note).toContain('restricted');
    expect(h.log).toEqual([]);
  });

  it('refuses a non-finite or non-positive time budget before starting anything', () => {
    // yargs `type:'number'` turns `--timeout abc` into NaN, and
    // `Date.now() >= NaN` is never true — every deadline would be disabled
    // and a hung script would hang the command forever, kill-server never
    // reached. All three budgets are guarded; each entry of the validation
    // loop earns its own case, because deleting one entry leaves the other
    // two green.
    for (const bad of [NaN, Infinity, 0, -5]) {
      const h = harness({ server: 'x' });
      const r = runAbDrive(baseArgs({ timeout: bad, exec: h.exec }));
      expect(r.observed).toBe(false);
      expect(r.note).toContain('--timeout');
      expect(h.log).toEqual([]);
    }
    for (const [key, flag] of [
      ['readyTimeout', '--ready-timeout'],
      ['sharedReadyTimeout', '--shared-ready-timeout'],
    ] as const) {
      const h = harness({ server: 'x' });
      const r = runAbDrive(baseArgs({ [key]: NaN, exec: h.exec }));
      expect(r.note).toContain(flag);
      expect(h.log).toEqual([]);
    }
  });

  it('reports the environment gap when tmux is absent', () => {
    const h = harness({ server: 't', tmuxAvailable: false });
    const r = runAbDrive(baseArgs({ exec: h.exec }));
    expect(r.observed).toBe(false);
    expect(r.note).toContain('tmux is not available');
  });

  it('names the missing arm instead of driving what does not exist', () => {
    const h = harness({ server: 't' });
    const r = runAbDrive(
      baseArgs({ armB: '/nope/never/exists', exec: h.exec }),
    );
    expect(r.observed).toBe(false);
    expect(r.note).toContain('--arm-b');
  });

  it('refuses an arm path that exists but is not a directory', () => {
    // `tmux new-session -c <a file>` succeeds with a silent cwd fallback to
    // $HOME — the arm would report `completed` for a script that never ran
    // in its tree, and `observed: true` would license the comparison.
    const filePath = join(tempDir('ab-file-'), 'report.json');
    writeFileSync(filePath, '{}');
    const h = harness({ server: 't' });
    const r = runAbDrive(baseArgs({ armA: filePath, exec: h.exec }));
    expect(r.observed).toBe(false);
    expect(r.note).toContain('--arm-a');
    expect(r.note).toContain('not an existing directory');
    const h2 = harness({ server: 't' });
    const r2 = runAbDrive(
      baseArgs({ shared: 'daemon', sharedCwd: filePath, exec: h2.exec }),
    );
    expect(r2.note).toContain('--shared-cwd');
  });

  it('refuses the same directory passed as both arms — an A/B needs two trees', () => {
    // A copy-pasted flag runs a self-comparison and returns observed: true,
    // identicalOutput: true — "the PR changes nothing", manufactured from
    // nothing.
    const one = tempDir('ab-same-');
    const h = harness({ server: 't' });
    const r = runAbDrive(baseArgs({ armA: one, armB: one, exec: h.exec }));
    expect(r.observed).toBe(false);
    expect(r.note).toContain('same directory');
  });

  it('re-validates a tree at its use site — a root swapped mid-run is a harness fact', () => {
    // The pre-flight runs before arm a's whole drive window, and the driven
    // code is the PR's own: a root removed (tmux -c falls back to $HOME) or
    // replaced between validation and use must not have arm b attributed to
    // a tree it never ran in.
    const args = baseArgs({});
    const h = harness({
      server: args.server,
      onSession: (name) => {
        if (name === 'arm-a')
          rmSync(args.armB, { recursive: true, force: true });
      },
    });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.a?.outcome).toBe('completed');
    expect(r.b?.outcome).toBe('unavailable');
    expect(r.observed).toBe(false);
    expect(r.note).toContain('no longer resolves');
    expect(h.events()).not.toContain('new:arm-b');
  });

  it('reclaims a stale server FIRST — and reports that it did', () => {
    // A prior run SIGKILLed before its `finally` leaves a server owning the
    // fixed session names; without the leading reclaim, this run's
    // new-session collides and aborts as "an environment gap" instead of
    // self-healing. The report's `killedStale` is quoted into witnesses, so
    // its value is pinned too, not just the call's position.
    const args = baseArgs({});
    const h = harness({ server: args.server });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(h.log[0]).toEqual(['tmux', '-V']);
    expect(h.log[1]).toEqual(['tmux', '-L', args.server, 'kill-server']);
    expect(r.killedStale).toBe(true);
  });

  it('reports the environment gap when the keeper session cannot start', () => {
    const args = baseArgs({});
    const h = harness({ server: args.server, failSessions: ['hold'] });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.observed).toBe(false);
    expect(r.a).toBeNull();
    expect(r.note).toContain('could not start a session');
  });

  it('drives both arms with one script and pairs the captures', () => {
    const args = baseArgs({});
    const h = harness({ server: args.server });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.observed).toBe(true);
    expect(r.a?.outcome).toBe('completed');
    expect(r.b?.outcome).toBe('completed');
    expect(r.a?.output).toContain('arm-a output');
    expect(r.b?.output).toContain('arm-b output');
    expect(r.identicalOutput).toBe(false);
    // The digest is the same-bytes fact a witness quotes — pinned to the
    // script's actual bytes, not merely to being 64 hex characters.
    expect(r.scriptSha256).toBe(
      createHash('sha256').update('true').digest('hex'),
    );
    // Cleanup is unconditional and last — a leaked server is the next run's
    // wrong observation.
    expect(h.log.at(-1)).toEqual(['tmux', '-L', args.server, 'kill-server']);
  });

  it('carries each arm script’s own exit code — never a fabricated zero', () => {
    // The success note quotes `a: exit N`, and a verifier quotes the note;
    // an exit-code-discarding regression would write "exit 0" for a script
    // that failed with 17.
    const args = baseArgs({});
    const h = harness({
      server: args.server,
      rcBySession: { 'arm-a': 17, 'arm-b': 0 },
    });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.a?.outcome).toBe('completed');
    expect(r.a?.exitCode).toBe(17);
    expect(r.b?.exitCode).toBe(0);
    expect(r.note).toContain('a: exit 17');
  });

  it('polls the per-arm readiness probe and refuses to drive an arm that never comes up', () => {
    const args = baseArgs({ ready: 'ARMPROBE' });
    const h = harness({
      server: args.server,
      failProbes: [{ marker: 'ARMPROBE', arm: 'a' }],
    });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.a?.outcome).toBe('not-ready');
    expect(r.b?.outcome).toBe('completed');
    expect(r.observed).toBe(false);
    // The arm was never driven: no arm-a session exists in the event log.
    expect(h.events()).not.toContain('new:arm-a');
  });

  it('applies the readiness gate to arm b too — the mirrored negative', () => {
    // A mutant that skips polling when arm === 'b' would drive arm b against
    // a tree that never became ready and let bothCompleted license it.
    const args = baseArgs({ ready: 'ARMPROBE' });
    const h = harness({
      server: args.server,
      failProbes: [{ marker: 'ARMPROBE', arm: 'b' }],
    });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.a?.outcome).toBe('completed');
    expect(r.b?.outcome).toBe('not-ready');
    expect(r.observed).toBe(false);
    expect(h.events()).not.toContain('new:arm-b');
  });

  it('a timed-out arm is killed before the other arm starts — and fails the gate', () => {
    // A timed-out script is still RUNNING when observation stops; left
    // alive it contends with arm b for the same ports and files. The
    // partial capture must survive into the report — it is the repair
    // pointer the not-observed note sends the verifier to. Cleanup stays
    // unconditional on this failing path too.
    const args = baseArgs({ timeout: 1 });
    const h = harness({ server: args.server, hang: ['arm-a'] });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.a?.outcome).toBe('timed-out');
    expect(r.a?.exitCode).toBeNull();
    expect(r.a?.output).toContain('arm-a output');
    expect(r.b?.outcome).toBe('completed');
    expect(r.observed).toBe(false);
    expect(r.identicalOutput).toBeNull();
    const ev = h.events();
    expect(ev.indexOf('kill:arm-a')).toBeGreaterThan(ev.indexOf('new:arm-a'));
    expect(ev.indexOf('kill:arm-a')).toBeLessThan(ev.indexOf('new:arm-b'));
    expect(ev).toContain('kill:arm-b');
    expect(h.log.at(-1)).toEqual(['tmux', '-L', args.server, 'kill-server']);
  });

  it('the mirrored asymmetric case: arm a completes, arm b hangs', () => {
    // bothCompleted is a conjunction; dropping arm b's side must go red.
    const args = baseArgs({ timeout: 1 });
    const h = harness({ server: args.server, hang: ['arm-b'] });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.a?.outcome).toBe('completed');
    expect(r.b?.outcome).toBe('timed-out');
    expect(r.observed).toBe(false);
    expect(r.identicalOutput).toBeNull();
  });

  it('an arm whose log crosses the cap ends overflowed — no verdict, gate failed', () => {
    const args = baseArgs({ timeout: 1 });
    const h = harness({
      server: args.server,
      hang: ['arm-a'],
      logBySession: { 'arm-a': 'x'.repeat(LOG_MAX_BYTES + 1) },
    });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.a?.outcome).toBe('overflowed');
    expect(r.a?.exitCode).toBeNull();
    expect(r.observed).toBe(false);
  });

  it('per-arm mode stands the shared process up fresh for EACH arm, interleaved, torn down in place', () => {
    // The ORDER is the isolation claim: shared-a must be dead before
    // shared-b starts, or arm b binds against arm a's instance — the false
    // difference the command exists to rule out.
    const args = baseArgs({ shared: 'run-daemon', sharedReady: 'SHPROBE' });
    const h = harness({ server: args.server });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.mode).toBe('per-arm');
    expect(r.observed).toBe(true);
    expect(h.events()).toEqual([
      'new:hold',
      'new:shared-a',
      'new:arm-a',
      'kill:arm-a',
      'kill:shared-a',
      'new:shared-b',
      'new:arm-b',
      'kill:arm-b',
      'kill:shared-b',
    ]);
  });

  it('per-arm shared-ready failure bails THAT arm — tearing its instance down — and still drives the other', () => {
    // Half an A/B is not evidence, but the other half's capture is the
    // repair pointer; and the bailed arm's shared instance must not outlive
    // the bail, or it holds its port through arm b's whole window.
    const args = baseArgs({ shared: 'run-daemon', sharedReady: 'SHPROBE' });
    const h = harness({
      server: args.server,
      failProbes: [{ marker: 'SHPROBE', arm: 'a' }],
    });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.a?.outcome).toBe('not-ready');
    expect(r.b?.outcome).toBe('completed');
    expect(r.observed).toBe(false);
    const ev = h.events();
    expect(ev.indexOf('kill:shared-a')).toBeGreaterThan(-1);
    expect(ev.indexOf('kill:shared-a')).toBeLessThan(
      ev.indexOf('new:shared-b'),
    );
  });

  it('a shared instance that fails to START is that arm’s loss in per-arm mode, the run’s in once mode', () => {
    // The mode split is deliberate semantics: per-arm keeps the other arm's
    // capture as the repair pointer; once mode has nothing arm b could
    // salvage and must not spend its budgets polling a nonexistent upstream.
    const perArm = baseArgs({ shared: 'run-daemon' });
    const h1 = harness({ server: perArm.server, failSessions: ['shared-a'] });
    const r1 = runAbDrive({ ...perArm, exec: h1.exec });
    expect(r1.a?.outcome).toBe('unavailable');
    expect(r1.b?.outcome).toBe('completed');
    expect(r1.observed).toBe(false);

    const once = baseArgs({ shared: 'run-daemon', sharedOnce: true });
    const h2 = harness({ server: once.server, failSessions: ['shared-a'] });
    const r2 = runAbDrive({ ...once, exec: h2.exec });
    expect(r2.a).toBeNull();
    expect(r2.b).toBeNull();
    expect(h2.events()).not.toContain('new:arm-a');
  });

  it('an arm session that fails to start is unavailable, not silently skipped', () => {
    const args = baseArgs({});
    const h = harness({ server: args.server, failSessions: ['arm-a'] });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.a?.outcome).toBe('unavailable');
    expect(r.b?.outcome).toBe('completed');
    expect(r.observed).toBe(false);
  });

  it('--shared-once starts ONE instance, on arm a, and both arms see it', () => {
    const args = baseArgs({ shared: 'run-daemon', sharedOnce: true });
    const h = harness({ server: args.server });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.mode).toBe('once');
    expect(r.observed).toBe(true);
    expect(h.events()).toEqual([
      'new:hold',
      'new:shared-a',
      'new:arm-a',
      'kill:arm-a',
      'new:arm-b',
      'kill:arm-b',
    ]);
    expect(r.a?.sharedAliveAtEnd).toBe(true);
    expect(r.b?.sharedAliveAtEnd).toBe(true);
  });

  it('a shared process that never becomes ready stops a --shared-once run outright', () => {
    const args = baseArgs({
      shared: 'run-daemon',
      sharedReady: 'SHPROBE',
      sharedOnce: true,
    });
    const h = harness({
      server: args.server,
      failProbes: [{ marker: 'SHPROBE' }],
    });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.observed).toBe(false);
    expect(r.a).toBeNull();
    expect(r.b).toBeNull();
    expect(r.note).toContain('never became ready');
    expect(h.events()).not.toContain('new:arm-a');
  });

  it('a shared process that dies before its arm finishes fails the observed gate', () => {
    const args = baseArgs({ shared: 'run-daemon' });
    const h = harness({ server: args.server, deadShared: true });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.a?.outcome).toBe('completed');
    expect(r.b?.outcome).toBe('completed');
    expect(r.a?.sharedAliveAtEnd).toBe(false);
    expect(r.observed).toBe(false);
    expect(r.note).toContain('died');
  });

  it('a SIGKILLed or exec’d upstream — no sentinel, no session — reads as dead, not alive', () => {
    // The sentinel is one-directional: its presence proves an exit, its
    // absence proves nothing (no EXIT trap fires under SIGKILL, and an
    // `exec`'d daemon replaced the shell holding the trap). Liveness must
    // require the session to still exist.
    const args = baseArgs({ shared: 'exec run-daemon' });
    const h = harness({
      server: args.server,
      vanishedSessions: ['shared-a'],
    });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.a?.outcome).toBe('completed');
    expect(r.a?.sharedAliveAtEnd).toBe(false);
    expect(r.observed).toBe(false);
  });

  it('ONE arm’s upstream dying is enough to fail the gate — the asymmetric case', () => {
    const args = baseArgs({ shared: 'run-daemon' });
    const h = harness({ server: args.server, deadShared: ['shared-b'] });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.a?.sharedAliveAtEnd).toBe(true);
    expect(r.b?.sharedAliveAtEnd).toBe(false);
    expect(r.observed).toBe(false);
  });

  it('--shared-once with a dead instance fast-fails arm b instead of driving against a corpse', () => {
    const args = baseArgs({ shared: 'run-daemon', sharedOnce: true });
    const h = harness({ server: args.server, deadShared: true });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.a?.outcome).toBe('completed');
    expect(r.a?.sharedAliveAtEnd).toBe(false);
    expect(r.b?.outcome).toBe('not-ready');
    expect(r.observed).toBe(false);
    expect(r.note).toContain('exited before arm b');
    expect(h.events()).not.toContain('new:arm-b');
  });

  it('keeps the shared probe’s cwd and its AB_ARM_ROOT split under --shared-cwd', () => {
    // The daemon runs in --shared-cwd but received the ARM's root as
    // AB_ARM_ROOT; a probe polled with the daemon's cwd and a different
    // AB_ARM_ROOT would look for the readiness file in a directory the
    // daemon never wrote.
    const sharedCwd = tempDir('ab-shcwd-');
    const args = baseArgs({
      shared: 'run-daemon',
      sharedReady: 'SHPROBE',
      sharedCwd,
    });
    const h = harness({ server: args.server });
    runAbDrive({ ...args, exec: h.exec });
    const probe = h.bashCmds.find((c) => c.includes('SHPROBE'));
    expect(probe).toBeDefined();
    expect(probe).toContain(`cd '${sharedCwd}'`);
    expect(probe).toContain(`AB_ARM_ROOT='${args.armA}'`);
  });

  it('identicalOutput is true only for identical, untrimmed captures — and null when ANY head was cut', () => {
    // Equality of two tails whose heads are gone is not equality — and the
    // guard is a conjunction over BOTH arms, so the asymmetric shape (one
    // giant capture, one tiny) is the fixture that keeps `&&` from decaying
    // to a single-arm check.
    const args = baseArgs({});
    const same = harness({
      server: args.server,
      logBySession: { 'arm-a': 'same bytes\n', 'arm-b': 'same bytes\n' },
    });
    expect(runAbDrive({ ...args, exec: same.exec }).identicalOutput).toBe(true);

    const big = `x`.repeat(200_001);
    for (const logs of [
      { 'arm-a': big, 'arm-b': big },
      { 'arm-a': big, 'arm-b': 'ten lines\n' },
      { 'arm-a': 'ten lines\n', 'arm-b': big },
    ]) {
      const h = harness({ server: args.server, logBySession: logs });
      const r = runAbDrive({ ...args, exec: h.exec });
      expect(r.identicalOutput).toBeNull();
    }
  });
});

const hasTmux = spawnSync('tmux', ['-V']).status === 0;

describe.skipIf(!hasTmux || process.platform === 'win32')(
  'runAbDrive, driven for real',
  () => {
    it('same bytes, two trees: each arm reports its own root and its own content', () => {
      const armA = tempDir('ab-real-a-');
      const armB = tempDir('ab-real-b-');
      writeFileSync(join(armA, 'marker.txt'), 'CONTENT-OF-A\n');
      writeFileSync(join(armB, 'marker.txt'), 'CONTENT-OF-B\n');
      const r = runAbDrive({
        script: 'cat marker.txt; echo "arm=$AB_ARM root=$AB_ARM_ROOT"',
        armA,
        armB,
        readyTimeout: 5,
        timeout: 30,
        sharedReadyTimeout: 5,
        sharedOnce: false,
        server: `abreal-${process.pid}`,
      });
      expect(r.observed).toBe(true);
      expect(r.a?.exitCode).toBe(0);
      expect(r.a?.output).toContain('CONTENT-OF-A');
      expect(r.a?.output).toContain('arm=a');
      expect(r.a?.output).toContain(armA);
      expect(r.b?.output).toContain('CONTENT-OF-B');
      expect(r.b?.output).toContain('arm=b');
      // AB_ARM_ROOT is one of the two documented arm-identity channels; a
      // script deriving paths from it must land in ITS tree on both arms.
      expect(r.b?.output).toContain(armB);
      expect(r.identicalOutput).toBe(false);
    });

    it('survives arm paths carrying shell metacharacters — the quoting layer is load-bearing', () => {
      const armA = join(tempDir('ab-real-q-'), "we ird'a");
      const armB = join(tempDir('ab-real-q-'), 'we irdb');
      mkdirSync(armA, { recursive: true });
      mkdirSync(armB, { recursive: true });
      writeFileSync(join(armA, 'marker.txt'), 'QA\n');
      writeFileSync(join(armB, 'marker.txt'), 'QB\n');
      const r = runAbDrive({
        script: 'cat marker.txt; echo "root=$AB_ARM_ROOT"',
        armA,
        armB,
        readyTimeout: 5,
        timeout: 30,
        sharedReadyTimeout: 5,
        sharedOnce: false,
        server: `abrealq-${process.pid}`,
      });
      expect(r.observed).toBe(true);
      expect(r.a?.output).toContain('QA');
      expect(r.a?.output).toContain(armA);
      expect(r.b?.output).toContain('QB');
    });

    it('per-arm shared: each arm reads its OWN instance, and teardown leaves nothing', () => {
      const armA = tempDir('ab-real-sa-');
      const armB = tempDir('ab-real-sb-');
      const server = `abreals-${process.pid}`;
      const r = runAbDrive({
        // The shared process writes its identity, then stays up past the arm.
        shared: 'echo "upstream-for-$AB_ARM" > up.txt; sleep 30',
        sharedReady: 'test -f up.txt',
        script: 'cat up.txt',
        armA,
        armB,
        readyTimeout: 5,
        timeout: 30,
        sharedReadyTimeout: 10,
        sharedOnce: false,
        server,
      });
      expect(r.observed).toBe(true);
      expect(r.a?.output).toContain('upstream-for-a');
      expect(r.b?.output).toContain('upstream-for-b');
      expect(r.a?.sharedAliveAtEnd).toBe(true);
      expect(r.b?.sharedAliveAtEnd).toBe(true);
      // The namespaced server is gone: a leaked one would be the next run's
      // wrong observation.
      expect(spawnSync('tmux', ['-L', server, 'ls']).status).not.toBe(0);
    });

    it('an upstream that exits at birth is a confound, not a comparison — and still cleans up', () => {
      const before = readdirSync(tmpdir()).filter((d) =>
        d.startsWith('qwen-review-ab-drive-'),
      ).length;
      const r = runAbDrive({
        shared: 'true',
        script: 'sleep 1; echo watched-nothing',
        armA: tempDir('ab-real-da-'),
        armB: tempDir('ab-real-db-'),
        readyTimeout: 5,
        timeout: 30,
        sharedReadyTimeout: 5,
        sharedOnce: false,
        server: `abreald-${process.pid}`,
      });
      expect(r.a?.outcome).toBe('completed');
      expect(r.a?.sharedAliveAtEnd).toBe(false);
      expect(r.observed).toBe(false);
      expect(r.note).toContain('died');
      // The mkdtemp'd run dir is swept on this failing path too.
      const after = readdirSync(tmpdir()).filter((d) =>
        d.startsWith('qwen-review-ab-drive-'),
      ).length;
      expect(after).toBe(before);
    });

    it('an arm path that is a FILE is refused with the directory message', () => {
      const filePath = join(tempDir('ab-real-f-'), 'plan.json');
      writeFileSync(filePath, '{}');
      const r = runAbDrive({
        script: 'true',
        armA: filePath,
        armB: tempDir('ab-real-g-'),
        readyTimeout: 5,
        timeout: 30,
        sharedReadyTimeout: 5,
        sharedOnce: false,
        server: `abrealf-${process.pid}`,
      });
      expect(r.observed).toBe(false);
      expect(r.note).toContain('not an existing directory');
      expect(statSync(filePath).isFile()).toBe(true);
    });
  },
);

describe.skipIf(!hasTmux || process.platform === 'win32')(
  'the command wiring',
  () => {
    const handlerArgs = (over: Record<string, unknown>) => ({
      script: 'cat marker.txt',
      readyTimeout: 5,
      timeout: 30,
      sharedReadyTimeout: 5,
      sharedOnce: false,
      server: `abrealw-${process.pid}`,
      ...over,
    });

    it('maps --arm-a/--arm-b onto the right arms, prints the report, and honours --out', () => {
      // The transposition mutation (armA from arm-b and vice versa) is an
      // easy copy-paste error that inverts every verdict a verifier reads
      // off the report — same-typed strings, no type error.
      const armA = tempDir('ab-wire-a-');
      const armB = tempDir('ab-wire-b-');
      writeFileSync(join(armA, 'marker.txt'), 'WIRE-A\n');
      writeFileSync(join(armB, 'marker.txt'), 'WIRE-B\n');
      const out = join(tempDir('ab-wire-out-'), 'report.json');
      process.exitCode = 0;
      (abDriveCommand.handler as (a: unknown) => void)(
        handlerArgs({ 'arm-a': armA, 'arm-b': armB, out }),
      );
      expect(process.exitCode).toBe(0);
      const printed = vi
        .mocked(writeStdoutLine)
        .mock.calls.at(-1)?.[0] as string;
      const r = JSON.parse(printed) as {
        a: { root: string; output: string };
        b: { root: string; output: string };
      };
      expect(r.a.root).toBe(armA);
      expect(r.a.output).toContain('WIRE-A');
      expect(r.b.root).toBe(armB);
      expect(r.b.output).toContain('WIRE-B');
      // --out carries the same bytes the caller saw on stdout.
      expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(
        JSON.parse(printed),
      );
    });

    it('a not-observed run exits 1; an unusable --out exits 2 before any driving', () => {
      const filePath = join(tempDir('ab-wire-f-'), 'plan.json');
      writeFileSync(filePath, '{}');
      process.exitCode = 0;
      (abDriveCommand.handler as (a: unknown) => void)(
        handlerArgs({ 'arm-a': filePath, 'arm-b': tempDir('ab-wire-g-') }),
      );
      expect(process.exitCode).toBe(1);

      // The repairable-invocation class, matching every sibling caller of
      // assertWritableOutPath — and it must fire BEFORE the arms drive.
      process.exitCode = 0;
      (abDriveCommand.handler as (a: unknown) => void)(
        handlerArgs({
          'arm-a': tempDir('ab-wire-h-'),
          'arm-b': tempDir('ab-wire-i-'),
          out: tempDir('ab-wire-dir-'),
        }),
      );
      expect(process.exitCode).toBe(2);
      process.exitCode = 0;
    });
  },
);
