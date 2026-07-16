/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Coverage, computed from the harness's records rather than accepted from the
// caller.
//
// This is shared by `check-coverage` (which stops the run) and `compose-review`
// (which caps the verdict) deliberately. The old shape had `check-coverage` write
// a report and `compose-review` take a `coverage` **field in a JSON the model
// writes** — so hardening the first while the second still believed a hand-typed
// `{"ok": true}` would have moved the forgery one hop downstream and made it
// cheaper: one object instead of eighteen fabricated receipts. A caller cannot
// forge what it cannot supply, so neither of them is given the answer. They both
// derive it.
//
// **What a chunk being "covered" means here, and what it used to mean.** The
// first version asked one question of the transcript: did an agent whose launch
// prompt said `chunk 3 of 18` make at least one successful tool call? That model
// had two holes, and dogfooding walked into both.
//
//   - It could only see a **territory agent**. Step 3B assigns one agent per chunk
//     and their prompts say so; Step 3A — the topology *most* pull requests get,
//     and which the skill explicitly says has no receipts — assigns every dimension
//     agent the whole diff, and no agent's prompt names a chunk. Run against a real
//     Step 3A review in which fifteen agents each opened the diff, walked both
//     chunks and filed findings, this file returned `0/2 chunk(s) reviewed …
//     Nobody read those lines` — in the same breath as `16 agent(s) ran; 16 did
//     work`. `compose-review` runs the same computation on the way to the verdict,
//     so a flawless small-PR review was capped away from Approve and told, in the
//     body it would have posted to the pull request, that nobody had read it. Both
//     sentences cannot be true. The false one is the one this file wrote.
//
//   - It credited **any** successful tool call. A `glob` for test files is a
//     successful tool call. What a review has to be able to say is not that an
//     agent did something, but that someone opened the lines it is about to
//     certify.
//
// So coverage is no longer a claim an agent makes about a chunk. It is the
// intersection of two things the harness wrote down: the **lines the agent was
// pointed at** (its launch prompt, recorded at launch, before the model spoke) and
// the fact that it **opened the diff** (a successful tool call whose arguments
// named the diff file). Both are topology-blind. A territory agent is pointed at
// one chunk; a Step 3A dimension agent is pointed at all of them; a reverse-audit
// agent is pointed at none, and is credited only with the ranges it demonstrably
// read.
//
// What this proves, and what it does not: that an agent was given the lines and
// opened the file. Not that it read every byte — no check can, and pretending
// otherwise is how the receipts became theatre. The paging rule is what covers the
// rest, and it is now in the prompt, in code.

import { readFileSync, statSync } from 'node:fs';
import {
  readTranscripts,
  wasGivenTheDiff,
  TranscriptsUnavailableError,
  type AgentRecord,
} from './transcripts.js';
import {
  readRecordedPrompts,
  wasDeliveredVerbatim,
  briefPath,
} from './prompt-record.js';
import {
  requiredAgents,
  type RequiredAgent,
  type RosterPlan,
} from './roster.js';
import { BRIEFS } from './agent-briefs.js';

export interface CoverageFromTranscripts {
  /** True only when every chunk was reviewed by an agent that could and did. */
  ok: boolean;
  /** How many subagent transcripts the harness wrote for this run. */
  agents: number;
  /**
   * Chunk agents launched with a prompt that never named the diff.
   *
   * They cannot have read it. This is not a whiff and must not be reported as
   * one: relaunching an agent whose prompt has no diff in it produces a second
   * agent that also cannot read the diff. The prompt is the defect.
   */
  blindAgents: string[];
  /** Agents that made no successful tool call: they read nothing. */
  idleAgents: string[];
  /**
   * Agents pointed at diff lines that never opened the diff.
   *
   * They worked — they just worked on something else. An agent handed chunk 3 and
   * a diff path, which then spends its run grepping the source tree, has reviewed
   * the post-change file and not the change. The old check credited it: any one
   * successful call was enough.
   */
  unopenedAgents: string[];
  /**
   * Chunks whose agent got something other than the prompt the CLI built for it.
   *
   * "Pass what it prints to the agent verbatim" is prose, and prose is what this
   * skill keeps discovering it cannot rely on. Dogfooded, the orchestrator invoked
   * `agent-prompt` for all five chunks and then **paraphrased** what came back:
   * the delivered prompt had dropped the instruction not to recite a stock
   * sentence, dropped the half-read warning, and replaced the project's review
   * rules with a three-sentence summary of its own.
   */
  rewrittenPrompts: string[];
  /**
   * Agents the plan requires that this review did not launch.
   *
   * Every other field here asks a question of an agent that ran. An agent that did
   * not run leaves no transcript to ask, so its absence is invisible — which is how
   * a real PR review shipped having never launched Agent 0 at all, on a review whose
   * job includes asking whether the PR fixes the thing it claims to. The roster is
   * derived from the plan; nothing in it is supplied by the caller.
   */
  missingRoles: string[];
  /**
   * Required agents that never opened the brief they were pointed at.
   *
   * The launch prompt names the brief rather than containing it — a 4 652-character
   * prompt is not something an orchestrator pastes twelve times, and the run that
   * was asked to delivered 2 893 characters of it. So the instructions arrive only
   * if the agent reads the file. Whether it did is a tool call, and the harness
   * wrote it down.
   */
  unreadBriefs: string[];
  /** Chunk ids no working agent covered. */
  missingChunks: number[];
  /** Chunk ids an agent declared unreachable. */
  uncoverableChunks: number[];
  /** Chunk ids a working agent actually reviewed. */
  coveredChunks: number[];
}

/** The plan, as far as coverage needs it. The roster reads more of it — see RosterPlan. */
interface Plan {
  diffPathAbsolute: string;
  chunks: Array<{ id: number; startLine: number; endLine: number }>;
}

function readPlan(path: string): { plan: Plan; mtimeMs: number } {
  const plan = JSON.parse(readFileSync(path, 'utf8')) as Plan;
  if (typeof plan?.diffPathAbsolute !== 'string' || !plan.diffPathAbsolute) {
    throw new Error(`coverage: ${path} has no diffPathAbsolute`);
  }
  if (!Array.isArray(plan.chunks) || plan.chunks.length === 0) {
    throw new Error(`coverage: ${path} has no chunks[]`);
  }
  // Chunk ids are matched against what the launch prompts say and rendered into
  // the review body. A non-integer or duplicate id would silently never match,
  // and the chunk it stands for would be reported as unreviewed forever.
  const ids = plan.chunks.map((c) => c?.id);
  if (ids.some((id) => !Number.isSafeInteger(id) || (id as number) < 1)) {
    throw new Error(
      `coverage: ${path} has a chunk with no positive integer id`,
    );
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`coverage: ${path} has duplicate chunk ids`);
  }
  return { plan, mtimeMs: statSync(path).mtimeMs };
}

/** `chunk 13 of 25` — written into the prompt by `agent-prompt`, in code. */
const CHUNK_RE = /\bchunk\s+(\d+)\s+of\s+\d+\b/i;

/** The chunk this agent owns, when it was launched to own one. */
function assignedChunk(rec: AgentRecord): number | null {
  const m = CHUNK_RE.exec(rec.launchPrompt);
  return m ? Number(m[1]) : null;
}

/**
 * The diff lines this launch prompt points its agent at, 1-based and inclusive.
 *
 * Every prompt the CLI builds spells its reads out literally —
 * `read_file(file_path="…", offset=0, limit=386)` — one of them for a chunk agent,
 * one per chunk for a whole-diff agent. So the lines an agent was pointed at are
 * recoverable from the harness's own copy of its launch prompt, in either
 * topology, without the agent having to claim anything afterwards.
 */
function pointedAt(prompt: string, plan: Plan): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /offset\s*[=:]\s*(\d+)\s*,\s*limit\s*[=:]\s*(\d+)/gi;
  for (const m of prompt.matchAll(re)) {
    const offset = Number(m[1]);
    const limit = Number(m[2]);
    if (limit > 0) out.push([offset + 1, offset + limit]);
  }
  if (out.length > 0) return out;

  // A prompt that names a chunk but spells out no read is not one this CLI built —
  // and its territory is still unambiguous. Resolve it through the plan rather
  // than discard it: reporting a chunk unread because the prompt that assigned it
  // was hand-written would send the reader after the wrong defect.
  const m = CHUNK_RE.exec(prompt);
  if (m) {
    const c = plan.chunks.find((c) => c.id === Number(m[1]));
    if (c) return [[c.startLine, c.endLine]];
  }
  return [];
}

/**
 * Coalesce adjacent and overlapping ranges before asking whether one contains a chunk.
 *
 * Without this, an agent that **paged** its chunk — which the prompt tells it to do
 * when a read comes back `isTruncated` — got no credit for it: reads of 1-200 and
 * 201-400 are two ranges, and no single one of them contains a chunk spanning
 * 1-400. The check would have contradicted the instruction the same review had just
 * given, on exactly the oversized chunks where paging is not optional.
 */
function merge(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length < 2) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // Start with a COPY of the first tuple, and push copies. `sorted` shares its
  // element references with the caller's array — which includes `rec.diffReads` —
  // so writing `last[1] = …` below would mutate a tuple the record owns. Harmless
  // today (the record is not read again after this), but a pure function here is
  // one fewer latent foot-gun for the next caller.
  const out: Array<[number, number]> = [[...sorted[0]]];
  for (const [s, e] of sorted.slice(1)) {
    const last = out[out.length - 1];
    // `s <= last[1] + 1` — abutting counts. Lines 1-200 then 201-400 is one walk of
    // 1-400, not two walks with a hole between them.
    if (s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

const UNCOVERABLE_RE = /^\s*Uncoverable:\s*chunk\s+(\d+)\b/im;

/** A required agent, named the way a reader has to act on it. */
function roleLabel(req: RequiredAgent): string {
  if (req.role === 'chunk') return `chunk ${req.chunk}`;
  const base = BRIEFS[req.role].label;
  return req.file ? `${base} — ${req.file}` : base;
}

/** The exact call that would have built it. An error a reader can act on names the fix. */
function promptFlags(req: RequiredAgent): string {
  if (req.role === 'chunk') return `--chunk ${req.chunk}`;
  return req.file
    ? `--role ${req.role} --file ${req.file}`
    : `--role ${req.role}`;
}

/** Something a reader can act on. `agentName` is `general-purpose` for all of them. */
function label(rec: AgentRecord, chunk: number | null): string {
  if (chunk !== null) return `chunk ${chunk}`;
  const first = rec.launchPrompt.split('\n')[0]?.trim() ?? '';
  if (first) return first.length > 60 ? `${first.slice(0, 57)}...` : first;
  return rec.agentName || rec.agentId;
}

/**
 * What the agents of this run actually did, as the harness recorded it.
 *
 * Nothing here is supplied by the caller except the plan path. The transcripts
 * are found from the environment the CLI exported; their contents are the
 * harness's, written at launch and flushed per event.
 *
 * Transcripts older than the plan are ignored. The transcript directory is scoped
 * to the session, not the review, and nothing prunes it — so a second `/review`
 * in one session would otherwise be satisfied by the first one's agents. The diff
 * path is stable across runs, which makes that collision silent.
 */
export function coverageFromTranscripts(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
): CoverageFromTranscripts {
  const { plan, mtimeMs } = readPlan(planPath);
  const records = readTranscripts(mtimeMs, env, plan.diffPathAbsolute);
  const built = readRecordedPrompts(planPath);

  const blindAgents: string[] = [];
  const idleAgents: string[] = [];
  const unopenedAgents: string[] = [];
  const rewrittenPrompts: string[] = [];
  const covered = new Set<number>();
  const uncoverable = new Set<number>();

  for (const rec of records) {
    const chunk = assignedChunk(rec);
    const name = label(rec, chunk);

    // Could this agent have read the diff at all? The prompt is the harness's
    // record of what was asked of it. 23 of 23 real chunk agents were launched
    // without one, and every one of them then said the sentence its prompt had
    // handed it.
    const given = wasGivenTheDiff(rec, plan.diffPathAbsolute);
    if (chunk !== null && !given) {
      blindAgents.push(name);
      continue; // Its silence proves nothing about the diff; the prompt failed.
    }

    // Did it work? Zero successful tool calls means it read nothing — whatever
    // its prose says. This is checked BEFORE the Uncoverable claim below, and the
    // order is load-bearing: `Uncoverable: chunk N` is a line the prompt hands the
    // agent, and an honest one requires having read the chunk to discover the line
    // is too long. A zero-tool-call agent that merely copied the template must not
    // be credited with a disclosed gap — that is the whiff wearing a costume.
    if (rec.successfulToolCalls === 0) {
      idleAgents.push(name);
      continue;
    }

    // Not a diff reader, and not required to be. Two review agents legitimately
    // never open the diff — Build & Test runs the build, Issue Fidelity reads the
    // issue — and the session's transcript directory also holds agents this review
    // did not launch, including ones its own agents spawned. None of them owes the
    // diff anything; none of them may be credited with having read it either.
    if (!given) continue;

    // The prompt the CLI built for this chunk, against the prompt the harness
    // recorded the agent being launched with. Nothing else in the run can see the
    // difference: a paraphrase keeps the diff path, so every other check passes.
    if (chunk !== null) {
      const b = built.get(`chunk-${chunk}`);
      if (b === undefined) {
        rewrittenPrompts.push(
          `${name} — no prompt was built for it (\`agent-prompt\` never ran for this chunk)`,
        );
      } else if (!wasDeliveredVerbatim(rec.launchPrompt, b)) {
        rewrittenPrompts.push(
          `${name} — launched with a prompt that is not the one the CLI built`,
        );
      }
    }

    const told = pointedAt(rec.launchPrompt, plan);

    // Pointed at lines, and never opened the file they live in. It did work, so it
    // is not idle. It just did not do *this* work.
    if (told.length > 0 && rec.diffToolCalls === 0) {
      unopenedAgents.push(name);
      continue;
    }

    // What it was told to read, plus what it demonstrably read. The second term is
    // what lets an agent handed the bare diff path with no territory — a
    // reverse-audit pass, a verifier — be credited for exactly the lines it opened
    // and for no others.
    const ranges = merge([...told, ...rec.diffReads]);
    if (ranges.length === 0) continue;

    const u = UNCOVERABLE_RE.exec(rec.finalText);
    if (u && chunk !== null && Number(u[1]) === chunk) {
      uncoverable.add(chunk);
      continue;
    }

    for (const c of plan.chunks) {
      if (ranges.some(([s, e]) => s <= c.startLine && e >= c.endLine)) {
        covered.add(c.id);
      }
    }
  }

  // A chunk somebody declared unreachable is a disclosed gap, not coverage — even
  // though a whole-diff agent's range formally spans it. Listing it as both would
  // be the report contradicting itself, which is the failure this whole file is a
  // response to.
  for (const id of uncoverable) covered.delete(id);

  // Who *should* have been here. Every other check in this file asks a question of
  // an agent that ran; an agent that never ran leaves no transcript to ask, so an
  // omission is invisible precisely because it is an omission. Dogfooded, a real
  // PR review simply never launched Agent 0 — issue fidelity, on a review whose
  // whole job includes asking whether the PR fixes the thing it claims to — and
  // nothing in the run could tell. The roster is derived from the plan, which the
  // caller does not write, and matched against the prompts the CLI recorded itself
  // emitting.
  const missingRoles: string[] = [];
  const unreadBriefs: string[] = [];
  for (const req of requiredAgents(plan as unknown as RosterPlan)) {
    const b = built.get(req.key);
    if (b === undefined) {
      missingRoles.push(
        `${roleLabel(req)} — no prompt was built for it ` +
          `(\`agent-prompt ${promptFlags(req)}\` never ran)`,
      );
      continue;
    }
    const agent = records.find((r) => wasDeliveredVerbatim(r.launchPrompt, b));
    if (!agent) {
      missingRoles.push(
        `${roleLabel(req)} — its prompt was built, but no agent was launched with it`,
      );
      continue;
    }
    // The launch prompt points at the brief rather than containing it, because a
    // 4 652-character prompt is not a thing an orchestrator will paste twelve times
    // — measured, it delivered 2 893 of them and cut the rest — and a Step 3B review
    // of a real pull request has seventeen chunk agents whose briefs run to five
    // kilobytes apiece. Eighty-seven kilobytes, in one response. Which means the
    // instructions now arrive only if the agent opens the file. That is not a hope:
    // it is a tool call, and the harness wrote it down.
    //
    // Every role, territory agents included. Their brief is where the severity
    // definitions, the paging rule, the uncoverable rule and the project rules live.
    const brief = briefPath(planPath, req.key);
    // The brief as a whole JSON string value (`successfulCallArgs` are already
    // serialized args): a bare substring would credit `${brief}.bak` for the brief,
    // the same trap `parseTranscript` avoids for the diff path.
    const opened = agent.successfulCallArgs.some((a) =>
      a.includes(JSON.stringify(brief)),
    );
    if (!opened) {
      unreadBriefs.push(
        `${roleLabel(req)} — never opened its brief (${brief}), so it reviewed ` +
          'without the instructions it was launched to follow',
      );
    }
  }

  const planned = plan.chunks.map((c) => c.id);
  const missingChunks = planned.filter(
    (id) => !covered.has(id) && !uncoverable.has(id),
  );

  return {
    ok:
      blindAgents.length === 0 &&
      idleAgents.length === 0 &&
      unopenedAgents.length === 0 &&
      rewrittenPrompts.length === 0 &&
      missingRoles.length === 0 &&
      unreadBriefs.length === 0 &&
      // An uncoverable chunk is a disclosed gap, not coverage: a diff with a line
      // no read can reach was not reviewed, and the verdict may not be Approve on
      // its strength. `compose-review` already caps on it; the report must agree.
      uncoverable.size === 0 &&
      missingChunks.length === 0,
    agents: records.length,
    blindAgents,
    idleAgents,
    unopenedAgents,
    rewrittenPrompts,
    missingRoles,
    unreadBriefs,
    missingChunks,
    uncoverableChunks: [...uncoverable].sort((a, b) => a - b),
    coveredChunks: [...covered].sort((a, b) => a - b),
  };
}

/**
 * How a Step 4/5 step's agents got their prompt — four shapes, four different fixes.
 *
 * `ok` — an agent was launched with the prompt the CLI built and opened its brief.
 * `not-built` — `agent-prompt --role <r>` never ran: the step was skipped.
 * `not-launched` — the prompt was built and nothing was launched with it.
 * `rewritten` — an agent ran and opened the brief, but no agent got the built prompt
 *   intact: the orchestrator wrote the launch itself.
 * `brief-unread` — an agent got the built prompt and never opened the brief it names.
 */
type Delivery =
  | 'ok'
  | 'not-built'
  | 'not-launched'
  | 'rewritten'
  | 'brief-unread';

/** What to say, and what to do about it, for each way a step's delivery failed. */
type GapText = Record<Exclude<Delivery, 'ok'>, string>;

const REVERSE_AUDIT_GAP: GapText = {
  'not-built':
    'no auditor ran — Step 5 builds its prompt with `agent-prompt --role ' +
    'reverse-audit --findings <file>`, and none was recorded, so the pass that ' +
    'looks for what Step 3 missed never happened',
  'not-launched':
    'its prompt was built, but no agent was launched with it — the pass that ' +
    'looks for what Step 3 missed did not run',
  rewritten:
    'an auditor ran and opened its brief, but **no agent was launched with the ' +
    'prompt the CLI built** — the launch was written by hand instead of pasted. ' +
    'What the agent was actually asked is not what this skill guarantees: pass ' +
    '`--findings <file>` so there is nothing to assemble, and paste that output ' +
    'verbatim — no round number, no summary of your own, no rewording',
  'brief-unread':
    'it was launched with the built prompt but never opened its brief, so it ' +
    'audited without the gaps-only method and the finding format it was launched ' +
    'to follow',
};

const VERIFY_GAP: GapText = {
  'not-built':
    'the review posts findings, but no verifier ran — Step 4 builds its prompt ' +
    'with `agent-prompt --role verify --findings <file>`, and none was recorded, ' +
    'so the findings were never verified',
  'not-launched':
    'its prompt was built, but no agent was launched with it, so the posted ' +
    'findings were not verified',
  rewritten:
    'a verifier ran and opened its brief, but **no agent was launched with the ' +
    'prompt the CLI built** — the launch was written by hand instead of pasted. ' +
    'Pass `--findings <file>` so there is nothing to assemble, and paste that ' +
    'output verbatim — no shard number, no summary of your own, no rewording',
  'brief-unread':
    'it was launched with the built prompt but never opened its brief, so it ' +
    'ruled on the findings without the verdict bar it was launched to apply',
};

export interface VerificationReport {
  /** True when every required Step 4/5 agent ran and read its brief. */
  ok: boolean;
  /**
   * Self-explanatory gap lines, shaped to drop straight into
   * `unreviewedDimensions` — each carries its own ` — ` reason, so
   * `compose-review` renders it verbatim rather than appending the whiff sentence.
   */
  gaps: string[];
}

/**
 * Did Step 4 (verify) and Step 5 (reverse audit) actually run, and read their
 * briefs?
 *
 * `check-coverage` proves Step 3 was done — but it runs at Step 3D, *before* these
 * two, so its roster (`requiredAgents`) cannot reach them. And their count is not
 * in the plan: verify shards on the finding count (`ceil(N/8)`), reverse audit
 * loops until it goes dry. So this is not an exact roster — it is a floor, and it
 * is asked only by `compose-review`, which runs only at high effort. A low/medium
 * quick pass has no verify and no reverse audit, and never reaches here (it emits
 * no verdict, so it calls no `compose-review`).
 *
 * The floor is deliberately one agent per step, for the failure it exists to catch:
 * the step skipped **wholesale**, or run with agents that never opened their brief —
 * the same silent omission the rest of this file is a response to. Per-chunk
 * completeness of a Step 3B reverse audit is the orchestrator's Step 5 loop
 * contract, disclosed through `unreviewedDimensions` when a scope is left
 * outstanding; this does not re-litigate it.
 *
 * Like everything here, nothing is supplied by the caller but the plan path. The
 * proof is the intersection of two artifacts with different authors: the prompt the
 * CLI recorded building (`reverse-audit` / `reverse-audit--chunk-N` / `verify`) and
 * the harness's transcript of an agent launched with it that opened its brief.
 */
export function verificationGaps(
  planPath: string,
  opts: { postsFindings: boolean },
  env: NodeJS.ProcessEnv = process.env,
): VerificationReport {
  const { plan, mtimeMs } = readPlan(planPath);
  const records = readTranscripts(mtimeMs, env, plan.diffPathAbsolute);
  const built = readRecordedPrompts(planPath);
  const gaps: string[] = [];

  // How a step's agents actually got their prompt. The floor needs the four shapes
  // apart, not one boolean, because the fix for each is different — and a refusal
  // that names the wrong one is a refusal that gets argued with.
  //
  // Dogfooded, exactly that happened: an auditor HAD run and HAD opened its brief;
  // the orchestrator had merely rewritten the launch prompt. The gap said "no agent
  // was launched with it that opened its brief" — false as written. The orchestrator
  // read it, called it "a transcript visibility issue", and reported an **Approve**
  // over the capped verdict. It was wrong about the mechanism and right that the
  // message did not describe what happened. So the message describes what happened.
  const deliveryOf = (key: string): Delivery => {
    const b = built.get(key);
    if (b === undefined || b.trim() === '') return 'not-built';
    // Match the brief as a whole JSON string value, quotes included — the same
    // lesson `parseTranscript` learned for the diff path: a bare substring credits
    // `…/x.brief.md.bak` for `…/x.brief.md`. `successfulCallArgs` are already
    // `JSON.stringify(args)`, so the quoted path is what a real read of the brief
    // leaves in them.
    const needle = JSON.stringify(briefPath(planPath, key));
    const opened = (r: AgentRecord) =>
      r.successfulCallArgs.some((a) => a.includes(needle));
    const gotTheBuiltPrompt = records.filter((r) =>
      wasDeliveredVerbatim(r.launchPrompt, b),
    );
    if (gotTheBuiltPrompt.some(opened)) return 'ok';
    if (gotTheBuiltPrompt.length > 0) return 'brief-unread';
    // Nothing was launched with the built prompt. Did anything open this key's brief
    // anyway? Then an agent DID run — on a launch the orchestrator wrote itself. A
    // different failure, with a different fix, and the one the message used to deny.
    if (records.some(opened)) return 'rewritten';
    return 'not-launched';
  };

  /** The best shape across a step's keys — the floor is one agent, not all of them. */
  const bestDelivery = (keys: string[]): Delivery => {
    if (keys.length === 0) return 'not-built';
    const rank: Record<Delivery, number> = {
      ok: 0,
      'brief-unread': 1,
      rewritten: 2,
      'not-launched': 3,
      'not-built': 4,
    };
    return keys
      .map(deliveryOf)
      .sort((a, b) => rank[a] - rank[b])[0] as Delivery;
  };

  // Step 5: reverse audit. Required on EVERY high-effort review — it is the pass
  // that hunts what Step 3 missed, and a verdict that never ran it cannot certify
  // the diff complete, least of all a clean one (a zero-finding review is exactly
  // when a second look matters most). 3A records it under `reverse-audit`; 3B under
  // `reverse-audit--chunk-N`, one per chunk. The floor is one: at least one auditor
  // ran and read its brief. Matched on the role name and the universal `--` key
  // separator rather than the exact `--chunk-<n>` shape, so a change to how the
  // chunk suffix is spelled does not silently drop every per-chunk key here.
  const reverseKeys = [...built.keys()].filter(
    (k) => k === 'reverse-audit' || k.startsWith('reverse-audit--'),
  );
  const reverse = bestDelivery(reverseKeys);
  if (reverse !== 'ok') {
    gaps.push(`reverse audit — ${REVERSE_AUDIT_GAP[reverse]}`);
  }

  // Step 4: verify. Required when the review posts a finding a verifier rules on —
  // an unverified finding must not become a public blocker (the false "this PR now
  // leaks tokens" Critical is the exact harm). Whether it does is `opts.postsFindings`,
  // decided by the caller: `compose-review` counts the anchored findings and the
  // non-deterministic body Criticals, and excludes deterministic `[build]`/`[test]`
  // findings, which are pre-confirmed and skip verification by design. A review that
  // confirmed nothing has nothing to verify.
  if (opts.postsFindings) {
    const verify = deliveryOf('verify');
    if (verify !== 'ok') gaps.push(`verification — ${VERIFY_GAP[verify]}`);
  }

  return { ok: gaps.length === 0, gaps };
}

export { TranscriptsUnavailableError };
