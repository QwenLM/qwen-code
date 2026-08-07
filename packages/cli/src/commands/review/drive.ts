/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review drive`: start something, wait until it is actually up, drive it,
// and capture what it did — as facts, not as a guess about how long to sleep.
//
// The maintainer verification this borrows from is the highest-yield review
// technique in this repo's history: build the PR, run the real product, watch
// what it does. Measured across 260 of those sessions, the mechanical half is
// the same every time and it is done by hand every time — and two of its three
// steps are done by GUESSING:
//
//   - **81% waited with `sleep N`**, and only 36% polled for a readiness
//     signal. A `sleep 2` that lands before the daemon binds its port makes
//     `capture-pane` return an empty screen, and an empty screen reads as "the
//     feature does not work". That is a false negative produced by the harness,
//     and it is silent — which is the one failure mode this pipeline treats as
//     worse than a missed finding.
//   - **74% captured one screenful** with no way to know whether the command
//     had finished. A capture taken mid-write is a truncated observation
//     presented as a complete one.
//   - **87% cleaned up by hand**, with `pkill -f <a name they made up>` plus a
//     `kill-server`. What the previous round leaked, the next round inherits.
//
// So this command owns exactly those three: **ready or not** (polled, with the
// wait reported), **finished or not** (a sentinel the driven script must reach,
// with its exit code), and **cleaned up regardless** (a named server this
// command owns end to end). What to drive and what the output means stay with
// the caller — the same split `build-test` and `test-delta` already draw.
//
// Nothing here interprets the captured text. A run that never became ready, or
// never reached its sentinel, reports what it observed AND that the observation
// is partial; it does not hand back a screenful and let the reader assume it is
// the whole story.

import type { CommandModule } from 'yargs';
import { bundleStalenessNotices } from './lib/stale-bundle.js';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeStdoutLine,
  writeStderrLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';

/** Why a drive stopped. Every value is a fact about the run, not a verdict. */
export type DriveOutcome =
  /** The sentinel was reached; `exitCode` is the driven script's own. */
  | 'completed'
  /** Readiness never arrived within the budget — nothing was driven. */
  | 'not-ready'
  /** Driven, but the sentinel never appeared before the deadline. */
  | 'timed-out'
  /** Stopped because its output crossed the log cap — no verdict, by design. */
  | 'overflowed'
  /** The harness itself could not run (no tmux, server would not start). */
  | 'unavailable';

export interface DriveReport {
  outcome: DriveOutcome;
  /**
   * True only for `completed`. The gate every reader should branch on, for the
   * reason `base-tree` has one: an observation from a run that never finished
   * is not a weaker observation of the same thing, it is a different thing.
   */
  observed: boolean;
  /** The driven script's exit code; null unless the sentinel was reached. */
  exitCode: number | null;
  /** Milliseconds spent waiting for readiness — reported even when it arrived. */
  readyAfterMs: number | null;
  /** Milliseconds from drive start to sentinel (or to the deadline). */
  droveForMs: number;
  /** Everything the pane held, trimmed. Partial unless `observed`. */
  output: string;
  /** True when `output` was cut by the capture cap rather than by the sentinel. */
  truncated: boolean;
  /** A stale server from an earlier run that this one had to kill first. */
  killedStale: boolean;
  note: string;
}

export interface DriveArgs {
  /** The script to drive. Runs inside the tmux window; its exit code is captured. */
  script: string;
  /** Working directory for both the readiness probe and the script. */
  cwd: string;
  /**
   * Shell command polled until it exits 0 — the readiness signal. Omit it and
   * the drive starts immediately, which is honest for a script that has nothing
   * to wait for and dishonest for anything that binds a port.
   */
  ready?: string;
  /** Seconds to wait for readiness before giving up. */
  readyTimeout: number;
  /** Seconds to wait for the sentinel after the drive starts. */
  timeout: number;
  out?: string;
  /**
   * tmux server name. Namespaced per run so a leaked server from another PR
   * cannot be captured from, or killed, by this one.
   */
  server: string;
  /** Test seam — production shells out for real. */
  exec?: (cmd: string, args: string[], input?: string) => ExecResult;
  /** Test seam — production derives it from `server`. */
  logPath?: string;
}

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * A tmux server name this command is willing to own.
 *
 * It is used twice — as a path segment under the temp dir, and inside the shell
 * line tmux runs — and it was safe in neither. Measured: `--server
 * '../../PWNED'` put `drive.sh` and its log at the FILESYSTEM ROOT, because
 * `join(tmpdir(), 'qwen-review-drive-' + server)` normalises the `..` away; and
 * a name holding `;` splits the `bash <script> > <log>` line into further
 * commands. The value is operator-supplied today, but this command exists to be
 * called from a review that builds its arguments programmatically — a name
 * derived from a branch or a PR title is one small step away, and neither of
 * those is ours to trust. The paths below are quoted as well: a charset this
 * narrow makes quoting redundant, and redundant is the point — the next person
 * to widen the charset should not also have to notice the shell line.
 */
const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Single-quote a path for `bash -lc`, closing over any embedded quote. */
export function shellQuote(v: string): string {
  return `'${v.split("'").join(`'\\''`)}'`;
}

/** Cap the captured pane the way build-test caps command output. */
const CAPTURE_MAX = 200_000;

/**
 * Cap on the log FILE, not just on what gets reported from it.
 *
 * `trimCapture` bounds the string this command hands back; nothing bounded what
 * the driven script wrote. Measured: a loop printing 200k lines left a 9.9 MB
 * log on disk while the report stayed at 200 KB — and a drive script is
 * whatever the reviewer wrote, so there is no upper bound at all. This repo has
 * already paid for that once: `build-test`'s disk floors exist because an
 * `npm ci` filled the disk 33 seconds in and then failed every agent scheduled
 * after it.
 *
 * Enforced by WATCHING, not by piping through `head -c`. That was the first
 * attempt and it is worse than the problem: `head` exits at the cap, the writer
 * takes SIGPIPE mid-loop, and the EXIT trap then fires with `$?` from the last
 * successful echo. Measured — a script whose last statement was `exit 5` came
 * back `rc=0`. Not a lost verdict: a FABRICATED one, a failing run reported as
 * a clean pass. A run this command had to stop is not a run that finished, so
 * it gets its own outcome and no exit code at all.
 */
const LOG_MAX_BYTES = 8 * 1024 * 1024;
/** How often readiness is polled. Fast enough to measure, slow enough to be cheap. */
const POLL_MS = 250;

/**
 * Wait, without asking the platform for a fractional `sleep`.
 *
 * The first version shelled out to `sleep 0.25`. Fractional operands are a
 * GNU/BSD extension — POSIX specifies an integer — so on a system without it
 * `sleep` fails, returns instantly, and the poll below becomes a tight loop.
 * Measured through the exec seam: **8.2 MILLION readiness probes in one
 * second**. That does not merely spin a CPU; it hammers the very daemon the
 * probe is waiting for, at millions of requests a second, and then reports that
 * it never became ready — a false negative manufactured by the harness, which
 * is the exact failure this command was written to remove.
 *
 * `Atomics.wait` blocks the thread for a real duration with no subprocess and
 * no platform surface at all.
 */
/** Size of the log so far; 0 when it is not there yet. */
function logBytes(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

function waitMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run(cmd: string, args: string[], input?: string): ExecResult {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    input,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    status: r.status ?? null,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

export const DRIVE_SENTINEL = '__QWEN_REVIEW_DRIVE_DONE__';

/**
 * The wrapper the driven script runs inside.
 *
 * The sentinel carries the exit code with it on ONE line, because the two facts
 * are read from the same capture and a capture that caught the marker but not
 * the code would report `completed` with an unknown result.
 *
 * Emitted from a `trap … EXIT`, not from a trailing `echo`. A drive script
 * reports its result by calling `exit N` — that is what `exit` is for — and
 * `exit` terminates the shell immediately, so a trailing echo is never reached
 * and `set +e` does nothing about it. Measured: `echo failing; exit 17` came
 * back as `timed-out` with a null exit code, i.e. a run that finished in
 * milliseconds and told us its answer was reported as one that never finished.
 * The trap fires on every way out — falling off the end, an explicit `exit`,
 * or an abort under `set -e`.
 *
 * And it writes to its OWN file, not into the captured stream. The log is
 * size-capped at the write end, and a cap on the stream is a cap on the
 * sentinel too: measured, a script printing 200k lines then `exit 5` had its
 * sentinel swallowed by the closed pipe and came back `timed-out` with a null
 * code — the same wrong answer, reintroduced by the fix for a different
 * problem. Two facts, two channels: the log may be trimmed, the verdict may
 * not.
 */
export function wrapScript(
  script: string,
  sentinelPath: string,
  sentinel = DRIVE_SENTINEL,
): string {
  return `trap '__qwen_rc=$?; echo "${sentinel} rc=\${__qwen_rc}" > ${shellQuote(sentinelPath)}' EXIT\nset +e\n${script}\n`;
}

/** Parse the sentinel line back out of a capture. Null when it is not there. */
export function sentinelExitCode(
  capture: string,
  sentinel = DRIVE_SENTINEL,
): number | null {
  // LAST occurrence. The trap's sentinel is, by construction, the final line
  // the wrapper writes — so anything sentinel-shaped ahead of it came from the
  // driven script itself, and a drive script that cats a log or replays a
  // capture can easily emit one. Taking the first match would let the script's
  // own text decide the exit code this command reports.
  const re = new RegExp(`${sentinel} rc=(\\d+)`, 'g');
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(capture); m; m = re.exec(capture)) last = m;
  return last ? Number(last[1]) : null;
}

/** Trim a capture to the cap, keeping the TAIL — the end is where the result is. */
export function trimCapture(s: string): { text: string; truncated: boolean } {
  if (s.length <= CAPTURE_MAX) return { text: s, truncated: false };
  return {
    text: `... [${s.length - CAPTURE_MAX} characters omitted from the head] ...\n${s.slice(-CAPTURE_MAX)}`,
    truncated: true,
  };
}

export function runDrive(args: DriveArgs): DriveReport {
  const exec = args.exec ?? run;
  const server = args.server;
  if (!SERVER_NAME_RE.test(server)) {
    return {
      outcome: 'unavailable',
      observed: false,
      exitCode: null,
      readyAfterMs: null,
      droveForMs: 0,
      output: '',
      truncated: false,
      killedStale: false,
      note: `--server ${JSON.stringify(server)} is not a name this command will own: it becomes both a path under the temp dir and a word in the shell line tmux runs, so it is restricted to letters, digits, dot, dash and underscore (max 64). Nothing was started.`,
    };
  }
  const tmux = (...a: string[]) => exec('tmux', ['-L', server, ...a]);

  if (exec('tmux', ['-V']).status !== 0) {
    return {
      outcome: 'unavailable',
      observed: false,
      exitCode: null,
      readyAfterMs: null,
      droveForMs: 0,
      output: '',
      truncated: false,
      killedStale: false,
      note: 'tmux is not available, so nothing could be driven — an environment gap, not a finding about the diff',
    };
  }

  // A server under this name from an earlier run is killed before anything
  // else. Inheriting it would mean capturing another run's pane, which is the
  // one way this command could report an observation of the wrong program.
  const killedStale = tmux('kill-server').status === 0;

  const started = Date.now();
  let readyAfterMs: number | null = null;
  if (args.ready) {
    const deadline = started + args.readyTimeout * 1000;
    for (;;) {
      if (exec('bash', ['-lc', args.ready]).status === 0) {
        readyAfterMs = Date.now() - started;
        break;
      }
      if (Date.now() >= deadline) {
        tmux('kill-server');
        return {
          outcome: 'not-ready',
          observed: false,
          exitCode: null,
          readyAfterMs: null,
          droveForMs: 0,
          output: '',
          truncated: false,
          killedStale,
          note: `readiness probe never succeeded within ${args.readyTimeout}s (\`${args.ready}\`) — nothing was driven, so nothing here is evidence about the diff. A slower machine needs a larger --ready-timeout; a probe that can never pass needs a different probe.`,
        };
      }
      waitMs(POLL_MS);
    }
  }

  const dir = join(tmpdir(), `qwen-review-drive-${server}`);
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, 'drive.sh');
  const logPath = args.logPath ?? join(dir, 'drive.log');
  const sentinelPath = join(dir, 'drive.rc');
  rmSync(sentinelPath, { force: true });
  writeFileSync(scriptPath, wrapScript(args.script, sentinelPath), 'utf8');

  const droveFrom = Date.now();
  let output = '';
  let exitCode: number | null = null;
  let outcome: DriveOutcome = 'timed-out';
  try {
    // The SCRIPT writes the log, not the pane. `pipe-pane` attaches after
    // `new-session` has already started the script, so a fast drive finishes —
    // and takes its session with it — before the pipe exists: measured here,
    // a one-second delay makes `pipe-pane` itself exit 1 and the log stay
    // empty, which this command would then have reported as `timed-out`. A
    // pane is a window that closes; the redirect is the record.
    const create = tmux(
      'new-session',
      '-d',
      '-c',
      args.cwd,
      'bash',
      '-lc',
      `bash ${shellQuote(scriptPath)} > ${shellQuote(logPath)} 2>&1`,
    );
    if (create.status !== 0) {
      return {
        outcome: 'unavailable',
        observed: false,
        exitCode: null,
        readyAfterMs,
        droveForMs: 0,
        output: '',
        truncated: false,
        killedStale,
        note: `tmux could not start a session: ${create.stderr.trim() || 'no error text'} — an environment gap, not a finding`,
      };
    }
    const deadline = droveFrom + args.timeout * 1000;
    for (;;) {
      output = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
      exitCode = existsSync(sentinelPath)
        ? sentinelExitCode(readFileSync(sentinelPath, 'utf8'))
        : null;
      if (exitCode !== null) {
        outcome = 'completed';
        break;
      }
      if (logBytes(logPath) > LOG_MAX_BYTES) {
        outcome = 'overflowed';
        break;
      }
      if (Date.now() >= deadline) break;
      waitMs(POLL_MS);
    }
  } finally {
    // Unconditional. The 87% that clean up by hand are the 87% that remembered;
    // a leaked server is the next run's wrong observation.
    tmux('kill-server');
    // ...and the working directory goes with it, once its contents have been
    // read into the report. The default server name carries the pid, so every
    // invocation would otherwise leave its own directory behind: measured, six
    // runs left five. `output` is already in memory by here, so nothing the
    // caller needs is in this tree. A caller who passed `--log-path` owns that
    // file and keeps it.
    if (!args.logPath) rmSync(dir, { recursive: true, force: true });
  }

  const { text, truncated } = trimCapture(output);
  const droveForMs = Date.now() - droveFrom;
  const note =
    outcome === 'overflowed'
      ? `the drive wrote more than ${Math.round(LOG_MAX_BYTES / 1024 / 1024)} MiB and was stopped — no exit code is reported because it never gave one, and a run this command had to stop is not evidence about the diff either way. Quieten the script, or have it manage its own output file.`
      : outcome === 'completed'
        ? `drove for ${Math.round(droveForMs / 1000)}s and reached its sentinel with exit ${exitCode}${readyAfterMs === null ? '' : ` (ready after ${Math.round(readyAfterMs / 1000)}s)`}${truncated ? '; the capture was trimmed at the head, so early output is missing' : ''}`
        : `the drive did not finish within ${args.timeout}s — the capture below is PARTIAL, and a partial capture is not evidence that the run produced nothing. Raise --timeout, or give the script a smaller job.`;

  return {
    outcome,
    observed: outcome === 'completed',
    exitCode,
    readyAfterMs,
    droveForMs,
    output: text,
    truncated,
    killedStale,
    note,
  };
}

export const driveCommand: CommandModule = {
  command: 'drive',
  describe:
    'Start something, wait until it is really up, drive it, and capture what it did — readiness polled rather than slept on, completion proven by a sentinel, cleanup guaranteed',
  builder: (yargs) =>
    yargs
      .option('script', {
        type: 'string',
        demandOption: true,
        describe: 'Shell script to drive (its exit code is captured)',
      })
      .option('cwd', {
        type: 'string',
        demandOption: true,
        describe: 'Working directory — usually the PR or base worktree',
      })
      .option('ready', {
        type: 'string',
        describe:
          'Command polled until it exits 0 before driving (omit only when nothing needs to come up first)',
      })
      .option('ready-timeout', {
        type: 'number',
        default: 60,
        describe: 'Seconds to wait for readiness',
      })
      .option('timeout', {
        type: 'number',
        default: 300,
        describe: 'Seconds to wait for the script to reach its sentinel',
      })
      .option('server', {
        type: 'string',
        default: `qr-${process.pid}`,
        describe:
          'tmux server name — namespaced so runs cannot capture each other',
      })
      .option('out', {
        type: 'string',
        describe: 'Write the JSON report here',
      }),
  handler: (argv) => {
    // Caught like `base-tree` and `test-plan`: the messages this handler
    // writes are for the caller, and a stack trace re-frames every one of
    // them as a crash.
    try {
      // The verifier brief sends agents straight here, so this can run without
      // `parse-args` ever running first — and it is where the long work
      // starts, which makes a stale bundle costliest here. The one-line form:
      // a fresh review already heard the full paragraph at `parse-args`, and
      // a repeated paragraph becomes wallpaper.
      const bundleNotice = bundleStalenessNotices(process.argv[1], true);
      if (bundleNotice) writeStderrLineSafe(bundleNotice);
      const args = argv as unknown as DriveArgs & { readyTimeout: number };
      const report = runDrive(args);
      if (args.out) {
        mkdirSync(dirname(resolve(args.out)), { recursive: true });
        writeFileSync(resolve(args.out), JSON.stringify(report, null, 2));
      }
      writeStdoutLine(JSON.stringify(report, null, 2));
      writeStderrLine(`drive: ${report.note}`);
      if (!report.observed) process.exitCode = 1;
    } catch (err) {
      writeStderrLine((err as Error).message);
      process.exitCode = 1;
    }
  },
};
