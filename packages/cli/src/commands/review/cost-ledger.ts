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
import { dirname, join, resolve } from 'node:path';
import { parseLineTolerant } from '@qwen-code/qwen-code-core/utils/jsonl-utils.js';
import {
  writeStdoutLineSafe,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';
import {
  transcriptPaths,
  listAgentTranscriptFiles,
  priorSessionDirs,
  TranscriptsUnavailableError,
  textOf,
} from './lib/transcripts.js';
import { labelFromIdentityLine } from './lib/agent-identity.js';
import { currentSessionEntry, priorSessionEntries } from './lib/run-ledger.js';

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
  /**
   * Never null: `computeLedger` throws before folding when the current
   * session's chat holds no above-floor record, so a ledger that exists
   * always carries its main loop.
   */
  main: StreamCost;
  agents: StreamCost[];
  /**
   * How many EARLIER sessions of this run (a resumed review) contributed
   * streams. Zero on a run that never resumed; the field then reads as "this
   * ledger is one session's". The interrupted attempt's cost is part of the
   * review's cost — a resume that hid it would report a review as cheaper
   * than it was.
   */
  priorSessions: number;
  /**
   * Streams that exist but could not be read (a stat, read or parse failure).
   * A silent skip would present a lower total as a complete one.
   */
  missingStreams: number;
}

interface UsageEvent {
  timestampMs: number;
  timestamp: string;
  input: number;
  cached: number;
  output: number;
  thoughts: number;
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
  ceilingMs?: number,
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
        launch = textOf(rec);
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
      // A prior session's window closes when the NEXT attempt began: the old
      // CLI session may have gone on serving unrelated turns after this
      // review was interrupted, and billing those to the review is the exact
      // mirror of the omission folding prior cost exists to fix.
      if (ceilingMs !== undefined && tsMs >= ceilingMs) continue;
      // Finite ≥ 0, else null: the main loop coerces broken-proxy usage
      // (negative or NaN counts) before recording, but the agent path records
      // raw provider usage, and each consumer below picks its own fallback
      // for a count that did not survive the provider.
      const rawCount = (k: string): number | null => {
        const v = u[k];
        return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
      };
      const rawPrompt = rawCount('promptTokenCount');
      const rawTotal = rawCount('totalTokenCount');
      const prompt = rawPrompt ?? 0;
      const candidates = rawCount('candidatesTokenCount') ?? 0;
      events.push({
        timestampMs: tsMs,
        timestamp: ts,
        input: prompt,
        // Cached is part of the prompt it is reported with; a broken proxy
        // can report the pair inverted, and the inversion would otherwise
        // land in BOTH the rendered share and the archived --out JSON.
        cached: Math.min(rawCount('cachedContentTokenCount') ?? 0, prompt),
        // `total − prompt` is the output including thinking under BOTH usage
        // conventions — reasoning inside candidates, and thoughts disjoint
        // from them — the same derivation tokenEstimation uses. Candidates
        // alone is the fallback when the provider reported no total; it stays
        // correct for the providers this CLI converts, which clamp thoughts
        // inside candidates. Derive it only when BOTH operands survived the
        // provider intact: a mixed-sign record coerces prompt to 0 while
        // keeping a positive total, and the subtraction would bill the
        // call's whole total as output.
        output:
          rawPrompt !== null && rawTotal !== null && rawTotal > rawPrompt
            ? rawTotal - rawPrompt
            : candidates,
        thoughts: rawCount('thoughtsTokenCount') ?? 0,
      });
    }
  }
  return { events, launch };
}

/**
 * An auditor's own brief line, exactly as `buildRoleLaunchPrompt` prints it.
 * A bare `reverse-audit--chunk-N--round-M--<hex>` path mentioned anywhere is
 * NOT this — quoted mentions must never be credited. The findings section
 * cannot inject one: since #8597 it is a pointer to a `.findings.md` file,
 * which this regex's `.brief.md` suffix cannot match, and the list itself no
 * longer rides the launch prompt.
 */
const AUDIT_BRIEF_RE =
  /read_file\(file_path="[^"]*reverse-audit--chunk-(\d+)--round-(\d+)--[0-9a-f][^"]*\.brief\.md"\)/g;

/** A role label out of the launch prompt, else the fallback. */
function labelOf(launch: string, fallback: string): string {
  // Every identity-based parse stays on the identity LINE, and nothing runs
  // at all without one at the head. The text below it — the findings section,
  // the builder's own prose — can quote budget disclosures' "(round N)",
  // other agents' `Your file:` lines, ledger rows, and `You are review agent`
  // lines — a whole-launch match would hand the quoted label to the agent
  // carrying the quote. A prompt with no identity line is an older harness's,
  // or an agent this review never launched (the session's transcript dir also
  // holds nested subagents): its free text can name anything, so keep the one
  // label it owns — the file id.
  const nl = launch.indexOf('\n');
  const identity = nl === -1 ? launch : launch.slice(0, nl);
  const parsed = labelFromIdentityLine(identity);
  if (parsed === null) return fallback;
  // A reverse-audit chunk auditor shares its launch shape with the territory
  // finder; only its brief path carries the stage and the round — without
  // it, five audit rounds fold into one row and the ledger reports one agent
  // where six pipeline stages ran. Match the agent's OWN brief line, never a
  // quoted mention: the findings section sits ABOVE the agent's own brief
  // line (foldFindings puts it there), so the last brief-shaped read_file in
  // the launch is the agent's own.
  let auditChunk: RegExpExecArray | null = null;
  for (const m of launch.matchAll(AUDIT_BRIEF_RE)) auditChunk = m;
  if (auditChunk) {
    return `audit chunk ${auditChunk[1]} (round ${auditChunk[2]})`;
  }
  // The chunk / round / owned-file grammar lives in the shared parser
  // (agent-identity.ts), alongside coverage's disclosure labels — one format,
  // one parser, so the two readers cannot drift apart again.
  return parsed;
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

/** The first and last moment a set of usage events covers. */
function spanOf(events: UsageEvent[]): { firstMs: number; lastMs: number } {
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    if (e.timestampMs < firstMs) firstMs = e.timestampMs;
    if (e.timestampMs > lastMs) lastMs = e.timestampMs;
  }
  return Number.isFinite(firstMs)
    ? { firstMs, lastMs }
    : { firstMs: 0, lastMs: 0 };
}

export function computeLedger(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Ledger {
  const planMs = planFloorMs(planPath);
  const { projectDir, sessionId, dir } = transcriptPaths(env);
  // A review that starts inside an EXISTING session must not bill that
  // session's earlier turns; its ledger entry says when it became an attempt.
  const own = currentSessionEntry(planPath, env);
  const floorMs = own === null ? planMs : Math.max(planMs, own.atMs);

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
  // Streams that exist but could not be read: a silent skip would present a
  // lower total as a complete one.
  let missingStreams = 0;
  const readAgentDir = (
    agentDir: string,
    names: string[],
    ceilingMs?: number,
    streamFloorMs?: number,
  ): number => {
    let streams = 0;
    for (const f of names) {
      const full = join(agentDir, f);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        missingStreams++;
        continue; // Gone between listing and stat.
      }
      // The transcript dir is session-scoped and never pruned: files from
      // earlier reviews this session predate the floor, and a file whose last
      // write predates it cannot hold an above-floor record — the same
      // membership test `readTranscripts` applies. Skip it without opening.
      if (mtimeMs < (streamFloorMs ?? floorMs)) continue;
      let read: { events: UsageEvent[]; launch: string };
      try {
        read = readUsage(full, streamFloorMs ?? floorMs, ceilingMs);
      } catch {
        missingStreams++;
        continue; // This agent's record is lost; the rest still count.
      }
      if (read.events.length === 0) continue;
      const id = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      agents.push(foldEvents(id, labelOf(read.launch, id), read.events));
      agentEvents.push(...read.events);
      streams++;
    }
    return streams;
  };
  readAgentDir(dir, files);

  // Earlier sessions of THIS run (a resumed review): their cost is part of
  // the review's cost. Unlike the current session, a prior session whose
  // records cannot be read only makes the ledger a floor, not a fabrication —
  // so unreadable prior state is skipped, never fatal, and the count of
  // sessions that did contribute is reported.
  const priorMainEvents: UsageEvent[] = [];
  const priorSpans: Array<{ firstMs: number; lastMs: number }> = [];
  // The prior-session events, by identity: the wall-clock sum below folds
  // each session's own span, so the current session's must exclude them.
  const priorEventSet = new Set<UsageEvent>();
  let priorSessions = 0;
  // Paths come from the shared accessor, which drops a symlinked prior
  // directory: the ledger reads file CONTENT with no certification step, so
  // it is the consumer a planted link would mislead most cheaply.
  const priorDirs = new Map(
    priorSessionDirs(planPath, env).map((p) => [p.sessionId, p]),
  );
  for (const entry of priorSessionEntries(planPath, env)) {
    const paths = priorDirs.get(entry.sessionId);
    let contributed = 0;
    let events: UsageEvent[] = [];
    try {
      events = readUsage(
        paths?.chatFile ??
          join(projectDir, 'chats', `${entry.sessionId}.jsonl`),
        // Floored at the moment THIS attempt began — the plan floor plus
        // that session's own start. NOT the current attempt's floor, which is
        // later and would erase the prior attempt entirely.
        Math.max(planMs, entry.atMs),
        entry.endsAtMs ?? undefined,
      ).events;
      priorMainEvents.push(...events);
      contributed += events.length;
    } catch {
      // The prior attempt's chat is lost; its agents may still count.
    }
    let priorAgentEvents: UsageEvent[] = [];
    if (paths !== undefined) {
      const before = agentEvents.length;
      try {
        contributed += readAgentDir(
          paths.dir,
          listAgentTranscriptFiles(paths.dir),
          // The same window the chat gets: an interrupted CLI session whose
          // operator kept working would otherwise fold unrelated subagent
          // cost into this review.
          entry.endsAtMs ?? undefined,
          Math.max(planMs, entry.atMs),
        );
      } catch (err) {
        // Absent is the legitimate state (the attempt died before launching
        // anything). Any OTHER fault is disclosed rather than silently
        // floored: the summary would otherwise announce that this session's
        // cost is included while omitting all of its agents.
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          writeStderrLineSafe(
            `WARNING: could not list the prior session's subagent transcripts at ` +
              `${paths.dir} (${(err as NodeJS.ErrnoException)?.code ?? (err as Error).message}); ` +
              `that attempt's agent cost is missing from this ledger.`,
          );
        }
      }
      priorAgentEvents = agentEvents.slice(before);
    }
    // ONE span per session, from the union of its chat and agent events: the
    // agent window is nested inside the session's, so pushing both would
    // count the nested minutes twice.
    const sessionEvents = [...events, ...priorAgentEvents];
    if (sessionEvents.length > 0) {
      priorSpans.push(spanOf(sessionEvents));
      for (const e of sessionEvents) priorEventSet.add(e);
    }
    if (contributed > 0) priorSessions++;
  }
  agents.sort((a, b) => b.inputTokens - a.inputTokens);

  // A present-but-empty window is not a lighter version of a missing one.
  // The recorder pre-creates the chat file and degrades permanently if its
  // first append fails, so "exists, yet no above-floor records" — with or
  // without agents — is the same infrastructure fact as "unreadable": a live
  // review holds at least one above-floor main-loop record, because the plan
  // itself is a main-loop write. Rendering a zero ledger from this shape
  // would be diffed against real numbers — exactly the fabrication the
  // refusal above names.
  if (mainEvents.length === 0) {
    throw new Error(
      `could not read the chat transcript ${chatFile}: no main-loop usage ` +
        // Name the boundary that actually filtered: on a resumed or
        // long-lived session the floor is this attempt's ledger entry, not
        // the plan — and an operator pointed at "after the plan" finds
        // records plainly there and distrusts the refusal.
        (own === null
          ? 'records at or after the plan'
          : `records at or after this attempt's start (its run-ledger entry)`),
    );
  }

  // One `main` row for the run: a resumed run's orchestrator turns span two
  // chat files, but they are the same loop doing the same job. Folded after
  // the emptiness check above, which is deliberately about the CURRENT
  // session only — prior events must not vouch for a broken current chat.
  const allMainEvents = [...priorMainEvents, ...mainEvents];
  const main = foldEvents('main', 'main loop', allMainEvents);

  // The same events the per-stream rows fold, folded once more — one
  // accumulator, so a new usage counter cannot land in the rows and miss the
  // headline.
  const totals = foldEvents('totals', 'totals', [
    ...allMainEvents,
    ...agentEvents,
  ]);
  // The time this review SPENT, not the envelope it spans. On a resumed run
  // the envelope would include the dead gap between the interrupted attempt
  // and the continuation — minutes to hours of nothing — and the ledger
  // renders this as "min wall" beside real token counts. Summing each
  // session's own span is identical on a single-session run (one span) and
  // honest on a resumed one.
  const currentEvents = [...mainEvents, ...agentEvents].filter(
    (e) => !priorEventSet.has(e),
  );
  const spans = [...priorSpans];
  if (currentEvents.length > 0) spans.push(spanOf(currentEvents));
  const wallSeconds = spans.reduce(
    (acc, sp) => acc + Math.max(0, Math.round((sp.lastMs - sp.firstMs) / 1000)),
    0,
  );

  const { id: _i, label: _l, ...totalsRest } = totals;
  return {
    totals: { ...totalsRest, wallSeconds },
    main,
    agents,
    priorSessions,
    missingStreams,
  };
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
  const m = ledger.main;
  lines.push(
    `  main loop: ${plural(m.calls, 'call')} · ${human(m.inputTokens)} in · ` +
      `${human(m.outputTokens)} out`,
  );
  if (ledger.priorSessions > 0) {
    lines.push(
      `  resumed run: totals include ${plural(ledger.priorSessions, 'earlier session')} of this review`,
    );
  }
  if (ledger.missingStreams > 0) {
    lines.push(
      `  ⚠️ ${plural(ledger.missingStreams, 'stream')} could not be read; this ledger is a floor`,
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
  // EPIPE arrives two ways when the reader goes away (`qwen … | head`, a
  // daemon's closed redirect): a sync throw out of the write, and an async
  // 'error' event on the pipe. The safe writers catch the first; destroy the
  // stream on the second — the convention nonInteractiveCli uses — and
  // detach both listeners on exit. A review must never fail on its own
  // accounting, including the accounting of a reader that left.
  const stdoutErrorHandler = (err: NodeJS.ErrnoException): void => {
    if (err.code === 'EPIPE') process.stdout.destroy();
  };
  const stderrErrorHandler = (err: NodeJS.ErrnoException): void => {
    if (err.code === 'EPIPE') process.stderr.destroy();
  };
  process.stdout.on('error', stdoutErrorHandler);
  process.stderr.on('error', stderrErrorHandler);
  try {
    let ledger: Ledger;
    try {
      ledger = computeLedger(args.plan, process.env);
    } catch (err) {
      // Informational, always: a review must never fail on its own accounting.
      const why =
        err instanceof TranscriptsUnavailableError
          ? err.message
          : (err as Error).message;
      writeStderrLineSafe(`cost-ledger unavailable — ${why}`);
      return;
    }
    if (args.out !== undefined && args.out.length > 0) {
      // A failed archive write degrades to a warning: the ledger was computed,
      // and the exit code must stay 0 either way.
      try {
        mkdirSync(dirname(resolve(args.out)), { recursive: true });
        writeFileSync(args.out, JSON.stringify(ledger, null, 2));
      } catch (err) {
        writeStderrLineSafe(
          `cost-ledger: could not write ${args.out} — ${(err as Error).message}`,
        );
      }
    }
    writeStdoutLineSafe(renderLedger(ledger));
  } finally {
    process.stdout.removeListener('error', stdoutErrorHandler);
    process.stderr.removeListener('error', stderrErrorHandler);
  }
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
