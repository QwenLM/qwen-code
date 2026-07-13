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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';

interface CheckCoverageArgs {
  plan: string;
  returns: string;
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
const WHIFF_CHARS = 40;

/**
 * The bare form, exactly.
 *
 * A length floor alone is crude — `No issues found — checked.` clears forty
 * characters and says nothing. This is the sentence the prompt explicitly
 * forbids, and it is what every whiffing agent in the dogfood run actually said.
 */
const BARE_RE = /^\s*no issues found[.!]?\s*$/i;

const AGENT_RE = /^===\s*AGENT:\s*(.+?)\s*===\s*$/;
const COVERED_RE = /^\s*Covered:\s*chunk\s+(\d+)\b/im;
const UNCOVERABLE_RE = /^\s*Uncoverable:\s*chunk\s+(\d+)\b/im;

interface AgentReturn {
  label: string;
  body: string;
}

/** Split the returns file into one entry per `=== AGENT: <label> ===` block. */
export function splitReturns(text: string): AgentReturn[] {
  const out: AgentReturn[] = [];
  let cur: AgentReturn | null = null;
  for (const line of text.split('\n')) {
    const m = AGENT_RE.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { label: m[1], body: '' };
      continue;
    }
    if (cur) cur.body += line + '\n';
  }
  if (cur) out.push(cur);
  return out;
}

export interface CoverageReport {
  plannedChunks: number[];
  coveredChunks: number[];
  uncoverableChunks: number[];
  /** Planned, and nobody receipted it. Nobody read these lines. */
  missingChunks: number[];
  /** Agents whose return carries no receipt and says nothing. */
  whiffedAgents: string[];
  agents: number;
  ok: boolean;
}

export function checkCoverage(
  plannedChunks: number[],
  returns: AgentReturn[],
): CoverageReport {
  const covered = new Set<number>();
  const uncoverable = new Set<number>();
  const whiffed: string[] = [];

  for (const r of returns) {
    const c = COVERED_RE.exec(r.body);
    const u = UNCOVERABLE_RE.exec(r.body);
    if (c) covered.add(Number(c[1]));
    if (u) uncoverable.add(Number(u[1]));

    // A return with no receipt has to earn its silence with evidence. The
    // whole-diff agents owe no receipt, so this is the only check they get.
    const body = r.body.trim();
    if (!c && !u && (body.length < WHIFF_CHARS || BARE_RE.test(body))) {
      whiffed.push(r.label);
    }
  }

  const missing = plannedChunks.filter(
    (id) => !covered.has(id) && !uncoverable.has(id),
  );

  return {
    plannedChunks,
    coveredChunks: [...covered].sort((a, b) => a - b),
    uncoverableChunks: [...uncoverable].sort((a, b) => a - b),
    missingChunks: missing,
    whiffedAgents: whiffed,
    agents: returns.length,
    // `uncoverable` is a disclosed gap, not a failure — it still forbids an
    // Approve downstream. Missing chunks and whiffed agents are the failure.
    ok: missing.length === 0 && whiffed.length === 0,
  };
}

function runCheckCoverage(args: CheckCoverageArgs): void {
  let plan: { chunks?: Array<{ id: number }> };
  try {
    plan = JSON.parse(readFileSync(args.plan, 'utf8'));
  } catch (err) {
    throw new Error(
      `Cannot read the chunk plan ${args.plan}: ${(err as Error).message}`,
    );
  }
  const planned = (plan.chunks ?? []).map((c) => c.id);

  let text: string;
  try {
    text = readFileSync(args.returns, 'utf8');
  } catch (err) {
    throw new Error(
      `Cannot read the agent returns ${args.returns}: ${(err as Error).message}`,
    );
  }

  const returns = splitReturns(text);
  if (returns.length === 0) {
    throw new Error(
      `No agent returns found in ${args.returns}. Each one must be preceded by ` +
        `a \`=== AGENT: <label> ===\` line, and its text copied verbatim — a ` +
        `summary of what an agent said cannot show whether it said anything.`,
    );
  }

  const report = checkCoverage(planned, returns);

  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');
  writeStdoutLine(`Wrote coverage report to ${args.out}`);

  writeStderrLine(
    `Coverage: ${report.coveredChunks.length}/${planned.length} chunks ` +
      `receipted by ${report.agents} agent return(s)` +
      (report.uncoverableChunks.length
        ? `, ${report.uncoverableChunks.length} uncoverable`
        : ''),
  );

  if (report.missingChunks.length > 0) {
    writeStderrLine(
      `ERROR: ${report.missingChunks.length} chunk(s) carry NO receipt — ` +
        `${report.missingChunks.join(', ')}. Nobody read those lines. Relaunch ` +
        `an agent for each before Step 4; do not aggregate findings over a diff ` +
        `that was not read, and do not certify what nobody looked at.`,
    );
  }
  if (report.whiffedAgents.length > 0) {
    writeStderrLine(
      `ERROR: ${report.whiffedAgents.length} agent(s) returned nothing ` +
        `substantive — ${report.whiffedAgents.join('; ')}. A return this short ` +
        `with no receipt is indistinguishable from an agent that did not run. ` +
        `Relaunch each ONCE; if it comes back bare again, record its dimension ` +
        `in \`unreviewedDimensions\`, which forbids an Approve.`,
    );
  }
  if (!report.ok) {
    writeStderrLine(
      'The review has not covered the diff. Fix that before Step 4.',
    );
    process.exitCode = 3;
  }
}

export const checkCoverageCommand: CommandModule = {
  command: 'check-coverage',
  describe:
    "Read the review agents' verbatim returns and report which chunks nobody covered (the Step 3 receipt check, as code)",
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe:
          'The chunk plan from fetch-pr / capture-local / plan-diff (its `chunks[]` is what must be covered)',
      })
      .option('returns', {
        type: 'string',
        demandOption: true,
        describe:
          "Every review agent's return, VERBATIM, each preceded by `=== AGENT: <label> ===`. Not a summary: a summary of an agent that said nothing says something.",
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
