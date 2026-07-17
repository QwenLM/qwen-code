/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review check-coverage`: read what the review agents actually returned,
// and say which parts of the diff nobody looked at.
//
// This exists because the review approved a pull request that no agent read.
//
// Dogfooded against its own PR, the orchestrator launched 25 agents over an
// 18-chunk, 4 925-line diff. Twenty-two of them came back in under two seconds
// having made **zero tool calls**, returning about nineteen tokens each — the
// length of the words "No issues found." They had not opened the diff. The three
// that did work were the three whose jobs do not require reading it: the one that
// runs the build, the one that queries the issue tracker, the one that greps for
// tests.
//
// The prompt already had three defences against this, and all three are prose:
// every chunk agent "MUST" end with a `Covered:` receipt; the orchestrator "MUST"
// verify that every chunk carries exactly one; an agent returning "near-instantly
// with almost no output did not do its job". The run performed none of them,
// reported zero findings, wrote "Not reviewed: none", and filed an Approve.
//
// A rule a model is asked to remember is a rule that will eventually not be
// remembered — this file's whole PR is a list of proofs of that. So the check
// moves to where it cannot be forgotten: the agents' returns are handed to a
// subcommand, verbatim, and the subcommand decides what was covered. The
// orchestrator can still lie — it copies the returns — but fabricating eighteen
// receipts is an act, and every failure this skill has actually suffered has been
// an omission.

import type { CommandModule } from 'yargs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  coverageFromTranscripts,
  TranscriptsUnavailableError,
} from './lib/coverage.js';
import { promptRecordDir } from './lib/prompt-record.js';

interface CheckCoverageArgs {
  plan: string;
  out: string;
}

/**
 * The floor a return has to clear to count as evidence of a walk.
 *
 * The whiffing agents returned ~19 tokens — "No issues found." is sixteen
 * characters. The prompt requires a no-finding return to name what it examined,
 * and its own example (`No issues found — traced all 7 changed exports to their
 * call sites; every caller compiles against the new signature`) runs to 108. So
 * the floor sits well under that: a check strict enough to reject the prompt's
 * model answer is a check that fails closed on good work, and the cost of that
 * is a relaunch of an agent that had already done its job.
 */
function runCheckCoverage(args: CheckCoverageArgs): void {
  let report;
  try {
    report = coverageFromTranscripts(args.plan);
  } catch (err) {
    if (err instanceof TranscriptsUnavailableError) {
      // Infrastructure, not a verdict. A read-only HOME or a sandbox leaves no
      // transcripts, and reading that as "every agent idled" would block every
      // review with nothing to act on. Say what is actually wrong, and still
      // refuse — a run that cannot show what it read has not shown it read
      // anything — but refuse for the right reason.
      writeStderrLine(
        `ERROR: ${(err as Error).message}\n` +
          'This is an environment problem, not a finding about the agents. ' +
          'Coverage cannot be shown, so the review must not certify the diff.',
      );
      process.exitCode = 3;
      return;
    }
    throw err;
  }

  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(args.out, JSON.stringify(report, null, 2));
  writeStdoutLine(`Wrote coverage report to ${args.out}`);

  const totalChunks =
    report.coveredChunks.length +
    report.missingChunks.length +
    report.uncoverableChunks.length;
  const worked =
    report.agents - report.blindAgents.length - report.idleAgents.length;
  writeStderrLine(
    `Coverage: ${report.coveredChunks.length}/${totalChunks} chunk(s) reviewed. ` +
      // "did work", not "opened the diff": `worked` includes the whole-diff agents
      // whose job needs no diff (Build & Test, Issue Fidelity), and claiming they
      // opened it would be the same kind of overstatement this report exists to
      // stop. What is asserted is a tool call, which is all the transcript shows.
      `${report.agents} agent(s) ran; ${worked} did work` +
      (report.blindAgents.length
        ? `, ${report.blindAgents.length} were launched blind`
        : '') +
      (report.idleAgents.length
        ? `, ${report.idleAgents.length} made no tool call`
        : ''),
  );

  // The defect that actually happened, named as itself.
  if (report.blindAgents.length > 0) {
    writeStderrLine(
      `ERROR: ${report.blindAgents.length} agent(s) were launched with a prompt ` +
        `that never named the diff file — ${report.blindAgents.join(', ')}. They ` +
        `could not have read the diff, whatever they returned. Do NOT relaunch ` +
        `them as they are: a second blind agent reads no more than the first. ` +
        `Build each prompt with \`"\${QWEN_CODE_CLI:-qwen}" review agent-prompt ` +
        `--plan <plan> --chunk <id>\` and pass it verbatim.`,
    );
  }
  // The prompt was built in code and then edited on the way to the agent. Nothing
  // else in the run can see this: a paraphrase keeps the diff path, so every other
  // check passes.
  if (report.rewrittenPrompts.length > 0) {
    writeStderrLine(
      `ERROR: ${report.rewrittenPrompts.length} agent(s) were not launched with ` +
        `the prompt this CLI built for them — ${report.rewrittenPrompts.join('; ')}. ` +
        `\`agent-prompt\` prints a prompt to be passed VERBATIM; a summary of it is ` +
        `not it. The last run to paraphrase one dropped the rule against reciting a ` +
        `stock sentence and replaced the project's review rules with three sentences ` +
        `of its own. Re-run \`"\${QWEN_CODE_CLI:-qwen}" review agent-prompt\` and ` +
        `pass its output ` +
        `unedited — copy it, do not retype it.`,
    );
  }
  // The one failure no other check in this file can see. Every other question is
  // asked of an agent whose transcript exists; a brief that never arrived leaves
  // nothing to ask it of.
  if (report.missingRoles.length > 0) {
    writeStderrLine(
      // No count: when no role was briefed at all, `missingRoles` collapses to one
      // line covering the whole roster, and a leading "1" would undercount it by the
      // size of the review.
      `ERROR: required briefs never reached their agents — ` +
        `${report.missingRoles.join('; ')}. The roster comes from the ` +
        `plan, not from anything this run wrote. Writing the launch yourself does ` +
        `not substitute: the agent runs and may even find something, but the ` +
        `severity bar, the finding format and this project's rules live in the ` +
        `brief it was never given, and a dimension reviewed without them cannot ` +
        `be certified clean. Build every required prompt in one call — ` +
        `\`"\${QWEN_CODE_CLI:-qwen}" review agent-prompt --plan <plan> --roster\` ` +
        // No "the label above names the role" here: when no role was briefed at
        // all, the report collapses to one line that names none of them.
        `— and launch one agent per block it prints, verbatim. To rebuild a ` +
        `single one: \`--role <n>\` (a per-file role takes \`--file <path>\`), ` +
        `or \`--chunk <id>\` for a chunk agent.\n` +
        // Where it looked, because "the builder never ran" and "the builder ran
        // against a different --plan" are indistinguishable from a missing file and
        // are fixed differently. The record dir hangs off the plan path as given, so
        // a relative --plan resolves against the caller's cwd — and Steps 2-6 are
        // run from inside the worktree. Printing the directory turns a silent
        // disagreement about where the records live into one a reader can see.
        `Looked for them in: ${promptRecordDir(args.plan)}`,
    );
  }
  if (report.unreadBriefs.length > 0) {
    writeStderrLine(
      `ERROR: ${report.unreadBriefs.length} agent(s) never opened their brief — ` +
        `${report.unreadBriefs.join('; ')}. The launch prompt points at the brief ` +
        `instead of containing it, so an agent that did not read it reviewed with ` +
        `no dimension, no severity definitions and no project rules. Relaunch each ` +
        `once, with the prompt \`agent-prompt\` printed.`,
    );
  }
  if (report.unopenedAgents.length > 0) {
    writeStderrLine(
      `ERROR: ${report.unopenedAgents.length} agent(s) were pointed at diff lines ` +
        `and never opened the diff — ${report.unopenedAgents.join(', ')}. They made ` +
        `tool calls, so they are not idle; they simply worked on something else. ` +
        `Reviewing the post-change source instead of the diff cannot see a deletion ` +
        `at all. Relaunch each once.`,
    );
  }
  if (report.missingChunks.length > 0) {
    writeStderrLine(
      'NOTE: a chunk counts as read when an agent was pointed at its lines AND ' +
        'the harness recorded that agent opening the diff. An agent handed the ' +
        'diff with no line ranges covers nothing. Build every whole-diff ' +
        'agent\'s prompt with `"${QWEN_CODE_CLI:-qwen}" review agent-prompt ' +
        '--plan <plan> --whole-diff` and paste it verbatim ahead of its brief.',
    );
  }
  if (report.idleAgents.length > 0) {
    writeStderrLine(
      `ERROR: ${report.idleAgents.length} agent(s) made no tool call — ` +
        `${report.idleAgents.join(', ')}. They read nothing. Their prose is not ` +
        `evidence: of 129 real transcripts, every single one of the 80 agents ` +
        `that made no call still returned confident, specific text.`,
    );
  }
  if (report.uncoverableChunks.length > 0) {
    writeStderrLine(
      `ERROR: ${report.uncoverableChunks.length} chunk(s) were declared ` +
        `uncoverable — ${report.uncoverableChunks.join(', ')}. A diff with a ` +
        `line no read can reach was not reviewed; the verdict may not approve on ` +
        `its strength. Report them to the user as an unreviewed gap.`,
    );
  }
  if (report.missingChunks.length > 0) {
    writeStderrLine(
      `ERROR: ${report.missingChunks.length} chunk(s) were not reviewed — ` +
        `${report.missingChunks.join(', ')}. Nobody read those lines. Do not ` +
        `aggregate findings over a diff that was not read.`,
    );
  }

  if (!report.ok) {
    process.exitCode = 3;
  }
}

export const checkCoverageCommand: CommandModule = {
  command: 'check-coverage',
  describe:
    "Prove the diff was read, from the harness's own per-agent transcripts " +
    '(not from any file the caller writes)',
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe: 'Path to the plan report from Step 1',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Output JSON path (will be overwritten)',
      }),
  handler: (argv) => {
    runCheckCoverage(argv as unknown as CheckCoverageArgs);
  },
};
