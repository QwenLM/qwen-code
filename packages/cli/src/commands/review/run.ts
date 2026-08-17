/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review run`: execute a full /review non-interactively and report the
// verdict in a machine-readable way.
//
// The review pipeline already runs headless — `qwen --prompt "/review …"` expands
// the bundled skill, launches the dimension agents, and honors the approval mode.
// What that path does NOT give a caller is a contract: the verdict lives in the
// model's prose and in files whose names the caller would have to know, the exit
// code says nothing about the review's outcome, and a piped stdin silently
// defeats slash-command detection (the runner prepends piped input, and
// `isSlashCommand` requires the FIRST character to be `/`). Every consumer that
// wants "run a review, tell me what it decided" has been re-deriving those facts
// by scraping a terminal.
//
// This command is that contract, and nothing more: it assembles the /review
// invocation, runs the CLI's own non-interactive path in a child process with
// stdin closed, and then reads the verdict from the artifact `compose-review`
// wrote — the same JSON the skill treats as the verdict authority — rather than
// from anything the model said. Progress streams to stderr; stdout carries only
// the result; the exit code distinguishes "review completed" from "review never
// reached a verdict" from "blocking verdict" (opt-in via --fail-on).

import type { CommandModule } from 'yargs';
import { isUnusableScriptEntry } from '@qwen-code/qwen-code-core';
import { spawn, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  writeStdoutLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';
import { REVIEW_TMP_DIR, REVIEWS_DIR } from './lib/paths.js';
import { EFFORT_LEVELS, parseReviewArgs } from './parse-args.js';

export interface RunReviewArgs {
  target?: string;
  effort?: string;
  comment: boolean;
  json: boolean;
  failOn: 'none' | 'request-changes';
  timeoutMinutes: number;
  approvalMode: string;
  quiet: boolean;
}

/**
 * The composed-verdict fields this command republishes (see compose-review).
 * `findings`, `model`, and `disclosures` (named by #7981) are deliberately
 * absent: compose-review does not emit them as discrete fields, so there is
 * nothing to republish until the composed artifact grows them.
 */
interface ComposedVerdict {
  event?: string;
  verdictLine?: string;
  baseEvent?: string;
  cappedBy?: string[];
  downgraded?: boolean;
  downgradedFrom?: string | null;
  remediation?: string[];
}

export interface RunReviewResult {
  completed: boolean;
  event: string | null;
  verdictLine: string | null;
  baseEvent: string | null;
  cappedBy: string[];
  downgraded: boolean;
  downgradedFrom: string | null;
  remediation: string[];
  composedPath: string | null;
  /**
   * The exact `.qwen/tmp` filename this run's target class pins — named in
   * the result so a completed-but-uncaptured review (a naming drift between
   * this pin and the skill's template) is diagnosable after Step 9 has
   * swept the directory that would show the near-miss.
   */
  expectedComposedName: string;
  reportPath: string | null;
  childExitCode: number | null;
  childSignal: string | null;
  timedOut: boolean;
  durationMs: number;
}

/**
 * What a `review run` target IS, in the child's own terms. Classified by the
 * child's parser, not a local regex: the child names its artifacts after
 * what `parse-args` decided, so any second classifier here diverges exactly
 * where the shapes get interesting — `/pull/9014/files` (a PR to the parser,
 * unmatched by a $-anchored regex), `0042` (the parser writes `pr-42-`, a
 * verbatim pin looks for `pr-0042-`), `docs/pull/42` (a file path to the
 * parser). A run whose pin disagrees with the child reports a completed
 * review as "no verdict was produced".
 */
export type RunTargetClass =
  | { kind: 'pr'; number: string }
  | { kind: 'file'; base: string }
  | { kind: 'local' };

export function classifyRunTarget(target?: string): RunTargetClass {
  if (!target) return { kind: 'local' };
  const { target: t } = parseReviewArgs(target);
  if (t.type === 'pr-number' || t.type === 'pr-url') {
    return { kind: 'pr', number: String(t.number) };
  }
  if (t.type === 'file') {
    // The skill's `{target}` token for a file review is the file's basename
    // (`--target <filename>` in the capture step), so that is the identity
    // the child's artifact names carry. Trailing separators are stripped
    // first: a tab-completed `src/` classifies as a file target and reviews
    // the directory, and a bare `.pop()` would return `''` — a pin
    // (`qwen-review--composed.json`) no child artifact can ever carry.
    const trimmed = t.path.replace(/[\\/]+$/, '');
    return { kind: 'file', base: trimmed.split(/[\\/]/).pop() || trimmed };
  }
  return { kind: 'local' };
}

const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The one composed-verdict filename this run's target class produces, per
 * the skill's literal `--out .qwen/tmp/qwen-review-{target}-composed.json`
 * template: `pr-<n>` for a PR, the file's basename for a file review, the
 * fixed token `local` for a bare run. Exact names, not shape heuristics —
 * a name-shape pin (`(?!pr-\d+-)…`) rejected a file run's OWN artifact
 * whenever the reviewed file was named `pr-<digits>-…`, and conversely let
 * a PR pin claim that file run's artifact. Two concurrent `review run`s
 * share `.qwen/tmp`, and the pre-pin newest-composed scan captured the
 * OTHER run's verdict the moment it appeared (measured: two of three
 * parallel PR reviews republished a neighbour's `composedPath`).
 *
 * Known residual races, accepted — the pin separates composed FILENAMES,
 * which is as much identity as the child's naming carries; do not diagnose
 * any of these as a pin failure:
 *
 *  - same target twice (two bare runs, or the same PR twice) — the same
 *    filename, so whichever child composes last wins for both parents;
 *  - two FILE targets with different paths but one basename (a monorepo's
 *    two `index.ts`) — the child names by basename, so their filenames
 *    collide the same way;
 *  - a FILE target whose basename is literally `local` or `pr-<digits>` —
 *    its filename is byte-identical to the local/PR pin.
 *
 * Only a per-run nonce in the child's artifact names could key these
 * apart, and the bundled skill, not this command, would have to mint it.
 */
export function composedNameFor(cls: RunTargetClass): string {
  switch (cls.kind) {
    case 'pr':
      return `qwen-review-pr-${cls.number}-composed.json`;
    case 'file':
      return `qwen-review-${cls.base}-composed.json`;
    case 'local':
    default:
      return 'qwen-review-local-composed.json';
  }
}

export function composedPatternFor(cls: RunTargetClass): RegExp {
  return new RegExp(`^${escapeRe(composedNameFor(cls))}$`);
}

/**
 * The saved report under `.qwen/reviews/`, pinned as far as its naming
 * allows. PR reports reliably end `-pr-<n>.md`, and file reports carry the
 * filename in the same slot (`<date>-<time>-<filename>.md`, the `.md` not
 * doubled) — so a file target named `pr-1234.md` claims its OWN report
 * instead of tripping the local branch's PR exclusion. Local report stems
 * are model-chosen (three date formats observed in one day), so a bare run
 * claims any report EXCEPT a PR-suffixed one — concurrent local runs can
 * still pool reports, and a PR run cannot be told from a file run whose
 * basename is `pr-<n>.md` by name alone. The report is informational; the
 * verdict (`composedPatternFor`) is what carries the exit code, and it is
 * exact.
 */
export function reportPatternFor(cls: RunTargetClass): RegExp {
  switch (cls.kind) {
    case 'pr':
      return new RegExp(`-pr-${cls.number}\\.md$`);
    case 'file':
      return new RegExp(
        cls.base.toLowerCase().endsWith('.md')
          ? `-${escapeRe(cls.base)}$`
          : `-${escapeRe(cls.base)}\\.md$`,
      );
    case 'local':
    default:
      return /^(?!.*-pr-\d+\.md$).*\.md$/;
  }
}

// How often to poll for the composed verdict while the child runs. The verdict
// sits on disk from Step 6 (compose-review) until Step 9 (cleanup) — a window
// spanning the model's between-step narration and the report write, i.e.
// seconds — so a quarter-second poll catches it with a wide margin.
const COMPOSED_POLL_MS = 250;

// Conventional exit codes for a run cancelled by a signal (128 + signum).
const SIGNAL_EXIT_CODES: Record<string, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};
const PARENT_SIGNALS = Object.keys(SIGNAL_EXIT_CODES) as NodeJS.Signals[];

/** The /review invocation the child runs — built from flags, never hand-typed. */
export function buildReviewPrompt(args: {
  target?: string;
  effort?: string;
  comment?: boolean;
}): string {
  const parts = ['/review'];
  // Presence, not truthiness: an EMPTY target is a target the caller named
  // and got wrong — `qwen review run "$TARGET"` with `TARGET` unset — and
  // treating it as "no target given" silently launches a full local review
  // on the caller's tree, at the 120-minute default timeout and real model
  // spend, instead of the error its siblings `/`, `//`, `\` now get.
  if (args.target !== undefined) {
    // The child re-tokenizes this string; a target carrying whitespace or a
    // leading dash would split into extra tokens (`123 --comment` would
    // silently authorise posting), and a quote is stripped by the tokenizer
    // (`src/it's.ts` would re-target to `src/its.ts`) — refuse anything but a
    // single clean token.
    if (
      args.target.trim() === '' ||
      /\s/.test(args.target) ||
      args.target.startsWith('-') ||
      /['"]/.test(args.target) ||
      // A separators-only path (`/`, `//`, `\`) names no file: it survives
      // basename extraction as the empty string, which pins the unmatchable
      // `qwen-review--composed.json` and burns a whole child review before
      // reporting "no composed verdict". Refuse it here instead.
      /^[\\/]+$/.test(args.target)
    ) {
      throw new Error(
        `Invalid review target ${JSON.stringify(args.target)}: expected a single PR number, PR URL, or file path`,
      );
    }
    parts.push(args.target);
  }
  if (args.effort) parts.push(`--effort ${args.effort}`);
  if (args.comment) parts.push('--comment');
  return parts.join(' ');
}

/**
 * The newest file under `dir` matching `pattern` whose mtime is at or after
 * `startMs`, or null. Pre-existing artifacts from earlier reviews in the same
 * repo must not be mistaken for this run's verdict — a stale composed JSON says
 * whatever the LAST review decided, which is exactly the wrong thing to
 * republish — so anything older than the run is invisible here. The mtime
 * rides along with the path: the capture poll compares it against what it
 * already holds, and re-statting the path here would race the child's Step 9
 * sweep, which unlinks these files while the parent may still be polling.
 */
export function newestArtifactSince(
  dir: string,
  pattern: RegExp,
  startMs: number,
): { path: string; mtime: number } | null {
  let best: { path: string; mtime: number } | null = null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null; // no directory — the review never got far enough to create it
  }
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const path = join(dir, name);
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < startMs) continue;
    if (!best || mtime > best.mtime) best = { path, mtime };
  }
  return best;
}

/**
 * Exit code contract: 0 = the review completed (whatever it decided); 1 = it
 * never reached a verdict (child failed, timed out with no verdict captured,
 * or left no composed artifact); 3 = it completed AND the caller asked
 * --fail-on request-changes AND the event is REQUEST_CHANGES. 3, not 2 — yargs
 * exits 1 on usage errors and some shells reserve 2, so a CI gate can tell
 * "review is blocking" from "the tool broke" without parsing anything.
 */
export function exitCodeFor(
  completed: boolean,
  event: string | null,
  failOn: 'none' | 'request-changes',
): number {
  if (!completed) return 1;
  if (failOn === 'request-changes' && event === 'REQUEST_CHANGES') return 3;
  return 0;
}

function readComposed(path: string): ComposedVerdict | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ComposedVerdict;
    // The one field everything downstream keys on. A file without it is not a
    // composed verdict, whatever its name says.
    return typeof parsed.event === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Terminate the child's process group — the detached relaunch wrapper AND the
 * real review it spawned. On POSIX a negative pid names the group; on Windows
 * there are no POSIX process groups and a negative pid is meaningless, so fall
 * back to `taskkill /T`, which walks the tree the detached child spawned. Both
 * are best-effort: killing a group that is already gone throws, and that is
 * fine.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } catch {
      // Already dead, or taskkill unavailable.
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Already dead.
  }
}

/**
 * The child review's environment, with one correction: QWEN_CODE_CLI.
 *
 * An UNSET slot is corrected too, and that case is not hypothetical: cli.ts
 * stamps a *derived* `../index.js`, which does not exist beside the bundle, so
 * a `node dist/cli.js review run <pr>` never stamps anything and the child
 * review inherits nothing. Measured on PR #9113: the skill's second subcommand,
 * `"${QWEN_CODE_CLI:-qwen}" review match-remote`, resolved `qwen` off PATH,
 * landed in an older global install whose `review` has no `match-remote`, and
 * came back `Unknown arguments: owner, repo, host, match-remote` — the review
 * then spent minutes diagnosing its own harness instead of reading the diff.
 * `review run` is the one place that can close this without guessing: it is
 * about to re-enter `process.argv[1]` as the review CLI, so argv[1] IS this
 * build's entry, no derivation involved.
 *
 * The stamp is only written when a shell could exec it — the same test the
 * consumer applies at spawn time (isUnusableScriptEntry). A stamp that fails
 * that test is worse than none: `${QWEN_CODE_CLI:-qwen}` falls back on empty,
 * but a set-and-unusable path dies on exit 126.
 *
 * cli.ts stamps QWEN_CODE_CLI first-writer-wins, so a `review run` launched
 * from INSIDE a parent Qwen session inherits the parent's entry — and the
 * skill's every `"${QWEN_CODE_CLI:-qwen}" review …` subcommand then runs the
 * PARENT's build for the entire review. Measured: a working-tree `review run`
 * issued from a 0.21.3 session had its whole prompt roster built by 0.21.3 —
 * the review ran one version of the skill while its subcommands answered to
 * another, and nothing raised an error.
 *
 * The inherited value is right only when it reaches THIS build (an outer
 * launcher of the same install: the npm bin shim, cli-entry.js, the desktop
 * bundle). The child runs argv[1], so compare the resolved package roots
 * (dirname of realpathSync): cli-entry.js stamps itself but spawns cli.js,
 * so an exact-file comparison would blank a valid same-install stamp. On a
 * root mismatch, an inherited path that does not resolve, or an UNSET slot,
 * stamp this build's own `argv[1]` — the entry this command is about to
 * re-enter — when a shell could exec it; write '' only when that entry fails
 * `isUnusableScriptEntry`, preserving the bare-`qwen` fallback instead of a
 * stamp that dies on exit 126.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const inherited = env['QWEN_CODE_CLI'];
  const ownEntry = process.argv[1];
  if (!ownEntry) {
    return env;
  }
  if (inherited) {
    try {
      if (
        dirname(realpathSync(inherited)) === dirname(realpathSync(ownEntry))
      ) {
        return env;
      }
    } catch {
      // An inherited entry that does not resolve cannot be this build's.
    }
  }
  // Either nothing was stamped, or what was stamped belongs to another install.
  // Both are answered by this build's own entry — when a shell can exec it.
  env['QWEN_CODE_CLI'] = isUnusableScriptEntry(resolve(ownEntry))
    ? ''
    : resolve(ownEntry);
  return env;
}

async function runReview(args: RunReviewArgs): Promise<void> {
  const startMs = Date.now();
  const prompt = buildReviewPrompt(args);

  // The verdict cutoff carries slack: a coarse filesystem clock can stamp a
  // file a moment BEFORE the Date.now() captured at run start, and a review's
  // own verdict must not be discarded over clock granularity. Artifacts from a
  // previous review are minutes old, far outside any slack.
  const cutoffMs = startMs - 2_000;

  // Re-enter THIS build's CLI, not whatever `qwen` PATH resolves to — the same
  // version-skew rule the skill's own subprocesses follow via QWEN_CODE_CLI.
  // process.argv[1] is the entry that is already running this command.
  // --expose-gc comes first, exactly as the relaunch wrapper passes it
  // (cli-entry.js): a full review is the longest, most memory-hungry session
  // the CLI runs, and spawning argv[1] directly would silently drop the flag
  // the memory-pressure monitor's critical tier needs to call global.gc().
  const child = spawn(
    process.execPath,
    [
      '--expose-gc',
      process.argv[1],
      '--prompt',
      prompt,
      '--approval-mode',
      args.approvalMode,
    ],
    {
      env: childEnv(),
      // stdin CLOSED, not inherited: piped input would be prepended to the
      // prompt and the leading `/` would no longer be the first character —
      // the slash command would reach the model as plain text.
      stdio: ['ignore', 'pipe', 'pipe'],
      // The CLI relaunches itself in a child (for --max-old-space-size), so
      // the pid we spawn is a wrapper whose grandchild is the real review.
      // A new process group lets the timeout kill reach both.
      detached: true,
    },
  );

  if (!args.quiet) {
    // Progress belongs on stderr; stdout is reserved for the result. A throw
    // here (EPIPE once the pipe reader exits) would crash the parent and orphan
    // the child review, so the write stays incidental.
    const writeProgress = (chunk: Buffer): void => {
      try {
        process.stderr.write(chunk);
      } catch {
        // stderr is gone; the verdict, not the progress, is what matters.
      }
    };
    child.stdout?.on('data', writeProgress);
    child.stderr?.on('data', writeProgress);
  } else {
    child.stdout?.resume();
    child.stderr?.resume();
  }

  // The composed verdict is transient: the child's Step 9 `cleanup` sweeps
  // every `.qwen/tmp/qwen-review-<target>-*` file — including it — before the
  // child exits. Reading it only AFTER `close` therefore sees nothing and
  // reports a review that completed as one that failed. Snapshot it the moment
  // compose-review writes it, and keep re-reading while the child runs: a
  // coverage re-check can legitimately recompose the verdict (measured: a live
  // run rewrote its composed artifact twelve minutes after the first write),
  // and the FIRST snapshot would republish the superseded one.
  const targetClass = classifyRunTarget(args.target);
  const composedPattern = composedPatternFor(targetClass);
  let capturedPath: string | null = null;
  let capturedVerdict: ComposedVerdict | null = null;
  let capturedMtime = -Infinity;
  const captureTimer = setInterval(() => {
    const best = newestArtifactSince(REVIEW_TMP_DIR, composedPattern, cutoffMs);
    if (best === null || best.mtime <= capturedMtime) return;
    // A half-written file fails to parse; the next tick retries it.
    const verdict = readComposed(best.path);
    if (verdict !== null) {
      capturedPath = best.path;
      capturedVerdict = verdict;
      capturedMtime = best.mtime;
    }
  }, COMPOSED_POLL_MS);

  let timedOut = false;
  const timeoutMs = args.timeoutMinutes * 60_000;
  const timer = setTimeout(() => {
    timedOut = true;
    // Safe write: a throw on EPIPE would skip the kill below and leave the
    // child review running on, burning compute and model API calls.
    writeStderrLineSafe(
      `review run: timeout after ${args.timeoutMinutes} minutes — terminating the review`,
    );
    // Kill the process group, not just the wrapper: child.kill() would only
    // reach the relaunch wrapper, leaving the real review reparented to PID 1
    // and still burning API calls.
    const pid = child.pid;
    if (pid !== undefined) {
      killProcessGroup(pid, 'SIGTERM');
      setTimeout(() => killProcessGroup(pid, 'SIGKILL'), 10_000).unref();
    }
  }, timeoutMs);

  // The child is detached (its own process group) so the timeout kill can reach
  // the relaunch wrapper's grandchild — but that also puts it outside the
  // foreground group a terminal's Ctrl+C signals, and a cancelled CI job sends
  // the parent SIGTERM. Without forwarding, the parent dies and the review is
  // reparented to PID 1, burning model API calls for up to the full timeout
  // (and, with --comment, can still post after the job that spawned it is
  // gone). Terminate the group on the way out, mirroring the timeout path.
  const onParentSignal = (signal: NodeJS.Signals): void => {
    clearTimeout(timer);
    clearInterval(captureTimer);
    const pid = child.pid;
    if (pid !== undefined) {
      // SIGTERM's default action terminates the node group; the parent exits
      // immediately, so there is no later moment to escalate to SIGKILL.
      killProcessGroup(pid, 'SIGTERM');
    }
    process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
  };
  for (const signal of PARENT_SIGNALS) process.on(signal, onParentSignal);

  const childOutcome = await new Promise<{
    code: number | null;
    signal: string | null;
  }>((resolvePromise) => {
    child.on('close', (code, signal) => resolvePromise({ code, signal }));
    child.on('error', (err) => {
      writeStderrLineSafe(
        `review run: failed to launch the CLI: ${err.message}`,
      );
      resolvePromise({ code: null, signal: null });
    });
  });
  const childExitCode = childOutcome.code;
  const childSignal = childOutcome.signal;
  clearTimeout(timer);
  clearInterval(captureTimer);
  for (const signal of PARENT_SIGNALS) process.off(signal, onParentSignal);

  // The verdict is what compose-review wrote, not what the child printed. A
  // clean child exit without a composed artifact means the run wandered off
  // before Step 7 — that is "no verdict", not "approve". Prefer the verdict
  // captured during the run (Step 9 cleanup has usually swept the file by now);
  // fall back to a disk scan for a child that died before cleanup ran.
  // Annotated, not inferred: capturedPath/capturedVerdict are mutated only
  // inside the poll closure, so control-flow analysis would narrow them to
  // their `null` initializer and reject the fallback reassignment below.
  let composedPath: string | null = capturedPath;
  let composed: ComposedVerdict | null = capturedVerdict;
  if (composed === null) {
    const best = newestArtifactSince(REVIEW_TMP_DIR, composedPattern, cutoffMs);
    composedPath = best?.path ?? null;
    composed = composedPath ? readComposed(composedPath) : null;
  }
  const reportPath =
    newestArtifactSince(REVIEWS_DIR, reportPatternFor(targetClass), cutoffMs)
      ?.path ?? null;

  const completed = composed !== null;
  const result: RunReviewResult = {
    completed,
    event: composed?.event ?? null,
    verdictLine: composed?.verdictLine ?? null,
    baseEvent: composed?.baseEvent ?? null,
    cappedBy: composed?.cappedBy ?? [],
    downgraded: composed?.downgraded ?? false,
    downgradedFrom: composed?.downgradedFrom ?? null,
    remediation: composed?.remediation ?? [],
    composedPath: composedPath ? resolve(composedPath) : null,
    expectedComposedName: composedNameFor(targetClass),
    reportPath: reportPath ? resolve(reportPath) : null,
    childExitCode,
    childSignal,
    timedOut,
    durationMs: Date.now() - startMs,
  };

  // Assign the exit code BEFORE writing the result: a stdout write can throw
  // (EPIPE once the pipe reader exits), and the exit code — not the prose — is
  // the contract a CI gate reads. A throw must not downgrade a blocking verdict
  // (exit 3) to yargs' generic failure (exit 1).
  process.exitCode = exitCodeFor(completed, result.event, args.failOn);

  try {
    if (args.json) {
      writeStdoutLine(JSON.stringify(result, null, 2));
    } else if (completed) {
      writeStdoutLine(result.verdictLine ?? `Event: ${result.event}`);
      if (result.reportPath) writeStdoutLine(`Report: ${result.reportPath}`);
    } else {
      // Name the expectation: the pin is an exact-filename contract with the
      // skill's naming template, and by the time anyone investigates, Step 9
      // has swept `.qwen/tmp` — the near-miss name is gone. A no-verdict
      // report that does not say which file it was waiting for cannot be
      // diagnosed as a naming drift.
      const detail =
        composedPath !== null
          ? `a composed verdict was found at ${resolve(composedPath)} but could not be parsed`
          : `no composed verdict was produced (expected ${join(
              REVIEW_TMP_DIR,
              composedNameFor(targetClass),
            )})`;
      writeStdoutLine(
        timedOut
          ? 'Review did not complete: timed out.'
          : `Review did not complete: ${detail}` +
              `${childExitCode !== null ? ` (CLI exit ${childExitCode})` : ''}` +
              `${childSignal !== null ? ` (killed by ${childSignal})` : ''}.`,
      );
    }
  } catch {
    // stdout is gone; the exit code above is the contract, not this prose.
  }
}

export const runCommand: CommandModule = {
  command: 'run [target]',
  describe:
    'Run a full /review non-interactively and print the verdict (machine-readable with --json)',
  builder: (yargs) =>
    yargs
      .positional('target', {
        type: 'string',
        describe:
          'What to review: a PR number, a PR URL, or a file path; omit to review the local working tree',
      })
      .option('effort', {
        type: 'string',
        choices: [...EFFORT_LEVELS],
        describe:
          'The review effort. Defaults to the skill default for the target (high for a PR, medium locally).',
      })
      .option('comment', {
        type: 'boolean',
        default: false,
        describe:
          'Authorise posting the review to GitHub (PR targets only) — same meaning as `/review <pr> --comment`',
      })
      .option('json', {
        type: 'boolean',
        default: false,
        describe: 'Print the full result as JSON on stdout',
      })
      .option('fail-on', {
        type: 'string',
        choices: ['none', 'request-changes'],
        default: 'none',
        describe:
          'Exit 3 when the review completes with this outcome — lets CI gate on the verdict without parsing output',
      })
      .option('timeout-minutes', {
        type: 'number',
        default: 120,
        describe:
          'Terminate the review after this long without a verdict (exit 1)',
      })
      .option('approval-mode', {
        type: 'string',
        default: 'yolo',
        choices: ['plan', 'default', 'auto-edit', 'auto', 'yolo'],
        describe:
          'Approval mode for the child CLI. The default is yolo: headless runs cannot answer ' +
          'confirmation prompts, and anything still unapproved would be auto-denied mid-review.',
      })
      .option('quiet', {
        type: 'boolean',
        default: false,
        describe: 'Suppress the child CLI progress stream on stderr',
      }),
  handler: async (argv) => {
    await runReview({
      target: argv['target'] as string | undefined,
      effort: argv['effort'] as string | undefined,
      comment: Boolean(argv['comment']),
      json: Boolean(argv['json']),
      failOn: (argv['fail-on'] as 'none' | 'request-changes') ?? 'none',
      // `|| 120` would treat an explicit `--timeout-minutes 0` as falsy and
      // silently substitute the default; decide default-vs-value by finiteness
      // so 0 still reaches the 1-minute floor.
      timeoutMinutes: Number.isFinite(Number(argv['timeout-minutes']))
        ? Math.max(1, Number(argv['timeout-minutes']))
        : 120,
      approvalMode: String(argv['approval-mode'] ?? 'yolo'),
      quiet: Boolean(argv['quiet']),
    });
  },
};
