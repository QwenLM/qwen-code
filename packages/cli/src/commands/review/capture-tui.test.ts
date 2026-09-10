/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import {
  ARTIFACT_OPEN_FLAGS,
  isSameSocket,
  captureTuiCommand,
  freezeRender,
  hostStateFor,
  MATCH_BUDGET_MS,
  holderInit,
  probeBudget,
  probes,
  REAP_SIGNALS,
  runCaptureTui,
  tmuxControl,
} from './capture-tui.js';
import {
  captureServerName,
  tmuxSupportsCaptureN,
  tmuxPadsWithCaptureN,
} from './lib/tui-capture.js';

const tmuxVersionProbe = spawnSync('tmux', ['-V'], {
  encoding: 'utf8',
  // Same belt as production probeOutput: a hanging shimmed binary here
  // blocks the whole file at import time with no red test naming the cause.
  timeout: 10_000,
  killSignal: 'SIGKILL',
});
// The suite needs capture-pane -N (tmux 3.1+); on an older tmux every
// capture would refuse with "too old", which is a skip-shaped outcome, not
// a red suite.
const hasTmux =
  tmuxVersionProbe.status === 0 &&
  tmuxSupportsCaptureN(tmuxVersionProbe.stdout ?? '') !== false;
// --help, not --version: freeze <=0.1.6 has no --version flag and would be
// misdiagnosed as absent (mirrors the production probe).
const hasFreeze =
  spawnSync('freeze', ['--help'], { timeout: 10_000, killSignal: 'SIGKILL' })
    .status === 0;
// The server-death and signal probes need pgrep; without it they would parse
// pid 0 and fail red on healthy code. error === undefined distinguishes
// "binary absent" from "no match" (a --version gate would misfire on BSD
// pgrep, which has none).
const hasPgrep =
  spawnSync('pgrep', ['-f', 'no-such-process-anywhere'], {
    timeout: 10_000,
    killSignal: 'SIGKILL',
  }).error === undefined;

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
// The manifest a PREVIOUS run of this command actually wrote — the only
// thing the clear phase now accepts as its own. A bare `{"evidence":"png"}`
// no longer qualifies, and must not: a user's own JSON carrying that field
// authorized deleting the files beside it (probe-reproduced).
function staleManifest(outBase: string, evidence = 'png'): string {
  return JSON.stringify({
    command: 'printf hi',
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    ansPath: `${outBase}.ans`,
    // An ans-only run (the degraded freeze rung) records a NULL pngPath,
    // exactly as the command writes it — so it cannot authorize deleting
    // anything at the png name.
    pngPath: evidence === 'png' ? `${outBase}.png` : null,
    evidence,
    settledBy: 'fixed-delay',
  });
}

// `<out>.holder-ready` is no longer the sentinel — it lives per-pid under
// the system temp dir — so asserting that path is absent proves nothing.
// This is the assertion that still has teeth: nothing of ours outlives the
// run where the sentinel really is.
/** Absolute path to capture-tui.ts, for the child drivers. Was copy-pasted
 * at six sites, five of which failed SILENTLY when neither candidate
 * existed: the driver then imported nothing and the test read as a passing
 * run of a command it never invoked. One place, one loud failure. */
function captureTuiSource(): string {
  const candidates = [
    join(process.cwd(), 'src/commands/review/capture-tui.ts'),
    join(process.cwd(), 'packages/cli/src/commands/review/capture-tui.ts'),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `capture-tui.ts not found for the child driver; tried:\n  ${candidates.join('\n  ')}`,
    );
  }
  return found;
}

function leakedSentinels(pid: number = process.pid): string[] {
  return readdirSync(tmpdir()).filter((f) =>
    f.startsWith(`qwen-capture-ready-${pid}-`),
  );
}

describe('hostStateFor', () => {
  // Five of these six arms were asserted nowhere: reaching them through
  // the real syscalls needs a fault injector, so deleting any one shipped
  // green while the refusal blamed the caller's --out for the host.
  it.each([
    ['EMFILE', 'out of file descriptors'],
    ['ENFILE', 'system file table is full'],
    ['ENOSPC', 'filesystem is full'],
    ['EDQUOT', 'disk quota is exhausted'],
    ['EROFS', 'filesystem is read-only'],
    ['EIO', 'I/O errors'],
    ['ESTALE', 'network filesystem handle is stale'],
  ])('names the host state for %s', (code, expected) => {
    expect(hostStateFor(code)).toContain(expected);
  });

  it('says nothing for a code that IS about the argument', () => {
    // ENOENT/EACCES/EISDIR are answers about --out itself, and must keep
    // the '--out is not writable' wording rather than blaming the host.
    for (const code of ['ENOENT', 'EACCES', 'EISDIR', undefined]) {
      expect(hostStateFor(code)).toBeNull();
    }
  });
});

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
    probes.tmux = () => ({ status: 'absent' }) as const;
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
      expect(leakedSentinels()).toEqual([]);
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

  it.skipIf(process.platform === 'win32')(
    'refuses an unusable TMPDIR up front, naming it',
    async () => {
      // The sentinel lives under the system temp dir now, and nothing probed
      // that directory: an unusable TMPDIR burned the whole --timeout-ms
      // waiting for a holder that could never signal ready, then blamed the
      // capture. The dir is created BEFORE TMPDIR is overridden — mkdtemp
      // reads the same variable.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-badtmp-'));
      // Seeded, and call-logged: the elapsed pin below catches only the
      // gate-DELETED mutant (the old ready-wait burn). A gate MOVED below
      // plan.start refuses just as fast, having started a real server and
      // run the user's command first — and leaves the previous run's
      // evidence:"png" manifest beside the refusal if it also moved above
      // the clear. Both are what the sibling gate families pin.
      writeFileSync(join(dir, 'cap.ans'), 'old run');
      writeFileSync(join(dir, 'cap.png'), 'old run');
      writeFileSync(join(dir, 'cap.json'), staleManifest(join(dir, 'cap')));
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      const callLog = join(dir, 'tmux-calls');
      writeFileSync(
        join(binDir, 'tmux'),
        `#!/bin/sh\necho "$*" >> "${callLog}"\n[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }\necho ""\nexit 0\n`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      const realTmp = process.env['TMPDIR'];
      process.env['TMPDIR'] = join(dir, 'no-such-temp-dir');
      const started = performance.now();
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
            // Generous on purpose: the point is that it refuses in
            // milliseconds instead of sitting out the ready deadline.
            timeoutMs: 60_000,
          } as never),
        );
        expect(process.exitCode).toBe(3);
        expect(stderr).toContain('temporary directory is not usable');
        expect(stderr).toContain('TMPDIR');
        expect(performance.now() - started).toBeLessThan(10_000);
        // Nothing started...
        const calls = existsSync(callLog) ? readFileSync(callLog, 'utf8') : '';
        expect(calls).not.toContain('new-session');
        // ...and the clear ran first, like every sibling gate.
        expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
        expect(existsSync(join(dir, 'cap.png'))).toBe(false);
        expect(existsSync(join(dir, 'cap.json'))).toBe(false);
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        if (realTmp === undefined) delete process.env['TMPDIR'];
        else process.env['TMPDIR'] = realTmp;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a file-shaped TMPDIR at the gate, not at the sentinel removal',
    async () => {
      // The existing-but-unusable shapes the nonexistent-dir test cannot
      // reach: `force` suppresses ENOENT only, so the clear-phase sentinel
      // removal threw ENOTDIR here and the --out-attributing catch claimed
      // it ('--out is not writable: ENOTDIR'), shadowing the dedicated gate
      // — and the gate itself checked only W_OK|X_OK, which a mode-0777
      // regular file PASSES (probe-verified), so without the directoryness
      // check the run burns the full holder-init window and then blames
      // the pane ('capture never started'), naming TMPDIR nowhere.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-filetmp-'));
      // Created BEFORE TMPDIR is overridden — mkdtemp reads the same
      // variable (same discipline as the nonexistent-dir sibling).
      const fileTmp = join(dir, 'tmp-as-file');
      writeFileSync(fileTmp, 'not a directory');
      chmodSync(fileTmp, 0o777);
      const realTmp = process.env['TMPDIR'];
      process.env['TMPDIR'] = fileTmp;
      const started = performance.now();
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
            timeoutMs: 60_000,
          } as never),
        );
        expect(process.exitCode).toBe(3);
        expect(stderr).toContain('temporary directory is not usable');
        expect(stderr).toContain('TMPDIR');
        expect(stderr).not.toContain('--out is not writable');
        // Refused in milliseconds, not after the holder-init window: the
        // sail-through mutant pays the full 10s before blaming the pane.
        expect(performance.now() - started).toBeLessThan(5_000);
      } finally {
        if (realTmp === undefined) delete process.env['TMPDIR'];
        else process.env['TMPDIR'] = realTmp;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses an over-long tmux socket path up front, naming it',
    async () => {
      // A unix socket path is capped by sockaddr_un (104 bytes on macOS,
      // 108 on Linux). Over it, the server START succeeds and the first
      // control call fails with "error connecting to … (File name too
      // long)" — a mid-capture refusal that blames tmux for a path this
      // command chose, after paying for the start. Found by making this
      // suite's own TMUX_TMPDIR test assert success: it had been passing
      // over exactly this failure.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-longsock-'));
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      // CREATED, not just named: tmux only uses a base it can use, and an
      // unusable one falls back to /tmp — where the path is short and the
      // capture would have been fine.
      // Sized AGAINST THE CONSTANT, not just "very long": the previous
      // fixture overflowed by ~100 bytes, so any mutant bound in roughly
      // [104, 197] refused it too and the gate's defining 103 was
      // undiscriminated. This lands exactly one byte over the gate's 103
      // bound (a 104-byte path), built from the same pieces production
      // measures — the `> 104` off-by-one admits it and this refusal goes
      // missing.
      const socketTail = `/tmux-${process.getuid?.() ?? 0}/${captureServerName(
        process.pid,
        'deadbeef',
      )}`;
      const pad = Math.max(1, 103 - Buffer.byteLength(dir) - socketTail.length);
      const longBase = join(dir, 'x'.repeat(pad));
      mkdirSync(longBase, { recursive: true, mode: 0o700 });
      process.env['TMUX_TMPDIR'] = longBase;
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
        expect(stderr).toContain('too long for a unix socket');
        expect(stderr).toContain('TMUX_TMPDIR');
        expect(stderr).not.toContain('mid-capture');
      } finally {
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'measures the CANONICAL socket base — a lengthening symlink cannot slip past the gate',
    async () => {
      // tmux resolves a symlinked base before it binds, and the sockaddr
      // bound applies to the CANONICAL path: a lexical measure admitted
      // this run and the start then failed mid-capture with ENAMETOOLONG,
      // blaming tmux for a path this command chose (probe-verified on 3.4;
      // macOS meets the default shape, /tmp -> /private/tmp).
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join('/tmp', 'capture-tui-gatel-'));
      const deep = join(dir, 'y'.repeat(50), 'y'.repeat(50));
      mkdirSync(deep, { recursive: true, mode: 0o700 });
      const link = join(dir, 'link');
      symlinkSync(deep, link);
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      process.env['TMUX_TMPDIR'] = link;
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
        expect(stderr).toContain('too long for a unix socket');
        expect(stderr).not.toContain('mid-capture');
      } finally {
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'admits a run whose CANONICAL socket path fits a lexical path that does not',
    async () => {
      // The converse arm of the gate above: a long lexical path through a
      // deep link whose TARGET is short fits the sockaddr bound once
      // canonicalized — the lexical measure refused a capture that was
      // about to succeed (probe-verified on 3.4).
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join('/tmp', 'capture-tui-gates-'));
      const real = join(dir, 'real');
      mkdirSync(real, { mode: 0o700 });
      const deep = join(dir, 'z'.repeat(60), 'z'.repeat(60));
      mkdirSync(deep, { recursive: true });
      const link = join(deep, 'link');
      symlinkSync(real, link);
      writeFakeTmux(dir, '    :');
      const realPath = process.env['PATH'];
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      process.env['PATH'] = `${join(dir, 'fakebin')}:${realPath ?? ''}`;
      process.env['TMUX_TMPDIR'] = link;
      try {
        await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBeUndefined();
        expect(existsSync(join(dir, 'cap.json'))).toBe(true);
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('refuses arguments past the manifest cap measured in BYTES, not code units', async () => {
    // The reader caps a manifest at MAX_MANIFEST_BYTES of UTF-8, so the
    // writer gate must measure the same unit: multibyte arguments between
    // half the cap in CHARACTERS and the cap in BYTES used to pass it and
    // wrote a manifest the next run could not verify — artifacts no longer
    // clearable, every re-run refused on the collision (probe-reproduced
    // with CJK --keys tokens). 180k CJK chars are one UTF-16 code unit
    // each (well under half the cap) and three UTF-8 bytes each (over it).
    probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-bigargs-'));
    try {
      const { stdout, stderr } = await withStdio(() =>
        runCaptureTui({
          command: 'printf hi',
          cwd: undefined,
          cols: 80,
          rows: 24,
          settleMs: 0,
          until: undefined,
          keys: ['\u4e00'.repeat(180_000)],
          out: join(dir, 'cap'),
          timeoutMs: 1000,
        } as never),
      );
      expect(process.exitCode).toBe(3);
      expect(stderr).toContain('would not fit a readable manifest');
      // The refusal JSON rides on stdout too, like every sibling refusal.
      expect(JSON.parse(stdout.trim())).toEqual({
        captured: false,
        evidence: 'none',
        reason: expect.stringContaining('would not fit a readable manifest'),
      });
      // The gate fires before anything starts.
      expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
      expect(existsSync(join(dir, 'cap.json'))).toBe(false);
      expect(leakedSentinels()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses small tokens that pass DENSE but overflow the cap pretty-printed', async () => {
    // The writer emits JSON.stringify(manifest, null, 2); the gate used to
    // measure the DENSE serialization. Pretty-printing an array of many
    // small elements expands ~2.25x: 130k one-char --keys tokens measure
    // ~520kB dense (under the gate) and ~1.17MB pretty — past the reader
    // cap — so the run passed, wrote a manifest its own next run could not
    // verify, and every re-run against the same --out refused on the
    // collision instead (probe-reproduced).
    probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-prettyargs-'));
    try {
      const { stdout, stderr } = await withStdio(() =>
        runCaptureTui({
          command: 'printf hi',
          cwd: undefined,
          cols: 80,
          rows: 24,
          settleMs: 0,
          until: undefined,
          // Never matches: on pre-gate code the run proceeds, and withheld
          // keys keep that run fast instead of typing 130k send-keys calls.
          ready: 'NEVER-MATCHES',
          keys: Array.from({ length: 130_000 }, () => 'k'),
          out: join(dir, 'cap'),
          timeoutMs: 500,
        } as never),
      );
      expect(process.exitCode).toBe(3);
      expect(stderr).toContain('would not fit a readable manifest');
      expect(JSON.parse(stdout.trim())).toEqual({
        captured: false,
        evidence: 'none',
        reason: expect.stringContaining('would not fit a readable manifest'),
      });
      expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses the --no-keys negation with the reason that names it', async () => {
    // yargs's default boolean-negation parses `--no-keys` on the
    // array-typed option to [false] (probed on this repo's yargs): the
    // caller supplied no key tokens at all, and the refusal must not say
    // their tokens have the wrong type — an agent consumer would go
    // inspect tokens it never passed and retry unchanged. Every sibling
    // flag's negation gets the accurate "given exactly once" message.
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-nokeys-'));
    try {
      const { stdout, stderr } = await withStdio(() =>
        runCaptureTui({
          command: 'printf hi',
          cwd: undefined,
          cols: 80,
          rows: 24,
          settleMs: 0,
          until: undefined,
          keys: [false],
          out: join(dir, 'cap'),
          timeoutMs: 1000,
        } as never),
      );
      expect(process.exitCode).toBe(3);
      expect(stderr).toContain('--keys must be given exactly once');
      expect(JSON.parse(stdout.trim())).toEqual({
        captured: false,
        evidence: 'none',
        reason: '--keys must be given exactly once, as strings.',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The png rung's mid-window occupancy, driven with NO real tmux: a PATH
  // shim answers every control call — planting at <out>.png where the
  // pane's command would — and the freeze seam does the render. The
  // ladder's occupancy decision runs identically, so these pins also work
  // on tmux-less hosts where the real-tmux planter fixtures skip.
  function writeFakeTmux(dir: string, plant: string): void {
    const binDir = join(dir, 'fakebin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'tmux'),
      `#!/bin/sh
[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }
for a in "$@"; do
  if [ "$a" = "new-session" ]; then
${plant}
    s=$(printf '%s\\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1)
    [ -n "$s" ] && : > "$s"
    exit 0
  fi
  if [ "$a" = "kill-server" ]; then exit 0; fi
done
printf 'MARK\\n'
exit 0
`,
      { mode: 0o755 },
    );
  }

  // win32: `resolveOnPath` splits PATH on ':' and requires an absolute POSIX
  // element, which no Windows PATH satisfies — the whole command refuses on
  // the tmux probe long before that matters in production, but this test
  // drives the resolver directly and would fail red on the Windows lane.
  it.skipIf(process.platform === 'win32')(
    'resolves sleep to an absolute executable path',
    () => {
      // The plan embeds whatever this answers, so a walker that returns a bare
      // name or a directory would put one back in the pane's hands — silently,
      // because the holder only fails under a PATH that lacks sleep.
      const resolved = probes.sleepBin();
      expect(resolved).toBeDefined();
      expect(resolved?.startsWith('/')).toBe(true);
      expect(statSync(resolved as string).isFile()).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'skips PATH elements that are not absolute — the answer cannot depend on cwd',
    () => {
      // POSIX reads an EMPTY element as the current directory and resolves
      // relative ones against it; execvp honours both. The capture's cwd is
      // the REVIEWED WORKTREE, so either rule lets the PR under review
      // supply the binary the holder runs. A relative answer is also
      // re-resolved against the PANE's own `--cwd`, which puts the lookup
      // back exactly where resolving it here exists to take it from.
      const root = mkdtempSync(join(tmpdir(), 'capture-tui-pathrel-'));
      const before = process.cwd();
      const realPath = process.env['PATH'];
      try {
        mkdirSync(join(root, 'rel'), { recursive: true });
        writeFileSync(join(root, 'rel', 'sleep'), '#!/bin/sh\nexit 0\n', {
          mode: 0o755,
        });
        process.chdir(root);
        // Both non-absolute shapes, and a `sleep` execvp would find through
        // either of them.
        process.env['PATH'] = ':rel';
        expect(probes.sleepBin()).toBeUndefined();
        // The SAME directory named absolutely is taken — so this pins the
        // element's shape, not the planted file.
        process.env['PATH'] = join(root, 'rel');
        expect(probes.sleepBin()).toBe(join(root, 'rel', 'sleep'));
      } finally {
        process.chdir(before);
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'never probes a tmux the reviewed tree put in the way',
    () => {
      // The probe used to spawn a BARE name, and execvp honours the
      // empty-element rule the resolver refuses: an executable named `tmux`
      // committed to the PR would answer this probe and then every control
      // call after it — the attacker would BE the tmux, authoring the .ans
      // bytes and the manifest that the verdict machinery reads as
      // rendering evidence, with every `-L` scoping defence downstream of a
      // binary this command no longer chose.
      const root = mkdtempSync(join(tmpdir(), 'capture-tui-pathplant-'));
      const before = process.cwd();
      const realPath = process.env['PATH'];
      try {
        writeFileSync(
          join(root, 'tmux'),
          '#!/bin/sh\necho "tmux 9.9-PLANTED"\nexit 0\n',
          { mode: 0o755 },
        );
        mkdirSync(join(root, 'empty'), { recursive: true });
        process.chdir(root);
        // A legal PATH carrying an empty element, and nothing on it that
        // holds tmux.
        process.env['PATH'] = `:${join(root, 'empty')}`;
        expect(probes.tmux()).toEqual({ status: 'absent' });
        // Control: the same plant reached through an ABSOLUTE element still
        // answers — which is what every fake-tmux fixture in this file is —
        // so the refusal above is about the element, not the file.
        process.env['PATH'] = root;
        expect(probes.tmux()).toEqual({
          status: 'ok',
          out: 'tmux 9.9-PLANTED',
        });
      } finally {
        process.chdir(before);
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('identifies the stamped socket by more than its inode', () => {
    // An inode is not a durable name for a file: ext-family allocators hand
    // the freed number straight back on an immediate same-directory
    // recreate (measured 5/5 on a review host), so `rm` + recreate at the
    // socket path read as "still ours" and a verdict about the REPLACEMENT
    // was credited — the reap crediting a goal state about a socket this
    // run never owned. Pinned here rather than through a capture, because a
    // test cannot ask a filesystem to reuse an inode on demand: every one
    // a fixture can rely on hands out a fresh one, so the widened
    // comparison has no behavioural arm to reach it.
    const stamp = { ino: 7214321, mode: 0o140700, mtimeMs: 1_700_000_000_000 };
    expect(isSameSocket(stamp, { ...stamp })).toBe(true);
    // The inode-reuse shape: same number, different file.
    expect(isSameSocket(stamp, { ...stamp, mtimeMs: stamp.mtimeMs + 1 })).toBe(
      false,
    );
    // A regular file recreated where a socket stood keeps neither.
    expect(isSameSocket(stamp, { ...stamp, mode: 0o100644 })).toBe(false);
    // And the inode alone still counts.
    expect(isSameSocket(stamp, { ...stamp, ino: stamp.ino + 1 })).toBe(false);
  });

  it('opens artifact writes non-blocking — a FIFO must refuse, not wedge', () => {
    // The one flag here that a behavioural test cannot reach: O_NONBLOCK
    // only decides the outcome when a FIFO lands in the microseconds
    // between changed()'s lstat and the open, and a FIFO at any other
    // moment is caught by changed() as the occupant it is. Without it,
    // open(O_WRONLY) on a FIFO waits for a reader forever — on the main
    // thread, inside a synchronous syscall — so the machine-read refusal
    // contract breaks entirely and only an external SIGKILL ends the run.
    // Pinned at the flag set, which is the thing an edit would drop.
    expect(ARTIFACT_OPEN_FLAGS & fsConstants.O_WRONLY).toBeTruthy();
    expect(ARTIFACT_OPEN_FLAGS & fsConstants.O_CREAT).toBeTruthy();
    expect(ARTIFACT_OPEN_FLAGS & fsConstants.O_TRUNC).toBeTruthy();
    // Gated the way PRODUCTION degrades, not by skipping the whole test:
    // Windows exposes neither constant (node documents the eight it has),
    // and the flag set is built with `?? 0` for exactly that — so asserting
    // them unconditionally reddens the Windows lane over two flags that
    // legitimately contribute nothing there, while the three above stay
    // meaningful on every platform.
    for (const flag of [fsConstants.O_NOFOLLOW, fsConstants.O_NONBLOCK]) {
      if (typeof flag !== 'number') continue;
      expect(ARTIFACT_OPEN_FLAGS & flag).toBeTruthy();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'visits a base once even when two candidate strings name it',
    async () => {
      // The candidates are the env base and `/tmp`, and they were
      // de-duplicated as STRINGS — so `/tmp/`, `/tmp/.` or a TMUX_TMPDIR
      // symlinked to /tmp produced two visits to one base. That was
      // harmless while identity was a pre-loop snapshot; it is not now that
      // the verdict re-reads it, because the first visit credits and
      // UNLINKS, and the second would read the socket this reap had just
      // removed as a swap and warn about an orphan it reaped itself. Same
      // rule cleanup.ts's sweep already states for its own scan.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join('/tmp', 'capture-tui-alias-'));
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      const killLog = join(dir, 'kills');
      writeFileSync(
        join(binDir, 'tmux'),
        `#!/bin/sh
[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }
SRV=""; prev=""
for x in "$@"; do [ "$prev" = "-L" ] && SRV="$x"; prev="$x"; done
for a in "$@"; do
  if [ "$a" = "new-session" ]; then
    mkdir -p "\${TMUX_TMPDIR}/tmux-$(id -u)"
    : > "\${TMUX_TMPDIR}/tmux-$(id -u)/$SRV"
    s=$(printf '%s\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1)
    [ -n "$s" ] && : > "$s"
    exit 0
  fi
  if [ "$a" = "kill-server" ]; then
    printf '%s\n' "$TMUX_TMPDIR" >> '${killLog}'
    exit 0
  fi
done
printf 'MARK\n'
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      // A trailing slash: a different string, the same directory. The socket
      // this creates under the real tmux dir carries this run's own unique
      // name and the credited kill unlinks it again.
      process.env['TMUX_TMPDIR'] = '/tmp/';
      try {
        const { stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        const kills = existsSync(killLog)
          ? readFileSync(killLog, 'utf8').trim().split('\n')
          : [];
        expect(kills).toHaveLength(1);
        // And the run stays quiet: one visit, credited, nothing left to doubt.
        expect(stderr).not.toContain('WARNING');
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not let a kill that fell back to /tmp vouch for the start base',
    async () => {
      // `-L` PINS the socket base in the client's environment; it does not
      // bind tmux to it. An unusable base sends the client to /tmp — which
      // is why the failure path checks verdictExaminedBase before believing
      // a wording — and the success path had no equivalent: an exit 0 from a
      // kill aimed at a destroyed base was credited to that base. The
      // captured command destroys the base mid-window and binds a
      // sacrificial server at this run's unique name under /tmp; the
      // fallback kill exits 0, and the run's own server — alive behind its
      // removed socket, unreachable by `-L` and invisible to the readdir
      // sweep — was orphaned at exit 0 with nothing on stderr.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join('/tmp', 'capture-tui-fellback-'));
      const envBase = join(dir, 'scratch');
      mkdirSync(envBase);
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      // Binds under the START base so the stamp is taken there, destroys
      // that base while the capture runs, then answers every kill with
      // exit 0 the way a fallback kill against /tmp would.
      writeFileSync(
        join(binDir, 'tmux'),
        `#!/bin/sh
[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }
SRV=""; prev=""
for x in "$@"; do [ "$prev" = "-L" ] && SRV="$x"; prev="$x"; done
for a in "$@"; do
  if [ "$a" = "new-session" ]; then
    mkdir -p "\${TMUX_TMPDIR}/tmux-$(id -u)"
    : > "\${TMUX_TMPDIR}/tmux-$(id -u)/$SRV"
    s=$(printf '%s\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1)
    [ -n "$s" ] && : > "$s"
    exit 0
  fi
  if [ "$a" = "kill-server" ]; then exit 0; fi
done
rm -rf '${envBase}'
printf 'MARK\n'
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      process.env['TMUX_TMPDIR'] = envBase;
      try {
        const { stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBeUndefined();
        expect(stderr).toContain('WARNING');
        expect(stderr).toContain('may still be running');
        // And it says WHICH doubt: an operator told "kill-server failed
        // twice" would go looking for a wedged server.
        expect(stderr).toContain('could not reach the base this run started');
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reads the stamped identity at VERDICT time, not once before the loop',
    async () => {
      // The identity arm used to read a snapshot taken before the candidate
      // loop — which spans both bases' attempts, a retry and a 15s belt. A
      // daemonized survivor of the captured command (this file's documented
      // same-uid class; it knows the path from `$TMUX`) waits for the reap,
      // renames the LIVE socket away and leaves a creditable occupant at
      // the path: the stale snapshot still said "alive", the replacement's
      // goal-state verdict was credited, and the entry this capture never
      // wrote was unlinked — exit 0, no WARNING, the real server holding
      // its pane holder for up to three hours and invisible to the sweep.
      //
      // The sibling pin ('a socket that is not the stamped one') cannot
      // catch this: its own start base is credited either way, and it goes
      // red only through the fallback base. Here BOTH bases answer a
      // creditable wording, so the verdict-time read is the only thing
      // between the swap and a silent orphan.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join('/tmp', 'capture-tui-verdictid-'));
      const envBase = join(dir, 'scratch');
      mkdirSync(envBase);
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, 'tmux'),
        `#!/bin/sh
[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }
SRV=""; prev=""
for x in "$@"; do [ "$prev" = "-L" ] && SRV="$x"; prev="$x"; done
for a in "$@"; do
  if [ "$a" = "new-session" ]; then
    mkdir -p "\${TMUX_TMPDIR}/tmux-$(id -u)"
    : > "\${TMUX_TMPDIR}/tmux-$(id -u)/$SRV"
    s=$(printf '%s\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1)
    [ -n "$s" ] && : > "$s"
    exit 0
  fi
  if [ "$a" = "kill-server" ]; then
    p="\${TMUX_TMPDIR}/tmux-$(id -u)/$SRV"
    # The swap lands DURING the kill — after any pre-loop snapshot, before
    # the verdict this answer produces.
    # By RENAME, not rm-then-create: an inode is not a durable file name —
    # ext-family allocators hand the freed number straight back on an
    # immediate same-directory recreate, so rm+create can land the swap on
    # the SAME inode and the fixture would then be pinning nothing on those
    # filesystems while passing on tmpfs/APFS.
    if [ "$TMUX_TMPDIR" = "${envBase}" ]; then q="$p.swap"; : > "$q"; rm -f "$p"; mv -f "$q" "$p"; fi
    echo "no server running on $p" >&2
    exit 1
  fi
done
printf 'MARK\n'
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      process.env['TMUX_TMPDIR'] = envBase;
      try {
        const { stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBeUndefined();
        expect(stderr).toContain('WARNING');
        expect(stderr).toContain('may still be running');
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a start that THREW still warns — the ENOENT wording buys doubt, not death',
    async () => {
      // The ENOENT class says the socket path was gone when the client
      // looked, and nothing else. Two proxies for "so the server never
      // existed" were tried here and both conflated: an absent stamp is
      // also absent when the stamp failed AFTER a successful start, and
      // `startThrew` is also set for a belt-cut start that threw with the
      // server already forked and its socket bound — the shape this file
      // documents at the start call. On a real tmux, `rm` of a live
      // server's socket answers this exact wording while `kill -0` shows it
      // alive, and the captured command is the thing that removes it. So
      // the class credits nothing on any base: a refusal that cannot prove
      // the server is gone says so, at the cost of a warning in the shape
      // where it truly never came up.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join('/tmp', 'capture-tui-startthrew-'));
      const envBase = join(dir, 'scratch');
      mkdirSync(envBase);
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      // start FAILS and binds nothing the stamp could see; every kill then
      // answers the ENOENT class.
      writeFileSync(
        join(binDir, 'tmux'),
        `#!/bin/sh
[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }
SRV=""; prev=""
for x in "$@"; do [ "$prev" = "-L" ] && SRV="$x"; prev="$x"; done
for a in "$@"; do
  if [ "$a" = "new-session" ]; then
    echo "start refused" >&2
    exit 1
  fi
  if [ "$a" = "kill-server" ]; then
    echo "error connecting to \${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$SRV (No such file or directory)" >&2
    exit 1
  fi
done
printf 'MARK\n'
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      process.env['TMUX_TMPDIR'] = envBase;
      try {
        const { stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBe(3);
        expect(stderr).toContain('WARNING');
        expect(stderr).toContain('may still be running');
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'never connects the kill on another base when a stamp proves the bind',
    async () => {
      // A stamp proves the bind was on the start base — the same fact
      // `confirmedDead` leans on. So a socket at this run's unique name on
      // ANY OTHER candidate base cannot be ours, and the pinned kill must
      // not connect to it. Without this the identity arm was gated on the
      // start base, and a plain foreign socket renamed onto the name under
      // /tmp passed the symlink/nlink tests and took the kill — the user's
      // own server destroyed, exit 0, no WARNING.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const uid = String(process.getuid?.());
      const dir = mkdtempSync(join('/tmp', 'capture-tui-crossbind-'));
      const envBase = join(dir, 'scratch');
      mkdirSync(envBase);
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      const killLog = join(dir, 'kills');
      const srvFile = join(dir, 'srv');
      // Binds under the START base (stamp), records the server name, and
      // ALSO drops a foreign entry at this run's name under /tmp — the
      // renamed-foreign-socket shape. Every kill-server records the base it
      // was invoked under.
      writeFileSync(
        join(binDir, 'tmux'),
        `#!/bin/sh
[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }
SRV=""; prev=""
for x in "$@"; do [ "$prev" = "-L" ] && SRV="$x"; prev="$x"; done
for a in "$@"; do
  if [ "$a" = "new-session" ]; then
    mkdir -p "\${TMUX_TMPDIR}/tmux-${uid}"
    : > "\${TMUX_TMPDIR}/tmux-${uid}/$SRV"
    printf '%s' "$SRV" > '${srvFile}'
    mkdir -p /tmp/tmux-${uid}
    : > /tmp/tmux-${uid}/"$SRV"
    s=$(printf '%s\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1)
    [ -n "$s" ] && : > "$s"
    exit 0
  fi
  if [ "$a" = "kill-server" ]; then
    printf '%s\n' "$TMUX_TMPDIR" >> '${killLog}'
    exit 0
  fi
done
printf 'MARK\n'
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      process.env['TMUX_TMPDIR'] = envBase;
      try {
        await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        const killedBases = existsSync(killLog)
          ? readFileSync(killLog, 'utf8').trim().split('\n')
          : [];
        // The start base is killed; the OTHER base (/tmp), where a socket
        // stands at this run's name with a stamp proving we did not bind
        // there, is NEVER connected to.
        // The start base is killed; the OTHER base (/tmp), where a socket
        // stands at this run's name with a stamp proving we did not bind
        // there, is NEVER connected to — pre-fix it was, destroying it.
        expect(killedBases).toContain(envBase);
        expect(killedBases).not.toContain('/tmp');
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        // Remove the foreign entry this test planted under the real /tmp.
        try {
          const srv = readFileSync(srvFile, 'utf8').trim();
          if (srv) rmSync(join('/tmp', `tmux-${uid}`, srv), { force: true });
        } catch {
          // Nothing planted, or already gone.
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not let a kill on another base vouch for the start base',
    async () => {
      // A successful kill used to establish death GLOBALLY on the strength
      // of the server name being unique to this run. Unique is not
      // exclusive here: the captured command reads that name from `$TMUX`
      // and can bind a sacrificial server under the OTHER candidate base,
      // whose exit-0 kill then vouched for a server it never touched and
      // silenced the orphan WARNING for the real one. A present stamp
      // proves the bind happened on the start base, so a success anywhere
      // else cannot be this run's.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join('/tmp', 'capture-tui-crossbase-'));
      const envBase = join(dir, 'scratch');
      mkdirSync(envBase);
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      // Binds under the START base (so the stamp is taken there), then
      // answers the start base's kill with the ENOENT class — the shape of
      // a live server whose socket was removed — while the OTHER base's
      // kill exits 0, as a sacrificial server's would.
      writeFileSync(
        join(binDir, 'tmux'),
        `#!/bin/sh
[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }
SRV=""; prev=""
for x in "$@"; do [ "$prev" = "-L" ] && SRV="$x"; prev="$x"; done
for a in "$@"; do
  if [ "$a" = "new-session" ]; then
    mkdir -p "\${TMUX_TMPDIR}/tmux-$(id -u)"
    : > "\${TMUX_TMPDIR}/tmux-$(id -u)/$SRV"
    s=$(printf '%s\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1)
    [ -n "$s" ] && : > "$s"
    exit 0
  fi
  if [ "$a" = "kill-server" ]; then
    if [ "$TMUX_TMPDIR" = "${envBase}" ]; then
      echo "error connecting to $TMUX_TMPDIR/tmux-$(id -u)/$SRV (No such file or directory)" >&2
      exit 1
    fi
    exit 0
  fi
done
printf 'MARK\n'
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      process.env['TMUX_TMPDIR'] = envBase;
      try {
        const { stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        // The capture succeeds; what must not happen is the silence.
        expect(process.exitCode).toBeUndefined();
        expect(stderr).toContain('WARNING');
        expect(stderr).toContain('may still be running');
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('refuses a capture whose holder would have no sleep to run', async () => {
    // The holder's watchdog (`sleep 10800`) and bounded hold loop
    // (`sleep 60` x 180) are what keep the pane open. Resolved bare, they
    // went through the PANE's inherited PATH, and under a PATH that finds
    // tmux but not sleep the watchdog exited 127 in milliseconds and fell
    // straight into `kill -9 -$$` — the whole pane process group SIGKILLed,
    // the capture window collapsed to ~0ms, and the evidence read as "the
    // command rendered nothing" with nothing naming the cause. Refuse up
    // front instead, before any server exists.
    probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
    const realSleepProbe = probes.sleepBin;
    probes.sleepBin = () => undefined;
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-nosleep-'));
    try {
      const { stdout, stderr } = await withStdio(() =>
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
      );
      expect(process.exitCode).toBe(3);
      expect(stderr).toContain('sleep is not on PATH');
      expect(JSON.parse(stdout.trim())).toEqual({
        captured: false,
        evidence: 'none',
        reason: expect.stringContaining('sleep is not on PATH'),
      });
      // "Nothing was started" is part of the refusal's claim.
      expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
      expect(existsSync(join(dir, 'cap.json'))).toBe(false);
      expect(leakedSentinels()).toEqual([]);
    } finally {
      probes.sleepBin = realSleepProbe;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'does not credit an ENOENT verdict when the STAMP merely failed',
    async () => {
      // An absent stamp is TWO states and only one of them is "start never
      // bound a socket": it is also absent when the stamp failed after a
      // SUCCESSFUL start (this file's own `startThrew` declaration says so,
      // and the captured command can produce it by unlinking the socket it
      // reaches through `$TMUX`). Crediting the ENOENT wording there read a
      // live server as reaped — exit 0, no WARNING, server and holder
      // orphaned for the holder's whole window and invisible to the
      // readdir-based sweep, which discovers orphans by the socket that
      // this state has already lost. `startThrew` separates the two.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join('/tmp', 'capture-tui-stampfail-'));
      const envBase = join(dir, 'scratch');
      mkdirSync(envBase);
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      // Starts fine and binds NOTHING the stamp can see, then answers every
      // kill with the ENOENT class — the shape of a server whose socket is
      // gone while the server itself stands.
      writeFileSync(
        join(binDir, 'tmux'),
        `#!/bin/sh
[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }
for a in "$@"; do
  if [ "$a" = "new-session" ]; then
    s=$(printf '%s\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1)
    [ -n "$s" ] && : > "$s"
    exit 0
  fi
  if [ "$a" = "kill-server" ]; then
    SRV=""; prev=""
    for x in "$@"; do [ "$prev" = "-L" ] && SRV="$x"; prev="$x"; done
    echo "error connecting to \${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$SRV (No such file or directory)" >&2
    exit 1
  fi
done
printf 'MARK\n'
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      process.env['TMUX_TMPDIR'] = envBase;
      try {
        const { stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        // The capture itself still succeeds — this is about what the reap
        // is entitled to claim afterwards, not about failing the run.
        expect(process.exitCode).toBeUndefined();
        expect(existsSync(join(dir, 'cap.json'))).toBe(true);
        expect(stderr).toContain('WARNING');
        expect(stderr).toContain('kill-server failed twice');
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses to connect to an entry it has no recorded identity for',
    async () => {
      // The identity half of the entry guard compares against the stamp, so
      // an ABSENT stamp silently disabled it: a plain foreign socket bound
      // at this run's own unique name passed "not a symlink" and "one link"
      // and took the pinned kill. Absent-stamp is reachable without any
      // race — a start that bound under the other base, or a stamp lstat
      // that failed — so the check fails closed: an entry standing on the
      // start base that this run cannot show is its own is not connected
      // to, and the WARNING carries the manual reap command.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join('/tmp', 'capture-tui-nostamp-'));
      const envBase = join(dir, 'scratch');
      mkdirSync(envBase);
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      const killLog = join(dir, 'kills');
      // Binds nothing at start (so the stamp finds nothing), then an entry
      // APPEARS at the start base while the capture runs.
      writeFileSync(
        join(binDir, 'tmux'),
        `#!/bin/sh
[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }
SRV=""; prev=""
for x in "$@"; do [ "$prev" = "-L" ] && SRV="$x"; prev="$x"; done
for a in "$@"; do
  if [ "$a" = "new-session" ]; then
    s=$(printf '%s\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1)
    [ -n "$s" ] && : > "$s"
    exit 0
  fi
  if [ "$a" = "kill-server" ]; then
    printf '%s\n' "$TMUX_TMPDIR" >> '${killLog}'
    echo "error connecting to \${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$SRV (No such file or directory)" >&2
    exit 1
  fi
done
mkdir -p "\${TMUX_TMPDIR}/tmux-$(id -u)"
: > "\${TMUX_TMPDIR}/tmux-$(id -u)/$SRV"
printf 'MARK\n'
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      process.env['TMUX_TMPDIR'] = envBase;
      try {
        const { stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        const killedBases = existsSync(killLog)
          ? readFileSync(killLog, 'utf8').trim().split('\n')
          : [];
        // The start base carries an entry with no recorded identity: never
        // connected to...
        expect(killedBases).not.toContain(envBase);
        // ...while the base that carries no entry at all is still killed,
        // which is what separates a refusal from a reap that never ran.
        expect(killedBases).toContain('/tmp');
        expect(stderr).toContain('the reap refused to connect');
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'never connects a kill through an entry this capture did not bind',
    async () => {
      // The reap addresses the socket by NAME and tmux connects to whatever
      // that name resolves to. The captured command runs under this uid —
      // untrusted code is what a review captures — and knows the path from
      // `$TMUX`; a HARD LINK planted there aims the pinned kill-server at
      // another server, which dies with exit 0 while `confirmedDead` credits
      // the success globally and nothing warns. That is this command's
      // headline premise failing, so the entry is inspected first, exactly
      // as the sibling sweep in cleanup.ts inspects its own.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const uid = process.getuid?.();
      // Short base by necessity: a unix socket path is capped near 104 bytes,
      // and the default mkdtemp parent plus a capture server name overruns it.
      const base = mkdtempSync('/tmp/ctui-r111-');
      const sockDir = join(base, `tmux-${String(uid)}`);
      mkdirSync(sockDir, { recursive: true, mode: 0o700 });
      // A FOREIGN server's socket — what the planted link would aim at. A
      // real one, because the guard's question is the entry's type and link
      // count, and a regular file would answer a weaker one.
      const foreign = join(sockDir, 'foreign');
      const foreignServer = createServer();
      await new Promise<void>((resolveListen) => {
        foreignServer.listen(foreign, () => resolveListen());
      });
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-r111-'));
      const killLog = join(dir, 'kills');
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      // The shim plants at new-session — the earliest moment the server name
      // exists — and records the base of every kill it is asked to make.
      writeFileSync(
        join(binDir, 'tmux'),
        `#!/bin/sh
[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }
for a in "$@"; do
  if [ "$a" = "new-session" ]; then
    srv=$(printf '%s\\n' "$@" | grep -o 'qwen-review-capture-[0-9]*-[0-9a-f]*' | head -1)
    [ -n "$srv" ] && ln '${foreign}' '${sockDir}'/"$srv"
    s=$(printf '%s\\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1)
    [ -n "$s" ] && : > "$s"
    exit 0
  fi
  if [ "$a" = "kill-server" ]; then
    printf '%s\\n' "$TMUX_TMPDIR" >> '${killLog}'
    exit 0
  fi
done
printf 'MARK\\n'
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      process.env['TMUX_TMPDIR'] = base;
      try {
        await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: undefined,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 5000,
          } as never),
        );
        const killedBases = existsSync(killLog)
          ? readFileSync(killLog, 'utf8').trim().split('\n')
          : [];
        // The planted base is never connected to...
        expect(killedBases).not.toContain(base);
        // ...while the untouched fallback base still gets its kill, which is
        // what separates "the guard refused" from "the reap never ran".
        expect(killedBases).toContain('/tmp');
        // And the entry is left standing: it may BE the foreign socket,
        // reached through the link, so unlinking it is not this run's to do.
        const planted = readdirSync(sockDir).filter((n) =>
          n.startsWith('qwen-review-capture-'),
        );
        expect(planted).toHaveLength(1);
        expect(lstatSync(join(sockDir, planted[0])).nlink).toBe(2);
        // The foreign server is untouched — the whole point.
        expect(lstatSync(foreign).isSocket()).toBe(true);
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        foreignServer.close();
        rmSync(base, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not render THROUGH a symlink planted at <out>.png mid-window',
    async () => {
      // The png stamp is taken before the window, and the ladder used to
      // consult nothing but it: an occupant arriving at <out>.png during
      // the window was written through by freeze (following the link out
      // of the --out base), the exact escape writeArtifact's changed()
      // closes for the .ans and the manifest. The ladder must decide
      // occupancy AGAIN at render time.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const realFreezeProbe = probes.freeze;
      probes.freeze = () => ({ status: 'ok', out: '' }) as const;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-pngsym-'));
      const outside = join(dir, 'victim.txt');
      writeFileSync(outside, 'VICTIM-CONTENT');
      writeFakeTmux(dir, `    ln -s '${outside}' '${join(dir, 'cap.png')}'`);
      const freezeBin = join(dir, 'fakebin', 'freeze');
      writeFileSync(
        freezeBin,
        '#!/bin/sh\nprintf \'PNG-BYTES\' > "$5"\nexit 0\n',
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realBin = freezeRender.bin;
      process.env['PATH'] = `${join(dir, 'fakebin')}:${realPath ?? ''}`;
      freezeRender.bin = freezeBin;
      try {
        await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBeUndefined();
        // The link's target never received the render...
        expect(readFileSync(outside, 'utf8')).toBe('VICTIM-CONTENT');
        // ...and the link itself is not ours to remove.
        expect(lstatSync(join(dir, 'cap.png')).isSymbolicLink()).toBe(true);
        const manifest = JSON.parse(
          readFileSync(join(dir, 'cap.json'), 'utf8'),
        );
        expect(manifest.evidence).toBe('ans-only');
        expect(manifest.pngPath).toBeNull();
        expect(manifest.degradedBecause).toContain(
          'holds a file this capture did not write',
        );
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        freezeRender.bin = realBin;
        probes.freeze = realFreezeProbe;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not DELETE a file planted at <out>.png mid-window when the render fails',
    async () => {
      // The sibling harm on the failed-render cleanup: it removes the png
      // only when `changed()` credits it to this run, but with no occupant
      // stamped before the window, a file the captured command planted
      // mid-window counted as ours and was silently deleted on a run that
      // reported success.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const realFreezeProbe = probes.freeze;
      probes.freeze = () => ({ status: 'ok', out: '' }) as const;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-pngplant-'));
      writeFakeTmux(
        dir,
        `    printf 'PLANTED-BY-COMMAND' > '${join(dir, 'cap.png')}'`,
      );
      const freezeBin = join(dir, 'fakebin', 'freeze');
      writeFileSync(freezeBin, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
      const realPath = process.env['PATH'];
      const realBin = freezeRender.bin;
      process.env['PATH'] = `${join(dir, 'fakebin')}:${realPath ?? ''}`;
      freezeRender.bin = freezeBin;
      try {
        await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBeUndefined();
        expect(readFileSync(join(dir, 'cap.png'), 'utf8')).toBe(
          'PLANTED-BY-COMMAND',
        );
        const manifest = JSON.parse(
          readFileSync(join(dir, 'cap.json'), 'utf8'),
        );
        expect(manifest.evidence).toBe('ans-only');
        expect(manifest.pngPath).toBeNull();
        expect(manifest.degradedBecause).toContain(
          'holds a file this capture did not write',
        );
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        freezeRender.bin = realBin;
        probes.freeze = realFreezeProbe;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'leaves a TORN png when the render fails — deletion cannot attribute it',
    async () => {
      // Sibling of the plant test above for the occupant THIS run's
      // freeze wrote: a torn png at the path the manifest is about to
      // deny is indistinguishable from a foreign file claimed during the
      // probe/render window — an empty pre-window stamp makes changed()
      // reduce to occupied() — and deleting on presence alone destroyed
      // the foreign shape (probe-reproduced). The sibling manifest-write
      // cleanup already spares the png whenever the render produced
      // nothing; the failed-render arm keeps its hands off too and names
      // the leftover.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const realFreezeProbe = probes.freeze;
      probes.freeze = () => ({ status: 'ok', out: '' }) as const;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-pngtorn-'));
      writeFakeTmux(dir, '    :');
      const freezeBin = join(dir, 'fakebin', 'freeze');
      writeFileSync(freezeBin, '#!/bin/sh\nprintf torn > "$5"\nexit 9\n', {
        mode: 0o755,
      });
      const realPath = process.env['PATH'];
      const realBin = freezeRender.bin;
      process.env['PATH'] = `${join(dir, 'fakebin')}:${realPath ?? ''}`;
      freezeRender.bin = freezeBin;
      try {
        await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBeUndefined();
        const manifest = JSON.parse(
          readFileSync(join(dir, 'cap.json'), 'utf8'),
        );
        expect(manifest.evidence).toBe('ans-only');
        expect(manifest.pngPath).toBeNull();
        expect(readFileSync(join(dir, 'cap.png'), 'utf8')).toBe('torn');
        expect(manifest.degradedBecause).toContain('left in place');
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        freezeRender.bin = realBin;
        probes.freeze = realFreezeProbe;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'spares a spared png the owner rewrote when the MANIFEST write fails',
    async () => {
      // The clear phase left the user's png (no manifest proved ownership)
      // and the ladder degraded on the stamp — png null, never touched.
      // The owner rewriting their own file inside the window then
      // answered changed() true, and the manifest-write cleanup deleted a
      // file the ladder had classified as not ours: changed() answers
      // "the occupant changed", not "this run put it there"
      // (probe-reproduced; no adversarial race — the window legally runs
      // up to an hour). The plant stands in for the owner's rewrite AND
      // for the manifest write failing, so the shape needs no real tmux.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-pngspare-'));
      writeFileSync(join(dir, 'cap.png'), 'USER-ORIGINAL');
      writeFakeTmux(
        dir,
        `    printf 'USER-REWRITTEN-BY-OWNER' > '${join(dir, 'cap.png')}'\n    mkdir '${join(dir, 'cap.json')}'`,
      );
      const realPath = process.env['PATH'];
      process.env['PATH'] = `${join(dir, 'fakebin')}:${realPath ?? ''}`;
      try {
        const { stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBe(3);
        expect(stderr).toContain('cannot write capture manifest');
        expect(readFileSync(join(dir, 'cap.png'), 'utf8')).toBe(
          'USER-REWRITTEN-BY-OWNER',
        );
        // The cleanup DID run — the .ans this run wrote is gone with it,
        // and the collision occupant is never ours to remove.
        expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
        expect(statSync(join(dir, 'cap.json')).isDirectory()).toBe(true);
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not land a render THROUGH a symlink planted during the render window',
    async () => {
      // The pngsym sibling plants its link during the CAPTURE; this one
      // plants it inside the render itself — the check-then-write window
      // the pre-staging ladder left open (probe-verified on freeze v0.2.2:
      // freeze opens the OUTPUT name it is given and follows the link).
      // The render writes a nonce'd sibling and lands by rename, and a
      // claimant at the landing path degrades the ladder instead of being
      // replaced.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const realFreezeProbe = probes.freeze;
      probes.freeze = () => ({ status: 'ok', out: '' }) as const;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-pngland-'));
      const outside = join(dir, 'victim.txt');
      writeFileSync(outside, 'VICTIM-CONTENT');
      writeFakeTmux(dir, '    :');
      const freezeBin = join(dir, 'fakebin', 'freeze');
      writeFileSync(
        freezeBin,
        `#!/bin/sh
ln -s '${outside}' '${join(dir, 'cap.png')}'
printf 'PNG-BYTES' > "$5"
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realBin = freezeRender.bin;
      process.env['PATH'] = `${join(dir, 'fakebin')}:${realPath ?? ''}`;
      freezeRender.bin = freezeBin;
      try {
        await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBeUndefined();
        expect(readFileSync(outside, 'utf8')).toBe('VICTIM-CONTENT');
        expect(lstatSync(join(dir, 'cap.png')).isSymbolicLink()).toBe(true);
        const manifest = JSON.parse(
          readFileSync(join(dir, 'cap.json'), 'utf8'),
        );
        expect(manifest.evidence).toBe('ans-only');
        expect(manifest.pngPath).toBeNull();
        expect(manifest.degradedBecause).toContain(
          'holds a file this capture did not write',
        );
        // The nonce'd stage never outlives the run.
        expect(readdirSync(dir).filter((f) => f.includes('.render-'))).toEqual(
          [],
        );
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        freezeRender.bin = realBin;
        probes.freeze = realFreezeProbe;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'stages the render INPUT under a nonce — freeze never reads the .ans by name',
    async () => {
      // A swap of the .ans during the probe window fed foreign bytes to a
      // by-name render input (probe-verified): the staged hard link pins
      // the bytes this run wrote under a name only this run knows. The
      // fake refuses to render from the literal .ans name — the
      // pre-staging argv fails it.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const realFreezeProbe = probes.freeze;
      probes.freeze = () => ({ status: 'ok', out: '' }) as const;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-ansstage-'));
      writeFakeTmux(dir, '    :');
      const freezeBin = join(dir, 'fakebin', 'freeze');
      writeFileSync(
        freezeBin,
        `#!/bin/sh
[ "$3" = '${join(dir, 'cap.ans')}' ] && { echo "render read the .ans by name" >&2; exit 9; }
[ -s "$3" ] || { echo "render input missing" >&2; exit 9; }
printf 'x' > "$5"
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realBin = freezeRender.bin;
      process.env['PATH'] = `${join(dir, 'fakebin')}:${realPath ?? ''}`;
      freezeRender.bin = freezeBin;
      try {
        await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBeUndefined();
        const manifest = JSON.parse(
          readFileSync(join(dir, 'cap.json'), 'utf8'),
        );
        expect(manifest.evidence).toBe('png');
        expect(readdirSync(dir).filter((f) => f.includes('.render-'))).toEqual(
          [],
        );
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        freezeRender.bin = realBin;
        probes.freeze = realFreezeProbe;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'degrades rather than falsely claiming a swap when staging itself fails',
    async () => {
      // R20-2 set `ansLost` unconditionally in the staging catch, conflating
      // a real swap with `linkSync` ITSELF failing — a host with no link()
      // (exFAT/FAT/WSL DrvFs), or ENOSPC/EACCES on the stage's directory
      // entry. There the .ans this run wrote is intact, so refusing with
      // "replaced during the render window" is factually false and wedges
      // the --out for every later capture. Identity decides: an intact .ans
      // is a stage failure to degrade past, not a swap to refuse over.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const realFreezeProbe = probes.freeze;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-stagefail-'));
      writeFakeTmux(dir, '    :');
      const realPath = process.env['PATH'];
      process.env['PATH'] = `${join(dir, 'fakebin')}:${realPath ?? ''}`;
      // Make the --out directory unwritable DURING the render window, after
      // the .ans is already on disk: the stage linkSync then fails with
      // EACCES while <out>.ans stays exactly the bytes this run wrote. (A
      // read-only dir also fails the manifest write, so the run still
      // refuses — but for the honest reason, never the fabricated swap.)
      probes.freeze = () => {
        chmodSync(dir, 0o500);
        return { status: 'ok', out: '' } as const;
      };
      try {
        const { stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        // The staging failed on an intact .ans — never the false swap claim
        // that stranded it and wedged the --out.
        expect(stderr).not.toContain('replaced while the render');
        expect(stderr).not.toContain('replaced during the render window');
      } finally {
        chmodSync(dir, 0o700);
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        probes.freeze = realFreezeProbe;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a render input rewritten IN PLACE — the inode never changed',
    async () => {
      // The sibling below swaps the file; this one rewrites it. The staging
      // check pinned its input by inode alone, and an in-place rewrite keeps
      // the inode by definition — no allocator reuse needed, nothing to
      // race. So an actor that truncates and rewrites <out>.ans inside the
      // stamp→link window (which spans the whole freeze availability probe)
      // had its bytes staged, rendered and credited at the publishable png
      // rung, with a manifest naming both artifacts: a complete evidence
      // forgery reported as success. Identity here is now the comparison
      // `changed()` and isSameSocket already make — ino, size and mtime —
      // and size and mtime are exactly what an in-place rewrite moves.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const realFreezeProbe = probes.freeze;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-inplace-'));
      writeFakeTmux(dir, '    :');
      const freezeBin = join(dir, 'fakebin', 'freeze');
      const rendered = join(dir, 'freeze-ran');
      writeFileSync(
        freezeBin,
        `#!/bin/sh\ncat "$3" > "$5"\n: > '${rendered}'\nexit 0\n`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realBin = freezeRender.bin;
      process.env['PATH'] = `${join(dir, 'fakebin')}:${realPath ?? ''}`;
      freezeRender.bin = freezeBin;
      let inodeHeld = false;
      probes.freeze = () => {
        const ans = join(dir, 'cap.ans');
        const before = lstatSync(ans).ino;
        // Same file, new bytes — the shape an inode comparison cannot see.
        writeFileSync(ans, 'FORGED-EVIDENCE-BYTES-FORGED-EVIDENCE-BYTES');
        inodeHeld = lstatSync(ans).ino === before;
        return { status: 'ok', out: '' } as const;
      };
      try {
        const { stdout } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        // The premise: the inode really did survive the rewrite, so an
        // inode-only check would have passed these bytes through.
        expect(inodeHeld).toBe(true);
        // ino+size+mtime catches it, and a .ans that is no longer this run's
        // is no honest evidence: the run REFUSES rather than credit the
        // forged bytes or mint the signature that would delete them.
        expect(process.exitCode).toBe(3);
        expect(JSON.parse(stdout.trim())).toEqual({
          captured: false,
          evidence: 'none',
          reason: expect.stringContaining('replaced during the render window'),
        });
        expect(existsSync(join(dir, 'cap.json'))).toBe(false);
        // freeze never saw the staged input, and the forged file is left in
        // place (not ours to delete), just never credited.
        expect(existsSync(rendered)).toBe(false);
        expect(readFileSync(join(dir, 'cap.ans'), 'utf8')).toBe(
          'FORGED-EVIDENCE-BYTES-FORGED-EVIDENCE-BYTES',
        );
        expect(readdirSync(dir).filter((f) => f.includes('.render-'))).toEqual(
          [],
        );
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        freezeRender.bin = realBin;
        probes.freeze = realFreezeProbe;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    "refuses a symlink swapped in for the .ans before staging — neither platform's link() refuses it",
    async () => {
      // The staging comment claimed link() refuses a symlinked ansPath
      // with ELOOP; neither platform does. Measured on Linux it CLONES the
      // link, so a survivor swapping ansPath for a symlink during the probe
      // window (a fresh freeze availability probe — seconds, not
      // microseconds) staged the link intact and freeze rendered the
      // victim's bytes, credited as "evidence": "png" (probe-verified end
      // to end). Measured on darwin it FOLLOWS the link instead, staging a
      // hard link to the victim's own inode — a regular file, so a
      // type-only guard passes it and the same bytes are credited. Identity
      // is what refuses both: the stage must name the inode this run's own
      // .ans write produced.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const realFreezeProbe = probes.freeze;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-anssym-'));
      const victim = join(dir, 'victim.txt');
      writeFileSync(victim, 'FOREIGN-VICTIM-BYTES');
      writeFakeTmux(dir, '    :');
      const freezeBin = join(dir, 'fakebin', 'freeze');
      const rendered = join(dir, 'freeze-ran');
      writeFileSync(
        freezeBin,
        // Reads the staged input by name — following a symlink exactly
        // like the real freeze (measured on v0.2.2) — and records that it
        // ran at all.
        `#!/bin/sh\ncat "$3" > "$5"\n: > '${rendered}'\nexit 0\n`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realBin = freezeRender.bin;
      process.env['PATH'] = `${join(dir, 'fakebin')}:${realPath ?? ''}`;
      freezeRender.bin = freezeBin;
      // The swap rides the freeze AVAILABILITY probe: it runs after the
      // .ans is on disk and before the staging linkSync — the seconds-long
      // window the survivor class plants in.
      probes.freeze = () => {
        rmSync(join(dir, 'cap.ans'));
        symlinkSync(victim, join(dir, 'cap.ans'));
        return { status: 'ok', out: '' } as const;
      };
      try {
        const { stdout } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        // A .ans no longer this run's is no honest evidence: the run REFUSES
        // rather than credit or delete the foreign file (a manifest crediting
        // it would also mint the clear signature that deletes it next run).
        expect(process.exitCode).toBe(3);
        expect(JSON.parse(stdout.trim())).toEqual({
          captured: false,
          evidence: 'none',
          reason: expect.stringContaining('replaced during the render window'),
        });
        // No manifest is written on a refusal — that is what keeps 'none' out
        // of any manifest and off the clear-phase signature.
        expect(existsSync(join(dir, 'cap.json'))).toBe(false);
        // freeze never saw the staged input, and the victim is untouched.
        expect(existsSync(rendered)).toBe(false);
        expect(readFileSync(victim, 'utf8')).toBe('FOREIGN-VICTIM-BYTES');
        // The link this run's linkSync staged is this run's to remove.
        expect(readdirSync(dir).filter((f) => f.includes('.render-'))).toEqual(
          [],
        );
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        freezeRender.bin = realBin;
        probes.freeze = realFreezeProbe;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a stage replaced by a directory during the render does not mask the capture result',
    async () => {
      // The stage-removal rmSync pair in the render finally was the only
      // unguarded fs operation in runCaptureTui: an actor with write access
      // to the --out directory (the class the clear phase and collision
      // gate exist for) replacing a stage with a directory mid-render made
      // the finally throw EISDIR out of the function — exit 1, a stack
      // trace, no contract JSON, and drainSignalsThenRelease never ran.
      // Litter is cosmetic; the capture's result is not.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const realFreezeProbe = probes.freeze;
      probes.freeze = () => ({ status: 'ok', out: '' }) as const;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-stagedir-'));
      writeFakeTmux(dir, '    :');
      const freezeBin = join(dir, 'fakebin', 'freeze');
      writeFileSync(
        freezeBin,
        `#!/bin/sh
rm -f "$3" && mkdir "$3"
printf 'x' > "$5"
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realBin = freezeRender.bin;
      process.env['PATH'] = `${join(dir, 'fakebin')}:${realPath ?? ''}`;
      freezeRender.bin = freezeBin;
      try {
        const { stdout } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBeUndefined();
        const manifest = JSON.parse(
          readFileSync(join(dir, 'cap.json'), 'utf8'),
        );
        expect(manifest.evidence).toBe('png');
        expect(JSON.parse(stdout)).toMatchObject({ captured: true });
        // The planted directory is another actor's — left in place, never
        // recursively deleted, and the run still completed its contract.
        const litter = readdirSync(dir).filter((f) => f.includes('.render-'));
        expect(litter).toHaveLength(1);
        expect(lstatSync(join(dir, litter[0])).isDirectory()).toBe(true);
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        freezeRender.bin = realBin;
        probes.freeze = realFreezeProbe;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'records the -T caveat — erased cells still capture as trailing spaces',
    async () => {
      // -T trims only positions that never held a character; cells written
      // and later erased still capture as trailing spaces on the very
      // versions that take the flag, and the joined marker view carries
      // them mid-line (measured on 3.4) — so the manifest carries the
      // caveat the way the pad case does.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const realFreezeProbe = probes.freeze;
      probes.freeze = () => ({ status: 'ok', out: '' }) as const;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-tcaveat-'));
      writeFakeTmux(dir, '    :');
      const freezeBin = join(dir, 'fakebin', 'freeze');
      writeFileSync(freezeBin, '#!/bin/sh\nprintf x > "$5"\nexit 0\n', {
        mode: 0o755,
      });
      const realPath = process.env['PATH'];
      const realBin = freezeRender.bin;
      process.env['PATH'] = `${join(dir, 'fakebin')}:${realPath ?? ''}`;
      freezeRender.bin = freezeBin;
      try {
        await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBeUndefined();
        const manifest = JSON.parse(
          readFileSync(join(dir, 'cap.json'), 'utf8'),
        );
        expect(manifest.degradedBecause).toContain(
          'trims only never-written trailing positions',
        );
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        freezeRender.bin = realBin;
        probes.freeze = realFreezeProbe;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reaps where the server ACTUALLY lives when the socket base moves mid-window',
    async () => {
      // tmux resolves the socket base from the CLIENT's environment at kill
      // time, but the server starts under the first USABLE base: a stale
      // TMUX_TMPDIR pointing at an unusable path puts the socket under /tmp,
      // and when the env base becomes usable before the reap, a bare kill
      // answers tmux's "nothing to kill" wordings ABOUT THE ENV BASE — the
      // goal state, with the server alive under /tmp — and the reap that
      // trusted the verdict unlinked the live server's real socket: no
      // WARNING, and invisible to the orphan sweep that discovers orphans by
      // readdir of the very socket dirs the unlink emptied (probe-reproduced
      // on real tmux 3.4). The shim models tmux's own rule: it records which
      // base a start would use, creates the env base inside the window, and
      // answers kill-server goal-state only about the base its own env
      // resolves — so an env-resolved kill reads as a nothing-to-kill here
      // exactly as it does against real tmux.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-reapbase-'));
      const envBase = join(dir, 'env-base'); // nonexistent at start
      const stateDir = join(dir, 'state');
      mkdirSync(stateDir);
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, 'tmux'),
        `#!/bin/sh
[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }
for a in "$@"; do
  if [ "$a" = "new-session" ]; then
    if [ -n "$TMUX_TMPDIR" ] && [ -d "$TMUX_TMPDIR" ]; then
      printf '%s' "$TMUX_TMPDIR" > "${stateDir}/alive-base"
    else
      printf '%s' /tmp > "${stateDir}/alive-base"
    fi
    [ -n "$TMUX_TMPDIR" ] && mkdir -p "$TMUX_TMPDIR"
    s=$(printf '%s\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1)
    [ -n "$s" ] && : > "$s"
    exit 0
  fi
  if [ "$a" = "kill-server" ]; then
    printf '%s\n' "\${TMUX_TMPDIR:-}" >> "${stateDir}/kill-calls"
    if [ "\${TMUX_TMPDIR:-/tmp}" = "$(cat "${stateDir}/alive-base")" ]; then
      printf 'killed\n' >> "${stateDir}/kills"
      exit 0
    fi
    SRV=""; prev=""
    for x in "$@"; do [ "$prev" = "-L" ] && SRV="$x"; prev="$x"; done
    echo "error connecting to \${TMUX_TMPDIR:-/tmp}/tmux-1000/$SRV (No such file or directory)" >&2
    exit 1
  fi
done
printf 'MARK\n'
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      process.env['TMUX_TMPDIR'] = envBase;
      try {
        const { stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBeUndefined();
        expect(existsSync(join(dir, 'cap.json'))).toBe(true);
        // The kill was pinned to BOTH candidate bases — the env-resolved
        // call alone answers goal-state about the wrong base.
        const killCalls = readFileSync(join(stateDir, 'kill-calls'), 'utf8')
          .trim()
          .split('\n');
        expect(killCalls).toContain('/tmp');
        // ...and a kill actually REACHED the base the server lives under —
        // the env-resolved verdict never killed anything.
        expect(existsSync(join(stateDir, 'kills'))).toBe(true);
        expect(readFileSync(join(stateDir, 'kills'), 'utf8')).toContain(
          'killed',
        );
        // The server is confirmed dead, so the run stays silent: a false
        // WARNING here would send an operator hunting a reaped server.
        expect(stderr).not.toContain('WARNING');
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not credit a goal-state verdict the client answered about the FALLBACK base',
    async () => {
      // The server starts under the env base (usable at start) and the base
      // is deleted mid-window: at reap the client falls back to /tmp and
      // answers the goal-state wording ABOUT /tmp while the kill was pinned
      // to the vanished base (probe-verified on 3.4). Crediting that
      // verdict to the pinned base read the live server as reaped — no
      // WARNING, and invisible to the sweep once the socket dir went with
      // the base. The shim models tmux's rule: a kill pinned at a vanished
      // base answers with /tmp's path, exactly as the real client did.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      // SHORT base, never under tmpdir(): the socket-length gate refuses
      // a socket path over 103 bytes, and a macOS-shaped tmpdir
      // (/var/folders/<2>/<32>/T/, ~50 bytes) pushed this fixture's usable
      // env base past the bound — the run refused before any window opened
      // and the kill-verdict pins never executed while short-tmpdir hosts
      // showed green (probe-verified with a long-TMPDIR arm).
      const dir = mkdtempSync(join('/tmp', 'capture-tui-reapfb-'));
      const envBase = join(dir, 'scratch');
      mkdirSync(envBase);
      const stateDir = join(dir, 'state');
      mkdirSync(stateDir);
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, 'tmux'),
        `#!/bin/sh
[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }
for a in "$@"; do
  if [ "$a" = "new-session" ]; then
    printf '%s' "$TMUX_TMPDIR" > "${stateDir}/alive-base"
    rm -rf "$TMUX_TMPDIR"
    s=$(printf '%s\\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1)
    [ -n "$s" ] && : > "$s"
    exit 0
  fi
  if [ "$a" = "kill-server" ]; then
    printf '%s\\n' "\${TMUX_TMPDIR:-}" >> "${stateDir}/kill-calls"
    SRV=""; prev=""
    for x in "$@"; do [ "$prev" = "-L" ] && SRV="$x"; prev="$x"; done
    if [ -n "$TMUX_TMPDIR" ] && [ ! -d "$TMUX_TMPDIR" ]; then
      echo "error connecting to /tmp/tmux-$(id -u)/$SRV (No such file or directory)" >&2
      exit 1
    fi
    echo "error connecting to \${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$SRV (No such file or directory)" >&2
    exit 1
  fi
done
printf 'MARK\\n'
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      process.env['TMUX_TMPDIR'] = envBase;
      try {
        const { stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBeUndefined();
        expect(existsSync(join(dir, 'cap.json'))).toBe(true);
        // Both candidate bases were tried...
        const killCalls = readFileSync(join(stateDir, 'kill-calls'), 'utf8')
          .trim()
          .split('\n');
        expect(killCalls).toContain(envBase);
        expect(killCalls).toContain('/tmp');
        // ...and the env-base verdict — the goal-state wording naming /tmp
        // — must NOT have been credited: the server's fate under the
        // vanished base is unconfirmed, and a presumed-alive server is
        // never a silent outcome.
        expect(stderr).toContain('WARNING');
        expect(stderr).toContain('kill-server failed twice');
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not credit a create-directory verdict on a base that HELD the server at start',
    async () => {
      // The sibling arm: the base is replaced by a regular file mid-window.
      // The client answers `couldn't create directory` naming the pinned
      // base — but it examined nothing behind it, and the server that
      // started there may still be alive. The verdict is credited only
      // where the server could never have started (the next test).
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      // SHORT base — same gate reason as the reapfb sibling above.
      const dir = mkdtempSync(join('/tmp', 'capture-tui-reapcd-'));
      const envBase = join(dir, 'scratch');
      mkdirSync(envBase);
      const stateDir = join(dir, 'state');
      mkdirSync(stateDir);
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, 'tmux'),
        `#!/bin/sh
[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }
for a in "$@"; do
  if [ "$a" = "new-session" ]; then
    printf '%s' "$TMUX_TMPDIR" > "${stateDir}/alive-base"
    rm -rf "$TMUX_TMPDIR" && : > "$TMUX_TMPDIR"
    s=$(printf '%s\\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1)
    [ -n "$s" ] && : > "$s"
    exit 0
  fi
  if [ "$a" = "kill-server" ]; then
    printf '%s\\n' "\${TMUX_TMPDIR:-}" >> "${stateDir}/kill-calls"
    SRV=""; prev=""
    for x in "$@"; do [ "$prev" = "-L" ] && SRV="$x"; prev="$x"; done
    if [ -f "$TMUX_TMPDIR" ]; then
      echo "couldn't create directory $TMUX_TMPDIR/tmux-$(id -u) (Not a directory)" >&2
      exit 1
    fi
    echo "error connecting to \${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$SRV (No such file or directory)" >&2
    exit 1
  fi
done
printf 'MARK\\n'
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      process.env['TMUX_TMPDIR'] = envBase;
      try {
        const { stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBeUndefined();
        expect(existsSync(join(dir, 'cap.json'))).toBe(true);
        const killCalls = readFileSync(join(stateDir, 'kill-calls'), 'utf8')
          .trim()
          .split('\n');
        expect(killCalls).toContain(envBase);
        expect(killCalls).toContain('/tmp');
        expect(stderr).toContain('WARNING');
        expect(stderr).toContain('kill-server failed twice');
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'credits the create-directory verdict when start itself failed before binding a socket',
    async () => {
      // The third arm of the create-directory exclusion: the base passes
      // the start-time W_OK|X_OK gate, but tmux's mkdir of tmux-<uid>
      // persistently fails there (ENOSPC on that filesystem, EROFS under
      // root, NFS root-squash). Start throws, no server ever existed, and
      // both kills answer the same persistent wording — yet the exclusion,
      // unconditional on the stamp (which never ran either), vetoed credit
      // and the reap printed a false orphan WARNING next to the refusal.
      // The discriminating signal is whether the start call threw.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join('/tmp', 'capture-tui-reapns-'));
      const envBase = join(dir, 'scratch');
      mkdirSync(envBase);
      const stateDir = join(dir, 'state');
      mkdirSync(stateDir);
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, 'tmux'),
        `#!/bin/sh
[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }
for a in "$@"; do
  if [ "$a" = "new-session" ]; then
    echo "couldn't create directory $TMUX_TMPDIR/tmux-$(id -u) (No space left on device)" >&2
    exit 1
  fi
  if [ "$a" = "kill-server" ]; then
    printf '%s\\n' "\${TMUX_TMPDIR:-}" >> "${stateDir}/kill-calls"
    if [ "$TMUX_TMPDIR" = '${envBase}' ]; then
      echo "couldn't create directory $TMUX_TMPDIR/tmux-$(id -u) (No space left on device)" >&2
      exit 1
    fi
    SRV=""; prev=""
    for x in "$@"; do [ "$prev" = "-L" ] && SRV="$x"; prev="$x"; done
    echo "no server running on \${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$SRV" >&2
    exit 1
  fi
done
printf 'MARK\\n'
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      process.env['TMUX_TMPDIR'] = envBase;
      try {
        const { stdout, stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBe(3);
        expect(stderr).toContain('refused');
        expect(stderr).toContain("couldn't create directory");
        // Both candidate bases were tried...
        const killCalls = readFileSync(join(stateDir, 'kill-calls'), 'utf8')
          .trim()
          .split('\n');
        expect(killCalls).toContain(envBase);
        expect(killCalls).toContain('/tmp');
        // ...but a start that threw never bound a socket, so the server
        // never existed: the persistent create failure on the start base
        // IS the goal state there, and no orphan WARNING may print.
        expect(stderr).not.toContain('WARNING');
        expect(JSON.parse(stdout)).toMatchObject({ captured: false });
        expect(existsSync(join(dir, 'cap.json'))).toBe(false);
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'still credits a create-directory verdict on a base that never held the server',
    async () => {
      // The balance point of the arm above: an env base ALREADY unusable at
      // start (a regular file) never held the server — tmux started it
      // under /tmp — so the same `couldn't create directory` wording IS
      // honest there, and a false WARNING would send an operator hunting a
      // server that was confirmed dead by the /tmp kill (the measured harm
      // that folded the wording into the goal state in the first place).
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-reapnc-'));
      const envBase = join(dir, 'file-base');
      writeFileSync(envBase, 'not a directory');
      const stateDir = join(dir, 'state');
      mkdirSync(stateDir);
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, 'tmux'),
        `#!/bin/sh
[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }
for a in "$@"; do
  if [ "$a" = "new-session" ]; then
    printf '%s' /tmp > "${stateDir}/alive-base"
    s=$(printf '%s\\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1)
    [ -n "$s" ] && : > "$s"
    exit 0
  fi
  if [ "$a" = "kill-server" ]; then
    printf '%s\\n' "\${TMUX_TMPDIR:-}" >> "${stateDir}/kill-calls"
    if [ -f "$TMUX_TMPDIR" ]; then
      echo "couldn't create directory $TMUX_TMPDIR/tmux-$(id -u) (Permission denied)" >&2
      exit 1
    fi
    exit 0
  fi
done
printf 'MARK\\n'
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      process.env['TMUX_TMPDIR'] = envBase;
      try {
        const { stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBeUndefined();
        expect(existsSync(join(dir, 'cap.json'))).toBe(true);
        const killCalls = readFileSync(join(stateDir, 'kill-calls'), 'utf8')
          .trim()
          .split('\n');
        expect(killCalls).toContain(envBase);
        expect(killCalls).toContain('/tmp');
        expect(stderr).not.toContain('WARNING');
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not credit an ENOENT verdict once start STAMPED a socket — the file can vanish under a live server',
    async () => {
      // The shim's start binds a socket under the env base and the kill
      // removes it, answering the ENOENT wording naming the pinned base.
      // The wording proves only that the path was gone at look time — a
      // live server behind a removed socket file answers exactly this
      // (probed live on tmux) — so once start stamped a socket the verdict
      // is unconfirmed and the presumed-alive server surfaces as the
      // WARNING. Crediting it read the live server as reaped.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join('/tmp', 'capture-tui-reapabs-'));
      const envBase = join(dir, 'scratch');
      mkdirSync(envBase);
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, 'tmux'),
        `#!/bin/sh
[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }
for a in "$@"; do
  if [ "$a" = "new-session" ]; then
    SRV=""; prev=""
    for x in "$@"; do [ "$prev" = "-L" ] && SRV="$x"; prev="$x"; done
    mkdir -p "$TMUX_TMPDIR/tmux-$(id -u)"
    : > "$TMUX_TMPDIR/tmux-$(id -u)/$SRV"
    s=$(printf '%s\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1)
    [ -n "$s" ] && : > "$s"
    exit 0
  fi
  if [ "$a" = "kill-server" ]; then
    SRV=""; prev=""
    for x in "$@"; do [ "$prev" = "-L" ] && SRV="$x"; prev="$x"; done
    rm -f "$TMUX_TMPDIR/tmux-$(id -u)/$SRV"
    echo "error connecting to $TMUX_TMPDIR/tmux-$(id -u)/$SRV (No such file or directory)" >&2
    exit 1
  fi
done
printf 'MARK\n'
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      process.env['TMUX_TMPDIR'] = envBase;
      try {
        const { stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBeUndefined();
        expect(existsSync(join(dir, 'cap.json'))).toBe(true);
        expect(stderr).toContain('WARNING');
        expect(stderr).toContain('kill-server failed twice');
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not credit a start-base verdict about a socket that is not the stamped one',
    async () => {
      // The base's socket is replaced mid-window and the kill answers `no
      // server running` about the REPLACEMENT — the shape a base destroyed
      // and recreated mid-window produces (probe-verified on 3.4). The
      // stamped inode separates a verdict about THIS run's server from one
      // about a socket this run never owned; crediting the latter read the
      // live server behind the destroyed socket as dead, with no WARNING.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join('/tmp', 'capture-tui-reapid-'));
      const envBase = join(dir, 'scratch');
      mkdirSync(envBase);
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, 'tmux'),
        `#!/bin/sh
[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }
for a in "$@"; do
  if [ "$a" = "new-session" ]; then
    SRV=""; prev=""
    for x in "$@"; do [ "$prev" = "-L" ] && SRV="$x"; prev="$x"; done
    mkdir -p "$TMUX_TMPDIR/tmux-$(id -u)"
    : > "$TMUX_TMPDIR/tmux-$(id -u)/$SRV"
    s=$(printf '%s\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1)
    [ -n "$s" ] && : > "$s"
    exit 0
  fi
  if [ "$a" = "kill-server" ]; then
    SRV=""; prev=""
    for x in "$@"; do [ "$prev" = "-L" ] && SRV="$x"; prev="$x"; done
    if [ "$TMUX_TMPDIR" = "${envBase}" ]; then
      p="$TMUX_TMPDIR/tmux-$(id -u)/$SRV"
      # Same reason as the sibling fixture: swap by rename so the
      # replacement cannot inherit the freed inode.
      q="$p.swap"
      : > "$q"
      rm -f "$p"
      mv -f "$q" "$p"
      echo "no server running on $p" >&2
      exit 1
    fi
    echo "error connecting to \${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$SRV (No such file or directory)" >&2
    exit 1
  fi
done
printf 'MARK\n'
exit 0
`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      process.env['TMUX_TMPDIR'] = envBase;
      try {
        const { stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBeUndefined();
        expect(existsSync(join(dir, 'cap.json'))).toBe(true);
        expect(stderr).toContain('WARNING');
        expect(stderr).toContain('kill-server failed twice');
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
        else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a wall of freeze stderr cannot push the manifest past the reader cap',
    async () => {
      // The writer gate caps the EMBEDDED arguments, but degradedBecause
      // is added later: the errTail carried the last two lines of up to
      // FREEZE_MAX_BUFFER of freeze output verbatim, and one newline-free
      // megabyte-line of it pushed a successful run's manifest past
      // MAX_MANIFEST_BYTES — which its own next run could not verify,
      // refusing on the collision forever after (probe-reproduced).
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const realFreezeProbe = probes.freeze;
      probes.freeze = () => ({ status: 'ok', out: '' }) as const;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-errtail-'));
      writeFakeTmux(dir, '    :');
      const freezeBin = join(dir, 'fakebin', 'freeze');
      writeFileSync(
        freezeBin,
        "#!/bin/sh\nhead -c 3145728 /dev/zero | tr '\\0' 'x' >&2\nexit 9\n",
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      const realBin = freezeRender.bin;
      process.env['PATH'] = `${join(dir, 'fakebin')}:${realPath ?? ''}`;
      freezeRender.bin = freezeBin;
      try {
        await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: dir,
            cols: 80,
            rows: 24,
            settleMs: 0,
            until: 'MARK',
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 10_000,
          } as never),
        );
        expect(process.exitCode).toBeUndefined();
        const manifestPath = join(dir, 'cap.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        expect(manifest.evidence).toBe('ans-only');
        expect(manifest.degradedBecause).toContain('freeze failed (exit 9');
        // The tail stops at its cap, and the manifest a SUCCESSFUL run
        // writes stays small enough for the next run to verify.
        expect(manifest.degradedBecause.length).toBeLessThan(8192);
        expect(statSync(manifestPath).size).toBeLessThan(64 * 1024);
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        freezeRender.bin = realBin;
        probes.freeze = realFreezeProbe;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('refuses a tmux too old for capture-pane -N, naming the version', async () => {
    // -N landed in tmux 3.1; an older host passes -V and would otherwise
    // die MID-capture on the unknown flag — blaming tmux for a version
    // problem, after paying for a server start.
    probes.tmux = () => ({ status: 'ok', out: 'tmux 2.8' }) as const;
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-oldtmux-'));
    try {
      // The call log, not just the message: exit 3, the wording and the
      // absent .ans are all location-invariant, and a mutant that moved
      // this gate BELOW plan.start stayed green on a tmux-equipped lane —
      // a real new-session ran the user's command, then the identical
      // refusal, with the start/reap cycle and its orphan window on every
      // refusal on a genuinely old host. That start is the cost the gate
      // exists to avoid, so the pin has to be able to see it.
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      const callLog = join(dir, 'tmux-calls');
      writeFileSync(
        join(binDir, 'tmux'),
        `#!/bin/sh\necho "$*" >> "${callLog}"\n[ "$1" = "-V" ] && { echo "tmux 2.8"; exit 0; }\necho ""\nexit 0\n`,
        { mode: 0o755 },
      );
      const realPath = process.env['PATH'];
      process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
      let stderr: string;
      try {
        ({ stderr } = await withStdio(() =>
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
        ));
      } finally {
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
      }
      expect(process.exitCode).toBe(3);
      expect(stderr).toContain('tmux 2.8 is too old');
      expect(stderr).toContain('capture-pane -N');
      expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
      // Nothing was started. (The version came from the probe seam, so the
      // log may be empty — that is the strongest form of the same claim.)
      const calls = existsSync(callLog) ? readFileSync(callLog, 'utf8') : '';
      expect(calls).not.toContain('new-session');
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
    // answers {status:'absent'}, and the refusal is the no-tmux one — BOTH
    // land after the up-front clear, so the assertions pin the clear on
    // every platform.
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-stale-'));
    try {
      writeFileSync(join(dir, 'cap.ans'), 'old run');
      writeFileSync(join(dir, 'cap.png'), 'old run');
      writeFileSync(join(dir, 'cap.json'), staleManifest(join(dir, 'cap')));
      writeFileSync(join(dir, 'cap.holder-ready'), '');
      const binDir = join(dir, 'fakebin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, 'tmux'),
        '#!/bin/sh\n[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }\nfor a in "$@"; do [ "$a" = "kill-server" ] && { echo "no server running on /tmp/x" >&2; exit 1; }; done\necho "fake tmux: refusing" >&2\nexit 1\n',
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
      // A user file at this name is not ours: the sentinel lives under
      // the system temp dir now. It used to be unlinked unconditionally,
      // before any refusal the run was already headed for.
      expect(existsSync(join(dir, 'cap.holder-ready'))).toBe(true);
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
    // A REAL-looking probe so the run reaches the --until compile gate its
    // title claims (with the probe undefined, the no-tmux refusal fired
    // first and every later gate stayed unpinned for the clear).
    probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-staleearly-'));
    try {
      writeFileSync(join(dir, 'cap.ans'), 'old run');
      writeFileSync(join(dir, 'cap.png'), 'old run');
      writeFileSync(join(dir, 'cap.json'), staleManifest(join(dir, 'cap')));
      writeFileSync(join(dir, 'cap.holder-ready'), '');
      const { stderr } = await withStdio(() =>
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
      // The REASON, so the gate this pins is the marker compile and not
      // whichever gate happens to refuse first: without it, deleting or
      // hoisting that gate leaves the run refusing elsewhere — still exit
      // 3, still cleared, still green.
      expect(stderr).toContain('not a valid regex');
      expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
      expect(existsSync(join(dir, 'cap.png'))).toBe(false);
      expect(existsSync(join(dir, 'cap.json'))).toBe(false);
      // A user file at this name is not ours: the sentinel lives under
      // the system temp dir now. It used to be unlinked unconditionally,
      // before any refusal the run was already headed for.
      expect(existsSync(join(dir, 'cap.holder-ready'))).toBe(true);
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

  it('leaves UNRELATED files at the artifact paths alone on refusal', async () => {
    // The artifact names are not reserved: a colliding --out must not
    // force-delete unrelated files on a run that refuses (measured shape:
    // --out package → the --cols 0 refusal deleted package.json). The
    // clear keys on the manifest's evidence rung — a JSON that is not a
    // capture manifest leaves its sibling files untouched too.
    probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-unrelated-'));
    try {
      writeFileSync(
        join(dir, 'cap.json'),
        '{"name":"not-a-manifest","version":"1.0.0"}',
      );
      writeFileSync(join(dir, 'cap.ans'), 'user file');
      writeFileSync(join(dir, 'cap.png'), 'user file');
      const { stderr } = await withStdio(() =>
        runCaptureTui({
          command: 'printf hi',
          cwd: undefined,
          cols: 0,
          rows: 24,
          settleMs: 0,
          until: undefined,
          keys: undefined,
          out: join(dir, 'cap'),
          timeoutMs: 1000,
        } as never),
      );
      expect(process.exitCode).toBe(3);
      // The refusal is now the COLLISION itself, taken before anything
      // starts: a file the clear phase verified is not a capture artifact
      // is not ours to replace, and a successful run used to rewrite it.
      expect(stderr).toContain('collides with a file this capture did not');
      expect(readFileSync(join(dir, 'cap.json'), 'utf8')).toBe(
        '{"name":"not-a-manifest","version":"1.0.0"}',
      );
      expect(readFileSync(join(dir, 'cap.ans'), 'utf8')).toBe('user file');
      expect(readFileSync(join(dir, 'cap.png'), 'utf8')).toBe('user file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Probe-reproduced harm: a foreign `<out>.json` carrying nothing but
  // `"evidence":"png"` authorized the clear phase to DELETE the user's
  // .json, .ans and .png — before the collision gate this run was already
  // headed for could refuse. `evidence` is a field any report-shaped JSON
  // can plausibly hold; ownership has to be proved by the full signature a
  // previous run of THIS command wrote, every rung of it.
  for (const [label, manifest] of [
    ['only the evidence rung', '{"evidence":"png"}'],
    [
      'a manifest naming a DIFFERENT capture',
      JSON.stringify({
        evidence: 'png',
        ansPath: '/somewhere/else/other.ans',
        settledBy: 'timeout',
      }),
    ],
    [
      // Everything valid EXCEPT the evidence rung: without this fixture no
      // case isolated it — the others are caught by ansPath first, so the
      // rung could be deleted and the suite stayed green.
      'a manifest whose evidence is not a rung this tool writes',
      JSON.stringify({
        evidence: 'text',
        ansPath: 'PLACEHOLDER',
        settledBy: 'timeout',
      }),
    ],
    [
      'a manifest with no settledBy',
      JSON.stringify({
        evidence: 'png',
        ansPath: 'PLACEHOLDER',
      }),
    ],
  ] as const) {
    it(`refuses instead of clearing a foreign manifest — ${label}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-foreignjson-'));
      try {
        writeFileSync(join(dir, 'cap.ans'), 'user file');
        writeFileSync(join(dir, 'cap.png'), 'user file');
        const json = manifest.replace('PLACEHOLDER', join(dir, 'cap.ans'));
        writeFileSync(join(dir, 'cap.json'), json);
        const { stderr } = await withStdio(() =>
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
        );
        expect(process.exitCode).toBe(3);
        expect(stderr).toContain('collides with a file this capture did not');
        expect(readFileSync(join(dir, 'cap.json'), 'utf8')).toBe(json);
        expect(readFileSync(join(dir, 'cap.ans'), 'utf8')).toBe('user file');
        expect(readFileSync(join(dir, 'cap.png'), 'utf8')).toBe('user file');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('a manifest whose pngPath names ANOTHER file cannot authorize clearing <out>.png', async () => {
    // The internally inconsistent png-rung shape: the signature passes
    // (evidence rung, exact ansPath, closed-set settledBy) but the
    // recorded pngPath points elsewhere — a manifest this writer never
    // produces, since every png rung it writes records THIS <out>.png.
    // The evidence rung alone licensed deleting the user's cap.png
    // (probe-reproduced); unverified is not permission to delete.
    probes.tmux = () => ({ status: 'absent' }) as const;
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-foreignpng-'));
    try {
      writeFileSync(join(dir, 'cap.ans'), 'user file');
      writeFileSync(join(dir, 'cap.png'), 'user file');
      const json = JSON.stringify({
        evidence: 'png',
        ansPath: join(dir, 'cap.ans'),
        pngPath: '/elsewhere/foreign.png',
        settledBy: 'timeout',
      });
      writeFileSync(join(dir, 'cap.json'), json);
      const { stderr } = await withStdio(() =>
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
      );
      expect(process.exitCode).toBe(3);
      // The refusal is the probe's (the ans and the manifest verified as
      // ours and were cleared, so no collision remains to name) — the
      // teeth are in the file assertions below.
      expect(stderr).toContain('tmux is not installed');
      // The png survives: the manifest's own pngPath never named it.
      expect(readFileSync(join(dir, 'cap.png'), 'utf8')).toBe('user file');
      // The signature-passing halves were verified ours and cleared.
      expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
      expect(existsSync(join(dir, 'cap.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never touches a user DIRECTORY at <out>.holder-ready, refusal or not', async () => {
    // Was: the sentinel sat at this path and its unlink was the one clear
    // that could THROW (EISDIR, which `force` does not suppress), so it had
    // to be ordered last or it stranded the previous run's evidence:"png"
    // manifest beside the refusal. The sentinel moved under the system temp
    // dir, so the throw is gone at the source and nothing here is ours: the
    // stale artifacts still clear, and the directory — content and all —
    // outlives a run that refuses. A plain file at the same name is covered
    // by the SHAPE-guard test above; a DIRECTORY is what used to throw.
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-sentinelorder-'));
    try {
      writeFileSync(join(dir, 'cap.ans'), 'old run');
      writeFileSync(join(dir, 'cap.png'), 'old run');
      writeFileSync(join(dir, 'cap.json'), staleManifest(join(dir, 'cap')));
      mkdirSync(join(dir, 'cap.holder-ready'));
      writeFileSync(join(dir, 'cap.holder-ready', 'user-file'), 'not ours');
      await withStdio(() =>
        runCaptureTui({
          // Refuses at the shape guard — deterministic, and no tmux of any
          // version is spawned, so this pins the clear phase alone.
          command: ['a', 'b'],
          cwd: undefined,
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
      expect(existsSync(join(dir, 'cap.png'))).toBe(false);
      expect(existsSync(join(dir, 'cap.json'))).toBe(false);
      expect(statSync(join(dir, 'cap.holder-ready')).isDirectory()).toBe(true);
      expect(
        readFileSync(join(dir, 'cap.holder-ready', 'user-file'), 'utf8'),
      ).toBe('not ours');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears stale artifacts even when a SHAPE guard refuses', async () => {
    // The measured R4-1 regression: an array-shaped --command refused at
    // the shape guard BEFORE the clear, leaving a stale evidence:"png"
    // manifest next to the refusal. The clear must precede the shape
    // guards too — only an unnameable --out refuses without clearing.
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-staleshape-'));
    try {
      writeFileSync(join(dir, 'cap.ans'), 'old run');
      writeFileSync(join(dir, 'cap.png'), 'old run');
      writeFileSync(join(dir, 'cap.json'), staleManifest(join(dir, 'cap')));
      writeFileSync(join(dir, 'cap.holder-ready'), '');
      await withStdio(() =>
        runCaptureTui({
          command: ['a', 'b'],
          cwd: undefined,
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
      expect(existsSync(join(dir, 'cap.png'))).toBe(false);
      expect(existsSync(join(dir, 'cap.json'))).toBe(false);
      // A user file at this name is not ours: the sentinel lives under
      // the system temp dir now. It used to be unlinked unconditionally,
      // before any refusal the run was already headed for.
      expect(existsSync(join(dir, 'cap.holder-ready'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'cuts a HANGING availability probe with the belt — wedged, not absent',
    async () => {
      // A tmux -V that hangs would otherwise block before the refusal
      // contract or any signal handler exists; through the seam the belt is
      // provable — the hardcoded-timeout mutant hangs past the wall bound.
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-hangprobe-'));
      const binDir = join(dir, 'bin');
      mkdirSync(binDir, { recursive: true });
      // /bin/sleep by absolute path: PATH is binDir alone below, so a bare
      // `sleep` would ENOENT and the shim would EXIT instantly instead of
      // hanging — the test then never exercised the belt at all.
      // TERM-immune, like the measured wedge: without killSignal SIGKILL
      // the belt only SENDS a TERM this shim ignores, and the spawn blocks
      // past any deadline — the SIGKILL half of the belt is what this pins.
      writeFileSync(
        join(binDir, 'tmux'),
        "#!/bin/sh\ntrap '' TERM\n/bin/sleep 30\n",
        {
          mode: 0o755,
        },
      );
      const realPath = process.env['PATH'];
      const realBudget = probeBudget.timeoutMs;
      process.env['PATH'] = binDir;
      probeBudget.timeoutMs = 500;
      const started = performance.now();
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
        probeBudget.timeoutMs = realBudget;
        if (realPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = realPath;
        rmSync(dir, { recursive: true, force: true });
      }
      expect(process.exitCode).toBe(3);
      // A belt-killed probe is WEDGED, not absent — the refusal must not
      // send an operator to reinstall a binary that exists.
      expect(stderr).toContain('present but wedged');
      expect(stderr).not.toContain('not installed');
      const elapsed = performance.now() - started;
      // Floor proves the shim actually hung to the belt; the tight ceiling
      // kills a hardcoded 10s mutant.
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(2_500);
    },
  );

  it('clears stale artifacts when the ENVIRONMENT refuses — absent, hung, too old', async () => {
    // The clear-first contract has ordering pins for the sentinel, the
    // shape guards, the marker gate and the directory-shaped --out — but
    // every one of them runs with an OK probe, so a regression that let the
    // probe-refusal family bypass the clear shipped green while a stale
    // manifest claiming "evidence":"png" sat beside the refusal JSON.
    for (const [name, probe] of [
      ['absent', () => ({ status: 'absent' }) as const],
      ['hung', () => ({ status: 'hung' }) as const],
      ['too old', () => ({ status: 'ok', out: 'tmux 3.0a' }) as const],
    ] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-probestale-'));
      try {
        writeFileSync(join(dir, 'cap.ans'), 'old run');
        writeFileSync(join(dir, 'cap.png'), 'old run');
        writeFileSync(join(dir, 'cap.json'), staleManifest(join(dir, 'cap')));
        probes.tmux = probe;
        await withStdio(() =>
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
        );
        // The probe name rides IN the compared value, so a miss prints
        // WHICH of the three refusals regressed instead of `false`.
        expect({
          probe: name,
          exitCode: process.exitCode,
          ans: existsSync(join(dir, 'cap.ans')),
          png: existsSync(join(dir, 'cap.png')),
          manifest: existsSync(join(dir, 'cap.json')),
        }).toEqual({
          probe: name,
          exitCode: 3,
          ans: false,
          png: false,
          manifest: false,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
        process.exitCode = undefined;
      }
    }
  });

  it('leaves an occupant BYTE-FOR-BYTE intact when it refuses', async () => {
    // What pins this now is the collision gate, not a per-path write probe:
    // that probe is gone (an append-mode open passes on a `chattr +a` file
    // the truncating final write then fails on), and the gate refuses on
    // any occupant before anything opens it. Content, not existence — a
    // regression that truncates on the way to refusing stays green
    // otherwise.
    probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-notrunc-'));
    try {
      writeFileSync(join(dir, 'cap.json'), '{"name":"not-a-manifest"}');
      writeFileSync(join(dir, 'cap.ans'), 'user bytes');
      await withStdio(() =>
        runCaptureTui({
          command: 'printf hi',
          cwd: undefined,
          cols: 0,
          rows: 24,
          settleMs: 0,
          until: undefined,
          keys: undefined,
          out: join(dir, 'cap'),
          timeoutMs: 1000,
        } as never),
      );
      expect(process.exitCode).toBe(3);
      expect(readFileSync(join(dir, 'cap.json'), 'utf8')).toBe(
        '{"name":"not-a-manifest"}',
      );
      expect(readFileSync(join(dir, 'cap.ans'), 'utf8')).toBe('user bytes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'refuses an unwritable MANIFEST path too, not just the .ans',
    async () => {
      // The probe loop covers both paths; dropping manifestPath from it
      // passed the whole file. The brief template's `--out package` against
      // a stage that left package.json mode-0444 is exactly this shape:
      // every gate passes, the capture runs, and the manifest write fails
      // at the very end with the pane text already thrown away.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-romanifest-'));
      try {
        writeFileSync(join(dir, 'cap.json'), '{"name":"not-a-manifest"}', {
          mode: 0o444,
        });
        const started = performance.now();
        const { stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: undefined,
            cols: 80,
            rows: 24,
            settleMs: 5_000,
            until: undefined,
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 30_000,
          } as never),
        );
        expect(process.exitCode).toBe(3);
        expect(stderr).toContain('collides with a file this capture did not');
        expect(stderr).toContain('cap.json');
        expect(performance.now() - started).toBeLessThan(3_000);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('a RELATIVE ansPath does not pass the ownership signature', async () => {
    // Probe-reproduced: while ownership compared `resolve(m.ansPath)`, a
    // foreign JSON carrying a relative ansPath that happened to resolve to
    // this run's .ans passed the signature and took all three of the user's
    // files with it. This tool always records the already-resolved absolute
    // path, so the relative form can only come from somewhere else.
    // The relative path is built to resolve CORRECTLY from the test's cwd —
    // process.chdir is unavailable in a vitest worker thread, and would
    // prove less: this is the exact string the old comparison accepted.
    probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-relansp-'));
    try {
      writeFileSync(join(dir, 'cap.ans'), 'user file');
      writeFileSync(join(dir, 'cap.png'), 'user file');
      const json = JSON.stringify({
        evidence: 'png',
        ansPath: relative(process.cwd(), join(dir, 'cap.ans')),
        settledBy: 'timeout',
      });
      writeFileSync(join(dir, 'cap.json'), json);
      const { stderr } = await withStdio(() =>
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
      );
      expect(process.exitCode).toBe(3);
      expect(stderr).toContain('collides with a file this capture did not');
      expect(readFileSync(join(dir, 'cap.json'), 'utf8')).toBe(json);
      expect(readFileSync(join(dir, 'cap.ans'), 'utf8')).toBe('user file');
      expect(readFileSync(join(dir, 'cap.png'), 'utf8')).toBe('user file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Both of these need NO tmux: the size cap and the bounded read run in
  // the clear phase, and the collision gate refuses before probes.tmux()
  // is ever called. Sitting in the real-tmux describe, they were skipped on
  // every tmux-less lane — which is every Windows lane by definition — so
  // the heap guard was unpinned exactly where an unattended runner would
  // meet it.
  for (const [label, makeJson] of [
    ['a bare oversize file', (): string => 'x'.repeat(1024 * 1024 + 10)],
    [
      // VALID JSON carrying the FULL ownership signature (evidence rung,
      // exact ansPath, closed-set settledBy), so the CAP is what decides:
      // without it the file parses, `shaped` is true, and the clear phase
      // deletes the sibling artifacts. A garbage payload would not
      // discriminate — JSON.parse rejects it either way — and neither
      // would a partial signature, which fails `shaped` with or without
      // the cap.
      'valid manifest-shaped JSON past the cap',
      (base: string): string =>
        JSON.stringify({
          evidence: 'png',
          ansPath: `${base}.ans`,
          pngPath: `${base}.png`,
          settledBy: 'timeout',
          pad: 'x'.repeat(2 * 1024 * 1024),
        }),
    ],
  ] as const) {
    it(`REFUSES an oversized <out>.json rather than read it into the heap — ${label}`, async () => {
      // Measured at ~479MB: the clear phase used to readFileSync +
      // JSON.parse whatever regular file sat there, and the process died on
      // the heap limit before any refusal could print. Past the cap the
      // file is simply not ours, which the collision gate refuses by name.
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-hugejson-'));
      try {
        const json = makeJson(join(dir, 'cap'));
        writeFileSync(join(dir, 'cap.json'), json);
        writeFileSync(join(dir, 'cap.ans'), 'previous run text');
        writeFileSync(join(dir, 'cap.png'), 'user file');
        const { stderr } = await withStdio(() =>
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
        );
        expect(process.exitCode).toBe(3);
        expect(stderr).toContain('collides with a file this capture did not');
        // Nothing touched: a manifest this run could not verify is not
        // authority to delete anything beside it.
        expect(statSync(join(dir, 'cap.json')).size).toBe(json.length);
        expect(readFileSync(join(dir, 'cap.ans'), 'utf8')).toBe(
          'previous run text',
        );
        expect(readFileSync(join(dir, 'cap.png'), 'utf8')).toBe('user file');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('clears stale artifacts for the SHAPE-BOUNDS gate family too', async () => {
    // Seven refusal gates have seeded-artifact ordering pins; the family
    // between the probe gates and the marker gate — geometry bounds, an
    // empty --command, a non-enterable --cwd, the settle/timeout bounds —
    // had none, so hoisting any of them above the clear block shipped green
    // while a stale manifest claiming "evidence":"png" survived beside the
    // refusal.
    probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
    // The REASON, not just exit 3: without it, deleting a gate outright
    // ships green — the run sails on and refuses for some other reason
    // (a tmux-less lane refuses 'not installed'), which is still exit 3
    // with the artifacts cleared. The pin has to name the gate it pins.
    for (const [name, over, reason] of [
      ['geometry', { rows: 9999 }, '--rows must'],
      ['empty command', { command: '   ' }, '--command must not be empty'],
      [
        'cwd',
        { cwd: join(tmpdir(), 'capture-tui-nope-does-not-exist') },
        '--cwd',
      ],
      ['settle bound', { settleMs: -1 }, '--settle-ms'],
      ['timeout bound', { timeoutMs: -1 }, '--timeout-ms'],
    ] as ReadonlyArray<readonly [string, Record<string, unknown>, string]>) {
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-boundstale-'));
      try {
        writeFileSync(join(dir, 'cap.ans'), 'old run');
        writeFileSync(join(dir, 'cap.png'), 'old run');
        writeFileSync(join(dir, 'cap.json'), staleManifest(join(dir, 'cap')));
        const { stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: undefined,
            cols: 80,
            settleMs: 0,
            until: undefined,
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 1000,
            rows: 24,
            ...(over as Record<string, unknown>),
          } as never),
        );
        // The gate name rides IN the compared value, so a miss prints WHICH
        // gate stopped naming itself instead of a bare `false`.
        expect({ gate: name, named: stderr.includes(reason) }).toEqual({
          gate: name,
          named: true,
        });
        expect({
          gate: name,
          exitCode: process.exitCode,
          ans: existsSync(join(dir, 'cap.ans')),
          png: existsSync(join(dir, 'cap.png')),
          manifest: existsSync(join(dir, 'cap.json')),
        }).toEqual({
          gate: name,
          exitCode: 3,
          ans: false,
          png: false,
          manifest: false,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
        process.exitCode = undefined;
      }
    }
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a FIFO at an artifact path instead of blocking on it',
    async () => {
      // Reading a FIFO blocks until a writer appears — a HANG, not a throw,
      // so no refusal is printed and no reap handler is installed yet. Run
      // from a CHILD with a kill deadline: the block is a synchronous read
      // on the main thread, so an in-process timeout cannot interrupt it
      // (measured — a regression wedged the whole vitest run past its own
      // 10s test timeout), and only an external killer turns it red.
      const captureTuiTs = captureTuiSource();
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-fifo-'));
      try {
        const mkfifo = spawnSync('mkfifo', [join(dir, 'cap.json')]);
        // A bare `return` here reported PASSED on a lane without mkfifo —
        // spawnSync does not throw for an absent binary, it hands back an
        // ENOENT error object — so the only pin against the blocking
        // manifest read went green while testing nothing. Fail loudly
        // instead: this suite's lanes all have it, and a lane that does not
        // should say so rather than quietly drop the coverage.
        expect(
          mkfifo.error ?? null,
          'mkfifo is unavailable — this pin cannot run here',
        ).toBeNull();
        expect(existsSync(join(dir, 'cap.json'))).toBe(true);
        const driver = join(dir, 'driver-fifo.mts');
        writeFileSync(
          driver,
          [
            `const mod = await import(${JSON.stringify(pathToFileURL(captureTuiTs).href)});`,
            `mod.probes.tmux = () => ({ status: 'absent' });`,
            `await mod.runCaptureTui({ command: 'printf hi', cwd: ${JSON.stringify(dir)}, cols: 80, rows: 24, settleMs: 0, until: undefined, keys: undefined, out: ${JSON.stringify(join(dir, 'cap'))}, timeoutMs: 1000 } as never);`,
          ].join('\n'),
        );
        const { spawn } = await import('node:child_process');
        const child = spawn(process.execPath, ['--import', 'tsx', driver], {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (b: Buffer) => (out += b.toString()));
        child.stderr.on('data', (b: Buffer) => (out += b.toString()));
        const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        const code = await new Promise<number | null>((resolve) =>
          child.once('exit', (c) => resolve(c)),
        );
        clearTimeout(killer);
        // Exit 3 with the collision named — not a SIGKILL'd hang.
        expect(code).toBe(3);
        expect(out).toContain('collides with a file this capture did not');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it('refuses an EMPTY --cwd, --until or --ready — a template that expanded to nothing', async () => {
    // `resolve('')` is the launcher's own cwd, so the enterability gate
    // always passed it: an empty --cwd captured somewhere the caller never
    // named and the manifest recorded that directory as if asked for
    // (probe-reproduced: exit 0, success, wrong cwd). An empty --until is a
    // pattern matching everything, settling on the first frame.
    probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
    for (const flag of ['cwd', 'until', 'ready', 'out'] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-emptyarg-'));
      try {
        writeFileSync(join(dir, 'cap.ans'), 'old run');
        writeFileSync(join(dir, 'cap.json'), staleManifest(join(dir, 'cap')));
        const { stderr } = await withStdio(() =>
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
            // --out's own empty form was pinned only by an exit-3
            // assertion that holds with the gate deleted (resolve('') is
            // the cwd, and the artifacts then collide there).
            [flag]: '   ',
          } as never),
        );
        expect(`${flag}:${process.exitCode}`).toBe(`${flag}:3`);
        expect(stderr).toContain(`--${flag} must not be empty`);
        if (flag === 'out') {
          // The ONE gate that refuses without clearing, by design: an --out
          // this run cannot name gives it nowhere to clear. So the pin is
          // the opposite one — the seeded files are still there.
          expect(existsSync(join(dir, 'cap.ans'))).toBe(true);
          expect(existsSync(join(dir, 'cap.json'))).toBe(true);
        } else {
          // ...and the clear ran first, like every sibling gate.
          expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
          expect(existsSync(join(dir, 'cap.json'))).toBe(false);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('refuses a BARE --keys — no tokens is a template that drove nothing', async () => {
    // yargs `array: true` turns `--keys` (bare), `--keys=` and an unquoted
    // `--keys $EMPTY` into [], which was accepted silently: nothing typed,
    // success reported, while the QUOTED form of the same template failure
    // was refused.
    probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-barekeys-'));
    try {
      // Seeded, so the assertions below are not vacuous: against an empty
      // dir `existsSync(cap.json) === false` passes with or without the
      // clear, and every other refusal-gate family in this suite pins the
      // ordering with real artifacts in place.
      writeFileSync(join(dir, 'cap.ans'), 'old run');
      writeFileSync(join(dir, 'cap.png'), 'old run');
      writeFileSync(join(dir, 'cap.json'), staleManifest(join(dir, 'cap')));
      const { stderr } = await withStdio(() =>
        runCaptureTui({
          command: 'printf hi',
          cwd: undefined,
          cols: 80,
          rows: 24,
          settleMs: 0,
          until: undefined,
          keys: [],
          out: join(dir, 'cap'),
          timeoutMs: 1000,
        } as never),
      );
      expect(process.exitCode).toBe(3);
      expect(stderr).toContain('no tokens');
      expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
      expect(existsSync(join(dir, 'cap.png'))).toBe(false);
      expect(existsSync(join(dir, 'cap.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an EMPTY --keys token — a keypress that never happens', async () => {
    // `send-keys ''` types nothing, so the run reported success with the
    // token in manifest.keys and keysSent true — a keypress a verdict can
    // cite that never happened. A brief template expanding an empty
    // variable produces exactly this token.
    probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-emptykey-'));
    try {
      // Seeded, so the assertions below are not vacuous: against an empty
      // dir `existsSync(cap.json) === false` passes with or without the
      // clear, and every other refusal-gate family in this suite pins the
      // ordering with real artifacts in place.
      writeFileSync(join(dir, 'cap.ans'), 'old run');
      writeFileSync(join(dir, 'cap.png'), 'old run');
      writeFileSync(join(dir, 'cap.json'), staleManifest(join(dir, 'cap')));
      const { stderr } = await withStdio(() =>
        runCaptureTui({
          command: 'printf hi',
          cwd: undefined,
          cols: 80,
          rows: 24,
          settleMs: 0,
          until: undefined,
          keys: [''],
          out: join(dir, 'cap'),
          timeoutMs: 1000,
        } as never),
      );
      expect(process.exitCode).toBe(3);
      expect(stderr).toContain('empty token');
      expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
      expect(existsSync(join(dir, 'cap.png'))).toBe(false);
      expect(existsSync(join(dir, 'cap.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a READ-ONLY file at an artifact path before the capture window',
    async () => {
      // The sibling write probe proves the DIRECTORY writable, not the
      // artifact paths. A mode-0444 (or foreign-owned, the shape a shared
      // CI stage leaves) .ans passed every gate and refused only at the
      // final write — after the whole settle/timeout window and a render,
      // with the pane text produced and thrown away. Not skipped as root: the gate
      // is occupancy, not permission — a pure lstat — so the mode bits
      // never enter it and a root lane must exercise it like any other.
      probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-roartifact-'));
      try {
        writeFileSync(join(dir, 'cap.ans'), 'not writable by us', {
          mode: 0o444,
        });
        const started = performance.now();
        const { stderr } = await withStdio(() =>
          runCaptureTui({
            command: 'printf hi',
            cwd: undefined,
            cols: 80,
            rows: 24,
            settleMs: 5_000,
            until: undefined,
            keys: undefined,
            out: join(dir, 'cap'),
            timeoutMs: 30_000,
          } as never),
        );
        expect(process.exitCode).toBe(3);
        expect(stderr).toContain('collides with a file this capture did not');
        // BEFORE the window: the 5s settle never ran.
        expect(performance.now() - started).toBeLessThan(3_000);
        // And the file is still the user's, untouched.
        expect(readFileSync(join(dir, 'cap.ans'), 'utf8')).toBe(
          'not writable by us',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('SKIPS a directory squatting at an artifact path and clears the rest', async () => {
    // A capture writes files, so a DIRECTORY at an artifact path is someone
    // else's — the recursive EISDIR fallback deleted it and its contents on
    // every re-run against the same --out (a stale shaped manifest is the
    // normal state from the second run on). The directory survives; the
    // unlink's throw must not abort the clear of the OTHER paths either.
    probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-eisdir-'));
    try {
      mkdirSync(join(dir, 'cap.ans'));
      writeFileSync(join(dir, 'cap.ans', 'user-file'), 'not ours');
      writeFileSync(join(dir, 'cap.png'), 'stale png');
      writeFileSync(join(dir, 'cap.json'), staleManifest(join(dir, 'cap')));
      const { stderr } = await withStdio(() =>
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
      );
      expect(process.exitCode).toBe(3);
      // The undeletable path is also occupied, so the collision gate
      // refuses UP FRONT naming it — not after a full capture window at
      // the final write.
      expect(stderr).toContain('collides with a file this capture did not');
      expect(stderr).toContain('cap.ans');
      expect(statSync(join(dir, 'cap.ans')).isDirectory()).toBe(true);
      expect(existsSync(join(dir, 'cap.ans', 'user-file'))).toBe(true);
      // The throw on the directory does not strand the other stale evidence.
      expect(existsSync(join(dir, 'cap.png'))).toBe(false);
      expect(existsSync(join(dir, 'cap.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // skipIf(win32) like every shim-dependent sibling: an extensionless
  // shebang script is not spawnable via CreateProcess and PATH joins with
  // ';' there, so the real probe answers 'absent', the run refuses
  // 'tmux is not installed' before either gate, and the call-log
  // assertions pass VACUOUSLY — pinning nothing on the windows lane.
  it.skipIf(process.platform === 'win32')(
    'starts NO process before the marker gates refuse — pinned by call log',
    async () => {
      // Location-invariant assertions could not see a mutant that moved the
      // --until compile below plan.start: the refusal looked identical while
      // a real private server ran the user's command. The call log can.
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-order-'));
      try {
        const binDir = join(dir, 'fakebin');
        mkdirSync(binDir, { recursive: true });
        const callLog = join(dir, 'tmux-calls');
        writeFileSync(
          join(binDir, 'tmux'),
          `#!/bin/sh\necho "$*" >> "${callLog}"\n[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }\necho ""\nexit 0\n`,
          { mode: 0o755 },
        );
        const realTmuxProbe = probes.tmux;
        const realPath = process.env['PATH'];
        process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
        try {
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
        } finally {
          probes.tmux = realTmuxProbe;
          if (realPath === undefined) delete process.env['PATH'];
          else process.env['PATH'] = realPath;
        }
        expect(process.exitCode).toBe(3);
        const calls = existsSync(callLog) ? readFileSync(callLog, 'utf8') : '';
        expect(calls).not.toContain('new-session');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('refuses non-string argv shapes before anything else', async () => {
    // yargs parses duplicated options into arrays and --no-X into booleans;
    // both must refuse, not throw uncaught or silently corrupt the capture.
    // Undefined required options are the exported-function vector of the
    // same class: demandOption covers the CLI path only.
    probes.tmux = () => ({ status: 'absent' }) as const; // never reached — shapes refuse first
    // A test-owned out, not '/tmp/never-written': the hardcoded path
    // routed most iterations through the mkdir+probe block before the
    // guards under test, and on Windows resolve() lands it at the drive
    // root (a stray <drive>:\tmp on admin lanes, EPERM on the others).
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-shapes-'));
    try {
      const base = {
        cwd: undefined,
        cols: 80,
        rows: 24,
        settleMs: 0,
        until: undefined,
        keys: undefined,
        out: join(dir, 'never-written'),
        timeoutMs: 1000,
      };
      for (const [over, flag] of [
        [{ command: ['a', 'b'] }, '--command'], // --command A --command B
        [{ command: false }, '--command'], // --no-command
        [{ command: undefined }, '--command'],
        [{ command: 'x', until: ['A', 'B'] }, '--until'], // --until A --until B
        [{ command: 'x', keys: [false] }, '--keys'], // --keys false
        [{ command: 'x', keys: false }, '--keys'], // --no-keys (boolean)
        [{ command: 'x', keys: 'Enter' }, '--keys'], // bare string
        [{ command: 'x', out: ['x', 'y'] }, '--out'],
        [{ command: 'x', out: undefined }, '--out'],
        [{ command: 'x', ready: ['A', 'B'] }, '--ready'], // --ready A --ready B
        [{ command: 'x', cwd: ['a', 'b'] }, '--cwd'],
      ] as const) {
        process.exitCode = undefined;
        const { stderr } = await withStdio(() =>
          runCaptureTui({ ...base, ...over } as never),
        );
        expect(process.exitCode).toBe(3);
        // The FLAG NAME, not just the shared word 'must': a label↔value
        // swap in production's guard loop misnames the offending flag in
        // the machine-parsed refusal JSON, sending an agent consumer to
        // fix a flag it never duplicated (measured: with --until/--ready
        // labels swapped, a duplicated --until blamed --ready).
        expect(stderr).toContain(`${flag} must`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'keeps unverifiable artifacts when the WRITE PROBE itself fails',
    async () => {
      // Fd exhaustion means the manifest CANNOT be read, so the capture
      // signature cannot be verified — and unverified is not permission to
      // delete: the artifact names are not reserved, so what sits there may
      // be the user's. This run refuses; the files stay. (The sentinel is
      // this tool's alone and clears unconditionally.)
      //
      // Driven from a CHILD, and that is not incidental: vitest runs test
      // files in worker THREADS that share one process fd table, so
      // exhausting it in-process starves whatever else happens to be
      // running — measured, this test passed alone 3/3 while the full
      // review suite failed here and timed out an unrelated hadolint test
      // in the same run. A child contains the blast radius, and real
      // exhaustion is still what drives the EMFILE (vi.spyOn on node:fs
      // does not reach this module's named imports).
      const captureTuiTs = captureTuiSource();
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-staleprobe-'));
      try {
        writeFileSync(join(dir, 'cap.ans'), 'old run');
        writeFileSync(join(dir, 'cap.png'), 'old run');
        writeFileSync(join(dir, 'cap.json'), staleManifest(join(dir, 'cap')));
        writeFileSync(join(dir, 'cap.holder-ready'), '');
        const driver = join(dir, 'driver-emfile.mts');
        writeFileSync(
          driver,
          [
            `const { openSync, writeFileSync } = await import('node:fs');`,
            `const mod = await import(${JSON.stringify(pathToFileURL(captureTuiTs).href)});`,
            `mod.probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' });`,
            `const fdSource = ${JSON.stringify(join(dir, 'fd-source'))};`,
            `writeFileSync(fdSource, 'x');`,
            `for (;;) { try { openSync(fdSource, 'r'); } catch { break; } }`,
            `await mod.runCaptureTui({ command: 'printf hi', cwd: undefined, cols: 80, rows: 24, settleMs: 0, until: undefined, keys: undefined, out: ${JSON.stringify(join(dir, 'cap'))}, timeoutMs: 1000 } as never);`,
          ].join('\n'),
        );
        const { spawn } = await import('node:child_process');
        const child = spawn(process.execPath, ['--import', 'tsx', driver], {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (b: Buffer) => (out += b.toString()));
        child.stderr.on('data', (b: Buffer) => (out += b.toString()));
        // An external killer, like the FIFO sibling: an in-process timeout
        // cannot interrupt a child that never exits, so without this a
        // regression hangs the run instead of reddening it.
        const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        const code = await new Promise<number | null>((resolve) =>
          child.once('exit', (c) => resolve(c)),
        );
        clearTimeout(killer);
        expect(code).toBe(3);
        // The reason names the HOST, not the argument: this refusal used to
        // read '--out is not writable' under fd exhaustion, sending an
        // agent consumer to fix a --out that was fine. It is machine-read,
        // so the misattribution propagated into whatever acted on it.
        expect(out).toContain('out of file descriptors');
        expect(out).toContain('not a problem with the argument');
        expect(out).not.toContain('--out is not writable');
        // Unverifiable is not permission to delete.
        expect(existsSync(join(dir, 'cap.ans'))).toBe(true);
        expect(existsSync(join(dir, 'cap.png'))).toBe(true);
        expect(existsSync(join(dir, 'cap.json'))).toBe(true);
        // A user file at this name is not ours: the sentinel lives under
        // the system temp dir now. It used to be unlinked unconditionally,
        // before any refusal the run was already headed for.
        expect(existsSync(join(dir, 'cap.holder-ready'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
  // POSIX only, like every other child-spawning test here: on Windows a
  // broken pipe surfaces through libuv as UV_EOF/UV_EAGAIN
  // (ERROR_BROKEN_PIPE / ERROR_NO_DATA), never as EPIPE — and
  // guardBrokenPipes rethrows every non-EPIPE code while artifactsComplete
  // is false, so the refusal path this pins does not exist there.
  it.skipIf(process.platform === 'win32')(
    'holds the exit-3 contract when the stdout reader is GONE — EPIPE-proof',
    async () => {
      // withStdio mocks the streams, so no in-process test can raise a real
      // EPIPE; a child whose stdout pipe closes early can. Without the guard
      // the refusal crashed on the async 'error' event and exited 1.
      const captureTuiTs = captureTuiSource();
      const dir = mkdtempSync(join(tmpdir(), 'capture-tui-epipe-'));
      try {
        const driver = join(dir, 'driver-epipe.mts');
        writeFileSync(
          driver,
          [
            `const mod = await import(${JSON.stringify(pathToFileURL(captureTuiTs).href)});`,
            `mod.probes.tmux = () => ({ status: 'absent' }) as never;`,
            `// Give the pipe a beat to be closed by the parent first.`,
            `await new Promise((r) => setTimeout(r, 300));`,
            `await mod.runCaptureTui({ command: 'printf hi', cwd: undefined, cols: 80, rows: 24, settleMs: 0, until: undefined, keys: undefined, out: ${JSON.stringify(join(dir, 'cap'))}, timeoutMs: 1000 } as never);`,
          ].join('\n'),
        );
        const { spawn } = await import('node:child_process');
        const child = spawn(process.execPath, ['--import', 'tsx', driver], {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        // Kill the reader immediately: the child's refusal write hits EPIPE.
        child.stdout.destroy();
        // Same external killer as the FIFO sibling — see there for why an
        // in-process timeout cannot stand in for it.
        const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        const code = await new Promise<number | null>((resolve) =>
          child.once('exit', (c) => resolve(c)),
        );
        clearTimeout(killer);
        expect(code).toBe(3);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it('clears stale artifacts before the directory-shaped --out refusal too', async () => {
    // The last nameable gate without an ordering pin: a mutant hoisting the
    // isDirectory check above the clears left the previous run's manifest
    // beside the refusal.
    probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
    const dir = mkdtempSync(join(tmpdir(), 'capture-tui-dirout-'));
    try {
      writeFileSync(join(dir, 'adir.ans'), 'old');
      writeFileSync(join(dir, 'adir.png'), 'old');
      writeFileSync(join(dir, 'adir.json'), staleManifest(join(dir, 'adir')));
      mkdirSync(join(dir, 'adir'));
      const { stderr } = await withStdio(() =>
        runCaptureTui({
          command: 'printf hi',
          cwd: undefined,
          cols: 80,
          rows: 24,
          settleMs: 0,
          until: undefined,
          keys: undefined,
          out: join(dir, 'adir'),
          timeoutMs: 1000,
        } as never),
      );
      expect(process.exitCode).toBe(3);
      expect(stderr).toContain('existing directory');
      expect(existsSync(join(dir, 'adir.ans'))).toBe(false);
      expect(existsSync(join(dir, 'adir.json'))).toBe(false);
      expect(existsSync(join(dir, 'adir'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registers the full REAP set — a pure pin, gated on nothing', () => {
    // The set check needs neither tmux nor pgrep; buried in a skipIf test
    // it vanished on slim hosts — where dropping SIGHUP/SIGQUIT (a
    // regression that shipped green once before) would ship green again.
    expect([...REAP_SIGNALS].sort()).toEqual([
      'SIGHUP',
      'SIGINT',
      'SIGQUIT',
      'SIGTERM',
    ]);
  });
});

// The command boundary drives REAL tmux — a private-server capture the mocks
// cannot vouch for (the isolation property IS the exec shape). Skipped where
// tmux is absent; the pure plan shapes stay pinned in tui-capture.test.ts
// everywhere.
describe.skipIf(!hasTmux)('capture-tui (real tmux)', () => {
  let dir: string;
  // The probe seams are restored HERE, not per test: a test that fakes the
  // version and forgets to put it back leaves every later capture believing
  // it, and the plan then sends flags the real tmux may not have. That is
  // exactly what happened — a leaked 'tmux 3.9' made 20 captures send -T on
  // a runner whose tmux is 3.2a, and it was invisible on a dev machine
  // whose tmux accepts -T. A hook cannot be forgotten.
  const realTmuxProbe = probes.tmux;
  const realFreezeProbe = probes.freeze;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'capture-tui-'));
    process.exitCode = undefined;
  });
  afterEach(() => {
    probes.tmux = realTmuxProbe;
    probes.freeze = realFreezeProbe;
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

  it('refuses a FIFO at <out>.json instead of hanging on it', async () => {
    // The manifest checks and the read used to resolve the path twice, so a
    // racer could swap a verified regular file for a FIFO and hang the
    // synchronous read forever — no refusal printed, no timeout able to
    // interrupt it. One descriptor decides both now, opened non-blocking.
    // A FIFO standing there from the start is the same shape without the
    // race, and it must not stall the run.
    // No wall-clock assertion here: it would only run once the call had
    // already returned, and under the regression it names — a blocking
    // synchronous FIFO read — the event loop never gets there. The bound
    // that actually bites is this test's own budget below, which fails the
    // test by name instead of letting a hang masquerade as a slow run.
    const { stderr } = await withStdio(() =>
      run({
        command: `mkfifo cap.json 2>/dev/null || mknod cap.json p; printf 'MARK\\n'; sleep 20`,
        until: 'MARK',
      }),
    );
    expect(process.exitCode).toBe(3);
    expect(stderr).toContain('claimed during the capture window');
    // Not ours, so still there.
    expect(existsSync(join(dir, 'cap.json'))).toBe(true);
  }, 45_000);

  it('refuses when the CAPTURED COMMAND claims an artifact path mid-window', async () => {
    // The collision gate runs before the window; the window then lasts up
    // to --timeout-ms. Probe-reproduced: a command writing its own
    // <out>.json had that file silently replaced and the run reported
    // success — the same ownership harm the pre-window gate exists to
    // prevent, arriving from inside the capture instead of before it. The
    // refusal must ALSO leave the occupant alone: this run's cleanup path
    // would otherwise delete the very file it refused to replace.
    const { stderr } = await withStdio(() =>
      run({
        command: `printf 'USER-FILE-CONTENT' > cap.json; printf 'MARK\\n'; sleep 20`,
        until: 'MARK',
      }),
    );
    expect(process.exitCode).toBe(3);
    expect(stderr).toContain('claimed during the capture window');
    expect(readFileSync(join(dir, 'cap.json'), 'utf8')).toBe(
      'USER-FILE-CONTENT',
    );
  });

  it('does not follow a SYMLINK planted at <out>.ans mid-window', async () => {
    // The write followed links, and the occupancy check that guards it ran
    // before the window: a symlink planted at <out>.ans during the capture
    // redirected this run's bytes OUT of the --out base — exactly what the
    // lstat-based gate refuses at check time. The target must stay empty
    // and the run must refuse rather than write through the link.
    const outside = join(dir, 'outside-the-base');
    writeFileSync(outside, 'untouched');
    const { stderr } = await withStdio(() =>
      run({
        command: `ln -s '${outside}' cap.ans; printf 'MARK\\n'; sleep 20`,
        until: 'MARK',
      }),
    );
    expect(process.exitCode).toBe(3);
    expect(stderr).toContain('claimed during the capture window');
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
    // The link itself is not ours to remove either.
    expect(lstatSync(join(dir, 'cap.ans')).isSymbolicLink()).toBe(true);
  });

  it.skipIf(tmuxPadsWithCaptureN(tmuxVersionProbe.stdout ?? '') !== true)(
    'names the padding tmux ONCE in the degradation, not twice',
    async () => {
      // tmuxVersion is already the `tmux -V` line, so the prefix produced
      // "tmux tmux 3.2a" in the manifest of every capture on a padding
      // host. Nothing pinned the string — the only `pads` reference in
      // this file was a skipIf guard.
      await run();
      const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
      expect(manifest.degradedBecause).toContain('pads capture-pane -N');
      expect(manifest.degradedBecause).not.toContain('tmux tmux');
    },
  );

  it('an ans-only manifest does not authorize clearing <out>.png', async () => {
    // Mutation-probed: dropping the `manifestHadPng` condition shipped the
    // whole suite green while this exact shape deleted a user's file. A
    // previous run that degraded to ans-only names no png in its manifest,
    // so whatever sits at <out>.png is someone else's — and the re-run
    // against the same --out (the documented reuse shape) must degrade its
    // own png rung rather than clear the way for one. Real tmux, real
    // version: faking 3.9 here would send flags an older runner's tmux
    // rejects.
    writeFileSync(join(dir, 'cap.ans'), 'old run');
    writeFileSync(join(dir, 'cap.png'), 'user file');
    writeFileSync(
      join(dir, 'cap.json'),
      staleManifest(join(dir, 'cap'), 'ans-only'),
    );
    const { stderr } = await withStdio(() => run());
    expect(process.exitCode).toBeUndefined();
    // Untouched, byte for byte — the whole point.
    expect(readFileSync(join(dir, 'cap.png'), 'utf8')).toBe('user file');
    // ...and the run says so instead of quietly claiming a png rung.
    expect(stderr).toContain('holds a file this capture did not write');
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.evidence).toBe('ans-only');
    expect(manifest.pngPath).toBeNull();
    // Its own .ans was cleared and rewritten by this run.
    expect(readFileSync(join(dir, 'cap.ans'), 'utf8')).toContain('WORLD');
  });

  it('an ans-only manifest with a string pngPath still spares <out>.png', async () => {
    // The internally inconsistent shape: a signature-passing manifest whose
    // evidence says ans-only but whose pngPath is a string. The old
    // disjunct fired on it and cleared the user's file (probe-reproduced),
    // contradicting the guard's own invariant — an ans-only run wrote no
    // png, so nothing at that name is the next run's to remove.
    writeFileSync(join(dir, 'cap.ans'), 'old run');
    writeFileSync(join(dir, 'cap.png'), 'user file');
    writeFileSync(
      join(dir, 'cap.json'),
      JSON.stringify({
        evidence: 'ans-only',
        ansPath: join(dir, 'cap.ans'),
        pngPath: join(dir, 'cap.png'),
        settledBy: 'fixed-delay',
      }),
    );
    const { stderr } = await withStdio(() => run());
    expect(process.exitCode).toBeUndefined();
    expect(readFileSync(join(dir, 'cap.png'), 'utf8')).toBe('user file');
    expect(stderr).toContain('holds a file this capture did not write');
  });

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
    // Field-omission contract in the HAPPY shape: no keys were given, so
    // keysSent must be absent (a keysSent=false initialization mutant would
    // report "keys withheld" on a keys-less run); until was given, so
    // settleMs must be absent.
    expect(manifest.keysSent).toBeUndefined();
    expect(manifest.settleMs).toBeUndefined();
    if (hasFreeze) {
      // A present-but-broken freeze (--help exits 0, render dies) degrades
      // to ans-only BY CONTRACT — that is a designed rung, not a failure.
      expect(['png', 'ans-only']).toContain(manifest.evidence);
      if (manifest.evidence === 'png') {
        expect(manifest.pngPath).toBe(join(dir, 'cap.png'));
        expect(existsSync(join(dir, 'cap.png'))).toBe(true);
      } else {
        expect(manifest.degradedBecause).toContain('freeze');
      }
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
      // The repeated marker is built in NODE, not `$(seq …)`: seq is GNU
      // coreutils, and a pane shell without it (stock macOS userland ships
      // jot) expanded the fixture to `MEND` — the until marker never
      // matched and the test failed red while Linux CI showed green
      // (probe-verified with an exit-127 PATH shim).
      command: `printf "%sEND\\n" "${'M'.repeat(60)}"; sleep 30`,
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
      // Node-built repetition — the `$(seq …)` fixture was GNU-only; see
      // the wrap-boundary sibling for the probe.
      command: `printf '%s\\n' "${'a'.repeat(79)}"; sleep 30`,
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
    // TMUX_TMPDIR under the test dir, restored after: standard CI lanes
    // set no TMUX_TMPDIR, so without this the production TMUX_TMPDIR
    // branch of the socket-dir resolution never runs there — a
    // /tmp-hardcoding mutant ships green on those lanes, and on hosts that
    // DO set the variable it unlinks in /tmp while tmux created the socket
    // under $TMUX_TMPDIR/tmux-<uid>/ (measured: tmux honors the variable).
    // SHORT on purpose, and not under the mkdtemp base: a unix socket path
    // is capped at ~104 bytes, and the deep /var/folders path this suite's
    // dirs live under blew past it — the capture then refused mid-run and
    // the leftover-socket probe below found an empty directory and passed
    // over the branch it exists to watch (which is why the success
    // assertions were added).
    const tmuxTmp = join('/tmp', `qtt-${process.pid}`);
    rmSync(tmuxTmp, { recursive: true, force: true });
    mkdirSync(tmuxTmp, { mode: 0o700, recursive: true });
    const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
    process.env['TMUX_TMPDIR'] = tmuxTmp;
    try {
      await run();
    } finally {
      if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
      else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
    }
    // The capture SUCCEEDED — otherwise this pins nothing: a run that
    // refuses under a custom TMUX_TMPDIR creates no server at all, the
    // probe below finds an empty directory, and both assertions pass over
    // the broken branch they exist to watch.
    expect(process.exitCode).toBeUndefined();
    expect(readFileSync(join(dir, 'cap.ans'), 'utf8')).toContain('WORLD');
    // Any server this run created is named qwen-review-capture-<ourpid>-…;
    // asking it for sessions must fail because the server is gone. Probe
    // the SAME dir production resolved — the TMUX_TMPDIR this test set —
    // so a regression in that branch cannot pass this probe vacuously.
    const base = tmuxTmp;
    // Quote the dir and grep the names: interpolating ${base} unquoted into
    // a glob makes this assertion pass VACUOUSLY whenever TMUX_TMPDIR
    // carries whitespace (measured with a planted orphan in such a dir).
    const probe = spawnSync('bash', [
      '-c',
      `ls "${base}/tmux-$(id -u)" 2>/dev/null | grep "^qwen-review-capture-${process.pid}-" || true`,
    ]);
    // Binary absence must be loud: with no bash, stdout is undefined and the
    // empty-string assertion below would pass while checking nothing.
    expect(probe.error).toBeUndefined();
    expect((probe.stdout ?? Buffer.from('')).toString().trim()).toBe('');
    rmSync(tmuxTmp, { recursive: true, force: true });
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
      '#!/bin/sh\n[ "$1" = "-V" ] && exit 0\nfor a in "$@"; do [ "$a" = "kill-server" ] && { echo "no server running on /tmp/x" >&2; exit 1; }; done\necho "fake tmux: refusing" >&2\nexit 1\n',
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
    // The DIAGNOSTIC rides the reason (stderr tail first): with the ||
    // operands swapped the reason degrades to the failed argv line and the
    // real cause is lost to the consumer.
    expect(stderr).toContain('fake tmux: refusing');
    // The start that threw created no server: reap() still attempts the
    // kill (the flag precedes the call), and the goal-state answer keeps it
    // silent — a warning here would send an operator hunting a socket that
    // was never created.
    expect(stderr).not.toContain('may still be running');
    expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
    expect(existsSync(join(dir, 'cap.json'))).toBe(false);
    expect(leakedSentinels()).toEqual([]);
  });

  it('reaps a server whose START died on the belt — the flag precedes the call', async () => {
    // plan.start forks the server in the SAME client call that creates the
    // session: a start cut by the control belt throws with the server
    // ALREADY UP. serverStarted must precede the call, or reap() skips
    // exactly that window and orphans the server (measured shape on loaded
    // runners). The fake's new-session hangs past the seam and its
    // kill-server answers the goal state: the call log proves the kill was
    // ATTEMPTED — with the flag after the call, reap() returns early and
    // no kill-server ever reaches the log.
    const binDir = join(dir, 'fakebin');
    mkdirSync(binDir, { recursive: true });
    const callLog = join(dir, 'tmux-calls');
    writeFileSync(
      join(binDir, 'tmux'),
      `#!/bin/sh\necho "$*" >> "${callLog}"\n[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }\nfor a in "$@"; do [ "$a" = "new-session" ] && sleep 5; done\nfor a in "$@"; do [ "$a" = "kill-server" ] && { echo "no server running on /tmp/x" >&2; exit 1; }; done\necho ""\nexit 0\n`,
      { mode: 0o755 },
    );
    const realBelt = tmuxControl.timeoutMs;
    tmuxControl.timeoutMs = 500;
    const started = performance.now();
    const realPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
    let stderr = '';
    try {
      ({ stderr } = await withStdio(() =>
        run({ until: undefined, settleMs: 0 }),
      ));
    } finally {
      if (realPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = realPath;
      tmuxControl.timeoutMs = realBelt;
    }
    const elapsed = performance.now() - started;
    // The belt cut the hung start — the 5s sleep never ran out.
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(4_000);
    expect(process.exitCode).toBe(3);
    expect(stderr).toContain('tmux failed mid-capture');
    // The reap ATTEMPTED the kill despite the start never returning.
    expect(readFileSync(callLog, 'utf8')).toContain('kill-server');
    expect(stderr).not.toContain('may still be running');
  }, 15_000);

  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    'refuses a FAILED .ans write after capture — contract, not stack trace',
    async () => {
      // The capture window legally runs up to an hour; the disk can fill
      // (or the target turn hostile) inside it. Reaching the WRITE failure
      // now takes a blocker the occupancy gate cannot see: a directory at
      // the .ans path is intercepted as a mid-window collision before
      // openSync is ever attempted (which is correct, and pinned
      // elsewhere), so this drops the write permission on the PARENT —
      // unstamped, unwatched, and exactly the "target turns hostile" shape.
      const { stdout, stderr } = await withStdio(() =>
        run({
          command: 'chmod a-w .; printf "RO-DIR\\n"; sleep 30',
          until: 'RO-DIR',
        }),
      );
      // Restore first: the suite's own cleanup cannot empty a read-only dir.
      chmodSync(dir, 0o700);
      expect(process.exitCode).toBe(3);
      expect(stderr).toContain('cannot write capture output');
      expect(stderr).toContain('EACCES');
      expect(JSON.parse(stdout.trim())).toEqual({
        captured: false,
        evidence: 'none',
        reason: expect.stringContaining('cannot write capture output'),
      });
      // Nothing of OURS remains — and nothing that was not ours was touched.
      expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
      expect(existsSync(join(dir, 'cap.png'))).toBe(false);
      expect(existsSync(join(dir, 'cap.json'))).toBe(false);
      expect(leakedSentinels()).toEqual([]);
    },
  );

  it('removes what it already wrote when the MANIFEST path is claimed', async () => {
    // Was aimed at the manifest write failing EISDIR on a directory the
    // command creates. That now refuses one step earlier — the mid-window
    // occupancy gate sees the directory before openSync is attempted — so
    // what this pins is the half it still reaches, and the half that
    // matters: the .ans is already on disk when the refusal happens, and
    // the run must not leave it there undescribed ("THIS run's artifacts
    // or nothing"). The write-failure branch proper is pinned by the .ans
    // sibling above, through a read-only parent.
    const { stdout, stderr } = await withStdio(() =>
      run({
        command: 'mkdir cap.json; printf "DIR-BLOCK2\\n"; sleep 30',
        until: 'DIR-BLOCK2',
      }),
    );
    expect(process.exitCode).toBe(3);
    expect(stderr).toContain('cannot write capture manifest');
    expect(stderr).toContain('claimed during the capture window');
    expect(JSON.parse(stdout.trim())).toEqual({
      captured: false,
      evidence: 'none',
      reason: expect.stringContaining('cannot write capture manifest'),
    });
    expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
    expect(existsSync(join(dir, 'cap.png'))).toBe(false);
    expect(statSync(join(dir, 'cap.json')).isDirectory()).toBe(true);
    expect(leakedSentinels()).toEqual([]);
  });

  it('a user DIRECTORY at <out>.holder-ready no longer breaks the run', async () => {
    // Was: the sentinel sat at this path, so a user's directory there made
    // the run refuse (`--out is not writable`) — a capture destroyed by a
    // name collision in the user's own namespace. The sentinel moved under
    // the system temp dir, so the directory is now simply none of our
    // business: it survives untouched and the capture still succeeds.
    mkdirSync(join(dir, 'cap.holder-ready'));
    writeFileSync(join(dir, 'cap.holder-ready', 'user-file'), 'content');
    await withStdio(() => run());
    expect(process.exitCode).toBeUndefined();
    expect(statSync(join(dir, 'cap.holder-ready')).isDirectory()).toBe(true);
    expect(
      readFileSync(join(dir, 'cap.holder-ready', 'user-file'), 'utf8'),
    ).toBe('content');
    expect(leakedSentinels()).toEqual([]);
  });

  it('a pre-existing DIRECTORY at the png path survives the ans-only run', async () => {
    // No manifest → shaped=false → the clear phase protects the directory;
    // the freeze torn-png cleanup is a plain rmSync, so the directory's
    // EISDIR is swallowed and the otherwise-successful run never deletes
    // what it did not write (recursive removal destroyed the tree and the
    // run still reported success — measured).
    mkdirSync(join(dir, 'cap.png'));
    writeFileSync(join(dir, 'cap.png', 'user-file'), 'content');
    await run();
    expect(process.exitCode).toBeUndefined();
    expect(statSync(join(dir, 'cap.png')).isDirectory()).toBe(true);
    expect(readFileSync(join(dir, 'cap.png', 'user-file'), 'utf8')).toBe(
      'content',
    );
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.evidence).toBe('ans-only');
    expect(existsSync(join(dir, 'cap.ans'))).toBe(true);
  });

  it('keeps the exit contract when the reap WARNING cannot be written', async () => {
    // reap() runs from the finally and from onSignal; a throwing stderr
    // write there turned an exit-3 refusal into an exit-1 stack trace (and
    // an uncaughtException out of the signal handler, killing the re-raise).
    // The write is incidental — its reader going away must not decide the
    // command's disposition.
    const binDir = join(dir, 'fakebin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'tmux'),
      `#!/bin/sh\n[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }\nfor a in "$@"; do [ "$a" = "kill-server" ] && { echo "wedged" >&2; exit 1; }; done\ns=$(printf '%s\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1); [ -n "$s" ] && : > "$s"\necho ""\nexit 0\n`,
      { mode: 0o755 },
    );
    // NOT withStdio: it installs its own stderr spy, which would replace a
    // throwing one — the sinks are wired by hand so the WARNING write is
    // the one that fails.
    const sinks = { stdout: '', stderr: '' };
    const realPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      sinks.stdout += String(chunk);
      return true;
    }) as never);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      const text = String(chunk);
      if (text.includes('WARNING')) {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      }
      sinks.stderr += text;
      return true;
    }) as never);
    try {
      await run({ until: undefined, settleMs: 0 });
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
      if (realPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = realPath;
    }
    const stdout = sinks.stdout;
    // The capture still completed: no stack trace, no exit-1 disposition.
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(join(dir, 'cap.ans'))).toBe(true);
    expect(JSON.parse(stdout.trim().split('\n').at(-1) ?? '')).toMatchObject({
      captured: true,
    });
  });

  it('WARNS when kill-server fails twice — never an unqualified success', async () => {
    // A fake tmux that succeeds at everything except kill-server models the
    // wedged-server shape: the reap retries once, then must say so — a
    // presumed-alive private server holding a pane for up to three hours
    // is not a silent outcome.
    const binDir = join(dir, 'fakebin');
    mkdirSync(binDir, { recursive: true });
    const callLogPath = join(dir, 'tmux-calls');
    writeFileSync(
      join(binDir, 'tmux'),
      `#!/bin/sh\necho "$@" >> "${callLogPath}"\n[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }\nfor a in "$@"; do [ "$a" = "kill-server" ] && { sleep 5; echo "wedged" >&2; exit 1; }; done\ns=$(printf '%s\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1); [ -n "$s" ] && : > "$s"\necho ""\nexit 0\n`,
      { mode: 0o755 },
    );
    // TMUX_TMPDIR controlled like the sibling socket-dir tests: the reap
    // iterates one candidate base per distinct value, and a host exporting
    // one logged 4 kill calls against this test's 2-call cap — a false red
    // unrelated to the retry count (CI lanes export none, so the
    // fragility shipped invisibly).
    const realTmuxTmpdir = process.env['TMUX_TMPDIR'];
    delete process.env['TMUX_TMPDIR'];
    // The control-call belt through its SEAM: the fake kill HANGS (sleep 5)
    // and the shortened belt must cut it — a hardcoded-timeout mutant waits
    // out both 5s hangs and blows the wall bound.
    const realBelt = tmuxControl.timeoutMs;
    tmuxControl.timeoutMs = 500;
    const started = performance.now();
    const realPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
    let stdout = '';
    let stderr = '';
    try {
      ({ stdout, stderr } = await withStdio(() =>
        run({ until: undefined, settleMs: 0 }),
      ));
    } finally {
      if (realPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = realPath;
      if (realTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
      else process.env['TMUX_TMPDIR'] = realTmuxTmpdir;
      tmuxControl.timeoutMs = realBelt;
    }
    expect(performance.now() - started).toBeLessThan(8_000);
    expect(stderr).toContain('WARNING');
    expect(stderr).toContain('kill-server failed twice');
    // The cap is ONE retry, pinned from ABOVE too: the assertions here hold
    // for any cap up to ~13 under the shortened belt, and the "failed
    // twice" wording blesses whatever the cap happens to be. Against a
    // genuinely wedged server every extra attempt pays the full 15s belt
    // while the capture is already done.
    const killCalls = readFileSync(callLogPath, 'utf8')
      .split('\n')
      .filter((l) => l.includes('kill-server'));
    expect(killCalls).toHaveLength(2);
    // The other half of "never an unqualified success": a wedged reap is a
    // WARNING next to a COMPLETE capture, not a failure — exit code clean,
    // artifacts written, success JSON emitted (a mutant setting exitCode
    // in the reap's !serverDead branch reports exit 3 next to a finished
    // capture, and shipped green before these assertions).
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(join(dir, 'cap.ans'))).toBe(true);
    expect(existsSync(join(dir, 'cap.json'))).toBe(true);
    expect(JSON.parse(stdout.trim().split('\n').at(-1) ?? '')).toMatchObject({
      captured: true,
    });
    // The sentinel is plumbing — removed on every exit path, including this
    // degraded one whose fixture is the only one that creates it.
    expect(leakedSentinels()).toEqual([]);
  });

  it('refuses when the holder never initializes — and sends NO key into the void', async () => {
    // A fake tmux that succeeds every command but whose new-session writes
    // no sentinel models a pane that died at startup: the 10s holder
    // deadline must refuse (not hang, not fire keys at an unknown screen).
    const binDir = join(dir, 'fakebin');
    mkdirSync(binDir, { recursive: true });
    const callLog = join(dir, 'tmux-calls');
    writeFileSync(
      join(binDir, 'tmux'),
      `#!/bin/sh\necho "$*" >> "${callLog}"\n[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }\necho ""\nexit 0\n`,
      { mode: 0o755 },
    );
    const realHolder = holderInit.timeoutMs;
    holderInit.timeoutMs = 600;
    const started = performance.now();
    const realPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
    let stderr = '';
    try {
      ({ stderr } = await withStdio(() =>
        run({ keys: ['C-c'], until: undefined, settleMs: 0 }),
      ));
    } finally {
      if (realPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = realPath;
      holderInit.timeoutMs = realHolder;
    }
    expect(process.exitCode).toBe(3);
    // The deadline actually elapsed (floor) and is seam-driven (ceiling —
    // the hardcoded-10s mutant blows it).
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(550);
    expect(waited).toBeLessThan(5_000);
    expect(stderr).toContain('never initialized');
    // No key was fired into the uninitialized pane.
    expect(readFileSync(callLog, 'utf8')).not.toContain('send-keys');
  }, 20_000);

  it('treats a kill answering "no server running" as the goal state — no WARNING', async () => {
    // A server dying between the last capture and the reap is success, not
    // a wedge: the always-false regex mutant printed a false WARNING that
    // sends an operator hunting a server that does not exist.
    const binDir = join(dir, 'fakebin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'tmux'),
      `#!/bin/sh\n[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }\nfor a in "$@"; do [ "$a" = "kill-server" ] && { echo "no server running on /tmp/x" >&2; exit 1; }; done\ns=$(printf '%s\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1); [ -n "$s" ] && : > "$s"\necho ""\nexit 0\n`,
      { mode: 0o755 },
    );
    const realPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
    let stderr = '';
    try {
      ({ stderr } = await withStdio(() =>
        run({ until: undefined, settleMs: 0 }),
      ));
    } finally {
      if (realPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = realPath;
    }
    expect(process.exitCode).toBeUndefined();
    expect(stderr).not.toContain('WARNING');
    expect(existsSync(join(dir, 'cap.json'))).toBe(true);
  });

  it('records the LAUNCHER cwd when --cwd is omitted', async () => {
    // Every other success capture passes an explicit cwd; the default
    // branch feeds both new-session -c and the manifest — a mutant default
    // would make the capture's only record name a directory the command
    // never ran in.
    await runCaptureTui({
      command: 'printf "CWDLESS\\n"; sleep 30',
      cwd: undefined,
      cols: 80,
      rows: 24,
      settleMs: 0,
      until: 'CWDLESS',
      keys: undefined,
      out: join(dir, 'nocwd'),
      timeoutMs: 10_000,
    } as never);
    const manifest = JSON.parse(readFileSync(join(dir, 'nocwd.json'), 'utf8'));
    expect(manifest.cwd).toBe(process.cwd());
  });

  it('survives a C-\\ sent through --keys — QUIT is trapped at layer 0', async () => {
    // The wrapped holder trapped one layer deep: INT survived by shell
    // wait semantics, QUIT killed the untrapped session leader (measured:
    // exit 3, "no server running", zero artifacts). The unwrapped script
    // traps both at the pane's own shell.
    await runCaptureTui({
      command: 'cat',
      cwd: dir,
      cols: 80,
      rows: 24,
      settleMs: 800,
      until: undefined,
      keys: ['C-\\'],
      out: join(dir, 'cq'),
      timeoutMs: 10_000,
    } as never);
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(join(dir, 'cq.json'))).toBe(true);
  });

  it('renders WIDTH x HEIGHT, not height x width — the frame has rows lines', async () => {
    // validGeometry accepts a transposed pair, so only a behavioral pin
    // catches a cols/rows swap: a 30x10 pane captures as 10 physical lines.
    await run({
      command: 'printf "GEOM\\n"; sleep 30',
      until: 'GEOM',
      cols: 30,
      rows: 10,
      out: join(dir, 'geom'),
    });
    const ans = readFileSync(join(dir, 'geom.ans'), 'utf8');
    const lines = ans.replace(/\n$/, '').split('\n').length;
    expect(lines).toBe(10);
  });

  it('reaps on the SECOND kill attempt without a WARNING — the retry is real', async () => {
    // Every prior fixture failed both attempts or neither; the fail-once
    // shape is what the retry exists for, and a retry-less mutant WARNs.
    const binDir = join(dir, 'fakebin');
    mkdirSync(binDir, { recursive: true });
    const marker = join(dir, 'kill-attempted');
    writeFileSync(
      join(binDir, 'tmux'),
      `#!/bin/sh\n[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }\nfor a in "$@"; do [ "$a" = "kill-server" ] && { if [ ! -e "${marker}" ]; then : > "${marker}"; echo "transient" >&2; exit 1; fi; exit 0; }; done\ns=$(printf '%s\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1); [ -n "$s" ] && : > "$s"\necho ""\nexit 0\n`,
      { mode: 0o755 },
    );
    const realPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${realPath ?? ''}`;
    let stderr = '';
    try {
      ({ stderr } = await withStdio(() =>
        run({ until: undefined, settleMs: 0 }),
      ));
    } finally {
      if (realPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = realPath;
    }
    expect(process.exitCode).toBeUndefined();
    expect(stderr).not.toContain('WARNING');
    expect(existsSync(marker)).toBe(true);
  });

  it('unlinks the socket from /tmp when TMUX_TMPDIR points somewhere unusable', async () => {
    // tmux takes the first USABLE base, so the socket really lives under
    // /tmp; the env-base-only unlink mutant left dead sockets littering it.
    const realEnv = process.env['TMUX_TMPDIR'];
    process.env['TMUX_TMPDIR'] = join(dir, 'no-such-base');
    try {
      await run({ until: undefined, settleMs: 0, out: join(dir, 'tt') });
    } finally {
      if (realEnv === undefined) delete process.env['TMUX_TMPDIR'];
      else process.env['TMUX_TMPDIR'] = realEnv;
    }
    expect(process.exitCode).toBeUndefined();
    const probe = spawnSync('bash', [
      '-c',
      `ls "/tmp/tmux-$(id -u)" 2>/dev/null | grep "^qwen-review-capture-${process.pid}-" || true`,
    ]);
    expect(probe.error).toBeUndefined();
    expect((probe.stdout ?? Buffer.from('')).toString().trim()).toBe('');
  });

  it('settles by regex when --until matches, and says so', async () => {
    await run({ until: 'WORLD', settleMs: 0 });
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.settledBy).toBe('until-match');
  });

  it('captures anyway on --until timeout and records the degraded settle', async () => {
    const started = performance.now();
    await run({ until: 'NEVER-APPEARS', timeoutMs: 1500, settleMs: 0 });
    const elapsed = performance.now() - started;
    expect(process.exitCode).toBeUndefined();
    // The poll SPENT its budget. Everything else here is satisfied by a
    // mutant that bails on the first miss and records `settledBy:
    // 'timeout'` anyway — the marker would then be declared absent after
    // one look, and a UI that renders it 200ms later is reported as never
    // having rendered it. A floor at 80% of the deadline tolerates timer
    // coarseness without tolerating a curtailed poll.
    expect(elapsed).toBeGreaterThan(1500 * 0.8);
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.settledBy).toBe('timeout');
    // timeoutMs recorded on an UNTIL-ONLY run too: every other timeoutMs
    // assertion in this suite rides a --ready run, so a spread mutated to
    // `args.ready !== undefined` alone shipped green while every until-only
    // capture silently lost the record of its governing budget.
    expect(manifest.timeoutMs).toBe(1500);
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
    // settle-ms's 600_000 ceiling was unpinned: only its negative side was
    // tested, and a raised-max mutant accepted a 1-hour fixed delay.
    await run({ until: undefined, settleMs: 600_001 });
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
    // lost). The drain does NOT hide early keys from the pane — the kernel
    // echoes them before the fixture's read -s begins (measured) — so the
    // pin below is the ORDER (gated keys after READY): the one signal that
    // actually discriminates gated from ungated.
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
    const ans = readFileSync(join(dir, 'ready.ans'), 'utf8');
    expect(ans).toContain('gated-input');
    // Order is the discriminating signal: ungated, the keys still echo
    // into the pane, `until` matches on the echo, and every assertion
    // above stays green against the exact regression this test was written
    // to catch (measured: the no-gate mutant passed in 35ms).
    expect(ans.indexOf('gated-input')).toBeGreaterThan(ans.indexOf('READY'));
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
    const ans = readFileSync(join(dir, 'cap.ans'), 'utf8');
    // The pty would echo even unread keystrokes — absence proves withheld.
    expect(ans).not.toContain('DANGER');
    // And the late frame is a real frame: dropping the readyFailed-branch
    // capture shipped a 0-byte .ans whose degradation claimed "late frame
    // captured" while a second entry said "pane captured empty".
    expect(ans).toContain('HELLO-');
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
    expect(leakedSentinels()).toEqual([]);
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
    // The capture happens AFTER the wait: a sleep↔capture swap published a
    // pre-render frame as the settled rung.
    expect(readFileSync(join(dir, 'cap.ans'), 'utf8')).toContain('HELLO-');
  });

  it('settles by FIXED DELAY after a matched --ready without --until', async () => {
    // Every ready-matched test also passed --until, leaving this branch —
    // fixed delay AFTER the gate opens, and its dual-duration manifest —
    // unpinned: two mutants shipped green (skipping the settle sleep;
    // dropping settleMs from this shape's manifest).
    const started = performance.now();
    await runCaptureTui({
      command: `bash -c 'printf "READY-NO-UNTIL\\n"; sleep 0.3; printf "SETTLED-LATE\\n"; cat'`,
      cwd: dir,
      cols: 80,
      rows: 24,
      settleMs: 600,
      until: undefined,
      ready: 'READY-NO-UNTIL',
      keys: undefined,
      out: join(dir, 'readyfixed'),
      timeoutMs: 10_000,
    } as never);
    const elapsed = performance.now() - started;
    expect(process.exitCode).toBeUndefined();
    // Wall bound on the settle; the content check below is the real
    // discriminator, and this bound catches a sleep(timeoutMs) mutant.
    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(elapsed).toBeLessThan(8_000);
    const manifest = JSON.parse(
      readFileSync(join(dir, 'readyfixed.json'), 'utf8'),
    );
    expect(manifest.settledBy).toBe('fixed-delay');
    expect(manifest.settleMs).toBe(600);
    // BOTH durations are active in this shape: ready spent the timeout
    // budget AND settle governed the wait — omitting either misdescribes
    // the run (the ACTIVE-durations contract).
    expect(manifest.timeoutMs).toBe(10_000);
    // The settle really waited: the frame carries the line that renders
    // 300ms AFTER the ready marker matched — a skipped sleep captures
    // before it exists.
    const ans = readFileSync(join(dir, 'readyfixed.ans'), 'utf8');
    expect(ans).toContain('READY-NO-UNTIL');
    expect(ans).toContain('SETTLED-LATE');
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
    probes.freeze = () => ({ status: 'ok', out: '' }) as const;
    freezeRender.bin = bin;
    try {
      await fn();
    } finally {
      probes.freeze = realFreeze;
      freezeRender.bin = realBin;
    }
  }

  it('renders only AFTER the .ans is on disk — text evidence survives a hang', async () => {
    // The fake refuses to render unless the .ans already exists and is
    // non-empty: a write-after-render mutant fails it.
    await withFakeFreeze(
      '#!/bin/sh\n[ -s "$3" ] || { echo "ans missing at render time" >&2; exit 9; }\nprintf x > "$5"\nexit 0\n',
      () => run(),
    );
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.evidence).toBe('png');
  });

  it('degrades when the rendered png cannot be statted, never crashes', async () => {
    // Honest about what this covers: the hazard the guard closes is a
    // TOCTOU — the png vanishing BETWEEN the existsSync and the statSync,
    // reachable only with a concurrent deleter or fs fault injection, and
    // this test does not reproduce it (a dangling symlink short-circuits
    // at existsSync, so the pre-guard code degrades here too). What it
    // does pin is the branch the guard creates: a path freeze left that
    // cannot be statted produces a clean ans-only contract rather than an
    // uncaught ENOENT — exit 1, no contract JSON, a stack trace, and both
    // artifacts orphaned with no manifest (fault-injected upstream).
    await withFakeFreeze(
      '#!/bin/sh\nln -s /no-such-target-for-stat "$5"\nexit 0\n',
      () => run(),
    );
    expect(process.exitCode).toBeUndefined();
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.evidence).toBe('ans-only');
    expect(manifest.pngPath).toBeNull();
    expect(manifest.degradedBecause).toContain('exited 0 but wrote no image');
    expect(existsSync(join(dir, 'cap.ans'))).toBe(true);
  });

  it('does not blame the render belt for a maxBuffer overrun', async () => {
    // Both shapes kill with SIGKILL and set r.error, so presence alone
    // could not tell them apart and the overrun was recorded as 'signal
    // SIGKILL after the 30000ms render belt' — a hang that never happened.
    // The fake spews past the cap instead of hanging: same disposition,
    // different cause.
    await withFakeFreeze('#!/bin/sh\nexec yes "spew" \n', () => run());
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.evidence).toBe('ans-only');
    expect(manifest.degradedBecause).toContain('signal SIGKILL');
    expect(manifest.degradedBecause).not.toContain('render belt');
    expect(manifest.degradedBecause).toContain('bytes this spawn captures');
  }, 60_000);

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

  it('leaves a TORN png in place when the render fails — deletion cannot attribute it', async () => {
    // A freeze that writes bytes to the png path and THEN fails leaves an
    // occupant an empty pre-window stamp cannot attribute: the identical
    // shape is a foreign file claimed during the probe/render window (the
    // captured command is the named planter), and deleting on presence
    // alone destroyed such a file on a run that reported success
    // (probe-reproduced). The sibling manifest-write cleanup already
    // spares the png whenever the render produced nothing; the
    // failed-render arm keeps its hands off too. The leftover is loud,
    // not lost: the manifest denies the png rung and names it, and the
    // next run's ladder degrades on the occupant.
    await withFakeFreeze('#!/bin/sh\nprintf torn > "$5"\nexit 9\n', () =>
      run(),
    );
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.evidence).toBe('ans-only');
    expect(manifest.pngPath).toBeNull();
    expect(readFileSync(join(dir, 'cap.png'), 'utf8')).toBe('torn');
    expect(manifest.degradedBecause).toContain('left in place');
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

  it('stays exit 0 when STDIO fails after the evidence is on disk', async () => {
    // The success tail's writes were the only contract writes with no stdio
    // protection, and the broken-pipe guard rethrows every non-EPIPE
    // 'error' — so a full disk on a file-backed stdout flipped a COMPLETED
    // capture to exit 1, .ans and manifest both written.
    //
    // The error is queued on the reap WARNING, which is written during the
    // synchronous stretch BEFORE the tail: it therefore dispatches inside
    // the drain that follows, which is exactly where the completion flag
    // has to be armed already. Arming it after the drain — as it was —
    // leaves the guard rethrowing at that moment, so this test measures the
    // arming POINT and not merely the guard's existence.
    const captureTuiTs = captureTuiSource();
    const binDir = join(dir, 'fakebin-stdio');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'tmux'),
      `#!/bin/sh\n[ "$1" = "-V" ] && { echo "tmux 3.9"; exit 0; }\nfor a in "$@"; do [ "$a" = "kill-server" ] && { echo "wedged" >&2; exit 1; }; done\ns=$(printf '%s\n' "$@" | grep -o "/[^']*qwen-capture-ready-[0-9a-f-]*" | head -1); [ -n "$s" ] && : > "$s"\necho ""\nexit 0\n`,
      { mode: 0o755 },
    );
    const patch = join(dir, 'stdio-enospc.cjs');
    writeFileSync(
      patch,
      [
        'const real = process.stderr.write.bind(process.stderr);',
        'let armed = false;',
        'process.stderr.write = function (chunk, ...rest) {',
        "  if (!armed && String(chunk).includes('WARNING')) {",
        '    armed = true;',
        '    process.nextTick(() =>',
        "      process.stderr.emit('error', Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })),",
        '    );',
        '    return true;',
        '  }',
        '  return real(chunk, ...rest);',
        '};',
      ].join('\n'),
    );
    const driver = join(dir, 'driver-stdio.mts');
    writeFileSync(
      driver,
      [
        `const mod = await import(${JSON.stringify(pathToFileURL(captureTuiTs).href)});`,
        `mod.probes.freeze = () => ({ status: 'absent' });`,
        `await mod.runCaptureTui({ command: 'printf hi', cwd: ${JSON.stringify(dir)}, cols: 80, rows: 24, settleMs: 0, until: undefined, keys: undefined, out: ${JSON.stringify(join(dir, 'stdio'))}, timeoutMs: 5_000 } as never);`,
      ].join('\n'),
    );
    const { spawn } = await import('node:child_process');
    const child = spawn(
      process.execPath,
      ['--require', patch, '--import', 'tsx', driver],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${binDir}:${process.env['PATH'] ?? ''}` },
      },
    );
    // Drained, not just piped: nobody read these, so a spewing regression
    // fills the ~64KB pipe buffer and blocks the child forever — the same
    // hang the killer below exists for, reached a different way.
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
    const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    const code = await new Promise<number | null>((resolve) =>
      child.once('exit', (c) => resolve(c)),
    );
    clearTimeout(killer);
    // A completed capture is a success, whatever happened to stdio after.
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'stdio.ans'))).toBe(true);
    expect(existsSync(join(dir, 'stdio.json'))).toBe(true);
  }, 60_000);

  it('does not inherit a previous run REFUSAL exit code', async () => {
    // runCaptureTui is exported and driven repeatedly in-process, so a
    // refusal that left exitCode 3 standing made the NEXT successful
    // capture report failure with its artifacts on disk (probe-observed).
    // The disposition is per run, like the completion flag beside it.
    probes.tmux = () => ({ status: 'ok', out: 'tmux 3.9' }) as const;
    await withStdio(() =>
      runCaptureTui({
        command: 'printf hi',
        cwd: undefined,
        cols: 0,
        rows: 24,
        settleMs: 0,
        until: undefined,
        keys: undefined,
        out: join(dir, 'inherit-refusal'),
        timeoutMs: 1000,
      } as never),
    );
    expect(process.exitCode).toBe(3);
    probes.tmux = realTmuxProbe;
    probes.freeze = () => ({ status: 'absent' }) as const;
    await withStdio(() => run({ settleMs: 0 }));
    expect(process.exitCode).toBeUndefined();
  });

  it('names the until marker as NEVER SEARCHED when --ready times out', async () => {
    // The manifest records `until` and settledBy 'timeout', which reads as
    // "searched and not found" — but the poll never ran. Measured with the
    // marker present in the pane for the whole run: a reader deciding the
    // marker never appears would decide from a search that never happened.
    probes.freeze = () => ({ status: 'absent' }) as const;
    await run({
      command: 'printf "PRESENT\n"; sleep 30',
      ready: 'NEVER-MATCHES-THIS',
      until: 'PRESENT',
      settleMs: 0,
      timeoutMs: 1200,
    });
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.degradedBecause).toContain('--ready never matched');
    expect(manifest.degradedBecause).toContain('never searched for');
  });

  it('refuses a DANGLING SYMLINK at a mandatory path — writes must not escape', async () => {
    // existsSync and statSync follow links, so a dangling one read as
    // "nothing here": the collision gate never fired and writeFileSync's
    // O_CREAT then created the pane text and the manifest at the links'
    // TARGETS, outside the --out base, while the run reported success and
    // the manifest named <out>.json (probe-verified end to end). Occupancy
    // is an lstat question — the link itself is the occupant.
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(join(elsewhere, 'ans-victim.txt'), join(dir, 'cap.ans'));
    const { stderr } = await withStdio(() => run({ settleMs: 0 }));
    expect(process.exitCode).toBe(3);
    expect(stderr).toContain('collides with a file this capture did not');
    // Nothing escaped the base, and the link is still the user's.
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(lstatSync(join(dir, 'cap.ans')).isSymbolicLink()).toBe(true);
  });

  it('REFUSES rather than rewrite a foreign file at a mandatory path', async () => {
    // The collision the clear phase's own comment names: `--out package` in
    // a Node project. package.json parses but carries no evidence rung, so
    // the clear spares it — and a fully SUCCESSFUL run then rewrote it as a
    // capture manifest at exit 0 with nothing recorded. Both files must
    // come back byte-for-byte.
    const pkg = '{"name":"my-pkg","version":"1.0.0"}';
    const notes = 'hand-written notes';
    writeFileSync(join(dir, 'cap.json'), pkg);
    writeFileSync(join(dir, 'cap.ans'), notes);
    const { stderr } = await withStdio(() => run({ settleMs: 0 }));
    expect(process.exitCode).toBe(3);
    expect(stderr).toContain('collides with a file this capture did not');
    expect(readFileSync(join(dir, 'cap.json'), 'utf8')).toBe(pkg);
    expect(readFileSync(join(dir, 'cap.ans'), 'utf8')).toBe(notes);
  });

  it('degrades rather than rewrite a foreign file at the PNG path', async () => {
    // The png is a rung, not a requirement: an occupied png path stops the
    // ladder at the text rung and says why, instead of failing a capture
    // that can still produce evidence — or replacing the file.
    const foreign = 'a foreign image';
    writeFileSync(join(dir, 'cap.png'), foreign);
    await withFakeFreeze('#!/bin/sh\nprintf x > "$5"\n', () => run());
    expect(process.exitCode).toBeUndefined();
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.evidence).toBe('ans-only');
    expect(manifest.pngPath).toBeNull();
    expect(manifest.degradedBecause).toContain('did not write');
    expect(readFileSync(join(dir, 'cap.png'), 'utf8')).toBe(foreign);
  });

  // Both of these were written against the post-render arms — a freeze
  // exiting 0 without writing (credit), and one exiting 9 (torn-png
  // cleanup) — but with an occupant at <out>.png the ladder stops BEFORE
  // freeze is spawned at all, so neither fixture ever ran. The outcomes
  // they assert are right and worth keeping; what they pin is that the
  // protection happens earlier than they claimed, which is stronger. The
  // marker makes that explicit instead of leaving a fixture that looks
  // load-bearing and is not.
  for (const [label, script] of [
    ['exits 0 without writing', 'exit 0'],
    ['exits 9 after a torn write', 'printf torn > "$5"; exit 9'],
  ] as const) {
    it(`never spawns freeze at all when <out>.png is occupied — ${label}`, async () => {
      writeFileSync(join(dir, 'cap.png'), 'the user file');
      const ran = join(dir, 'freeze-ran');
      await withFakeFreeze(`#!/bin/sh\n: > "${ran}"\n${script}\n`, () => run());
      expect(existsSync(ran)).toBe(false);
      const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
      expect(manifest.evidence).toBe('ans-only');
      expect(manifest.pngPath).toBeNull();
      expect(manifest.degradedBecause).toContain('did not write');
      // Neither credited nor deleted: the two harms those arms guard
      // against, prevented one step sooner.
      expect(readFileSync(join(dir, 'cap.png'), 'utf8')).toBe('the user file');
    });
  }

  it('never manifests a png rung on exit code alone — the file must exist', async () => {
    // A freeze that exits 0 without writing anything would otherwise ship
    // "evidence": "png" pointing at nothing.
    await withFakeFreeze('#!/bin/sh\nexit 0\n', () => run());
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.evidence).toBe('ans-only');
    expect(manifest.pngPath).toBeNull();
    expect(manifest.degradedBecause).toContain('wrote no image');
  });

  it('never manifests a png rung on a 0-BYTE image either — size is checked', async () => {
    // A freeze that exits 0 but leaves an empty/truncated png (ENOSPC
    // mid-write — the shape the .ans write guard's comment names) would
    // otherwise sail past an existence-only guard and publish zero pixels
    // as "evidence": "png" (probe-verified end-to-end).
    await withFakeFreeze('#!/bin/sh\n: > "$5"\nexit 0\n', () => run());
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.evidence).toBe('ans-only');
    expect(manifest.pngPath).toBeNull();
    // The empty shell stays for the same reason a torn png does: with an
    // empty pre-window stamp, presence alone cannot attribute it.
    expect(existsSync(join(dir, 'cap.png'))).toBe(true);
    expect(manifest.degradedBecause).toContain('left in place');
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
      expect(probes.freeze().status).toBe('ok');
    } finally {
      if (realPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = realPath;
    }
  });

  it('degrades to ans-only when freeze is WEDGED — and says wedged, not absent', async () => {
    // The hung branch's message had no pin: a collapse to "not installed"
    // sends an operator to reinstall a binary that exists but hangs.
    const realFreeze = probes.freeze;
    probes.freeze = () => ({ status: 'hung' }) as const;
    try {
      await run();
    } finally {
      probes.freeze = realFreeze;
    }
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.evidence).toBe('ans-only');
    expect(manifest.degradedBecause).toContain('wedged');
    expect(manifest.degradedBecause).not.toContain('not installed');
  });

  it('degrades to ans-only when freeze is unavailable, and says why', async () => {
    // Through the probe seam, so the freeze-less rung is pinned even on
    // hosts that have freeze installed.
    const realFreeze = probes.freeze;
    probes.freeze = () => ({ status: 'absent' }) as const;
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

  it('survives a C-c sent through --keys — the holder traps SIGINT', async () => {
    // Non-interactive shells stay in the pane's foreground process group,
    // so a C-c delivered by this feature's own --keys path reaches the
    // holder shell too; untrapped, it dies and takes pane → session →
    // server down before the capture (measured: exit 3, zero artifacts,
    // misattributed "no server running"). The holder's `trap : INT` is
    // what this pins — and a trapped (not ignored) signal resets to
    // default in the children, so ^C still lands in the pane.
    await runCaptureTui({
      command: 'cat',
      cwd: dir,
      cols: 80,
      rows: 24,
      settleMs: 800,
      until: undefined,
      keys: ['C-c'],
      out: join(dir, 'cc'),
      timeoutMs: 10_000,
    } as never);
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(join(dir, 'cc.ans'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dir, 'cc.json'), 'utf8'));
    expect(manifest.keysSent).toBe(true);
    // The ^C landed in the pane: delivered, not swallowed.
    expect(readFileSync(join(dir, 'cc.ans'), 'utf8')).toContain('^C');
  });

  it('survives a C-c AFTER a one-shot command exits — the hold is a loop', async () => {
    // The trap protects only while the command is in the foreground: once
    // a render-and-exit command is done, a --keys C-c landing in the hold
    // killed a single sleep and ended the script — pane, session, server
    // gone (measured 5/5 with the single-sleep hold). The loop re-enters
    // sleep and the pane survives; a single-sleep mutant dies here.
    await run({
      command: 'printf "CCLOOP\\n"; exit 0',
      until: undefined,
      settleMs: 800,
      keys: ['C-c'],
      out: join(dir, 'ccloop'),
    });
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(join(dir, 'ccloop.ans'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dir, 'ccloop.json'), 'utf8'));
    expect(manifest.keysSent).toBe(true);
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
    // hasFreeze only proves --help answers; a broken render degrades to
    // ans-only by contract, so the evidence field is shape-checked.
    expect(JSON.parse(line)).toEqual({
      captured: true,
      evidence: hasFreeze
        ? expect.stringMatching(/^(png|ans-only)$/)
        : 'ans-only',
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
    probes.freeze = () => ({ status: 'absent' }) as const;
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
    // What this pins is the SINGLE deadline, not that the gate ran: with
    // --ready matching and no keys, no observable here separates a gate
    // that polled from one that skipped (a keys-gated skip mutant passes —
    // the sibling test below pins the gate's own residue through the
    // overrun accounting instead). The degradation names the until miss and
    // timeoutMs was the active knob.
    expect(manifest.degradedBecause).toContain('--until never matched');
    expect(manifest.timeoutMs).toBe(2500);
    // Pristine ends near the single 2.5s deadline; the two-clock mutant
    // needs ready(~1.6s) + until(2.5s) ≈ 4.1s and lands past the bound.
    expect(performance.now() - started).toBeLessThan(3600);
  });

  it('accounts budget overruns in the READY loop too', async () => {
    // Deleting matchOverruns++ from the ready loop shipped green — only the
    // until loop's accounting was pinned.
    await run({
      // Node-built repetition — the `$(seq …)` fixture was GNU-only; see
      // the wrap-boundary sibling for the probe.
      command: `printf '%s\\n' "${'a'.repeat(79)}"; sleep 30`,
      ready: '(a+)+b',
      until: undefined,
      settleMs: 0,
      timeoutMs: 1500,
    });
    expect(process.exitCode).toBeUndefined();
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.degradedBecause).toContain('budget');
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

  it('refuses a --out naming an existing directory — artifacts land NEXT TO it', async () => {
    // resolve('.') and resolve('./') are the cwd itself — the same shape
    // the empty guard refuses — and any existing directory sails through
    // an empty-string-only guard; artifacts would land as <dir>.ans next
    // to it, silently clobbering whatever holds those names (measured:
    // out '.' overwrote a pre-seeded <cwd>.ans with the pane text).
    const adir = join(dir, 'adir');
    mkdirSync(adir);
    const { stderr } = await withStdio(() => run({ out: adir }));
    expect(process.exitCode).toBe(3);
    expect(stderr).toContain('must not name an existing directory');
    process.exitCode = undefined;
    await run({ out: '.' });
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

  // Skipped where production deliberately omits -N: on tmux 3.1-3.2.x its
  // -N FABRICATES trailing spaces (it pads to the grid allocation) with no
  // -T to undo it, so the ladder trims there by design and this assertion
  // would red on every run — Ubuntu 22.04 ships 3.2a, and the local tmux is
  // what decides.
  it.skipIf(tmuxPadsWithCaptureN(tmuxVersionProbe.stdout ?? '') === true)(
    'preserves trailing spaces in the physical frame (-N)',
    async () => {
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
    },
  );

  it('maps the yargs surface — hyphenated keys reach the right fields', async () => {
    // Every other test hand-builds the args object; this drives the real
    // handler mapping. A wrong key (e.g. argv['settleMs']) leaves the field
    // undefined, the duration guard refuses, and this test turns red — the
    // option-contract bug class test-plan.test.ts documents.
    await (captureTuiCommand.handler as (argv: unknown) => Promise<void>)({
      command: `bash -c 'sleep 0.3; printf "MAPPED\\n"; cat'`,
      cwd: dir,
      // NON-default geometry, deliberately: both handler call sites used to
      // pass 80x24 — byte-equal to the yargs defaults — so a handler
      // hardcoding DEFAULT_COLS/DEFAULT_ROWS shipped green while
      // `--cols 120` silently captured at 80 and the manifest recorded 80.
      cols: 120,
      rows: 30,
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
    expect(manifest.cols).toBe(120);
    expect(manifest.rows).toBe(30);
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
    // Symmetric omission pin: no marker was given, so the marker budget
    // must be absent (an always-spread mutant recorded timeoutMs:10000 in a
    // fixed-delay manifest).
    expect(manifest.timeoutMs).toBeUndefined();
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
    // type:'string' is load-bearing for keys: yargs coerces UNTYPED array
    // values to numbers (measured: `--keys 3 Enter` → [3, 'Enter']), and a
    // numeric token is a legitimate send-keys shape — untyped, it hits the
    // shape guard's misleading "--keys must be strings." refusal.
    expect(options['keys']?.['type']).toBe('string');
    expect(options['command']?.['type']).toBe('string');
    expect(options['out']?.['type']).toBe('string');
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
    expect(tmuxControl.timeoutMs).toBe(15_000);
    expect(probeBudget.timeoutMs).toBe(10_000);
    expect(holderInit.timeoutMs).toBe(10_000);
  });

  it.skipIf(!hasPgrep)(
    'reaps an ATTACHED child but not a DAEMONIZED one — the documented boundary',
    async () => {
      // The reap is kill-server, not a process-tree reaper, and the header,
      // the plan's kill comment and the agent brief now say so. This pins
      // the line they draw, in both directions — a claim about a limit is
      // worth no more than a claim about a guarantee if nothing measures
      // it. The attached arm is the guarantee: a child in the pane's
      // session dies with the server. The detached arm is the limit: it
      // setsids into its own session, its parent is init before the reap
      // even runs, and nothing portable reaches it.
      // The tag has to ride on the LONG-LIVED process itself. Two earlier
      // shapes did not: a bare `sleep 41` matched any concurrent run of
      // this suite on a shared host (and its pkill reached into them), and
      // `sh -c 'sleep N; : <tag>'` tagged only the WRAPPER — sh forks an
      // untagged sleep and waits, so pgrep found the wrapper, pkill killed
      // it, and the sleep survived reparented to init: an orphan per run,
      // from the test that exists to pin orphans. A per-run symlink to the
      // real sleep puts the tag in argv[0] of the process that actually
      // lives.
      const tag = (arm: string): string =>
        `capture-tui-orphan-${process.pid}-${arm}`;
      const sleeper = (arm: string): string => {
        const link = join(dir, tag(arm));
        symlinkSync('/bin/sleep', link);
        return link;
      };
      const arms: Array<[string, string, boolean]> = [
        // A child in the pane's session: dies with the server. The guarantee.
        [
          'attached',
          `${sleeper('attached')} 41 & printf 'MARK\\n'; sleep 20`,
          false,
        ],
        // setsid'd into its own session, parent already init before the reap
        // runs: nothing portable reaches it. The documented limit.
        [
          'detached',
          `node -e "require('child_process').spawn('${sleeper('detached')}',['42'],{detached:true,stdio:'ignore'}).unref()"; printf 'MARK\\n'; sleep 20`,
          true,
        ],
      ];
      for (const [arm, command, expectedAlive] of arms) {
        const alive = (): boolean =>
          (
            spawnSync('pgrep', ['-f', tag(arm)], {
              encoding: 'utf8',
            }).stdout ?? ''
          ).trim() !== '';
        try {
          await withStdio(() =>
            run({ command, until: 'MARK', timeoutMs: 20_000 }),
          );
          // The reap is asynchronous at the OS level: kill-server returns
          // before the pane's descendants have finished dying. BOTH arms
          // get the same window — the attached one leaves it early, the
          // detached one sits through all of it.
          for (let i = 0; i < 40 && alive(); i++) await sleep(50);
          expect(`${arm}:${alive()}`).toBe(`${arm}:${expectedAlive}`);
        } finally {
          spawnSync('pkill', ['-f', tag(arm)]);
        }
      }
    },
    90_000,
  );

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
      const captureTuiTs = captureTuiSource();
      expect(existsSync(captureTuiTs)).toBe(true);
      const { spawn } = await import('node:child_process');
      // The FULL registration set, behaviorally: a registration mutant
      // dropping SIGHUP/SIGQUIT shipped green while the membership pin
      // still saw all four members.
      for (const signal of REAP_SIGNALS) {
        const outBase = join(dir, `sig-${signal}`);
        const driver = join(dir, `driver-${signal}.mts`);
        writeFileSync(
          driver,
          [
            `const { runCaptureTui } = await import(${JSON.stringify(pathToFileURL(captureTuiTs).href)});`,
            `await runCaptureTui({ command: 'sleep 300', cwd: ${JSON.stringify(dir)}, cols: 80, rows: 24, settleMs: 0, until: 'NEVER-MATCHES', keys: undefined, out: ${JSON.stringify(outBase)}, timeoutMs: 60_000 } as never);`,
          ].join('\n'),
        );
        const child = spawn(process.execPath, ['--import', 'tsx', driver], {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const childPid = child.pid as number;
        // Attached BEFORE the discovery loop, not after the kill: if the
        // child dies on its own during discovery — precisely the crash
        // regression this test polices — the sole `exit` event fires
        // unobserved, the disposition promise never settles, and the test
        // fails as a bare 15s timeout naming neither exit code nor signal
        // (probe-verified 10/10 in the attach-after-kill shape: the
        // surviving server still satisfies the loop and child.kill()
        // returns false silently).
        const disposition = new Promise<[number | null, NodeJS.Signals | null]>(
          (resolve) => child.once('exit', (c, sig) => resolve([c, sig])),
        );
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
        // Kill on ANY exit from here, including a thrown assertion: the
        // regression this test polices is exactly "the child did not do
        // what it should", and leaving it inside a 60s capture orphaned a
        // node process (and its tmux server) on every such failure.
        // BELOW this test's own budget, and held across every wait that
        // follows: cleared before `await disposition`, the guard covered
        // none of the window it exists for. Against the dropped-re-raise
        // mutant this test polices, `child.kill(signal)` does not end the
        // child, the disposition never settles, and vitest fails the test —
        // with the guard already cleared, the child then ran out its
        // 60s capture with its private tmux server alive on every red run.
        // SIGTERM, not SIGKILL: the child's own handler is what reaps its
        // private server, and a SIGKILL'd child leaves it standing
        // (measured) — a guard meant to prevent an orphan would create one.
        // And the rescue is RECORDED: SIGTERM is also this loop's expected
        // cause of death, so a child the guard had to kill would otherwise
        // produce the expected disposition and pass green with nothing
        // saying the guard fired.
        let guardFired = false;
        const orphanGuard = setTimeout(() => {
          guardFired = true;
          child.kill('SIGTERM');
        }, 20_000);
        try {
          expect(seen).toBe(true);
          child.kill(signal);
          // Capture the disposition: the re-raise half of the contract — the
          // handler reaps FIRST and then re-raises, so the child must die OF
          // the signal (the conventional exit disposition). A dropped
          // re-raise reads normal completion to a harness killing a wedged
          // capture (probe-verified: the exact mutant passed the
          // exit-event-only version of this wait).
          const [code, exitSignal] = await disposition;
          expect(exitSignal).toBe(signal);
          expect(code).toBeNull();
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
          expect(guardFired).toBe(false);
          // The sentinel cleanup on the signal path runs in the CHILD, so
          // the child's pid is the only one that can prove it ran —
          // leakedSentinels() defaulted to this worker's pid, which no
          // child sentinel ever carries, so the sole cleanup for the
          // signal-death path (the finally never runs: the re-raise
          // terminates without unwinding) was pinned by nothing.
          expect(leakedSentinels(childPid)).toEqual([]);
        } catch (e) {
          // SIGTERM for the same reason as the guard above: the child's own
          // handler is the only thing that reaps its private server.
          child.kill('SIGTERM');
          throw e;
        } finally {
          clearTimeout(orphanGuard);
        }
      }
    },
    // Four sequential cold `node --import tsx` lifecycles, each starting a
    // real tmux server: measured at 18.4s under load, so the default 15s
    // fails this test against healthy production code on a busy runner.
    // Every other child-spawning test in this file already carries a budget.
    60_000,
  );

  it(// No pgrep needed: sentinel + child disposition only.
  'dies OF the signal even when it lands during the render window', async () => {
    // The tail after reap is synchronous (freeze render up to its belt);
    // a queued signal must drain to the handler before the listeners go
    // away — without the drain the process exited 0 with the success JSON
    // as if the harness's kill never landed.
    const captureTuiTs = captureTuiSource();
    const slowFreeze = join(dir, 'slow-freeze');
    // The sentinel line is what the wait below keys on — one write, so the
    // fixture a maintainer edits is the one the child runs.
    const renderStarted = join(dir, 'render-started');
    writeFileSync(
      slowFreeze,
      // `sleep` from PATH, and FAIL LOUD if it is not there: hardcoding
      // /bin/sleep collapsed the 4s render window to ~0ms on hosts that do
      // not have it (NixOS store paths, minimal rootfs) — sh has no set -e,
      // so the shim went on to write the png and the test silently stopped
      // testing the render window.
      `#!/bin/sh\n: > "${renderStarted}"\nsleep 4 || exit 97\nprintf x > "$5"\n`,
      { mode: 0o755 },
    );
    const driver = join(dir, 'driver-render.mts');
    writeFileSync(
      driver,
      [
        `const mod = await import(${JSON.stringify(pathToFileURL(captureTuiTs).href)});`,
        `mod.probes.freeze = () => ({ status: 'ok', out: '' });`,
        `mod.freezeRender.bin = ${JSON.stringify(slowFreeze)};`,
        `await mod.runCaptureTui({ command: 'printf "RSIG\\n"; sleep 30', cwd: ${JSON.stringify(dir)}, cols: 80, rows: 24, settleMs: 0, until: 'RSIG', keys: undefined, out: ${JSON.stringify(join(dir, 'rsig'))}, timeoutMs: 30_000 } as never);`,
      ].join('\n'),
    );
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['--import', 'tsx', driver], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Attached BEFORE the wait, like its mid-poll sibling: if the child
    // dies during the render window the sole exit event fires unobserved
    // and the await below never settles.
    const disposition = new Promise<{
      code: number | null;
      signal: string | null;
    }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    // ...and the child is killed on ANY exit from here, including a thrown
    // assertion. Without this, a sentinel that never appears (a cold tsx
    // start on a loaded runner, a fixture regression) threw before the
    // kill below and left the node process AND its private tmux server
    // alive together — measured through a 16s window. SIGTERM, never
    // SIGKILL: the child's own handler is what reaps the server, and a
    // SIGKILL'd child leaves it standing (measured).
    // Recorded, not just sent: SIGTERM is also the disposition this test
    // asserts, so a child the guard had to kill produces exactly the
    // expected death and would pass green with nothing saying so.
    let guardFired = false;
    const orphanGuard = setTimeout(() => {
      guardFired = true;
      child.kill('SIGTERM');
    }, 20_000);
    try {
      let waited = 0;
      while (!existsSync(renderStarted) && waited < 200) {
        await sleep(50);
        waited++;
      }
      expect(existsSync(renderStarted)).toBe(true);
      child.kill('SIGTERM');
      const { code, signal } = await disposition;
      // Death BY the signal — not a swallowed exit 0 with success JSON.
      expect(signal ?? `code:${code}`).toBe('SIGTERM');
      expect(guardFired).toBe(false);
      // Same as the mid-poll sibling: the child's own pid is what proves
      // the signal path cleaned up after itself.
      expect(leakedSentinels(child.pid as number)).toEqual([]);
    } catch (e) {
      child.kill('SIGTERM');
      throw e;
    } finally {
      clearTimeout(orphanGuard);
    }
  }, 60_000);

  it('renders through a stdin-IGNORING spawn — a pipe stdin breaks freeze', async () => {
    // The production spawn sets stdio ignore because freeze treats a
    // non-/dev/null stdin as "the input is stdin" (measured: EOF'd pipe →
    // "ERROR No input", exit 1). spawnSync's pipe stdin EOFs at spawn — it
    // never blocks — so this fake discriminates by SHAPE: fd 0 must be the
    // /dev/null character device, or it fails the way real freeze does.
    await withFakeFreeze(
      // The property is stdin being /dev/null SPECIFICALLY, not "some
      // character device": measured against freeze v0.2.2, a pty is a
      // character device and hangs it indefinitely, while a regular file
      // sends it into file mode — both would have satisfied a `-c` test
      // while breaking the render. Compare the device itself.
      '#!/bin/sh\nif [ ! -c /dev/stdin ] || [ -t 0 ]; then echo "ERROR No input" >&2; exit 1; fi\nprintf x > "$5"\nexit 0\n',
      () => run(),
    );
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.evidence).toBe('png');
  });
});
