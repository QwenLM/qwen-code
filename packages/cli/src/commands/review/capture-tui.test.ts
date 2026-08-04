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
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  captureTuiCommand,
  freezeRender,
  MATCH_BUDGET_MS,
  probes,
  runCaptureTui,
} from './capture-tui.js';
import { tmuxSupportsCaptureN } from './lib/tui-capture.js';

const tmuxVersionProbe = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
// The suite needs capture-pane -N (tmux 3.1+); on an older tmux every
// capture would refuse with "too old", which is a skip-shaped outcome, not
// a red suite.
const hasTmux =
  tmuxVersionProbe.status === 0 &&
  tmuxSupportsCaptureN(tmuxVersionProbe.stdout ?? '') !== false;
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

/** Capture the stdio written during `fn` — the refusal REASON is part of
 * the contract, not just the exit code: two different refusal paths share
 * the exit-3/no-artifacts shape, and only the reason tells them apart; and
 * an agent consumer parses the refusal JSON from stdout, not stderr. */
async function withStdio(
  fn: () => Promise<void>,
): Promise<{ stdout: string; stderr: string }> {
  const sinks = { stdout: '', stderr: '' };
  const capture = (stream: 'stdout' | 'stderr') =>
    vi.spyOn(process[stream], 'write').mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      sinks[stream] +=
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as never);
  const outSpy = capture('stdout');
  const errSpy = capture('stderr');
  try {
    await fn();
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return sinks;
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
    probes.tmux = () => undefined;
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-notmux-'));
    try {
      const { stdout, stderr } = await withStdio(() =>
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
      // The refusal JSON rides on stdout too: an agent consumer must not
      // have to scrape stderr to tell WHY the ladder stopped at none.
      expect(JSON.parse(stdout.trim())).toEqual({
        captured: false,
        evidence: 'none',
        reason: expect.stringContaining('tmux is not installed'),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a tmux too old for capture-pane -N, naming the version', async () => {
    // -N landed in tmux 3.1; an older host passes -V and would otherwise
    // die MID-capture on the unknown flag — blaming tmux for a version
    // problem, after paying for a server start.
    probes.tmux = () => 'tmux 2.8';
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-oldtmux-'));
    try {
      const { stderr } = await withStdio(() =>
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
      expect(stderr).toContain('tmux 2.8 is too old');
      expect(stderr).toContain('capture-pane -N');
      expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves NO stale artifacts when a re-run refuses', async () => {
    // The previous run's artifacts cannot survive a refused re-run: a stale
    // manifest claiming a png rung whose .ans no longer exists is exactly
    // the wrong-evidence failure this command exists to prevent. On POSIX
    // the fake tmux passes the version probe and fails every real command
    // (a MID-capture refusal); on win32 the shim is unreachable, the probe
    // returns undefined, and the refusal is the no-tmux one — BOTH land
    // after the up-front clear, so the assertions pin the clear on every
    // platform.
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-stale-'));
    try {
      writeFileSync(join(dir, 'cap.ans'), 'old run');
      writeFileSync(join(dir, 'cap.png'), 'old run');
      writeFileSync(join(dir, 'cap.json'), '{"evidence":"png"}');
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, 'tmux'),
        '#!/bin/sh\n[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }\necho "fake tmux: refusing" >&2\nexit 1\n',
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      try {
        await withStdio(() =>
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
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
      }
      expect(process.exitCode).toBe(3);
      expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
      expect(existsSync(join(dir, 'cap.png'))).toBe(false);
      expect(existsSync(join(dir, 'cap.json'))).toBe(false);
      // The writability probe uses a unique sibling and removes it — it
      // must not outlive the run either.
      expect(readdirSync(dir).filter((f) => f.includes('write-probe'))).toEqual(
        [],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears stale artifacts even when the refusal is PRE-capture', async () => {
    // The clear must precede every gate, not just the mid-capture ones: a
    // refactor moving it below the validation chain leaves the previous
    // run's png-claiming manifest next to a typo'd-flag refusal.
    probes.tmux = () => undefined;
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-staleearly-'));
    try {
      writeFileSync(join(dir, 'cap.ans'), 'old run');
      writeFileSync(join(dir, 'cap.png'), 'old run');
      writeFileSync(join(dir, 'cap.json'), '{"evidence":"png"}');
      await withStdio(() =>
        runCaptureTui({
          command: 'printf hi',
          cwd: undefined,
          cols: 80,
          rows: 24,
          settleMs: 0,
          until: '[',
          keys: undefined,
          out: join(dir, 'cap'),
          timeoutMs: 1000,
        } as never),
      );
      expect(process.exitCode).toBe(3);
      expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
      expect(existsSync(join(dir, 'cap.png'))).toBe(false);
      expect(existsSync(join(dir, 'cap.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'refuses through the REAL probe when tmux is absent from PATH',
    async () => {
      // Every other seam test overrides probes.tmux; this one leaves the
      // real probe in place and empties PATH — a probeOutput regression
      // that stops distinguishing status!=0 would otherwise ship green and
      // misdiagnose an absent tmux as "tmux failed mid-capture".
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-realprobe-'));
      const emptyBin = join(dir, 'emptybin');
      mkdirSync(emptyBin, { recursive: true });
      const realPath = process.env['PATH'];
      process.env['PATH'] = emptyBin;
      let stderr = '';
      try {
        ({ stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: undefined,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: undefined,
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 1000,
          } as never),
        ));
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        rmSync(dir, { recursive: true, force: true });
      }
      expect(process.exitCode).toBe(3);
      expect(stderr).toContain('tmux is not installed');
      expect(stderr).not.toContain('mid-capture');
    },
  );

  it('refuses non-string argv shapes before anything else', async () => {
    // yargs parses duplicated options into arrays and --no-X into booleans;
    // both must refuse, not throw uncaught or silently corrupt the capture.
    // Undefined required options are the exported-function vector of the
    // same class: demandOption covers the CLI path only.
    probes.tmux = () => undefined; // never reached — shapes refuse first
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
      { command: undefined },
      { command: 'x', until: ['A', 'B'] }, // --until A --until B
      { command: 'x', keys: [false] }, // --no-keys
      { command: 'x', out: ['x', 'y'] },
      { command: 'x', out: undefined },
      { command: 'x', ready: ['A', 'B'] }, // --ready A --ready B
      { command: 'x', cwd: ['a', 'b'] },
    ]) {
      process.exitCode = undefined;
      const { stderr } = await withStdio(() =>
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
    // Monotonic clock for every wall bound in this suite: Date.now() can be
    // stepped by NTP mid-test and read a wrong elapsed value either way.
    const started = performance.now();
    await run({
      command: `printf 'a%.0s' $(seq 1 79); printf '\\n'; sleep 30`,
      until: '(a+)+b',
      timeoutMs: 1500,
    });
    expect(process.exitCode).toBeUndefined();
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.settledBy).toBe('timeout');
    // The budget cutoff is RECORDED, not swallowed: a backtracking-prone
    // marker may be present, and "never matched" alone would hide that the
    // match was cut off rather than the marker absent.
    expect(manifest.degradedBecause).toContain('exceeded its');
    // Bounded TIGHT: vitest's own testTimeout kills anything over 15s, so a
    // 30s bound would have zero bite. Healthy runs measure ~2s; the budget
    // VALUE itself is declaration-pinned in the defaults test.
    expect(performance.now() - started).toBeLessThan(8_000);
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

  it.skipIf(!hasPgrep)(
    'kills the tmux SERVER itself — pid probed while it was alive',
    async () => {
      // The socket probe above cannot distinguish "server reaped" from "we
      // unlinked a live server's socket" (the cleanup unlinks it either way).
      // This pins server DEATH: grab the server's pid mid-capture, then
      // assert the process is gone after the run.
      const inFlight = run({ until: 'NEVER-MATCHES', timeoutMs: 3000 });
      let serverPid = 0;
      for (let i = 0; i < 100 && !serverPid; i++) {
        const r = spawnSync(
          'pgrep',
          ['-f', `qwen-review-capture-${process.pid}-`],
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
    },
  );

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
      ({ stderr } = await withStdio(() => run()));
    } finally {
      if (realPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = realPath;
    }
    expect(process.exitCode).toBe(3);
    expect(stderr).toContain('tmux failed mid-capture');
    // The start that threw created no server: reap() must stay silent — a
    // kill-server warning here would send an operator hunting a socket that
    // was never created.
    expect(stderr).not.toContain('may still be running');
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

  it('sends --keys only after --ready matches — early keys get eaten', async () => {
    // The fixture DRAINS its input before printing READY, the way a
    // slow-mounting TUI eats keystrokes fired at start (measured on this
    // repo's own onboarding dialog: a Down consumed, the Enter behind it
    // lost). Keys sent at start land in the drain and never echo; keys
    // gated on --ready land after it and do.
    await runCaptureTui({
      command: `bash -c 'sleep 0.7; IFS= read -rs -t 0.3 -n 10000 junk || true; printf "READY\\n"; cat'`,
      cwd: dir,
      cols: 80,
      rows: 24,
      settleMs: 0,
      ready: 'READY',
      until: 'gated-input',
      keys: ['gated-input', 'Enter'],
      out: join(dir, 'ready'),
      timeoutMs: 10_000,
    } as never);
    expect(process.exitCode).toBeUndefined();
    const manifest = JSON.parse(readFileSync(join(dir, 'ready.json'), 'utf8'));
    expect(manifest.settledBy).toBe('until-match');
    expect(manifest.keysSent).toBe(true);
    expect(manifest.ready).toBe('READY');
    expect(readFileSync(join(dir, 'ready.ans'), 'utf8')).toContain(
      'gated-input',
    );
  });

  it('withholds --keys when --ready never matches, and says so', async () => {
    // Typing into a screen that never reached the expected state would
    // drive an unknown UI; the keys are withheld and the manifest is honest
    // about both the miss and the withholding.
    await run({
      ready: 'NEVER-READY',
      keys: ['DANGER', 'Enter'],
      until: undefined,
      settleMs: 0,
      timeoutMs: 1500,
    });
    expect(process.exitCode).toBeUndefined();
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.keysSent).toBe(false);
    expect(manifest.degradedBecause).toContain('--ready never matched');
    expect(manifest.degradedBecause).toContain('NOT sent');
    // The manifest tells the truth about HOW the run ended: it waited out
    // --timeout-ms (a timeout settle, not a fixed delay), and the active
    // duration recorded is the one that governed it.
    expect(manifest.settledBy).toBe('timeout');
    expect(manifest.timeoutMs).toBe(1500);
    expect(manifest.settleMs).toBeUndefined();
    // The pty would echo even unread keystrokes — absence proves withheld.
    expect(readFileSync(join(dir, 'cap.ans'), 'utf8')).not.toContain('DANGER');
  });

  it('gates --ready on the LOGICAL view — an SGR-split marker still opens it', async () => {
    // Both prior ready tests used plain markers; on the physical (-e) view
    // an escape lands inside the marker and the gate never opens — keys
    // withheld on a healthy UI.
    await runCaptureTui({
      command: `bash -c 'sleep 0.5; printf "GA\\033[31mTE\\033[0m\\n"; cat'`,
      cwd: dir,
      cols: 80,
      rows: 24,
      settleMs: 0,
      ready: 'GATE',
      until: 'sgr-gated',
      keys: ['sgr-gated', 'Enter'],
      out: join(dir, 'sgr-ready'),
      timeoutMs: 10_000,
    } as never);
    const manifest = JSON.parse(
      readFileSync(join(dir, 'sgr-ready.json'), 'utf8'),
    );
    expect(manifest.settledBy).toBe('until-match');
    expect(manifest.keysSent).toBe(true);
  });

  it('refuses an empty or invalid --ready like it refuses --until', async () => {
    await run({ ready: '   ' });
    expect(process.exitCode).toBe(3);
    process.exitCode = undefined;
    await run({ ready: '[' });
    expect(process.exitCode).toBe(3);
    expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
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

  it('dispatches EVERY key token — a marker only a second token can produce', async () => {
    // All prior keys fixtures settle on the FIRST token's echo, so a
    // first-token-only mutant shipped green. This fixture's marker appears
    // only after Enter completes the read.
    await runCaptureTui({
      command: `bash -c 'IFS= read -r line; printf "GOT:%s\\n" "$line"; cat'`,
      cwd: dir,
      cols: 80,
      rows: 24,
      settleMs: 0,
      until: 'GOT:hello',
      keys: ['hello', 'Enter'],
      out: join(dir, 'twotok'),
      timeoutMs: 10_000,
    } as never);
    const manifest = JSON.parse(readFileSync(join(dir, 'twotok.json'), 'utf8'));
    expect(manifest.settledBy).toBe('until-match');
  });

  it('dispatches keys IN ORDER — reversal drives a different key sequence', async () => {
    await runCaptureTui({
      command: 'cat',
      cwd: dir,
      cols: 80,
      rows: 24,
      settleMs: 0,
      until: 'LINE2',
      keys: ['LINE1', 'Enter', 'LINE2'],
      out: join(dir, 'order'),
      timeoutMs: 10_000,
    } as never);
    const ans = readFileSync(join(dir, 'order.ans'), 'utf8');
    expect(ans.indexOf('LINE1')).toBeGreaterThan(-1);
    expect(ans.indexOf('LINE2')).toBeGreaterThan(ans.indexOf('LINE1'));
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
    const { stderr } = await withStdio(() => run({ until: '[' }));
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
    // The wait itself is pinned by wall clock: sleep(0) captures before the
    // TUI renders, sleep(timeoutMs) waits up to 20x longer than requested —
    // both shipped green when only the manifest field was asserted.
    const started = performance.now();
    await run({ until: undefined, settleMs: 600 });
    const elapsed = performance.now() - started;
    // The 50ms of slack absorbs libuv starting the settle timer off a cached
    // loop tick under load; the bound still catches the sleep(0) and
    // sleep(timeoutMs) mutants it exists for.
    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(elapsed).toBeLessThan(5_000);
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.settledBy).toBe('fixed-delay');
    expect(manifest.settleMs).toBe(600);
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

  it('captures a command that ENDS ITSELF with exit 0 — the inner shell absorbs it', async () => {
    // Single-shell holder measured: `printf ...; exit 0` took pane, session
    // and server down before capture — "no server running" on a valid
    // command. The nested holder absorbs the exit.
    await run({ command: 'printf "EXITY\\n"; exit 0', until: 'EXITY' });
    expect(process.exitCode).toBeUndefined();
    expect(readFileSync(join(dir, 'cap.ans'), 'utf8')).toContain('EXITY');
  });

  it('refuses --until/--ready patterns that would MATCH a blank pane', async () => {
    // The blank pane's logical capture is rows of newlines, not the empty
    // string — `.?`, `x*`, `\s` and `\n` all pass an empty-string-only
    // oracle yet settle (or fire keys) before the UI rendered anything.
    for (const until of ['.?', '(MARKER)?', 'x*', '\\s', '\\n']) {
      process.exitCode = undefined;
      const { stderr } = await withStdio(() => run({ until }));
      expect(process.exitCode).toBe(3);
      expect(stderr).toContain('matches a blank pane');
    }
    process.exitCode = undefined;
    const { stderr } = await withStdio(() =>
      run({ until: 'REAL', ready: '\\s', keys: ['x'] }),
    );
    expect(process.exitCode).toBe(3);
    expect(stderr).toContain('--ready');
    expect(stderr).toContain('matches a blank pane');
  });

  it('reports the success JSON on stdout — captured, evidence, manifest path', async () => {
    // The consumer is an agent: the success line is machine-read, and only
    // the refusal side was pinned before.
    const { stdout } = await withStdio(() => run());
    const line = stdout.trim().split('\n').at(-1) ?? '';
    expect(JSON.parse(line)).toEqual({
      captured: true,
      evidence: hasFreeze ? 'png' : 'ans-only',
      manifest: join(dir, 'cap.json'),
    });
  });

  it('shares ONE deadline between the ready gate and the until poll', async () => {
    // Two separate clocks would let a ready+until capture run to
    // 2× --timeout-ms: ready matches late (~1.5s), until never matches, and
    // the whole run must still end near the single 2s deadline, not 3.5s.
    // The freeze render is NOT what this test measures: leaving it in the
    // timed window spends up to a second of the bound on the render, and
    // hosts with freeze would test a different window than hosts without.
    const realFreeze = probes.freeze;
    probes.freeze = () => false;
    const started = performance.now();
    try {
      await run({
        command: 'sleep 1.5; printf "GATE-OPEN\\n"; sleep 30',
        ready: 'GATE-OPEN',
        until: 'NEVER-MATCHES',
        timeoutMs: 2500,
      });
    } finally {
      probes.freeze = realFreeze;
    }
    expect(process.exitCode).toBeUndefined();
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.settledBy).toBe('timeout');
    // The ready gate's residue proves the gate RAN (a keys-gated mutant
    // skips it entirely when no keys are given): ready matched, so the
    // degradation names the until miss, and timeoutMs was the active knob.
    expect(manifest.degradedBecause).toContain('--until never matched');
    expect(manifest.timeoutMs).toBe(2500);
    // Pristine ends near the single 2.5s deadline; the two-clock mutant
    // needs ready(~1.6s) + until(2.5s) ≈ 4.1s and lands past the bound.
    expect(performance.now() - started).toBeLessThan(3600);
  });

  it('polls --ready even with no keys and no --until — and says how it settled', async () => {
    // Production deliberately spends the timeout budget on a ready-only
    // run; a mutant gating the poll on keys-present settles instantly on a
    // pre-render frame with settledBy 'fixed-delay' and no degradation —
    // the false-settle shape --ready exists to prevent.
    await run({
      ready: 'NEVER-READY',
      until: undefined,
      keys: undefined,
      settleMs: 0,
      timeoutMs: 1500,
    });
    expect(process.exitCode).toBeUndefined();
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.settledBy).toBe('timeout');
    expect(manifest.degradedBecause).toContain('--ready never matched');
    expect(manifest.timeoutMs).toBe(1500);
    expect(manifest.settleMs).toBeUndefined();
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
      const { stderr } = await withStdio(() => run({ out: join(ro, 'cap') }));
      expect(process.exitCode).toBe(3);
      expect(existsSync(join(ro, 'cap.ans'))).toBe(false);
      // The reason pins WHERE the refusal landed: without the up-front
      // probe, the capture runs to completion (a 1h --timeout-ms burns the
      // whole window first) and refuses at the final write instead.
      expect(stderr).toContain('not writable');
      expect(stderr).not.toContain('cannot write capture output');
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'refuses a --cwd the process cannot ENTER, not just a missing one',
    async () => {
      // statSync alone passes a mode-644 directory; entering it needs +x —
      // tmux would exit 0 and silently run the pane in the launcher's cwd
      // while the manifest records the requested one.
      const blocked = join(dir, 'blocked');
      mkdirSync(blocked, { mode: 0o644 });
      await run({ cwd: blocked });
      expect(process.exitCode).toBe(3);
      expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
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
    await (captureTuiCommand.handler as (argv: unknown) => Promise<void>)({
      command: `bash -c 'sleep 0.3; printf "MAPPED\\n"; cat'`,
      cwd: dir,
      cols: 80,
      rows: 24,
      'settle-ms': 0,
      ready: 'MAPPED',
      until: 'typed-by-map',
      keys: ['typed-by-map', 'Enter'],
      out: join(dir, 'mapped'),
      'timeout-ms': 10_000,
    });
    expect(process.exitCode).toBeUndefined();
    const manifest = JSON.parse(readFileSync(join(dir, 'mapped.json'), 'utf8'));
    expect(manifest.settledBy).toBe('until-match');
    // Every mapped field observable in the manifest is pinned BY VALUE — a
    // settle-ms/timeout-ms swap or a wrong ready/keys argv key ships green
    // otherwise (keys/ready only shape-check when !== undefined).
    expect(manifest.keysSent).toBe(true);
    expect(manifest.keys).toEqual(['typed-by-map', 'Enter']);
    expect(manifest.ready).toBe('MAPPED');
    expect(manifest.until).toBe('typed-by-map');
    expect(manifest.timeoutMs).toBe(10_000);
    expect(manifest.cwd).toBe(dir);
    // Identity fields too: a command/ansPath/cols/rows mutant self-
    // consistently records the lie (measured: a transposed cols/rows pair
    // passes validGeometry and every prior assertion).
    expect(manifest.command).toBe(
      `bash -c 'sleep 0.3; printf "MAPPED\\n"; cat'`,
    );
    expect(manifest.ansPath).toBe(join(dir, 'mapped.ans'));
    expect(manifest.cols).toBe(80);
    expect(manifest.rows).toBe(24);
  });

  it('maps settle-ms where it is OBSERVABLE — the fixed-delay shape', async () => {
    // With --until set, settleMs is structurally unobservable (omitted from
    // the manifest); a settle-ms→timeout-ms swap mutant shipped green until
    // this invocation, where the mapping is the active duration.
    await (captureTuiCommand.handler as (argv: unknown) => Promise<void>)({
      command: 'printf "FIXED\\n"; sleep 30',
      cwd: dir,
      cols: 80,
      rows: 24,
      'settle-ms': 123,
      until: undefined,
      keys: undefined,
      out: join(dir, 'mapped-fixed'),
      'timeout-ms': 10_000,
    });
    expect(process.exitCode).toBeUndefined();
    const manifest = JSON.parse(
      readFileSync(join(dir, 'mapped-fixed.json'), 'utf8'),
    );
    expect(manifest.settledBy).toBe('fixed-delay');
    expect(manifest.settleMs).toBe(123);
  });

  it('declares the yargs surface — array keys, required command/out, defaults', () => {
    // The mapping test drives the handler; this pins the BUILDER: dropping
    // array:true from keys refuses the documented `--keys "/review" Enter`
    // usage while every handler-level test stays green.
    const options: Record<string, Record<string, unknown>> = {};
    const fake = {
      option(name: string, cfg: Record<string, unknown>) {
        options[name] = cfg;
        return this;
      },
    };
    (captureTuiCommand.builder as (y: unknown) => unknown)(fake);
    expect(options['keys']?.['array']).toBe(true);
    expect(options['command']?.['demandOption']).toBe(true);
    expect(options['out']?.['demandOption']).toBe(true);
    expect(options['cols']?.['default']).toBe(80);
    expect(options['rows']?.['default']).toBe(24);
    expect(options['settle-ms']?.['default']).toBe(3000);
    expect(options['timeout-ms']?.['default']).toBe(60_000);
    expect(options['ready']?.['type']).toBe('string');
    // until/cwd must be DECLARED at all: reviewCommand registers under
    // .strict(), so a dropped .option('until') rejects the flagship
    // documented usage with "Unknown argument" while every handler-level
    // test stays green. And the numeric options must be type:'number' —
    // as strings, '--settle-ms 600' parses to '600' and the duration
    // guard refuses a legal value.
    expect(options['until']?.['type']).toBe('string');
    expect(options['cwd']?.['type']).toBe('string');
    for (const numeric of ['cols', 'rows', 'settle-ms', 'timeout-ms']) {
      expect(options[numeric]?.['type']).toBe('number');
    }
  });

  it('pins the production freeze render defaults — the belt is 30s, the bin is freeze', () => {
    // The belt test overrides-and-restores; without this pin a mutant
    // shipping timeoutMs: 5_000 (or a renamed bin) is invisible.
    expect(freezeRender.timeoutMs).toBe(30_000);
    expect(freezeRender.bin).toBe('freeze');
    // Same declaration-pin for the match budget: the wall-clock gate alone
    // tolerates any value up to ~7s, silently inflating every poll
    // iteration past the shared deadline.
    expect(MATCH_BUDGET_MS).toBe(500);
  });

  it.skipIf(!hasPgrep)(
    'reaps the private server when the capture is signalled mid-poll — SIGTERM and SIGINT',
    async () => {
      // The no-orphan guarantee cannot rest on finally alone — a signal
      // skips it. Spawn the capture as a child, kill it mid --until poll,
      // and assert nothing named for the CHILD's pid survives. BOTH
      // signals: deleting only the SIGINT registration shipped green while
      // an operator's Ctrl+C left server, socket and holder alive.
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
      const { spawn } = await import('node:child_process');
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        const outBase = join(dir, `sig-${signal}`);
        const driver = join(dir, `driver-${signal}.mts`);
        writeFileSync(
          driver,
          [
            `const { runCaptureTui } = await import(${JSON.stringify(captureTuiTs)});`,
            `await runCaptureTui({ command: 'sleep 300', cwd: ${JSON.stringify(dir)}, cols: 80, rows: 24, settleMs: 0, until: 'NEVER-MATCHES', keys: undefined, out: ${JSON.stringify(outBase)}, timeoutMs: 60_000 } as never);`,
          ].join('\n'),
        );
        const child = spawn(process.execPath, ['--import', 'tsx', driver], {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const childPid = child.pid as number;
        let seen = false;
        for (let i = 0; i < 200 && !seen; i++) {
          const r = spawnSync(
            'pgrep',
            ['-f', `qwen-review-capture-${childPid}-`],
            { encoding: 'utf8' },
          );
          if ((r.stdout ?? '').trim() !== '') seen = true;
          else await sleep(50);
        }
        expect(seen).toBe(true);
        child.kill(signal);
        await new Promise((resolve) => child.once('exit', resolve));
        // The reap ran before the re-raise: no server named for the child.
        let gone = false;
        for (let i = 0; i < 40 && !gone; i++) {
          const r = spawnSync(
            'pgrep',
            ['-f', `qwen-review-capture-${childPid}-`],
            { encoding: 'utf8' },
          );
          if ((r.stdout ?? '').trim() === '') gone = true;
          else await sleep(50);
        }
        expect(gone).toBe(true);
      }
    },
  );

  it('renders through a stdin-IGNORING spawn — a pipe stdin breaks freeze', async () => {
    // The production spawn sets stdio ignore because freeze treats a
    // non-/dev/null stdin as "the input is stdin" (measured: EOF'd pipe →
    // "ERROR No input", exit 1). spawnSync's pipe stdin EOFs at spawn — it
    // never blocks — so this fake discriminates by SHAPE: fd 0 must be the
    // /dev/null character device, or it fails the way real freeze does.
    await withFakeFreeze(
      '#!/bin/sh\nif [ ! -c /dev/stdin ]; then echo "ERROR No input" >&2; exit 1; fi\n: > "$5"\nexit 0\n',
      () => run(),
    );
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.evidence).toBe('png');
  });
});
