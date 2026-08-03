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

import type { CommandModule } from 'yargs';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  transcriptDir,
  TranscriptsUnavailableError,
} from './lib/transcripts.js';

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

/** The usage-bearing assistant events of one JSONL transcript, floor-filtered. */
function usageEvents(file: string, floorMs: number): UsageEvent[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: UsageEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec['type'] !== 'assistant') continue;
    const usage = rec['usageMetadata'] as Record<string, unknown> | undefined;
    if (usage === undefined) continue;
    const ts = rec['timestamp'];
    if (typeof ts !== 'string') continue;
    const tsMs = Date.parse(ts);
    // The chat file spans the whole session, not the review: a `/review`
    // launched an hour into a working session would otherwise bill that hour's
    // conversation to the review. The plan's own mtime marks the review start
    // — the same floor `check-coverage` applies to transcripts.
    if (!Number.isFinite(tsMs) || tsMs < floorMs) continue;
    const n = (k: string): number => {
      const v = usage[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    };
    out.push({
      timestampMs: tsMs,
      timestamp: ts,
      input: n('promptTokenCount'),
      cached: n('cachedContentTokenCount'),
      output: n('candidatesTokenCount'),
      thoughts: n('thoughtsTokenCount'),
    });
  }
  return out;
}

/** A role label out of the transcript's launch prompt, else the fallback. */
function labelOf(file: string, fallback: string): string {
  let head = '';
  try {
    // The launch prompt is the first record; 64KB is far past any of them.
    head = readFileSync(file, 'utf8').slice(0, 65536);
  } catch {
    return fallback;
  }
  const role = /You are review agent `([^`]+)`/.exec(head);
  if (role) return `agent ${role[1]}`;
  const chunk = /reviewing chunk (\d+) of \d+/.exec(head);
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
  for (const e of events) {
    s.calls += 1;
    s.inputTokens += e.input;
    s.cachedTokens += e.cached;
    s.outputTokens += e.output;
    s.thoughtsTokens += e.thoughts;
    if (s.firstAt === null || e.timestamp < s.firstAt) s.firstAt = e.timestamp;
    if (s.lastAt === null || e.timestamp > s.lastAt) s.lastAt = e.timestamp;
  }
  return s;
}

/** 12_345_678 → "12.3M"; 45_600 → "46k"; 890 → "890". */
function human(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function computeLedger(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Ledger {
  const floorMs = statSync(planPath).mtimeMs;
  const dir = transcriptDir(env);
  const sessionId = env['QWEN_CODE_SESSION_ID']!.trim();
  const projectDir = env['QWEN_CODE_PROJECT_DIR']!.trim();

  const chatFile = join(projectDir, 'chats', `${sessionId}.jsonl`);
  const mainEvents = usageEvents(chatFile, floorMs);
  const main =
    mainEvents.length > 0 ? foldEvents('main', 'main loop', mainEvents) : null;

  const agents: StreamCost[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter(
      (f) => f.startsWith('agent-') && f.endsWith('.jsonl'),
    );
  } catch {
    // No subagent dir is a real state (a low-effort review runs no agents);
    // the ledger reports what exists.
  }
  for (const f of files) {
    const full = join(dir, f);
    const events = usageEvents(full, floorMs);
    if (events.length === 0) continue;
    const id = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    agents.push(foldEvents(id, labelOf(full, id), events));
  }
  agents.sort((a, b) => b.inputTokens - a.inputTokens);

  const all = [...(main ? [main] : []), ...agents];
  const totals = foldEvents('totals', 'totals', []);
  for (const s of all) {
    totals.calls += s.calls;
    totals.inputTokens += s.inputTokens;
    totals.cachedTokens += s.cachedTokens;
    totals.outputTokens += s.outputTokens;
    totals.thoughtsTokens += s.thoughtsTokens;
    if (
      s.firstAt !== null &&
      (totals.firstAt === null || s.firstAt < totals.firstAt)
    ) {
      totals.firstAt = s.firstAt;
    }
    if (
      s.lastAt !== null &&
      (totals.lastAt === null || s.lastAt > totals.lastAt)
    ) {
      totals.lastAt = s.lastAt;
    }
  }
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
    `Cost ledger: ${t.calls} model calls · ${human(t.inputTokens)} input ` +
      `(${cachedPct}% cached) · ${human(t.outputTokens + t.thoughtsTokens)} ` +
      `output (${human(t.thoughtsTokens)} thinking) · ` +
      `${Math.round(t.wallSeconds / 60)} min wall`,
  );
  if (ledger.main !== null) {
    const m = ledger.main;
    lines.push(
      `  main loop: ${m.calls} calls · ${human(m.inputTokens)} in · ` +
        `${human(m.outputTokens + m.thoughtsTokens)} out`,
    );
  }
  if (ledger.agents.length > 0) {
    lines.push(`  agents: ${ledger.agents.length}`);
    for (const a of ledger.agents.slice(0, 8)) {
      lines.push(
        `    ${a.label}: ${a.calls} calls · ${human(a.inputTokens)} in · ` +
          `${human(a.outputTokens + a.thoughtsTokens)} out`,
      );
    }
    if (ledger.agents.length > 8) {
      const rest = ledger.agents.slice(8);
      const restIn = rest.reduce((n, a) => n + a.inputTokens, 0);
      lines.push(
        `    …and ${rest.length} more agents · ${human(restIn)} in combined`,
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
        : `could not read the usage records: ${(err as Error).message}`;
    writeStderrLine(`cost-ledger unavailable — ${why}`);
    return;
  }
  if (args.out !== undefined && args.out.length > 0) {
    writeFileSync(args.out, JSON.stringify(ledger, null, 2));
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
