/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Per-chunk retirement for the Step 5 reverse-audit loop.
//
// On a 3B plan the loop launches one auditor PER CHUNK PER ROUND, up to five
// rounds. Measured on a real run (6 chunks × 5 rounds = 30 auditors, ~95
// minutes): chunks 3 and 6 came back dry in ALL five rounds, while chunks 1,
// 2 and 4 yielded in most of them. The loop's convergence rule is
// round-global — two consecutive dry ROUNDS — so one hot territory keeps
// every cold one under audit for the whole run: auditor after auditor
// re-walking code that has twice produced a substantive all-clear, on
// exactly the large reviews where the rounds they pad push the loop into the
// budget gate.
//
// So from round 3 on the schedule becomes per-chunk. A chunk whose two most
// recent audits are both substantive dry receipts is RETIRED: instead of an
// auditor every round it gets a cold check on alternating rounds, and a cold
// check that yields puts it straight back on the every-round schedule.
// Rounds 1 and 2 always fan out to every chunk — they are what establishes
// each chunk's record.
//
// The history this is read from is the same pair of artifacts every delivery
// check trusts: the prompts this CLI recorded itself building (keyed
// `reverse-audit--chunk-<n>--round-<k>--<digest>`) and the harness's own
// transcripts of the agents launched with them. Nothing the orchestrator
// writes is consulted — a schedule the subject of the checks could edit is a
// schedule that retires whatever chunk is inconvenient to audit.
//
// Everything here fails toward auditing, chunk by chunk: no transcripts, no
// matching transcript, a whiffed receipt, an unclassifiable return — each
// reads as "not dry", and a chunk that cannot prove itself cold stays hot.
// The failure mode of a bug in this file is the old behaviour (audit every
// territory every round), never a skipped one.

import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { readTranscripts, type AgentRecord } from './transcripts.js';
import { REVERSE_AUDIT_EXAMPLE_RECEIPT } from './agent-briefs.js';
import {
  deliveredVerbatimLines,
  findingsPointerOf,
  flattenPrompt,
  promptLines,
  promptRecordDir,
  readRecordedPrompts,
} from './prompt-record.js';
import { stripBudgetGapLines, INLINE_BUDGET_GAP_RE } from './budget.js';

/** What one prior audit of one chunk provably produced. */
export type AuditOutcome = 'yielded' | 'dry' | 'unknown';

/** A retired chunk skipped this round, with the receipts that earned it. */
export interface RetiredChunk {
  chunkId: number;
  /** The two most recent audit rounds — both substantive dry receipts. */
  dryRounds: [number, number];
  /** The next round whose parity puts the chunk back under audit. */
  nextColdCheck: number;
}

export interface RoundSchedule {
  /** Chunk ids to build this round, in the order the caller gave them. */
  due: number[];
  /** The subset of `due` that is a retired chunk's alternating cold check. */
  coldChecks: number[];
  /** Retired chunks NOT due this round — the retirement note names these. */
  skipped: RetiredChunk[];
  /** Every chunk is retired and none is due: the audit has converged. */
  converged: boolean;
}

/**
 * The round part of a per-chunk reverse-audit record key, as `runAllChunks`
 * and the single-chunk rebuild path both spell it. The digest tail is matched
 * loosely on purpose: its width is the digest function's business, and a key
 * this regex misses is merely history this module cannot see — fail-open.
 */
const RECORD_KEY_RE = /^reverse-audit--chunk-(\d+)--round-(\d+)--[0-9a-f]+$/;

/**
 * Every launch the builder emits for this loop carries the literal role id —
 * the identity line and the brief path both spell it, whitespace-free, so no
 * re-wrap can hide it — and each record's own lines carry it too, so a
 * transcript that could verbatim-match any record must contain it. That makes
 * it a sound cheap cut over the transcripts before the pairing walk.
 */
const REVERSE_AUDIT_MARKER = 'reverse-audit';

/**
 * The diff lines a record's prompt points its chunk at, 1-based and
 * inclusive. Every per-chunk launch this CLI builds bakes exactly one
 * `read_file(file_path="…", offset=N, limit=M)` aimed at the diff; the dry
 * bar compares what the transcript actually read against it. Empty when the
 * prompt bakes no read, where the bar falls back to "opened the diff at
 * all" — a shape this module's own records never have.
 *
 * The scan is bound to the diff's own path because the prompt carries other
 * `read_file` lines — the brief, the findings list file — and prose quoting
 * ANY `offset=N, limit=M` pair (a read_file call under discussion, this very
 * file in a diff) would otherwise inject its range into the territory. When
 * the findings list was folded into the prompt verbatim it did exactly that:
 * `openedTheTerritory` passes on ANY overlap with ANY range, so an injected
 * range can only WIDEN the bar — an auditor whose only diff read was lines
 * 1-50 would retire a chunk whose territory is 1001-1200 the moment a
 * finding quoted `offset=0, limit=50` — the same range-blind hole the
 * territory check exists to close, reopened by honest findings. Only a read
 * aimed at the diff is territory. An unknown diff path reads as no
 * territory: the transcripts side then marks no call a diff read, every
 * transcript classifies `unknown`, and no chunk retires — the territory is
 * never consulted.
 */
export function bakedRanges(
  prompt: string,
  diffPath: string | undefined,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (diffPath === undefined) return out;
  for (const m of prompt.matchAll(
    /read_file\(\s*file_path="([^"]*)",\s*offset=(\d+),\s*limit=(\d+)/gi,
  )) {
    if (m[1] !== diffPath) continue;
    const offset = Number(m[2]);
    const limit = Number(m[3]);
    if (limit > 0) out.push([offset + 1, offset + limit]);
  }
  return out;
}

/** A finding's file line — the shape `FINDING_FORMAT` asks every role for. */
const FILE_LINE_RE = /\*\*File:\*\*\s*([^\n]*)/g;

/**
 * The other half of a filed finding. A `**File:**` line alone is not proof
 * the auditor FILED anything: the auditor was launched against a cumulative
 * findings list (a `.findings.md` file its prompt points at), and an auditor
 * explaining "already covered, not re-reporting" can echo an entry's file
 * line into its return. Every finding actually filed carries the full block
 * the format mandates — severity included — so the pair is what
 * distinguishes a report from a bare file-line echo; a quotation of a WHOLE
 * entry is caught in `classifyReturn`, where the list is on hand. Misreading
 * an echo as `yielded` is cost, not corruption (the chunk just stays hot),
 * but it is exactly the cost this module exists to stop paying.
 */
const SEVERITY_LINE_RE = /\*\*Severity:\*\*/;

/**
 * The no-issues receipt, read by its STRUCTURE: the phrase, a dash or colon,
 * then the clause naming what was re-examined.
 *
 * The reverse-audit brief demands a receipt that "names what it re-examined",
 * and its own model answer has exactly this shape — "No issues found —
 * re-walked the reconnect state machine and the two changed exports' call
 * sites; …". A bare "No issues found." — the text 23 real whiffing agents
 * returned — has the phrase and nothing after it, and specific-sounding
 * brevity is not evidence of a walk. The first cut enforced a 120-character
 * floor on the whole return instead of this structure, and both of its
 * failure modes pointed the same silent way: an honest 78-character English
 * receipt and a Chinese receipt of ANY length both read `unknown`, and the
 * chunk never retired — on exactly the budgeted runs the optimization exists
 * for. Auditors narrate in the review's output language (`未发现问题` is the
 * phrasing compose-review itself ships), so the phrase accepts the zh forms
 * beside the English ones.
 *
 * The separator admits an em/en dash anywhere (`——` doubled included), a
 * colon in either width, and an ASCII hyphen only when it stands alone —
 * space-led or doubled — so the dash inside `retry-cap` never opens a clause
 * mid-word. Closing emphasis and quotation may sit between the phrase and
 * the separator — auditors bold the phrase (`**No issues found** — …`,
 * `**未发现新问题** —— …`) in the same `**File:**` / `**Severity:**` idiom
 * the rest of the pipeline writes in, and a receipt refused on a bold mark
 * reads `unknown` and never retires, on exactly the budgeted runs the
 * optimization exists for. The filler between phrase and separator (`were
 * found`, `were detected`, a parenthesised scope) is capped and word-only
 * apart from parentheses: a period or other markdown in between is a new
 * sentence, not this receipt.
 */
const DRY_RECEIPT_RE = new RegExp(
  '(?:\\bno (?:new )?(?:issues?|findings?|gaps?)[ \\w()]{0,32}?' +
    '|未发现(?:新的?)?(?:问题|发现)' +
    '|无新的?(?:问题|发现)' +
    '|没有(?:发现)?(?:新的?)?问题)' +
    '\\s*[*_)\\]"”’]*\\s*(?:[—–]+|[:：]|--+|-+\\s)\\s*' +
    '([\\s\\S]*)',
  'i',
);

/** CJK ideographs — a zh clause packs its substance into far fewer chars. */
const CJK_RE = /[一-鿿]/g;

/**
 * The clause the brief's own example receipt leaves AFTER its separator —
 * extracted with the same regex that parses receipts, so the two cannot
 * drift. Empty when the example ever stops matching its own parser, which
 * disables the parrot refusal rather than refuse every clause.
 */
const EXAMPLE_RECEIPT_CLAUSE = (
  DRY_RECEIPT_RE.exec(REVERSE_AUDIT_EXAMPLE_RECEIPT)?.[1] ?? ''
).trim();

/**
 * Does the clause after the receipt's separator name anything? An ENCLOSED
 * code span or a real path is a named object at any length — a stray
 * backtick is prose punctuation, not a quotation, and "N/A" is not a path
 * (one character on the slash's left), neither is the conjunction "and/or":
 * a path has a second slash or a dotted extension. Otherwise ~20 flattened
 * characters, or a handful of ideographs, is the least that can name a
 * territory; "all good." can not. The brief's own example receipt is
 * refused outright, but only VERBATIM: a clause containing the example's
 * whole clause reads as the parrot it is, while real parroting is partial
 * — the shape and a phrase or two — and a partial echo passes this check;
 * what catches that is the rest of the dry bar (the territory read, the
 * substance floor). This refusal closes the cheapest path: the exact
 * sentence every auditor is handed. Misjudging here fails the way
 * everything in this module fails — the receipt reads `unknown` and the
 * chunk stays under audit.
 */
function substantiveClause(clause: string): boolean {
  const c = clause.replace(/\s+/g, ' ').trim();
  if (c.length === 0) return false;
  if (EXAMPLE_RECEIPT_CLAUSE.length > 0 && c.includes(EXAMPLE_RECEIPT_CLAUSE)) {
    return false;
  }
  if (/`[^`]+`/.test(c)) return true;
  if (/\w[\w.-]+\/[\w.$-]+\/\w/.test(c)) return true;
  if (/\w[\w.-]+\/[\w$-]+\.\w+/.test(c)) return true;
  if ((c.match(CJK_RE) ?? []).length >= 4) return true;
  return c.length >= 20;
}

/**
 * The cumulative findings list an auditor was launched against. Since #8597
 * the list rides a digest-named `.findings.md` file the prompt points at —
 * read it back; a prompt with no pointer predates the file shape (or its
 * file is gone), and the prompt itself is the fallback, which is where the
 * list lived before. The pointer is the CLI's own record's (never the
 * orchestrator's pasted copy, which `wasDeliveredVerbatim` allows additions
 * around), confined to this plan's record dir before reading; an unreadable
 * or out-of-bounds file degrades to the prompt: no entry matches there, a
 * quotation counts as a yield, and the chunk stays hot — every failure in
 * this module lands on the audit side. `memo` keys on the pointer so the
 * pairing walk reads each round's list once, not once per record.
 */
function findingsListFor(
  prompt: string,
  recordDir: string,
  memo: Map<string, string>,
): string {
  const pointer = findingsPointerOf(prompt);
  if (pointer === null) return prompt;
  const root = resolve(recordDir);
  const target = resolve(pointer);
  if (target !== root && !target.startsWith(root + sep)) return prompt;
  const cached = memo.get(pointer);
  if (cached !== undefined) return cached;
  try {
    const content = readFileSync(target, 'utf8');
    // Memoize ONLY a successful read: the pointer is shared by every chunk of
    // the round (the file key is chunk-free), so caching a failure's fallback
    // — THIS record's prompt — would serve one chunk's launch text as every
    // other chunk's findings list. On a miss each record falls back to its
    // OWN prompt (no entry matches there → stays hot), uncached.
    memo.set(pointer, content);
    return content;
  } catch {
    return prompt; // Fall back to this record's own prompt.
  }
}

/**
 * Classify one auditor's return.
 *
 * `yielded` outranks everything: a return that files a finding against a
 * real file proves the territory hot, whatever else it says. `dry` requires
 * all of a structurally substantive no-issues receipt AND the tool calls
 * that make it believable — an agent that never opened the diff has an
 * opinion about lines it did not read, which is the whiff wearing a costume
 * (measured: 80 of 129 real transcripts made no tool call, and every one
 * still returned confident, specific-sounding prose) — AND the read must
 * land in the chunk's territory: a successful read of the diff's first
 * screenful proves nothing about lines a thousand down. Anything else is
 * `unknown`, which the scheduler treats as NOT dry.
 *
 * `territory` is the diff lines the record's own prompt bakes for this
 * chunk (1-based, inclusive); empty when it bakes no read, where the old
 * bar — any successful diff read — stands.
 */
function classifyReturn(
  rec: AgentRecord,
  territory: Array<[number, number]>,
  findingsList: string,
): AuditOutcome {
  const text = rec.finalText.trim();
  if (SEVERITY_LINE_RE.test(text)) {
    // The cumulative list is on hand for this agent: since #8597 it rides
    // a digest-named findings file the launch prompt points at (before, it
    // was folded into the prompt verbatim), and every entry in it is a full
    // block — File AND Severity. An auditor explaining "already covered,
    // not re-reporting" can quote one whole, and the quotation must not
    // read as a filing: an entry whose exact file line is already on the
    // list cannot be a new finding against it. Skipping costs an audit at
    // most; counting a quotation re-opens the never-retire direction on
    // the loop's most common honest return.
    for (const m of text.matchAll(FILE_LINE_RE)) {
      const file = (m[1] ?? '').trim();
      if (file === '' || /^N\/A\b/i.test(file)) continue;
      if (findingsList.includes(`**File:** ${file}`)) continue;
      return 'yielded';
    }
  }
  // The receipt is judged WITHOUT its budget-gap disclosure lines. Two
  // failure modes bound this from opposite sides. An auditor's admission of
  // what its soft ceiling cut short must not double as the receipt's
  // substantive clause — stripped, a return whose only substance was its
  // disclosures reads `unknown` and the chunk stays under audit. But a
  // receipt that is substantive WITHOUT them — a real walk of the
  // territory, proven by the same tool-call and territory-read bar as
  // ever, that found nothing new and separately disclosed exploration it
  // did not take — still retires: an earlier draft read any gap-bearing
  // return as `unknown`, and since a reverse auditor's ceiling is routinely
  // met (its brief orders a 65-82 KB findings list read in full), that made
  // convergence impossible and ran every budgeted loop to the round cap —
  // the exact never-retire failure this module's own docstrings warn
  // about. The gap itself is not lost: coverage reports it and Step 3D
  // rules on it; retirement certifies the audit that DID happen, not the
  // exploration that did not.
  const judged = stripBudgetGapLines(text);
  const receipt = DRY_RECEIPT_RE.exec(judged);
  // The clause is cut at any INLINE disclosure marker before its substance
  // is judged: a one-line return (`No new issues found — …; Budget gap: X`)
  // slips past the line-based strip, and the `[\s\S]*` capture would
  // otherwise absorb the gap text and get its substantiveness from it —
  // the admission doubling as the receipt again, one line lower.
  const clause = receipt?.[1] ?? '';
  const inlineGap = INLINE_BUDGET_GAP_RE.exec(clause);
  const judgedClause =
    inlineGap === null ? clause : clause.slice(0, inlineGap.index);
  if (
    rec.successfulToolCalls > 0 &&
    rec.diffToolCalls > 0 &&
    openedTheTerritory(rec.diffReads, territory) &&
    receipt !== null &&
    substantiveClause(judgedClause)
  ) {
    return 'dry';
  }
  return 'unknown';
}

/**
 * Whether any of the transcript's reads lands in the chunk's baked
 * territory. Overlap is the bar, not containment: an honest auditor pages
 * an oversized chunk, and each page overlaps the territory even though no
 * single read holds it all. A read with no line range (a `read_file` with
 * no limit) proves no lines at all and overlaps nothing.
 */
export function openedTheTerritory(
  diffReads: Array<[number, number]>,
  territory: Array<[number, number]>,
): boolean {
  if (territory.length === 0) return true;
  return diffReads.some(([s, e]) =>
    territory.some(([ts, te]) => s <= te && ts <= e),
  );
}

/**
 * One outcome for one (chunk, round), from every record and transcript that
 * spoke to it. A round can legitimately have several of both — a same-round
 * rebuild with corrected rules is a second record; a relaunch is a second
 * transcript — and the merge fails toward auditing: any yield proves the
 * territory hot, a dry needs at least one substantive receipt and no yield,
 * and an empty set proves nothing.
 */
function mergeOutcomes(outcomes: AuditOutcome[]): AuditOutcome {
  if (outcomes.includes('yielded')) return 'yielded';
  if (outcomes.includes('dry')) return 'dry';
  return 'unknown';
}

/**
 * Which chunks round `round` owes an auditor, from the audit history the
 * harness and the prompt records agree on.
 *
 * Retirement: a chunk whose two most recent audits are both `dry` is due
 * only on even rounds — one round skipped, one round cold-checked,
 * alternating on a SINGLE global parity every retired chunk shares, so
 * staggered certificates re-align and the all-retired convergence stays
 * reachable (the loop below says why the anchor is not the chunk's own
 * parity). A retired chunk whose cold check yields simply stops satisfying
 * the two-most-recent-dry rule and is due every round again; no state is
 * kept anywhere, the history IS the state.
 *
 * Throws whatever the transcript or record readers throw
 * (`TranscriptsUnavailableError` included): the CALLER owns the fail-open,
 * because the right degradation — build every chunk — is a build decision,
 * not a schedule.
 */
export function scheduleReverseAuditRound(
  planPath: string,
  chunkIds: number[],
  round: number,
  env: NodeJS.ProcessEnv = process.env,
  diffPath?: string,
): RoundSchedule {
  // Rounds 1 and 2 establish each chunk's record; retirement needs two
  // consecutive dry audits, so nothing can retire before round 3.
  if (round < 3) {
    return {
      due: [...chunkIds],
      coldChecks: [],
      skipped: [],
      converged: false,
    };
  }

  // Transcripts older than the plan belong to a previous review in the same
  // session — the same collision `coverageFromTranscripts` guards against.
  // The records take the SAME fence: nothing clears the record dir, and the
  // CI retry of a dead attempt re-runs the review at the same plan path with
  // the dead attempt's records still on disk. The retry's honest launch —
  // its findings list a superset of the dead attempt's, in the same order —
  // verbatim-contains BOTH records for a (chunk, round), so unfenced records
  // trip the injectivity guard below (two records, one transcript, neither
  // certified): fail-safe, but retirement silently off on exactly the
  // retries with the least time left. A record older than the plan is the
  // dead attempt's, and reads as absent.
  const since = statSync(planPath).mtimeMs;
  const transcripts = readTranscripts(since, env, diffPath);
  const built = readRecordedPrompts(planPath, since);

  // The prior-round records: one per (chunk, round) prompt this CLI built.
  // Only PRIOR rounds are history — a record of the round being built is a
  // rebuild of it (a repaired delivery), not evidence about the territory.
  const recordDir = promptRecordDir(planPath);
  const findingsMemo = new Map<string, string>();
  const records: Array<{
    chunkId: number;
    round: number;
    lines: string[];
    territory: Array<[number, number]>;
    findings: string;
  }> = [];
  for (const [key, prompt] of built) {
    const m = RECORD_KEY_RE.exec(key);
    if (!m) continue;
    const r = Number(m[2]);
    if (r >= round) continue;
    records.push({
      chunkId: Number(m[1]),
      round: r,
      // Flattened ONCE per record, beside the once-per-transcript flatten
      // below: the pairing walk pays neither half per (record, transcript)
      // pair.
      lines: promptLines(prompt),
      territory: bakedRanges(prompt, diffPath),
      findings: findingsListFor(prompt, recordDir, findingsMemo),
    });
  }

  // Which transcripts certify which record — injectively, in the direction
  // that actually bounds the shortcut: how many RECORDS each transcript
  // matches. `wasDeliveredVerbatim` allows additions, so a launch prompt
  // that verbatim-contains SEVERAL recorded prompts matches every one of
  // them: one agent handed several blocks (or a whole round concatenated)
  // is the shortcut this module exists to catch. That shortcut is ONE
  // launch, and counting transcripts per record cannot see it — the single
  // transcript is each record's unique match, so every chunk would be
  // credited the same dry receipt and the round would retire whole. So
  // invert the relation: a transcript that matches several records names
  // no territory specifically and certifies none — the failure lands where
  // every failure here lands, on the audit side. Honest launches are
  // untouched either way: the round number and each chunk's territory are
  // baked into the prompt, so one matches exactly one record, its own —
  // and several honest transcripts for one record (the mandated whiff
  // relaunch) each certify it, the multi-transcript merge `mergeOutcomes`
  // promises.
  //
  // The pairing walk is O(records × transcripts) over multi-KB prompts, on
  // the critical path before the round is admitted — so cut the transcript
  // side down to the launches that carry the role marker first (a launch
  // that could match any record contains it; see REVERSE_AUDIT_MARKER), and
  // flatten each survivor ONCE instead of once per pair (the record side is
  // already flattened once per record, above). A transcript the cut drops
  // fails the way everything here fails: it certifies nothing, and its
  // chunk stays under audit.
  const candidates = transcripts
    .filter((t) => t.launchPrompt.includes(REVERSE_AUDIT_MARKER))
    .map((t) => ({ transcript: t, flat: flattenPrompt(t.launchPrompt) }));
  const matchesByRecord = records.map((rec) =>
    candidates
      .filter((c) => deliveredVerbatimLines(c.flat, rec.lines))
      .map((c) => c.transcript),
  );
  const recordsPerTranscript = new Map<AgentRecord, number>();
  for (const matches of matchesByRecord) {
    for (const t of matches) {
      recordsPerTranscript.set(t, (recordsPerTranscript.get(t) ?? 0) + 1);
    }
  }
  const outcomesByRecord = matchesByRecord.map((matches, i) =>
    matches
      .filter((t) => recordsPerTranscript.get(t) === 1)
      .map((t) => classifyReturn(t, records[i].territory, records[i].findings)),
  );

  // chunk id → prior round → every outcome that round's records produced. A
  // record no transcript certifies (a blank partial write, an undelivered
  // build, an ambiguous launch) contributes nothing, and its round
  // classifies `unknown`: the round was scheduled for this chunk, and
  // nothing proves it dry.
  const history = new Map<number, Map<number, AuditOutcome[]>>();
  records.forEach((rec, i) => {
    let byRound = history.get(rec.chunkId);
    if (!byRound) {
      byRound = new Map();
      history.set(rec.chunkId, byRound);
    }
    byRound.set(rec.round, [
      ...(byRound.get(rec.round) ?? []),
      ...outcomesByRecord[i],
    ]);
  });

  const due: number[] = [];
  const coldChecks: number[] = [];
  const skipped: RetiredChunk[] = [];
  for (const chunkId of chunkIds) {
    const audits = [...(history.get(chunkId)?.entries() ?? [])]
      .map(([r, outcomes]) => ({ round: r, outcome: mergeOutcomes(outcomes) }))
      .sort((a, b) => a.round - b.round);
    const lastTwo = audits.slice(-2);
    const retired =
      lastTwo.length === 2 && lastTwo.every((a) => a.outcome === 'dry');
    if (!retired) {
      // Hot — including a chunk with no history at all, one whose latest
      // receipt was a whiff, and one whose cold check yielded.
      due.push(chunkId);
      continue;
    }
    // Cold checks land on ONE global parity — the even rounds — not on the
    // chunk's own certificate parity. Per-chunk anchors never re-align: a
    // chunk dry in rounds 2,3 (last dry round odd) beside one dry in 1,2
    // (even) cold-checks on opposite rounds forever, the all-retired
    // CONVERGED exit can never fire, and the loop always runs to the cap —
    // on exactly the staggered large-PR shape retirement exists for. A
    // certificate that completes on an odd last-dry round simply takes its
    // first cold check one round sooner; after that every retired chunk
    // skips and cold-checks together, and convergence is reachable again.
    if (round % 2 === 0) {
      due.push(chunkId);
      coldChecks.push(chunkId);
    } else {
      skipped.push({
        chunkId,
        dryRounds: [lastTwo[0].round, lastTwo[1].round],
        // The next even round — this branch only runs on odd rounds, so
        // that is always round + 1. Whether the cap allows it is the note
        // composer's question, not the schedule's: the plan's cap
        // (`reverseAuditRoundCap` in budget.ts, floored at the huge-diff
        // tier's 3) is what the admission gate enforces.
        nextColdCheck: round + 1,
      });
    }
  }

  return {
    due,
    coldChecks,
    skipped,
    // An empty `chunkIds` empties `due` vacuously — nothing was ever under
    // audit, so nothing has proven itself cold. `runAllChunks` refuses a
    // chunkless plan long before scheduling, but this function is exported,
    // and convergence is an exit-5 termination rule: it must not be
    // reachable from nothing.
    converged: chunkIds.length > 0 && due.length === 0,
  };
}
