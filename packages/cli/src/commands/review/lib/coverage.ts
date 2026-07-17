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
   * The exact `agent-prompt` selector that rebuilds each missing brief, in the
   * same order as its `missingRoles` entries would list them per-role. For
   * stderr, never for the body: a human-facing label does not name its role id.
   */
  missingRoleSelectors: string[];
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

/** The exact rebuild flags for one required agent — operator-facing (stderr). */
function selectorOf(req: RequiredAgent): string {
  if (req.role === 'chunk') return `--chunk ${req.chunk}`;
  return req.file
    ? `--role ${req.role} --file ${req.file}`
    : `--role ${req.role}`;
}

/** A required agent, named the way a reader has to act on it. */
function roleLabel(req: RequiredAgent): string {
  if (req.role === 'chunk') return `chunk ${req.chunk}`;
  const base = BRIEFS[req.role].label;
  return req.file ? `${base} — ${req.file}` : base;
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

  // Hoisted from the roster section below: when NO role was briefed at all, the
  // roster collapses to one line covering the whole run, and repeating "none was
  // built" once per chunk transcript would put N more copies of the same fact
  // into the posted body, right next to the line that already states it.
  const rosterForRun = requiredAgents(plan as unknown as RosterPlan);
  // ONE predicate for "was this prompt built", everywhere. A partial write can
  // leave a zero-byte record, and the Step 4/5 classifier already reads that as
  // not-built — a `Map.has()` here would read the same file as built, so an
  // all-empty record dir would dodge the single collapsed diagnosis and surface
  // as a pile of false built-but-not-launched failures instead.
  const builtOf = (key: string): string | undefined => {
    const b = built.get(key);
    return b !== undefined && b.trim() !== '' ? b : undefined;
  };
  const nothingBuiltAtAll =
    rosterForRun.length > 1 && rosterForRun.every((r) => !builtOf(r.key));

  // A failed attempt superseded by a compliant one must stop counting, or the
  // report can never converge: the relaunch its own FIX line prescribes adds a
  // SECOND transcript, the first stays in idle/blind/unopened/rewritten, `ok`
  // stays false, and the same FIX prints forever. A record's failure flags are
  // suppressed when ANOTHER record satisfies the same target — same chunk served
  // by a verbatim launch that opened the diff, or same built prompt delivered
  // verbatim to an agent that opened its brief.
  const chunkSatisfied = (c: number, self: AgentRecord): boolean => {
    const b = builtOf(`chunk-${c}`);
    if (b === undefined) return false;
    return records.some(
      (r) =>
        r !== self &&
        assignedChunk(r) === c &&
        wasDeliveredVerbatim(r.launchPrompt, b) &&
        r.diffToolCalls > 0,
    );
  };
  const keySatisfied = (rec: AgentRecord): boolean => {
    for (const key of built.keys()) {
      const b = builtOf(key);
      if (b === undefined) continue;
      if (!wasDeliveredVerbatim(rec.launchPrompt, b)) continue;
      const needle = JSON.stringify(briefPath(planPath, key));
      if (
        records.some(
          (r) =>
            r !== rec &&
            wasDeliveredVerbatim(r.launchPrompt, b) &&
            r.successfulCallArgs.some((a) => a.includes(needle)),
        )
      ) {
        return true;
      }
    }
    return false;
  };
  const superseded = (rec: AgentRecord, chunk: number | null): boolean =>
    chunk !== null ? chunkSatisfied(chunk, rec) : keySatisfied(rec);

  for (const rec of records) {
    const chunk = assignedChunk(rec);
    const name = label(rec, chunk);

    // Could this agent have read the diff at all? The prompt is the harness's
    // record of what was asked of it. 23 of 23 real chunk agents were launched
    // without one, and every one of them then said the sentence its prompt had
    // handed it.
    const given = wasGivenTheDiff(rec, plan.diffPathAbsolute);
    if (chunk !== null && !given) {
      if (!superseded(rec, chunk)) blindAgents.push(name);
      continue; // Its silence proves nothing about the diff; the prompt failed.
    }

    // Did it work? Zero successful tool calls means it read nothing — whatever
    // its prose says. This is checked BEFORE the Uncoverable claim below, and the
    // order is load-bearing: `Uncoverable: chunk N` is a line the prompt hands the
    // agent, and an honest one requires having read the chunk to discover the line
    // is too long. A zero-tool-call agent that merely copied the template must not
    // be credited with a disclosed gap — that is the whiff wearing a costume.
    if (rec.successfulToolCalls === 0) {
      if (!superseded(rec, chunk)) idleAgents.push(name);
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
    let rewrittenThisRecord = false;
    if (chunk !== null) {
      const b = builtOf(`chunk-${chunk}`);
      if (b === undefined) {
        // No internal command in this label: `compose-review` pushes it into the
        // posted body as-is, and the PR author cannot run `agent-prompt`. The
        // rebuild command rides the rewritten-launches remediation line, on stderr.
        // Suppressed when nothing was built at all — the collapsed roster line
        // already says so once, for the whole run.
        rewrittenThisRecord = true;
        if (!nothingBuiltAtAll && !superseded(rec, chunk)) {
          rewrittenPrompts.push(
            `${name} — ran on a prompt the run wrote itself (none was built for ` +
              `this chunk), so the brief with its method and rules never reached it`,
          );
        }
      } else if (!wasDeliveredVerbatim(rec.launchPrompt, b)) {
        rewrittenThisRecord = true;
        if (!superseded(rec, chunk)) {
          rewrittenPrompts.push(
            `${name} — launched with a prompt that is not the one the CLI built`,
          );
        }
      }
    }

    const told = pointedAt(rec.launchPrompt, plan);

    // Pointed at lines, and never opened the file they live in. It did work, so it
    // is not idle. It just did not do *this* work. Not reported for an agent
    // already flagged rewritten: the repairs contradict (rebuild the prompt vs.
    // relaunch the same one), the rebuild subsumes the relaunch, and an operator
    // handed both for one agent follows whichever came last.
    if (told.length > 0 && rec.diffToolCalls === 0) {
      if (!rewrittenThisRecord && !superseded(rec, chunk)) {
        unopenedAgents.push(name);
      }
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
  // The exact rebuild selector for each missing brief, for stderr: a label like
  // `Test coverage matrix (whole-diff)` does not tell the operator to pass
  // `--role test-matrix`, and guessing wrong means a full-roster rerun.
  const missingRoleSelectors: string[] = [];
  const unreadBriefs: string[] = [];
  const roster = rosterForRun;

  // A role with no recorded prompt says one thing only: the brief never reached an
  // agent. It does *not* say nobody reviewed the dimension — an orchestrator that
  // writes the launch itself gets an agent that runs, reads the diff and reports real
  // findings, having never seen the severity bar or the finding format the brief
  // carries. Dogfooded on #7012: this gate reported all twelve roles "never ran" on a
  // review that posted two Criticals with line numbers. Both readings are bad; they
  // are not the same bad, and they are not fixed the same way, so the text may not
  // pick the one it cannot prove.
  const briefless = roster.filter((r) => !builtOf(r.key));

  // Every role briefless is one failure — the run did not use the prompt builder —
  // not N. Said once per dimension it becomes N lines that bury the single fact
  // explaining all of them, and those N lines are what a PR author reads as the
  // review: on #7012 the whole CHANGES_REQUESTED body was twelve of them, while the
  // findings that needed acting on sat inline, below the fold.
  const nobodyBuiltAnything =
    roster.length > 1 && briefless.length === roster.length;
  if (nobodyBuiltAnything) {
    // Phrased to read under the `Not reviewed: ` prefix `compose-review` renders it
    // with, which is where a PR author meets it.
    missingRoles.push(
      `every dimension — none of the ${roster.length} required agents is on ` +
        `record as launched with a prompt this skill built, so this diff was ` +
        `reviewed, if at all, from prompts the run wrote for itself: no record ` +
        `shows the severity bar, the finding format or this project's own rules ` +
        `reaching an agent`,
    );
  }

  // Injective: one transcript may satisfy ONE roster requirement. Without this,
  // pasting the whole roster output to a single agent yields one transcript that
  // verbatim-contains every block, matches every requirement independently, and
  // certifies an N-agent fan-out with one reader. And injective by MAXIMUM
  // matching, not greedy claim order: with T1 containing blocks A+B and T2
  // containing only A, a greedy pass claims T1 for A and reports B missing while
  // the valid assignment (T2→A, T1→B) exists — a compliant repair permanently
  // capped by transcript order. Kuhn's augmenting paths, seeded on the edges
  // where the transcript also opened the requirement's brief, then extended over
  // all verbatim edges.
  const buildable = roster.filter((r) => builtOf(r.key) !== undefined);
  const openedBrief = (rec: AgentRecord, key: string): boolean => {
    const needle = JSON.stringify(briefPath(planPath, key));
    return rec.successfulCallArgs.some((a) => a.includes(needle));
  };
  const candidatesOf = buildable.map((req) => {
    const b = builtOf(req.key) as string;
    return records.filter((r) => wasDeliveredVerbatim(r.launchPrompt, b));
  });
  const openedOfReq = buildable.map((req, i) =>
    candidatesOf[i].filter((r) => openedBrief(r, req.key)),
  );
  const matchedRec = new Map<AgentRecord, number>();
  const augment = (
    i: number,
    edges: AgentRecord[][],
    seen: Set<AgentRecord>,
  ): boolean => {
    for (const rec of edges[i]) {
      if (seen.has(rec)) continue;
      seen.add(rec);
      const j = matchedRec.get(rec);
      if (j === undefined || augment(j, edges, seen)) {
        matchedRec.set(rec, i);
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < buildable.length; i++) {
    augment(i, openedOfReq, new Set());
  }
  for (let i = 0; i < buildable.length; i++) {
    if (![...matchedRec.values()].includes(i)) {
      augment(i, candidatesOf, new Set());
    }
  }
  const assignment = new Map<number, AgentRecord>();
  for (const [rec, i] of matchedRec) assignment.set(i, rec);

  let buildableIdx = -1;
  for (const req of roster) {
    const b = builtOf(req.key);
    if (b === undefined) {
      if (!nobodyBuiltAnything) {
        missingRoles.push(
          `${roleLabel(req)} — no record shows its brief reaching an agent, so ` +
            `this dimension was reviewed, if at all, from a prompt the run ` +
            `wrote for itself`,
        );
      }
      missingRoleSelectors.push(selectorOf(req));
      continue;
    }
    buildableIdx += 1;
    const pick = assignment.get(buildableIdx);
    if (pick === undefined) {
      // Not assignable even under a MAXIMUM matching — so this is provably a
      // shortage of transcripts, not an artifact of claim order.
      const anyMatch = candidatesOf[buildableIdx].length > 0;
      missingRoles.push(
        anyMatch
          ? `${roleLabel(req)} — its prompt reached only an agent already ` +
              `credited with another block; one agent was given several blocks, ` +
              `and one transcript cannot certify two dimensions`
          : `${roleLabel(req)} — its prompt was built, but no agent on record ` +
              `was launched with it`,
      );
      missingRoleSelectors.push(selectorOf(req));
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
    // The ASSIGNED transcript must have opened this requirement's brief. The
    // matching SEEDS on brief-opening edges, but maximizing satisfied
    // requirements can displace an opened match onto an unopened edge — so an
    // unread flag here describes this assignment, not an impossibility. That is
    // the right trade: missing-role claims stay provable, and an unread brief
    // still caps.
    const opened = pick.successfulCallArgs.some((a) =>
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
    missingRoleSelectors,
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
 * `not-built` — `agent-prompt --role <r>` never ran. Decided before the transcripts
 *   are consulted (there is no brief whose open could be looked for), so it proves
 *   the builder was skipped — NOT that no agent ran: a hand-written launch with no
 *   brief on disk is invisible to this check, and the texts below say "if at all"
 *   because of it.
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

/**
 * Two sentences per failed shape, for two different readers.
 *
 * `gap` goes into the posted review body, under `Not reviewed:` — a PR author
 * reads it, so it says what the review cannot certify and names no internal
 * command (`agent-prompt --findings …` is not something an author can run, and on
 * #7012 fourteen lines of exactly that register WERE the public review). `fix` is
 * the per-shape remediation, printed to stderr where the orchestrator reads — the
 * four shapes exist because the four fixes differ, and that precision belongs to
 * the reader who relaunches agents, not the one who reads the verdict.
 */
interface GapEntry {
  /** Author-facing: what this review cannot certify, and why. */
  gap: string;
  /** Orchestrator-facing: the exact fix, printed to stderr. */
  fix: string;
}
type GapText = Record<Exclude<Delivery, 'ok'>, GapEntry>;

/**
 * The one rebuild command, spelled once. Role-aware where the roles genuinely
 * differ: an empty findings file is a legitimate early reverse-audit round and a
 * vacuous verification — a verifier that saw no findings clears the delivery
 * floor while verifying nothing, so the verify advice must not invite it. And
 * `--rules` rides along in both: `agent-prompt` rewrites the brief on every
 * build, so a rebuild without the rules file silently ships a rules-free brief
 * that every delivery check still passes.
 */
const rebuildFix = (role: 'verify' | 'reverse-audit', noun: string): string =>
  `build the prompt with \`"\${QWEN_CODE_CLI:-qwen}" review agent-prompt ` +
  `--plan <plan> --role ${role} --findings <file> [--rules <rules file>]\` ` +
  (role === 'reverse-audit'
    ? `(an early round with nothing confirmed passes an empty file; `
    : `(pass the shard's findings, never an empty file — a verifier that sees ` +
      `no findings verifies nothing; `) +
  `pass --rules whenever the review loaded any, or the rebuilt brief silently ` +
  `drops the project rules) and launch an agent with EXACTLY what it prints — ` +
  `no ${noun} number, no summary of your own, no rewording`;

const REVERSE_AUDIT_GAP: GapText = {
  // Not "no auditor ran": a run that skipped the builder and hand-wrote the
  // launch leaves no brief file to open, so this shape is reached before the
  // transcripts are ever consulted — the check cannot see that auditor, and it
  // may not claim to. Same honest construction as the roster texts: what is
  // provable ("no brief was built"), then what that costs ("if at all").
  'not-built': {
    gap:
      'no auditor was launched with a prompt this skill builds — the pass ' +
      'that hunts what the rest of the review missed ran, if at all, without ' +
      'the method its brief carries',
    fix: rebuildFix('reverse-audit', 'round'),
  },
  // Same reach limit as `not-built`: a hand-written auditor that never opened
  // the brief lands here too (`rewritten` requires the brief-open), so this text
  // may not claim the pass did not run — only that it cannot be certified.
  'not-launched': {
    gap:
      'its prompt was built, but no agent was launched with it — the pass ' +
      'that hunts what the rest of the review missed ran, if at all, without ' +
      'the method its brief carries, and cannot be certified',
    fix: rebuildFix('reverse-audit', 'round'),
  },
  // `rewritten` is reached only after a successful call OPENED the brief — so
  // this text may not claim the method never arrived; the brief carries it, and
  // it demonstrably did. What is missing is the launch the CLI built: the folded
  // findings, the exact ranges, the guarantee the skill certifies against.
  rewritten: {
    gap:
      'an auditor ran and opened its brief, but no agent was launched with the ' +
      'prompt the CLI built — the launch was written by hand, and what the ' +
      'agent was actually asked is not what this skill certifies',
    fix: rebuildFix('reverse-audit', 'round'),
  },
  'brief-unread': {
    gap:
      'it was launched with the built prompt but never opened its brief, so it ' +
      'audited without the gaps-only method and the finding format it was ' +
      'launched to follow',
    fix:
      'relaunch with the same printed prompt — the agent must OPEN the brief ' +
      'file the prompt names; that read is the receipt',
  },
};

const VERIFY_GAP: GapText = {
  // Same reach limit as the reverse-audit text above: `not-built` is decided
  // before the transcripts are consulted, so it may not assert nobody ran.
  'not-built': {
    gap:
      'the review posts findings, but no verifier was launched with a prompt ' +
      'this skill builds — they were ruled on, if at all, without the verdict ' +
      'bar its brief carries',
    fix: rebuildFix('verify', 'shard'),
  },
  'not-launched': {
    gap:
      'its prompt was built, but no agent was launched with it, so the posted ' +
      'findings cannot be counted as verified',
    fix: rebuildFix('verify', 'shard'),
  },
  rewritten: {
    gap:
      'a verifier ran and opened its brief, but no agent was launched with the ' +
      'prompt the CLI built — the launch was written by hand, and the posted ' +
      'findings cannot be counted as verified against it',
    fix: rebuildFix('verify', 'shard'),
  },
  'brief-unread': {
    gap:
      'it was launched with the built prompt but never opened its brief, so it ' +
      'ruled on the findings without the verdict bar it was launched to apply',
    fix:
      'relaunch with the same printed prompt — the agent must OPEN the brief ' +
      'file the prompt names; that read is the receipt',
  },
};

export interface VerificationReport {
  /** True when every required Step 4/5 agent ran and read its brief. */
  ok: boolean;
  /**
   * Self-explanatory gap lines, shaped to drop straight into
   * `unreviewedDimensions` — each carries its own ` — ` reason, so
   * `compose-review` renders it verbatim rather than appending the whiff sentence.
   * These reach the POSTED review body: author-facing register, no internal
   * commands.
   */
  gaps: string[];
  /**
   * The per-shape fix for each gap, in the same order — for stderr, where the
   * orchestrator reads. Never rendered into the body.
   */
  remediation: string[];
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
  const remediation: string[] = [];

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
    gaps.push(`reverse audit — ${REVERSE_AUDIT_GAP[reverse].gap}`);
    // The fix template carries `--plan <plan>`; a literal `<plan>` pasted into a
    // POSIX shell parses as input redirection, so the one repair round Step 6
    // prescribes could never run. This function is handed the real path.
    remediation.push(
      `reverse audit: ${REVERSE_AUDIT_GAP[reverse].fix.replace(
        '--plan <plan>',
        () => `--plan '${planPath}'`,
      )}`,
    );
  }

  // Step 4: verify. Required when the review posts a finding a verifier rules on —
  // an unverified finding must not become a public blocker (the false "this PR now
  // leaks tokens" Critical is the exact harm). Whether it does is `opts.postsFindings`,
  // decided by the caller: `compose-review` counts the anchored findings and the
  // non-deterministic body Criticals, and excludes deterministic `[build]`/`[test]`
  // findings, which are pre-confirmed and skip verification by design. A review that
  // confirmed nothing has nothing to verify.
  if (opts.postsFindings) {
    // The whole key family: `verify--<digest>` per shard (the record now folds
    // the findings in, so a launch that dropped them matches nothing), plus the
    // bare legacy key. Floor of one, as documented.
    const verifyKeys = [...built.keys()].filter(
      (k) => k === 'verify' || k.startsWith('verify--'),
    );
    const verify = bestDelivery(verifyKeys);
    if (verify !== 'ok') {
      gaps.push(`verification — ${VERIFY_GAP[verify].gap}`);
      remediation.push(
        `verification: ${VERIFY_GAP[verify].fix.replace(
          '--plan <plan>',
          // A function replacer: a plain string gives `$&`/`$\`` special
          // meaning, and a path is not a place for replacement patterns.
          () => `--plan '${planPath}'`,
        )}`,
      );
    }
  }

  return { ok: gaps.length === 0, gaps, remediation };
}

export { TranscriptsUnavailableError };
