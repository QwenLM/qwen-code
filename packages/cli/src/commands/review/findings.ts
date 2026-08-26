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
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import {
  FINDING_SEVERITIES,
  FINDING_CONFIDENCES,
  FINDING_OUTCOMES,
  FINDING_SOURCES,
  compressFindingSummary,
} from '@qwen-code/qwen-code-core';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import type { AnchorRequest } from './lib/anchors.js';
import { isSameFile } from './lib/same-file.js';

// These four lists are DEFINED in core (`core/src/tools/report-findings.ts`,
// the `report_findings` tool's contract) and re-exported here under this
// module's historical names. They still have one further deliberate consumer:
// the Web Shell review renderer
// (packages/web-shell/client/components/artifacts/CodeReviewArtifactDetail.tsx)
// is a browser bundle that cannot import Node-side packages, keeps its own
// copy, and fails closed on any value it does not know — so a value added in
// core breaks rendering of every saved artifact that carries one. Update the
// renderer copy in the same change.
/** The severity ladder, most severe first — this array IS the sort order. */
export const SEVERITIES = FINDING_SEVERITIES;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCES = FINDING_CONFIDENCES;
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
export const OUTCOMES = FINDING_OUTCOMES;
export type Outcome = (typeof OUTCOMES)[number];

/** Where a finding came from — the tag that decides whether it was verified. */
export const SOURCES = FINDING_SOURCES;
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
  /**
   * The executed evidence that settled the verdict (a probe's two sides, an
   * A/B's quoted pair, a sweep count) — or the verifier's
   * `not run — <reason>` line. Carried as data so the report and the comment
   * bodies quote one recorded string instead of transcribing it twice more.
   */
  witness?: string;
  suggestedFix?: string;
  /**
   * The test that must go red if the fix is removed — the file and the
   * behaviour it pins, or `N/A` when the fix adds no guard, branch or
   * behaviour a test can pin.
   *
   * `witness` is the reviewer's evidence that the defect is real; this is the
   * ACCEPTANCE CRITERION handed to whoever fixes it, and the two are not
   * interchangeable. It exists because the fix round is the review loop's
   * largest source of its own next round: measured across six multi-round
   * pull requests, roughly a third of every post-first-round finding was
   * introduced by the fix immediately preceding it, and the dominant shape
   * was a guard or branch added with no test of its own. Carried as data for
   * the same reason `witness` is — the report and the comment body quote one
   * recorded string instead of transcribing it twice more.
   */
  fixWitness?: string;
  /** Free-form kebab-case tag (`correctness`, `security`, `test-coverage`, …). */
  category?: string;
  /** Every location, in report order. A standalone finding has exactly one. */
  locations: FindingLocation[];
  /**
   * Local evidence-image paths attached by the review (screenshots, rendered
   * output). Published to the designated assets repo by `publish-assets`,
   * which weaves the resulting URLs into `assets`.
   */
  assetFiles?: string[];
  /** Commit-pinned URLs of published evidence images (see `publish-assets`). */
  assets?: string[];
  /** Set only after the fixer ran. */
  outcome?: Outcome;
  /** The fixer's reason, carried from the ledger — mainly for `skipped`. */
  outcomeNote?: string;
  /**
   * Set when `--test-delta` lowered this finding's severity: the test file the
   * measurement matched. Structured, not prose only — the sibling command makes
   * the same argument about its own budget skips, and for the same reason. A
   * later round reads the artifact, not the paragraph, so a hold discoverable
   * only by substring-matching `failureScenario` is a hold the round ledger
   * cannot see, and it re-files the finding at whatever severity it likes.
   */
  heldByMeasurement?: { file: string };
}

export interface FindingsReport {
  findings: Finding[];
  counts: {
    total: number;
    bySeverity: Record<Severity, number>;
    byConfidence: Record<Confidence, number>;
    /** Present only once outcomes have been recorded. */
    byOutcome?: Record<Outcome, number>;
    /** How many findings a measurement lowered. Counted, not inferred from
     *  prose, so a later round can act on it. */
    held: number;
  };
  /** True once every finding carries an outcome. */
  outcomesRecorded: boolean;
}

/** `shortSummary`, when the caller did not supply one. Defined in core. */
export const compressSummary = compressFindingSummary;

function fail(index: number, message: string): never {
  throw new Error(`Finding at index ${index}: ${message}`);
}

function asString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** A non-empty array of non-empty strings, or undefined; anything else fails
 * with the finding's index so a typo'd shape is named rather than dropped. */
function stringArray(
  o: Record<string, unknown>,
  key: string,
  index: number,
): string[] | undefined {
  const v = o[key];
  // `== null` covers null too: every sibling optional-field parser (asString)
  // treats null as absent, and an artifact author who renders "no assets" as
  // null must not crash the whole canonicalization.
  if (v == null) return undefined;
  // trim(), matching the sibling asString: a whitespace-only evidence path is
  // as nameless as an empty one.
  if (
    !Array.isArray(v) ||
    v.some((x) => typeof x !== 'string' || x.trim() === '')
  ) {
    fail(
      index,
      `"${key}" must be an array of non-empty strings, got ${JSON.stringify(v)}.`,
    );
  }
  return v.length > 0 ? (v as string[]) : undefined;
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

/**
 * The finding format the agents write mandates the bracketed tag —
 * `Source: [review]`, `Source: [probe]` — and a finding copied forward with
 * the tag it was born with used to die at this gate, because the artifact
 * schema names the bare enum. Strip the brackets and validate what is inside;
 * anything else (including an unknown word, bracketed or not) still fails.
 */
function normalizeSource(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const bracketed = /^\[(.*)\]$/.exec(trimmed);
  return (bracketed ? bracketed[1] : trimmed).trim();
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
      if (
        lo['line'] !== undefined &&
        (typeof lo['line'] !== 'number' ||
          !Number.isSafeInteger(lo['line']) ||
          lo['line'] <= 0)
      ) {
        fail(index, `location ${j} has an invalid "line".`);
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
  if (
    o['line'] !== undefined &&
    (typeof o['line'] !== 'number' ||
      !Number.isSafeInteger(o['line']) ||
      o['line'] <= 0)
  ) {
    fail(index, 'has an invalid "line".');
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
  // Step 9 cleanup deletes the side files `--input` normally receives, but
  // not the saved artifact (Step 8, under .qwen/reviews/) nor a surviving
  // `--out` report — and both wrap the findings array. Accept the wrapper,
  // so a later outcome path can recover from the state that survives the
  // cleanup instead of dying on a missing findings-in.json.
  if (
    !Array.isArray(raw) &&
    raw !== null &&
    typeof raw === 'object' &&
    Array.isArray((raw as { findings?: unknown }).findings)
  ) {
    raw = (raw as { findings: unknown }).findings;
  }
  if (!Array.isArray(raw)) {
    throw new Error(
      'Input must be a JSON array of findings, or a saved review artifact/report object carrying one as "findings".',
    );
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
        : oneOf(normalizeSource(o['source']), SOURCES);
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

    const assetFiles =
      stringArray(o, 'assetFiles', i) ?? stringArray(o, 'asset_files', i);
    const assets = stringArray(o, 'assets', i);

    // `outcomeNote` is accepted on input so the canonical artifact round-trips:
    // `validateFindings` already accepts `outcome`, and an artifact fed back
    // through `--input` that kept its outcomes but silently dropped their
    // reasons would strip exactly the field a `skipped` finding owes the reader.
    const outcomeNote =
      asString(o, 'outcomeNote') ?? asString(o, 'outcome_note');

    // And `heldByMeasurement`, for the same reason and with more riding on it:
    // the field exists so a later round can see that a measurement lowered this
    // finding, and a round reads the artifact by feeding it back through
    // `--input`. Dropped here, the hold survives exactly one command.
    const heldRaw = (o as { heldByMeasurement?: unknown }).heldByMeasurement;
    const heldFile =
      heldRaw && typeof heldRaw === 'object'
        ? asString(heldRaw as Record<string, unknown>, 'file')
        : undefined;

    const shortSummary =
      asString(o, 'shortSummary') ?? asString(o, 'short_summary');

    // `witness` round-trips for the same reason `outcomeNote` does: the Step 4
    // witness rule attaches it once, and the report and the comment bodies read
    // it back out of the artifact instead of transcribing the evidence again.
    const witness = asString(o, 'witness');

    // And `fixWitness` round-trips beside it: the acceptance criterion is
    // written once, at the finding, and read back by the comment body and by
    // a later round comparing what it asked for against what landed.
    const fixWitness = asString(o, 'fixWitness') ?? asString(o, 'fix_witness');

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
      ...(witness ? { witness } : {}),
      ...(fixWitness ? { fixWitness } : {}),
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
      ...(assetFiles ? { assetFiles } : {}),
      ...(assets ? { assets } : {}),
      ...(heldFile ? { heldByMeasurement: { file: heldFile } } : {}),
      ...(outcome ? { outcome } : {}),
      ...(outcome && outcomeNote ? { outcomeNote } : {}),
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

/**
 * Does `text` name `probe`? Both are repo-relative by the time this runs —
 * `sharedFailingFilesOf` qualifies what `test-delta` reported. Match on a name
 * boundary so `src/a.test.ts` is satisfied by neither `vendor/other-src/a.test.ts`
 * nor `src/a.test.tsx`.
 */
function namesPath(text: string, probe: string): boolean {
  const isNameChar = (c: string | undefined) =>
    c !== undefined && /[A-Za-z0-9._-]/.test(c);
  // `/` is NOT a leading boundary. Probes reach here repo-relative, so a `/`
  // in front means the match sits under some other root —
  // `third_party/packages/cli/src/a.test.ts` is a vendored copy, not this
  // file, and treating the slash as a boundary demoted a Critical about the
  // real one. The trailing side already required both ends; this is the same
  // rule on the side that was left open.
  const isBoundary = (c: string | undefined) =>
    c === undefined || (!isNameChar(c) && c !== '/');
  let from = 0;
  for (;;) {
    const at = text.indexOf(probe, from);
    if (at < 0) return false;
    const after = text[at + probe.length];
    // A trailing `.` is the end of a sentence far more often than the start of
    // another extension — findings are prose, and "…in src/a.test.ts." is the
    // ordinary way to write it. So a dot only extends the name when something
    // alphanumeric follows it (`.snap`), and never at the end of the text.
    const extendsName =
      after !== undefined &&
      (/[A-Za-z0-9_-]/.test(after) ||
        (after === '.' &&
          /[A-Za-z0-9]/.test(text[at + probe.length + 1] ?? '')));
    // Both ends: the leading check alone cannot see a probe matching inside a
    // longer name, where `src/a.test.ts` is satisfied by `src/a.test.tsx`.
    if (isBoundary(at === 0 ? undefined : text[at - 1]) && !extendsName) {
      return true;
    }
    from = at + 1;
  }
}

/**
 * Hold a Critical that blames the PR for a test failure the base tree already
 * had — the one contradiction this pipeline measures and then used to ignore.
 *
 * `test-delta` reruns the PR side's failed test commands on the merge base and
 * splits the failures into `netNew` (the PR's own) and `shared` (failing on both
 * sides, whatever files the diff touches). A Critical naming a `shared` test file
 * is asserting a breakage against a file that was already red without the PR.
 *
 * Measured on #8368: `AuthDialog.test.tsx` was `shared` in two independent runs,
 * and the base tree fails the very same test — `drives API key provider steps
 * from endpoint options metadata` — at merge-base `e967cc90`. A Critical reading
 * "height-based pagination breaks the pre-existing test" was carried across four
 * rounds and into the composed review anyway, because nothing reconciled the two
 * artifacts. The path rule this replaced was closed off in `test-delta` itself;
 * the round ledger reopened it from the other side.
 *
 * Downgrade, never drop. The measurement contradicts the SEVERITY — the PR is
 * not breaking a passing test — but the finding may still describe something
 * real about a test that is red for two reasons. A Suggestion stays in front of
 * a human, carrying the measurement that demoted it; a deletion would not. Only
 * Critical is touched, and nothing is ever raised.
 */
export function holdCriticalsFailingOnBase(
  findings: readonly Finding[],
  sharedFailingFiles: readonly string[],
): {
  findings: Finding[];
  held: Array<{ id: string; file: string }>;
  readjudicated: Array<{ id: string; file: string }>;
} {
  const held: Array<{ id: string; file: string }> = [];
  const readjudicated: Array<{ id: string; file: string }> = [];
  const out = findings.map((f) => {
    if (f.severity !== 'Critical') return f;
    // `summary` and `failureScenario` only — the two fields where a finding
    // states its claim.
    //
    // `suggestedFix` is where it proposes work ("add a case in src/x.test.ts"),
    // and `locations[].file` is its subject. Both name a test file routinely
    // without asserting anything about that file being red, and the second is
    // the sharper trap: for a finding ABOUT a test's content — "this new
    // assertion checks the wrong thing" — the location IS the test file, and a
    // PR touching an already-red test is exactly when such a finding gets
    // written. Demoting it would use the measurement against a claim the
    // measurement says nothing about.
    const haystack = [f.summary, f.failureScenario].join('\n');
    const hit = sharedFailingFiles.find((p) => p && namesPath(haystack, p));
    if (!hit) return f;
    // Already held for this file, and back at Critical anyway. The ledger
    // carries a held finding forward as the Suggestion it became, so Critical
    // plus this marker takes a deliberate act: someone read the measurement and
    // raised it again. Re-applying the same measurement to the same finding
    // adds nothing and silently overrides that decision — and the escape the
    // report offers ("say which test fails for a NEW reason") names the test
    // file, which is the match condition, so without this the door the
    // documentation promises cannot be opened at all.
    if (f.heldByMeasurement?.file === hit) {
      readjudicated.push({ id: f.id, file: hit });
      return f;
    }
    held.push({ id: f.id, file: hit });
    return {
      ...f,
      severity: 'Suggestion' as Severity,
      heldByMeasurement: { file: hit },
      failureScenario: `${f.failureScenario}\n\nHeld back from Critical by measurement: \`test-delta\` reran the failing test command on the merge base and ${hit} failed there too, so this is not a passing test the PR turns red. If the PR makes an already-red test fail for a NEW reason, say which test, quote both sides, and file it at Critical again: a finding that already carries this measurement and is raised anyway is left where you put it.`,
    };
  });
  return { findings: out, held, readjudicated };
}

/**
 * A `witness` that opens with `not run` and carries no reason after the dash
 * is the escape hatch used without paying its toll: Step 4's rule is that the
 * line names why no run could settle the claim, and an empty reason names
 * nothing — so downstream it counts as no witness at all.
 *
 * "No reason" is detected as "no letter or digit after `not run`" (Unicode
 * classes, not `\w`), NOT as an enumeration of dash glyphs: the first draft
 * listed three dashes and any other dash-like character (U+2015, U+2212,
 * U+FF0D) slipped through as a "reason" — while the obvious tightening,
 * `\W*$`, fails the other way, reading a perfectly good CJK reason as empty
 * because JavaScript's `\w` is ASCII-only. A reason in any script contributes
 * a letter or a number; punctuation alone contributes neither.
 */
export function isEmptyNotRunWitness(witness: string): boolean {
  // The phrase's own word-continuation is consumed before the remainder is
  // tested: `not runnable` and `not running —` are the brief's reason-less
  // forms too, and counting their `nable`/`ning` letters as reason content
  // was the same fail-open one suffix over.
  const m = /^\s*(?:witness:\s*)?not run[\p{L}\p{N}]*(?<rest>[\s\S]*)$/iu.exec(
    witness,
  );
  if (!m) return false;
  return !/[\p{L}\p{N}]/u.test(m.groups!['rest']!);
}

/**
 * The witness rule's machine half. Step 4 demands that a confirmed finding
 * carry its executed evidence — the `witness` field, holding either the
 * observed output or the verifier's `not run — <reason>` line — and promises
 * the demotion is mechanical. This is the mechanism, in the same place the
 * test-delta holdback lives: a high-confidence Critical or Suggestion from
 * the one non-deterministic source that arrives with no witness is filed at
 * low confidence — terminal-only, never posted. Both postable severities,
 * not just Critical: a Suggestion posts to the PR on the same terms
 * (DESIGN.md — Why Suggestion-level findings are posted as inline comments,
 * like Critical), so an unexecuted claim rides onto the author's screen
 * through the Suggestion door exactly as it would have through the Critical
 * one. `Nice to have` is exempt — it is terminal-only by construction, so
 * there is nothing for the rule to hold back. Only `source: 'review'` is
 * judged: a `[build]`/`[test]`/`[lint]`/`[probe]` finding IS a run's output,
 * so its witness is constitutive, not an attachment. A `not run` line with
 * an EMPTY reason counts as absent — the escape hatch is the reason, not the
 * phrase. Nothing is deleted and nothing is raised; the appended sentence
 * names the rule that moved it and the way back (attach the witness, or say
 * why none could run). Idempotent by construction — a demoted finding re-fed
 * through `--input` is already low confidence and is not touched again.
 */
export function holdUnwitnessedFindings(findings: readonly Finding[]): {
  findings: Finding[];
  unwitnessed: string[];
} {
  const unwitnessed: string[] = [];
  const out = findings.map((f) => {
    if (
      (f.severity !== 'Critical' && f.severity !== 'Suggestion') ||
      f.confidence !== 'high' ||
      f.source !== 'review' ||
      // A measurement-held SUGGESTION is exempt, deliberately: test-delta
      // just demoted it Critical→Suggestion on the promise that it STAYS in
      // front of a human as a posted Suggestion whose note says how to
      // re-raise it. Judging it here would compose the two holds into a
      // silent drop to terminal-only, and it is not the unexecuted claim
      // this rule exists to stop — the measurement that moved it IS a run's
      // output, riding as `heldByMeasurement`. Scoped to Suggestion on
      // purpose: a finding re-raised to Critical through the note's own
      // "file it at Critical again" door still carries the marker, and it
      // must face the witness rule like any other unexecuted Critical.
      (f.heldByMeasurement !== undefined && f.severity === 'Suggestion') ||
      (f.witness !== undefined && !isEmptyNotRunWitness(f.witness))
    ) {
      return f;
    }
    unwitnessed.push(f.id);
    return {
      ...f,
      confidence: 'low' as Confidence,
      failureScenario: `${f.failureScenario}\n\nFiled at low confidence by the witness rule: this confirmed ${f.severity} arrived with neither a witness (the executed evidence that settled the verdict) nor a \`not run — <reason>\` line naming why no run could settle it. Attach either and it stands at high confidence again.`,
    };
  });
  return { findings: out, unwitnessed };
}

const WORKSPACE_IN_COMMAND_RE = /--workspace="([^"]+)"/;

/**
 * One `test-delta` path as a finding would write it: repo-relative, unkeyed.
 *
 * Two things are stripped away. `failingFilesOf` keys a file by its vitest
 * project when the runner prints one (`@qwen-code/qwen-code::src/x.test.ts`) —
 * a finding never writes that prefix, so a keyed entry could never match and the
 * guard no-opped silently on the one shape a real projects run emits. And a
 * per-workspace command prints paths relative to that workspace, so
 * `src/utils/errors.test.ts` from the `packages/cli` command is qualified back
 * to `packages/cli/src/utils/errors.test.ts`.
 *
 * The qualification is the part that matters. Five test paths in this repo exist
 * under BOTH `packages/cli/src` and `packages/core/src` (`utils/errors.test.ts`
 * among them), so a bare suffix cannot tell them apart: a Critical about core's
 * copy would be held by cli's copy being red — demoting a real finding on a
 * measurement that was never about it. `failingFilesOf` keeps the project token
 * in its identity for exactly this reason; discarding it here would reopen from
 * the consumer side what the producer closed.
 */
function repoRelative(
  path: string,
  workspace: string | undefined,
): string | undefined {
  const at = path.indexOf('::');
  const bare = at < 0 ? path : path.slice(at + 2);
  // A key with no workspace to put back cannot be re-qualified, and the bare
  // remainder is project-relative: `namesPath` would then match it as a suffix
  // of ANY directory, which is the cross-project collapse this whole function
  // exists to prevent. The two shapes are mutually exclusive in practice — a
  // project tag comes from a runner printing one, and a `--workspace=` command
  // in this repo never does — so the qualifying half was never covering for the
  // stripping half. Refuse: a measurement whose subject cannot be identified
  // licenses nothing, and a missed hold costs less than a demoted Critical.
  if (at >= 0 && !workspace) return undefined;
  if (!workspace || bare.startsWith(`${workspace}/`)) return bare;
  return `${workspace}/${bare}`;
}

/**
 * Every file `test-delta` measured as failing on BOTH sides, repo-relative.
 *
 * Read from `entries` only, because only an entry carries the `--workspace=`
 * its paths are relative to. The top-level `shared` is the union of the same
 * files with that context already lost, so it is never honoured — an artifact
 * with no entries measured nothing this can safely act on, and a bare
 * workspace-relative path matches inside any package.
 *
 * A file measured `netNew` anywhere in the run is dropped even if some other
 * command called it `shared`: the two claims cannot both license a hold, and the
 * direction that suppresses a real finding is the worse one to get wrong.
 *
 * A shape it does not recognise yields none: an unreadable measurement must not
 * silently hold a Critical back, and must not throw either — the review has
 * findings to report whether or not this file parsed.
 */
export function sharedFailingFilesOf(raw: unknown): {
  shared: string[];
  unidentifiable: string[];
} {
  if (!raw || typeof raw !== 'object')
    return { shared: [], unidentifiable: [] };
  const shared = new Set<string>();
  const netNew = new Set<string>();
  const unidentifiable = new Set<string>();
  const take = (
    into: Set<string>,
    v: unknown,
    workspace: string | undefined,
  ) => {
    if (!Array.isArray(v)) return;
    for (const e of v) {
      if (typeof e !== 'string' || !e) continue;
      const qualified = repoRelative(e, workspace);
      // Reported only for `shared`: a `netNew` path was never eligible to hold
      // anything back, so nothing was set aside by dropping it, and saying
      // otherwise would make the disclosure noise on the very shape (a plain
      // `npm test` with vitest projects) that produces most of these keys.
      if (qualified === undefined) {
        if (into === shared) unidentifiable.add(e);
      } else into.add(qualified);
    }
  };

  const entries = (raw as { entries?: unknown }).entries;
  const rows = Array.isArray(entries) ? entries : [];
  if (rows.length > 0) {
    for (const e of rows) {
      if (!e || typeof e !== 'object') continue;
      const command = (e as { command?: unknown }).command;
      const workspace =
        typeof command === 'string'
          ? (WORKSPACE_IN_COMMAND_RE.exec(command)?.[1] ?? undefined)
          : undefined;
      take(shared, (e as { shared?: unknown }).shared, workspace);
      take(netNew, (e as { netNew?: unknown }).netNew, workspace);
    }
  }
  // No `entries` and therefore no `--workspace=` to qualify against. The
  // top-level list is the union of the entries with that context already lost,
  // so honouring it would put back the bare workspace-relative path that
  // matches inside ANY package — the collapse `repoRelative` exists to stop,
  // through the one door left open. A real artifact always has entries;
  // anything else measured nothing this can safely act on.
  return {
    shared: [...shared].filter((f) => !netNew.has(f)),
    unidentifiable: [...unidentifiable],
  };
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
    // The report_findings contract refuses a skipped outcome the reader
    // cannot inspect; the ledger feeding it must not accept one either.
    if (outcome === 'skipped' && !asString(o, 'note')) {
      throw new Error(
        `Outcome for ${JSON.stringify(id)} is "skipped" with no note — the reader is owed the reason for work not done.`,
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
      held: sorted.filter((f) => f.heldByMeasurement !== undefined).length,
      ...(byOutcome ? { byOutcome } : {}),
    },
    outcomesRecorded,
  };
}

/**
 * Headed for the `comments` array — the projection set. The projection and
 * its skip disclosure must agree on exactly this set, so both read one
 * predicate.
 */
function isPostable(f: Finding): boolean {
  return (
    f.confidence === 'high' &&
    (f.severity === 'Critical' || f.severity === 'Suggestion')
  );
}

/**
 * The Step 7 resolver input, projected from the canonical findings.
 *
 * `resolve-anchors` wants flat `{id, path, anchor, line?}` entries — one per
 * location — while the artifact stores `locations[]` arrays under a different
 * key name (`file`, not `path`). Hand-writing that projection once produced
 * all-null anchors and a redo; this is the mechanical version. Only the
 * findings headed for the `comments` array are projected — high-confidence
 * Criticals and Suggestions; a standalone finding keeps its own id, and an
 * aggregate's locations carry `<id>-1`, `<id>-2`, …, the suffix scheme Step 7
 * joins each resolution back to its finding on. Locations without an anchor
 * are skipped: there is nothing to resolve, and the skip disclosure below
 * names them. Their disposition follows Step 7's partial-resolution rule —
 * while the finding still projects anchored locations, the anchorless ones
 * add no comment and no body copy; a finding that projects nothing is the
 * ordinary unanchorable one (body Critical, discarded Suggestion).
 */
export function anchorRequestsFor(
  findings: readonly Finding[],
): AnchorRequest[] {
  const requests: AnchorRequest[] = [];
  // Seed with EVERY finding's own id, not just the postable ones: Step 7
  // joins each resolution back to the artifact by id, so a minted `<id>-N`
  // equal to any finding's id attaches the comment to the wrong body,
  // whether or not that finding projects a request of its own.
  const seen = new Map<string, string>(findings.map((f) => [f.id, f.id]));
  for (const f of findings) {
    if (!isPostable(f)) continue;
    const postable = f.locations.filter((l) => l.anchor !== undefined);
    const multi = postable.length > 1;
    for (const [i, l] of postable.entries()) {
      const id = multi ? `${f.id}-${i + 1}` : f.id;
      // Finding ids are unique, but an EXPANDED id can equal another finding's
      // own id (`p1`'s first location mints `p1-1`; a standalone finding may
      // be named `p1-1`). Resolutions join back on this id, so the collision
      // must fail here: the emitted ids are unique, so no later gate sees it,
      // and Step 7's join would attach the comment to the wrong finding's
      // body. A finding matching its own id is the standalone shape, not a
      // collision.
      const other = seen.get(id);
      if (other !== undefined && other !== f.id) {
        throw new Error(
          `findings: anchor request id "${id}" is produced twice — findings ` +
            `"${other}" and "${f.id}" both claim it; rename one of the findings`,
        );
      }
      seen.set(id, f.id);
      requests.push({
        id,
        path: l.file,
        anchor: l.anchor as string,
        ...(l.line !== undefined ? { line: l.line } : {}),
      });
    }
  }
  return requests;
}

/**
 * The locations the projection skips: a postable finding carrying a location
 * with no anchor. Nothing downstream cross-checks the artifact's postable
 * findings against the resolver input, so the command discloses them — and
 * the disclosure splits on what the finding still projects: while anchored
 * locations project, the anchorless ones add no comment and no body copy;
 * only a finding that projects nothing is disposed of as unanchorable (a
 * Critical moves to the body, a Suggestion is discarded).
 */
function anchorlessLocationsFor(
  findings: readonly Finding[],
): Array<{ id: string; count: number; anchored: number }> {
  const skipped: Array<{ id: string; count: number; anchored: number }> = [];
  for (const f of findings) {
    if (!isPostable(f)) continue;
    const count = f.locations.filter((l) => l.anchor === undefined).length;
    if (count > 0) {
      skipped.push({
        id: f.id,
        count,
        anchored: f.locations.length - count,
      });
    }
  }
  return skipped;
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
  testDelta: string | undefined;
  toAnchors: string | undefined;
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
        describe:
          'JSON array of findings written by the review (or a saved review artifact/report object carrying the array as "findings")',
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
      .option('test-delta', {
        type: 'string',
        describe:
          'The test-delta artifact. A Critical naming a test file that also failed on the merge base is held back to Suggestion, carrying the measurement that demoted it.',
      })
      .option('to-anchors', {
        type: 'string',
        describe:
          'Also write the Step 7 resolver input: one {id, path, anchor, line?} ' +
          'per anchored location of every high-confidence Critical and ' +
          'Suggestion, ready for resolve-anchors.',
      })
      .option('print', {
        type: 'boolean',
        describe: 'Also print one line per finding to stdout',
      }),
  handler: (argv) => {
    const { input, out, outcomes, print, testDelta, toAnchors } =
      argv as unknown as FindingsArgs;

    // The resolver input must not share a file with anything this command
    // reads or writes: a --to-anchors that lands on one of them destroys its
    // counterpart while stderr reports every write as successful, and Step 7
    // joins the pair by id — a silently destroyed member poisons the join.
    // Identity is filesystem identity — dev/ino where a side exists, the
    // canonicalised deepest ancestor where it does not: path strings miss
    // hard links, case-variant spellings, and symlinked directory
    // components. A link realpath cannot see through is refused where it can
    // still alias — the anchor side outright, a sibling side when it dangles.
    // Nesting is a collision too: the write sequence creates the prefix path
    // as a directory, the paired write dies at EISDIR, and the stray
    // directory survives every rerun.
    if (toAnchors !== undefined) {
      const anchorTarget = resolve(toAnchors);
      let anchorStat: Stats | undefined;
      try {
        anchorStat = lstatSync(anchorTarget);
      } catch {
        // Not there yet — the run creates it; spelling is all it has.
      }
      if (anchorStat?.isSymbolicLink()) {
        throw new Error(
          `findings: --to-anchors must not be a symlink (${toAnchors}); ` +
            'a link can alias a file this command also reads or writes, and no path compare would see the collision',
        );
      }
      if (anchorStat?.isDirectory()) {
        throw new Error(
          `findings: --to-anchors must not be a directory (${toAnchors}); the anchor artifact is written as a file`,
        );
      }
      const others: Array<[string, string | undefined]> = [
        ['--input', input],
        ['--out', out],
        ['--outcomes', outcomes],
        ['--test-delta', testDelta],
      ];
      for (const [flag, p] of others) {
        if (p === undefined) continue;
        const sibling = resolve(p);
        try {
          realpathSync(sibling);
        } catch {
          // realpath failed — distinguish a dangling link (which can still
          // alias the resolver input) from a truly absent file.
          let siblingStat: Stats | undefined;
          try {
            siblingStat = lstatSync(sibling);
          } catch {
            // Absent file — spelling is all it has.
          }
          if (siblingStat?.isSymbolicLink()) {
            throw new Error(
              `findings: ${flag} must not be a dangling symlink (${p}); ` +
                'it could alias the resolver input, and no path compare would see the collision',
            );
          }
        }
        if (isSameFile(anchorTarget, sibling)) {
          throw new Error(
            `findings: --to-anchors points at the same file as ${flag} (${p}); the resolver input would overwrite it`,
          );
        }
        if (
          sibling.startsWith(anchorTarget + sep) ||
          anchorTarget.startsWith(sibling + sep)
        ) {
          throw new Error(
            `findings: --to-anchors must not nest inside ${flag} (${p}) or contain it; ` +
              'one path would be created as a directory where the other needs a file',
          );
        }
      }
    }

    let findings = validateFindings(readJson(input, 'findings'));
    if (outcomes !== undefined) {
      findings = applyOutcomes(
        findings,
        validateOutcomes(readJson(outcomes, 'outcomes')),
      );
    }
    let held: Array<{ id: string; file: string }> = [];
    let readjudicated: Array<{ id: string; file: string }> = [];
    if (testDelta !== undefined) {
      // A measurement that will not read is a measurement, absent — and an
      // absent measurement holds nothing back. It must not take the review
      // down with it either: the findings are the deliverable, this is a
      // cross-check on them. `readJson` throws on a missing file and on
      // invalid JSON, so the loud-but-fatal path is caught here and the
      // shape-level tolerance in `sharedFailingFilesOf` covers the rest.
      // Never silent, though — a hold that did not happen because the file was
      // unreadable is exactly what a reader needs told.
      // A file that is not there and a file that will not parse are different
      // facts, and only the second is worth alarming about. `test-delta` runs
      // only when a test command failed AND a base tree was available, so on
      // the ordinary review — tests green — the artifact does not exist, and a
      // loud line there would report the normal path as a failure on every run.
      let measurement: unknown;
      if (existsSync(resolve(testDelta))) {
        try {
          measurement = readJson(testDelta, 'test-delta');
        } catch (err) {
          writeStderrLine(
            `findings: no holds applied — ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const { shared, unidentifiable } = sharedFailingFilesOf(measurement);
      // Never a silent drop: a measured file this could not place is coverage
      // the command chose not to use, and saying so is the difference between
      // "nothing matched" and "something was set aside".
      for (const f of unidentifiable) {
        writeStderrLine(
          `findings: ignored the measured file ${f} — it carries a vitest project key and no workspace to resolve it against, so which project it names cannot be established`,
        );
      }
      ({ findings, held, readjudicated } = holdCriticalsFailingOnBase(
        findings,
        shared,
      ));
    }
    const witnessHold = holdUnwitnessedFindings(findings);
    findings = witnessHold.findings;
    const report = buildReport(findings);

    // Project the resolver input from the SAME findings the artifact carries —
    // after the holds above, so a Critical lowered to Suggestion (or a
    // confidence lowered to terminal-only) projects as the holds intend — and
    // BEFORE anything is written: a projection the collision guard refuses
    // must leave the previous run's consistent pair on disk, not a rewritten
    // findings.json beside a stale anchors.json.
    const anchorRequests =
      toAnchors !== undefined ? anchorRequestsFor(report.findings) : undefined;

    const target = resolve(out);
    mkdirSync(dirname(target), { recursive: true });

    // The anchors file goes down BEFORE the artifact: Step 7 joins the pair
    // by id, so a failure between the two writes can only leave this run's
    // anchors.json beside the previous run's findings.json — never a
    // rewritten findings.json beside a stale anchors.json. A failure of the
    // FIRST write leaves the previous run's consistent pair untouched, and
    // the anchors path is the realistic failure — a parent that cannot be
    // created, a read-only directory — while the artifact's is the path the
    // previous run already wrote.
    if (toAnchors !== undefined && anchorRequests !== undefined) {
      const anchorTarget = resolve(toAnchors);
      mkdirSync(dirname(anchorTarget), { recursive: true });
      writeFileSync(
        anchorTarget,
        `${JSON.stringify(anchorRequests, null, 2)}\n`,
        'utf8',
      );
      writeStderrLine(
        `findings: wrote ${anchorRequests.length} anchor request(s) for Step 7 to ${anchorTarget}`,
      );
      for (const { id, count, anchored } of anchorlessLocationsFor(
        report.findings,
      )) {
        writeStderrLine(
          `findings: ${id} carries ${count} location(s) without an anchor — ` +
            'absent from the resolver input; ' +
            (anchored > 0
              ? `the finding still projects ${anchored} anchored location(s), ` +
                'and the anchorless ones add no comment and no body copy'
              : 'dispose as unanchorable'),
        );
      }
    }

    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    const { bySeverity, byConfidence } = report.counts;
    writeStderrLine(
      `findings: ${report.counts.total} total — ` +
        `${bySeverity['Critical']} Critical, ${bySeverity['Suggestion']} Suggestion, ` +
        `${bySeverity['Nice to have']} Nice to have; ` +
        `${byConfidence['low']} low-confidence. Wrote ${target}`,
    );
    // Never silent: a severity this command lowered is a change to what the
    // review says, and the reader has to be told which finding and on what
    // evidence — otherwise the demotion reads as the reviewer's own judgement.
    for (const h of held) {
      writeStderrLine(
        `findings: ${h.id} held back from Critical — test-delta measured ${h.file} as failing on the merge base too`,
      );
    }
    // The witness rule's demotions get the same disclosure: a confidence this
    // command lowered must name the finding and the rule, or the demotion
    // reads as the reviewer's own judgement.
    for (const id of witnessHold.unwitnessed) {
      writeStderrLine(
        `findings: ${id} filed at low confidence — a confirmed finding carried neither a witness nor a 'not run' reason (Step 4's witness rule)`,
      );
    }
    // A hold that was weighed and reversed is a decision, and a decision this
    // command declined to overrule is exactly as reportable as one it made.
    for (const r of readjudicated) {
      writeStderrLine(
        `findings: ${r.id} left at Critical — it already carries the ${r.file} measurement and was raised again anyway`,
      );
    }
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
