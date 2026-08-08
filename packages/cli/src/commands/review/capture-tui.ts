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
// was reached (`png` or `ans-only`) and why, because a verifier must say
// which rung its verdict stands on — a PNG is publishable rendering evidence,
// an .ans proves bytes but not pixels, and prose is neither. A REFUSED
// capture writes no manifest at all — the bottom rung (`none`) is reported by
// the refusal JSON on stdout instead, so a missing manifest reads as a
// refusal, not corruption.

import type { CommandModule } from 'yargs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createContext, runInContext, type Context } from 'node:vm';
import {
  writeStdoutLine,
  writeStderrLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  captureServerName,
  freezePlan,
  tmuxPlan,
  tmuxSupportsCaptureN,
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

/** Probe the binary itself (`tmux -V` / `freeze --help`), not `which`: a
 * host without `which` would otherwise misdiagnose an installed binary as
 * missing, and the binary answering is the only fact that matters. A clean
 * answer returns its trimmed stdout; anything else returns undefined. */
/** The availability-probe deadline, a seam like its two belt siblings: a
 * hanging `tmux -V`/`freeze --help` would otherwise block runCaptureTui
 * before the refusal contract or any signal handler exists — and without
 * the seam the belt itself is untestable. */
export const probeBudget = { timeoutMs: 10_000 };

/** The holder-init sentinel deadline, a seam like the other belts — a pane
 * that dies at startup must refuse within it, and without the seam neither
 * the floor nor the ceiling is provable. */
export const holderInit = { timeoutMs: 10_000 };

type ProbeResult =
  | { status: 'ok'; out: string }
  | { status: 'absent' }
  // Belt-killed: present but not answering. Reported distinctly — an
  // operator told "not installed" for a wedged binary goes to fix an
  // installation that exists (the freeze render path names its belt kill
  // for the same reason).
  | { status: 'hung' };

function probeOutput(bin: string, flag: string): ProbeResult {
  const r = spawnSync(bin, [flag], {
    encoding: 'utf8',
    timeout: probeBudget.timeoutMs,
    // SIGKILL, not the default SIGTERM: a TERM-immune child (trap '' TERM)
    // blocks the sync spawn past any belt — measured unkillable except by
    // external SIGKILL.
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status === 0) return { status: 'ok', out: (r.stdout ?? '').trim() };
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { status: 'hung' };
  }
  return { status: 'absent' };
}

/** The freeze render invocation, exported as a seam: the 30s belt against a
 * wedged freeze (measured hangs on this repo's own workflows) is otherwise
 * untestable — a test cannot wait out the real value to prove the belt
 * exists — and `bin` lets a test point the render at a fake binary by
 * absolute path (a PATH shim is skipped by execvp when non-executable).
 * Tests override and restore; production never does. */
export const freezeRender = { bin: 'freeze', timeoutMs: 30_000 };

/** The availability probes, exported as a seam: the no-tmux refusal fires
 * exactly where `describe.skipIf(!hasTmux)` skips the real-tmux tests, so
 * without this seam that path is untestable in the one environment where it
 * matters. Tests override a probe and restore it; production never does. */
export const probes = {
  // The VERSION LINE, not a boolean: capture-pane -N needs tmux 3.1, and a
  // host with an older tmux must be told so up front — the real cause named,
  // no server started — instead of dying mid-capture on the unknown flag.
  tmux: (): ProbeResult => probeOutput('tmux', '-V'),
  // `--help`, not `--version`: freeze ≤0.1.6 (the whole 2024 release line)
  // has no --version flag and would be misdiagnosed as absent; --help exits
  // 0 on both release lines (measured on v0.1.6 and v0.2.2).
  freeze: (): ProbeResult => probeOutput('freeze', '--help'),
};

/** Every signal whose default action would terminate the process past the
 * finally-based reap: a closed terminal window HUPs the foreground process
 * group (measured: exit 129 with server, socket and holder all surviving),
 * and the capture window legally runs up to an hour. Exported so the signal
 * tests iterate the REAL list. */
export const REAP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

/** The tmux control-call deadline, exported as a seam like its freezeRender
 * sibling: belt-less, a wedged server blocks the first execFileSync forever
 * — and in reap() the process could not even die on the re-raised signal.
 * Tests shorten it; production never does. */
export const tmuxControl = { timeoutMs: 15_000 };

function tmux(argv: string[]): string {
  return execFileSync('tmux', argv, {
    encoding: 'utf8',
    // A pane of text is small; a runaway TUI writing a scrollback is not our
    // problem — capture-pane returns the visible pane only.
    maxBuffer: 8 * 1024 * 1024,
    // Every tmux command here is a quick control call; a server wedged hard
    // enough to sit on one this long should turn into a refusal, not hang
    // the whole review agent behind it.
    timeout: tmuxControl.timeoutMs,
    killSignal: 'SIGKILL',
  }) as string;
}

/** Async on purpose: the waits dominate the capture's wall time, and an
 * idle event loop is what lets the SIGINT/SIGTERM reap below actually run —
 * a fully synchronous capture would queue the signal until after the work
 * it was meant to interrupt. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One marker match's time budget: a backtracking-prone --until/--ready
 * pattern can spin a single test() call past any deadline (the deadline is
 * only checked BETWEEN calls). vm interrupts the match; an overrun is
 * reported as such — it is "the match was cut off", NOT "no match".
 * Exported so the declaration test can pin the VALUE — the wall-clock test
 * alone tolerates anything up to ~7s, silently inflating every poll
 * iteration past the shared deadline. */
export const MATCH_BUDGET_MS = 500;

// ONE context for every match of the run: the interrupt property lives in
// the timeout option, which runInContext keeps — runInNewContext built a
// fresh V8 context per poll (~14k of them across a 1h capture).
// createContext wires the sandbox object in place, so writing re/text before
// each match feeds the context without re-creating it.
const matchSandbox: { re: RegExp; text: string } = { re: /(?!)/, text: '' };

const matchContext: Context = createContext(matchSandbox);

function testWithBudget(
  re: RegExp,
  text: string,
): 'match' | 'miss' | 'overrun' {
  matchSandbox.re = re;
  matchSandbox.text = text;
  try {
    return runInContext('re.test(text)', matchContext, {
      timeout: MATCH_BUDGET_MS,
    })
      ? 'match'
      : 'miss';
  } catch {
    return 'overrun';
  }
}

let brokenPipeGuarded = false;
/** The contract writes (refusal/success JSON, stderr summary, the reap
 * WARNING) must never flip the exit disposition: a gone reader raises an
 * ASYNC EPIPE 'error' event that crashes the process at exit 1 with a stack
 * trace where the machine-read contract promised exit 3 (or 0). Swallow
 * EPIPE only; anything else stays loud. */
function guardBrokenPipes(): void {
  if (brokenPipeGuarded) return;
  brokenPipeGuarded = true;
  const swallow = (err: NodeJS.ErrnoException): void => {
    if (err.code !== 'EPIPE') throw err;
  };
  process.stdout.on('error', swallow);
  process.stderr.on('error', swallow);
}

export async function runCaptureTui(args: CaptureTuiArgs): Promise<void> {
  guardBrokenPipes();
  const refuse = (reason: string): void => {
    // Exit code FIRST: it is the disposition a harness reads, and the
    // writes below can throw synchronously on a closed fd.
    process.exitCode = 3;
    try {
      writeStderrLine(`capture-tui: refused — ${reason}`);
      // The reason rides on stdout too: the consumer is an agent that must
      // tell an environment refusal from a caller mistake without scraping
      // stderr, and `evidence: 'none'` names the ladder's bottom rung.
      writeStdoutLine(
        JSON.stringify({ captured: false, evidence: 'none', reason }),
      );
    } catch {
      // A gone reader cannot un-refuse: the exit code already carries it.
    }
  };

  // --out's shape FIRST, then the stale-artifact clear, then every other
  // gate: any refusal that fires with a valid --out and stale artifacts
  // still in place hands a consumer the PREVIOUS run's manifest next to
  // this run's refusal JSON (measured: a duplicated --command flag against
  // a reused --out left all three prior artifacts, manifest still claiming
  // "evidence":"png"). Only an --out we cannot even name is allowed to
  // refuse without clearing — there is nowhere to clear.
  if (typeof args.out !== 'string') {
    refuse('--out must be given exactly once, as a string.');
    return;
  }
  if (args.out.trim() === '') {
    // resolve('') is the cwd: artifacts would land as <cwd>.ans/.png/.json
    // NEXT TO the working directory, silently clobbering whatever holds
    // those names (the brief's template with an empty variable hits this).
    refuse('--out must not be empty.');
    return;
  }
  const outBase = resolve(args.out);
  const ansPath = `${outBase}.ans`;
  const pngPath = `${outBase}.png`;
  const manifestPath = `${outBase}.json`;
  const holderReadyPath = `${outBase}.holder-ready`;
  // Files this run found ALREADY at the artifact paths after the clear
  // phase — see the snapshot below. Defaults to "pre-existing" so a refusal
  // taken before the snapshot can never authorize a delete.
  let preExisting = { ans: true, png: true, manifest: true };
  try {
    // Clears FIRST — before even mkdir and before the directory-shaped
    // --out refusal below: under fd exhaustion (EMFILE, measured on macOS)
    // mkdirSync itself can throw, and EVERY nameable refusal must leave no
    // stale capture evidence ("only an --out we cannot even name refuses
    // without clearing"). But clear ONLY what looks like a previous
    // capture: the artifact names are not reserved, and a colliding --out
    // must not force-delete an unrelated file on a run that later refuses
    // (measured: --out package deleted package.json at the --cols 0
    // refusal — the brief's template puts --out inside the plan dir). A
    // manifest that parses with an evidence rung is the capture's own
    // signature; .ans/.png/.json clear alongside it. The sentinel clears
    // unconditionally: this tool alone writes it, and a stale one from a
    // SIGKILL'd run would pass the ready gate before the new holder
    // installs its trap.
    const clearArtifact = (path: string): void => {
      // Plain unlink only — no descriptor needed, so it survives EMFILE —
      // and a throw is SWALLOWED rather than escalated to a recursive rm.
      // A capture writes files; a DIRECTORY at an artifact path was made by
      // someone else, and the recursive fallback destroyed it and its
      // contents on every re-run against the documented same-`--out` usage
      // (a stale shaped manifest is the normal state from the second run
      // on — no fd exhaustion needed). Skipping it keeps the clear going
      // for the other paths; a directory still standing where this run must
      // write turns into the write-failure refusal downstream, which is the
      // fail-closed outcome.
      try {
        rmSync(path, { force: true });
      } catch {
        // Not ours to delete (EISDIR), or unlinkable for a reason the
        // write probe below will name.
      }
    };
    let shaped = false;
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        evidence?: unknown;
      };
      shaped =
        m !== null &&
        typeof m === 'object' &&
        (m.evidence === 'png' || m.evidence === 'ans-only');
    } catch {
      // ANY read failure means the capture signature could not be verified —
      // including fd exhaustion (EMFILE/ENFILE), which is transient under
      // the concurrent captures the briefs encourage. Unverified is NOT
      // permission to delete: clearing here deleted unrelated user files at
      // the artifact names on a run that then refused (measured), against
      // this block's own invariant. Stale evidence left beside a refusal is
      // the lesser harm — the refusal names itself, a deleted file does not.
      shaped = false;
    }
    if (shaped) {
      clearArtifact(ansPath);
      clearArtifact(pngPath);
      clearArtifact(manifestPath);
    }
    // AFTER the clears, never before: this unlink is the one that may throw
    // (a DIRECTORY at the sentinel path gives EISDIR, which `force` does not
    // suppress) and its throw refuses. Run first, it stranded the previous
    // run's artifacts beside the refusal (measured) — the exact wrong-
    // evidence outcome the clear-first contract exists to prevent. The
    // sentinel itself clears UNCONDITIONALLY and as a PLAIN file: this tool
    // alone writes it, a stale one from a SIGKILL'd run would pass the ready
    // gate before the new holder installs its trap, and a directory there is
    // a user's — recursive removal would destroy it on every run (measured:
    // a seeded content-bearing directory deleted even by successful runs).
    rmSync(holderReadyPath, { force: true });
    // What still sits at an artifact path now is something this run did not
    // write and did not clear (an unverifiable manifest, an unrelated file,
    // a directory). The failure-cleanup sites below consult this snapshot:
    // they may remove only what this run itself put there. Without it a
    // successful run deleted a user's untouched .png whose render never
    // started, and a refusing run deleted a .ans it never wrote (both
    // measured).
    preExisting = {
      ans: existsSync(ansPath),
      png: existsSync(pngPath),
      manifest: existsSync(manifestPath),
    };
    mkdirSync(dirname(outBase), { recursive: true });
    // Probe the actual write target BEFORE any process starts: mkdirSync
    // with `recursive` does no permission check on a directory that already
    // exists, so an unwritable --out would otherwise run the full capture —
    // up to the 1h ceiling — and lose the pane text at the very last write.
    // The probe uses a UNIQUE sibling, never the .ans itself: truncating the
    // real one would delete the previous run's text while its manifest/png
    // survive to misdescribe it.
    const probePath = `${outBase}.write-probe-${randomBytes(4).toString('hex')}`;
    const fd = openSync(probePath, 'w');
    closeSync(fd);
    rmSync(probePath, { force: true });
  } catch (e) {
    refuse(
      `--out is not writable: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  // resolve('.') and resolve('./') are the cwd itself — the same shape the
  // empty guard above refuses — and any existing directory sails through:
  // artifacts would land as <dir>.ans/.png/.json NEXT TO the directory,
  // silently clobbering whatever holds those names. AFTER the clears, like
  // every other nameable refusal.
  let outIsDirectory = false;
  try {
    outIsDirectory = statSync(outBase).isDirectory();
  } catch {
    // A nonexistent out base is the normal shape.
  }
  if (outIsDirectory) {
    refuse(`--out must not name an existing directory: ${outBase}`);
    return;
  }
  // Remaining shape guards: yargs parses a DUPLICATED string option into an
  // array (`--command A --command B` → ['A','B']) and its default --no-X
  // negation into a boolean (`--no-command` → false) — both sail through
  // the `as` casts and either throw uncaught TypeErrors past the refusal
  // contract or silently corrupt the capture (`--until A --until B`
  // compiles /A,B/; `--no-keys` types the literal word "false" into the
  // pane). --command also refuses undefined: demandOption covers the CLI
  // path, but runCaptureTui is exported.
  if (typeof args.command !== 'string') {
    refuse('--command must be given exactly once, as a string.');
    return;
  }
  for (const [name, v] of [
    ['--cwd', args.cwd],
    ['--until', args.until],
    ['--ready', args.ready],
  ] as const) {
    if (v !== undefined && typeof v !== 'string') {
      refuse(`${name} must be given exactly once, as a string.`);
      return;
    }
  }
  if (args.keys !== undefined) {
    if (
      !Array.isArray(args.keys) ||
      args.keys.some((k) => typeof k !== 'string')
    ) {
      refuse('--keys must be strings.');
      return;
    }
  }
  const tmuxProbe = probes.tmux();
  if (tmuxProbe.status === 'hung') {
    refuse(
      `tmux did not answer -V within ${probeBudget.timeoutMs}ms — present ` +
        'but wedged, not absent. Fix or restart the tmux binary; rendering ' +
        'claims stay argued from the code until it answers.',
    );
    return;
  }
  if (tmuxProbe.status === 'absent') {
    refuse(
      'tmux is not installed. Rendering claims stay argued from the code on ' +
        'this host; say so in the finding rather than describing an imagined ' +
        'terminal as evidence.',
    );
    return;
  }
  const tmuxVersion = tmuxProbe.out;
  if (tmuxSupportsCaptureN(tmuxVersion) === false) {
    refuse(
      `${tmuxVersion} is too old: capture-pane -N needs tmux 3.1 or newer.`,
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
  // No trailing-backslash gate: the two-shell holder single-quotes the
  // command at every layer (esc balances every quote), so no shell ever
  // parses the command text adjacent to the hold line — probe-verified with
  // four odd-run shapes on the production plan, all executed correctly with
  // the holder alive. The old gate protected the earlier single-shell
  // holder and over-refused valid commands.
  if (args.cwd !== undefined) {
    // tmux new-session -c with an unusable directory exits 0 and silently
    // runs the pane in the launching process's cwd — evidence from the
    // wrong directory with nothing recording the swap. stat alone is not
    // enough: a directory without +x stats fine but cannot be entered
    // (measured: mode-644 --cwd passed the gate and the manifest lied).
    let usable = false;
    try {
      const abs = resolve(args.cwd);
      usable = statSync(abs).isDirectory();
      if (usable) accessSync(abs, fsConstants.X_OK);
    } catch {
      usable = false;
    }
    if (!usable) {
      refuse(`--cwd is not an enterable directory: ${args.cwd}`);
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
  // A marker that matches a BLANK pane settles before the TUI rendered
  // anything — a false settle claim (or keys fired into a still-mounting UI,
  // the exact failure --ready exists to prevent). Empty/whitespace patterns
  // are the obvious case; `.?`, `x*`, `^`, `\s` and `\n` are the sneaky
  // ones: the blank pane's logical capture is rows of newlines, not the
  // empty string, so both oracles are probed (through the match budget — a
  // backtracking pattern must not hang the gate itself).
  const compileMarker = (
    name: '--ready' | '--until',
    pattern: string,
  ): RegExp | { error: string } => {
    if (pattern.trim() === '') return { error: `${name} must not be empty.` };
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return {
        error: `${name} is not a valid regex: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const blankPane = '\n'.repeat(args.rows);
    if (
      testWithBudget(re, '') === 'match' ||
      testWithBudget(re, blankPane) === 'match'
    ) {
      return {
        error:
          `${name} ${JSON.stringify(pattern)} matches a blank pane — it ` +
          `would settle before the UI rendered anything; pick a marker the ` +
          `claim actually draws`,
      };
    }
    return re;
  };
  let readyRe: RegExp | undefined;
  if (args.ready !== undefined) {
    const r = compileMarker('--ready', args.ready);
    if ('error' in r) {
      refuse(r.error);
      return;
    }
    readyRe = r;
  }
  let untilRe: RegExp | undefined;
  if (args.until !== undefined) {
    const r = compileMarker('--until', args.until);
    if ('error' in r) {
      refuse(r.error);
      return;
    }
    untilRe = r;
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
    readyFile: holderReadyPath,
  });

  // The no-orphan guarantee cannot rest on `finally` alone: a SIGINT/SIGTERM
  // (an operator's Ctrl+C on an un-settling capture, a harness reaping a
  // stuck one) skips finally and would leave the server, its socket, and the
  // captured TUI alive. The handler reaps first and then re-raises so the
  // exit code stays the conventional one for the signal — removing only
  // itself before the re-raise, so any OTHER handler the host process
  // installed sees the signal a second time; accepted for a leaf
  // subcommand, which this is.
  let serverStarted = false;
  let reaped = false;
  const reap = (): void => {
    // serverStarted is set BEFORE the start call: the call forks the
    // server before it returns, so a start that threw or was belt-cut can
    // still have a live server behind it — skipping the reap on that path
    // orphaned server, session and holder (measured on loaded runners).
    // kill-server against a server that never came up answers "no server
    // running" — the goal state below — so the attempt stays warning-free.
    if (reaped || !serverStarted) return;
    reaped = true;
    // Unlink the socket ONLY when the server is known dead: kill can throw
    // with the server alive (the tmux CLIENT failing to spawn — EMFILE, a
    // wedged server outlasting the 15s timeout), and unlinking then makes
    // the live server unreachable forever — nothing addressable by -L can
    // ever kill it again, while it holds the pane holder (the bounded
    // hold loop runs up to three hours).
    // One retry before giving up: a transient client-spawn failure is the
    // named shape, and a second attempt reaps it (measured).
    let serverDead = false;
    for (let attempt = 0; attempt < 2 && !serverDead; attempt++) {
      try {
        tmux(plan.kill);
        serverDead = true;
      } catch (e) {
        // A kill failing because the server already died is the goal state.
        serverDead = /no server running/i.test(
          String((e as { stderr?: unknown }).stderr ?? ''),
        );
      }
    }
    if (!serverDead) {
      // A presumed-alive private server is never a silent outcome: the
      // holder keeps it up for up to three hours, and the briefs encourage many
      // captures per review — orphans would accumulate invisibly.
      // SAFE, like refuse()'s writes: process.stderr.write throws
      // synchronously on a closed fd, and reap() runs BOTH from the finally
      // (where a throw turns the exit-3 refusal into an exit-1 stack trace
      // and skips the sentinel cleanup below it) and from onSignal (where it
      // becomes an uncaughtException — exit 1 instead of 128+sig, the
      // re-raise never reached, and this very warning lost).
      writeStderrLineSafe(
        `capture-tui: WARNING — kill-server failed twice; the private tmux ` +
          `server ${server} may still be running (tmux -L ${server} kill-server to reap it by hand).`,
      );
      return;
    }
    // tmux does not always unlink the socket of a killed server; a review
    // that captures often would litter the socket dir with dead sockets.
    // tmux resolves that dir from TMUX_TMPDIR, falling back to /tmp — it
    // does NOT consult TMPDIR, so neither do we. BOTH candidate bases,
    // like the orphan sweep: tmux takes the first USABLE base, so a stale
    // TMUX_TMPDIR pointing at an unusable path puts the socket under /tmp
    // while a single-base unlink misses it.
    try {
      const uid = process.getuid?.();
      if (uid !== undefined) {
        // Untrimmed, matching tmux (a padded value is used verbatim).
        const envBase = process.env['TMUX_TMPDIR'];
        for (const base of new Set([envBase || '/tmp', '/tmp'])) {
          rmSync(join(base, `tmux-${uid}`, server), { force: true });
        }
      }
    } catch {
      // Litter is cosmetic; never let cleanup mask the capture's own result.
    }
  };
  // (REAP_SIGNALS is module-level and exported so the signal tests iterate
  // the REAL list — a dropped entry must fail a test, not ship silently.)
  const releaseSignals = (): void => {
    for (const s of REAP_SIGNALS) process.removeListener(s, onSignal);
  };
  // The success tail after the reap is synchronous (freeze render up to its
  // belt, two writes): a signal landing there is QUEUED in libuv's self-pipe,
  // and removing the listeners before that pipe is read swallows it — the
  // process then exits 0 as if nothing happened (measured on the bundled
  // runtime: SIGTERM during a fake render → exit 0, handler never ran).
  // TWO turns, and neither may be a 0ms timer. libuv delivers signals by
  // writing to a pipe the POLL phase reads; the JS handler runs from there.
  // A timer resolves in the timers phase, which precedes poll — it can
  // release with the byte unread. setImmediate resolves in the check phase,
  // which follows poll WITHIN THE SAME ITERATION: scheduled from a
  // poll-phase continuation (where this tail resumes after the render's
  // blocking spawnSync) its poll has ALREADY run, so one turn releases with
  // the byte still queued and the signal is dropped when uv_signal_stop
  // takes the watcher away. A second turn cannot land before the next
  // iteration's poll, so a full poll phase — the one that dispatches the
  // handler, which reaps and re-raises — always runs first. Measured on
  // Linux/Node 22 through the real command: one turn swallowed the SIGTERM
  // every time (exit 0, success JSON, handler never entered, kernel showing
  // the signal delivered and no longer pending); two turns died 143.
  const drainSignalsThenRelease = async (): Promise<void> => {
    for (let turn = 0; turn < 2; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    releaseSignals();
  };
  function onSignal(sig: NodeJS.Signals): void {
    reap();
    releaseSignals();
    process.kill(process.pid, sig);
  }
  for (const s of REAP_SIGNALS) process.on(s, onSignal);

  let ansText = '';
  let settledBy: CaptureManifest['settledBy'] = 'fixed-delay';
  let readyFailed = false;
  let keysSent: boolean | undefined;
  let matchOverruns = 0;
  let captureFailed = false;
  try {
    // BEFORE the call: plan.start forks the server in the same client
    // invocation that creates the session, so a start cut by the control
    // belt throws with the server ALREADY UP — exactly the window an
    // after-the-call flag left unreaped (measured orphan shape on loaded
    // runners). kill-server against a server that never came up answers
    // the goal state, so the early flag adds no false warnings.
    serverStarted = true;
    tmux(plan.start);
    // Before ANY key can be sent, wait for the holder's ready sentinel: the
    // pty's INTR fires the instant tmux writes 0x03 — a C-c racing the
    // holder's own `trap : INT` line killed pane, session and server
    // (measured; no in-script ordering can win, so the wait sits out here).
    {
      const holderDeadline = Date.now() + holderInit.timeoutMs;
      while (!existsSync(holderReadyPath)) {
        if (Date.now() >= holderDeadline) {
          throw new Error(
            'the pane never initialized — its holder wrote no ready marker',
          );
        }
        await sleep(25);
      }
    }
    // One deadline covers the ready gate AND the until poll: two separate
    // clocks would let a capture run to 2× --timeout-ms.
    const deadline = Date.now() + args.timeoutMs;
    if (readyRe) {
      readyFailed = true;
      for (;;) {
        const logical = tmux(plan.captureText);
        const m = testWithBudget(readyRe, logical);
        if (m === 'match') {
          readyFailed = false;
          break;
        }
        if (m === 'overrun') matchOverruns++;
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
      // The deadline is spent; a late frame is all there is. This is a
      // timeout settle even without --until — the run waited out
      // --timeout-ms, and calling it 'fixed-delay' would misdescribe it.
      settledBy = 'timeout';
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
        const m = testWithBudget(untilRe, logical);
        if (m === 'match') {
          settledBy = 'until-match';
          ansText = tmux(plan.capture);
          break;
        }
        if (m === 'overrun') matchOverruns++;
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
    captureFailed = true;
    refuse(`tmux failed mid-capture: ${detail}`);
    return;
  } finally {
    // Always, even when the capture threw mid-run: the private server holds
    // every process this capture launched, and an orphaned TUI outliving the
    // review is the mess this command exists to make impossible. A start
    // that threw has no server to reap, and reap() stays silent about it.
    // The reap runs FIRST — releasing the listeners before it left a
    // measured 25ms-to-death window with no listener. Honest limit, also
    // measured: Node cannot dispatch a JS handler while reap()'s synchronous
    // execFileSync blocks (up to 2×15s against a wedged server), so a signal
    // landing in that window only dispatches once the block ends — a kill
    // there reads normal completion, and the no-orphan guarantee is the
    // reap's, not the handler's. The listeners cover the await windows,
    // where dispatch works. On the success path they stay installed through
    // the freeze render below, which can block up to its belt.
    reap();
    // The sentinel is plumbing, not evidence — removed on EVERY exit path
    // (a mid-capture refusal after the holder wrote it used to leave it
    // stranded next to where evidence should be, measured).
    try {
      rmSync(holderReadyPath, { force: true });
    } catch {
      // Litter is cosmetic.
    }
    // Same drain as the success tail: a signal queued while reap() blocked
    // in execFileSync must dispatch to the handler (re-raise) before the
    // listeners go away — bare release read as "it refused on its own"
    // where the harness's kill actually landed.
    if (captureFailed) await drainSignalsThenRelease();
  }

  try {
    writeFileSync(ansPath, ansText, 'utf8');
  } catch (e) {
    // The disk can fill (or the target turn hostile) during a long capture
    // window; the same principle as the mkdir guard — refusal contract, not
    // a stack trace. "THIS run's artifacts or nothing": a partial or 0-byte
    // .ans from an interrupted write (measured with a real ENOSPC) must not
    // persist undescribed.
    try {
      // Plain, never recursive: this run wrote a FILE (or nothing); a
      // directory at the path is not ours to delete. And only when nothing
      // was there after the clear: a write that failed (EISDIR, EACCES,
      // EROFS) may not have touched the file at all, so a .ans the
      // signature check deliberately protected must survive the refusal.
      if (!preExisting.ans) rmSync(ansPath, { force: true });
    } catch {
      // The refusal reason below is the primary signal either way.
    }
    await drainSignalsThenRelease();
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
  // Probed ONCE and reused: each probe is a fresh 10s-belted spawn, and a
  // wedged freeze paid the belt twice — worse, a stateful binary could
  // answer differently between condition and message.
  let freezeProbe: ReturnType<typeof probes.freeze>;
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
  if (matchOverruns > 0) {
    // A budget cutoff is not the same as an absent marker: the match may
    // have been interrupted mid-backtrack, and the field's contract is that
    // a reader learns WHY the settle landed where it did.
    degradations.push(
      `marker matching exceeded its ${MATCH_BUDGET_MS}ms budget ${matchOverruns} time(s) — the marker may be present, its match cut off`,
    );
  }
  if (ansText.trim() === '') {
    // A blank capture — zero bytes or nothing but whitespace — has no pixels
    // worth rendering: freeze fails empty input with a misleading bounds
    // error, and a blank image would be evidence-shaped noise anyway.
    degradations.push(
      'pane captured empty — nothing to render, no image produced',
    );
  } else if ((freezeProbe = probes.freeze()).status !== 'ok') {
    degradations.push(
      freezeProbe.status === 'hung'
        ? `freeze did not answer --help within ${probeBudget.timeoutMs}ms — present but wedged; .ans text captured, no image rendered`
        : 'freeze is not installed — .ans text captured, no image rendered',
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
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status === 0 && existsSync(pngPath) && statSync(pngPath).size > 0) {
      // Exit code alone is not evidence: a freeze that exits 0 without
      // writing the file — or leaving a 0-byte/truncated one (ENOSPC
      // mid-write, the shape the .ans write guard's comment names) — would
      // otherwise manifest a png rung with no pixels, and a verifier would
      // publish it.
      png = pngPath;
    } else {
      // The stderr tail rides along: a bare exit code is undiagnosable from
      // a manifest, and the whole point of recording degradation is that a
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
            ? // A belt kill carries BOTH signal and error (ETIMEDOUT); name
              // the belt, or it reads as an unexplained external kill.
              `signal ${r.signal}${
                r.error
                  ? ` after the ${freezeRender.timeoutMs}ms render belt`
                  : ''
              }`
            : r.status !== null
              ? `exit ${String(r.status)}`
              : `spawn failed: ${r.error ? r.error.message : 'unknown error'}`;
      degradations.push(
        `freeze failed (${why}${errTail ? `: ${errTail}` : ''}) — .ans text captured, no image rendered`,
      );
      // A failed render can leave a partial/0-byte png at the very path the
      // manifest is about to deny — remove it (measured: a fake freeze that
      // wrote bytes then exited 9 left a torn png behind). Only when the
      // clear phase left nothing there: freeze can fail without its spawn
      // ever opening the output (EMFILE, a belt kill), and this SUCCEEDING
      // run then silently deleted a user's untouched png and reported
      // ans-only (measured).
      try {
        if (!preExisting.png) rmSync(pngPath, { force: true });
      } catch {
        // The degradation entry above is the primary signal.
      }
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
    // The ACTIVE durations: settleMs governed the run only when a fixed
    // delay actually happened; timeoutMs governed it when either marker
    // (--until OR --ready) was in play — a --ready-only run spends the
    // timeout budget too, and recording settleMs alone would misdescribe it.
    ...(args.until === undefined && !readyFailed
      ? { settleMs: args.settleMs }
      : {}),
    ...(args.until !== undefined || args.ready !== undefined
      ? { timeoutMs: args.timeoutMs }
      : {}),
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
    // "THIS run's artifacts or nothing": a refusal must not leave an .ans
    // (and possibly a png) with no manifest to describe them — best-effort
    // remove what this run already wrote before refusing.
    try {
      // Plain, never recursive — same rationale as the .ans catch above —
      // and each path only if this run put it there. Reaching here, the
      // .ans write SUCCEEDED, so a protected .ans has already been
      // overwritten by this run and is ours to remove; the png is ours only
      // when this run's render produced one, and the manifest only when the
      // clear left the path empty (a failed write can leave the previous
      // file untouched).
      rmSync(ansPath, { force: true });
      if (png !== null) rmSync(pngPath, { force: true });
      // The failed write itself can leave a PARTIAL manifest at the path —
      // worse than none: it parses or half-parses as evidence description.
      if (!preExisting.manifest) rmSync(manifestPath, { force: true });
    } catch {
      // The refusal reason below is the primary signal either way.
    }
    await drainSignalsThenRelease();
    refuse(
      `cannot write capture manifest: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  await drainSignalsThenRelease();

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
          'tmux send-keys tokens sent after start (or after --ready matches), one per token (e.g. --keys "/review" Enter); a token starting with "-" must use the --keys=<token> form or yargs parses it as an unknown flag',
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
        describe:
          'One shared deadline for the --ready gate and --until polling — a ready+keys capture without --until is still bounded by this',
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
