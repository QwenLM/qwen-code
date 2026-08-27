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
  openSync,
  fstatSync,
  readSync,
  closeSync,
  constants,
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
  /** The driven script's exit code; null unless `outcome` is `completed`. */
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
  /**
   * Facts read back out of THIS run's own output, one per `--capture`.
   *
   * A RECORD of the run, never an input to it. Extraction happens after the
   * drive loop has ended, so nothing here can reach a request the script has
   * already made — and treating it as though it could is worse than not
   * capturing at all: a script that addressed 8931 while the service logged
   * 8932 completes with `observed: true` beside `captured.baseUrl` of 8932,
   * and nothing in the report contradicts it, so a witness quoting that
   * address attributes 8931's readings to the daemon on 8932. The script has
   * to derive the address from the service's own output before its first
   * request; what this field then adds is evidence that the address it used
   * is the one the service printed. The verify brief carries the recipe.
   *
   * The address a service actually bound is the motivating one, and it is not
   * the address it was asked for: `qwen serve` handed a taken port prints
   * `port 8931 is in use, trying 8932...` and listens on the next one. A caller
   * that goes on addressing its requested port then reads a DIFFERENT, stale
   * process for the rest of the run — and every number it reports is about that
   * process, while the drive completes and looks exactly like a clean one.
   * Measured: a full verification cycle spent on a daemon that was not the one
   * under test.
   *
   * `null` when nothing was captured — the pattern never matched, or it
   * declares a group the match left unfilled. That is a different fact from a
   * captured empty string, and only the second is a measurement.
   *
   * `''` is narrower than it looks, and the narrowing is the pattern's rather
   * than the service's: it means the pattern matched and its group captured
   * zero characters, which a `*`-quantified group does wherever it is anchored
   * — `pid=(\d*)` returns `''` against `pid=abc`. A pattern meant to tell
   * "printed nothing" from "printed something" needs `+`, not `*`.
   *
   * Absent entirely when nothing was captured, so a report from a drive that
   * asked for nothing does not claim an empty result set.
   */
  captured?: Record<string, string | null>;
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
  /**
   * `name=<regex>` pairs read back out of the drive's own output. Repeatable.
   * Capture group 1 when the pattern has one, the whole match otherwise.
   */
  capture?: string[];
  /** Test seam — production shells out for real. */
  exec?: (
    cmd: string,
    args: string[],
    input?: string,
    timeoutMs?: number,
    killSignal?: NodeJS.Signals,
  ) => ExecResult;
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
// Exported (with the log cap and the two poll helpers below) for `ab-drive`,
// which owns the same tmux/sentinel mechanics across two arms and must not
// re-derive them — a second copy of a safety rule is where the two drift.
export const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Single-quote a path for `bash -lc`, closing over any embedded quote. */
export function shellQuote(v: string): string {
  return `'${v.split("'").join(`'\\''`)}'`;
}

/** Cap the captured pane the way build-test caps command output. */
const CAPTURE_MAX = 200_000;

/**
 * Bounds on `--capture`. Small on purpose: this exists to lift a handful of
 * run-derived facts out of a log — an address, a pid, a chosen path — not to
 * become a reporting language. A caller who wants more than this wants `jq`
 * over the log, which they already have.
 */
const MAX_CAPTURES = 8;
/**
 * Bounds the pattern's LENGTH, not its running time: a nested quantifier like
 * `(a+)+$` — nine characters, well under this cap — backtracks exponentially
 * on a near-matching run, and extraction happens after the poll loop exits,
 * where `--timeout` no longer reaches. Measured growth is ~×3.5 per +2
 * characters, so a ~40-char near-miss is hours at 100% CPU with no report
 * ever written. Keep patterns linear; the verify brief says so where it tells
 * agents to author their own.
 */
const MAX_CAPTURE_PATTERN = 200;
/** Capture names travel into a JSON key and a report a human reads. */
const CAPTURE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/**
 * A captured value is the one output channel here with no cap anywhere else:
 * it comes out of the UNTRIMMED log before `trimCapture`, so one group could
 * otherwise carry megabytes into the report — which the handler writes to
 * BOTH stdout and the `--out` file — and the verify brief tells agents to
 * quote captured values in the witness. Symmetric with `trimCapture`: cut at
 * a bound, and say that it cut.
 */
const CAPTURE_VALUE_MAX = 4096;

export interface CaptureSpec {
  name: string;
  re: RegExp;
  /**
   * Whether the pattern declares a capturing group, decided when it is parsed
   * rather than from whether group 1 happened to participate in a match.
   *
   * Those are different questions and conflating them loses a value silently.
   * `(?:a(x))?b` against `b` matches with group 1 absent; a runtime
   * `m[1] ?? m[0]` then reports the WHOLE MATCH under a name whose pattern
   * asked for the group — the caller receives `"b"` where it asked for what
   * `x` matched, and nothing says a substitution happened. A pattern that
   * declares a group and did not fill it captured nothing, which is `null`.
   */
  hasGroup: boolean;
}

/**
 * Does this pattern declare a capturing group?
 *
 * Counted by matching `<source>|` against the empty string — the alternation
 * always matches, and the result's length is 1 + the group count, which is the
 * standard way to ask this without parsing regex syntax. Guarded because it
 * builds a second pattern from the first: any source that survived
 * `new RegExp` should survive this too, and a source that somehow does not
 * falls back to "no group", which is the pre-existing whole-match behaviour
 * rather than a throw from a helper that only counts.
 */
function declaresGroup(re: RegExp): boolean {
  try {
    return (new RegExp(`${re.source}|`).exec('')?.length ?? 1) > 1;
  } catch {
    return false;
  }
}

/**
 * Parse `--capture name=<regex>` pairs, or say why they cannot be used.
 *
 * Rejects rather than skips, and rejects the whole set rather than the bad
 * entry: a drive that quietly dropped one capture would report the others
 * beside a missing key, which reads as "the service never printed it" — the
 * one meaning `null` is reserved for. A malformed request is the caller's bug
 * and must not be able to disguise itself as a measurement.
 *
 * Split on the FIRST `=` only, because a regex may hold as many as it likes
 * (`--capture port=listening on \S+=(\d+)` is a legitimate pattern).
 */
export function parseCaptureSpecs(
  raw: readonly string[] | undefined,
): { specs: CaptureSpec[] } | { error: string } {
  if (!raw) return { specs: [] };
  if (raw.length === 0) {
    return {
      error:
        '--capture was given but holds no `name=<regex>` pair — an empty ask would run the whole drive and report identically to never having asked, and a malformed request must not be able to disguise itself.',
    };
  }
  if (raw.length > MAX_CAPTURES) {
    return {
      error: `--capture was given ${raw.length} patterns; the cap is ${MAX_CAPTURES}. This lifts a few run-derived facts out of the log, not a report format.`,
    };
  }
  const specs: CaptureSpec[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      return {
        error: `--capture ${JSON.stringify(entry)} is not \`name=<regex>\` — the name comes first, then one \`=\`, then the pattern (later \`=\` characters belong to the pattern).`,
      };
    }
    const name = entry.slice(0, eq);
    const pattern = entry.slice(eq + 1);
    if (!CAPTURE_NAME_RE.test(name)) {
      return {
        error: `--capture name ${JSON.stringify(name)} is not usable as a report key: letters, digits, underscore and dash, starting with a letter, max 32.`,
      };
    }
    if (seen.has(name)) {
      return {
        error: `--capture name ${JSON.stringify(name)} was given twice; one of the two would silently win.`,
      };
    }
    if (pattern.length === 0 || pattern.length > MAX_CAPTURE_PATTERN) {
      return {
        error: `--capture ${JSON.stringify(name)} needs a pattern of 1 to ${MAX_CAPTURE_PATTERN} characters.`,
      };
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      return {
        error: `--capture ${JSON.stringify(name)} is not a valid regular expression: ${(err as Error).message}`,
      };
    }
    seen.add(name);
    specs.push({ name, re, hasGroup: declaresGroup(re) });
  }
  return { specs };
}

/**
 * Read each pattern out of the drive's output.
 *
 * Against the UNTRIMMED log, not the report's `output`: `trimCapture` keeps the
 * tail, and the line a service prints when it binds is near the head — the one
 * value this feature exists for is exactly the one a trimmed capture loses.
 *
 * Group 1 when the pattern declares one, the whole match otherwise, so both
 * `listening on \S+` and `listening on (\S+)` do what they look like — and a
 * declared group the match left unfilled is `null`, not a quiet substitution
 * of the whole match under the same name.
 *
 * FIRST match, unlike `sentinelExitCode`'s last. The two are answering
 * different questions: the sentinel's decoys come from the driven script's own
 * text and the real one is written last by construction, whereas the value this
 * exists for is printed once, at startup, before anything else could have
 * echoed it. A caller who wants the most recent of several occurrences says so
 * in the pattern rather than having the rule chosen for them.
 *
 * A value longer than the cap is cut at it, keeping the head and naming the
 * full length — a service that prints one huge line under a pattern spanning
 * it must not put megabytes into the report.
 */
export function extractCaptures(
  output: string,
  specs: readonly CaptureSpec[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const { name, re, hasGroup } of specs) {
    const m = re.exec(output);
    // A pattern that declares a group is asking for the group. When it matched
    // but the group did not participate, nothing was captured — `null` — and
    // NOT the whole match, which would answer a question the caller did not
    // ask under the name it did.
    const v = m ? (hasGroup ? (m[1] ?? null) : m[0]) : null;
    out[name] =
      v !== null && v.length > CAPTURE_VALUE_MAX
        ? `${v.slice(0, CAPTURE_VALUE_MAX)}... [truncated, ${v.length} characters total]`
        : v;
  }
  return out;
}

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
export const LOG_MAX_BYTES = 8 * 1024 * 1024;
/**
 * A hard ceiling on how large a log file may be before the poll loop reads it
 * at all. `LOG_MAX_BYTES` is the SOFT cap: a log over it is classified
 * `overflowed`, but only AFTER the read, so the trimmed tail is still reported.
 * A log can grow past V8's ~512 MiB string limit between polls, though, and
 * then the read throws `ERR_STRING_TOO_LONG` — swallowed to '' by the ab-drive
 * capture (a completed arm reporting an empty capture, two different arms
 * comparing equal) or thrown out of the loop in drive. Set well under that
 * limit, this bounds the allocation: past it the log is unreadable evidence
 * anyway, so the loop classifies `overflowed` WITHOUT reading.
 */
export const MAX_READ_BYTES = 256 * 1024 * 1024;
/** How often readiness is polled. Fast enough to measure, slow enough to be cheap. */
export const POLL_MS = 250;

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
export function logBytes(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

export function waitMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read a file bounded by its size AT open time, never following a concurrent
 * writer. A `statSync`-then-`readFileSync` guard is check-then-use: readFileSync
 * keeps reading a file that grows past the size it stat'd, so a log a
 * backgrounded writer bursts mid-read can still exceed V8's ~512 MiB string
 * limit and throw `ERR_STRING_TOO_LONG` — the exact throw the ceiling exists to
 * prevent. Opening once, `fstat`-ing, and reading at most that many bytes caps
 * the allocation at a size already accepted. `{ overflow: true }` when the file
 * is already over `maxBytes` (the caller treats it as overflowed); an absent
 * file reads as an empty snapshot, as before.
 */
export function readCapped(
  path: string,
  maxBytes: number,
): { overflow: boolean; text: string } {
  let fd: number;
  try {
    // O_NONBLOCK, mirroring readIfThere: an untrusted arm can swap its log for
    // a writer-less FIFO (`rm log; mkfifo log` — it learns the path from its
    // wrapper's command line), and a blocking open would then hang the poll
    // loop FOREVER, past --timeout, with the finally kill-server never reached.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return { overflow: false, text: '' }; // absent/unopenable → empty snapshot
  }
  try {
    const st = fstatSync(fd);
    // Only a regular file is a log. A DIRECTORY (`rm log; mkdir log`) would let
    // openSync succeed and then throw EISDIR out of readSync into the poll
    // loop; a FIFO/device is not a capture. Treat any non-regular file as an
    // empty snapshot — the same guard readIfThere applies.
    if (!st.isFile()) return { overflow: false, text: '' };
    const size = st.size;
    if (size > maxBytes) return { overflow: true, text: '' };
    const buf = Buffer.allocUnsafe(size);
    let off = 0;
    // Read at most `size` bytes (from absolute positions), so a writer that
    // grows the file after the fstat cannot enlarge this read.
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n <= 0) break; // shrank or hit EOF early — keep what we have
      off += n;
    }
    return { overflow: false, text: buf.toString('utf8', 0, off) };
  } catch {
    // fstat/read on a hostile special file must not escape into the handler
    // catch-all (exit 1, the whole run's report — including the other arm's
    // completed capture — discarded). Treat as an empty snapshot.
    return { overflow: false, text: '' };
  } finally {
    closeSync(fd);
  }
}

/**
 * The production exec: 30s hang guard, 64MB buffer, null-status-means-failure.
 * Exported for `ab-drive`, which owns the same tmux mechanics across two arms
 * — a second copy of these limits is where the two commands drift apart under
 * the same failure.
 */
export function spawnExec(
  cmd: string,
  args: string[],
  input?: string,
  timeoutMs = 30_000,
  killSignal?: NodeJS.Signals,
): ExecResult {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    input,
    timeout: timeoutMs,
    // spawnSync's timeout kill defaults to SIGTERM, which untrusted code can
    // trap — a probe that ignores it would block past its budget forever.
    // Callers running disposable, untrusted work (readiness probes) pass
    // SIGKILL so the budget is hard.
    ...(killSignal ? { killSignal } : {}),
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
  userScriptPath: string,
  sentinelPath: string,
  sentinel = DRIVE_SENTINEL,
): string {
  // Run the user body from its OWN file (`bash <file>`), not inlined. Two
  // properties fall out. `exec` in the body (`exec node server.js`) replaces
  // only THAT child bash, so the trap-owning wrapper survives to write the
  // sentinel — without this the arm would time out despite finishing. And a
  // construct that swallows trailing text — an unterminated heredoc — is
  // delimited by the END of the user file, so it cannot reach past it. An
  // earlier inlined subshell `( … )` could not offer the second: a dangling
  // heredoc consumed the closing paren, the compound never parsed, and the body
  // silently did not run while the trap stamped the syntax-error rc.
  return `trap '__qwen_rc=$?; echo "${sentinel} rc=\${__qwen_rc}" > ${shellQuote(sentinelPath)}' EXIT\nset +e\nbash ${shellQuote(userScriptPath)}\n`;
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
  const exec = args.exec ?? spawnExec;
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
  // Before anything is started, like the server-name check above: a caller who
  // asked for a capture wants it in the witness, and discovering the pattern
  // was malformed after a 300-second drive costs the drive.
  const parsed = parseCaptureSpecs(args.capture);
  if ('error' in parsed) {
    return {
      outcome: 'unavailable',
      observed: false,
      exitCode: null,
      readyAfterMs: null,
      droveForMs: 0,
      output: '',
      truncated: false,
      killedStale: false,
      note: `${parsed.error} Nothing was started.`,
    };
  }
  const captureSpecs = parsed.specs;
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
  const bodyPath = join(dir, 'drive.body.sh');
  const logPath = args.logPath ?? join(dir, 'drive.log');
  const sentinelPath = join(dir, 'drive.rc');
  rmSync(sentinelPath, { force: true });
  // The user body in its own file so wrapScript runs it with `bash <file>`.
  writeFileSync(bodyPath, `${args.script}\n`, 'utf8');
  writeFileSync(scriptPath, wrapScript(bodyPath, sentinelPath), 'utf8');

  const droveFrom = Date.now();
  let output = '';
  let exitCode: number | null = null;
  let outcome: DriveOutcome = 'timed-out';
  // NOTE — deliberately NO signal handler here. The poll loop is fully
  // synchronous (spawnSync + Atomics.wait + sync fs), so the event loop never
  // turns during a drive, and a `process.on('SIGTERM')` callback is only ever
  // delivered on an event-loop turn. Registering one would not run the
  // teardown mid-loop AND would suppress Node's default terminate action — so
  // SIGTERM/SIGINT/SIGHUP would be silently IGNORED for the whole --timeout
  // (measured: the drive ran to completion and exited 0), strictly worse than
  // the default. The keeper that a signalled process leaks (it setsids out of
  // reach of a group kill) is the accepted same-uid teardown-reachability
  // residual; closing it needs an async loop or an out-of-process watchdog.
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
      // Bounded read: `readCapped` opens once, fstats, and reads at most that
      // many bytes, so a writer bursting the log past MAX_READ_BYTES mid-read
      // cannot enlarge the allocation into an ERR_STRING_TOO_LONG throw. Over
      // the ceiling is `overflowed`; the soft LOG_MAX_BYTES check below still
      // trims an ordinary overflow.
      const cap = readCapped(logPath, MAX_READ_BYTES);
      if (cap.overflow) {
        outcome = 'overflowed';
        break;
      }
      output = cap.text;
      exitCode = existsSync(sentinelPath)
        ? sentinelExitCode(readFileSync(sentinelPath, 'utf8'))
        : null;
      if (exitCode !== null) {
        // Re-read the log now that the sentinel is there, because the read
        // above happened BEFORE it. The wrapper writes the sentinel from an
        // EXIT trap, strictly after the script's last write to the log, so a
        // final write landing between these two back-to-back reads is in the
        // file and not in the snapshot — a window one `readFileSync` of a
        // near-cap log wide, measured at ~1 in 70 such drives. It used to cost
        // a truncated tail in `output`, which reads as a display artefact;
        // with `captured` extracted from that same snapshot it costs a `null`
        // for a value the run demonstrably produced, under a note asserting
        // the pattern never matched. Every log write happens-before the
        // sentinel write, so a read taken after it is complete. Kept to this
        // branch: the other exits stopped the run rather than observing it
        // finish, and have no such guarantee to lean on.
        // Re-read (bounded) now the sentinel is there: a final burst past
        // MAX_READ_BYTES between the top-of-iteration read and the sentinel is
        // still classified overflowed rather than throwing.
        const done = readCapped(logPath, MAX_READ_BYTES);
        if (done.overflow) {
          outcome = 'overflowed';
          break;
        }
        output = done.text;
        outcome = 'completed';
        break;
      }
      // Soft cap, after the read: an ordinary overflow keeps its trimmed tail
      // (unlike the unread hard-ceiling break at the top of the loop).
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
    // file and keeps it. Best-effort: an `ENOTEMPTY`/`EIO` from a degraded
    // tmpdir must not throw the finished report away out of the finally.
    if (!args.logPath) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  // From the untrimmed log, and on every outcome rather than only `completed`:
  // a drive that timed out still bound its port, and the address it bound is
  // often the fact that explains why the rest of it went nowhere.
  const captured =
    captureSpecs.length > 0 ? extractCaptures(output, captureSpecs) : undefined;
  const { text, truncated } = trimCapture(output);
  const droveForMs = Date.now() - droveFrom;
  const missed = captured
    ? Object.entries(captured)
        .filter(([, v]) => v === null)
        .map(([k]) => k)
    : [];
  const note =
    outcome === 'overflowed'
      ? `the drive wrote more than ${Math.round(LOG_MAX_BYTES / 1024 / 1024)} MiB and was stopped — no exit code is reported because it never gave one, and a run this command had to stop is not evidence about the diff either way. Quieten the script, or have it manage its own output file.`
      : outcome === 'completed'
        ? `drove for ${Math.round(droveForMs / 1000)}s and reached its sentinel with exit ${exitCode}${readyAfterMs === null ? '' : ` (ready after ${Math.round(readyAfterMs / 1000)}s)`}${truncated ? '; the capture was trimmed at the head, so early output is missing' : ''}`
        : `the drive did not finish within ${args.timeout}s — the capture below is PARTIAL, and a partial capture is not evidence that the run produced nothing. Raise --timeout, or give the script a smaller job.`;

  // Named, not merely counted. A `null` capture is the case where a witness is
  // about to quote a value the run never produced, and the reader needs to know
  // WHICH one before deciding whether the rest still stands.
  const captureNote =
    missed.length > 0
      ? ` — --capture produced no value for ${missed.map((n) => JSON.stringify(n)).join(', ')} (the pattern never matched, or its group did not participate), so ${missed.length === 1 ? 'that value is' : 'those values are'} null rather than measured; anything addressed by ${missed.length === 1 ? 'it' : 'them'} was addressed by assumption`
      : '';

  // Reconciles the head-trim clause with the capture block beside it. `output`
  // is trimmed at the head and `captured` is read BEFORE that trim, so without
  // this the report says "early output is missing" immediately beside values
  // that came out of the missing head — and, for a miss, beside a `null` the
  // reader would reasonably blame the trim for. Both misreadings run the same
  // way: they invite doubt about a measurement that is sound.
  //
  // Completed only: "the head-trim above" appears only in the completed note,
  // and only a run that reached its sentinel had a whole run to miss against —
  // a timed-out or overflowed drive was stopped early, so a value printed
  // after the stop never reached the extraction.
  const trimScopeNote =
    captured && truncated && outcome === 'completed'
      ? ' — --capture reads the untrimmed log, so the head-trim above does not reach it and a null capture is a miss against the whole run rather than against what survived the trim'
      : '';

  return {
    outcome,
    observed: outcome === 'completed',
    // Null unless the run completed (the documented invariant): the poll loop
    // reads the sentinel every iteration, and the sentinel branch's
    // hard-ceiling break stops a run whose sentinel DID appear — the very
    // iteration the log crossed MAX_READ_BYTES. Returning that value beside
    // the overflowed note contradicts the note, and a caller branching on
    // `exitCode !== null` as the completion signal would treat a stopped,
    // unread run as completed. ab-drive's twin masks this the same way.
    exitCode: outcome === 'completed' ? exitCode : null,
    readyAfterMs,
    droveForMs,
    output: text,
    truncated,
    killedStale,
    ...(captured ? { captured } : {}),
    note: `${note}${trimScopeNote}${captureNote}`,
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
      .option('capture', {
        type: 'array',
        string: true,
        describe:
          "name=<regex> read back out of this run's own output, e.g. baseUrl=listening on (https?://\\S+). Repeatable. Group 1 when the pattern declares one, the whole match otherwise; null when nothing was captured — the pattern never matched, or its declared group did not participate. Keep patterns linear — no nested quantifiers like (a+)+: extraction runs after the drive ends, where no --timeout reaches, and a backtracking pattern hangs the run with no report. Use it for anything the service CHOSE rather than was told — above all the address it actually bound.",
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
