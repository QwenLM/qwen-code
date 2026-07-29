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
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { REVIEW_TMP_DIR, REVIEWS_DIR } from './lib/paths.js';
import { EFFORT_LEVELS } from './parse-args.js';

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

/** The composed-verdict fields this command republishes (see compose-review). */
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
  reportPath: string | null;
  childExitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

/** The /review invocation the child runs — built from flags, never hand-typed. */
export function buildReviewPrompt(args: {
  target?: string;
  effort?: string;
  comment?: boolean;
}): string {
  const parts = ['/review'];
  if (args.target) parts.push(args.target);
  if (args.effort) parts.push(`--effort ${args.effort}`);
  if (args.comment) parts.push('--comment');
  return parts.join(' ');
}

/**
 * The newest file under `dir` matching `pattern` whose mtime is at or after
 * `startMs`, or null. Pre-existing artifacts from earlier reviews in the same
 * repo must not be mistaken for this run's verdict — a stale composed JSON says
 * whatever the LAST review decided, which is exactly the wrong thing to
 * republish — so anything older than the run is invisible here.
 */
export function newestArtifactSince(
  dir: string,
  pattern: RegExp,
  startMs: number,
): string | null {
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
  return best ? best.path : null;
}

/**
 * Exit code contract: 0 = the review completed (whatever it decided); 1 = it
 * never reached a verdict (child failed, timed out, or left no composed
 * artifact); 3 = it completed AND the caller asked --fail-on request-changes
 * AND the event is REQUEST_CHANGES. 3, not 2 — yargs exits 1 on usage errors
 * and some shells reserve 2, so a CI gate can tell "review is blocking" from
 * "the tool broke" without parsing anything.
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

async function runReview(args: RunReviewArgs): Promise<void> {
  const startMs = Date.now();
  const prompt = buildReviewPrompt(args);

  // Re-enter THIS build's CLI, not whatever `qwen` PATH resolves to — the same
  // version-skew rule the skill's own subprocesses follow via QWEN_CODE_CLI.
  // process.argv[1] is the entry that is already running this command.
  const child = spawn(
    process.execPath,
    [process.argv[1], '--prompt', prompt, '--approval-mode', args.approvalMode],
    {
      // stdin CLOSED, not inherited: piped input would be prepended to the
      // prompt and the leading `/` would no longer be the first character —
      // the slash command would reach the model as plain text.
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  if (!args.quiet) {
    // Progress belongs on stderr; stdout is reserved for the result.
    child.stdout?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  } else {
    child.stdout?.resume();
    child.stderr?.resume();
  }

  let timedOut = false;
  const timeoutMs = args.timeoutMinutes * 60_000;
  const timer = setTimeout(() => {
    timedOut = true;
    writeStderrLine(
      `review run: timeout after ${args.timeoutMinutes} minutes — terminating the review`,
    );
    child.kill('SIGTERM');
    // The runner traps SIGTERM for cleanup; give it a moment, then insist.
    setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
  }, timeoutMs);

  const childExitCode: number | null = await new Promise((resolvePromise) => {
    child.on('close', (code) => resolvePromise(code));
    child.on('error', (err) => {
      writeStderrLine(`review run: failed to launch the CLI: ${err.message}`);
      resolvePromise(null);
    });
  });
  clearTimeout(timer);

  // The verdict is what compose-review wrote, not what the child printed. A
  // clean child exit without a composed artifact means the run wandered off
  // before Step 7 — that is "no verdict", not "approve".
  //
  // The cutoff carries slack: a coarse filesystem clock can stamp a file a
  // moment BEFORE the Date.now() captured at run start, and a review's own
  // verdict must not be discarded over clock granularity. Artifacts from a
  // previous review are minutes old, far outside any slack.
  const cutoffMs = startMs - 2_000;
  const composedPath = newestArtifactSince(
    REVIEW_TMP_DIR,
    /^qwen-review-.*composed\.json$/,
    cutoffMs,
  );
  const composed = composedPath ? readComposed(composedPath) : null;
  const reportPath = newestArtifactSince(REVIEWS_DIR, /\.md$/, cutoffMs);

  const completed = composed !== null && !timedOut;
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
    reportPath: reportPath ? resolve(reportPath) : null,
    childExitCode,
    timedOut,
    durationMs: Date.now() - startMs,
  };

  if (args.json) {
    writeStdoutLine(JSON.stringify(result, null, 2));
  } else if (completed) {
    writeStdoutLine(result.verdictLine ?? `Event: ${result.event}`);
    if (result.reportPath) writeStdoutLine(`Report: ${result.reportPath}`);
  } else {
    writeStdoutLine(
      timedOut
        ? 'Review did not complete: timed out.'
        : `Review did not complete: no composed verdict was produced` +
            `${childExitCode !== null ? ` (CLI exit ${childExitCode})` : ''}.`,
    );
  }

  process.exitCode = exitCodeFor(completed, result.event, args.failOn);
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
          'What to review: a PR number, or omit to review the local working tree',
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
      timeoutMinutes: Number(argv['timeout-minutes']) || 120,
      approvalMode: String(argv['approval-mode'] ?? 'yolo'),
      quiet: Boolean(argv['quiet']),
    });
  },
};
