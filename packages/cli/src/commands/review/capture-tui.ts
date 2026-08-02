/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review capture-tui`: run a command in a throwaway terminal and hand
// back what it actually rendered — the evidence producer for rendering claims.
//
// A verifier ruling on "the panel clips at 80 columns" without this command
// reads the layout code and imagines a terminal; measured on this repo, the
// imagining is where rendering verdicts go wrong. This command makes the
// terminal real and the evidence a file:
//
//   tmux (PRIVATE server, -L)  →  .ans (pane text with escapes, always)
//                              →  .png (freeze-rendered, when available)
//
// The safety property is isolation, and it is structural: every tmux call is
// scoped to a per-run private server socket, so the capture cannot see —
// let alone resize or kill — the user's own tmux sessions. The measured
// failure mode of desktop-automation verification was exactly "drives the
// user's own windows"; a private server makes that impossible rather than
// discouraged. `kill-server` at the end reaps everything the capture started.
//
// Degradation is explicit, not silent: the manifest names which evidence rung
// was reached (`png` / `ans-only` / `none`) and why, because a verifier must
// say which rung its verdict stands on — a PNG is publishable rendering
// evidence, an .ans proves bytes but not pixels, and prose is neither.

import type { CommandModule } from 'yargs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  captureServerName,
  freezePlan,
  tmuxPlan,
  validGeometry,
  type CaptureManifest,
} from './lib/tui-capture.js';

interface CaptureTuiArgs {
  command: string;
  cwd: string | undefined;
  cols: number;
  rows: number;
  settleMs: number;
  until: string | undefined;
  keys: string[] | undefined;
  out: string;
  timeoutMs: number;
}

/** Probe the binary itself (`tmux -V` / `freeze --version`), not `which`:
 * a host without `which` would otherwise misdiagnose an installed tmux as
 * missing, and the binary answering is the only fact that matters. */
function available(bin: string, versionFlag: string): boolean {
  const r = spawnSync(bin, [versionFlag], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return r.status === 0;
}

/** The availability probes, exported as a seam: the no-tmux refusal fires
 * exactly where `describe.skipIf(!hasTmux)` skips the real-tmux tests, so
 * without this seam that path is untestable in the one environment where it
 * matters. Tests override a probe and restore it; production never does. */
export const probes = {
  tmux: () => available('tmux', '-V'),
  freeze: () => available('freeze', '--version'),
};

function tmux(argv: string[]): string {
  return execFileSync('tmux', argv, {
    encoding: 'utf8',
    // A pane of text is small; a runaway TUI writing a scrollback is not our
    // problem — capture-pane returns the visible pane only.
    maxBuffer: 8 * 1024 * 1024,
    // Every tmux command here is a quick control call; a server wedged hard
    // enough to sit on one for 15s should turn into a refusal, not hang the
    // whole review agent behind it.
    timeout: 15_000,
  }) as string;
}

function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

export function runCaptureTui(args: CaptureTuiArgs): void {
  const refuse = (reason: string): void => {
    writeStderrLine(`capture-tui: refused — ${reason}`);
    writeStdoutLine(JSON.stringify({ captured: false }));
    process.exitCode = 3;
  };

  if (!probes.tmux()) {
    refuse(
      'tmux is not installed. Rendering claims stay argued from the code on ' +
        'this host; say so in the finding rather than describing an imagined ' +
        'terminal as evidence.',
    );
    return;
  }
  const geometry = validGeometry(args.cols, args.rows);
  if (!geometry.ok) {
    refuse(geometry.reason);
    return;
  }
  if (args.command.trim() === '') {
    refuse('--command must not be empty.');
    return;
  }
  // yargs coerces a non-numeric `--settle-ms abc` to NaN, and NaN is the
  // worst possible value here: Atomics.wait treats a NaN timeout as
  // INFINITY (a capture that never returns), and a NaN deadline makes the
  // --until poll loop unexpirable. Refuse, don't hang.
  for (const [name, v, max] of [
    ['--settle-ms', args.settleMs, 600_000],
    ['--timeout-ms', args.timeoutMs, 3_600_000],
  ] as const) {
    if (!Number.isFinite(v) || v < 0 || v > max) {
      refuse(`${name} must be a number in [0, ${max}], got ${String(v)}`);
      return;
    }
  }
  // Validate the regex BEFORE any process starts: an invalid pattern is a
  // caller mistake and gets the refusal contract, not a stack trace thrown
  // from inside a running capture.
  let untilRe: RegExp | undefined;
  if (args.until !== undefined) {
    try {
      untilRe = new RegExp(args.until);
    } catch (e) {
      refuse(
        `--until is not a valid regex: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
  }

  const outBase = resolve(args.out);
  try {
    mkdirSync(dirname(outBase), { recursive: true });
  } catch (e) {
    // The same principle as the regex above: an unwritable --out (EACCES,
    // EROFS, ENOSPC) is a caller/environment mistake and gets the refusal
    // contract, not a stack trace.
    refuse(
      `cannot create output directory: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  const ansPath = `${outBase}.ans`;
  const pngPath = `${outBase}.png`;
  const manifestPath = `${outBase}.json`;

  const server = captureServerName(process.pid, randomBytes(4).toString('hex'));
  const session = 'cap';
  const plan = tmuxPlan({
    server,
    session,
    cols: args.cols,
    rows: args.rows,
    command: args.command,
    cwd: args.cwd ? resolve(args.cwd) : process.cwd(),
  });

  let ansText = '';
  let settledBy: CaptureManifest['settledBy'] = 'fixed-delay';
  try {
    tmux(plan.start);
    for (const key of args.keys ?? []) {
      tmux(plan.sendKeys(key));
    }
    if (untilRe) {
      // Poll the pane for the settle marker; on timeout, capture anyway and
      // SAY SO — a late frame is degraded evidence, not no evidence. The
      // frame that MATCHED is the one written: a re-capture after the match
      // could be a later, different frame, and then the manifest's
      // `until-match` would describe evidence that no longer shows the match.
      const deadline = Date.now() + args.timeoutMs;
      settledBy = 'timeout';
      for (;;) {
        const text = tmux(plan.capture);
        if (untilRe.test(text)) {
          settledBy = 'until-match';
          ansText = text;
          break;
        }
        if (Date.now() >= deadline) {
          ansText = text;
          break;
        }
        sleepSync(250);
      }
    } else {
      sleepSync(args.settleMs);
      ansText = tmux(plan.capture);
    }
  } catch (e) {
    // tmux failing mid-run (ancient tmux without a flag we use, a command
    // tmux itself refuses, a server that died under us) is an environment
    // that could not produce evidence — the refusal contract, not a stack
    // trace. The finally below still reaps whatever did start.
    const err = e as Error & { stderr?: string };
    const detail =
      (err.stderr ?? '').trim().split('\n').slice(-1)[0] ||
      (err.message ?? String(e)).split('\n')[0];
    refuse(`tmux failed mid-capture: ${detail}`);
    return;
  } finally {
    // Always, even when start/capture threw: the private server holds every
    // process this capture launched, and an orphaned TUI outliving the
    // review is the mess this command exists to make impossible.
    try {
      tmux(plan.kill);
    } catch {
      // A kill failing because the server already died is the goal state.
    }
    // tmux does not always unlink the socket of a killed server; a review
    // that captures often would litter the socket dir with dead sockets.
    // tmux resolves that dir from TMUX_TMPDIR, falling back to /tmp — it
    // does NOT consult TMPDIR, so neither do we.
    try {
      const uid = process.getuid?.();
      if (uid !== undefined) {
        const base = process.env['TMUX_TMPDIR']?.trim() || '/tmp';
        rmSync(join(base, `tmux-${uid}`, server), { force: true });
      }
    } catch {
      // Litter is cosmetic; never let cleanup mask the capture's own result.
    }
  }

  writeFileSync(ansPath, ansText, 'utf8');

  // .ans FIRST, then render: freeze has hung mid-render on this repo's own
  // workflows, and the text evidence must already be on disk when it does.
  let png: string | null = null;
  // Collect every way this capture fell short of "settled png" — the field's
  // contract is that a manifest reader learns WHY the ladder stopped where it
  // did, and a late frame and a failed render can both be true at once.
  const degradations: string[] = [];
  if (settledBy === 'timeout') {
    degradations.push(
      `--until never matched within ${args.timeoutMs}ms — late frame captured`,
    );
  }
  if (ansText.trim() === '') {
    // A blank capture — zero bytes or nothing but whitespace — has no pixels
    // worth rendering: freeze fails empty input with a misleading bounds
    // error, and a blank image would be evidence-shaped noise anyway.
    degradations.push(
      'pane captured empty — nothing to render, no image produced',
    );
  } else if (!probes.freeze()) {
    degradations.push(
      'freeze is not installed — .ans text captured, no image rendered',
    );
  } else {
    // stdin MUST be /dev/null: freeze treats a pipe stdin — Node's spawnSync
    // default — as "the input is stdin" and ignores the positional file. A
    // pipe that EOFs promptly produces `ERROR No input` (exit 1); a pipe that
    // stays open hangs freeze indefinitely. Both modes were measured on this
    // machine in one evening — the historical "freeze hangs" incidents on
    // this repo's workflows are this exact shape. The timeout stays as the
    // second belt.
    const r = spawnSync('freeze', freezePlan(ansPath, pngPath), {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status === 0) {
      png = pngPath;
    } else {
      // The stderr tail rides along: a bare exit code is undiagnosable from a
      // manifest, and the whole point of recording degradation is that a
      // reader can tell WHY the ladder stopped.
      const errTail = `${r.stderr ?? ''} ${r.stdout ?? ''}`
        .trim()
        .split('\n')
        .slice(-2)
        .join(' ');
      degradations.push(
        `freeze failed (${
          r.signal ? `signal ${r.signal}` : `exit ${String(r.status)}`
        }${errTail ? `: ${errTail}` : ''}) — .ans text captured, no image rendered`,
      );
    }
  }

  const degradedBecause = degradations.length
    ? degradations.join('; ')
    : undefined;
  const manifest: CaptureManifest = {
    command: args.command,
    cols: args.cols,
    rows: args.rows,
    ansPath,
    pngPath: png,
    evidence: png ? 'png' : 'ans-only',
    ...(degradedBecause ? { degradedBecause } : {}),
    settledBy,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  writeStderrLine(
    `capture-tui: ${manifest.evidence} at ${args.cols}x${args.rows} ` +
      `(settled by ${settledBy})${degradedBecause ? ` — ${degradedBecause}` : ''}`,
  );
  writeStdoutLine(
    JSON.stringify({
      captured: true,
      evidence: manifest.evidence,
      manifest: manifestPath,
    }),
  );
}

export const captureTuiCommand: CommandModule = {
  command: 'capture-tui',
  describe:
    'Run a command in a throwaway PRIVATE tmux server and capture what it rendered — .ans always, .png when freeze is available — as evidence for rendering claims',
  builder: (yargs) =>
    yargs
      .option('command', {
        type: 'string',
        demandOption: true,
        describe: 'The command to run inside the capture terminal',
      })
      .option('cwd', {
        type: 'string',
        describe: 'Working directory for the command (default: current)',
      })
      .option('cols', {
        type: 'number',
        default: DEFAULT_COLS,
        describe: 'Terminal width — layout claims are claims about a width',
      })
      .option('rows', {
        type: 'number',
        default: DEFAULT_ROWS,
        describe: 'Terminal height',
      })
      .option('settle-ms', {
        type: 'number',
        default: 3000,
        describe: 'Fixed delay before capturing (ignored when --until is set)',
      })
      .option('until', {
        type: 'string',
        describe:
          'Capture as soon as the pane text matches this regex; on timeout, capture anyway and record that the marker never appeared',
      })
      .option('keys', {
        type: 'string',
        array: true,
        describe:
          'tmux send-keys tokens sent after start, one per token (e.g. --keys "/review" Enter)',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe:
          'Output basename: <out>.ans, <out>.png (when rendered) and <out>.json (the manifest) are written',
      })
      .option('timeout-ms', {
        type: 'number',
        default: 60_000,
        describe: 'Deadline for --until polling',
      }),
  handler: (argv) => {
    runCaptureTui({
      command: argv['command'] as string,
      cwd: argv['cwd'] as string | undefined,
      cols: argv['cols'] as number,
      rows: argv['rows'] as number,
      settleMs: argv['settle-ms'] as number,
      until: argv['until'] as string | undefined,
      keys: argv['keys'] as string[] | undefined,
      out: argv['out'] as string,
      timeoutMs: argv['timeout-ms'] as number,
    });
  },
};
