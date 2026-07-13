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
  topology: 'territory' | 'dimension';
  expect?: string;
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
const OWN_CHUNK_RE = /\bchunk\s+(\d+)\b/i;

/**
 * The chunk this agent was assigned, from its label — or null for a whole-diff
 * agent, which owns no territory and may receipt nothing.
 */
function ownChunk(label: string): number | null {
  const m = OWN_CHUNK_RE.exec(label);
  return m ? Number(m[1]) : null;
}

/** The receipt lines, removed — what is left is the review, if there was one. */
function stripReceipts(body: string): string {
  return body
    .split('\n')
    .filter((l) => !/^\s*(Covered|Uncoverable):/i.test(l))
    .join('\n')
    .trim();
}
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
      // The label is a filename's cousin: it is copied from a prompt the diff
      // helped write, and it is printed to a terminal. Bound it and strip the
      // control characters, or a `=== AGENT: <ESC>[2K ===` line sitting inside
      // the diff under review — this file is in that diff — forges a return and
      // drives the reader's terminal.
      cur = { label: sanitiseLabel(m[1]), body: '' };
      continue;
    }
    if (cur) cur.body += line + '\n';
  }
  if (cur) out.push(cur);
  return out;
}

/** A label safe to put on a terminal, and short enough to read. */
function sanitiseLabel(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const CONTROL = /[\u0000-\u001f\u007f]/g;
  const clean = raw.replace(CONTROL, '?').slice(0, 80);
  return clean.trim() || '(unnamed agent)';
}

export interface CoverageReport {
  plannedChunks: number[];
  coveredChunks: number[];
  uncoverableChunks: number[];
  /** Planned, and nobody receipted it. Nobody read these lines. */
  missingChunks: number[];
  /** Agents whose return carries no receipt and says nothing. */
  whiffedAgents: string[];
  /** Agents the caller said to expect, whose return never arrived at all. */
  missingAgents: string[];
  topology: 'territory' | 'dimension';
  agents: number;
  ok: boolean;
}

export function checkCoverage(
  plannedChunks: number[],
  returns: AgentReturn[],
  opts: { topology: 'territory' | 'dimension'; expected?: string[] } = {
    topology: 'territory',
  },
): CoverageReport {
  // Receipts are a **territory** idea. In the dimension fan-out every agent
  // walks the whole chunk plan, so "exactly one receipt per chunk" would demand
  // either none or one per diff-reading agent — and the prompt says so outright:
  // "Step 3A has no receipts, and must not."
  //
  // The first cut of this command demanded them anyway, which would have blocked
  // **every small review** at Step 4 with eighteen chunks it believed nobody had
  // read. Under the dimension fan-out the coverage question is a different one:
  // did each agent do a walk? That is the substantive-return check, and it is
  // the only one that applies.
  const territory = opts.topology === 'territory';
  const covered = new Set<number>();
  const uncoverable = new Set<number>();
  const whiffed: string[] = [];

  // Only a label the caller said to expect can create coverage. `splitReturns`
  // starts a new record at any `=== AGENT: … ===` line, and one of those can sit
  // inside an agent's verbatim body — the diff under review contains this very
  // file, whose tests contain that header. Without the roster a diff-induced
  // quote forges an expected agent and a matching receipt. An empty roster (the
  // caller passed none) trusts every record, as before — the roster is the
  // opt-in defence, and `--expect` is already how a launched-agent list arrives.
  const roster =
    opts.expected && opts.expected.length > 0
      ? new Set(opts.expected.map((l) => l.toLowerCase().trim()))
      : null;

  for (const r of returns) {
    const body = r.body.trim();
    const known = roster === null || roster.has(r.label.toLowerCase().trim());

    // A return with no receipt has to earn its silence with evidence — and so
    // does one *with* a receipt. The first cut only ran this check when no
    // receipt was present, so a chunk agent that emitted `Covered: chunk 3` and
    // then "No issues found." cleared coverage having read nothing. The receipt
    // says which lines it was given; only the body says whether it looked.
    const substantive =
      body.length >= WHIFF_CHARS && !BARE_RE.test(stripReceipts(body));

    // A receipt is a claim about the agent's **own** territory. Parsed loose, a
    // chunk-1 agent could receipt chunk 2 — or quote a receipt out of the diff it
    // is reviewing, since the diff is untrusted text and this file is in it. The
    // label carries the assignment (`chunk 7`), so the receipt has to agree with
    // it, and a whole-diff agent (no chunk in its label) cannot receipt anything.
    const own = ownChunk(r.label);
    const c = COVERED_RE.exec(body);
    const u = UNCOVERABLE_RE.exec(body);
    // A record whose label is not on the roster is a forgery from inside another
    // agent's body; it cannot receipt anything.
    if (own !== null && known) {
      if (c && Number(c[1]) === own) covered.add(own);
      if (u && Number(u[1]) === own) uncoverable.add(own);
    }

    // A known agent that said nothing whiffed. An unknown label is not a whiff —
    // it is not a real agent — so it neither covers nor counts.
    if (known && !substantive) whiffed.push(r.label);
  }

  const missing = territory
    ? plannedChunks.filter((id) => !covered.has(id) && !uncoverable.has(id))
    : [];

  // An agent that was never launched leaves no return, and a checker that only
  // sees the returns that turned up cannot miss what is not there. With every
  // chunk receipted and the Security agent simply never started, the report was
  // `ok: true` and the review could approve — the lens nobody ran was invisible.
  const seen = new Set(returns.map((r) => r.label.toLowerCase().trim()));
  const missingAgents = (opts.expected ?? []).filter(
    (label) => !seen.has(label.toLowerCase().trim()),
  );

  return {
    plannedChunks,
    coveredChunks: [...covered].sort((a, b) => a - b),
    uncoverableChunks: [...uncoverable].sort((a, b) => a - b),
    missingChunks: missing,
    whiffedAgents: whiffed,
    missingAgents,
    topology: opts.topology,
    agents: returns.length,
    // `uncoverable` is a disclosed gap, not a failure — it still forbids an
    // Approve downstream (compose-review caps on it). A chunk nobody receipted,
    // an agent that said nothing, and an agent that never ran are failures.
    ok:
      missing.length === 0 &&
      whiffed.length === 0 &&
      missingAgents.length === 0,
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
  // `{}` parses, and a zero-chunk plan is a review with nothing to cover: point
  // this at the wrong artifact and the command exits 0 over a diff it never saw.
  if (!Array.isArray(plan.chunks) || plan.chunks.length === 0) {
    throw new Error(
      `${args.plan} carries no \`chunks[]\`. That is not a chunk plan — pass the ` +
        `report from fetch-pr / capture-local / plan-diff for THIS review. A ` +
        `plan with no chunks would let the check pass over a diff nobody saw.`,
    );
  }
  const planned = plan.chunks.map((c) => c.id);
  if (planned.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error(`${args.plan} has a chunk with no positive integer id.`);
  }
  if (new Set(planned).size !== planned.length) {
    throw new Error(`${args.plan} has duplicate chunk ids.`);
  }

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

  const expected = (args.expect ?? '')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
  const report = checkCoverage(planned, returns, {
    topology: args.topology,
    expected,
  });

  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');
  writeStdoutLine(`Wrote coverage report to ${args.out}`);

  // Branch the headline by topology: the dimension fan-out has no receipts, so
  // "0/N chunks receipted" on a clean dimension run reads as a failure it is not.
  writeStderrLine(
    report.topology === 'dimension'
      ? `Coverage: ${report.agents} dimension agent return(s), no per-chunk ` +
          `receipts (every agent walks the whole plan)`
      : `Coverage: ${report.coveredChunks.length}/${planned.length} chunks ` +
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
  if (report.missingAgents.length > 0) {
    writeStderrLine(
      `ERROR: ${report.missingAgents.length} expected agent(s) never ` +
        `returned — ${report.missingAgents.join(', ')}. A lens nobody ran is ` +
        `not a lens that found nothing. Launch each before Step 4.`,
    );
  }
  if (report.whiffedAgents.length > 0) {
    writeStderrLine(
      `ERROR: ${report.whiffedAgents.length} agent(s) returned nothing ` +
        `substantive — ${report.whiffedAgents.join('; ')}. A return this short ` +
        `is indistinguishable from an agent that did not run (a receipt says ` +
        `which lines it was handed, not that it looked at them). ` +
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
      })
      .option('topology', {
        type: 'string',
        choices: ['territory', 'dimension'] as const,
        default: 'territory' as const,
        describe:
          'territory (Step 3B: one receipt per chunk) or dimension (Step 3A: no receipts, every agent walks the whole plan)',
      })
      .option('expect', {
        type: 'string',
        describe:
          'Comma-separated labels of every agent launched, so an agent that never returned is caught',
      }),
  handler: (argv) => {
    runCheckCoverage(argv as unknown as CheckCoverageArgs);
  },
};
