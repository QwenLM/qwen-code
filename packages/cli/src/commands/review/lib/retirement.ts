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

import { statSync } from 'node:fs';
import { readTranscripts, type AgentRecord } from './transcripts.js';
import {
  deliveredVerbatim,
  flattenPrompt,
  readRecordedPrompts,
} from './prompt-record.js';

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

/** A finding's file line — the shape `FINDING_FORMAT` asks every role for. */
const FILE_LINE_RE = /\*\*File:\*\*\s*([^\n]*)/g;

/**
 * The other half of a filed finding. A `**File:**` line alone is not proof
 * the auditor FILED anything: the cumulative list is folded into its launch
 * prompt, and an auditor explaining "already covered, not re-reporting" can
 * echo an entry's file line into its return. Every finding actually filed
 * carries the full block the format mandates — severity included — so the
 * pair is what distinguishes a report from a quotation. Misreading an echo
 * as `yielded` is cost, not corruption (the chunk just stays hot), but it is
 * exactly the cost this module exists to stop paying.
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
 * mid-word. The filler between phrase and separator (`were found`, `were
 * detected`) is capped and word-only: a period or markdown in between is a
 * new sentence, not this receipt.
 */
const DRY_RECEIPT_RE = new RegExp(
  '(?:\\bno (?:new )?(?:issues?|findings?|gaps?)[ \\w]{0,32}?' +
    '|未发现(?:新的?)?(?:问题|发现)' +
    '|无新的?(?:问题|发现)' +
    '|没有(?:发现)?(?:新的?)?问题)' +
    '\\s*(?:[—–]+|[::]|--+|-+\\s)\\s*' +
    '([\\s\\S]*)',
  'i',
);

/** CJK ideographs — a zh clause packs its substance into far fewer chars. */
const CJK_RE = /[一-鿿]/g;

/**
 * Does the clause after the receipt's separator name anything? A quoted
 * symbol or a real path is a named object at any length ("N/A" is not a path
 * — one character on the slash's left). Otherwise ~20 flattened characters,
 * or a handful of ideographs, is the least that can name a territory; "all
 * good." can not. Misjudging here fails the way everything in this module
 * fails — the receipt reads `unknown` and the chunk stays under audit.
 */
function substantiveClause(clause: string): boolean {
  const c = clause.replace(/\s+/g, ' ').trim();
  if (c.length === 0) return false;
  if (c.includes('`')) return true;
  if (/\w[\w.-]+\/[\w.$/-]*\w/.test(c)) return true;
  if ((c.match(CJK_RE) ?? []).length >= 4) return true;
  return c.length >= 20;
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
 * still returned confident, specific-sounding prose). Anything else is
 * `unknown`, which the scheduler treats as NOT dry.
 */
function classifyReturn(rec: AgentRecord): AuditOutcome {
  const text = rec.finalText.trim();
  if (SEVERITY_LINE_RE.test(text)) {
    for (const m of text.matchAll(FILE_LINE_RE)) {
      const file = (m[1] ?? '').trim();
      if (file !== '' && !/^N\/A\b/i.test(file)) return 'yielded';
    }
  }
  const receipt = DRY_RECEIPT_RE.exec(text);
  if (
    rec.successfulToolCalls > 0 &&
    rec.diffToolCalls > 0 &&
    receipt !== null &&
    substantiveClause(receipt[1] ?? '')
  ) {
    return 'dry';
  }
  return 'unknown';
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
  // Rounds 1 and 2 establish the record; there is nothing to retire on.
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
  const records: Array<{ chunkId: number; round: number; prompt: string }> = [];
  for (const [key, prompt] of built) {
    const m = RECORD_KEY_RE.exec(key);
    if (!m) continue;
    const r = Number(m[2]);
    if (r >= round) continue;
    records.push({ chunkId: Number(m[1]), round: r, prompt });
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
  // flatten each survivor ONCE instead of once per pair. A transcript the
  // cut drops fails the way everything here fails: it certifies nothing,
  // and its chunk stays under audit.
  const candidates = transcripts
    .filter((t) => t.launchPrompt.includes(REVERSE_AUDIT_MARKER))
    .map((t) => ({ transcript: t, flat: flattenPrompt(t.launchPrompt) }));
  const matchesByRecord = records.map((rec) =>
    candidates
      .filter((c) => deliveredVerbatim(c.flat, rec.prompt))
      .map((c) => c.transcript),
  );
  const recordsPerTranscript = new Map<AgentRecord, number>();
  for (const matches of matchesByRecord) {
    for (const t of matches) {
      recordsPerTranscript.set(t, (recordsPerTranscript.get(t) ?? 0) + 1);
    }
  }
  const outcomesByRecord = matchesByRecord.map((matches) =>
    matches
      .filter((t) => recordsPerTranscript.get(t) === 1)
      .map(classifyReturn),
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
        // that is always round + 1.
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
