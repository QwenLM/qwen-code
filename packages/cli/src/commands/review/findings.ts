/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review findings`: the review's findings as data, and the per-finding
// outcome ledger `--fix` writes back into it.
//
// Everything else in this pipeline that matters is already a computed artifact —
// the diff plan, the coverage report, the resolved anchors, the verdict — and the
// findings were the conspicuous exception: prose in a terminal, re-typed into the
// saved report, re-typed again into the review JSON. Three transcriptions of the
// same list, and this skill's own history is a catalogue of what transcription
// does (a Critical that changed severity between two sections of one review; an
// aggregate that lost its per-location anchors on the way to `resolve-anchors`
// and took the whole batch down with it).
//
// Two jobs, and the second is the reason the first exists:
//
//  1. **Canonicalize.** One id per finding, one ordering, one severity spelling,
//     a `shortSummary` short enough for a list UI, counts nobody recomputes by
//     hand. Downstream reads the artifact instead of the prose.
//
//  2. **Account for every finding after `--fix`.** When the fixer has run, every
//     finding must come back carrying an outcome — `fixed`, `skipped`, or
//     `no_change_needed` — and this command **refuses an outcome set that does
//     not cover all of them**. That refusal is the whole point. A fixer that
//     applies six of nine findings and reports six has not lied about any one of
//     them; it has silently shortened the list, and the reader has no way to see
//     the three that fell off. Partial coverage is the failure mode, so partial
//     coverage is the error.

import type { CommandModule } from 'yargs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';

/** The severity ladder, most severe first — this array IS the sort order. */
export const SEVERITIES = ['Critical', 'Suggestion', 'Nice to have'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCES = ['high', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/**
 * What happened to a finding once the fixer ran.
 *
 * `no_change_needed` is not a synonym for `skipped`, and collapsing the two is
 * how a review quietly retracts a finding: `skipped` says "real, not applied"
 * and stays on the reader's plate; `no_change_needed` says "this was wrong, or
 * already handled" and takes it off. They are different claims about the code,
 * so they are different words, and the fixer has to pick one.
 */
export const OUTCOMES = ['fixed', 'skipped', 'no_change_needed'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Where a finding came from — the tag that decides whether it was verified. */
export const SOURCES = ['review', 'build', 'test', 'probe', 'lint'] as const;
export type Source = (typeof SOURCES)[number];

/** One location a finding applies to. A pattern aggregate carries several. */
export interface FindingLocation {
  file: string;
  line?: number;
  /** The verbatim snippet `resolve-anchors` turns into a line number. */
  anchor?: string;
}

export interface Finding {
  id: string;
  severity: Severity;
  confidence: Confidence;
  source: Source;
  /** One sentence stating the defect. */
  summary: string;
  /** `summary` compressed to <= 60 characters, for a list UI. */
  shortSummary: string;
  /** The concrete trigger and wrong outcome — the finding's evidence. */
  failureScenario: string;
  suggestedFix?: string;
  /** Free-form kebab-case tag (`correctness`, `security`, `test-coverage`, …). */
  category?: string;
  /** Every location, in report order. A standalone finding has exactly one. */
  locations: FindingLocation[];
  /** Set only after the fixer ran. */
  outcome?: Outcome;
  /** The fixer's reason, carried from the ledger — mainly for `skipped`. */
  outcomeNote?: string;
}

export interface FindingsReport {
  findings: Finding[];
  counts: {
    total: number;
    bySeverity: Record<Severity, number>;
    byConfidence: Record<Confidence, number>;
    /** Present only once outcomes have been recorded. */
    byOutcome?: Record<Outcome, number>;
  };
  /** True once every finding carries an outcome. */
  outcomesRecorded: boolean;
}

/** `shortSummary`, when the caller did not supply one. */
export function compressSummary(summary: string, max = 60): string {
  // Collapse whitespace first: a summary that wrapped across lines in the source
  // prose would otherwise carry its newlines into a single-line list cell.
  const flat = summary.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  // Cut on a word boundary when one is reasonably near the limit, so the label
  // reads as a clause rather than a severed word. `max - 1` leaves room for the
  // ellipsis, which is one character (U+2026), not three dots.
  const head = flat.slice(0, max - 1);
  const space = head.lastIndexOf(' ');
  const cut = space >= max * 0.6 ? head.slice(0, space) : head;
  return `${cut.trimEnd()}…`;
}

function fail(index: number, message: string): never {
  throw new Error(`Finding at index ${index}: ${message}`);
}

function asString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === 'string' &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function parseLocations(
  o: Record<string, unknown>,
  index: number,
): FindingLocation[] {
  const raw = o['locations'];
  // The aggregate form. Step 4's pattern aggregation merges N findings into one
  // and Step 7 expands it back into one comment per location, so the locations
  // must survive as a list — an aggregate that arrived with a single merged
  // location is an aggregate whose other anchors were dropped, which is exactly
  // the failure that once took a whole `resolve-anchors` batch down.
  if (raw !== undefined) {
    if (!Array.isArray(raw) || raw.length === 0) {
      fail(index, '"locations" must be a non-empty array when present.');
    }
    return raw.map((l, j) => {
      if (l === null || typeof l !== 'object' || Array.isArray(l)) {
        fail(index, `location ${j} is ${JSON.stringify(l)}, not an object.`);
      }
      const lo = l as Record<string, unknown>;
      const file = asString(lo, 'file');
      if (!file) fail(index, `location ${j} is missing a non-empty "file".`);
      if (lo['line'] !== undefined && typeof lo['line'] !== 'number') {
        fail(index, `location ${j} has a non-numeric "line".`);
      }
      return {
        file,
        ...(typeof lo['line'] === 'number' ? { line: lo['line'] } : {}),
        ...(asString(lo, 'anchor') ? { anchor: asString(lo, 'anchor')! } : {}),
      };
    });
  }
  // The standalone form: `file` (+ optional `line`/`anchor`) at the top level.
  const file = asString(o, 'file');
  if (!file) {
    fail(
      index,
      'needs a non-empty "file" (or a "locations" array for a pattern aggregate).',
    );
  }
  if (o['line'] !== undefined && typeof o['line'] !== 'number') {
    fail(index, 'has a non-numeric "line".');
  }
  return [
    {
      file,
      ...(typeof o['line'] === 'number' ? { line: o['line'] } : {}),
      ...(asString(o, 'anchor') ? { anchor: asString(o, 'anchor')! } : {}),
    },
  ];
}

/**
 * Validate and canonicalize the orchestrator's findings list.
 *
 * Strict about the fields that carry evidence and lenient about the rest, for
 * the reason the finding format gives: a finding with no failure scenario is not
 * a finding, so an entry that omits one is a malformed entry rather than a
 * finding with a blank field. `shortSummary` and `category` are conveniences and
 * are derived or dropped, never demanded.
 */
export function validateFindings(raw: unknown): Finding[] {
  if (!Array.isArray(raw)) {
    throw new Error('Input must be a JSON array of findings.');
  }
  const findings = raw.map((r, i) => {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      fail(i, `is ${JSON.stringify(r)}, not an object.`);
    }
    const o = r as Record<string, unknown>;

    const id = asString(o, 'id');
    if (!id) fail(i, 'is missing a non-empty string "id".');

    const severity = oneOf(o['severity'], SEVERITIES);
    if (!severity) {
      fail(
        i,
        `has severity ${JSON.stringify(o['severity'])}; expected one of ${SEVERITIES.map((s) => JSON.stringify(s)).join(', ')}.`,
      );
    }

    // Confidence defaults to `high`: the finding format asks for `low` only when
    // the agent could not pin the trigger down, so an omitted field means the
    // ordinary case. Defaulting the other way would sweep every finding into the
    // terminal-only bucket and silently empty the posted review.
    const confidence =
      o['confidence'] === undefined
        ? ('high' as Confidence)
        : oneOf(o['confidence'], CONFIDENCES);
    if (!confidence) {
      fail(
        i,
        `has confidence ${JSON.stringify(o['confidence'])}; expected "high" or "low".`,
      );
    }

    const source =
      o['source'] === undefined
        ? ('review' as Source)
        : oneOf(o['source'], SOURCES);
    if (!source) {
      fail(
        i,
        `has source ${JSON.stringify(o['source'])}; expected one of ${SOURCES.map((s) => JSON.stringify(s)).join(', ')}.`,
      );
    }

    const summary = asString(o, 'summary');
    if (!summary) fail(i, 'is missing a non-empty string "summary".');

    const failureScenario =
      asString(o, 'failureScenario') ?? asString(o, 'failure_scenario');
    if (!failureScenario) {
      fail(
        i,
        'is missing a non-empty "failureScenario" — a finding that cannot name ' +
          'its concrete trigger and wrong outcome (or, for a quality finding, its ' +
          'concrete cost) is not a finding.',
      );
    }

    const outcome =
      o['outcome'] === undefined ? undefined : oneOf(o['outcome'], OUTCOMES);
    if (o['outcome'] !== undefined && !outcome) {
      fail(
        i,
        `has outcome ${JSON.stringify(o['outcome'])}; expected one of ${OUTCOMES.map((s) => JSON.stringify(s)).join(', ')}.`,
      );
    }

    const shortSummary =
      asString(o, 'shortSummary') ?? asString(o, 'short_summary');

    return {
      id,
      severity,
      confidence,
      source,
      summary,
      shortSummary: shortSummary
        ? compressSummary(shortSummary)
        : compressSummary(summary),
      failureScenario,
      ...(asString(o, 'suggestedFix') || asString(o, 'suggested_fix')
        ? {
            suggestedFix: (asString(o, 'suggestedFix') ??
              asString(o, 'suggested_fix'))!,
          }
        : {}),
      ...(asString(o, 'category')
        ? { category: asString(o, 'category')! }
        : {}),
      locations: parseLocations(o, i),
      ...(outcome ? { outcome } : {}),
    } satisfies Finding;
  });

  // Ids join outcomes back to findings, and Step 7 joins resolved anchors back
  // the same way. A duplicate id makes both joins ambiguous, and an ambiguous
  // join lands a fix report — or a PR comment — on the wrong finding.
  const seen = new Set<string>();
  for (const f of findings) {
    if (seen.has(f.id)) {
      throw new Error(
        `Duplicate finding id ${JSON.stringify(f.id)}. Ids join outcomes and ` +
          'resolved anchors back to their findings; they must be unique.',
      );
    }
    seen.add(f.id);
  }
  return findings;
}

/** Most severe first, then high-confidence before low, then file and line. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity =
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);
    if (bySeverity !== 0) return bySeverity;
    const byConfidence =
      CONFIDENCES.indexOf(a.confidence) - CONFIDENCES.indexOf(b.confidence);
    if (byConfidence !== 0) return byConfidence;
    const af = a.locations[0]?.file ?? '';
    const bf = b.locations[0]?.file ?? '';
    if (af !== bf) return af < bf ? -1 : 1;
    const al = a.locations[0]?.line ?? 0;
    const bl = b.locations[0]?.line ?? 0;
    if (al !== bl) return al - bl;
    // Ids break the last tie so the ordering is total: two findings on one line
    // must not swap places between runs, or a diff of two reports is noise.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The outcome ledger, as the fixer hands it back. */
export interface OutcomeEntry {
  id: string;
  outcome: Outcome;
  /** Why, for `skipped` — the reader is owed a reason for work not done. */
  note?: string;
}

export function validateOutcomes(raw: unknown): OutcomeEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error('Outcomes must be a JSON array of {id, outcome} entries.');
  }
  return raw.map((r, i) => {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      throw new Error(
        `Outcome at index ${i} is ${JSON.stringify(r)}, not an object.`,
      );
    }
    const o = r as Record<string, unknown>;
    const id = asString(o, 'id');
    if (!id) throw new Error(`Outcome at index ${i} is missing a string "id".`);
    const outcome = oneOf(o['outcome'], OUTCOMES);
    if (!outcome) {
      throw new Error(
        `Outcome for ${JSON.stringify(id)} is ${JSON.stringify(o['outcome'])}; ` +
          `expected one of ${OUTCOMES.map((s) => JSON.stringify(s)).join(', ')}.`,
      );
    }
    return {
      id,
      outcome,
      ...(asString(o, 'note') ? { note: asString(o, 'note')! } : {}),
    };
  });
}

/**
 * Merge the ledger into the findings — and refuse anything less than full
 * coverage.
 *
 * Both directions are errors, and neither is pedantry. An **unaccounted**
 * finding is one the fixer walked past: the reader sees a shorter list and has
 * no way to learn what fell off it. An **unknown** id is a report about a
 * finding this review never made, which means the ledger was built against some
 * other list — and merging it would attach outcomes to the wrong rows.
 */
export function applyOutcomes(
  findings: readonly Finding[],
  outcomes: readonly OutcomeEntry[],
): Finding[] {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const o of outcomes) {
    if (!byId.has(o.id)) {
      unknown.push(o.id);
      continue;
    }
    if (seen.has(o.id)) {
      throw new Error(
        `Outcome for ${JSON.stringify(o.id)} appears twice. One outcome per finding.`,
      );
    }
    seen.add(o.id);
  }
  if (unknown.length > 0) {
    throw new Error(
      `Outcome(s) for unknown finding id(s): ${unknown.map((u) => JSON.stringify(u)).join(', ')}. ` +
        "The ledger does not match this review's findings.",
    );
  }
  const missing = findings.filter((f) => !seen.has(f.id)).map((f) => f.id);
  if (missing.length > 0) {
    throw new Error(
      `No outcome recorded for ${missing.length} finding(s): ` +
        `${missing.map((m) => JSON.stringify(m)).join(', ')}. ` +
        'Every finding needs one of ' +
        `${OUTCOMES.map((s) => JSON.stringify(s)).join(', ')} — a finding left out ` +
        'of the ledger is one the reader cannot tell was considered.',
    );
  }
  const noteById = new Map(
    outcomes.filter((o) => o.note).map((o) => [o.id, o.note as string]),
  );
  const outcomeById = new Map(outcomes.map((o) => [o.id, o.outcome]));
  return findings.map((f) => ({
    ...f,
    outcome: outcomeById.get(f.id)!,
    ...(noteById.has(f.id) ? { outcomeNote: noteById.get(f.id)! } : {}),
  }));
}

export function buildReport(findings: readonly Finding[]): FindingsReport {
  const sorted = sortFindings(findings);
  const bySeverity = Object.fromEntries(
    SEVERITIES.map((s) => [s, sorted.filter((f) => f.severity === s).length]),
  ) as Record<Severity, number>;
  const byConfidence = Object.fromEntries(
    CONFIDENCES.map((c) => [
      c,
      sorted.filter((f) => f.confidence === c).length,
    ]),
  ) as Record<Confidence, number>;
  const outcomesRecorded =
    sorted.length > 0 && sorted.every((f) => f.outcome !== undefined);
  const byOutcome = outcomesRecorded
    ? (Object.fromEntries(
        OUTCOMES.map((o) => [o, sorted.filter((f) => f.outcome === o).length]),
      ) as Record<Outcome, number>)
    : undefined;
  return {
    findings: sorted,
    counts: {
      total: sorted.length,
      bySeverity,
      byConfidence,
      ...(byOutcome ? { byOutcome } : {}),
    },
    outcomesRecorded,
  };
}

/** One line per finding, for a terminal that will not render the JSON. */
export function renderFindings(report: FindingsReport): string[] {
  return report.findings.map((f) => {
    const loc = f.locations[0];
    const where = loc
      ? `${loc.file}${loc.line !== undefined ? `:${loc.line}` : ''}`
      : '(no location)';
    const more =
      f.locations.length > 1 ? ` (+${f.locations.length - 1} more)` : '';
    const confidence = f.confidence === 'low' ? ' [low confidence]' : '';
    const outcome = f.outcome ? ` [${f.outcome}]` : '';
    return `${f.severity} — ${where}${more} — ${f.shortSummary}${confidence}${outcome}`;
  });
}

interface FindingsArgs {
  input: string;
  out: string;
  outcomes: string | undefined;
  print: boolean | undefined;
}

function readJson(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(resolve(path), 'utf8');
  } catch (err) {
    throw new Error(
      `Could not read the ${what} file at ${JSON.stringify(path)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `The ${what} file at ${JSON.stringify(path)} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export const findingsCommand: CommandModule = {
  command: 'findings',
  describe:
    "Validate and canonicalize the review's findings into a JSON artifact, and — with --outcomes — record what happened to each one after --fix (refusing any ledger that does not account for every finding)",
  builder: (yargs) =>
    yargs
      .option('input', {
        type: 'string',
        demandOption: true,
        describe: 'JSON array of findings written by the review',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Where to write the canonical findings artifact',
      })
      .option('outcomes', {
        type: 'string',
        describe:
          'JSON array of {id, outcome, note?} recording what --fix did to each finding. Must cover every finding.',
      })
      .option('print', {
        type: 'boolean',
        describe: 'Also print one line per finding to stdout',
      }),
  handler: (argv) => {
    const { input, out, outcomes, print } = argv as unknown as FindingsArgs;

    let findings = validateFindings(readJson(input, 'findings'));
    if (outcomes !== undefined) {
      findings = applyOutcomes(
        findings,
        validateOutcomes(readJson(outcomes, 'outcomes')),
      );
    }
    const report = buildReport(findings);

    const target = resolve(out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    const { bySeverity, byConfidence } = report.counts;
    writeStderrLine(
      `findings: ${report.counts.total} total — ` +
        `${bySeverity['Critical']} Critical, ${bySeverity['Suggestion']} Suggestion, ` +
        `${bySeverity['Nice to have']} Nice to have; ` +
        `${byConfidence['low']} low-confidence. Wrote ${target}`,
    );
    if (report.counts.byOutcome) {
      const o = report.counts.byOutcome;
      writeStderrLine(
        `outcomes: ${o['fixed']} fixed, ${o['skipped']} skipped, ` +
          `${o['no_change_needed']} no change needed`,
      );
    }
    if (print) {
      for (const line of renderFindings(report)) writeStdoutLine(line);
    }
  },
};
