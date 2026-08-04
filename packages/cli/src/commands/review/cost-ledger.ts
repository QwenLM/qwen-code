/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review cost-ledger`: what this review actually cost, from the
// harness's own usage records.
//
// The number exists because it kept having to be excavated. A maintainer's
// "0.21.3 was fine, 0.21.4 got slow" was settled only by replaying a whole
// review under a telemetry exporter and hand-aggregating half a million
// telemetry lines — hours of forensics for a question one printed table
// answers. The same excavation found the money: a small +93/-48 PR at high
// effort cost 523 model calls and 37.8M input tokens, 9.7M of them a repair
// round redelivering prompts the agents had already acted on. Nobody chose
// that spend; nobody could see it either.
//
// The data was on disk the whole time: every chat and subagent transcript
// event carries `usageMetadata` (prompt / candidates / thoughts / cached
// counts). This subcommand aggregates those records — the same records
// `check-coverage` trusts for delivery, read from the same
// environment-exported location — into per-stream totals. It is
// **informational**: a ledger that cannot be computed prints why and exits 0,
// because a review must never fail on its own accounting.
//
// A "model call" is an assistant record carrying `usageMetadata`; a turn
// whose provider returned no usage is invisible, so call counts are a floor,
// not an exact API-call tally.

import type { CommandModule } from 'yargs';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseLineTolerant } from '@qwen-code/qwen-code-core';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  transcriptPaths,
  listAgentTranscriptFiles,
  TranscriptsUnavailableError,
} from './lib/transcripts.js';
import { CHUNK_RE } from './lib/coverage.js';

interface CostLedgerArgs {
  plan: string;
  out?: string;
}

interface StreamCost {
  /** `main` for the orchestrator session, else the agent file's id. */
  id: string;
  /** Human label: the role parsed from the launch prompt when one is found. */
  label: string;
  calls: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  firstAt: string | null;
  lastAt: string | null;
}

interface Ledger {
  totals: Omit<StreamCost, 'id' | 'label'> & { wallSeconds: number };
  main: StreamCost | null;
  agents: StreamCost[];
}

interface UsageEvent {
  timestampMs: number;
  timestamp: string;
  input: number;
  cached: number;
  output: number;
  thoughts: number;
}

/** Text out of a record's message parts — the shape the harness writes. */
function textOfRecord(rec: Record<string, unknown>): string {
  const msg = rec['message'] as { parts?: unknown } | undefined;
  const parts = Array.isArray(msg?.parts) ? msg.parts : [];
  return parts
    .map((p) => (p as { text?: unknown }).text)
    .filter((t): t is string => typeof t === 'string')
    .join('');
}

/**
 * One read of a transcript: its usage-bearing assistant events, floor-filtered,
 * plus the launch prompt the label comes from.
 *
 * The launch prompt is the first `user` record's text — the same anchor
 * `parseTranscript` in lib/transcripts.ts uses — never a raw byte slice of the
 * file: a fork agent's transcript opens with an `agent_bootstrap` system
 * record carrying the entire inherited conversation, which can quote other
 * agents' identity lines and outgrow any fixed head window.
 *
 * Read failures throw; the caller decides what they mean — for the chat file,
 * "the ledger cannot be computed"; for one agent file, "that agent is lost".
 */
function readUsage(
  file: string,
  floorMs: number,
): { events: UsageEvent[]; launch: string } {
  const raw = readFileSync(file, 'utf8');
  const events: UsageEvent[] = [];
  let launch = '';
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    // parseLineTolerant recovers the `}{`-glued records an interrupted append
    // leaves behind — the documented corruption shape of these incrementally
    // flushed files — and drops non-object lines, which a bare JSON.parse
    // parses happily (`null`, `42`) only to trip the property reads below.
    for (const rec of parseLineTolerant<Record<string, unknown>>(line, file)) {
      if (launch === '' && rec['type'] === 'user') {
        launch = textOfRecord(rec);
      }
      if (rec['type'] !== 'assistant') continue;
      const usage = rec['usageMetadata'];
      if (usage === null || typeof usage !== 'object') continue;
      if (Array.isArray(usage)) continue;
      const u = usage as Record<string, unknown>;
      const ts = rec['timestamp'];
      if (typeof ts !== 'string') continue;
      const tsMs = Date.parse(ts);
      // The chat file spans the whole session, not the review: a `/review`
      // launched an hour into a working session would otherwise bill that hour's
      // conversation to the review. The plan's own mtime marks the review start
      // — the same floor `check-coverage` applies to transcripts.
      if (!Number.isFinite(tsMs) || tsMs < floorMs) continue;
      // ≥ 0, not merely finite: the main loop coerces broken-proxy usage
      // (negative or NaN counts) before recording, but the agent path records
      // raw provider usage — a negative count here would render >100% cached
      // shares and negative rows in the archived block.
      const n = (k: string): number => {
        const v = u[k];
        return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
      };
      const prompt = n('promptTokenCount');
      const total = n('totalTokenCount');
      events.push({
        timestampMs: tsMs,
        timestamp: ts,
        input: prompt,
        cached: n('cachedContentTokenCount'),
        // `total − prompt` is the output including thinking under BOTH usage
        // conventions — reasoning inside candidates, and thoughts disjoint
        // from them — the same derivation tokenEstimation uses. Candidates
        // alone is the fallback when the provider reported no total; it stays
        // correct for the providers this CLI converts, which clamp thoughts
        // inside candidates.
        output: total > prompt ? total - prompt : n('candidatesTokenCount'),
        thoughts: n('thoughtsTokenCount'),
      });
    }
  }
  return { events, launch };
}

/** A role label out of the launch prompt, else the fallback. */
function labelOf(launch: string, fallback: string): string {
  // The identity line `agent-prompt` emits, with the role in backticks. A
  // chunk agent's role is `chunk N of M`; prefixing it with "agent" would
  // read as a malformed role, so resolve it through the same regex coverage
  // uses. Distinguishers OUTSIDE the backticks matter too: a reverse-audit
  // chunk auditor is launched with the same `chunk N of M` identity as the
  // Step 3B territory finder, and only its brief path carries the stage and
  // the round — without it, five audit rounds fold into the finder's row and
  // the ledger reports one agent where six pipeline stages ran. A role
  // launch's round label sits after the backticks for the same reason.
  const auditChunk = /reverse-audit--chunk-(\d+)--round-(\d+)--[0-9a-f]/.exec(
    launch,
  );
  if (auditChunk) {
    return `audit chunk ${auditChunk[1]} (round ${auditChunk[2]})`;
  }
  const role = /You are review agent `([^`]+)`/.exec(launch);
  if (role) {
    // The round is read from the identity LINE, not the whole launch: the
    // folded findings below it can quote a budget disclosure's own
    // "(round N)" and mislabel an unrelated round.
    const nl = launch.indexOf('\n');
    const identity = nl === -1 ? launch : launch.slice(0, nl);
    const round = /\(round (\d+)\)/.exec(identity);
    const chunk = CHUNK_RE.exec(role[1]);
    if (chunk) return `chunk ${chunk[1]}`;
    if (round) {
      // Shards of one verify round carry the same label and fold; distinct
      // rounds — verify and reverse-audit alike — are distinct rows.
      return `agent ${role[1]} (round ${round[1]})`;
    }
    // An invariant role launches once PER heavy file. The role alone would
    // fold those parallel runs into one (×N) row — the marker reserved for
    // relaunches — and lose the per-file breakdown. The launch prompt names
    // the owned file right after the identity; that is the distinguisher.
    const file = /Your file: `([^`]+)`/.exec(launch);
    if (file) return `agent ${role[1]} (${basename(file[1])})`;
    return `agent ${role[1]}`;
  }
  // No identity line (an older harness): the chunk the prompt text names,
  // else the file's own id.
  const chunk = CHUNK_RE.exec(launch);
  if (chunk) return `chunk ${chunk[1]}`;
  return fallback;
}

function foldEvents(
  id: string,
  label: string,
  events: UsageEvent[],
): StreamCost {
  const s: StreamCost = {
    id,
    label,
    calls: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    thoughtsTokens: 0,
    firstAt: null,
    lastAt: null,
  };
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    s.calls += 1;
    s.inputTokens += e.input;
    s.cachedTokens += e.cached;
    s.outputTokens += e.output;
    s.thoughtsTokens += e.thoughts;
    if (e.timestampMs < firstMs) {
      firstMs = e.timestampMs;
      s.firstAt = e.timestamp;
    }
    if (e.timestampMs > lastMs) {
      lastMs = e.timestampMs;
      s.lastAt = e.timestamp;
    }
  }
  return s;
}

/** 12_345_678 → "12.3M"; 45_600 → "46k"; 890 → "890". */
function human(n: number): string {
  // 999_500 rounds to 1000k; from there up, render in M so it reads "1.0M".
  // The same boundary at the B tier keeps 1.5e9 from reading "1500.0M".
  if (n >= 999_500_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** "1 call", "2 calls" — the rendered block is archived verbatim. */
const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The plan's mtime is the billing floor. Validate the file IS a Step 1 plan
 * report before trusting that mtime: a wrong-but-existing file (the findings
 * JSON, the report written minutes earlier) would move the floor silently in
 * either direction. The shape checked is the pair every Step 1 report carries
 * — `diffLines` and `chunks` — not `check-coverage`'s stricter contract: a
 * degraded capture (unresolvable merge base, the tiling fallback) writes
 * `diffPathAbsolute: null` with `chunks: []`, and that report's mtime is
 * still exactly the floor this ledger needs.
 */
function planFloorMs(planPath: string): number {
  let raw: string;
  let floorMs: number;
  try {
    raw = readFileSync(planPath, 'utf8');
    floorMs = statSync(planPath).mtimeMs;
  } catch (err) {
    throw new Error(
      `could not read the plan report ${planPath}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const plan =
    parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  if (
    typeof plan?.['diffLines'] !== 'number' ||
    !Array.isArray(plan?.['chunks'])
  ) {
    throw new Error(`not a review plan report: ${planPath}`);
  }
  return floorMs;
}

export function computeLedger(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Ledger {
  const floorMs = planFloorMs(planPath);
  const { projectDir, sessionId, dir } = transcriptPaths(env);

  const chatFile = join(projectDir, 'chats', `${sessionId}.jsonl`);
  let mainEvents: UsageEvent[];
  try {
    mainEvents = readUsage(chatFile, floorMs).events;
  } catch (err) {
    // The plan's existence proves the main loop ran: a missing or unreadable
    // chat file is an infrastructure fact (chat recording off, or a fault),
    // not a verdict that the loop made no calls. Agents-only totals would
    // read as the review's whole cost, so say the ledger cannot be computed.
    throw new Error(
      `could not read the chat transcript ${chatFile}: ` +
        `${(err as Error).message}`,
    );
  }
  const main =
    mainEvents.length > 0 ? foldEvents('main', 'main loop', mainEvents) : null;

  let files: string[];
  try {
    files = listAgentTranscriptFiles(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No subagent dir is a real state (a low-effort review runs no agents);
      // the ledger reports what exists.
      files = [];
    } else {
      // EACCES/EIO/ENOTDIR are not "no agents": main-loop-only totals would
      // read as the complete ledger.
      throw new Error(
        `could not list the subagent transcripts at ${dir}: ` +
          `${(err as Error).message}`,
      );
    }
  }

  const agents: StreamCost[] = [];
  const agentEvents: UsageEvent[] = [];
  for (const f of files) {
    const full = join(dir, f);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      continue; // Gone between listing and stat.
    }
    // The transcript dir is session-scoped and never pruned: files from
    // earlier reviews this session predate the floor, and a file whose last
    // write predates it cannot hold an above-floor record — the same
    // membership test `readTranscripts` applies. Skip it without opening.
    if (mtimeMs < floorMs) continue;
    let read: { events: UsageEvent[]; launch: string };
    try {
      read = readUsage(full, floorMs);
    } catch {
      continue; // This agent's record is lost; the rest still count.
    }
    if (read.events.length === 0) continue;
    const id = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    agents.push(foldEvents(id, labelOf(read.launch, id), read.events));
    agentEvents.push(...read.events);
  }
  agents.sort((a, b) => b.inputTokens - a.inputTokens);

  // A present-but-empty chat file is not a lighter version of a missing one.
  // The recorder pre-creates the file and degrades permanently if its first
  // append fails, so "exists, yet no above-floor records while agents ran" is
  // the same infrastructure fact as "unreadable" — and rendering agents-only
  // totals under the `Cost ledger:` headline is exactly what the catch above
  // refuses to do.
  if (mainEvents.length === 0 && agentEvents.length > 0) {
    throw new Error(
      `could not read the chat transcript ${chatFile}: no main-loop usage ` +
        'records at or after the plan, while agents ran',
    );
  }

  // The same events the per-stream rows fold, folded once more — one
  // accumulator, so a new usage counter cannot land in the rows and miss the
  // headline.
  const totals = foldEvents('totals', 'totals', [
    ...mainEvents,
    ...agentEvents,
  ]);
  const wallSeconds =
    totals.firstAt !== null && totals.lastAt !== null
      ? Math.max(
          0,
          Math.round(
            (Date.parse(totals.lastAt) - Date.parse(totals.firstAt)) / 1000,
          ),
        )
      : 0;

  const { id: _i, label: _l, ...totalsRest } = totals;
  return { totals: { ...totalsRest, wallSeconds }, main, agents };
}

/** The printed block: one summary line, the main loop, the top consumers. */
export function renderLedger(ledger: Ledger): string {
  const t = ledger.totals;
  const cachedPct =
    t.inputTokens > 0 ? Math.round((t.cachedTokens / t.inputTokens) * 100) : 0;
  const lines: string[] = [];
  lines.push(
    `Cost ledger: ${plural(t.calls, 'model call')} · ` +
      `${human(t.inputTokens)} input (${cachedPct}% cached) · ` +
      `${human(t.outputTokens)} output (${human(t.thoughtsTokens)} thinking) · ` +
      `${Math.round(t.wallSeconds / 60)} min wall`,
  );
  if (ledger.main !== null) {
    const m = ledger.main;
    lines.push(
      `  main loop: ${plural(m.calls, 'call')} · ${human(m.inputTokens)} in · ` +
        `${human(m.outputTokens)} out`,
    );
  }
  if (ledger.agents.length > 0) {
    // Equal labels fold into one row marked (×N): a relaunched agent keeps
    // its label, and verify shards deliberately share one — the marker reads
    // "N runs under this label", and the repair round this ledger exists to
    // surface becomes visible, not merely present. Rounds and audit chunks
    // do NOT share labels (labelOf carries their stage and round), so a
    // five-round audit is five rows, not a phantom ×5 relaunch.
    const rows: Array<{
      label: string;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      count: number;
    }> = [];
    for (const a of ledger.agents) {
      const row = rows.find((r) => r.label === a.label);
      if (row) {
        row.calls += a.calls;
        row.inputTokens += a.inputTokens;
        row.outputTokens += a.outputTokens;
        row.count += 1;
      } else {
        rows.push({
          label: a.label,
          calls: a.calls,
          inputTokens: a.inputTokens,
          outputTokens: a.outputTokens,
          count: 1,
        });
      }
    }
    // Rank by the folded total, not the first member's share: a doubled run
    // must not be truncated away by the half that sorted lower.
    rows.sort((a, b) => b.inputTokens - a.inputTokens);
    lines.push(`  agent runs: ${ledger.agents.length}`);
    for (const r of rows.slice(0, 8)) {
      const label = r.count > 1 ? `${r.label} (×${r.count})` : r.label;
      lines.push(
        `    ${label}: ${plural(r.calls, 'call')} · ` +
          `${human(r.inputTokens)} in · ${human(r.outputTokens)} out`,
      );
    }
    if (rows.length > 8) {
      const rest = rows.slice(8);
      const restIn = rest.reduce((n, r) => n + r.inputTokens, 0);
      const restAgents = rest.reduce((n, r) => n + r.count, 0);
      lines.push(
        `    …and ${plural(restAgents, 'more agent')} · ` +
          `${human(restIn)} in combined`,
      );
    }
  }
  return lines.join('\n');
}

function runCostLedger(args: CostLedgerArgs): void {
  let ledger: Ledger;
  try {
    ledger = computeLedger(args.plan, process.env);
  } catch (err) {
    // Informational, always: a review must never fail on its own accounting.
    const why =
      err instanceof TranscriptsUnavailableError
        ? err.message
        : (err as Error).message;
    writeStderrLine(`cost-ledger unavailable — ${why}`);
    return;
  }
  if (args.out !== undefined && args.out.length > 0) {
    // A failed archive write degrades to a warning: the ledger was computed,
    // and the exit code must stay 0 either way.
    try {
      mkdirSync(dirname(resolve(args.out)), { recursive: true });
      writeFileSync(args.out, JSON.stringify(ledger, null, 2));
    } catch (err) {
      writeStderrLine(
        `cost-ledger: could not write ${args.out} — ${(err as Error).message}`,
      );
    }
  }
  writeStdoutLine(renderLedger(ledger));
}

export const costLedgerCommand: CommandModule = {
  command: 'cost-ledger',
  describe:
    "Aggregate this review's model-call cost from the harness's usage records",
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe:
          'The plan report from Step 1 — its mtime marks the review start',
      })
      .option('out', {
        type: 'string',
        describe: 'Also write the full ledger as JSON to this path',
      }),
  handler: (args) => {
    runCostLedger(args as unknown as CostLedgerArgs);
  },
};
