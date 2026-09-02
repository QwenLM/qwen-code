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
  readRunTranscripts,
  wasGivenTheDiff,
  TranscriptsUnavailableError,
  type AgentRecord,
} from './transcripts.js';
import {
  readRecordedPrompts,
  wasDeliveredVerbatim,
  briefPath,
  findingsPointerOf,
  findingsFilePath,
  recordedPromptPath,
} from './prompt-record.js';
import {
  declaredUncoverableChunkIds,
  declaresOwnUncoverable,
  openedBrief,
  readFindingsPointer,
} from './certification.js';
import {
  requiredAgents,
  type RequiredAgent,
  type RosterPlan,
} from './roster.js';
import { BRIEFS } from './agent-briefs.js';
import { labelFromLaunchPrompt } from './agent-identity.js';
import {
  chunkIdsProblem,
  READ_FILE_CHAR_CAP,
  type DiffChunk,
} from './diff-plan.js';
import {
  launchPlanToken,
  planIdentityToken,
  selectionDrift,
  type SelectionDrift,
} from './selection.js';
import { readBudgetStop } from './deadline.js';
import { budgetGapDisclosures } from './budget.js';
import { shellQuotePath } from './shell-quote.js';

/**
 * What became of one planned chunk. The four values partition `plannedChunks`:
 * every planned id lands in exactly one, and no id lands in two.
 *
 * `recovered` is a form of covered, split out rather than folded in because a
 * resumed run's continuity note reports it and a reader deciding whether to
 * trust a resume needs to see which chunks THIS attempt read. Nothing caps on
 * the distinction — `assertChunkPartition` treats both as covered scope.
 */
export type ChunkOutcome = 'covered' | 'recovered' | 'uncoverable' | 'missing';

/**
 * Why a chunk was not covered — a closed set, so a consumer can switch on it.
 *
 * These are the coverage-walk's `continue` points, named. Each one already
 * produced a prose entry in one of the agent-keyed arrays above; this is the
 * same fact keyed by CHUNK instead, which is the key a reader asking "why was
 * chunk 7 not reviewed" actually holds. Deriving it by parsing the prose back
 * was the alternative, and a label is not a contract.
 *
 * Deliberately NOT in this set: a disclosed budget gap and an unread brief. A
 * budget gap costs no coverage (the agent read its chunk and said where it
 * stopped), and `unreadBriefs` is a roster fact about roles, not chunks.
 * Putting either here would report a covered chunk as a failed one.
 */
export type ChunkFailureClass =
  /** No record in this run was assigned to the chunk at all. */
  | 'no-agent'
  /** Launched with a prompt that never named the diff: it could not have read it. */
  | 'blind-prompt'
  /** Zero successful tool calls: it read nothing. */
  | 'idle'
  /** Worked, but never opened the diff it was pointed at. */
  | 'unopened'
  /** Delivered a prompt that is not the one the CLI built for it. */
  | 'rewritten-prompt'
  /** An agent declared the chunk unreachable (oversized line, no read can span it). */
  | 'declared-uncoverable'
  /**
   * The chunk had records, none of them tripped a named cause, and it still
   * came out uncovered. Mandatory catch-all: an unclassifiable gap must be
   * reportable as one, not silently absent from the ledger.
   */
  | 'unknown';

/**
 * The closed failure vocabulary, as a value. `ChunkFailureClass` the type is
 * compile-time only; the persistence boundary (`save-artifact`) validates a
 * hand-editable file against THIS list, so a corrupted or hand-written
 * classification is refused there instead of laundering an out-of-vocabulary
 * string into the sealed ledger's type.
 */
export const CHUNK_FAILURE_CLASSES = [
  'no-agent',
  'blind-prompt',
  'idle',
  'unopened',
  'rewritten-prompt',
  'declared-uncoverable',
  'unknown',
] as const satisfies readonly ChunkFailureClass[];

/** One planned chunk's entry in the coverage ledger. */
export interface ChunkCoverageItem {
  id: number;
  /** The source files this chunk spans; empty on a plan written before chunks carried them. */
  files: string[];
  outcome: ChunkOutcome;
  /** Set only on `missing` and `uncoverable`; absent on covered scope. */
  classification?: ChunkFailureClass;
  /**
   * The agent labels this run recorded as the chunk's OWNERS, in walk order:
   * every record whose `chunk N of M` launch assigned it the chunk, plus a
   * paraphrased launch whose declaration of the chunk was admitted. Present on
   * every outcome — on a missing chunk it says who was sent for these lines
   * and did not read them.
   *
   * Deliberately NOT every reader whose range spanned the chunk. A whole-diff
   * agent spans every chunk by construction, and naming it on each would make
   * the field say "who happened to contain these lines" instead of "who was
   * sent for them" — the same label on every entry, distinguishing nothing.
   * So a covered chunk whose only reader was a whole-diff agent carries `[]`:
   * the coverage came from a spanning read, not from an owner, and the
   * `covered` outcome is what records the read. Settled as the ledger's
   * contract on #9768 (R8-4 / R19-2, owner-only) and pinned by
   * `names owners, not spanning readers` in `check-coverage.test.ts`.
   */
  agents: string[];
}

/**
 * The chunk ledger contradicted the plan it was built from.
 *
 * Its own class because `compose-review` renders a coverage failure's cause to
 * the reader, and the two it already distinguishes — an unusable plan and
 * unreadable transcripts — are both facts about the environment. This is a
 * defect in this file. All three cap the verdict; none may wear another's
 * message.
 */
export class ChunkPartitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChunkPartitionError';
  }
}

/**
 * Every planned chunk appears exactly once, and nothing else appears at all.
 *
 * Unreachable from any input: the sets this checks are built by one walk over
 * one plan, and the only id that enters them from outside — a launch text's
 * `chunk N of M`, on its way into `uncoverable` — is checked against the plan
 * first. That is the reason to assert it rather than the reason not to — an
 * unreachable invariant is exactly the kind that stops holding silently, and
 * every coverage figure downstream is a ratio whose denominator is this set.
 */
export function assertChunkPartition(
  planned: readonly number[],
  items: readonly ChunkCoverageItem[],
  /**
   * The three id arrays this report exports, cross-checked against the ledger.
   *
   * Without this the assertion would only prove the ledger self-consistent, and
   * the ledger is built from the same sets it would be checking — a second
   * derivation that cannot disagree with the first proves nothing, which is the
   * defect this whole change exists to remove from `check-coverage`'s
   * denominator. `missing` in particular is computed by its own filter over
   * `planned`, so this is the one comparison that can catch that filter
   * changing.
   */
  reported: {
    covered: readonly number[];
    missing: readonly number[];
    uncoverable: readonly number[];
  },
): void {
  const fail = (why: string): never => {
    throw new ChunkPartitionError(
      `coverage: chunk ledger does not partition the plan — ${why}. ` +
        `planned=[${planned.join(', ')}] ` +
        `ledger=[${items.map((i) => `${i.id}:${i.outcome}`).join(', ')}]`,
    );
  };
  const seen = new Set<number>();
  for (const item of items) {
    if (seen.has(item.id)) fail(`chunk ${item.id} appears twice`);
    seen.add(item.id);
  }
  const plannedSet = new Set(planned);
  for (const id of seen) {
    if (!plannedSet.has(id))
      fail(`chunk ${id} is in the ledger but not the plan`);
  }
  for (const id of plannedSet) {
    if (!seen.has(id)) fail(`chunk ${id} is in the plan but not the ledger`);
  }
  // An outcome outside the union is how a new value gets added to `ChunkOutcome`
  // and forgotten here; a `missing`/`uncoverable` entry with no classification
  // is the ledger declining to say why, which is the whole point of the field.
  for (const item of items) {
    if (
      item.outcome !== 'covered' &&
      item.outcome !== 'recovered' &&
      item.outcome !== 'uncoverable' &&
      item.outcome !== 'missing'
    ) {
      fail(
        `chunk ${item.id} has an unknown outcome ${JSON.stringify(item.outcome)}`,
      );
    }
    const needsCause =
      item.outcome === 'missing' || item.outcome === 'uncoverable';
    if (needsCause && item.classification === undefined) {
      fail(`chunk ${item.id} is ${item.outcome} with no classification`);
    }
    if (!needsCause && item.classification !== undefined) {
      fail(`chunk ${item.id} is ${item.outcome} but carries a failure class`);
    }
  }

  // The ledger against the arrays every existing consumer reads. `covered`
  // takes both covered outcomes: the recovered/live split is a provenance
  // detail this report adds, not a change to what counts as reviewed.
  const ledgerIds = (...outcomes: ChunkOutcome[]): number[] =>
    items
      .filter((i) => outcomes.includes(i.outcome))
      .map((i) => i.id)
      .sort((a, b) => a - b);
  const sameIds = (a: readonly number[], b: readonly number[]): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  const pairs: Array<[string, readonly number[], number[]]> = [
    [
      'covered',
      [...reported.covered].sort((a, b) => a - b),
      ledgerIds('covered', 'recovered'),
    ],
    [
      'missing',
      [...reported.missing].sort((a, b) => a - b),
      ledgerIds('missing'),
    ],
    [
      'uncoverable',
      [...reported.uncoverable].sort((a, b) => a - b),
      ledgerIds('uncoverable'),
    ],
  ];
  for (const [name, exported, ledger] of pairs) {
    if (!sameIds(exported, ledger)) {
      fail(
        `${name} disagrees with the ledger — ` +
          `reported=[${exported.join(', ')}] ledger=[${ledger.join(', ')}]`,
      );
    }
  }
}

export interface CoverageFromTranscripts {
  /** True only when every chunk was reviewed by an agent that could and did. */
  ok: boolean;
  /** How many subagent transcripts the harness wrote for this run. */
  agents: number;
  /**
   * Agents whose certified work came from an EARLIER attempt's session — a
   * resumed run crediting the interrupted attempt's evidence. Zero on any run
   * that never resumed; reading the prior directory grants nothing by itself.
   *
   * The bar is a STRICT SUBSET of the live credit bars, deliberately: a
   * verbatim-delivered CLI prompt plus an opened brief or diff, with none of
   * the drift rescues. Those rescues exist so a run is not made to relaunch
   * agents over a normalized word — they protect work this run can still
   * see. This number only reports how much a continuation reused, it caps
   * nothing (compose-review renders it as a non-capping note), so it should
   * under-claim rather than announce reuse the pairing cannot fully vouch
   * for. Coverage itself still applies its own rescue-inclusive bars to the
   * same records, so nothing is under-credited where credit decides
   * anything.
   */
  recoveredAgents: number;
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
   * Launches whose prompt drifted from the built block while the payload
   * provably arrived anyway: the transcript shows the agent opened the brief
   * the block points at and did the work (a chunk agent also opened the
   * diff). The brief is where the method, the severity bar and the project
   * rules live — the launch prompt is a pointer to it — so a drifted pointer
   * with a proven brief-read is a NOTE, never a failure and never a
   * relaunch. Measured: a model asked to copy twelve blocks normalized one
   * word in every block's tail ("you" → "it"), every role failed the
   * verbatim match, and the run relaunched all twelve agents — the most
   * expensive repair in the pipeline, spent redelivering text the agents had
   * already acted on.
   */
  driftedLaunches: string[];
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
  /**
   * `Budget gap: <the check>` lines parsed from agent returns — the fixed
   * disclosure format the tool-budget brief mandates when an agent's soft
   * ceiling stopped a check it wanted. Detection is deterministic (this
   * parse); the RULING stays with the orchestrator, exactly as it does for
   * whiffs: a gap naming an incomplete required trace joins
   * `unreviewedDimensions` and caps Approve, a gap naming optional depth is
   * disclosed in the report. An empty list on a budgeted run means no agent
   * hit its ceiling mid-check.
   */
  budgetGaps: Array<{ agent: string; gaps: string[] }>;
  /** Chunk ids a working agent actually reviewed. */
  coveredChunks: number[];
  /**
   * The pre-formed disclosure entries (`rewrittenPrompts`, `missingRoles`,
   * `unreadBriefs`), as `{subject, reason}` pairs in push order — for
   * `compose-review`, which dedupes caller echoes by subject and groups
   * same-reason subjects into one sentence. The prose twins above remain for
   * the stderr formatting; REPARSING them was the bug: a reason is free-form
   * text (labels carry ` — ` for an invariant's file, error interpolations
   * can carry anything), so a subject/reason boundary recovered from rendered
   * prose garbles exactly the entries it matters for.
   */
  disclosures: Array<{
    subject: string;
    reason: string;
    /**
     * The subject, said in the POSTED body's register (`Brief.publicLabel`) —
     * absent when the internal subject already is that register (`chunk N`
     * is translated downstream by `describeChunkGap`; `every dimension`,
     * `coverage` and the Step 4/5 subjects are plain English). The internal
     * `subject` stays the dedup and certification key, and the stderr twin
     * keeps it: the codename is the selector an operator acts on.
     */
    publicSubject?: string;
    /**
     * The reason for the POSTED body, when the internal one carries something
     * only an operator can use — today, the unread brief's filesystem path.
     */
    publicReason?: string;
    /**
     * The printed subject and reason, for the Chinese half of a bilingual
     * body (the plan's `prDescriptionHasHan`). `subjectZh` is absent for
     * chunk subjects — the chunk collapse translates those — and for
     * subjects with no Chinese variant the renderer falls back to the
     * English text rather than dropping the disclosure.
     */
    subjectZh?: string;
    reasonZh?: string;
  }>;
  /**
   * Every planned chunk with the source files it covers, in plan order — the
   * body renderer's translation table. A chunk id is the run's own
   * bookkeeping: it selects a rebuild command on stderr, and nothing on the PR
   * page maps it to code, so the POSTED body names files (the author's units)
   * or counts against this list's length instead. The ids themselves stay in
   * the structural entries — the caps, the dedup and the remediation
   * selectors all still key on them. `files` is empty for a plan written
   * before chunks carried them.
   */
  plannedChunks: Array<{ id: number; files: string[] }>;
  /**
   * The per-chunk ledger: one entry per `plannedChunks` id, carrying what
   * became of it and — when it was not covered — why.
   *
   * `coveredChunks` / `missingChunks` / `uncoverableChunks` remain, and remain
   * the fields every existing consumer reads. This adds nothing they cannot
   * already be derived from except the CLASSIFICATION, which they cannot: the
   * reason a chunk went uncovered lives in the agent-keyed prose arrays, and
   * an id in `missingChunks` carries no pointer into them. A consumer asking
   * "why was chunk 7 not reviewed" had to read stderr and match by hand.
   *
   * Ordered by chunk id, so a diff of two runs' ledgers lines up.
   */
  chunkItems: ChunkCoverageItem[];
  /**
   * Why the plan no longer describes the diff its chunks index into, or `null`
   * when it still does — and on a plan too old to carry an identity at all,
   * which is absence of evidence rather than evidence of drift.
   *
   * Disclosed, never capping. The check has never fired on a real run, and a
   * predicate whose false-positive rate nobody has measured does not get to
   * block a review; `check-coverage` prints it as a NOTE. When runs show what
   * it costs, making it a cap — or dropping it — becomes a decision with
   * evidence behind it.
   */
  selectionDrift: string | null;
}

/** The plan, as far as coverage needs it. The roster reads more of it — see RosterPlan. */
interface Plan {
  diffPathAbsolute: string;
  chunks: Array<{
    id: number;
    startLine: number;
    endLine: number;
    files?: Array<{ path: string }>;
    /**
     * Longest single line in the range. Every plan the planner has ever
     * written carries it; the read stays loose for hand-edited plans, and
     * the refutation guard below fails closed on the absence.
     */
    maxLineChars?: number;
  }>;
}

function readPlan(path: string): {
  plan: Plan;
  mtimeMs: number;
  drift: SelectionDrift;
} {
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
  const problem = chunkIdsProblem(plan.chunks.map((c) => c?.id));
  if (problem) {
    throw new Error(`coverage: ${path} has ${problem}`);
  }
  // Does the plan still describe the diff it was planned over? Reported, never
  // thrown — see `selectionDrift`'s own note on why an unmeasured predicate
  // does not get to refuse a review. An unreadable diff is not "no drift"
  // either, on a plan that carries an identity: `null` means the identity was
  // checked and everything matched, and this read is the ONLY read of the
  // diff — neither consumer of this function reads the file again. Collapsing
  // the failure to `null` certified over a file that may have been rewritten
  // or deleted since the agents ran, the one mutation the identity exists to
  // catch. An identity-less plan checks nothing, so an unreadable file stays
  // `null` there — the same absence rule `selectionDrift` itself states.
  let drift: SelectionDrift = null;
  const identity = (plan as { selection?: unknown }).selection;
  if (identity !== undefined && identity !== null) {
    try {
      drift = selectionDrift(
        identity,
        readFileSync(plan.diffPathAbsolute, 'utf8'),
        plan.chunks as unknown as DiffChunk[],
      );
    } catch {
      drift =
        `the diff file at ${plan.diffPathAbsolute} could not be read when ` +
        'the selection identity was checked, so the plan’s chunk ranges ' +
        'could not be verified against it — re-capture the diff and re-plan';
    }
  }
  return { plan, mtimeMs: statSync(path).mtimeMs, drift };
}

/**
 * How far apart the shard keys of ONE findings digest may be written.
 *
 * The round builder writes a digest's records in one pass, so they land within
 * milliseconds; a previous list's records are a round apart at minimum. Wide
 * enough to keep a slow write together, far narrower than the gap it must
 * separate.
 */
const DIGEST_WINDOW_MS = 5000;

/**
 * The chunk assignment, read from the identity line `agent-prompt` writes —
 * `` You are review agent `chunk 13 of 25` `` — anchored to that line's
 * shape. The words `chunk N of M` anywhere else in a launch are not an
 * assignment: `buildRoleLaunchPrompt` renders a PR-controlled filename on
 * the identity line (`inertPath` preserves spaces, colons and digits), so a
 * file named `chunk 2 of 5.ts` carries the phrase, and an unanchored read
 * would take it as the record's assignment. A filename cannot forge the
 * anchored shape — `inertPath` strips backticks.
 *
 * The assignment is the FIRST line-anchored identity line, not an index-0
 * match: orchestrators prepend context lines to the launches they deliver —
 * the one-sentence change summary the skill tells them to add; measured,
 * every chunk launch in a dogfooded session carried one — and an index-0
 * read stripped the assignment from every such record, skipping the
 * declaration branch, so an honest `Uncoverable:` return was dropped and
 * its chunk certified COVERED off the told-range presumption. The same
 * scan `labelFromLaunchPrompt` uses: a prepended context line is prose and
 * never matches, so the launch's own identity line is still the first hit,
 * and a forged line APPENDED below it cannot take the assignment.
 */
export const CHUNK_RE = /^You are review agent `chunk (\d+) of (\d+)`/m;

/** The chunk this agent owns, when it was launched to own one. */
export function assignedChunk(rec: AgentRecord): number | null {
  const m = CHUNK_RE.exec(rec.launchPrompt);
  return m ? Number(m[1]) : null;
}

/**
 * The chunk count this launch was written against — the plan identity of a
 * `chunk N of M` assignment, beside the id `assignedChunk` reads. A stale
 * declaration from a re-plan's old chunking can carry an id that collides
 * with a planned chunk; the count is what tells the plans apart.
 */
function assignedChunkTotal(rec: AgentRecord): number | null {
  const m = CHUNK_RE.exec(rec.launchPrompt);
  return m ? Number(m[2]) : null;
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
export function pointedAt(
  prompt: string,
  plan: { chunks: Array<{ id: number; startLine: number; endLine: number }> },
): Array<[number, number]> {
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

/** The exact rebuild flags for one required agent — operator-facing (stderr). */
function selectorOf(req: RequiredAgent): string {
  if (req.role === 'chunk') return `--chunk ${req.chunk}`;
  // The file path is copy-pasted into a shell like the plan path is — a heavy
  // file under a space-bearing directory would split the selector unquoted.
  return req.file
    ? `--role ${req.role} --file ${shellQuotePath(req.file)}`
    : `--role ${req.role}`;
}

/** A required agent, named the way a reader has to act on it. */
function roleLabel(req: RequiredAgent): string {
  if (req.role === 'chunk') return `chunk ${req.chunk}`;
  const base = BRIEFS[req.role].label;
  return req.file ? `${base} — ${req.file}` : base;
}

/**
 * The same requirement, named for the PR author — or undefined when the
 * internal label already is that register. A chunk requirement stays `chunk N`
 * here on purpose: the body renderer translates chunk ids collectively
 * (`describeChunkGap`), and a public subject would hide the id from that
 * partition. The invariant agents' file rides `on`, not ` — `: in the posted
 * sentence an em-dash reads as the subject/reason boundary.
 */
function publicRoleLabel(req: RequiredAgent): string | undefined {
  if (req.role === 'chunk') return undefined;
  const base = BRIEFS[req.role].publicLabel;
  return req.file ? `${base} on ${req.file}` : base;
}

/** `publicRoleLabel`, for the Chinese half of a bilingual body. */
function publicRoleLabelZh(req: RequiredAgent): string | undefined {
  if (req.role === 'chunk') return undefined;
  const base = BRIEFS[req.role].publicLabelZh;
  return req.file ? `${base}（${req.file}）` : base;
}

/**
 * Something a reader can act on. `agentName` is the launched subagent type,
 * so it is uniformly uninformative here but not a fixed string: `review-agent`
 * on runs since the review skill switched types, `general-purpose` on records
 * written before it. Do not match on either value — the identity line below is
 * what names an agent.
 */
function label(rec: AgentRecord, chunk: number | null): string {
  if (chunk !== null) return `chunk ${chunk}`;
  // The identity line names the agent wherever it sits: launchers prepend
  // context lines, and a first-line-only read has labelled twelve finders
  // with one shared PR-summary sentence — every disclosure then rendered
  // the same truncated PR quote instead of a name a reader can act on. The
  // parser is shared with cost-ledger's row labels, so the round and
  // owned-file suffixes survive here too — two reverse-audit rounds must
  // not fold into one indistinguishable disclosure line.
  const identity = labelFromLaunchPrompt(rec.launchPrompt);
  if (identity !== null) return identity;
  const first = rec.launchPrompt.split('\n')[0]?.trim() ?? '';
  if (first) return first.replace(/\s+/g, ' ');
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
  const { plan, mtimeMs, drift: selectionDriftReason } = readPlan(planPath);
  // The RUN's transcripts, not the session's: a resumed run (`--resume`)
  // continues in a new session, and the interrupted attempt's evidence lives
  // under the session id the run ledger recorded. Same fence (the plan's
  // mtime), which a resume deliberately leaves untouched.
  // `currentDirOptional`: a resumed continuation that recovered everything and
  // launched nothing has no current-session dir yet (the harness creates it on
  // the first launch), and this gate must read the prior attempt's evidence
  // rather than refusing as broken infrastructure. Only ENOENT is absorbed.
  const allRecords = readRunTranscripts(
    planPath,
    mtimeMs,
    env,
    plan.diffPathAbsolute,
    { currentDirOptional: true },
  );
  const records = liveRecords(allRecords);
  const built = readRecordedPrompts(planPath);
  // The plan's epoch token — see `planIdentityToken`. `null` on a plan with
  // no readable identity: the seal below fails open on absence, the same
  // rule the drift check states.
  const planToken = planIdentityToken(
    (plan as { selection?: unknown }).selection,
  );

  const blindAgents: string[] = [];
  const idleAgents: string[] = [];
  const unopenedAgents: string[] = [];
  const rewrittenPrompts: string[] = [];
  const driftedLaunches: string[] = [];
  // Used by the verbatim-drift rescue in both the chunk loop and the roster
  // walk, and by the roster's matching seed below.
  const openedBriefOf = (rec: AgentRecord, key: string): boolean =>
    openedBrief(rec, planPath, key);
  const disclosures: CoverageFromTranscripts['disclosures'] = [];
  // The one source for both registers: the structural entry feeds the posted
  // body (compose-review), and the returned prose feeds the stderr arrays —
  // maintained as a pair, an edit to one and not the other would silently
  // diverge what the operator reads from what the author was told. `pub`
  // carries the body-register variants; the returned prose always keeps the
  // internal subject and reason, because stderr is where the codename and the
  // path are the things a reader acts on.
  const disclose = (
    subject: string,
    reason: string,
    pub?: {
      subject?: string;
      reason?: string;
      subjectZh?: string;
      reasonZh?: string;
    },
  ): string => {
    disclosures.push({
      subject,
      reason,
      publicSubject: pub?.subject,
      publicReason: pub?.reason,
      subjectZh: pub?.subjectZh,
      reasonZh: pub?.reasonZh,
    });
    return `${subject} — ${reason}`;
  };
  const covered = new Set<number>();
  const uncoverable = new Set<number>();
  /**
   * Chunks a record from THIS session covered — the `covered` set minus the
   * chunks only a prior attempt's records earned. `liveRecords` keeps a prior
   * record that returned, so it walks and can earn coverage like any other;
   * the split is what lets the ledger say `recovered` instead of `covered`
   * without a second walk.
   */
  const coveredLive = new Set<number>();
  /**
   * Every agent label the walk saw against a chunk, and every named cause a
   * chunk's records tripped. Collected as the walk runs rather than recovered
   * afterwards by parsing the prose arrays back: those entries are suppressed
   * when a record is superseded, so a chunk whose only failing record lost to
   * a relaunch would leave no trace to parse — while the chunk itself may
   * still be uncovered for a different reason.
   */
  const chunkAgents = new Map<number, string[]>();
  const chunkCauses = new Map<number, Set<ChunkFailureClass>>();
  // Was this launch written against THIS plan? An identity-carrying plan
  // writes its epoch token into every chunk launch it builds
  // (`buildChunkLaunchPrompt`): a launch marked with ANOTHER plan's token
  // is positively the old plan's, which windows, counts and reads cannot
  // prove — a modify-only re-plan keeps every window, so a fence-surviving
  // record of the old plan passes the geometry seals with its old cause
  // intact. Fail CLOSED on a marker-less launch: one from before the
  // mechanism, or a paraphrase that dropped the line, carries nothing
  // tying it to this plan's lines — geometry cannot tell the plans apart
  // over a modify-only re-plan, and the chunk-less arms carry no geometry
  // at all (a whole-diff read spans every window by construction). A plan
  // with no identity checks nothing, the absence rule the drift check
  // states. ONE predicate for every admission path: the seal below, the
  // note arms, the declaration arms, the budget-gap gate, the credit gate
  // and the rescue all ride it — the fail-open twin that preceded it left
  // exactly the arms still riding it admitting stale records (R20-6,
  // R21-8, R22-1, R22-3).
  const markedOfThisPlan = (launch: string): boolean =>
    planToken === null || launchPlanToken(launch) === planToken;
  // The plan identity a `chunk N of M` launch was written against. A stale
  // record's id can collide with a planned chunk's, and a cause or agent
  // keyed through the collision writes an old plan's diagnosis into this
  // plan's ledger: `classify()` then hands the operator a repair for a
  // failure this run never had, and a stale cause can outrank the chunk's
  // genuine current one. Stale records still feed the prose arrays — those
  // name the RECORD — but may not key causes or agents into a chunk they
  // were never assigned under this plan.
  //
  // Membership, count and token are not the whole of that identity: two
  // plans can share a count while chunking different lines, and a
  // same-session re-plan can keep BOTH count and token facts out of reach —
  // two chunks stay two chunks while their windows move. Territory tells
  // the plans apart where the count cannot — see
  // `declarationStillOnTerritory`. Every launch this CLI builds spells its
  // chunk's whole window, so an honest record's told-range spans its chunk
  // exactly; a launch that spells no read resolves through the current plan
  // inside `pointedAt` and still passes. The token conjunct fails closed
  // with `markedOfThisPlan`: a marker-less launch over an identity-carrying
  // plan cannot prove it belongs to this plan whatever its geometry, the
  // same posture as the chunk-less arms (R22-3).
  const sealedToThisPlan = (rec: AgentRecord, chunkId: number): boolean =>
    plan.chunks.some((c) => c.id === chunkId) &&
    assignedChunkTotal(rec) === plan.chunks.length &&
    markedOfThisPlan(rec.launchPrompt) &&
    declarationStillOnTerritory(pointedAt(rec.launchPrompt, plan), chunkId);
  const noteChunkAgent = (
    rec: AgentRecord,
    c: number | null,
    name: string,
  ): void => {
    if (c === null || !sealedToThisPlan(rec, c)) return;
    const seen = chunkAgents.get(c);
    if (seen === undefined) chunkAgents.set(c, [name]);
    else if (!seen.includes(name)) seen.push(name);
  };
  const noteChunkCause = (
    rec: AgentRecord,
    c: number | null,
    cls: ChunkFailureClass,
  ): void => {
    if (c === null || !sealedToThisPlan(rec, c)) return;
    const seen = chunkCauses.get(c);
    if (seen === undefined) chunkCauses.set(c, new Set([cls]));
    else seen.add(cls);
  };

  // Hoisted from the roster section below: when NO role was briefed at all, the
  // roster collapses to one line covering the whole run, and repeating "none was
  // built" once per chunk transcript would put N more copies of the same fact
  // into the posted body, right next to the line that already states it.
  // The roster reads the effort from the plan itself (`plan.effort`, written by
  // the capturing command), so this recomputation — and `compose-review`'s, which
  // calls the same helper with no effort argument — agree with `check-coverage`
  // on a medium run automatically. No effort is threaded through here.
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
  // `only` narrows WHICH records may supersede. Left open (the default) for
  // the gap and uncoverable walks, where any qualifying record is a genuine
  // repair whichever attempt ran it; narrowed to the current session for the
  // recovery COUNT — see `supersededByCurrent`.
  const chunkSatisfied = (
    c: number,
    self: AgentRecord,
    only: (r: AgentRecord) => boolean = () => true,
  ): boolean => {
    const b = builtOf(`chunk-${c}`);
    if (b === undefined) return false;
    return records.some(
      (r) =>
        r !== self &&
        only(r) &&
        // A superseding record must have RETURNED. Current-session records
        // with empty finalText stay in `records` for the idle checks, and
        // without this a verbatim relaunch that read the diff once and died
        // mid-flight (a) suppressed an honest `Uncoverable:` declaration and
        // earned the chunk off the told-range presumption, (b) let two
        // honest declarations of one chunk annihilate into `missingChunks`,
        // and (c) silenced a prior attempt's `Budget gap:` disclosure as a
        // "genuine repair" — three symptoms of the one missing requirement
        // `certifies()` and `liveRecords()` already impose.
        r.returned &&
        assignedChunk(r) === c &&
        wasDeliveredVerbatim(r.launchPrompt, b) &&
        r.diffToolCalls > 0,
    );
  };
  const keySatisfied = (
    rec: AgentRecord,
    only: (r: AgentRecord) => boolean = () => true,
  ): boolean => {
    for (const key of built.keys()) {
      const b = builtOf(key);
      if (b === undefined) continue;
      if (!wasDeliveredVerbatim(rec.launchPrompt, b)) continue;
      if (
        records.some(
          (r) =>
            r !== rec &&
            only(r) &&
            // Same return requirement as the chunk branch above.
            r.returned &&
            wasDeliveredVerbatim(r.launchPrompt, b) &&
            openedBrief(r, planPath, key),
        )
      ) {
        return true;
      }
    }
    return false;
  };
  const superseded = (rec: AgentRecord, chunk: number | null): boolean =>
    chunk !== null ? chunkSatisfied(chunk, rec) : keySatisfied(rec);
  /**
   * Was this prior-session record's obligation redone in THIS session?
   *
   * The recovery count answers "what work did this run reuse", so only a
   * current-session relaunch supersedes: two prior records that both clear the
   * bar — a whiff-relaunch inside the interrupted attempt, say — otherwise
   * supersede EACH OTHER and both vanish from the count, while coverage still
   * credits their chunk. The continuity note would then under-report work the
   * same report simultaneously counts as reviewed, which on a single-chunk
   * plan means the recovered work appears nowhere at all.
   */
  const supersededByCurrent = (
    rec: AgentRecord,
    chunk: number | null,
  ): boolean => {
    const current = (r: AgentRecord): boolean => r.fromPriorSession !== true;
    return chunk !== null
      ? chunkSatisfied(chunk, rec, current)
      : keySatisfied(rec, current);
  };
  // A RETURNED spanning read refutes an `Uncoverable:` declaration: the
  // declaration claims no read can span the chunk, and a read that
  // demonstrably did proves it wrong. `chunkSatisfied` cannot see this
  // case when the relaunch that spanned the chunk was delivered with a
  // rewritten prompt — the walk credits a rewritten launch that still
  // read the diff, but the supersession bar (verbatim launch) fails it,
  // and the post-loop subtraction would delete the very coverage the walk
  // credited. `returned`, not merely live: an unreturned relaunch earns
  // told-range coverage on its way to dying, and that presumption must
  // not refute an honest declaration.
  /**
   * Does this launch's own told-range still describe the chunk it declares?
   *
   * The `of M` count seals a declaration to a plan with M chunks — but two
   * plans that share a count while chunking different lines are the same
   * number to it, and that collision is reachable. `since` fences transcripts
   * by their FILE's mtime (`recordsIn`), and the harness appends every event
   * through one long-lived fd, so a record written before a same-session
   * re-plan lands in a file whose mtime is newer than the plan's and survives
   * the fence. A stale `chunk 2 of 2` then passes count, membership, and both
   * refutation guards, `uncoverable.add(2)` erases the chunk's live spanning
   * coverage, and `classify()` reports `declared-uncoverable` — "no read can
   * span it", nothing a relaunch repairs — for a chunk a relaunch could cover.
   *
   * Territory tells the two plans apart where the count cannot. Every chunk
   * launch this CLI builds spells its read as the chunk's WHOLE window
   * (`diffWindow` is `offset = startLine - 1, limit = endLine - startLine + 1`;
   * an oversized chunk is told to page in prose, not given a smaller limit), so
   * an honest declarer's told-range spans its chunk exactly — including the
   * oversized chunks that are the likeliest to be declared at all. A stale
   * one's spans the window it was written against, which after a re-chunk is
   * not this one.
   *
   * `told`, not `ranges`: the question is which plan the LAUNCH was written
   * against, and a stale agent's actual reads are stale in the same way its
   * prompt is. A launch that spells no read at all resolves through the
   * current plan inside `pointedAt` and so still passes here — that hole is
   * older than this guard and unchanged by it; such a record is already
   * disclosed as a rewritten launch.
   */
  const declarationStillOnTerritory = (
    told: ReadonlyArray<[number, number]>,
    chunkId: number,
  ): boolean => {
    const c = plan.chunks.find((k) => k.id === chunkId);
    if (c === undefined) return false;
    // Exact, not containment: a re-plan that shrinks a chunk's tail leaves
    // the old window a strict SUPERSET of the new one, and containment
    // would pass membership, count and territory alike for a declaration
    // written against the old lines. Held on purpose against R27-2, which
    // asked for the shrinking direction to be admitted: the declaration's
    // evidence — the over-cap line — was found somewhere in the OLD window,
    // and nothing in the record says whether that line survived the trim.
    // The plan's own measurement of the NEW window (`maxLineChars`) is the
    // authority on whether it is spannable, and a relaunch against the new
    // window is the one repair that yields a declaration about THIS plan's
    // lines. Admitting supersets would reopen the stale-`chunk 2 of 2`
    // shape (R13-2, R18-1) whenever a re-plan happens to shrink.
    if (merge([...told]).some(([s, e]) => s === c.startLine && e === c.endLine))
      return true;
    // Against contiguous RUNS of the spelled reads, not only the merge: a
    // pasted-two-blocks launch spells the declarer's own window beside its
    // NEIGHBOUR's, and chunks tile contiguously, so the merge coalesces
    // the pair into one range the exact match above refuses — dropping a
    // genuine this-plan declaration purely from the paste (R18-1). Any
    // contiguous run whose union IS the window proves the launch was
    // written against it; a strict superset still fails, exactly as above.
    const sorted = [...told].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let i = 0; i < sorted.length; i++) {
      let end = sorted[i][1];
      if (sorted[i][0] === c.startLine && end === c.endLine) return true;
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j][0] > end + 1) break;
        end = Math.max(end, sorted[j][1]);
        if (sorted[i][0] === c.startLine && end === c.endLine) return true;
      }
    }
    return false;
  };

  /**
   * Did the declarer's own reads reach the chunk it declares?
   *
   * The told-range seal asks which plan the LAUNCH was written against;
   * this asks whether the agent ever went to the chunk's lines at all. An
   * agent told the right window that read elsewhere and returned
   * `Uncoverable:` is a repairable prompt failure wearing an
   * impossible-chunk verdict — admitting it pins `declared-uncoverable`
   * ("nothing is repaired by relaunching") over a chunk a relaunch could
   * cover, steering every classification-routing consumer away from the
   * one repair that works.
   *
   * Only RANGED reads can counter-prove: a `read_file` without a positive
   * `limit` returns a character budget, not a line range (`rangeOf`), so
   * its reach is unproven either way — it may have returned the chunk's
   * lines, and refusing the declaration on its presence would punish the
   * honest declarer whose only read was the capped one that showed it the
   * over-long line. A record with no ranged reads therefore keeps the told
   * presumption it already rides; one whose ranged reads demonstrably
   * avoid the chunk loses it.
   */
  const declarerReadItsChunk = (rec: AgentRecord, chunkId: number): boolean => {
    if (rec.diffReads.length === 0) return true;
    const c = plan.chunks.find((k) => k.id === chunkId);
    if (c === undefined) return false;
    return merge(rec.diffReads).some(
      ([s, e]) => s <= c.startLine && e >= c.endLine,
    );
  };

  /**
   * Does the plan's own measurement contradict the declaration?
   *
   * `maxLineChars` is the planner's walk of these same lines — the exact
   * fact the declaration claims — and the builder hands the declaration
   * template only to chunks whose longest line exceeds the read cap.
   * Metadata saying every line fits proves the declaration false on THIS
   * plan; admitted anyway, it pinned `declared-uncoverable` over a chunk
   * the plan's own input shows is spannable, and `uncoverable.add` erased
   * the coverage the walk credited. The refutation guard's metadata read,
   * mirrored: there it ENABLES refutation, here it REFUSES admission.
   * `> 0` keeps a hand-zeroed plan on the fail-open path the
   * absent-metadata shape rides; the truncatable shape (`> cap`) is the
   * honest declarer's, and stays admitted.
   */
  const planContradictsDeclaration = (chunkId: number): boolean => {
    const c = plan.chunks.find((k) => k.id === chunkId);
    return (
      c !== undefined &&
      c.maxLineChars !== undefined &&
      c.maxLineChars > 0 &&
      c.maxLineChars <= READ_FILE_CHAR_CAP
    );
  };
  // The truncatable shape the refutation guard's `> CAP` arm names, reused
  // by the suppression conjunct below: the planner's own measurement proves
  // no read can return this chunk's window.
  const chunkTruncatableByPlan = (chunkId: number): boolean => {
    const c = plan.chunks.find((k) => k.id === chunkId);
    return (
      c !== undefined &&
      c.maxLineChars !== undefined &&
      c.maxLineChars > READ_FILE_CHAR_CAP
    );
  };

  const refutedByReturnedSpanningRead = (
    chunkId: number,
    self?: AgentRecord,
  ): boolean => {
    const c = plan.chunks.find((k) => k.id === chunkId);
    if (c === undefined) return false;
    // A line longer than the read cap is unrecoverable — every page starts at
    // a line boundary, so no read returns the tail of that line — and a
    // spanning read recorded for such a chunk is a truncated view by
    // construction. It demonstrably spanned nothing, so it refutes nothing;
    // `maxLineChars` is the planner's own pre-detection of this shape. A
    // plan that carries NO metadata leaves the truncation question
    // unanswered — the spanning read may have been the truncated kind, and
    // a refutation the metadata cannot clear would delete an honest
    // declaration on a guess. `<= 0` is the same shape: the planner
    // measures >= 1 for any non-empty chunk, so a zero or negative lives
    // only on a hand-edited plan, and untrusted metadata clears nothing.
    // Fail closed: no trusted metadata, no refutation.
    if (
      c.maxLineChars === undefined ||
      c.maxLineChars <= 0 ||
      c.maxLineChars > READ_FILE_CHAR_CAP
    )
      return false;
    return records.some(
      (r) =>
        r !== self &&
        r.returned &&
        // Not the declarers of this chunk — keyed on the record's own
        // ASSIGNMENT, the way `certifies()` keys: the declarer's own
        // spanning read is the read the launch prompt spelled out and the
        // declaration answered — every production declaration would
        // otherwise refute itself — and two honest declarers refute each
        // other the same way. A record assigned elsewhere is not a
        // declarer even when its prose
        // QUOTES the declaration — an indented quote starts a line, so the
        // regex alone matches it — and excluding quoters can only remove
        // refuters: the whole-diff agents whose reads span every chunk are
        // the likeliest quoters and the likeliest refuters at once. The
        // record being adjudicated rides the same exclusion through
        // `self`: a paraphrased declarer carries no assignment the key can
        // read (R17-4).
        !(assignedChunk(r) === chunkId && declaresOwnUncoverable(r, chunkId)) &&
        merge(r.diffReads).some(([s, e]) => s <= c.startLine && e >= c.endLine),
    );
  };

  // Parsed once per record: the gap scan also feeds the supersession check
  // below, and the parse is not free on a long return.
  const gapsMemo = new Map<AgentRecord, string[]>();
  const gapsOf = (rec: AgentRecord): string[] => {
    let g = gapsMemo.get(rec);
    if (g === undefined) {
      g = budgetGapDisclosures(rec.finalText);
      gapsMemo.set(rec, g);
    }
    return g;
  };
  // A record's gaps are silenced only by a GAP-FREE superseding record — a
  // genuine repair. Two relaunches that both hit the ceiling and both
  // disclose would otherwise supersede each other and drop every gap.
  const gapsSuperseded = (rec: AgentRecord, chunk: number | null): boolean => {
    if (chunk !== null) {
      const b = builtOf(`chunk-${chunk}`);
      if (b === undefined) return false;
      return records.some(
        (r) =>
          r !== rec &&
          // Returned, like every superseding record: an empty return has no
          // gaps BECAUSE it has nothing at all, and reading that as a
          // gap-free repair silences the disclosure it never addressed.
          r.returned &&
          assignedChunk(r) === chunk &&
          wasDeliveredVerbatim(r.launchPrompt, b) &&
          r.diffToolCalls > 0 &&
          gapsOf(r).length === 0,
      );
    }
    // A whole-diff record: same shape as `keySatisfied`, plus the gap-free
    // requirement on the record that would do the superseding.
    for (const key of built.keys()) {
      const b = builtOf(key);
      if (b === undefined) continue;
      if (!wasDeliveredVerbatim(rec.launchPrompt, b)) continue;
      if (
        records.some(
          (r) =>
            r !== rec &&
            r.returned &&
            wasDeliveredVerbatim(r.launchPrompt, b) &&
            openedBrief(r, planPath, key) &&
            gapsOf(r).length === 0,
        )
      ) {
        return true;
      }
    }
    return false;
  };

  // Budget-gap disclosures (`Budget gap: <the check>` lines, the format the
  // tool-budget brief mandates and `budgetGapDisclosures` parses). Collected
  // inside the walk below so every guard the `Uncoverable:` claim earns
  // applies here for the same reason: the brief hands each agent the literal
  // template, so a zero-tool-call or blind agent that copied it back must
  // not be credited with a disclosed gap — that is the whiff wearing a
  // costume. Detection is deterministic here; the RULING (which gaps cap
  // Approve) stays with the orchestrator, like whiffs. Not part of `ok`: a
  // disclosed gap is the budget working, and failing the gate on it would
  // teach agents not to disclose.
  const budgetGaps: Array<{ agent: string; gaps: string[] }> = [];

  for (const rec of records) {
    const chunk = assignedChunk(rec);
    const name = label(rec, chunk);

    // Could this agent have read the diff at all? The prompt is the harness's
    // record of what was asked of it. 23 of 23 real chunk agents were launched
    // without one, and every one of them then said the sentence its prompt had
    // handed it.
    noteChunkAgent(rec, chunk, name);

    const given = wasGivenTheDiff(rec, plan.diffPathAbsolute);
    if (chunk !== null && !given) {
      // The cause is gated with the same supersession check as its prose
      // flag: a relaunch that satisfied the chunk already rebuilt the
      // prompt, and a cause that outlives its suppression makes
      // `classify()` diagnose the chunk with a repaired problem — leaving
      // the 'unknown' class that documents exactly that residue
      // unreachable.
      if (!superseded(rec, chunk)) {
        blindAgents.push(name);
        noteChunkCause(rec, chunk, 'blind-prompt');
      }
      continue; // Its silence proves nothing about the diff; the prompt failed.
    }

    // Did it work? Zero successful tool calls means it read nothing — whatever
    // its prose says. This is checked BEFORE the Uncoverable claim below, and the
    // order is load-bearing: `Uncoverable: chunk N` is a line the prompt hands the
    // agent, and an honest one requires having read the chunk to discover the line
    // is too long. A zero-tool-call agent that merely copied the template must not
    // be credited with a disclosed gap — that is the whiff wearing a costume.
    if (rec.successfulToolCalls === 0) {
      // Same supersession gate as the blind arm above.
      if (!superseded(rec, chunk)) {
        idleAgents.push(name);
        noteChunkCause(rec, chunk, 'idle');
        // The launch it idled on. The rewritten-prompt arm below never sees
        // this record — the `continue` here is load-bearing for the
        // declaration check, not for the classification — so without this
        // a zero-call record launched on a prompt the CLI did not build was
        // classified `idle` (repair: relaunch the same prompt) when the
        // repair that works is a rebuild. Both causes are recorded;
        // `classify()` ranks the rebuild above the relaunch, the same
        // precedence the unopened arm applies (R23-1). The prose channel
        // still names it idle: this adds a key, it does not move a record.
        if (chunk !== null) {
          const b = builtOf(`chunk-${chunk}`);
          if (b === undefined || !wasDeliveredVerbatim(rec.launchPrompt, b)) {
            noteChunkCause(rec, chunk, 'rewritten-prompt');
          }
        }
      }
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
            disclose(
              name,
              'ran on a prompt the run wrote itself (none was built for this ' +
                'chunk), so the brief with its method and rules never reached it',
              {
                reasonZh:
                  '运行在这次 run 自行编写的 prompt 上（该 chunk 从未构建过 ' +
                  'prompt），承载方法与规则的 brief 从未到达该 agent',
              },
            ),
          );
        }
      } else if (!wasDeliveredVerbatim(rec.launchPrompt, b)) {
        // Drifted launch, payload proven: the agent opened this chunk's brief
        // and opened the diff. The brief carries the method and the rules —
        // the launch prompt only points at it — so this is a NOTE, not a
        // relaunch. Not pushed through `disclose()`: the posted body caps on
        // disclosures, and a delivery that demonstrably arrived caps nothing.
        if (
          // Sealed like the note arms: membership, count, token AND
          // territory. A launch marked with ANOTHER plan's token is
          // positively the old plan's — its brief-open and diff read are
          // facts about THAT plan's delivery, not this one's — and a
          // marker-less stale record over an identity-less plan rides the
          // token conjunct through, so a count-changed or window-moved
          // record must fail the geometry conjuncts here the same way it
          // does in the note arms it claims parity with.
          sealedToThisPlan(rec, chunk) &&
          openedBriefOf(rec, `chunk-${chunk}`) &&
          rec.diffToolCalls > 0
        ) {
          if (!superseded(rec, chunk)) {
            driftedLaunches.push(
              `${name} — launched with a near-verbatim prompt; its brief was ` +
                'opened and the diff was read, so the delivery stands',
            );
          }
        } else {
          rewrittenThisRecord = true;
          if (!superseded(rec, chunk)) {
            rewrittenPrompts.push(
              disclose(
                name,
                'launched with a prompt that is not the one the CLI built',
                { reasonZh: '启动时使用的 prompt 不是 CLI 构建的那一份' },
              ),
            );
          }
        }
      }
    }

    // Recorded whether or not this record goes on to cover its chunk — the
    // classification is only ever consulted for a chunk that ended up
    // uncovered, and a cause that was never collected cannot be read at all —
    // but gated with the same supersession check as its prose push and the
    // blind/idle arms: a relaunch that satisfied the chunk already rebuilt
    // the prompt, and a cause that outlives its suppression makes
    // `classify()` diagnose the chunk with a repaired problem.
    if (rewrittenThisRecord && !superseded(rec, chunk))
      noteChunkCause(rec, chunk, 'rewritten-prompt');

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
      // The cause the operator is handed is the one whose repair subsumes the
      // other, matching the push above: a rewritten prompt is rebuilt, and a
      // rebuild already relaunches. Reporting both would hand two conflicting
      // repairs for one chunk. Gated like the push and the note above: a
      // superseding relaunch already reopened the diff or rebuilt the prompt.
      if (!superseded(rec, chunk)) {
        noteChunkCause(
          rec,
          chunk,
          rewrittenThisRecord ? 'rewritten-prompt' : 'unopened',
        );
      }
      continue;
    }

    // This record has passed every credit guard ABOVE it: it was given the
    // diff, it worked, and if it was pointed at lines it opened the file
    // they live in. Only now do its budget-gap lines count as disclosures —
    // sealed like the note arms, because a disclosure has NO geometry
    // backstop: the credit gate's chunk arm can lean on the requirement
    // that the record's ranges span the CURRENT windows, but a gap admitted
    // here rides straight into the posted report. A record of the old plan
    // — marked with another plan's token, marker-less over an identity
    // plan, count-changed, or written against a moved window — names THAT
    // plan's truncated trace in its `Budget gap:` lines, and
    // `gapsSuperseded` cannot suppress it (supersession needs a verbatim
    // delivery of THIS plan's built prompt) (R20-1, R21-21).
    //
    // Disclosing costs NO coverage credit, on purpose — an earlier draft
    // narrowed a disclosing agent's credit to its ranged reads, and that
    // punished exactly the honest agent: `rangeOf` records only reads that
    // carry a positive `limit`, so a compliant offset-paged or whole-file
    // read left a discloser with zero credit and a hard gate failure,
    // while an agent that stopped WITHOUT disclosing kept its full `told`
    // credit. An asymmetry that only ever bites the discloser teaches
    // agents not to disclose. The `told` presumption is the same for every
    // agent; what a disclosed gap changes is the RULING (Step 3D), not the
    // arithmetic.
    //
    // Suppression is gap-aware: a superseding record silences this one's
    // gaps only if it has none itself — a relaunch that hits the same
    // ceiling and discloses again must not let two compliant records
    // mutually supersede every disclosure into silence.
    const gaps = gapsOf(rec);
    if (
      gaps.length > 0 &&
      (chunk === null
        ? markedOfThisPlan(rec.launchPrompt)
        : sealedToThisPlan(rec, chunk)) &&
      !gapsSuperseded(rec, chunk)
    ) {
      budgetGaps.push({ agent: name, gaps });
    }

    // What it was told to read, plus what it demonstrably read. The second
    // term is what lets an agent handed the bare diff path with no
    // territory — a reverse-audit pass, a verifier — be credited for
    // exactly the lines it opened and for no others.
    const ranges = merge([...told, ...rec.diffReads]);
    if (ranges.length === 0) continue;

    // The declared chunks THIS record's reads may not certify, whatever the
    // declarer arms below decide about the declaration itself. A record
    // carrying `Uncoverable: chunk N` — its own line or a quotation — for a
    // chunk the plan's own measurement proves unspannable holds a read of
    // that chunk that is a truncated view by construction (the refutation
    // guard's `> CAP` arm): the read certifies nothing about N. Excluding
    // the CHUNK rather than dropping the RECORD keeps the reads' credit for
    // every other chunk they demonstrably spanned — the no-reads quoter that
    // lost its whole-diff credit (R28-1) and the overshooting declarer that
    // fell through to the credit gate and certified the chunk it declared
    // (R27-1) are the two shapes this one exclusion closes. A chunk whose
    // metadata is absent or hand-zeroed is not excluded: there the plan
    // cannot say the read was truncated, and the declaration rides the
    // untrusted-metadata arms instead. Identity-less records only — the
    // paraphrased chunk launch the branch below exists for. A record still
    // carrying an identity line is an assigned agent (its own declaration is
    // ruled on by the assigned arm) or a role agent, and a role agent
    // quoting a declaration keeps the live coverage its read earned: that
    // is the R20-4 posture, pinned by `a role agent quoting the declaration
    // is not an unassigned declarer`, and this exclusion does not move it.
    const creditExcluded = new Set(
      labelFromLaunchPrompt(rec.launchPrompt) === null
        ? declaredUncoverableChunkIds(rec).filter(chunkTruncatableByPlan)
        : [],
    );

    if (chunk !== null && declaresOwnUncoverable(rec, chunk)) {
      // The same supersession guard the sibling flags carry. Without it a
      // stale declaration — a prior attempt's agent on a resumed run, or a
      // relaunched agent's first try — permanently deletes live coverage
      // below (`for (const id of uncoverable) covered.delete(id)` is
      // post-loop and order-independent), so no compliant relaunch can ever
      // clear it and the verdict caps on lines this run demonstrably read.
      //
      // Suppression fails TOWARD suppression: the conjunct is reachable
      // only on the untrusted-metadata shape — a trusted measurement
      // answers first, contradicting the declaration or proving the chunk
      // unspannable — and there any compliant returned record stands the
      // declaration down. The older declarer-exclusion read a QUOTATION as
      // a declaration (an indented quote starts a line, so the regex
      // matches it) and removed the quoter as the only suppressor,
      // admitting the quote over a chunk the same run demonstrably read;
      // when the plan cannot prove unspannability, two honest declarers
      // annihilate into `missingChunks`, whose relaunch is the correct
      // repair (R20-3). Held on purpose against R28-2, which asked for a
      // declarer exclusion keyed on non-indented lines: an indentation
      // heuristic cannot tell a code-fenced quote at column 0 from a
      // declaration, and the shape is reachable only on a plan whose
      // metadata is absent or hand-zeroed — every plan the planner writes
      // measures its lines, and there a truncatable chunk is admitted ahead
      // of suppression. The cost is one relaunch on a hand-edited plan; the
      // alternative is a quotation capping a verdict again.
      //
      // Refuted outright by a returned spanning read — see
      // `refutedByReturnedSpanningRead`. Without the conjunct, a relaunch
      // that ACTUALLY spanned the chunk on a paraphrased prompt still
      // capped the verdict on lines this run demonstrably read.
      // The id comes from launch text the orchestrator wrote, which a
      // re-plan (or a resumed attempt's transcripts from a re-chunked diff)
      // can leave pointing at a chunk this PLAN does not carry. Such a
      // declaration is about nothing this run planned — and entering it
      // would put an id in `uncoverable` that the ledger, built only from
      // planned ids, can never match, taking the partition assertion down
      // on input that is stale, not contradictory. Drop it; the
      // rewritten-launch disclosure above already names the record.
      // Membership alone does not prove the declaration is about THIS plan:
      // a stale id can collide with a planned one — `chunk 2 of 9` left
      // over from a nine-chunk plan over a plan that now carries two
      // chunks. `sealedToThisPlan` is the plan-identity seal — membership,
      // the `of M` count, the token AND the told-range territory: a
      // declaration whose count or window contradicts this plan describes
      // different lines even when its id exists in it, and admitting it
      // classified a chunk a relaunch could cover as `declared-uncoverable`
      // and erased its live coverage. The declarer's own reads are the last
      // seal: told the right window but demonstrably reading elsewhere is a
      // repairable failure wearing an impossible verdict — see
      // `declarerReadItsChunk`.
      // The plan's own measurement is the mirror-image seal: metadata
      // saying every line fits contradicts the declaration outright — see
      // `planContradictsDeclaration`.
      if (
        sealedToThisPlan(rec, chunk) &&
        declarerReadItsChunk(rec, chunk) &&
        !planContradictsDeclaration(chunk) &&
        // A chunk the plan's own measurement proves unspannable cannot have
        // been returned by a relaunch that does not re-declare, whatever
        // `chunkSatisfied`'s bar (returned + verbatim + a diff call) says:
        // no read returns the tail of an over-cap line. Admitting the
        // suppression certified such a chunk covered off the relaunch's
        // told-range presumption — the back door beside the guarded front
        // door (`refutedByReturnedSpanningRead`'s `> CAP` arm).
        (chunkTruncatableByPlan(chunk) || !chunkSatisfied(chunk, rec)) &&
        !refutedByReturnedSpanningRead(chunk, rec)
      ) {
        uncoverable.add(chunk);
        noteChunkCause(rec, chunk, 'declared-uncoverable');
      }
      continue;
    }

    // The anchored CHUNK_RE de-assigns a launch the orchestrator
    // paraphrased: the words survive, the identity line does not. The
    // record's own `Uncoverable: chunk N` return is still a declaration —
    // without this branch it was dropped undisclosed while the credit
    // gate below certified the truncated read that motivated it (R17-4).
    // Take the id from the declaration line itself and route it through
    // the seals an assigned declarer rides — membership, the token, the
    // declarer's own reads and the refutation guards. The `of M` count
    // cannot ride: a chunk-less launch carries none to check. Declarer
    // SHAPE first, then the seals: a genuine declarer is pointed at its
    // chunk alone, so a launch whose spelled reads reach beyond the
    // declared chunk is a whole-diff shape QUOTING a declaration, not a
    // declaration — it keeps its spanning credit below, exactly as before
    // this branch existed. A launch that spells NO read is refused the
    // same way: [].every(...) is vacuously true, so a quoter paging the
    // diff with actual reads but no spelled reads rode the containment
    // check through and capped the verdict on a quotation — and the
    // entrance gate cannot tell the shape either, because a whole-diff
    // launch carries no identity line. A genuine declarer discovered the
    // over-cap line through the ranged read its launch spells (R20-4). A
    // declarer refused by any seal keeps the
    // assigned declarer's posture — no credit off the declared attempt —
    // while one admitted makes the chunk uncoverable, its reads
    // crediting nothing, the declaration having answered them.
    if (chunk === null) {
      const declaredIds = declaredUncoverableChunkIds(rec);
      if (
        declaredIds.length > 0 &&
        // Refuse role launches at the entrance: a role agent carries an
        // intact identity line (never CHUNK_RE-matched), walks chunk-less,
        // and can spell exactly the declared chunk's window — so a
        // QUOTATION in its return passes the shape checks below. Role
        // agents never declare chunks; a launch still carrying ANY
        // identity line is not the paraphrased chunk launch this branch
        // exists for (R20-4).
        labelFromLaunchPrompt(rec.launchPrompt) === null
      ) {
        // Adjudicate the candidates in text order and route on the FIRST
        // that fits the declarer shape: an earlier quotation of another
        // chunk's declaration must not hide the record's own declaration —
        // the quoted id fails the containment gate (a genuine declarer is
        // pointed at its chunk alone) and the record's own line is
        // adjudicated after it (R22-2).
        let declarerRouted = false;
        for (const declared of declaredIds) {
          const dc = plan.chunks.find((k) => k.id === declared);
          if (dc === undefined) continue;
          if (
            told.length > 0 &&
            told.every(([s, e]) => s >= dc.startLine && e <= dc.endLine)
          ) {
            if (
              // Fail-closed like the sibling chunk-less paths: the arm has
              // no geometry a seal could read, so a marker-less record over
              // an identity-carrying plan cannot prove it belongs to this
              // plan (R20-6, R21-8).
              markedOfThisPlan(rec.launchPrompt) &&
              // No fail-open on absent reads: the arm has no told-range seal
              // for the presumption to preserve, and an honest declarer
              // discovered the over-cap line through a ranged read (R20-5).
              rec.diffReads.length > 0 &&
              declarerReadItsChunk(rec, declared) &&
              !planContradictsDeclaration(declared) &&
              // Same fail-toward-suppression posture as the assigned arm
              // (R20-3): the conjunct is reachable only on the
              // untrusted-metadata shape.
              (chunkTruncatableByPlan(declared) ||
                !chunkSatisfied(declared, rec)) &&
              !refutedByReturnedSpanningRead(declared, rec)
            ) {
              uncoverable.add(declared);
              // Recorded directly, not through `noteChunkCause`: that
              // re-applies `sealedToThisPlan`, whose count conjunct is
              // guaranteed false here — a record reaches this branch exactly
              // when CHUNK_RE did not match, so `assignedChunkTotal` returns
              // null and the cause would be silently dropped, classifying
              // the chunk `no-agent` beside the walk's own admission. This
              // branch has already run its own seals (R17-4). The agent
              // label records the same way: `noteChunkAgent` returned on the
              // null assignment above.
              const causesSeen = chunkCauses.get(declared);
              if (causesSeen === undefined) {
                chunkCauses.set(
                  declared,
                  new Set<ChunkFailureClass>(['declared-uncoverable']),
                );
              } else {
                causesSeen.add('declared-uncoverable');
              }
              const agentsSeen = chunkAgents.get(declared);
              if (agentsSeen === undefined) {
                chunkAgents.set(declared, [name]);
              } else if (!agentsSeen.includes(name)) {
                agentsSeen.push(name);
              }
            }
            declarerRouted = true;
            break;
          }
          // A refused declarer — no spelled reads, or reads overshooting
          // the declared window — falls through to the credit gate on
          // purpose: `creditExcluded` above already withholds the declared
          // truncatable chunk from this record's credit, so the fall-through
          // certifies nothing the declaration names (R20-4's drop, R27-1's
          // overshoot) while the record's other reads keep their credit
          // (R28-1). Dropping the record here was the R28-1 defect.
        }
        if (declarerRouted) continue;
      }
    }

    // Sealed like the note arms and the declaration branch: a launch
    // marked with ANOTHER plan's token is positively the old plan's, and a
    // modify-only re-plan keeps every window, so its told-range and reads
    // are geometrically identical to this plan's — only the token tells the
    // plans apart. Its ranges earned coverage for the plan that wrote it,
    // not this one; the token conjunct fails closed with every other arm
    // (R22-1). A chunk-assigned record ALSO carries membership, the `of M`
    // count and the territory conjunct — evaluated over the record's
    // MERGED told-and-read ranges, not its told-range alone: a
    // pasted-two-blocks launch spells its own window beside its
    // neighbour's, and while the merged told-range spans both chunks
    // (neither exactly), the contiguous-run arm finds the window inside
    // those ranges, so the carve-out stays admitted (R18-1). A
    // count-changed or window-moved stale record the walk already discloses
    // as rewritten must not also certify the chunk covered off the same
    // record's read while `missingChunks` withholds the relaunch. The
    // chunk-LESS arm carries no geometry a seal could read — a whole-diff
    // read spans every window by construction — so nothing ties the record
    // to this plan's lines but the token (R20-6).
    if (
      chunk === null
        ? markedOfThisPlan(rec.launchPrompt)
        : markedOfThisPlan(rec.launchPrompt) &&
          plan.chunks.some((c) => c.id === chunk) &&
          assignedChunkTotal(rec) === plan.chunks.length &&
          declarationStillOnTerritory([...told, ...rec.diffReads], chunk)
    ) {
      for (const c of plan.chunks) {
        if (creditExcluded.has(c.id)) continue;
        if (ranges.some(([s, e]) => s <= c.startLine && e >= c.endLine)) {
          covered.add(c.id);
          // A whole-diff agent spans every chunk, so this credits chunks it was
          // never assigned — which is the point, and why `chunkAgents` is fed
          // from the assignment above rather than from here: the ledger's
          // `agents` should name who OWNED the chunk, not everyone whose range
          // happened to contain it.
          if (!rec.fromPriorSession) coveredLive.add(c.id);
        }
      }
    }
  }

  // A chunk somebody declared unreachable is a disclosed gap, not coverage — even
  // though a whole-diff agent's range formally spans it. Listing it as both would
  // be the report contradicting itself, which is the failure this whole file is a
  // response to.
  for (const id of uncoverable) {
    covered.delete(id);
    // The live/prior split is a view of `covered`; it has to be reconciled the
    // same way or the ledger reports a chunk as `covered` that this very loop
    // just took out of coverage.
    coveredLive.delete(id);
  }

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
      disclose(
        'every dimension',
        `none of the ${roster.length} required agents is on record as ` +
          `launched with a prompt this skill built, so this diff was ` +
          `reviewed, if at all, from prompts the run wrote for itself: no ` +
          `record shows the severity bar, the finding format or this ` +
          `project's own rules reaching an agent`,
        {
          subjectZh: '所有维度',
          reasonZh:
            `${roster.length} 个必需 agent 中没有任何一个有记录表明是用本 ` +
            `skill 构建的 prompt 启动的，这个 diff 即便被审查过，也是基于这次 ` +
            `run 自行编写的 prompt：没有记录表明严重级别标准、发现格式或本项目` +
            `自己的规则到达过任何 agent`,
        },
      ),
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
  const candidatesOf = buildable.map((req) => {
    const b = builtOf(req.key) as string;
    return records.filter((r) => wasDeliveredVerbatim(r.launchPrompt, b));
  });
  const openedOfReq = buildable.map((req, i) =>
    candidatesOf[i].filter((r) => openedBriefOf(r, req.key)),
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

  // Transcripts claimed by the drift rescue below — one role per transcript,
  // exactly like the verbatim matching, or a single curious agent that opened
  // every brief in the record dir would certify the whole roster.
  const rescued = new Set<AgentRecord>();
  let buildableIdx = -1;
  for (const req of roster) {
    const b = builtOf(req.key);
    if (b === undefined) {
      if (!nobodyBuiltAnything) {
        missingRoles.push(
          disclose(
            roleLabel(req),
            'no record shows its brief reaching an agent, so this dimension ' +
              'was reviewed, if at all, from a prompt the run wrote for itself',
            {
              subject: publicRoleLabel(req),
              subjectZh: publicRoleLabelZh(req),
              reasonZh:
                '没有记录表明它的 brief 到达过任何 agent，这个维度即便被审查' +
                '过，也是基于这次 run 自行编写的 prompt',
            },
          ),
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
      // The drift rescue: no launch contains this block verbatim, but some
      // agent opened THIS role's brief and did real work. The brief-open is a
      // tool call the harness recorded — not prose, not something a
      // paraphrasing orchestrator can fabricate — and the brief is where the
      // dimension, the severity bar and the project rules live. Injective like
      // the matching above: a transcript already credited with a verbatim
      // block, or already rescued for another role, cannot certify a second
      // one. Only for `anyMatch === false`: when a verbatim launch exists but
      // was spent elsewhere, the one-agent-many-blocks diagnosis below is the
      // truer one.
      if (!anyMatch) {
        // A role whose brief says it reads the diff must also show a diff
        // read — a drifted launch that dropped the read list is not rescued
        // on brief-open alone. Roles that legitimately never open the diff
        // (Build & Test, Issue Fidelity) are exempt by their own brief's
        // `readsDiff`; an unknown role fails safe and requires the read.
        const needsDiff = req.role === 'chunk' || BRIEFS[req.role].readsDiff;
        const rescue = records.find((r) => {
          const c = assignedChunk(r);
          return (
            // Sealed like the chunk loop's drifted-launch note: the
            // brief-open and the diff read are facts about the plan that
            // DELIVERED them. A launch marked with another plan's token is
            // the old plan's working role agent — and `briefPath` is stable
            // across re-plans, so its brief-open is this plan's path with
            // the old plan's delivery behind it. A record that CLAIMS a
            // chunk assignment rides the full plan-identity seal: a stale
            // `chunk 2 of 9` delivery from a re-planned old run opens the
            // same stable brief path and reads the diff, and the token-only
            // posture fails open on its marker-less launch — certifying
            // this plan's roster requirement off the old plan's delivery.
            // Chunk-assigned candidates are refused unless membership, the
            // `of M` count, the token AND the territory all agree with
            // this plan; records claiming no chunk carry no geometry the
            // seal can read — the brief path is stable across re-plans, so
            // the brief-open and the diff read are facts about whichever
            // plan delivered them — so the arm fails closed on a
            // marker-less launch over an identity plan, mirroring the
            // credit gate (R20-7).
            (c !== null
              ? sealedToThisPlan(r, c)
              : markedOfThisPlan(r.launchPrompt)) &&
            !matchedRec.has(r) &&
            !rescued.has(r) &&
            r.successfulToolCalls > 0 &&
            (!needsDiff || r.diffToolCalls > 0) &&
            openedBriefOf(r, req.key)
          );
        });
        if (rescue !== undefined) {
          rescued.add(rescue);
          // A chunk requirement rescued here was already noted by the chunk
          // loop above, which flags the same record — one NOTE per agent.
          if (req.role !== 'chunk') {
            driftedLaunches.push(
              `${roleLabel(req)} — no launch matched its block verbatim, ` +
                "but an agent opened this role's brief and did the work, so " +
                'the delivery stands',
            );
          }
          continue;
        }
      }
      missingRoles.push(
        disclose(
          roleLabel(req),
          anyMatch
            ? 'its prompt reached only an agent already credited with ' +
                'another block; one agent was given several blocks, and one ' +
                'transcript cannot certify two dimensions'
            : 'its prompt was built, but no agent on record was launched ' +
                'with it',
          {
            subject: publicRoleLabel(req),
            subjectZh: publicRoleLabelZh(req),
            reasonZh: anyMatch
              ? '它的 prompt 只到达了一个已被记入其他区块的 agent；一个 agent ' +
                '被塞进了多个区块，而一份运行记录无法为两个维度作证'
              : '它的 prompt 已构建，但没有任何 agent 有记录用它启动过',
          },
        ),
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
    // The ASSIGNED transcript must have opened this requirement's brief. The
    // matching SEEDS on brief-opening edges, but maximizing satisfied
    // requirements can displace an opened match onto an unopened edge — so an
    // unread flag here describes this assignment, not an impossibility. That is
    // the right trade: missing-role claims stay provable, and an unread brief
    // still caps.
    if (!openedBrief(pick, planPath, req.key)) {
      // The brief PATH is the operator's — it names the file to make the agent
      // open. The author's copy drops it: a filesystem path in a posted PR
      // body is the same register leak as a chunk id.
      unreadBriefs.push(
        disclose(
          roleLabel(req),
          `never opened its brief (${brief}), so it reviewed without the ` +
            'instructions it was launched to follow',
          {
            subject: publicRoleLabel(req),
            reason:
              'never opened its brief, so it reviewed without the ' +
              'instructions it was launched to follow',
            subjectZh: publicRoleLabelZh(req),
            reasonZh: '从未打开自己的 brief，审查时缺失了它本应遵循的指令',
          },
        ),
      );
    }
  }

  const planned = plan.chunks.map((c) => c.id);
  const missingChunks = planned.filter(
    (id) => !covered.has(id) && !uncoverable.has(id),
  );

  // The per-chunk ledger. Built here, from the sets this walk produced, so it
  // cannot disagree with them: the three id arrays and this are one derivation,
  // not two.
  const filesOfChunk = new Map<number, string[]>(
    plan.chunks.map((c) => [
      c.id,
      (c.files ?? [])
        .map((f) => f?.path)
        .filter((p): p is string => typeof p === 'string' && p !== ''),
    ]),
  );
  const classify = (id: number): ChunkFailureClass => {
    const causes = chunkCauses.get(id);
    if (causes === undefined || causes.size === 0) {
      // No record was ever assigned to it, or every record that was assigned
      // passed every guard and simply never spanned its lines.
      return chunkAgents.has(id) ? 'unknown' : 'no-agent';
    }
    // Ordered by which repair subsumes which. A declaration is the agent's own
    // verdict and outranks everything (nothing is repaired by relaunching);
    // then the causes whose fix is a rebuilt prompt, then a plain relaunch.
    for (const cls of [
      'declared-uncoverable',
      'blind-prompt',
      'rewritten-prompt',
      'idle',
      'unopened',
    ] as const) {
      if (causes.has(cls)) return cls;
    }
    return 'unknown';
  };
  // Sorted by id, not left in plan order: the doc on `chunkItems` promises it,
  // and `chunkIdsProblem` requires ids to be unique positive integers without
  // requiring them to be ASCENDING. A hand-written or reordered plan would
  // otherwise produce a ledger that two runs' diffs cannot be lined up against.
  const chunkItems: ChunkCoverageItem[] = [...planned]
    .sort((a, b) => a - b)
    .map((id) => {
      const files = filesOfChunk.get(id) ?? [];
      const agents = chunkAgents.get(id) ?? [];
      if (uncoverable.has(id)) {
        return {
          id,
          files,
          outcome: 'uncoverable' as const,
          classification: classify(id),
          agents,
        };
      }
      if (covered.has(id)) {
        return {
          id,
          files,
          outcome: coveredLive.has(id)
            ? ('covered' as const)
            : ('recovered' as const),
          agents,
        };
      }
      return {
        id,
        files,
        outcome: 'missing' as const,
        classification: classify(id),
        agents,
      };
    });

  // The invariant every coverage number in this pipeline rests on, asserted
  // rather than left to be inferred from the construction above.
  //
  // It holds today: `uncoverable` is subtracted from `covered` post-walk and
  // `missingChunks` is the complement of both. But a partition that is only
  // true by construction is one a future edit can break without anything
  // saying so, and the number it would break is the denominator of "17 of 18
  // chunks reviewed" — the one figure a reader uses to decide whether a review
  // read the change. `check-coverage` used to derive that denominator by
  // summing these same sets, which made it self-consistent and therefore
  // unable to ever show a violation; it now reads `plannedChunks.length` and
  // this is what proves the two agree.
  assertChunkPartition(planned, chunkItems, {
    covered: [...covered],
    missing: missingChunks,
    uncoverable: [...uncoverable],
  });

  // Prior-attempt records that clear the SAME certification bar as a live
  // launch — the resumed run's recovered work. The bar is deliberately the
  // pairing predicates above, not "the file existed": a fabricated ledger
  // entry can point the reader at a directory, but only a harness transcript
  // whose launch verbatim-contains a CLI-built prompt and shows the brief or
  // the diff actually opened earns a count here.
  const certifies = (r: AgentRecord): boolean => {
    // Same bar as the coverage walk: a prior agent that never returned did
    // not finish, so it is not recovered work either — and "returned" means
    // terminal text, not progress narrated between tool calls.
    if (!r.returned) return false;
    // A record whose own return declares ITS OWN chunk unreachable did not
    // review it; counting it as recovered would have the body announce work
    // "counted as reviewed" beside the gap that same record disclosed. The
    // veto is chunk-scoped like the walk's: a recovered whole-diff auditor
    // legitimately quotes the declarations it audited, and a quotation is
    // not a declaration.
    const c = assignedChunk(r);
    if (declaresOwnUncoverable(r, c)) return false;
    if (c !== null) {
      const b = builtOf(`chunk-${c}`);
      return (
        b !== undefined &&
        wasDeliveredVerbatim(r.launchPrompt, b) &&
        r.diffToolCalls > 0
      );
    }
    for (const key of built.keys()) {
      const b = builtOf(key);
      if (b === undefined) continue;
      if (wasDeliveredVerbatim(r.launchPrompt, b) && openedBriefOf(r, key)) {
        return true;
      }
    }
    return false;
  };
  // NOT pushed through `disclose()`: that channel caps (compose-review folds
  // every disclosure into the unreviewed-dimension cap and the "Not
  // reviewed:" rendering), and recovered work is the OPPOSITE of a gap — a
  // capping entry here would downgrade every clean resumed run to COMMENT,
  // permanently, since the prior records never leave the ledger.
  // compose-review reads the count off this report and renders its own
  // non-capping continuity note, beside the other disclosed-but-not-capping
  // blocks (deferred lint, test-plan notes).
  const recoveredAgents = records.filter(
    (r) =>
      r.fromPriorSession &&
      certifies(r) &&
      // Not if a CURRENT record already satisfied the same obligation: the
      // count is what the continuity note reports, and announcing recovery
      // for superseded work would misdescribe what this run reused.
      !supersededByCurrent(r, assignedChunk(r)),
  ).length;

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
    recoveredAgents,
    blindAgents,
    idleAgents,
    unopenedAgents,
    rewrittenPrompts,
    driftedLaunches,
    missingRoles,
    missingRoleSelectors,
    disclosures,
    unreadBriefs,
    missingChunks,
    uncoverableChunks: [...uncoverable].sort((a, b) => a - b),
    budgetGaps,
    coveredChunks: [...covered].sort((a, b) => a - b),
    plannedChunks: plan.chunks.map((c) => ({
      id: c.id,
      files: filesOfChunk.get(c.id) ?? [],
    })),
    chunkItems,
    selectionDrift: selectionDriftReason,
  };
}

/**
 * How a Step 4/5 step's agents got their prompt — five shapes, five different fixes.
 *
 * `ok` — an agent was launched with the prompt the CLI built, opened its brief,
 *   and — when the built prompt points at one — read the findings file.
 * `not-built` — `agent-prompt --role <r>` never ran. Decided before the transcripts
 *   are consulted (there is no brief whose open could be looked for), so it proves
 *   the builder was skipped — NOT that no agent ran: a hand-written launch with no
 *   brief on disk is invisible to this check, and the texts below say "if at all"
 *   because of it.
 * `not-launched` — the prompt was built and nothing was launched with it.
 * `rewritten` — an agent ran and opened the brief, but no agent got the built prompt
 *   intact: the orchestrator wrote the launch itself.
 * `brief-unread` — an agent got the built prompt and never opened the brief it names.
 * `findings-unread` — an agent got the built prompt and opened its brief, but never
 *   read the findings file the prompt points at. Since #8597 the verify/reverse-audit
 *   list rides that file (the block carries only the pointer), and the brief's read
 *   receipt does not cover it — an instruction-skipping agent could open the brief,
 *   skip the one instructed findings read, and rule on a list it never saw. The read
 *   is a tool call like the brief's, so it is checked the same way.
 */
type Delivery =
  | 'ok'
  | 'not-built'
  | 'not-launched'
  | 'rewritten'
  | 'brief-unread'
  | 'findings-unread';

/**
 * Two sentences per failed shape, for two different readers.
 *
 * `gap` goes into the posted review body, under `Not reviewed:` — a PR author
 * reads it, so it says what the review cannot certify and names no internal
 * command (`agent-prompt --findings …` is not something an author can run, and on
 * #7012 fourteen lines of exactly that register WERE the public review). `fix` is
 * the per-shape remediation, printed to stderr where the orchestrator reads — the
 * shapes exist because the fixes differ, and that precision belongs to
 * the reader who relaunches agents, not the one who reads the verdict.
 */
interface GapEntry {
  /** Author-facing: what this review cannot certify, and why. */
  gap: string;
  /** `gap`, for the Chinese half of a bilingual posted body. */
  gapZh: string;
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
  `--plan <plan> --role ${role} --findings <file> [--rules <rules file>] ` +
  // --round is MANDATORY for a reverse-audit build (`agent-prompt` refuses a
  // round-less call — the label keys the record and the budget gate's
  // accounting), so the paste-and-run repair must not bracket it as optional:
  // an orchestrator honouring the bracket convention would have its first
  // repair attempt rejected. Verify genuinely takes it or not (only a repeat
  // verification round passes one), so its brackets stay.
  (role === 'reverse-audit' ? `--round <k>\` ` : `[--round <k>]\` `) +
  (role === 'reverse-audit'
    ? `(an early round with nothing confirmed passes an empty file; `
    : `(pass the shard's findings, never an empty file — a verifier that sees ` +
      `no findings verifies nothing; `) +
  `pass --rules whenever the review loaded any, or the rebuilt brief silently ` +
  `drops the project rules) and launch an agent with EXACTLY what it prints — ` +
  `no hand-added ${noun} number` +
  // --round bakes in a ROUND number. Verify's noun is "shard", and a
  // parenthetical claiming --round bakes it in would send the reader to the
  // wrong flag — shards are already told apart by their findings digest.
  (role === 'reverse-audit' ? ` (--round bakes it in)` : ``) +
  `, no summary of your own, no rewording`;

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
    gapZh:
      '没有审计 agent 是用本 skill 构建的 prompt 启动的——负责搜寻评审其余部分' +
      '遗漏问题的这道工序，即便运行过，也缺失了 brief 承载的方法',
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
    gapZh:
      '它的 prompt 已构建，但没有 agent 用它启动——负责搜寻评审其余部分遗漏' +
      '问题的这道工序，即便运行过，也缺失了 brief 承载的方法，无法作证',
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
    gapZh:
      '有审计 agent 运行并打开了自己的 brief，但没有 agent 是用 CLI 构建的 ' +
      'prompt 启动的——启动 prompt 是手写的，agent 实际被要求做的并不是本 ' +
      'skill 所认证的内容',
    fix: rebuildFix('reverse-audit', 'round'),
  },
  'brief-unread': {
    gap:
      'it was launched with the built prompt but never opened its brief, so it ' +
      'audited without the gaps-only method and the finding format it was ' +
      'launched to follow',
    gapZh:
      '它用构建的 prompt 启动，却从未打开自己的 brief，审计时缺失了只报缺口的' +
      '方法和它本应遵循的发现格式',
    fix:
      'relaunch with the same printed prompt — the agent must OPEN the brief ' +
      'file the prompt names; that read is the receipt',
  },
  'findings-unread': {
    gap:
      'it was launched with the built prompt and opened its brief, but never ' +
      'read the findings file the prompt points at, so it audited without ' +
      'the confirmed list it was launched against',
    gapZh:
      '它用构建的 prompt 启动并打开了自己的 brief，却从未读取 prompt 所指向的 ' +
      'findings 文件，审计时缺失了它本应对照的已确认发现列表',
    fix:
      'relaunch with the same printed prompt — the agent must OPEN the brief ' +
      'file AND read the findings file the prompt names; those reads are ' +
      'the receipt',
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
    gapZh:
      '本次评审发布了发现，但没有验证 agent 是用本 skill 构建的 prompt 启动的' +
      '——这些发现即便被裁定过，也缺失了 brief 承载的裁定标准',
    fix: rebuildFix('verify', 'shard'),
  },
  'not-launched': {
    gap:
      'its prompt was built, but no agent was launched with it, so the posted ' +
      'findings cannot be counted as verified',
    gapZh:
      '它的 prompt 已构建，但没有 agent 用它启动，发布的发现不能算作已验证',
    fix: rebuildFix('verify', 'shard'),
  },
  rewritten: {
    gap:
      'a verifier ran and opened its brief, but no agent was launched with the ' +
      'prompt the CLI built — the launch was written by hand, and the posted ' +
      'findings cannot be counted as verified against it',
    gapZh:
      '有验证 agent 运行并打开了自己的 brief，但没有 agent 是用 CLI 构建的 ' +
      'prompt 启动的——启动 prompt 是手写的，发布的发现不能算作经它验证',
    fix: rebuildFix('verify', 'shard'),
  },
  'brief-unread': {
    gap:
      'it was launched with the built prompt but never opened its brief, so it ' +
      'ruled on the findings without the verdict bar it was launched to apply',
    gapZh:
      '它用构建的 prompt 启动，却从未打开自己的 brief，裁定发现时缺失了它本应' +
      '使用的裁定标准',
    fix:
      'relaunch with the same printed prompt — the agent must OPEN the brief ' +
      'file the prompt names; that read is the receipt',
  },
  'findings-unread': {
    gap:
      'it was launched with the built prompt and opened its brief, but never ' +
      'read the findings file the prompt points at, so it ruled on findings ' +
      'it was never shown',
    gapZh:
      '它用构建的 prompt 启动并打开了自己的 brief，却从未读取 prompt 所指向的 ' +
      'findings 文件，等于在未见到这些发现的情况下作出裁定',
    fix:
      'relaunch with the same printed prompt — the agent must OPEN the brief ' +
      'file AND read the findings file the prompt names; those reads are ' +
      'the receipt',
  },
};

/**
 * Both steps down the same way is ONE failure with two subjects, not two
 * paragraphs. #7268's posted body carried the verify and reverse-audit
 * `rewritten` sentences back to back, near-identical but for the tail — the
 * same repetition the chunk grouping exists to kill, one layer up. Merged only
 * on an EXACT shape match: mixed shapes have different mechanisms and
 * different fixes, and a sentence vague enough to cover both would misname
 * one of them. Each text keeps both steps' consequences and both honesty
 * limits of its per-role twins: `not-built`/`not-launched` may not claim
 * nobody ran, `rewritten` may not claim the brief never arrived. The
 * remediation stays per-role — the two rebuild commands differ.
 */
const COMBINED_STEP45_GAP: Record<
  Exclude<Delivery, 'ok'>,
  { en: string; zh: string }
> = {
  'not-built': {
    en:
      'neither the verifier nor the reverse auditor was launched with a prompt ' +
      'this skill builds — the posted findings were ruled on, and the misses ' +
      'the rest of the review left were hunted, if at all, without the briefs ' +
      'this skill certifies against',
    zh:
      '验证 agent 与反向审计 agent 都没有用本 skill 构建的 prompt 启动——发布的' +
      '发现即便被裁定过、评审其余部分遗漏的问题即便被搜寻过，也都缺失了本 ' +
      'skill 用以认证的 brief',
  },
  'not-launched': {
    en:
      'both prompts were built, but no agent was launched with either — the ' +
      'posted findings cannot be counted as verified, and the pass that hunts ' +
      'what the rest of the review missed cannot be certified',
    zh:
      '两份 prompt 都已构建，但都没有 agent 用它们启动——发布的发现不能算作已' +
      '验证，搜寻评审遗漏问题的工序也无法作证',
  },
  rewritten: {
    en:
      'each ran and opened its brief, but neither was launched with the prompt ' +
      'the CLI built — the launches were written by hand, so the posted ' +
      'findings cannot be counted as verified, and what the agents were ' +
      'actually asked is not what this skill certifies',
    zh:
      '两者都运行并打开了各自的 brief，但都不是用 CLI 构建的 prompt 启动的——' +
      '启动 prompt 是手写的，发布的发现不能算作已验证，agent 实际被要求做的也' +
      '不是本 skill 所认证的内容',
  },
  'brief-unread': {
    en:
      'each was launched with its built prompt and never opened its brief, so ' +
      'the findings were ruled on without the verdict bar, and the audit ran ' +
      'without the gaps-only method it was launched to follow',
    zh:
      '两者都用构建的 prompt 启动，却都从未打开自己的 brief——发现的裁定缺失了' +
      '裁定标准，审计也缺失了它本应遵循的只报缺口的方法',
  },
  'findings-unread': {
    en:
      'each was launched with its built prompt and opened its brief, but never ' +
      'read the findings file its prompt points at, so the findings were ' +
      'ruled on by agents never shown them, and the audit ran without the ' +
      'confirmed list it was launched against',
    zh:
      '两者都用构建的 prompt 启动并打开了各自的 brief，却都未读取 prompt 所指向' +
      '的 findings 文件——发现是在裁定者未见到它们的情况下被裁定的，审计也缺失' +
      '了它本应对照的已确认发现列表',
  },
};

export interface VerificationReport {
  /** True when every required Step 4/5 agent ran and read its brief. */
  ok: boolean;
  /**
   * The Step 4/5 gaps, structural — subject and reason apart, in both body
   * languages, so `compose-review` never recovers a boundary from rendered
   * prose (reparsing was the bug the disclosure entries already fixed).
   * These reach the POSTED review body: author-facing register, no internal
   * commands.
   */
  gaps: Array<{
    subject: string;
    reason: string;
    subjectZh: string;
    reasonZh: string;
    /**
     * True when the gap is a tier's BY-DESIGN omission rather than a
     * repairable floor failure — the balanced (medium) tier's skipped
     * reverse audit. No verification clears it and no repair lifts it,
     * so `compose-review` routes the cap it fires onto the posture axis
     * instead of sending an automated caller to relaunch verification
     * against a permanently uncleared axis.
     */
    byDesign?: boolean;
  }>;
  /**
   * The per-shape fix for each gap, in the same order — for stderr, where the
   * orchestrator reads. Never rendered into the body.
   */
  remediation: string[];
  /**
   * True when this review posts findings and NO verifier's delivery came back
   * clean — the structured form of the `verification — …` gap line, for the
   * verdict computation. A Request changes is "earned by a confirmed
   * Critical", and this is the bit that says the confirmation never happened;
   * parsing the gap text for it would put the verdict at the mercy of a
   * wording change.
   */
  unverifiedFindings: boolean;
}

/**
 * Drop a PRIOR attempt's agents that never returned.
 *
 * A session that died mid-flight left records whose findings never existed:
 * the agent opened its brief, said nothing, and the process went away. Such a
 * record still carries a recorded prompt and an opened brief, which is the
 * whole of the Step 4/5 delivery floor — so left in, it certifies a
 * verification nobody performed. An empty return in the CURRENT session is a
 * different thing entirely: an agent still running, which the idle checks own.
 *
 * Every CERTIFYING gate goes through here — coverage and the Step 4/5
 * floor. Two run-scoped readers do not call this helper but enforce the
 * same `returned` requirement at their own sites: the layer-audit
 * corroboration filter and the retirement scheduler's classify pipeline.
 * The earlier premise for exempting them — "an empty return already
 * contributes nothing" — was true only of EMPTY returns: `returned ===
 * false` also covers non-empty narration followed by tool traffic, and a
 * died-mid-flight auditor's receipt-shaped narration corroborated layers
 * and retired chunks through both readers. Their filters are pinned in
 * their own suites; this note exists so the next reader does not
 * reintroduce the exemption on the old premise.
 */
function liveRecords(all: AgentRecord[]): AgentRecord[] {
  // `returned`, not merely non-empty: `finalText` keeps the last non-empty
  // assistant text, which includes progress narrated between tool calls — an
  // agent that opened its inputs, said "reading the diff now…" and died
  // carries plausible text that certifies nothing. A record with tool
  // traffic after its text never returned.
  return all.filter((r) => !(r.fromPriorSession && !r.returned));
}

/**
 * Did Step 4 (verify) and Step 5 (reverse audit) actually run, and read their
 * briefs?
 *
 * `check-coverage` proves Step 3 was done — but it runs at Step 3D, *before* these
 * two, so its roster (`requiredAgents`) cannot reach them. And their count is not
 * in the plan: verify shards on the finding count (`ceil(N/8)`), reverse audit
 * loops until it goes dry. So this is not an exact roster — it is a floor, and it
 * is asked only by `compose-review`, which runs at high AND medium effort. High
 * requires both steps; medium runs verify but skips the reverse audit by design
 * (see `balancedMedium` below), so at medium the reverse-audit floor becomes a
 * Comment cap, not a repairable gap. Low emits no verdict, calls no
 * `compose-review`, and never reaches here.
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
  // Run-scoped for the same reason as `coverageFromTranscripts`: a resumed
  // run's Step 4/5 evidence may sit in the interrupted attempt's session dir.
  const records = liveRecords(
    readRunTranscripts(planPath, mtimeMs, env, plan.diffPathAbsolute, {
      currentDirOptional: true,
    }),
  );
  const built = readRecordedPrompts(planPath);
  const gaps: VerificationReport['gaps'] = [];
  const remediation: string[] = [];
  // The balanced (medium) tier deliberately skips Step 5 (reverse audit). Read
  // the effort from the plan, so this reader and the roster agree. At medium the
  // absent reverse audit is a by-design omission that caps the verdict at Comment
  // — NOT a gap to repair: flagging it missing, and emitting a FIX line telling
  // the orchestrator to run it, made the one mandated repair round rebuild the
  // full high pipeline and escalate every medium review back to high. Verify
  // (Step 4) still runs at medium, so its floor below is untouched.
  const balancedMedium = (plan as { effort?: unknown }).effort === 'medium';

  // How a step's agents actually got their prompt. The floor needs the shapes
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
    // leaves in them. The findings file — the list a findings-role block points
    // at since #8597 — is matched the same way: the pointer comes from the
    // recorded prompt itself (a per-chunk key and its round's findings file
    // are keyed differently, so the key cannot derive the path), and a prompt
    // with no pointer (an empty early round, a pre-#8597 inlined list, or a
    // round whose findings-file write failed and fell back to inlining) owes
    // no findings read. Deliberate weakening versus the inlined shape this
    // replaced: the floor proves the findings file was OPENED (one successful
    // read_file of the path — no other tool's args count), not that it was
    // paged to completion — `read_file` truncates, so a first-page-only read
    // still leaves a matching serialized pointer (the needle built inside `readFindingsPointer`).
    // The old `wasDeliveredVerbatim` required the whole list in the delivered
    // prompt; the pointer proves delivery of the pointer line, not receipt of
    // the whole list. Accepted: the brief now orders the full read, and a
    // verifier that under-reads surfaces in the verdicts it gets wrong.
    const opened = (r: AgentRecord) => openedBrief(r, planPath, key);
    const findingsPointer = findingsPointerOf(b);
    const readTheFindings = (r: AgentRecord) =>
      readFindingsPointer(r, findingsPointer);
    const gotTheBuiltPrompt = records.filter((r) =>
      wasDeliveredVerbatim(r.launchPrompt, b),
    );
    if (gotTheBuiltPrompt.some((r) => opened(r) && readTheFindings(r))) {
      return 'ok';
    }
    if (gotTheBuiltPrompt.some(opened)) return 'findings-unread';
    if (gotTheBuiltPrompt.length > 0) return 'brief-unread';
    // Nothing was launched with the built prompt. Did anything open this key's brief
    // anyway? Then an agent DID run — on a launch the orchestrator wrote itself. A
    // different failure, with a different fix, and the one the message used to deny.
    if (records.some(opened)) return 'rewritten';
    return 'not-launched';
  };

  /**
   * Narrow a step's keys to the CURRENT findings digest.
   *
   * `verify--<digest>` is one key per shard per digest, and the records
   * accumulate: a run that finds new Criticals writes a new digest's keys
   * beside the old ones. Taking the best delivery across ALL of them let a
   * verifier that succeeded against an EARLIER findings list satisfy the floor
   * for a list it never opened — and widening the record set to prior sessions
   * is what made that reachable in practice.
   *
   * The digest's own findings file dates it. Keys written together (the shards
   * of one digest) land within the same moment, so the newest file plus a
   * small window is the current set; anything older is a previous list's
   * verification and does not vouch for this one. Keys with no findings file
   * on disk stay in: they cannot be dated, and they also cannot reach `ok` —
   * `deliveryOf` requires the findings read — so they can only make the
   * verdict stricter.
   */
  const currentDigestKeys = (planPath: string, keys: string[]): string[] => {
    // A key with no findings file is dated by its PROMPT RECORD instead —
    // the `<key>.txt` the builder always writes. Dropping undatable keys
    // whenever any dated key existed failed in the mirror direction: when
    // the CURRENT digest's findings write failed (the documented
    // `writeFindingsFile` → inline fallback), its keys were the undatable
    // ones, the window kept the PREVIOUS round's dated cluster, and the
    // floor passed `ok` on an earlier list's verifier — certifying a
    // verification that never happened. The record file dates every built
    // key, so the current generation stays in the window and a genuinely
    // stale pointerless generation still falls out of it.
    const dated: Array<{ key: string; mtimeMs: number }> = [];
    const undatable: string[] = [];
    for (const key of keys) {
      try {
        dated.push({
          key,
          mtimeMs: statSync(findingsFilePath(planPath, key)).mtimeMs,
        });
      } catch {
        try {
          dated.push({
            key,
            mtimeMs: statSync(recordedPromptPath(planPath, key)).mtimeMs,
          });
        } catch {
          undatable.push(key);
        }
      }
    }
    if (dated.length === 0) return keys;
    const newest = Math.max(...dated.map((d) => d.mtimeMs));
    return dated
      .filter((d) => d.mtimeMs >= newest - DIGEST_WINDOW_MS)
      .map((d) => d.key);
  };

  /** The best shape across a step's keys — the floor is one agent, not all of them. */
  const bestDelivery = (keys: string[]): Delivery => {
    if (keys.length === 0) return 'not-built';
    const rank: Record<Delivery, number> = {
      ok: 0,
      'findings-unread': 1,
      'brief-unread': 2,
      rewritten: 3,
      'not-launched': 4,
      'not-built': 5,
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
  // Narrowed to the current digest exactly like the verify floor below:
  // reverse keys accumulate per round/digest the same way, and ranging over
  // all of them let a round-1 auditor's delivered receipt satisfy the floor
  // after the findings list changed and the current round's audit was never
  // delivered — with the prior-session widening making that stale auditor
  // reachable across attempts too.
  const reverse = bestDelivery(currentDigestKeys(planPath, reverseKeys));
  // A TIME-budget stop marker means the round builder refused the reverse
  // audit on the run's time budget. Exactly ONE gap shape is then by design:
  // `not-built` — the refusal writes no record, so an audit with no records
  // is the audit the gate stopped, and the gap's FIX (rebuild the round)
  // would be refused by the very gate that stopped it — exit 4,
  // deterministically, time only moves forward. compose-review synthesizes
  // the marker's own disclosure instead: it names the stop honestly and caps
  // the verdict. Every OTHER shape describes a round that predates the
  // refusal — a built round nobody launched, a launch the orchestrator
  // rewrote, a brief never opened — and those disclosures are still owed: a
  // hand-written round-1 launch is exactly as undelivered when round 3 later
  // hits the budget, and suppressing it would let "stopped before round 3"
  // imply the rounds that did run were faithful.
  //
  // Only the time-budget cause earns this exemption. A ROUND-CAP stop does
  // NOT: the cap gate refuses only `round > cap`, so the not-built gap's FIX
  // (rebuild `--round 1`) is admitted, and a local run has no deadline to
  // refuse it at all — the monotone-refusal premise fails twice. So a
  // round-cap marker leaves the not-built gap and its rebuild remediation
  // owed, exactly as if no marker were present.
  const stop = readBudgetStop(planPath);
  const budgetStopped = stop !== null && stop.cause !== 'round-cap';
  const reverseByDesign = budgetStopped && reverse === 'not-built';
  // A repairable reverse-audit gap only at high: medium is complete without it.
  const reverseGap = !balancedMedium && !reverseByDesign && reverse !== 'ok';
  if (reverseGap) {
    // The fix template carries `--plan <plan>`; a literal `<plan>` pasted into a
    // POSIX shell parses as input redirection, so the one repair round Step 6
    // prescribes could never run. This function is handed the real path.
    remediation.push(
      `reverse audit: ${REVERSE_AUDIT_GAP[reverse].fix.replace(
        '--plan <plan>',
        () => `--plan ${shellQuotePath(planPath)}`,
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
  let unverifiedFindings = false;
  let verify: Delivery | null = null;
  if (opts.postsFindings) {
    // The whole key family: `verify--<digest>` per shard (the record carries
    // the findings-file pointer, and `deliveryOf` now also requires the agent
    // to have read that file, so a launch that dropped the read matches
    // nothing), plus the bare legacy key. Floor of one, as documented.
    const verifyKeys = [...built.keys()].filter(
      (k) => k === 'verify' || k.startsWith('verify--'),
    );
    verify = bestDelivery(currentDigestKeys(planPath, verifyKeys));
    if (verify !== 'ok') {
      unverifiedFindings = true;
      remediation.push(
        `verification: ${VERIFY_GAP[verify].fix.replace(
          '--plan <plan>',
          // A function replacer: a plain string gives `$&`/`$\`` special
          // meaning, and a path is not a place for replacement patterns.
          () => `--plan ${shellQuotePath(planPath)}`,
        )}`,
      );
    }
  }

  // The gaps, after both shapes are known: both steps failing the SAME way is
  // one sentence with two subjects (see COMBINED_STEP45_GAP); anything else
  // keeps its own precise text. The remediation above stays per-role either
  // way — the two rebuild commands differ, and the combined sentence lands in
  // the posted body while the fixes land on stderr.
  if (reverseGap && verify !== null && verify === reverse) {
    gaps.push({
      subject: 'verification and reverse audit',
      reason: COMBINED_STEP45_GAP[reverse].en,
      subjectZh: '验证与反向审计',
      reasonZh: COMBINED_STEP45_GAP[reverse].zh,
    });
  } else {
    if (reverseGap) {
      gaps.push({
        subject: 'reverse audit',
        reason: REVERSE_AUDIT_GAP[reverse].gap,
        subjectZh: '反向审计',
        reasonZh: REVERSE_AUDIT_GAP[reverse].gapZh,
      });
    }
    if (verify !== null && verify !== 'ok') {
      gaps.push({
        subject: 'verification',
        reason: VERIFY_GAP[verify].gap,
        subjectZh: '验证',
        reasonZh: VERIFY_GAP[verify].gapZh,
      });
    }
  }
  // Medium discloses the reverse audit as a by-design omission — no FIX line
  // (above), honest wording here — and lets it stand as the one coverage entry
  // that caps a clean medium verdict at Comment, which is exactly what the tier
  // promises. A medium review is complete without the second look; it simply does
  // not certify the diff the way a high review does.
  if (balancedMedium) {
    gaps.push({
      subject: 'reverse audit',
      reason:
        'not run — the balanced (medium) tier skips the second-look pass, so ' +
        'this verdict is capped at Comment rather than Approve',
      subjectZh: '反向审计',
      reasonZh:
        '未运行——均衡（medium）档跳过二次审查步骤，因此本次判定上限为 Comment，不会 Approve',
      byDesign: true,
    });
  }

  return { ok: gaps.length === 0, gaps, remediation, unverifiedFindings };
}

export { TranscriptsUnavailableError };
