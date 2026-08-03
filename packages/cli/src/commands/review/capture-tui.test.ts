/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  captureTuiCommand,
  freezeRender,
  probes,
  runCaptureTui,
} from './capture-tui.js';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
// --help, not --version: freeze <=0.1.6 has no --version flag and would be
// misdiagnosed as absent (mirrors the production probe).
const hasFreeze = spawnSync('freeze', ['--help']).status === 0;
// The server-death and signal probes need pgrep; without it they would parse
// pid 0 and fail red on healthy code. error === undefined distinguishes
// "binary absent" from "no match" (a --version gate would misfire on BSD
// pgrep, which has none).
const hasPgrep =
  spawnSync('pgrep', ['-f', 'no-such-process-anywhere']).error === undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Capture stderr text written during `fn` — the refusal REASON is part of
 * the contract, not just the exit code: two different refusal paths share
 * the exit-3/no-artifacts shape, and only the reason tells them apart. */
async function withStderr(fn: () => Promise<void>): Promise<string> {
  let text = '';
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(((chunk: string | Uint8Array) => {
      text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as never);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return text;
}

// The no-tmux refusal fires exactly where the real-tmux block below is
// skipped, so it gets its own suite that runs EVERYWHERE, driving the probe
// seam instead of the real binary: a refactor that inverts the probe must
// fail here, not surface as a raw ENOENT on some tmux-less host.
describe('capture-tui without tmux (probe seam)', () => {
  const realTmux = probes.tmux;
  beforeEach(() => {
    process.exitCode = undefined;
  });
  afterEach(() => {
    probes.tmux = realTmux;
    process.exitCode = undefined;
  });

  it('refuses with the contract — exit 3, no artifacts, the RIGHT reason', async () => {
    probes.tmux = () => false;
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-notmux-'));
    try {
      const stderr = await withStderr(() =>
        runCaptureTui({
          command: 'printf hi',
          cwd: dir,
          cols: 80,
          rows: 24,
          settleMs: 0,
          until: undefined,
          keys: undefined,
          out: join(dir, 'cap'),
          timeoutMs: 1000,
        } as never),
      );
      expect(process.exitCode).toBe(3);
      expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
      expect(existsSync(join(dir, 'cap.json'))).toBe(false);
      // The reason pins the PATH taken: an inverted probe would fall through
      // to the mid-capture catch and say "tmux failed mid-capture" instead.
      expect(stderr).toContain('tmux is not installed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses non-string argv shapes before anything else', async () => {
    // yargs parses duplicated options into arrays and --no-X into booleans;
    // both must refuse, not throw uncaught or silently corrupt the capture.
    probes.tmux = () => false; // never reached — shapes refuse first
    const base = {
      cwd: undefined,
      cols: 80,
      rows: 24,
      settleMs: 0,
      until: undefined,
      keys: undefined,
      out: '/tmp/never-written',
      timeoutMs: 1000,
    };
    for (const over of [
      { command: ['a', 'b'] }, // --command A --command B
      { command: false }, // --no-command
      { command: 'x', until: ['A', 'B'] }, // --until A --until B
      { command: 'x', keys: [false] }, // --no-keys
      { command: 'x', out: ['x', 'y'] },
    ]) {
      process.exitCode = undefined;
      const stderr = await withStderr(() =>
        runCaptureTui({ ...base, ...over } as never),
      );
      expect(process.exitCode).toBe(3);
      expect(stderr).toContain('must');
    }
  });
});

// The command boundary drives REAL tmux — a private-server capture the mocks
// cannot vouch for (the isolation property IS the exec shape). Skipped where
// tmux is absent; the pure plan shapes stay pinned in tui-capture.test.ts
// everywhere.
describe.skipIf(!hasTmux)('capture-tui (real tmux)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'capture-tui-'));
    process.exitCode = undefined;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  function run(over: Record<string, unknown> = {}): Promise<void> {
    return runCaptureTui({
      command: 'printf "HELLO-\\033[31mRED\\033[0m-WORLD\\n"; sleep 30',
      cwd: dir,
      cols: 80,
      rows: 24,
      settleMs: 0,
      // Settle on CONTENT, not a fixed delay: under CI load a fixed delay
      // races the shell's startup, captures a blank pane, and the ladder
      // assertions turn flaky (measured once: empty .ans → freeze bounds
      // error → 'png' expectation failed).
      until: 'WORLD',
      keys: undefined,
      out: join(dir, 'cap'),
      timeoutMs: 10_000,
      ...over,
    } as never);
  }

  it('captures the real rendering into .ans and records the ladder honestly', async () => {
    await run();
    expect(process.exitCode).toBeUndefined();
    const ans = readFileSync(join(dir, 'cap.ans'), 'utf8');
    expect(ans).toContain('HELLO-');
    expect(ans).toContain('WORLD');
    // The escapes survived (-e): the red text carries its SGR bytes.
    expect(ans).toContain('[31m');
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(['png', 'ans-only']).toContain(manifest.evidence);
    if (hasFreeze) {
      expect(manifest.evidence).toBe('png');
      expect(existsSync(join(dir, 'cap.png'))).toBe(true);
    } else {
      expect(manifest.degradedBecause).toContain('freeze');
    }
  });

  it('captures a command that renders and EXITS — the one-shot fixture case', async () => {
    // Without the pane holder, tmux destroys the session the moment the
    // command exits (remain-on-exit off) and the obtainable frame is lost
    // with a misleading "no server running" refusal (measured: 0/10).
    await run({ command: 'printf "FAST-DONE\\n"', until: 'FAST-DONE' });
    expect(process.exitCode).toBeUndefined();
    expect(readFileSync(join(dir, 'cap.ans'), 'utf8')).toContain('FAST-DONE');
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.settledBy).toBe('until-match');
  });

  it('matches --until across an SGR attribute change', async () => {
    // On the physical (-e) frame the escape bytes sit inside the marker and
    // it can never match; the logical matching view has no escapes.
    await run({
      command: 'printf "AA\\033[31mBB\\033[0m-DONE\\n"; sleep 30',
      until: 'AABB-DONE',
    });
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.settledBy).toBe('until-match');
    // The saved frame is still the physical one, escapes and all.
    expect(readFileSync(join(dir, 'cap.ans'), 'utf8')).toContain('[31m');
  });

  it('matches --until across a wrap boundary', async () => {
    // A 60-char marker in a 40-column pane wraps; only the joined (-J)
    // matching view can see it whole. The .ans stays physical: two lines.
    await run({
      command: `s=$(printf 'M%.0s' $(seq 1 60)); printf "%sEND\\n" "$s"; sleep 30`,
      cols: 40,
      until: 'M{60}END',
    });
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.settledBy).toBe('until-match');
    const ans = readFileSync(join(dir, 'cap.ans'), 'utf8');
    // Physical evidence: the marker is split across lines, as rendered.
    expect(ans).not.toMatch(/M{60}END/);
    expect(ans).toContain('END');
  });

  it('survives a catastrophic-backtracking --until pattern', async () => {
    // The deadline is only checked between test() calls; the vm budget
    // interrupts a superlinear match so the poll keeps expiring on time.
    const started = Date.now();
    await run({
      command: `printf 'a%.0s' $(seq 1 79); printf '\\n'; sleep 30`,
      until: '(a+)+b',
      timeoutMs: 1500,
    });
    expect(process.exitCode).toBeUndefined();
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.settledBy).toBe('timeout');
    // Bounded TIGHT: vitest's own testTimeout kills anything over 15s, so a
    // 30s bound would have zero bite — and a budget regressed to ~13s would
    // still pass it. Healthy runs measure ~2s.
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it('leaves no tmux server behind — the isolation is also the cleanup', async () => {
    await run();
    // Any server this run created is named qwen-review-capture-<ourpid>-…;
    // asking it for sessions must fail because the server is gone. The
    // socket dir is resolved the way the production cleanup (and tmux)
    // resolves it — TMUX_TMPDIR, else /tmp — so a regression in that branch
    // cannot pass this probe vacuously.
    const base = process.env['TMUX_TMPDIR']?.trim() || '/tmp';
    const probe = spawnSync('bash', [
      '-c',
      `for s in $(ls ${base}/tmux-$(id -u)/qwen-review-capture-${process.pid}-* 2>/dev/null); do echo "$s"; done`,
    ]);
    // Binary absence must be loud: with no bash, stdout is undefined and the
    // empty-string assertion below would pass while checking nothing.
    expect(probe.error).toBeUndefined();
    expect((probe.stdout ?? Buffer.from('')).toString().trim()).toBe('');
  });

  it.skipIf(!hasPgrep)('kills the tmux SERVER itself — pid probed while it was alive', async () => {
    // The socket probe above cannot distinguish "server reaped" from "we
    // unlinked a live server's socket" (the cleanup unlinks it either way).
    // This pins server DEATH: grab the server's pid mid-capture, then
    // assert the process is gone after the run.
    const inFlight = run({ until: 'NEVER-MATCHES', timeoutMs: 3000 });
    let serverPid = 0;
    for (let i = 0; i < 100 && !serverPid; i++) {
      const r = spawnSync(
        'pgrep',
        ['-f', `tmux -L qwen-review-capture-${process.pid}-`],
        { encoding: 'utf8' },
      );
      const pid = Number((r.stdout ?? '').trim().split('\n')[0]);
      if (Number.isInteger(pid) && pid > 1) serverPid = pid;
      else await sleep(50);
    }
    await inFlight;
    expect(serverPid).toBeGreaterThan(1);
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(serverPid, 0);
        await sleep(50);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it('kills the processes the capture started — not just the socket file', async () => {
    const pidFile = join(dir, 'shell.pid');
    await run({
      command: `echo $$ > "${pidFile}"; printf "PIDDED\\n"; sleep 30`,
      until: 'PIDDED',
    });
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(pid) && pid > 1).toBe(true);
    // kill-server delivers the reap asynchronously; give it a beat.
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(pid, 0);
        await sleep(50);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it('refuses mid-capture tmux failure with the contract, not a stack trace', async () => {
    // A fake tmux that answers -V but fails every real command models the
    // "probe passes, session fails" host (ancient tmux, unwritable socket
    // dir). The catch must land on the refusal contract.
    const binDir = join(dir, 'fakebin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'tmux'),
      '#!/bin/sh\n[ "$1" = "-V" ] && exit 0\necho "fake tmux: refusing" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const realPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
    let stderr = '';
    try {
      stderr = await withStderr(() => run());
    } finally {
      if (realPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = realPath;
    }
    expect(process.exitCode).toBe(3);
    expect(stderr).toContain('tmux failed mid-capture');
    expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
    expect(existsSync(join(dir, 'cap.json'))).toBe(false);
  });

  it('settles by regex when --until matches, and says so', async () => {
    await run({ until: 'WORLD', settleMs: 0 });
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.settledBy).toBe('until-match');
  });

  it('captures anyway on --until timeout and records the degraded settle', async () => {
    await run({ until: 'NEVER-APPEARS', timeoutMs: 1500, settleMs: 0 });
    expect(process.exitCode).toBeUndefined();
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.settledBy).toBe('timeout');
    // The field whose contract is "why the ladder stopped" carries the late
    // frame too, not just the freeze rung.
    expect(manifest.degradedBecause).toContain('--until never matched');
    const ans = readFileSync(join(dir, 'cap.ans'), 'utf8');
    expect(ans).toContain('HELLO-');
  });

  it('refuses NaN durations instead of hanging on them', async () => {
    // A NaN deadline never expires — `--settle-ms abc` must refuse.
    await run({ until: undefined, settleMs: Number.NaN });
    expect(process.exitCode).toBe(3);
    process.exitCode = undefined;
    await run({ timeoutMs: Number.NaN });
    expect(process.exitCode).toBe(3);
    expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
  });

  it('refuses negative and over-bound durations', async () => {
    // The bounds are the guard's other half: without them a typo'd
    // --timeout-ms of a day is accepted and the poll loop runs for a day.
    await run({ until: undefined, settleMs: -1 });
    expect(process.exitCode).toBe(3);
    process.exitCode = undefined;
    await run({ timeoutMs: 3_600_001 });
    expect(process.exitCode).toBe(3);
    expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
  });

  it('refuses an unwritable --out on the contract, not a stack trace', async () => {
    writeFileSync(join(dir, 'blocker'), 'x');
    await run({ out: join(dir, 'blocker', 'cap') });
    expect(process.exitCode).toBe(3);
    expect(existsSync(join(dir, 'blocker', 'cap.ans'))).toBe(false);
  });

  it('sends --keys tokens verbatim, one per token', async () => {
    await runCaptureTui({
      command: 'cat',
      cwd: dir,
      cols: 80,
      rows: 24,
      settleMs: 800,
      until: 'typed-input',
      keys: ['typed-input', 'Enter'],
      out: join(dir, 'keys'),
      timeoutMs: 10_000,
    } as never);
    const ans = readFileSync(join(dir, 'keys.ans'), 'utf8');
    expect(ans).toContain('typed-input');
    // Per-token dispatch, not one joined call: joined, tmux types the
    // literal string "typed-input Enter" (Enter is only a key NAME as its
    // own token) and this line is what turns red.
    expect(ans).not.toContain('typed-input Enter');
    // The manifest records the keys: a capture driven by keys shows a
    // different screen than the bare command, and a reproducer must know.
    const manifest = JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8'));
    expect(manifest.keys).toEqual(['typed-input', 'Enter']);
    expect(manifest.until).toBe('typed-input');
    expect(manifest.cwd).toBe(dir);
  });

  it('sends --keys in fixed-delay mode too — keys are not an --until feature', async () => {
    await runCaptureTui({
      command: 'cat',
      cwd: dir,
      cols: 80,
      rows: 24,
      settleMs: 800,
      until: undefined,
      keys: ['typed-input', 'Enter'],
      out: join(dir, 'keys-fixed'),
      timeoutMs: 10_000,
    } as never);
    expect(readFileSync(join(dir, 'keys-fixed.ans'), 'utf8')).toContain(
      'typed-input',
    );
  });

  it('refuses degenerate geometry with the refusal contract', async () => {
    await run({ cols: 3 });
    expect(process.exitCode).toBe(3);
    expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
  });

  it('refuses an empty command', async () => {
    await run({ command: '   ' });
    expect(process.exitCode).toBe(3);
  });

  it('refuses an invalid --until regex BEFORE anything starts', async () => {
    const stderr = await withStderr(() => run({ until: '[' }));
    expect(process.exitCode).toBe(3);
    expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
    expect(existsSync(join(dir, 'cap.json'))).toBe(false);
    // The reason pins the path: validated up front, this reads "not a valid
    // regex"; thrown after tmux started, it would read "tmux failed
    // mid-capture: Invalid regular expression…" — a caller mistake blamed
    // on tmux, from a server that was started for nothing.
    expect(stderr).toContain('not a valid regex');
    expect(stderr).not.toContain('mid-capture');
  });

  it('records a fixed-delay settle honestly when no --until is given', async () => {
    await run({ until: undefined, settleMs: 600 });
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.settledBy).toBe('fixed-delay');
  });

  it('records an empty-pane capture honestly and never hands it to freeze', async () => {
    // A pane that rendered nothing (sleep, settle 0) is the blank-capture
    // branch: freeze on empty input fails with a misleading bounds error,
    // so the ladder must stop at ans-only with the blank named as the why.
    await run({ command: 'sleep 30', until: undefined, settleMs: 0 });
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.evidence).toBe('ans-only');
    expect(manifest.pngPath).toBeNull();
    expect(manifest.degradedBecause).toContain('pane captured empty');
    expect(existsSync(join(dir, 'cap.png'))).toBe(false);
  });

  /** Point the freeze render at a fake binary by ABSOLUTE path (a PATH shim
   * is skipped by execvp when non-executable) with the probe seam forced
   * open, so the real spawn runs and the degradation composition is pinned
   * by real exec, not by reading. */
  async function withFakeFreeze(
    script: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const binDir = join(dir, 'fakebin');
    mkdirSync(binDir, { recursive: true });
    const bin = join(binDir, 'freeze');
    writeFileSync(bin, script, {
      mode: script.startsWith('#!') ? 0o755 : 0o644,
    });
    const realFreeze = probes.freeze;
    const realBin = freezeRender.bin;
    probes.freeze = () => true;
    freezeRender.bin = bin;
    try {
      await fn();
    } finally {
      probes.freeze = realFreeze;
      freezeRender.bin = realBin;
    }
  }

  it('records a freeze CRASH with its diagnostics, not just its absence', async () => {
    await withFakeFreeze(
      '#!/bin/sh\necho "boom: render exploded" >&2\nexit 9\n',
      () => run(),
    );
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.evidence).toBe('ans-only');
    expect(manifest.degradedBecause).toContain('freeze failed (exit 9');
    expect(manifest.degradedBecause).toContain('boom: render exploded');
    // A freeze failure never costs the text evidence: .ans was written first.
    expect(existsSync(join(dir, 'cap.ans'))).toBe(true);
  });

  it('cuts a HANGING freeze with the timeout belt and keeps the .ans', async () => {
    const realBelt = freezeRender.timeoutMs;
    freezeRender.timeoutMs = 1000;
    try {
      await withFakeFreeze('#!/bin/sh\nsleep 40\n', () => run());
    } finally {
      freezeRender.timeoutMs = realBelt;
    }
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.evidence).toBe('ans-only');
    expect(manifest.degradedBecause).toContain('signal');
    expect(existsSync(join(dir, 'cap.ans'))).toBe(true);
  });

  it('never manifests a png rung on exit code alone — the file must exist', async () => {
    // A freeze that exits 0 without writing anything would otherwise ship
    // "evidence": "png" pointing at nothing.
    await withFakeFreeze('#!/bin/sh\nexit 0\n', () => run());
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.evidence).toBe('ans-only');
    expect(manifest.pngPath).toBeNull();
    expect(manifest.degradedBecause).toContain('wrote no image');
  });

  it('names a freeze that could not SPAWN, not "exit null"', async () => {
    // A non-executable freeze produces neither status nor signal; the
    // reason lives in r.error and the manifest must carry it.
    await withFakeFreeze('not executable', () => run());
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.evidence).toBe('ans-only');
    expect(manifest.degradedBecause).toContain('spawn failed');
    expect(manifest.degradedBecause).not.toContain('exit null');
  });

  it('probes freeze with --help — the flag freeze <=0.1.6 actually has', async () => {
    // Both real-freeze tests override the seam, so the FLAG the real probe
    // sends was unpinned: a --version mutant stays green wherever freeze
    // >=0.2.2 or no freeze at all is installed, and only fails on a 2024
    // freeze — where it misdiagnoses it as absent. This fake accepts ONLY
    // --help, so the mutant fails everywhere.
    const binDir = join(dir, 'probebin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'freeze'),
      '#!/bin/sh\n[ "$1" = "--help" ] && exit 0\nexit 1\n',
      { mode: 0o755 },
    );
    const realPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
    try {
      expect(probes.freeze()).toBe(true);
    } finally {
      if (realPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = realPath;
    }
  });

  it('degrades to ans-only when freeze is unavailable, and says why', async () => {
    // Through the probe seam, so the freeze-less rung is pinned even on
    // hosts that have freeze installed.
    const realFreeze = probes.freeze;
    probes.freeze = () => false;
    try {
      await run();
    } finally {
      probes.freeze = realFreeze;
    }
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.evidence).toBe('ans-only');
    expect(manifest.pngPath).toBeNull();
    expect(manifest.degradedBecause).toContain('freeze is not installed');
    expect(existsSync(join(dir, 'cap.png'))).toBe(false);
  });

  it('survives a command with a trailing semicolon or comment — the holder is tail-proof', async () => {
    // Appended with `;`, the hold would become `;;` (syntax error, pane
    // dies instantly) after a trailing semicolon, and a trailing `#`
    // comment would swallow it entirely — both re-creating the one-shot
    // failure on commands that are themselves valid shell.
    await run({ command: 'printf "TAIL-SEMI\\n";', until: 'TAIL-SEMI' });
    expect(process.exitCode).toBeUndefined();
    expect(readFileSync(join(dir, 'cap.ans'), 'utf8')).toContain('TAIL-SEMI');
    await run({
      command: 'printf "TAIL-HASH\\n" # keep-alive note',
      until: 'TAIL-HASH',
      out: join(dir, 'hash'),
    });
    expect(process.exitCode).toBeUndefined();
    expect(readFileSync(join(dir, 'hash.ans'), 'utf8')).toContain('TAIL-HASH');
  });

  it('refuses a command ending in a backslash — line continuation eats the holder', async () => {
    await run({ command: 'printf "X\\n" \\' });
    expect(process.exitCode).toBe(3);
    expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
  });

  it('refuses an empty --until instead of settling on a blank frame', async () => {
    // new RegExp('') matches ANY pane text: the first poll would settle
    // "until-match" before anything rendered — a false settle claim.
    await run({ until: '   ' });
    expect(process.exitCode).toBe(3);
    expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
  });

  it('refuses an empty --out instead of writing <cwd>.ans', async () => {
    await run({ out: '' });
    expect(process.exitCode).toBe(3);
  });

  it.skipIf(process.getuid?.() === 0)(
    'refuses an unwritable existing --out dir BEFORE the capture runs',
    async () => {
      // mkdirSync({recursive}) does no permission check on an existing dir:
      // without the write probe the capture would run to completion and
      // lose the pane text at the very last write.
      const ro = join(dir, 'ro');
      mkdirSync(ro, { mode: 0o555 });
      await run({ out: join(ro, 'cap') });
      expect(process.exitCode).toBe(3);
      expect(existsSync(join(ro, 'cap.ans'))).toBe(false);
    },
  );

  it('refuses a --cwd that is not a directory', async () => {
    // tmux new-session -c with a nonexistent dir exits 0 and silently runs
    // the pane somewhere else — evidence from the wrong directory.
    await run({ cwd: join(dir, 'no-such-dir') });
    expect(process.exitCode).toBe(3);
    expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
  });

  it('accepts the exact documented duration maxima', async () => {
    // The refusal message promises inclusive [0, max]: a `>=` off-by-one
    // would refuse a legal exactly-one-hour timeout with a
    // self-contradictory message. `until` settles these in ~1s.
    await run({ timeoutMs: 3_600_000 });
    expect(process.exitCode).toBeUndefined();
    await run({ settleMs: 600_000, out: join(dir, 'max2') });
    expect(process.exitCode).toBeUndefined();
  });

  it('preserves trailing spaces in the physical frame (-N)', async () => {
    // "A clipped right edge is trailing-space significant": without -N,
    // capture-pane trims the trailing run and a padding/clipping claim
    // reads trimmed output as evidence.
    await run({
      command: 'printf "AB   \\n"; sleep 30',
      until: 'AB',
    });
    const ans = readFileSync(join(dir, 'cap.ans'), 'utf8');
    // At least the three printed spaces survive (tmux may pad further);
    // without -N the whole trailing run is trimmed to "AB\n".
    expect(ans).toMatch(/AB {3,}(\r?\n|$)/);
  });

  it('maps the yargs surface — hyphenated keys reach the right fields', async () => {
    // Every other test hand-builds the args object; this drives the real
    // handler mapping. A wrong key (e.g. argv['settleMs']) leaves the field
    // undefined, the duration guard refuses, and this test turns red — the
    // option-contract bug class test-plan.test.ts documents.
    await (
      captureTuiCommand.handler as (argv: unknown) => Promise<void>
    )({
      command: 'printf "MAPPED\\n"; sleep 30',
      cwd: dir,
      cols: 80,
      rows: 24,
      'settle-ms': 0,
      until: 'MAPPED',
      keys: undefined,
      out: join(dir, 'mapped'),
      'timeout-ms': 10_000,
    });
    expect(process.exitCode).toBeUndefined();
    const manifest = JSON.parse(
      readFileSync(join(dir, 'mapped.json'), 'utf8'),
    );
    expect(manifest.settledBy).toBe('until-match');
  });

  it.skipIf(!hasPgrep)(
    'reaps the private server when the capture is SIGTERMed mid-poll',
    async () => {
      // The no-orphan guarantee cannot rest on finally alone — a signal
      // skips it. Spawn the capture as a child, kill it mid --until poll,
      // and assert nothing named for the CHILD's pid survives.
      // vitest's transform does not guarantee a usable file: import.meta.url;
      // resolve from the working directory (package root or repo root).
      let captureTuiTs = join(
        process.cwd(),
        'src/commands/review/capture-tui.ts',
      );
      if (!existsSync(captureTuiTs)) {
        captureTuiTs = join(
          process.cwd(),
          'packages/cli/src/commands/review/capture-tui.ts',
        );
      }
      expect(existsSync(captureTuiTs)).toBe(true);
      const driver = join(dir, 'driver.mts');
      writeFileSync(
        driver,
        [
          `const { runCaptureTui } = await import(${JSON.stringify(captureTuiTs)});`,
          `await runCaptureTui({ command: 'sleep 300', cwd: ${JSON.stringify(dir)}, cols: 80, rows: 24, settleMs: 0, until: 'NEVER-MATCHES', keys: undefined, out: ${JSON.stringify(join(dir, 'sig'))}, timeoutMs: 60_000 } as never);`,
        ].join('\n'),
      );
      const { spawn } = await import('node:child_process');
      const child = spawn(process.execPath, ['--import', 'tsx', driver], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const childPid = child.pid as number;
      // Wait for the child's private server to exist, then SIGTERM the child.
      let seen = false;
      for (let i = 0; i < 200 && !seen; i++) {
        const r = spawnSync(
          'pgrep',
          ['-f', `tmux -L qwen-review-capture-${childPid}-`],
          { encoding: 'utf8' },
        );
        if ((r.stdout ?? '').trim() !== '') seen = true;
        else await sleep(50);
      }
      expect(seen).toBe(true);
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
      // The reap ran before the re-raise: no server named for the child.
      let gone = false;
      for (let i = 0; i < 40 && !gone; i++) {
        const r = spawnSync(
          'pgrep',
          ['-f', `tmux -L qwen-review-capture-${childPid}-`],
          { encoding: 'utf8' },
        );
        if ((r.stdout ?? '').trim() === '') gone = true;
        else await sleep(50);
      }
      expect(gone).toBe(true);
    },
  );
});
