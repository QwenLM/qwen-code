/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The pre-verify carried-ledger dedup (issue #10105).
//
// On a re-review round the Step 3 finders re-derive findings earlier rounds
// already reported, and every one of them used to ride a Step 4 verify shard
// before the posting layer dropped it as a duplicate — the most expensive
// point in the pipeline, repeated every round for as long as the original
// threads stay open (measured on PR #9729: rounds 12 and 13 confirmed 7 and 8
// already-reported Suggestions each, all verified first). This command is the
// mechanical step between the finder union and the verify shard: it matches
// the pooled candidates against the carried ledger — the prev-ledger side
// file's posted work list, plus the previous round's saved findings
// artifact's deferral entries when that artifact exists on this machine — and
// drops a match before any verifier is spent on it. In the spirit of #7751's
// script-lint gate, the model is out of the matching loop: the report it
// writes is what the orchestrator shards from and what `compose-review`
// reads to disclose the set-aside count.
//
// The matching is deliberately conservative. A false NEGATIVE costs nothing
// new — the candidate rides to verification and the posting layer's
// duplicate drop remains the backstop, exactly the status quo — while a
// false POSITIVE would silently lose a genuinely new finding before any
// stage could recover it. So a drop requires the same file, anchor
// proximity when both sides carry a line, and high claim similarity — and a
// Critical candidate is never dropped against a non-Critical entry, so an
// escalation always reaches verification. A dropped candidate's claim is
// not lost either way: a matched posted finding is a ledger entry Step 6
// still rules on against the code (the ruling never leans on this drop),
// and a matched deferral stays on the standing deferral record.
//
// Trust shape: the side file is recovered from the posted review body,
// another account's writable surface. A planted entry can therefore divert a
// matching candidate from the verify shard — but the entry it matched is
// then ruled by Step 6 against the code like any carried finding, so the
// claim degrades to ruling rigor rather than disappearing, and the severity
// guard keeps a planted Suggestion from touching any Critical candidate.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CommandModule } from 'yargs';
import {
  LEDGER_ID_SHAPE,
  isLedgerFinding,
  isStandInName,
  normalizeLedgerFinding,
  type Ledger,
  type LedgerFinding,
} from './lib/ledger.js';
import { isPositivePrNumber } from './lib/roster.js';
import { diffHashOf } from './script-lint.js';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';

/**
 * A deferred finding's id in the findings artifact (`D<round>-<n>` — Step 6's
 * "one finding, one name" rule gives deferrals their own sequence so the `R`
 * counter keeps predicting `buildLedger`). The artifact is the only machine
 * copy of the deferral list a next round can reach today, and the id shape is
 * how its deferral entries are told apart from everything else it holds.
 */
export const DEFERRED_ID_SHAPE = /^D\d+-\d+$/;

/** Anchor proximity: how far apart two lines may sit and still be one claim. */
export const DEDUP_LINE_TOLERANCE = 5;
/** Claim similarity (Jaccard over title tokens) when anchor proximity holds. */
export const DEDUP_MIN_SIMILARITY = 0.6;
/** The stricter bar when either side carries no line to compare. */
export const DEDUP_LINELESS_SIMILARITY = 0.75;
/** A one-word overlap is coincidence, not similarity, whatever the ratio. */
export const DEDUP_MIN_SHARED_TOKENS = 2;

const CANDIDATE_SEVERITIES = ['Critical', 'Suggestion', 'Nice to have'];

/**
 * One pooled candidate, as the orchestrator writes it after the Step 4
 * finder-union merge. Only the four matching fields are validated; everything
 * else rides through untouched, so the report's `kept` list stays sufficient
 * to build the verify shard files from (failure scenario, source tags, …).
 */
export interface DedupCandidate {
  file: string;
  title: string;
  severity: string;
  line?: number;
  [key: string]: unknown;
}

/** One carried-ledger entry a candidate can match. */
interface CarriedEntry {
  id: string;
  file: string;
  line?: number;
  critical: boolean;
  /** The texts similarity runs over — a ledger title, or an artifact
   *  entry's summary and shortSummary; the best score counts. */
  texts: string[];
  via: 'posted' | 'deferred';
}

export interface DroppedCandidate {
  file: string;
  line?: number;
  title: string;
  severity: string;
  matchedId: string;
  matchedTitle: string;
  via: 'posted' | 'deferred';
}

export interface LedgerDedupReport {
  v: 1;
  /**
   * Hash of the plan's captured diff — the freshness key `ledgerDedupFacts`
   * verifies, exactly as the script-lint gate binds its report. Absent when
   * the diff could not be read; the disclosure then stays silent rather than
   * quoting a report it cannot place.
   */
  diffHash?: string;
  sources: {
    ledger: { round: number; findings: number } | null;
    artifact: { name: string; deferred: number } | null;
  };
  /** THIS invocation's surviving candidates — what the verify shards are
   *  built from. Not cumulative: earlier invocations' kept entries are
   *  already sharded. */
  kept: DedupCandidate[];
  /** Cumulative within the round: a repeat invocation (a Step 5 reporting
   *  round's fresh findings) merges onto the same-diff report on disk. */
  dropped: DroppedCandidate[];
  droppedCount: number;
  note: string;
}

interface DedupArgs {
  plan: string;
  candidates: string;
  out?: string;
}

/**
 * The report filename `compose-review` derives too — pr-numbered when the
 * plan resolved a PR, the stable local name otherwise (mirroring the
 * script-lint convention, and covered by cleanup's `qwen-review-<target>-*`
 * sweep on PR targets the same way).
 */
export function ledgerDedupReportName(pr: unknown): string {
  return isPositivePrNumber(pr)
    ? `qwen-review-pr-${pr}-ledger-dedup.json`
    : 'qwen-review-ledger-dedup.json';
}

/**
 * The typed candidates channel. Hard-validated like every other typed
 * boundary (`toDeferredEntries`): a shapeless entry is refused with its
 * index, never silently skipped — a skipped entry would dodge the dedup on
 * exactly the rounds it exists for, and the orchestrator can fix the file.
 */
export function validateCandidates(raw: unknown): DedupCandidate[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `dedup-candidates: the candidates file must hold a JSON array of ` +
        `{file, line?, title, severity} entries, got ${JSON.stringify(raw)?.slice(0, 200)}`,
    );
  }
  return raw.map((entry, i) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(
        `dedup-candidates: candidates[${i}] must be an object {file, line?, title, severity}`,
      );
    }
    const c = entry as Record<string, unknown>;
    if (typeof c['file'] !== 'string' || c['file'].trim() === '') {
      throw new Error(
        `dedup-candidates: candidates[${i}] needs a non-empty string file`,
      );
    }
    if (typeof c['title'] !== 'string' || c['title'].trim() === '') {
      throw new Error(
        `dedup-candidates: candidates[${i}] needs a non-empty string title`,
      );
    }
    if (
      typeof c['severity'] !== 'string' ||
      !CANDIDATE_SEVERITIES.includes(c['severity'])
    ) {
      throw new Error(
        `dedup-candidates: candidates[${i}].severity must be one of ` +
          `${CANDIDATE_SEVERITIES.join('|')}, got ${JSON.stringify(c['severity'])}`,
      );
    }
    if (
      c['line'] !== undefined &&
      (typeof c['line'] !== 'number' ||
        !Number.isInteger(c['line']) ||
        c['line'] < 1)
    ) {
      throw new Error(
        `dedup-candidates: candidates[${i}].line must be a positive integer when present`,
      );
    }
    return c as DedupCandidate;
  });
}

/** Path equality across the two model-written sides, nothing cleverer. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

/**
 * Title tokens for the similarity test: lowercased identifier-ish runs of
 * three characters or more. Short function words drop out by length alone —
 * no stopword list to maintain — and what remains is the claim's vocabulary.
 */
export function titleTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_$.]{3,}/g) ?? []);
}

function jaccard(
  a: Set<string>,
  b: Set<string>,
): { sim: number; shared: number } {
  if (a.size === 0 || b.size === 0) return { sim: 0, shared: 0 };
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return { sim: shared / (a.size + b.size - shared), shared };
}

/**
 * Does this candidate restate this carried entry? Same file, anchor
 * proximity when both sides carry one, and claim similarity above the bar —
 * with the severity guard first: a Critical candidate may only drop against
 * a Critical entry, so an escalation of a carried Suggestion still reaches
 * verification (Step 6 re-reports a still-standing entry at its recorded
 * severity; nothing downstream would recover the upgrade).
 */
export function candidateMatches(
  candidate: DedupCandidate,
  entry: CarriedEntry,
): boolean {
  if (candidate.severity === 'Critical' && !entry.critical) return false;
  if (normalizePath(candidate.file) !== normalizePath(entry.file)) return false;
  const candTokens = titleTokens(candidate.title);
  let best = { sim: 0, shared: 0 };
  for (const text of entry.texts) {
    const s = jaccard(candTokens, titleTokens(text));
    if (s.sim > best.sim) best = s;
  }
  if (best.shared < DEDUP_MIN_SHARED_TOKENS) return false;
  if (candidate.line !== undefined && entry.line !== undefined) {
    if (Math.abs(candidate.line - entry.line) > DEDUP_LINE_TOLERANCE) {
      return false;
    }
    return best.sim >= DEDUP_MIN_SIMILARITY;
  }
  return best.sim >= DEDUP_LINELESS_SIMILARITY;
}

/**
 * The side file's posted work list, through the ledger's own admission test
 * and caps — the same read `prevLedgerFacts` performs, because the side file
 * is an untrusted shape arriving beside the plan, not a marker `parseLedger`
 * already normalised. Null when absent or shapeless (round 1, a fresh
 * environment, a non-PR plan): the dedup then has no posted list to match,
 * which fails open to keeping every candidate.
 */
function postedEntries(
  planDir: string,
  pr: unknown,
): { entries: CarriedEntry[]; round: number } | null {
  let prev: Ledger;
  try {
    prev = JSON.parse(
      readFileSync(
        join(planDir, `qwen-review-pr-${pr}-prev-ledger.json`),
        'utf8',
      ),
    ) as Ledger;
  } catch {
    return null;
  }
  const round =
    Number.isInteger(prev?.round) && prev.round > 0 ? prev.round : 0;
  if (round === 0 || !Array.isArray(prev.findings)) return null;
  const entries = prev.findings
    .filter((f): f is LedgerFinding => isLedgerFinding(f, round))
    .map(normalizeLedgerFinding)
    // A stand-in path (`(body)`, `(unknown)`) names no file unless the `k`
    // flag says it literally is one — same exclusion the convergence join
    // applies, or a body-only Critical would match any pathless claim.
    .filter((f) => !isStandInName(f.file) || f.k === 1)
    .map((f) => ({
      id: f.id,
      file: f.file,
      ...(f.line !== undefined ? { line: f.line } : {}),
      critical: f.sev === 'C',
      texts: [f.title],
      via: 'posted' as const,
    }));
  return { entries, round };
}

/**
 * The previous round's deferral entries, from the newest saved findings
 * artifact for this PR (`.qwen/reviews/<date>-<time>-pr-<n>.json`). Only the
 * `D<round>-<n>` entries participate: a posted finding is matched through
 * the side file above (the authoritative cross-environment work list), and
 * an artifact `R` entry may predate rounds the ledger has since ruled — while
 * a low-confidence terminal-only finding must never absorb a candidate at
 * all, because nothing downstream would rule on it and the claim would
 * simply vanish. Local-only by nature, exactly like the incremental cache:
 * a CI or fresh-clone round has no artifact and loses only the deferral half.
 */
function deferredEntries(
  planDir: string,
  pr: unknown,
): { entries: CarriedEntry[]; name: string } | null {
  const reviewsDir = resolve(planDir, '..', 'reviews');
  const pattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-\\d{6}-pr-${pr}\\.json$`);
  let newest: string | undefined;
  try {
    newest = readdirSync(reviewsDir)
      .filter((name) => pattern.test(name))
      .sort()
      .at(-1);
  } catch {
    return null;
  }
  if (!newest) return null;
  let artifact: { schemaVersion?: unknown; findings?: unknown };
  try {
    artifact = JSON.parse(readFileSync(join(reviewsDir, newest), 'utf8'));
  } catch {
    return null;
  }
  if (artifact?.schemaVersion !== 1 || !Array.isArray(artifact.findings)) {
    return null;
  }
  const entries: CarriedEntry[] = [];
  for (const raw of artifact.findings) {
    const f = raw as {
      id?: unknown;
      severity?: unknown;
      summary?: unknown;
      shortSummary?: unknown;
      locations?: unknown;
    };
    if (typeof f?.id !== 'string' || !DEFERRED_ID_SHAPE.test(f.id)) continue;
    const texts = [f.summary, f.shortSummary].filter(
      (t): t is string => typeof t === 'string' && t.trim() !== '',
    );
    if (texts.length === 0) continue;
    const critical = f.severity === 'Critical';
    const locations = Array.isArray(f.locations) ? f.locations : [];
    for (const loc of locations) {
      const l = loc as { file?: unknown; line?: unknown };
      if (typeof l?.file !== 'string' || l.file.trim() === '') continue;
      entries.push({
        id: f.id,
        file: l.file,
        ...(typeof l.line === 'number' && Number.isInteger(l.line)
          ? { line: l.line }
          : {}),
        critical,
        texts,
        via: 'deferred',
      });
    }
  }
  return { entries, name: newest };
}

export function runDedupCandidates(args: DedupArgs): LedgerDedupReport {
  let plan: { prNumber?: unknown; diffPathAbsolute?: unknown };
  try {
    plan = JSON.parse(readFileSync(args.plan, 'utf8'));
  } catch (err) {
    throw new Error(
      `dedup-candidates: cannot read the plan ${args.plan}: ${(err as Error).message}`,
    );
  }
  let rawCandidates: unknown;
  try {
    rawCandidates = JSON.parse(readFileSync(args.candidates, 'utf8'));
  } catch (err) {
    throw new Error(
      `dedup-candidates: cannot read the candidates ${args.candidates}: ${(err as Error).message}`,
    );
  }
  const candidates = validateCandidates(rawCandidates);

  const planDir = dirname(resolve(args.plan));
  const pr = isPositivePrNumber(plan.prNumber) ? plan.prNumber : undefined;
  const posted = pr !== undefined ? postedEntries(planDir, pr) : null;
  const deferred = pr !== undefined ? deferredEntries(planDir, pr) : null;
  // Posted first: when a claim exists in both carriers, the drop should cite
  // the id the Step 6 ruling will use.
  const carried = [...(posted?.entries ?? []), ...(deferred?.entries ?? [])];

  const kept: DedupCandidate[] = [];
  const dropped: DroppedCandidate[] = [];
  for (const candidate of candidates) {
    const match = carried.find((entry) => candidateMatches(candidate, entry));
    if (!match) {
      kept.push(candidate);
      continue;
    }
    dropped.push({
      file: candidate.file,
      ...(candidate.line !== undefined ? { line: candidate.line } : {}),
      title: candidate.title,
      severity: candidate.severity,
      matchedId: match.id,
      matchedTitle: match.texts[0],
      via: match.via,
    });
  }

  const diffHash = diffHashOf(plan.diffPathAbsolute);
  const outPath = resolve(args.out ?? join(planDir, ledgerDedupReportName(pr)));
  // A repeat invocation within the round (a Step 5 reporting round's fresh
  // findings) accumulates: the disclosure reads ONE report, and overwriting
  // would erase the earlier batches' drops from it. A report bound to a
  // different diff is another round's leftovers and is replaced whole.
  let cumulative = dropped;
  try {
    const existing = JSON.parse(
      readFileSync(outPath, 'utf8'),
    ) as LedgerDedupReport;
    if (
      existing?.v === 1 &&
      existing.diffHash !== undefined &&
      existing.diffHash === diffHash &&
      Array.isArray(existing.dropped)
    ) {
      cumulative = [...existing.dropped, ...dropped];
    }
  } catch {
    // No usable prior report — this invocation's drops stand alone.
  }

  const parts = [
    `Carried-ledger dedup: ${candidates.length} candidate(s), ` +
      `${dropped.length} set aside before verification` +
      (cumulative.length !== dropped.length
        ? ` (${cumulative.length} cumulative this round)`
        : '') +
      `.`,
  ];
  parts.push(
    posted
      ? `Posted work list: round ${posted.round}, ${posted.entries.length} entries.`
      : `No posted work list recovered — posted-finding dedup skipped.`,
  );
  parts.push(
    deferred
      ? `Deferral record: ${deferred.name}, ${deferred.entries.length} entries.`
      : `No findings artifact for this PR on this machine — deferral dedup skipped.`,
  );
  const report: LedgerDedupReport = {
    v: 1,
    ...(diffHash ? { diffHash } : {}),
    sources: {
      ledger: posted
        ? { round: posted.round, findings: posted.entries.length }
        : null,
      artifact: deferred
        ? { name: deferred.name, deferred: deferred.entries.length }
        : null,
    },
    kept,
    dropped: cumulative,
    droppedCount: cumulative.length,
    note: parts.join(' '),
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  return report;
}

/**
 * The disclosure's read side, for `compose-review`: the set-aside count and
 * the matched ids, from a report verifiably bound to THIS round's diff. Same
 * freshness key as the script-lint gate, opposite failure direction: nothing
 * is owed here, so an absent, stale, or unverifiable report renders nothing
 * rather than capping — the dedup is an optimization, not a gate.
 */
export function ledgerDedupFacts(planPath: string): {
  droppedCount: number;
  /** Matched ids in first-appearance order, shape-validated, with counts. */
  ids: Array<{ id: string; n: number }>;
} {
  const none = { droppedCount: 0, ids: [] };
  try {
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
      prNumber?: unknown;
      diffPathAbsolute?: unknown;
    };
    const pr = isPositivePrNumber(plan.prNumber) ? plan.prNumber : undefined;
    const report = JSON.parse(
      readFileSync(
        join(dirname(resolve(planPath)), ledgerDedupReportName(pr)),
        'utf8',
      ),
    ) as LedgerDedupReport;
    if (report?.v !== 1 || !Array.isArray(report.dropped)) return none;
    const planDiffHash = diffHashOf(plan.diffPathAbsolute);
    // Both sides present and equal, or the report cannot be placed — the
    // same `undefined !== undefined` trap the script-lint gate names.
    if (!planDiffHash || report.diffHash !== planDiffHash) return none;
    const ids: Array<{ id: string; n: number }> = [];
    for (const d of report.dropped) {
      const id = (d as DroppedCandidate)?.matchedId;
      if (
        typeof id !== 'string' ||
        !(LEDGER_ID_SHAPE.test(id) || DEFERRED_ID_SHAPE.test(id))
      ) {
        continue;
      }
      const seen = ids.find((e) => e.id === id);
      if (seen) seen.n += 1;
      else ids.push({ id, n: 1 });
    }
    return { droppedCount: report.dropped.length, ids };
  } catch {
    return none;
  }
}

export const dedupCandidatesCommand: CommandModule = {
  command: 'dedup-candidates',
  describe:
    'Drop pooled review candidates that restate entries the carried ledger ' +
    'already holds (posted findings and deferrals), before any verifier is ' +
    'spent on them; the report is what the verify shards are built from',
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe: 'Path to the plan report from Step 1',
      })
      .option('candidates', {
        type: 'string',
        demandOption: true,
        describe:
          'JSON array of pooled candidates: {file, line?, title, severity}, extra fields ride through',
      })
      .option('out', {
        type: 'string',
        describe:
          'Report path (default: qwen-review-pr-<n>-ledger-dedup.json beside the plan)',
      }),
  handler: (argv) => {
    const args = argv as unknown as DedupArgs;
    try {
      const report = runDedupCandidates(args);
      // Print the JSON as well as writing it: the orchestrator shards from
      // the `kept` list it reads here (Build & Test and script-lint do the
      // same write-then-print).
      writeStdoutLine(JSON.stringify(report, null, 2));
      writeStderrLine(report.note);
    } catch (err) {
      writeStderrLine((err as Error).message);
      process.exitCode = 1;
    }
  },
};
