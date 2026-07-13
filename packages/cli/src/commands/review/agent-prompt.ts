/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review agent-prompt`: build a review agent's launch prompt in code.
//
// The prompt used to be composed by the orchestrator, from a paragraph of the
// skill's instructions telling it what to include. Measured against the harness's
// own record of what the agents were actually launched with — the first record of
// each subagent transcript, written at launch and not retconnable — the
// orchestrator did not include it:
//
//   23 of 23 chunk agents were launched with a prompt that named NO diff file:
//   no `diffPathAbsolute`, no `read_file`, no offset, no limit. All 23 made zero
//   tool calls.
//
// They were handed a *description* of a chunk they had no way to open ("The
// changes are in chunk 13 of 23, covering lines 3808-4024 of the diff"), and a
// sentence to say if they found nothing ("If you find no issues, say 'No issues
// found — reviewed chunk 13 (...)'"). They said it. Every one of them.
//
// So the agents never whiffed. They were launched blind, and then dutifully read
// their line. The receipts they returned — which looked like proof of work — were
// in the prompt that launched them.
//
// This is the same failure this skill has now fixed five times over: a rule the
// prompt states in prose is a rule that will eventually not be followed, and the
// fix is always to move it into code that can say no. It was applied to the
// review target, the posting gate, the verdict, and the coverage report. The
// agent's own prompt — the thing that decides whether a review can happen at all
// — was the one place it was not.
//
// The orchestrator now asks for the prompt instead of writing it. What comes back
// carries the diff path, the agent's exact byte range, and the paging and
// uncoverable rules, because those are not things a caller should be trusted to
// remember.

import type { CommandModule } from 'yargs';
import { readFileSync } from 'node:fs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { READ_FILE_CHAR_CAP, type DiffChunk } from './lib/diff-plan.js';

interface AgentPromptArgs {
  plan: string;
  chunk: number;
  rules?: string;
}

/** The plan report, as far as this command needs it. */
interface PlanReport {
  diffPathAbsolute?: unknown;
  chunks?: unknown;
}

/**
 * The severity definitions, verbatim.
 *
 * A chunk agent owns the test-coverage dimension with no dedicated agent to
 * calibrate it, and an uncalibrated agent files "zero test coverage" as Critical.
 * It has happened.
 */
const SEVERITY = `Apply the severity definitions:
- **Critical** — the code does something wrong. A bug that produces incorrect behaviour, a security hole, data loss, a resource or state leak, a build or test failure.
- **Suggestion** — a recommended improvement to code that works.
- **Nice to have** — optional.`;

const FINDING_FORMAT = `Format each finding using this structure:
- **File:** <file path>:<line number or range>
- **Anchor:** <1-3 consecutive lines copied VERBATIM from the diff>
- **Source:** [review]
- **Issue:** <one-line statement of the defect>
- **Failure scenario:** <the concrete trigger and the concrete wrong outcome: what input, state, timing, or config makes this code misbehave, and what incorrect output / crash / leak / exposure results>
- **Suggested fix:** <concrete code suggestion when possible, or "N/A">
- **Severity:** Critical | Suggestion | Nice to have
- **Confidence:** high | low`;

/** Validate the plan and pull out the one chunk this agent owns. */
function chunkFrom(
  report: PlanReport,
  id: number,
): {
  diffPath: string;
  chunk: DiffChunk;
  total: number;
} {
  const diffPath = report.diffPathAbsolute;
  if (typeof diffPath !== 'string' || diffPath.length === 0) {
    throw new Error(
      'agent-prompt: the plan has no `diffPathAbsolute`. Without it the agent ' +
        'has no way to reach the diff — which is the entire bug this command ' +
        'exists to prevent. Pass the report written by fetch-pr / plan-diff / ' +
        'capture-local.',
    );
  }
  if (!Array.isArray(report.chunks) || report.chunks.length === 0) {
    throw new Error('agent-prompt: the plan has no `chunks[]`.');
  }
  const chunks = report.chunks as DiffChunk[];
  const chunk = chunks.find((c) => c?.id === id);
  if (!chunk) {
    throw new Error(
      `agent-prompt: the plan has no chunk ${id} (it has ${chunks.length}: ` +
        `${chunks.map((c) => c?.id).join(', ')}).`,
    );
  }
  if (
    !Number.isSafeInteger(chunk.startLine) ||
    !Number.isSafeInteger(chunk.endLine) ||
    chunk.startLine < 1 ||
    chunk.endLine < chunk.startLine
  ) {
    throw new Error(
      `agent-prompt: chunk ${id} has no usable line range ` +
        `(startLine=${chunk.startLine}, endLine=${chunk.endLine}).`,
    );
  }
  return { diffPath, chunk, total: chunks.length };
}

/**
 * The launch prompt for the agent that owns `chunk`.
 *
 * Exported for the tests, which assert the properties that were missing from
 * every real launch: the diff path is in it, the read call is in it, and the
 * agent is not handed a sentence to recite when it finds nothing.
 */
export function buildChunkAgentPrompt(
  report: PlanReport,
  id: number,
  rules?: string,
): string {
  const { diffPath, chunk, total } = chunkFrom(report, id);

  // `read_file` takes a 0-based line offset; the plan's ranges are 1-based.
  const offset = chunk.startLine - 1;
  const limit = chunk.endLine - chunk.startLine + 1;

  const files = (chunk.files ?? [])
    .map((f) => `- ${f.path} (new-side lines ${f.newStart}-${f.newEnd})`)
    .join('\n');

  // The uncoverable case: a single line longer than one read returns. Paging
  // starts every page at a line boundary, so the tail of that line is
  // unreachable by any offset. Such a chunk must not be receipted as covered.
  const unreachable = chunk.maxLineChars > READ_FILE_CHAR_CAP;

  const parts = [
    `You are reviewing chunk ${chunk.id} of ${total} of a code diff.`,
    '',
    '**Read your chunk first. It is a file on disk — nothing in this prompt contains the code.**',
    '',
    '```',
    `read_file(file_path="${diffPath}", offset=${offset}, limit=${limit})`,
    '```',
    '',
    `That is your territory: lines ${chunk.startLine}-${chunk.endLine} of the diff ` +
      `(${chunk.lines} lines, ${chunk.chars} characters). The surrounding chunks belong ` +
      `to other agents — do not review them.`,
    '',
    'It covers these source files:',
    files || '- (none recorded)',
    '',
    '**If the read comes back with `isTruncated` set, you do not have your chunk.** ' +
      'Keep calling `read_file` with a larger `offset` until you have the whole range. ' +
      'A receipt for a range you only half read makes the coverage guarantee a lie, ' +
      'which is worse than not having one.',
  ];

  if (unreachable) {
    parts.push(
      '',
      `**This chunk contains a single line of ${chunk.maxLineChars} characters** — longer ` +
        'than one read returns, and paging cannot reach its tail (every page starts at a ' +
        'line boundary). Do not claim to have reviewed it. Return exactly:',
      '',
      `    Uncoverable: chunk ${chunk.id} — line exceeds the read limit`,
    );
  } else if (chunk.oversized) {
    parts.push(
      '',
      '**This chunk is oversized** — it is a single hunk with no safe place to cut, and it ' +
        'may exceed one read. Expect to page.',
    );
  }

  parts.push(
    '',
    'You may also `read_file` the **full source files** above from the worktree whenever a ' +
      "hunk's correctness depends on code outside it. Diff context is three lines deep; state " +
      'invariants are not. Page a source file that comes back truncated rather than reasoning ' +
      'from its first screenful.',
    '',
    '## What to review',
    '',
    'For your territory only, you own every dimension: line-by-line correctness, the ' +
      'removed-behavior audit of your own deleted lines, security, code quality, performance, ' +
      'test coverage, and the adversarial reading. Two duties are NOT yours, because a chunk ' +
      'agent is structurally blind to them: cross-file tracing (a caller in another chunk) and ' +
      'the cross-chunk half of removed-behavior. Audit the deletions in your own territory; do ' +
      'not conclude a deletion is unreplaced merely because its replacement is not in your range.',
    '',
    FINDING_FORMAT,
    '',
    SEVERITY,
    '',
    'Review the diff, not pre-existing issues in unchanged code.',
  );

  if (rules && rules.trim()) {
    parts.push('', '## Project rules', '', rules.trim());
  }

  // Deliberately NOT included: a sentence for the agent to recite when it finds
  // nothing. Every real launch handed the agent its own receipt text — `If you
  // find no issues, say "No issues found — reviewed chunk 13 (...)"` — and an
  // agent that cannot open the diff will still happily say it. A receipt the
  // prompt wrote is not evidence of work. Report what you examined, in your own
  // words, from what you read.
  parts.push(
    '',
    '## When you are done',
    '',
    'If you found nothing, say so **and say what you examined** — the specific lines, files ' +
      'and cases you walked, in your own words. Do not recite a stock sentence: a return that ' +
      'names nothing you read is indistinguishable from never having read anything, and will ' +
      'be treated as such.',
  );

  // The receipt, but NOT for an unreachable chunk: that one has already been told
  // to return `Uncoverable`, and asking for both hands the agent two instructions
  // that contradict each other. Downstream, a chunk that reports itself both
  // uncoverable and covered is neither, and the honest one loses.
  if (!unreachable) {
    parts.push(
      '',
      `Then, on its own final line: \`Covered: chunk ${chunk.id} lines ${chunk.startLine}-${chunk.endLine}\``,
    );
  }

  return parts.join('\n');
}

function runAgentPrompt(args: AgentPromptArgs): void {
  let report: PlanReport;
  try {
    report = JSON.parse(readFileSync(args.plan, 'utf8')) as PlanReport;
  } catch (err) {
    throw new Error(
      `agent-prompt: cannot read the plan ${args.plan}: ${(err as Error).message}`,
    );
  }

  // The project rules Step 2 loaded. They belong in the agent's prompt — the
  // skill now says this command builds it and to pass what it prints verbatim, so
  // there is no longer a later step in which the orchestrator would staple them
  // on. Without this flag they were loaded, written to a file, and silently
  // dropped: the review would enforce no project rule at all and say nothing.
  let rules: string | undefined;
  if (args.rules) {
    try {
      rules = readFileSync(args.rules, 'utf8');
    } catch (err) {
      throw new Error(
        `agent-prompt: cannot read the rules ${args.rules}: ` +
          `${(err as Error).message}. Omit --rules if this review has none; ` +
          'passing a path that does not resolve would silently review without ' +
          'the project rules it was told to enforce.',
      );
    }
  }

  writeStdoutLine(buildChunkAgentPrompt(report, args.chunk, rules));
}

export const agentPromptCommand: CommandModule = {
  command: 'agent-prompt',
  describe:
    "Build a chunk agent's launch prompt from the plan (the diff path and its " +
    'byte range are welded in, not left to the caller to remember)',
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe:
          'Path to the plan report from fetch-pr / plan-diff / capture-local',
      })
      .option('chunk', {
        type: 'number',
        demandOption: true,
        describe: 'Which chunk id this agent owns',
      })
      .option('rules', {
        type: 'string',
        describe:
          'Path to the project rules file from `load-rules` (omit when the ' +
          'review has none)',
      }),
  handler: (argv) => {
    runAgentPrompt(argv as unknown as AgentPromptArgs);
  },
};
