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
  requiredAgents,
  type RequiredAgent,
  type RosterPlan,
} from './roster.js';
import { BRIEFS } from './agent-briefs.js';
import { labelFromLaunchPrompt } from './agent-identity.js';
import { chunkIdsProblem } from './diff-plan.js';
import { readBudgetStop } from './deadline.js';
import { budgetGapDisclosures } from './budget.js';
import { shellQuotePath } from './shell-quote.js';

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
}

/** The plan, as far as coverage needs it. The roster reads more of it — see RosterPlan. */
interface Plan {
  diffPathAbsolute: string;
  chunks: Array<{
    id: number;
    startLine: number;
    endLine: number;
    files?: Array<{ path: string }>;
  }>;
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
  const problem = chunkIdsProblem(plan.chunks.map((c) => c?.id));
  if (problem) {
    throw new Error(`coverage: ${path} has ${problem}`);
  }
  return { plan, mtimeMs: statSync(path).mtimeMs };
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

/** `chunk 13 of 25` — written into the prompt by `agent-prompt`, in code. */
export const CHUNK_RE = /\bchunk\s+(\d+)\s+of\s+\d+\b/i;

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

/** Something a reader can act on. `agentName` is `general-purpose` for all of them. */
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
  const { plan, mtimeMs } = readPlan(planPath);
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

  const blindAgents: string[] = [];
  const idleAgents: string[] = [];
  const unopenedAgents: string[] = [];
  const rewrittenPrompts: string[] = [];
  const driftedLaunches: string[] = [];
  // Did this record's agent open the brief recorded under `key`? Compared as a
  // whole JSON string value (`successfulCallArgs` are serialized args), so a
  // `${brief}.bak` cannot be credited for the brief — the same trap
  // `parseTranscript` avoids for the diff path. Used by the verbatim-drift
  // rescue in both the chunk loop and the roster walk, and by the roster's
  // matching seed below.
  const openedBriefOf = (rec: AgentRecord, key: string): boolean => {
    const needle = JSON.stringify(briefPath(planPath, key));
    return rec.successfulCallArgs.some((a) => a.includes(needle));
  };
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
      const needle = JSON.stringify(briefPath(planPath, key));
      if (
        records.some(
          (r) =>
            r !== rec &&
            only(r) &&
            // Same return requirement as the chunk branch above.
            r.returned &&
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
      const needle = JSON.stringify(briefPath(planPath, key));
      if (
        records.some(
          (r) =>
            r !== rec &&
            r.returned &&
            wasDeliveredVerbatim(r.launchPrompt, b) &&
            r.successfulCallArgs.some((a) => a.includes(needle)) &&
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
        if (openedBriefOf(rec, `chunk-${chunk}`) && rec.diffToolCalls > 0) {
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

    // This record has passed every credit guard: it was given the diff, it
    // worked, and if it was pointed at lines it opened the file they live
    // in. Only now do its budget-gap lines count as disclosures.
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
    if (gaps.length > 0 && !gapsSuperseded(rec, chunk)) {
      budgetGaps.push({ agent: name, gaps });
    }

    // What it was told to read, plus what it demonstrably read. The second
    // term is what lets an agent handed the bare diff path with no
    // territory — a reverse-audit pass, a verifier — be credited for
    // exactly the lines it opened and for no others.
    const ranges = merge([...told, ...rec.diffReads]);
    if (ranges.length === 0) continue;

    const u = UNCOVERABLE_RE.exec(rec.finalText);
    if (u && chunk !== null && Number(u[1]) === chunk) {
      // The same supersession guard the sibling flags carry. Without it a
      // stale declaration — a prior attempt's agent on a resumed run, or a
      // relaunched agent's first try — permanently deletes live coverage
      // below (`for (const id of uncoverable) covered.delete(id)` is
      // post-loop and order-independent), so no compliant relaunch can ever
      // clear it and the verdict caps on lines this run demonstrably read.
      //
      // Narrowed to records that do not THEMSELVES declare this chunk: a
      // returned declarer clears `chunkSatisfied`'s bar (verbatim launch,
      // diff read), so two honest declarations otherwise annihilate each
      // other — the chunk lands in `missingChunks`, whose remediation
      // relaunches an agent that re-declares, forever. `gapsSuperseded`
      // below excludes same-shape records for exactly this reason.
      const redeclares = (r: AgentRecord): boolean => {
        const ru = UNCOVERABLE_RE.exec(r.finalText);
        return ru !== null && Number(ru[1]) === chunk;
      };
      if (!chunkSatisfied(chunk, rec, (r) => !redeclares(r))) {
        uncoverable.add(chunk);
      }
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
        const rescue = records.find(
          (r) =>
            !matchedRec.has(r) &&
            !rescued.has(r) &&
            r.successfulToolCalls > 0 &&
            (!needsDiff || r.diffToolCalls > 0) &&
            openedBriefOf(r, req.key),
        );
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
    // veto is chunk-scoped like the walk's: applied raw it also matches a
    // QUOTATION, and a recovered whole-diff auditor legitimately quotes the
    // declarations it audited.
    const declaredUnc = UNCOVERABLE_RE.exec(r.finalText);
    if (declaredUnc !== null) {
      const own = assignedChunk(r);
      if (own !== null && Number(declaredUnc[1]) === own) return false;
      if (own === null && r.diffToolCalls > 0 && assignedChunk(r) === null) {
        // A whole-diff record quoting a declaration is not declaring.
      }
    }
    const c = assignedChunk(r);
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
      files: (c.files ?? [])
        .map((f) => f?.path)
        .filter((p): p is string => typeof p === 'string' && p !== ''),
    })),
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
    // still leaves a matching `fNeedle`.
    // The old `wasDeliveredVerbatim` required the whole list in the delivered
    // prompt; the pointer proves delivery of the pointer line, not receipt of
    // the whole list. Accepted: the brief now orders the full read, and a
    // verifier that under-reads surfaces in the verdicts it gets wrong.
    const needle = JSON.stringify(briefPath(planPath, key));
    const opened = (r: AgentRecord) =>
      r.successfulCallArgs.some((a) => a.includes(needle));
    const findingsPointer = findingsPointerOf(b);
    const readTheFindings = (r: AgentRecord) => {
      if (findingsPointer === null) return true;
      const fNeedle = JSON.stringify(findingsPointer);
      // Successful read_file calls ONLY: every tool serializes its args, and
      // a `search_file_content` or a `list_directory` over the record dir
      // names the path without reading a line of it. The floor certifies
      // that the list was OPENED, and a mention is not an open.
      return r.successfulReadFileArgs.some((a) => a.includes(fNeedle));
    };
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
    });
  }

  return { ok: gaps.length === 0, gaps, remediation, unverifiedFindings };
}

export { TranscriptsUnavailableError };
