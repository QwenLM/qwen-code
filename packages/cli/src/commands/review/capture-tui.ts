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
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
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
  ready: string | undefined;
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
/** The freeze render invocation, exported as a seam: the 30s belt against a
 * wedged freeze (measured hangs on this repo's own workflows) is otherwise
 * untestable — a test cannot wait out the real value to prove the belt
 * exists — and `bin` lets a test point the render at a fake binary by
 * absolute path (a PATH shim is skipped by execvp when non-executable).
 * Tests override and restore; production never does. */
export const freezeRender = { bin: 'freeze', timeoutMs: 30_000 };

export const probes = {
  tmux: () => available('tmux', '-V'),
  // `--help`, not `--version`: freeze ≤0.1.6 (the whole 2024 release line)
  // has no --version flag and would be misdiagnosed as absent; --help exits
  // 0 on both release lines (measured on v0.1.6 and v0.2.2).
  freeze: () => available('freeze', '--help'),
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

/** Async on purpose: the waits dominate the capture's wall time, and an
 * idle event loop is what lets the SIGINT/SIGTERM reap below actually run —
 * a fully synchronous capture would queue the signal until after the work
 * it was meant to interrupt. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** `re.test` with a time budget: a backtracking-prone --until pattern can
 * spin one test() call past any deadline (the deadline is only checked
 * BETWEEN calls). vm interrupts the match; a budget overrun counts as "no
 * match yet", so the poll keeps making deadline progress. */
function testWithBudget(re: RegExp, text: string): boolean {
  try {
    return runInNewContext('re.test(text)', { re, text }, {
      timeout: 500,
    }) as boolean;
  } catch {
    return false;
  }
}

export async function runCaptureTui(args: CaptureTuiArgs): Promise<void> {
  const refuse = (reason: string): void => {
    writeStderrLine(`capture-tui: refused — ${reason}`);
    writeStdoutLine(JSON.stringify({ captured: false }));
    process.exitCode = 3;
  };

  // Shape guard first: yargs parses a DUPLICATED string option into an array
  // (`--command A --command B` → ['A','B']) and its default --no-X negation
  // into a boolean (`--no-command` → false) — both sail through the `as`
  // casts and either throw uncaught TypeErrors past the refusal contract or
  // silently corrupt the capture (`--until A --until B` compiles /A,B/;
  // `--no-keys` types the literal word "false" into the pane).
  for (const [name, v] of [
    ['--command', args.command],
    ['--cwd', args.cwd],
    ['--until', args.until],
    ['--ready', args.ready],
    ['--out', args.out],
  ] as const) {
    if (v !== undefined && typeof v !== 'string') {
      refuse(`${name} must be given exactly once, as a string.`);
      return;
    }
  }
  if (args.keys !== undefined) {
    if (!Array.isArray(args.keys) || args.keys.some((k) => typeof k !== 'string')) {
      refuse('--keys must be strings.');
      return;
    }
  }
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
  if (args.command.trimEnd().endsWith('\\')) {
    // A trailing backslash is a line continuation: it would fold the pane
    // holder's own line into the command, silently changing what runs.
    refuse('--command must not end with a trailing backslash.');
    return;
  }
  if (args.out.trim() === '') {
    // resolve('') is the cwd: artifacts would land as <cwd>.ans/.png/.json
    // NEXT TO the working directory, silently clobbering whatever holds
    // those names (the brief's template with an empty variable hits this).
    refuse('--out must not be empty.');
    return;
  }
  if (args.cwd !== undefined) {
    // tmux new-session -c with a nonexistent directory exits 0 and silently
    // runs the pane in the launching process's cwd — evidence from the
    // wrong directory with nothing recording the swap. Every other caller
    // mistake refuses; so does this one.
    let isDir = false;
    try {
      isDir = statSync(resolve(args.cwd)).isDirectory();
    } catch {
      // fall through to the refusal below
    }
    if (!isDir) {
      refuse(`--cwd is not a directory: ${args.cwd}`);
      return;
    }
  }
  // yargs coerces a non-numeric `--settle-ms abc` to NaN, and a NaN
  // deadline makes the --until poll loop unexpirable (`now >= NaN` is
  // always false). Refuse, don't hang — and refuse the out-of-bounds
  // values too, so a day-long timeout cannot be requested by typo.
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
  // --ready: measured on this repo's own onboarding TUI, keys fired at start
  // straddle the UI's mount — a Down was consumed and the Enter behind it
  // lost — so key-driven captures of anything that takes a moment to render
  // are unreliable without a gate. The gate is a marker, like --until.
  let readyRe: RegExp | undefined;
  if (args.ready !== undefined && args.ready.trim() === '') {
    refuse('--ready must not be empty.');
    return;
  }
  if (args.ready !== undefined) {
    try {
      readyRe = new RegExp(args.ready);
    } catch (e) {
      refuse(
        `--ready is not a valid regex: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
  }
  let untilRe: RegExp | undefined;
  if (args.until !== undefined && args.until.trim() === '') {
    // An empty pattern matches ANY pane text, including a blank one: the
    // first poll would settle "until-match" before the TUI rendered
    // anything — a false settle claim from a tool whose contract is an
    // honest evidence ladder.
    refuse('--until must not be empty.');
    return;
  }
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
  try {
    // Probe the actual write target BEFORE any process starts: mkdirSync
    // with `recursive` does no permission check on a directory that already
    // exists, so an unwritable --out would otherwise run the full capture —
    // up to the 1h ceiling — and lose the pane text at the very last write.
    const fd = openSync(ansPath, 'w');
    closeSync(fd);
    rmSync(ansPath, { force: true });
  } catch (e) {
    refuse(
      `--out is not writable: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  const server = captureServerName(process.pid, randomBytes(4).toString('hex'));
  const session = 'cap';
  const resolvedCwd = args.cwd ? resolve(args.cwd) : process.cwd();
  const plan = tmuxPlan({
    server,
    session,
    cols: args.cols,
    rows: args.rows,
    command: args.command,
    cwd: resolvedCwd,
  });

  // The no-orphan guarantee cannot rest on `finally` alone: a SIGINT/SIGTERM
  // (an operator's Ctrl+C on an un-settling capture, a harness reaping a
  // stuck one) skips finally and would leave the server, its socket, and the
  // captured TUI alive. The handler reaps first and then re-raises so the
  // exit code stays the conventional one for the signal.
  let reaped = false;
  const reap = (): void => {
    if (reaped) return;
    reaped = true;
    // Unlink the socket ONLY when the server is known dead: kill can throw
    // with the server alive (the tmux CLIENT failing to spawn — EMFILE, a
    // wedged server outlasting the 15s timeout), and unlinking then makes
    // the live server unreachable forever — nothing addressable by -L can
    // ever kill it again, while it holds the pane holder for two hours.
    let serverDead = false;
    try {
      tmux(plan.kill);
      serverDead = true;
    } catch (e) {
      // A kill failing because the server already died is the goal state.
      serverDead = /no server running/i.test(
        String((e as { stderr?: unknown }).stderr ?? ''),
      );
    }
    if (!serverDead) return;
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
  };
  const onSignal = (sig: NodeJS.Signals): void => {
    reap();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.kill(process.pid, sig);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let ansText = '';
  let settledBy: CaptureManifest['settledBy'] = 'fixed-delay';
  let readyFailed = false;
  let keysSent: boolean | undefined;
  try {
    tmux(plan.start);
    // One deadline covers the ready gate AND the until poll: two separate
    // clocks would let a capture run to 2× --timeout-ms.
    const deadline = Date.now() + args.timeoutMs;
    if (readyRe) {
      readyFailed = true;
      for (;;) {
        const logical = tmux(plan.captureText);
        if (testWithBudget(readyRe, logical)) {
          readyFailed = false;
          break;
        }
        if (Date.now() >= deadline) break;
        await sleep(250);
      }
    }
    if (args.keys !== undefined && args.keys.length > 0) {
      if (readyFailed) {
        // The UI never reached the state the keys were meant for: typing
        // them anyway would drive an unknown screen. Withhold, and say so.
        keysSent = false;
      } else {
        for (const key of args.keys) {
          tmux(plan.sendKeys(key));
        }
        keysSent = true;
      }
    }
    if (readyFailed) {
      // The deadline is spent; a late frame is all there is.
      if (untilRe) settledBy = 'timeout';
      ansText = tmux(plan.capture);
    } else if (untilRe) {
      // Poll for the settle marker on the LOGICAL view (wraps joined,
      // escapes absent): on the physical frame, a marker spanning a wrap
      // boundary or an SGR attribute change can never match (measured:
      // both miss forever). On timeout, capture anyway and SAY SO — a late
      // frame is degraded evidence, not no evidence. The physical frame is
      // captured in the same poll iteration as its matching logical view,
      // so the `.ans` is the frame the match ruled on, give or take the
      // milliseconds between two capture-pane calls.
      settledBy = 'timeout';
      for (;;) {
        const logical = tmux(plan.captureText);
        if (testWithBudget(untilRe, logical)) {
          settledBy = 'until-match';
          ansText = tmux(plan.capture);
          break;
        }
        if (Date.now() >= deadline) {
          ansText = tmux(plan.capture);
          break;
        }
        await sleep(250);
      }
    } else {
      await sleep(args.settleMs);
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
    reap();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  try {
    writeFileSync(ansPath, ansText, 'utf8');
  } catch (e) {
    // The disk can fill (or the target turn hostile) during a long capture
    // window; the same principle as the mkdir guard — refusal contract, not
    // a stack trace.
    refuse(
      `cannot write capture output: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  // .ans FIRST, then render: freeze has hung mid-render on this repo's own
  // workflows, and the text evidence must already be on disk when it does.
  let png: string | null = null;
  // Collect every way this capture fell short of "settled png" — the field's
  // contract is that a manifest reader learns WHY the ladder stopped where it
  // did, and a late frame and a failed render can both be true at once.
  const degradations: string[] = [];
  if (readyFailed) {
    degradations.push(
      `--ready never matched within ${args.timeoutMs}ms — ${
        keysSent === false ? 'keys were NOT sent, ' : ''
      }late frame captured`,
    );
  } else if (settledBy === 'timeout') {
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
    const r = spawnSync(freezeRender.bin, freezePlan(ansPath, pngPath), {
      encoding: 'utf8',
      timeout: freezeRender.timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status === 0 && existsSync(pngPath)) {
      // Exit code alone is not evidence: a freeze that exits 0 without
      // writing the file would otherwise manifest a png rung pointing at
      // nothing — and a verifier would publish a path with no pixels.
      png = pngPath;
    } else {
      // The stderr tail rides along: a bare exit code is undiagnosable from a
      // manifest, and the whole point of recording degradation is that a
      // reader can tell WHY the ladder stopped. A spawn that never ran
      // (EMFILE, a binary vanishing between probe and render) has neither
      // status nor signal — its reason lives in r.error.
      const errTail = `${r.stderr ?? ''} ${r.stdout ?? ''}`
        .trim()
        .split('\n')
        .slice(-2)
        .join(' ');
      const why =
        r.status === 0
          ? 'exited 0 but wrote no image'
          : r.signal
            ? `signal ${r.signal}`
            : r.status !== null
              ? `exit ${String(r.status)}`
              : `spawn failed: ${r.error ? r.error.message : 'unknown error'}`;
      degradations.push(
        `freeze failed (${why}${errTail ? `: ${errTail}` : ''}) — .ans text captured, no image rendered`,
      );
    }
  }

  const degradedBecause = degradations.length
    ? degradations.join('; ')
    : undefined;
  const manifest: CaptureManifest = {
    command: args.command,
    cwd: resolvedCwd,
    cols: args.cols,
    rows: args.rows,
    ...(args.keys !== undefined ? { keys: args.keys } : {}),
    ...(keysSent !== undefined ? { keysSent } : {}),
    ...(args.ready !== undefined ? { ready: args.ready } : {}),
    ...(args.until !== undefined ? { until: args.until } : {}),
    ...(args.until === undefined ? { settleMs: args.settleMs } : {}),
    ...(args.until !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ansPath,
    pngPath: png,
    evidence: png ? 'png' : 'ans-only',
    ...(degradedBecause ? { degradedBecause } : {}),
    settledBy,
  };
  try {
    writeFileSync(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
  } catch (e) {
    refuse(
      `cannot write capture manifest: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

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
      .option('ready', {
        type: 'string',
        describe:
          'Send --keys only after the pane matches this regex — keys fired at start straddle a slow-mounting UI and get partially eaten (measured); on timeout the keys are withheld and the manifest says so',
      })
      .option('keys', {
        type: 'string',
        array: true,
        describe:
          'tmux send-keys tokens sent after start (or after --ready matches), one per token (e.g. --keys "/review" Enter)',
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
  handler: (argv) =>
    runCaptureTui({
      command: argv['command'] as string,
      cwd: argv['cwd'] as string | undefined,
      cols: argv['cols'] as number,
      rows: argv['rows'] as number,
      settleMs: argv['settle-ms'] as number,
      until: argv['until'] as string | undefined,
      ready: argv['ready'] as string | undefined,
      keys: argv['keys'] as string[] | undefined,
      out: argv['out'] as string,
      timeoutMs: argv['timeout-ms'] as number,
    }),
};
