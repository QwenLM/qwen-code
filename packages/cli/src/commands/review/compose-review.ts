/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review compose-review`: deterministic event selection and body
// composition for the /review skill's Step 7 submission.
//
// This logic used to be prose — a C/S table, three event-capping overrides,
// a seven-clause body composition, and presubmit downgrade carve-outs,
// restated across four places in SKILL.md. Keeping the restatements in sync
// by hand produced five shipped bugs (four Critical), all of the same shape:
// one downstream branch not updated when an upstream rule gained a new
// state. This module is the single source of truth; the skill gathers the
// state, calls it, and uses `{event, body}` verbatim. 422 recovery is the
// same call with updated counts.
//
// The model stays responsible for judgment (what is a Critical, is it
// real); this owns only the bookkeeping that follows from the counts.

import type { CommandModule } from 'yargs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  coverageFromTranscripts,
  TranscriptsUnavailableError,
} from './lib/coverage.js';

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface ComposeReviewInput {
  /** Critical findings anchored as inline `comments` entries. Omitted = 0. */
  criticalsInline?: number;
  /** Suggestion findings anchored as inline `comments` entries. Omitted = 0. */
  suggestionsInline?: number;
  /**
   * Critical descriptions whose only copy lives in the review body — the
   * last-resort unmappable findings and 422-relocated ones. They count
   * toward `C` exactly like anchored Criticals.
   */
  bodyCriticals?: string[];
  /** Suggestions discarded as unanchorable (offline validation or 422). */
  suggestionsDiscarded?: number;
  /**
   * Existing Criticals already on the PR whose Step 6 re-check landed on
   * `cannot tell` — one line each (location + what could not be decided).
   * Not counted in `C` (the review did not confirm them), but their
   * presence forbids an approval.
   */
  cannotTellCriticals?: string[];
  /** Uncoverable chunks, e.g. `"chunk 5 (src/big.min.js)"`. */
  uncoverableChunks?: string[];
  /**
   * Dimensions nobody reviewed. A bare name (`"security"`) means its agent
   * whiffed twice and gets the standard explanation; an entry carrying its
   * own reason after an em-dash (`"issue-fidelity — linked issue #123 could
   * not be fetched"`) is rendered verbatim.
   */
  unreviewedDimensions?: string[];
  /**
   * The plan report from Step 1.
   *
   * Coverage is derived from it plus the harness's transcripts — it is not an
   * input. See the recomputation below for why a caller does not get to say
   * whether the diff was read.
   */
  planPath?: string;
  /**
   * Where to look for the harness's records. Defaults to the environment the CLI
   * exported. A test seam only — production never passes it, and a model cannot:
   * `compose-review` reads its input as JSON, and this is not serialisable into
   * anything that would change where the transcripts are found on a real run.
   */
  env?: NodeJS.ProcessEnv;
  /** Step 1's lightweight `pr-context` fetch failed. */
  contextUnavailable?: boolean;
  presubmit?: {
    downgradeApprove?: boolean;
    downgradeRequestChanges?: boolean;
    downgradeReasons?: string[];
  };
  /** Model id for the footer, e.g. `qwen3.7-max`. */
  modelId: string;
}

export interface ComposeReviewResult {
  event: ReviewEvent;
  body: string;
  /** The table row before caps and downgrades — for the terminal report. */
  baseEvent: ReviewEvent;
  /** Which cap states applied (empty when none). */
  cappedBy: string[];
  /** True when a presubmit flag actually changed the event. */
  downgraded: boolean;
}

const CRITICAL_MARKER = '**[Critical]**';

function withMarker(line: string): string {
  return line.startsWith(CRITICAL_MARKER) ? line : `${CRITICAL_MARKER} ${line}`;
}

// The input arrives as JSON a model wrote, and the skill tells it to omit
// fields that do not apply — so absence is normal and means zero/empty. What
// must never pass is a PRESENT field of the wrong shape: `undefined + 1` is
// NaN, and NaN fails both `c >= 1` and `s >= 1`, which once turned a
// body-Critical-only input into an APPROVE that dropped the only blocker.
function toCount(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `compose-review: ${field} must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function toStringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new TypeError(
      `compose-review: ${field} must be an array of strings, got ${JSON.stringify(value)}`,
    );
  }
  // A copy. The caller's array is not ours to push into, and coverage-derived
  // entries are appended to these lists — a programmatic caller that reused one
  // across two calls would find the first call's caps in the second.
  return [...(value as string[])];
}

// Booleans get the same boundary treatment as the counts: the JSON is
// model-written, and a stringified `"false"` is truthy — it once stood to
// fire the downgrade sentence on a review that was never downgraded, and to
// publish the diff-only warning on a run that fetched its context fine.
function toBool(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    throw new TypeError(
      `compose-review: ${field} must be a boolean, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function composeReview(input: ComposeReviewInput): ComposeReviewResult {
  const criticalsInline = toCount(input.criticalsInline, 'criticalsInline');
  const suggestionsInline = toCount(
    input.suggestionsInline,
    'suggestionsInline',
  );
  const bodyCriticals = toStringList(input.bodyCriticals, 'bodyCriticals');
  const suggestionsDiscarded = toCount(
    input.suggestionsDiscarded,
    'suggestionsDiscarded',
  );
  const cannotTell = toStringList(
    input.cannotTellCriticals,
    'cannotTellCriticals',
  );
  const uncoverable = toStringList(
    input.uncoverableChunks,
    'uncoverableChunks',
  );
  const unreviewed = toStringList(
    input.unreviewedDimensions,
    'unreviewedDimensions',
  );

  // Coverage is shown, not asserted. Whatever the caller listed by hand, the
  // report's own gaps are added to it — a run cannot approve past a chunk nobody
  // receipted or an agent that returned nothing, and it cannot do so by leaving
  // the lists empty.
  // Separate from `uncoverable`. The uncoverable renderer explains the gap as
  // "a line there exceeds the read limit", which is true of an uncoverable chunk
  // and a fabrication about a chunk nobody receipted. The public body would give
  // the author a false cause.
  const missingReceipts: number[] = [];

  // Coverage is NOT taken from the input. It is recomputed here, from the
  // harness's own per-agent transcripts.
  //
  // The previous shape accepted a `coverage` object inside this very JSON — a
  // document the model writes. Hardening `check-coverage` while this still
  // believed a hand-typed `{"ok": true}` would have moved the forgery one hop
  // downstream and made it *cheaper*: one object, instead of the eighteen
  // fabricated receipts it actually wrote the last time it wanted an approval.
  // A caller cannot forge what it cannot supply, so it no longer supplies this.
  //
  // What it supplies is `planPath` — a path, whose contents the CLI wrote. The
  // transcripts are found from the environment the CLI exported.
  if (!input.planPath) {
    unreviewed.push(
      'coverage — no plan was given, so this run cannot show that any of the ' +
        'diff was read',
    );
  } else {
    try {
      const cov = coverageFromTranscripts(input.planPath, input.env);
      for (const id of cov.missingChunks) missingReceipts.push(id);
      for (const id of cov.uncoverableChunks) {
        // The caller may already have named it. Rendered twice, the body reads
        // "Not reviewed: chunk 5, chunk 5".
        const entry = `chunk ${id}`;
        if (!uncoverable.includes(entry)) uncoverable.push(entry);
      }
      for (const label of cov.idleAgents) {
        unreviewed.push(
          `${label} — the agent made no tool call: it read nothing`,
        );
      }
      // The defect that actually happened, named as itself. A blind agent was
      // launched with a prompt that never mentioned the diff, so it could not
      // have read it — and relaunching it would produce another agent that
      // cannot either. Do not call this a whiff; the prompt is the bug.
      for (const label of cov.blindAgents) {
        unreviewed.push(
          `${label} — launched with a prompt that never named the diff file, ` +
            'so it could not have read it (build the prompt with `qwen review ' +
            'agent-prompt`)',
        );
      }
    } catch (err) {
      // Two different failures, and they must not wear each other's message. A
      // malformed plan is the caller's mistake and says so; missing transcripts
      // are an environment fault (a read-only HOME, a sandbox) and say *that*.
      // Both cap — a run that cannot show what it read has not shown it read
      // anything — but a reader chasing "could not read the transcripts" over a
      // plan with no `chunks[]` is chasing the wrong thing.
      const why =
        err instanceof TranscriptsUnavailableError
          ? `could not read the agents' transcripts (${err.message})`
          : `the plan could not be used (${(err as Error).message})`;
      unreviewed.push(
        `coverage — ${why}, so this run cannot show that any of the diff was read`,
      );
    }
  }
  const contextUnavailable = toBool(
    input.contextUnavailable,
    'contextUnavailable',
  );
  const presubmitRaw: unknown = input.presubmit ?? {};
  if (typeof presubmitRaw !== 'object' || Array.isArray(presubmitRaw)) {
    throw new TypeError(
      `compose-review: presubmit must be an object, got ${JSON.stringify(presubmitRaw)}`,
    );
  }
  const presubmitObj = presubmitRaw as Record<string, unknown>;
  const downgradeApprove = toBool(
    presubmitObj['downgradeApprove'],
    'presubmit.downgradeApprove',
  );
  const downgradeRequestChanges = toBool(
    presubmitObj['downgradeRequestChanges'],
    'presubmit.downgradeRequestChanges',
  );
  const downgradeReasons = toStringList(
    presubmitObj['downgradeReasons'],
    'presubmit.downgradeReasons',
  );
  const modelId: unknown = input.modelId;
  if (typeof modelId !== 'string' || modelId.trim() === '') {
    throw new TypeError(
      'compose-review: modelId is required (the public footer names the reviewing model)',
    );
  }

  // `C` counts every Critical the review posts anywhere — inline or body.
  // `S` counts every *confirmed* Suggestion — anchored or discarded: the
  // verdict reflects the findings the review confirmed, not the ones that
  // anchored, so dropping every Suggestion's anchor must never upgrade the
  // event to APPROVE.
  const c = criticalsInline + bodyCriticals.length;
  const s = suggestionsInline + suggestionsDiscarded;

  const baseEvent: ReviewEvent =
    c >= 1 ? 'REQUEST_CHANGES' : s >= 1 ? 'COMMENT' : 'APPROVE';

  // Caps: states outside this run's confirmed count that forbid an
  // approval. A REQUEST_CHANGES earned by a confirmed Critical is never
  // softened by them.
  const cappedBy: string[] = [];
  if (cannotTell.length > 0) cappedBy.push('cannot-tell-existing-critical');
  if (missingReceipts.length > 0) cappedBy.push('chunk-nobody-read');
  if (uncoverable.length > 0) cappedBy.push('uncoverable-chunk');
  if (unreviewed.length > 0) cappedBy.push('unreviewed-dimension');
  if (contextUnavailable) cappedBy.push('context-unavailable');

  let event: ReviewEvent = baseEvent;
  if (event === 'APPROVE' && cappedBy.length > 0) event = 'COMMENT';

  // Presubmit downgrades apply after the caps and only when the verdict
  // they name is the one on the table.
  let downgraded = false;
  let downgradedFrom: 'Approve' | 'Request changes' | null = null;
  if (event === 'APPROVE' && downgradeApprove) {
    event = 'COMMENT';
    downgraded = true;
    downgradedFrom = 'Approve';
  } else if (event === 'REQUEST_CHANGES' && downgradeRequestChanges) {
    event = 'COMMENT';
    downgraded = true;
    downgradedFrom = 'Request changes';
  }

  const footer = `_— ${modelId} via Qwen Code /review_`;
  const finish = (text: string): string =>
    text === '' ? '' : `${text}\n\n${footer}`;

  // Clause 6 — scope nobody reviewed. Legal on COMMENT and (alongside body
  // Criticals) on REQUEST_CHANGES: the blocker must not squeeze out the
  // disclosure of what was never read.
  const notReviewedParts: string[] = [];
  if (missingReceipts.length > 0) {
    // Its own sentence, because its own cause. The clause below explains a gap
    // as a line too long to read, which is true of an *uncoverable* chunk and a
    // fabrication about one nobody receipted — the author would be told the diff
    // defeated the reader, when in fact no reader turned up.
    notReviewedParts.push(
      `Not reviewed: ${missingReceipts
        .map((id) => `chunk ${id}`)
        .join(', ')} — no agent reported covering these; nobody read them.`,
    );
  }
  if (uncoverable.length > 0) {
    notReviewedParts.push(
      `Not reviewed: ${uncoverable.join(', ')} — a line there exceeds the read limit.`,
    );
  }
  // Bare dimension names share the whiffed-agent explanation; an entry that
  // brought its own reason (after an em-dash) must not have the whiff
  // sentence appended to it — that would misstate why it went unreviewed.
  const whiffedDimensions = unreviewed.filter((d) => !d.includes(' — '));
  const explainedDimensions = unreviewed.filter((d) => d.includes(' — '));
  if (whiffedDimensions.length > 0) {
    notReviewedParts.push(
      `Not reviewed: ${whiffedDimensions.join(', ')} — the agent returned no evidence of its walk twice.`,
    );
  }
  for (const d of explainedDimensions) {
    notReviewedParts.push(`Not reviewed: ${d}.`);
  }

  // Clause 5 — blockers the review could neither confirm nor clear. They
  // survive every event shape: erasing one is how a review approves the
  // very thing it is asking about.
  const cannotTellBlock =
    cannotTell.length === 0
      ? []
      : [
          `Unresolved, please confirm: ${cannotTell
            .map((l) => withMarker(l))
            .join(' ')}`,
        ];

  const bodyCriticalBlock = bodyCriticals.map((l) => withMarker(l));

  const contextUnavailableClause =
    'Reviewed diff-only — the PR’s existing discussion could not be fetched, so this is not an approval and not a no-blockers claim.';

  if (event === 'REQUEST_CHANGES') {
    // Empty body, except the disclosures: every clause whose state holds
    // appears on every event — a confirmed blocker must not squeeze out the
    // trust warning (clause 2), an undecided existing Critical (clause 5),
    // or the unread-scope disclosure (clause 6).
    const parts = [
      ...(contextUnavailable ? [contextUnavailableClause] : []),
      ...cannotTellBlock,
      ...notReviewedParts,
      ...bodyCriticalBlock,
    ];
    return {
      event,
      body: finish(parts.join('\n\n')),
      baseEvent,
      cappedBy,
      downgraded,
    };
  }

  if (event === 'APPROVE') {
    return {
      event,
      body: finish('No issues found. LGTM! ✅'),
      baseEvent,
      cappedBy,
      downgraded,
    };
  }

  // COMMENT: ordered clause composition — each clause present iff its
  // condition holds, nothing else.
  const clauses: string[] = [];

  // 1. Downgrade sentence (only when a presubmit flag changed the event).
  if (downgraded && downgradedFrom) {
    const reasons = downgradeReasons.join('; ');
    clauses.push(
      `⚠️ Downgraded from ${downgradedFrom} to Comment${reasons ? `: ${reasons}` : ''}.`,
    );
  }

  // 2. Context-unavailable clause — when present, it opens the body and no
  //    clause may certify "no blockers".
  if (contextUnavailable) {
    clauses.push(contextUnavailableClause);
  } else {
    // 3. Opener — certifying only when the review can actually certify it.
    // Certification is keyed to whether presubmit PERMITS it, not to
    // whether presubmit changed the event: a Suggestion-only review is
    // already COMMENT, so failing CI or a self-PR flips no event — but a
    // body that certifies "no blockers" over failing CI, or a self-review
    // certifying its own PR, misstates authority all the same.
    const canCertify =
      !downgraded &&
      !downgradeApprove &&
      !downgradeRequestChanges &&
      c === 0 &&
      cannotTell.length === 0 &&
      uncoverable.length === 0 &&
      unreviewed.length === 0 &&
      // A missing receipt caps the event but was left out of certification, so a
      // body could open "Reviewed — no blockers." two lines above "nobody read
      // them." Nothing nobody read can be certified blocker-free.
      missingReceipts.length === 0;
    clauses.push(canCertify ? 'Reviewed — no blockers.' : 'Reviewed.');
  }

  // 4. Suggestions clause — keyed off the POSTED count, not `s`: an
  //    all-discarded run has nothing inline, and claiming otherwise while
  //    the discarded sentence says the opposite is the round-6 collision
  //    this module exists to kill. (`s` stays right for the event — see
  //    above.)
  if (suggestionsInline > 0) clauses.push('Suggestions are inline.');
  if (suggestionsDiscarded > 0) {
    clauses.push(
      `${suggestionsDiscarded} Suggestion-level finding(s) could not be anchored to the diff; see the terminal output.`,
    );
  }

  // 5. Unresolved existing Criticals.
  clauses.push(...cannotTellBlock);

  // 6. Not-reviewed disclosure.
  clauses.push(...notReviewedParts);

  // 7. Body Criticals — only on a COMMENT downgraded from REQUEST_CHANGES
  //    (the carve-out); on a plain COMMENT there is no RC to have carried
  //    them.
  if (downgradedFrom === 'Request changes') {
    clauses.push(...bodyCriticalBlock);
  }

  return {
    event,
    body: finish(clauses.join(' ')),
    baseEvent,
    cappedBy,
    downgraded,
  };
}

interface ComposeReviewCliArgs {
  input: string | undefined;
  out: string | undefined;
}

export const composeReviewCommand: CommandModule = {
  command: 'compose-review',
  describe:
    'Compute the review event and body from the finding counts and run states (the Step 7 invariant, as code); reads the state JSON from --input or stdin',
  builder: (yargs) =>
    yargs
      .option('input', {
        type: 'string',
        describe: 'Path to the state JSON (omit to read stdin)',
      })
      .option('out', {
        type: 'string',
        describe: 'Also write the {event, body} JSON to this path',
      }),
  handler: (argv) => {
    const { input, out } = argv as unknown as ComposeReviewCliArgs;
    const raw = readFileSync(input ?? 0, 'utf8');
    const result = composeReview(JSON.parse(raw) as ComposeReviewInput);
    const json = JSON.stringify(result, null, 2);
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, json, 'utf8');
    }
    writeStdoutLine(json);
  },
};
