/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// What makes an A/B's difference evidence is exactly what these tests pin:
// same bytes on both arms (one script, digested), a shared upstream that is
// owned end to end — bail paths included — and an `observed` gate that goes
// false the moment a difference could be the harness's — a dead upstream, a
// half-run, an arm that never became ready — instead of the trees'. The
// asymmetric fixtures (one arm fails, only one arm's upstream dies) are here
// because the gate is a conjunction, and `&&` vs `||` only differ on the
// asymmetric inputs no symmetric fixture ever produces.

import { describe, it, expect, vi, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAbDrive, type AbDriveArgs } from './ab-drive.js';
import { DRIVE_SENTINEL, type ExecResult } from './drive.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
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
  const arm = tempDir('ab-arm-');
  return {
    script: 'true',
    armA: arm,
    armB: arm,
    readyTimeout: 1,
    timeout: 1,
    sharedReadyTimeout: 1,
    sharedOnce: false,
    server: `t-${process.pid}`,
    ...overrides,
  };
}

/**
 * A fake tmux + shell that plays the run's own file protocol back at it: the
 * arm loop reads sentinel files from the run's temp dir, so "this session
 * completed" is faked by writing that file when the session starts, "this
 * script hangs" by withholding it, and "this upstream died at birth" by
 * writing the SHARED sentinel too. Probes are matched by a marker substring
 * the test chooses plus the AB_ARM the poll command exports, so one harness
 * can fail exactly one arm's probe — the asymmetric shapes the observed
 * gate's conjunctions need.
 */
function harness(opts: {
  server: string;
  tmuxAvailable?: boolean;
  /** Shared sessions that die at birth: true = all of them, or a name list. */
  deadShared?: boolean | string[];
  /** Probes that fail: matched by marker substring, optionally per arm. */
  failProbes?: Array<{ marker: string; arm?: 'a' | 'b' }>;
  /** Arm sessions whose sentinel never appears — a script that hangs. */
  hang?: string[];
  /** Per-session exit code written into the fake sentinel (default 0). */
  rcBySession?: Record<string, number>;
  /** Per-session log content (default `${name} output\n`). */
  logBySession?: Record<string, string>;
}) {
  const log: string[][] = [];
  const dir = join(tmpdir(), `qwen-review-ab-drive-${opts.server}`);
  const sharedDies = (name: string) =>
    opts.deadShared === true ||
    (Array.isArray(opts.deadShared) && opts.deadShared.includes(name));
  const exec = (cmd: string, args: string[]): ExecResult => {
    log.push([cmd, ...args]);
    if (cmd === 'tmux' && args[0] === '-V')
      return opts.tmuxAvailable === false ? fail() : ok('tmux 3.4');
    if (cmd === 'bash') {
      const probe = args[1] ?? '';
      const arm = /AB_ARM=(a|b)/.exec(probe)?.[1];
      for (const f of opts.failProbes ?? []) {
        if (probe.includes(f.marker) && (!f.arm || f.arm === arm)) {
          return fail();
        }
      }
      return ok();
    }
    if (cmd === 'tmux' && args[2] === 'new-session') {
      const name = args[5];
      const write = name.startsWith('arm-')
        ? !(opts.hang ?? []).includes(name)
        : sharedDies(name);
      if (write) {
        const rc = opts.rcBySession?.[name] ?? 0;
        writeFileSync(join(dir, `${name}.rc`), `${DRIVE_SENTINEL} rc=${rc}\n`);
      }
      if (name.startsWith('arm-')) {
        writeFileSync(
          join(dir, `${name}.log`),
          opts.logBySession?.[name] ?? `${name} output\n`,
        );
      }
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
  return { exec, log, events };
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
    // reached.
    for (const bad of [NaN, Infinity, 0, -5]) {
      const h = harness({ server: 'x' });
      const r = runAbDrive(baseArgs({ timeout: bad, exec: h.exec }));
      expect(r.observed).toBe(false);
      expect(r.note).toContain('--timeout');
      expect(h.log).toEqual([]);
    }
    const h = harness({ server: 'x' });
    const r = runAbDrive(baseArgs({ readyTimeout: NaN, exec: h.exec }));
    expect(r.note).toContain('--ready-timeout');
    expect(h.log).toEqual([]);
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

  it('reclaims a stale server FIRST — before any session of its own starts', () => {
    // A prior run SIGKILLed before its `finally` leaves a server owning the
    // fixed session names; without the leading reclaim, this run's
    // new-session collides and aborts as "an environment gap" instead of
    // self-healing.
    const args = baseArgs({});
    const h = harness({ server: args.server });
    runAbDrive({ ...args, exec: h.exec });
    expect(h.log[0]).toEqual(['tmux', '-V']);
    expect(h.log[1]).toEqual(['tmux', '-L', args.server, 'kill-server']);
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
    expect(r.scriptSha256).toMatch(/^[0-9a-f]{64}$/);
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

  it('a timed-out arm is killed before the other arm starts — and fails the gate', () => {
    // A timed-out script is still RUNNING when observation stops; left
    // alive it contends with arm b for the same ports and files. The
    // mirrored shape (arm b hangs) also pins `bothCompleted`'s conjunction
    // with an asymmetric fixture: a completes, b does not, observed false.
    const args = baseArgs({ timeout: 1 });
    const h = harness({ server: args.server, hang: ['arm-a'] });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.a?.outcome).toBe('timed-out');
    expect(r.a?.exitCode).toBeNull();
    expect(r.b?.outcome).toBe('completed');
    expect(r.observed).toBe(false);
    expect(r.identicalOutput).toBeNull();
    const ev = h.events();
    expect(ev.indexOf('kill:arm-a')).toBeGreaterThan(ev.indexOf('new:arm-a'));
    expect(ev.indexOf('kill:arm-a')).toBeLessThan(ev.indexOf('new:arm-b'));
    expect(ev).toContain('kill:arm-b');
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
    // In once mode the one instance serves both arms; there is nothing arm b
    // could salvage, so nothing is driven and nothing reads as evidence.
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
    // Both arms "completed" — and the report still refuses the comparison,
    // because whatever an arm observed after its upstream died is an
    // observation of a dead upstream, not of the tree.
    const args = baseArgs({ shared: 'run-daemon' });
    const h = harness({ server: args.server, deadShared: true });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.a?.outcome).toBe('completed');
    expect(r.b?.outcome).toBe('completed');
    expect(r.a?.sharedAliveAtEnd).toBe(false);
    expect(r.observed).toBe(false);
    expect(r.note).toContain('died');
  });

  it('ONE arm’s upstream dying is enough to fail the gate — the asymmetric case', () => {
    // `sharedHeld` is a conjunction, and `&&` vs `||` only differ when
    // exactly one arm reports false; per-arm mode makes that a perfectly
    // ordinary state.
    const args = baseArgs({ shared: 'run-daemon' });
    const h = harness({ server: args.server, deadShared: ['shared-b'] });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.a?.sharedAliveAtEnd).toBe(true);
    expect(r.b?.sharedAliveAtEnd).toBe(false);
    expect(r.observed).toBe(false);
  });

  it('--shared-once with a dead instance fast-fails arm b instead of driving against a corpse', () => {
    // The end-of-arm liveness check keeps correctness; the pre-check keeps
    // arm b from spending readyTimeout + timeout polling a dead upstream.
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

  it('identicalOutput is true only for identical, untrimmed captures — and null when a head was cut', () => {
    // Equality of two tails whose heads are gone is not equality, so past
    // the capture cap the comparison must refuse rather than conclude.
    const args = baseArgs({});
    const same = harness({
      server: args.server,
      logBySession: { 'arm-a': 'same bytes\n', 'arm-b': 'same bytes\n' },
    });
    expect(runAbDrive({ ...args, exec: same.exec }).identicalOutput).toBe(true);

    const big = `x`.repeat(200_001);
    const trimmed = harness({
      server: args.server,
      logBySession: { 'arm-a': big, 'arm-b': big },
    });
    const r = runAbDrive({ ...args, exec: trimmed.exec });
    expect(r.a?.truncated).toBe(true);
    expect(r.identicalOutput).toBeNull();
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
      expect(r.identicalOutput).toBe(false);
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
      expect(existsSync(join(tmpdir(), `qwen-review-ab-drive-${server}`))).toBe(
        false,
      );
    });

    it('an upstream that exits at birth is a confound, not a comparison', () => {
      const armA = tempDir('ab-real-da-');
      const r = runAbDrive({
        shared: 'true',
        script: 'sleep 1; echo watched-nothing',
        armA,
        armB: armA,
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
