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
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';

/** Why a drive stopped. Every value is a fact about the run, not a verdict. */
export type DriveOutcome =
  /** The sentinel was reached; `exitCode` is the driven script's own. */
  | 'completed'
  /** Readiness never arrived within the budget — nothing was driven. */
  | 'not-ready'
  /** Driven, but the sentinel never appeared before the deadline. */
  | 'timed-out'
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
}

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Cap the captured pane the way build-test caps command output. */
const CAPTURE_MAX = 200_000;
/** How often readiness is polled. Fast enough to measure, slow enough to be cheap. */
const POLL_MS = 250;

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
 */
export function wrapScript(script: string, sentinel = DRIVE_SENTINEL): string {
  return `trap '__qwen_rc=$?; echo "${sentinel} rc=\${__qwen_rc}"' EXIT\nset +e\n${script}\n`;
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
      exec('sleep', [String(POLL_MS / 1000)]);
    }
  }

  const dir = join(tmpdir(), `qwen-review-drive-${server}`);
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, 'drive.sh');
  const logPath = join(dir, 'drive.log');
  writeFileSync(scriptPath, wrapScript(args.script), 'utf8');

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
      `bash ${scriptPath} > ${logPath} 2>&1`,
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
      exitCode = sentinelExitCode(output);
      if (exitCode !== null) {
        outcome = 'completed';
        break;
      }
      if (Date.now() >= deadline) break;
      exec('sleep', [String(POLL_MS / 1000)]);
    }
  } finally {
    // Unconditional. The 87% that clean up by hand are the 87% that remembered;
    // a leaked server is the next run's wrong observation.
    tmux('kill-server');
  }

  const { text, truncated } = trimCapture(output);
  const droveForMs = Date.now() - droveFrom;
  const note =
    outcome === 'completed'
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
    // Caught like `base-tree` and `test-plan`: the messages above are written
    // for the caller, and a stack trace re-frames every one of them as a crash.
    try {
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
