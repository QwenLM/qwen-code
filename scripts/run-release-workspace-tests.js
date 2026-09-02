/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the release workspace test suite and, when it exits non-zero without a
 * single failing test, says so instead of leaving the operator to search a
 * 10,000-line log for a `FAIL` that is not there.
 *
 * That combination is not hypothetical. `packages/core/vitest.config.ts` sets
 * `dangerouslyIgnoreUnhandledErrors` to false on Linux, so one leaked async
 * error fails a run whose tests all passed — release run 33576013293 exited 1
 * with "211 passed / 9480 tests passed" as its last words, and the release
 * notification reported it as an ordinary quality failure. Whatever the next
 * leak turns out to be, this makes the shape of the failure legible from the
 * job's annotations alone.
 *
 * Output is streamed through unchanged; this only adds an annotation after the
 * fact, and only when the run failed with nothing failing in it.
 */

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { escapeWorkflowCommand, isMainModule } from './release-script-utils.js';

// Matching ESC is the point; the GitHub log API also renders it as a literal
// "^[" pair, and both forms have to come out before the text is scanned.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /(?:\x1b|\^\[)\[[0-9;]*m/g;
// Vitest frames its unhandled-error report with a run of these; the same
// character opens the per-error sections inside the block.
const RULE_RE = /^[⎯\s]+$/;
const RULE_EDGE_RE = /^[⎯\s]+|[⎯\s]+$/g;
const UNHANDLED_START_RE = /Unhandled Errors?/;
// Anchored: vitest prints its failure header at the start of the line. A
// whitespace-bounded match anywhere would let a passing test whose NAME
// contains FAIL ("renders FAIL banner for expired token") set the flag, and a
// set flag suppresses the annotation this script exists to emit.
const FAIL_LINE_RE = /^\s*FAIL(\s|$)/;
const FAILED_COUNT_RE = /^\s*(Test Files|Tests)\s+\d+\s+failed/;
const SUMMARY_RE = /^\s*(Test Files|Tests)\s+\S/;
// The block is bounded so a pathological run cannot turn one annotation into
// the whole log; the head of an unhandled error is where the cause lives.
const MAX_BLOCK_LINES = 60;
const MAX_TAIL_LINES = 40;
const MAX_SUMMARY_LINES = 4;

/**
 * Reduces a run's output to the three things that decide how the failure is
 * reported: whether any test failed, what the unhandled-error blocks said, and
 * what the run's last summary lines were.
 *
 * @param {string} text
 * @returns {{
 *   hasFailingTests: boolean,
 *   unhandledBlocks: string[],
 *   summaryLines: string[],
 *   tailLines: string[],
 * }}
 */
export function createRunClassifier() {
  let hasFailingTests = false;
  const unhandledBlocks = [];
  const summaryLines = [];
  const tailLines = [];
  let capturing = null;

  const pushLine = (raw) => {
    const line = raw.replace(ANSI_RE, '');

    if (line.trim()) {
      tailLines.push(line);
      if (tailLines.length > MAX_TAIL_LINES) tailLines.shift();
    }

    if (FAIL_LINE_RE.test(line) || FAILED_COUNT_RE.test(line)) {
      hasFailingTests = true;
    }

    if (SUMMARY_RE.test(line)) {
      summaryLines.push(line.trim());
      // Only the tail of the summary matters: the release suite runs one
      // vitest per workspace, so an early workspace's totals say nothing
      // about the exit. Trim as we go so a long run cannot accumulate one
      // entry per workspace and beyond.
      if (summaryLines.length > MAX_SUMMARY_LINES) summaryLines.shift();
    }

    if (capturing) {
      // A rule line closes the block, but only once it holds something: the
      // block opens with a rule line of its own.
      if (RULE_RE.test(line) && capturing.some((entry) => entry.trim())) {
        unhandledBlocks.push(capturing.join('\n').trim());
        capturing = null;
        return;
      }
      if (capturing.length >= MAX_BLOCK_LINES) {
        unhandledBlocks.push(
          `${capturing.join('\n').trim()}\n… truncated at ${MAX_BLOCK_LINES} lines`,
        );
        capturing = null;
        return;
      }
      capturing.push(line);
      return;
    }

    if (UNHANDLED_START_RE.test(line)) {
      // Keep the words, drop the rule runs vitest draws on either side of
      // them: `⎯⎯⎯ Unhandled Errors ⎯⎯⎯` becomes `Unhandled Errors`.
      capturing = [line.replace(RULE_EDGE_RE, '')];
    }
  };

  return {
    /** Feeds one already-split line. */
    push: pushLine,
    /**
     * Feeds a raw chunk, holding back the trailing partial line until the
     * next chunk completes it.
     */
    write(chunk, pending = '') {
      const text = pending + chunk;
      const parts = text.split(/\r?\n/);
      const remainder = parts.pop() ?? '';
      for (const part of parts) pushLine(part);
      return remainder;
    },
    finish(pending = '') {
      if (pending) pushLine(pending);
      if (capturing?.some((entry) => entry.trim())) {
        unhandledBlocks.push(capturing.join('\n').trim());
        capturing = null;
      }
      return {
        hasFailingTests,
        unhandledBlocks,
        summaryLines: summaryLines.slice(-MAX_SUMMARY_LINES),
        tailLines,
      };
    },
  };
}

/**
 * Wires one child's output streams into a classifier. A multi-byte character
 * can be split across pipe chunks, and decoding each raw chunk on its own
 * (`chunk.toString('utf8')`) turns the split character into U+FFFD — and a
 * rule line whose `⎯` became U+FFFD no longer matches RULE_RE, so the block
 * that line opened or closed silently vanishes from the report. Each stream
 * gets its own decoder ahead of the line splitter; the sink still receives
 * the raw chunk untouched.
 *
 * @param {ReturnType<typeof createRunClassifier>} classifier
 */
export function createStreamConsumer(classifier) {
  const decoders = {
    out: new StringDecoder('utf8'),
    err: new StringDecoder('utf8'),
  };
  const pending = { out: '', err: '' };
  return {
    /** Feeds one raw chunk from stream `key`; the sink sees it unchanged. */
    write(chunk, sink, key) {
      pending[key] = classifier.write(decoders[key].write(chunk), pending[key]);
      sink.write(chunk);
    },
    /**
     * Flushes whatever partial character each decoder still holds, then the
     * partial line each stream still holds, and returns the classification.
     */
    finish() {
      for (const key of ['err', 'out']) {
        pending[key] = classifier.write(decoders[key].end(), pending[key]);
      }
      if (pending.err) classifier.push(pending.err);
      return classifier.finish(pending.out);
    },
  };
}

/**
 * Convenience wrapper for a run whose output is already in hand.
 *
 * @param {string} text
 * @returns {{
 *   hasFailingTests: boolean,
 *   unhandledBlocks: string[],
 *   summaryLines: string[],
 *   tailLines: string[],
 * }}
 */
export function classifyRunOutput(text) {
  const classifier = createRunClassifier();
  for (const line of String(text ?? '').split(/\r?\n/)) classifier.push(line);
  return classifier.finish();
}

/**
 * Builds what to say about a finished run. Returns null when the run needs no
 * commentary: it passed, or it failed with failing tests that speak for
 * themselves.
 *
 * @param {ReturnType<typeof classifyRunOutput>} classification
 * @param {number} exitCode
 * @returns {{ title: string, body: string } | null}
 */
export function describeSilentFailure(classification, exitCode) {
  if (exitCode === 0) return null;
  if (classification.hasFailingTests) return null;

  const summary = classification.summaryLines.length
    ? classification.summaryLines.join('\n')
    : '(no vitest summary line found)';

  if (classification.unhandledBlocks.length > 0) {
    const blocks = classification.unhandledBlocks.join('\n\n');
    return {
      title: `Workspace tests exited ${exitCode} with no failing test`,
      body: [
        `The suite reported no failing test and still exited ${exitCode}: vitest`,
        'caught an error outside any test, which fails the run on Linux because',
        'packages/core/vitest.config.ts sets dangerouslyIgnoreUnhandledErrors to',
        'false there. Nothing in the log carries a FAIL line.',
        '',
        blocks,
        '',
        summary,
      ].join('\n'),
    };
  }

  return {
    title: `Workspace tests exited ${exitCode} with no failing test`,
    body: [
      `The suite reported no failing test and no unhandled error, and still`,
      `exited ${exitCode}. The run's last lines were:`,
      '',
      classification.tailLines.join('\n'),
      '',
      summary,
    ].join('\n'),
  };
}

/**
 * Runs the command, streaming its output, and reports a silent non-zero exit.
 *
 * @returns {Promise<number>} the child's exit code
 */
export async function runAndReport({
  command,
  args,
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  summaryPath = process.env['GITHUB_STEP_SUMMARY'],
} = {}) {
  // The suite prints tens of thousands of lines, and this wrapper sits
  // outside the very process already running under a heap cap. Classify as
  // the output streams past and keep only the bounded state the report needs,
  // rather than holding the whole run in memory to scan it once at the end.
  // One consumer per run: a chunk can end mid-line or mid-character, and
  // splicing a half line of stdout onto the next stderr chunk would invent a
  // line neither stream printed.
  const consumer = createStreamConsumer(createRunClassifier());
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
      // Node >= 22 refuses to spawn a .cmd shim without a shell (the
      // CVE-2024-27980 hardening, whose opt-out the 22 line removed), and the
      // repo pins Node 22. scripts/dev.js spawns its shims the same way. Only
      // a shim goes through the shell: cmd.exe re-parses the joined command
      // line, which mangles quoted arguments handed to a real executable and
      // loses a program path containing a space.
      shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command),
    });
    child.stdout.on('data', (chunk) => consumer.write(chunk, stdout, 'out'));
    child.stderr.on('data', (chunk) => consumer.write(chunk, stderr, 'err'));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      // A signal death has no exit code; report it as a failure rather than
      // letting `null` become a passing 0 downstream.
      resolve(code ?? (signal ? 1 : 0));
    });
  });

  const classification = consumer.finish();
  const report = describeSilentFailure(classification, exitCode);
  if (!report) return exitCode;

  stdout.write(
    `::error title=${escapeWorkflowCommand(report.title)}::${escapeWorkflowCommand(report.body)}\n`,
  );
  stderr.write(`\n${report.title}\n\n${report.body}\n`);

  if (summaryPath) {
    try {
      appendFileSync(
        summaryPath,
        `### ${report.title}\n\n\`\`\`\n${report.body}\n\`\`\`\n`,
      );
    } catch (error) {
      // The summary is a convenience; never let writing it change the outcome.
      stderr.write(`(could not write the job summary: ${error.message})\n`);
    }
  }

  return exitCode;
}

// `import.meta.url` is a percent-encoded WHATWG URL, so comparing it against a
// hand-built `file://` + argv[1] is false for any checkout path holding a
// space, `#`, `%` or non-ASCII byte, and false on Windows always. A false
// guard skips this block entirely: the wrapper exits 0 having spawned
// nothing, which is the silent green this script exists to prevent.
if (isMainModule(import.meta.url)) {
  const passthrough = process.argv.slice(2).filter((arg, index, all) => {
    // `node script.js -- --shard=1/3` keeps npm's own separator out of the way;
    // drop only the leading one so a later `--` still reaches vitest.
    return !(arg === '--' && all.slice(0, index).every((a) => a !== '--'));
  });
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const exitCode = await runAndReport({
    command,
    args: ['run', 'test:release:workspaces', '--', ...passthrough],
  });
  process.exit(exitCode);
}
