/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The identity of a review's selected scope — the denominator, bound to the
// bytes it was computed from.
//
// A plan's `chunks[]` are line ranges **into the diff file**, and coverage is
// checked by re-reading the plan from its path long after the agents ran. The
// only thing tying the plan the agents were dispatched from to the plan the
// check reads is the plan file's mtime (`runEpochMs`), which fences the prompt
// records but says nothing about the DIFF: rewrite the diff after planning —
// a re-capture, a concurrent session, a `git diff` re-run in the worktree —
// and every chunk id still matches while the lines behind it have moved. The
// review then certifies chunk 7 as read, and the agent read a different
// chunk 7.
//
// So the plan records what it was computed from. `sourceArtifactSha256` is the
// diff text's digest; `selectionSha256` is the digest of the chunk boundaries
// themselves, which catches a plan re-chunked in place at the same size.
//
// NOT a duplicate of `fetch-pr`'s `diffSha256`, though both digest "the diff".
// Three differences, each load-bearing:
//
//   - **Who writes it.** `diffSha256` is written by `fetch-pr` alone. A
//     local-diff or file-path review goes through `capture-local` or
//     `plan-diff` and has never had a content identity at all — which is
//     exactly the population this check is for, since those are the plans
//     whose diff file sits in a working tree that keeps changing.
//   - **Who reads it.** `diffSha256` is read by `assessResume`, to decide
//     whether a `--resume` may credit the previous attempt. Nothing consults
//     it at coverage time, so a diff that changed *within* one run is
//     invisible to it.
//   - **What it digests.** `diffSha256` is over the raw BYTES git produced,
//     deliberately, so a latin1 or binary-adjacent diff still names what was
//     written. This digests the decoded TEXT — because the text is what
//     `buildDiffPlan` chunked, and the question here is whether the chunk
//     boundaries still describe their input. For a UTF-8 diff the two agree;
//     where they diverge, each is right about its own question.

import { createHash } from 'node:crypto';
import type { DiffChunk } from './diff-plan.js';

/**
 * The three fields a selection is made of. Narrower than `DiffChunk` on
 * purpose: the coverage reader holds the plan as parsed JSON, not as the
 * planner's type, and the digest reads nothing else.
 */
export type SelectionChunk = Pick<DiffChunk, 'id' | 'startLine' | 'endLine'>;

/** Bumped when a field's meaning changes, so a reader can refuse what it cannot read. */
export const SELECTION_SCHEMA_VERSION = 'qwen.review-selection/v1';

export interface SelectionIdentity {
  schemaVersion: typeof SELECTION_SCHEMA_VERSION;
  /** sha256 of the diff text the chunk line-ranges index into. */
  sourceArtifactSha256: string;
  /**
   * sha256 over the canonical `[id, startLine, endLine]` triples, in id order
   * — see `selectionDigest`.
   *
   * The only statement of the chunk list the identity carries, on purpose. A
   * recorded chunk count cannot disagree once this matches — the canonical
   * form is injective, so equal digests mean an identical triple list, hence
   * an identical length — and a recorded line count would duplicate the
   * plan's own `diffLines` without anything checking it. A field nothing
   * reads is a field that can only ever be wrong.
   */
  selectionSha256: string;
}

/** What `sha256` below writes: 64 lower-case hex digits, and nothing else. */
const isSha256 = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

const sha256 = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * The digest of a chunk list.
 *
 * Sorted by id, so two plans that differ only in the ORDER their chunks were
 * emitted hash the same — the selection is a set of ranges, not a sequence —
 * while any change to a boundary, an id, or the count changes the digest.
 *
 * The canonical form is JSON, not a hand-joined string: hand-joined, a field
 * that is not a number could carry the separator and fold two chunks into
 * one spelling. Over what callers actually pass it is injective — the
 * writers pass the planner's integers, and `selectionDrift` refuses a parsed
 * plan whose boundaries are not finite numbers before it digests one (ids
 * are `readPlan`'s to vouch for: it refuses any that is not a unique
 * integer).
 *
 * Changing this form changes every digest, and a plan an older build wrote
 * would then read as "edited after it was written" — so it is pinned by a
 * golden vector in the test, and a change to it owes a new
 * `SELECTION_SCHEMA_VERSION`.
 */
export function selectionDigest(chunks: readonly SelectionChunk[]): string {
  const canonical = JSON.stringify(
    [...chunks]
      .sort((a, b) => a.id - b.id)
      .map((c) => [c.id, c.startLine, c.endLine]),
  );
  return sha256(canonical);
}

export function buildSelectionIdentity(
  diffText: string,
  chunks: readonly SelectionChunk[],
): SelectionIdentity {
  return {
    schemaVersion: SELECTION_SCHEMA_VERSION,
    sourceArtifactSha256: sha256(diffText),
    selectionSha256: selectionDigest(chunks),
  };
}

/**
 * What a reader found when it checked a plan's identity against reality, or
 * `null` when everything matched.
 *
 * A string rather than a thrown error **on purpose, for now**. The failure this
 * detects has never been measured in a real run — it is derived from how the
 * pieces fit, not from an incident — and a check that has never fired is a
 * check whose false-positive rate is unknown. Turning an unmeasured predicate
 * into a hard refusal is how a review pipeline acquires a way to fail on
 * correct input. So this reports, callers disclose, nothing caps, and the
 * decision to make it fatal waits on runs that show how often it fires.
 *
 * The reasons are worded for an operator, because the repair is an operator's:
 * re-capture the diff and re-plan. Nothing an agent does can fix it.
 */
export type SelectionDrift = string | null;

/**
 * Check a plan's recorded identity against the diff on disk now.
 *
 * `identity` absent is not drift: a plan written by a CLI that predates this
 * field is old, not wrong, and a review must not narrate a defect at every
 * reader on every pre-existing plan. An identity present but from an unknown
 * schema IS reported — a reader that cannot interpret a field must say so
 * rather than skip it silently: silently ignoring a future schema is how a
 * check stops running without anyone noticing it stopped.
 */
export function selectionDrift(
  identity: unknown,
  actualDiffText: string,
  actualChunks: readonly SelectionChunk[],
): SelectionDrift {
  if (identity === undefined || identity === null) return null;
  if (typeof identity !== 'object' || Array.isArray(identity)) {
    return (
      'the plan carries a `selection` field that is not an object, so this ' +
      'build cannot read it — re-plan'
    );
  }
  const id = identity as Partial<SelectionIdentity>;
  if (id.schemaVersion !== SELECTION_SCHEMA_VERSION) {
    // The value found is not echoed: it is plan JSON — a file anything can
    // write — and this string is printed to a terminal and relayed by an
    // orchestrator. `JSON.stringify` would stop a newline, not a bidi
    // override or five megabytes.
    return (
      'the plan\u2019s selection identity is of a schema this build cannot ' +
      `read (it knows ${SELECTION_SCHEMA_VERSION}) — re-plan with this build`
    );
  }
  if (!isSha256(id.sourceArtifactSha256) || !isSha256(id.selectionSha256)) {
    // Named for what it is, not read as drift: a digest that is missing, not
    // a string, or not a sha256 — empty, truncated, re-cased — is an identity
    // this build cannot read — hand-edited or
    // half-written — and comparing `undefined` against the actual hash
    // reported it as "the diff file has changed", sending the operator to
    // re-capture a diff that never moved.
    return (
      'the plan\u2019s selection identity is missing its digests or carries ' +
      'one that is not a sha256, so this ' +
      'build cannot read it — re-plan'
    );
  }
  // The reader hands over chunks it PARSED, and only their ids have been
  // checked by then. A boundary that is not a finite number has no digest
  // worth comparing — JSON folds a missing one, `null` and `Infinity`
  // together, and a deeply nested object overflows the serialiser — so it is
  // named as what it is rather than digested.
  if (
    !actualChunks.every(
      (c) => Number.isFinite(c.startLine) && Number.isFinite(c.endLine),
    )
  ) {
    return (
      'the plan carries a chunk whose line range is not a pair of numbers, ' +
      'so its boundaries cannot be checked against the recorded identity — ' +
      're-plan'
    );
  }
  const actualSource = sha256(actualDiffText);
  if (id.sourceArtifactSha256 !== actualSource) {
    return (
      'the diff file has changed since the plan was written, so the chunk ' +
      'line-ranges no longer point at the lines they were planned over — ' +
      're-capture the diff and re-plan'
    );
  }
  const actualSelection = selectionDigest(actualChunks);
  if (id.selectionSha256 !== actualSelection) {
    return (
      'the plan’s chunk boundaries do not match the identity recorded ' +
      'beside them, so the plan was edited after it was written — re-plan'
    );
  }
  return null;
}
