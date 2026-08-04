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
import { readRecordedPrompts, wasDeliveredVerbatim } from './prompt-record.js';

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

/** A finding's file line — the shape `FINDING_FORMAT` asks every role for. */
const FILE_LINE_RE = /\*\*File:\*\*\s*([^\n]*)/g;

/**
 * The no-issues receipt, and the substance bar it must clear.
 *
 * The reverse-audit brief demands a receipt that "names what it re-examined",
 * and its own model answer ("No issues found — re-walked the reconnect state
 * machine and the two changed exports' call sites; …") runs well past this
 * floor. A bare "No issues found." is sixteen characters, and it is exactly
 * what 23 real whiffing agents returned — text that specific-sounding and
 * that short is not evidence of a walk, so it must not be evidence of a cold
 * territory either. Mirrors the whiff-check philosophy rather than any exact
 * threshold of it: strict enough to reject the stock sentence, loose enough
 * to accept the brief's own model answer.
 */
const DRY_RECEIPT_RE = /No (new )?(issues|findings|gap)/i;
const DRY_MIN_CHARS = 120;

/**
 * Classify one auditor's return.
 *
 * `yielded` outranks everything: a return that files a finding against a
 * real file proves the territory hot, whatever else it says. `dry` requires
 * all of a substantive no-issues receipt AND the tool calls that make it
 * believable — an agent that never opened the diff has an opinion about
 * lines it did not read, which is the whiff wearing a costume (measured: 80
 * of 129 real transcripts made no tool call, and every one still returned
 * confident, specific-sounding prose). Anything else is `unknown`, which the
 * scheduler treats as NOT dry.
 */
function classifyReturn(rec: AgentRecord): AuditOutcome {
  const text = rec.finalText.trim();
  for (const m of text.matchAll(FILE_LINE_RE)) {
    const file = (m[1] ?? '').trim();
    if (file !== '' && !/^N\/A\b/i.test(file)) return 'yielded';
  }
  if (
    rec.successfulToolCalls > 0 &&
    rec.diffToolCalls > 0 &&
    DRY_RECEIPT_RE.test(text) &&
    text.length >= DRY_MIN_CHARS
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
 * only when `(round - lastDryRound)` is even — one round skipped, one round
 * cold-checked, alternating. The parity anchor is the round of the most
 * recent dry audit (the one that completed the two-in-a-row certificate, and
 * after that, each dry cold check — which shares its parity, so the
 * alternation never drifts). A retired chunk whose cold check yields simply
 * stops satisfying the two-most-recent-dry rule and is due every round
 * again; no state is kept anywhere, the history IS the state.
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
  const since = statSync(planPath).mtimeMs;
  const transcripts = readTranscripts(since, env, diffPath);
  const built = readRecordedPrompts(planPath);

  // chunk id → prior round → every outcome that round's records produced.
  const history = new Map<number, Map<number, AuditOutcome[]>>();
  for (const [key, prompt] of built) {
    const m = RECORD_KEY_RE.exec(key);
    if (!m) continue;
    const chunkId = Number(m[1]);
    const r = Number(m[2]);
    // Only PRIOR rounds are history. A record of the round being built is a
    // rebuild of it (a repaired delivery), not evidence about the territory.
    if (r >= round) continue;
    // A blank record is a partial write, not a prompt — the same input
    // `wasDeliveredVerbatim` fails closed on. Here it classifies `unknown`:
    // the round was scheduled for this chunk, and nothing proves it dry.
    const outcomes =
      prompt.trim() === ''
        ? []
        : transcripts
            .filter((t) => wasDeliveredVerbatim(t.launchPrompt, prompt))
            .map(classifyReturn);
    let byRound = history.get(chunkId);
    if (!byRound) {
      byRound = new Map();
      history.set(chunkId, byRound);
    }
    byRound.set(r, [...(byRound.get(r) ?? []), ...outcomes]);
  }

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
    const lastDry = lastTwo[1].round;
    if ((round - lastDry) % 2 === 0) {
      due.push(chunkId);
      coldChecks.push(chunkId);
    } else {
      skipped.push({
        chunkId,
        dryRounds: [lastTwo[0].round, lastTwo[1].round],
        // The next round with the cold-check parity — always round + 1 from
        // a skipped round, spelled as arithmetic so the certificate cannot
        // drift from the rule that computes `due`.
        nextColdCheck: round + ((round - lastDry) % 2),
      });
    }
  }

  return { due, coldChecks, skipped, converged: due.length === 0 };
}
