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
// This is the shape `ocr` calls `ManifestInput.SourceArtifactSHA256`, and its
// neighbouring rule is the other half of the idea: resolved base/head are
// frozen commit SHAs, not the mutable refs a user typed.
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

/** Bumped when a field's meaning changes, so a reader can refuse what it cannot read. */
export const SELECTION_SCHEMA_VERSION = 'qwen.review-selection/v1';

export interface SelectionIdentity {
  schemaVersion: typeof SELECTION_SCHEMA_VERSION;
  /** sha256 of the diff text the chunk line-ranges index into. */
  sourceArtifactSha256: string;
  /** sha256 over the canonical `id:start-end` triples, in id order. */
  selectionSha256: string;
  /** The denominator, recorded beside its digest so a reader need not count. */
  chunkCount: number;
  /** Lines in the diff the chunks tile. */
  diffLines: number;
}

const sha256 = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * The digest of a chunk list.
 *
 * Sorted by id and joined with a separator no field can contain, so two plans
 * that differ only in the ORDER their chunks were emitted hash the same — the
 * selection is a set of ranges, not a sequence — while any change to a
 * boundary, an id, or the count changes the digest.
 */
export function selectionDigest(chunks: readonly DiffChunk[]): string {
  const canonical = [...chunks]
    .sort((a, b) => a.id - b.id)
    .map((c) => `${c.id}:${c.startLine}-${c.endLine}`)
    .join('\x00');
  return sha256(canonical);
}

export function buildSelectionIdentity(
  diffText: string,
  chunks: readonly DiffChunk[],
  diffLines: number,
): SelectionIdentity {
  return {
    schemaVersion: SELECTION_SCHEMA_VERSION,
    sourceArtifactSha256: sha256(diffText),
    selectionSha256: selectionDigest(chunks),
    chunkCount: chunks.length,
    diffLines,
  };
}

/**
 * The plan epoch a chunk launch carries, or `null` when the plan carries no
 * readable identity.
 *
 * Windows, counts and reads cannot order a transcript against a same-session
 * re-plan — a modify-only commit keeps every window, and the record carries
 * no plan epoch — so the launch carries one. The token mixes BOTH halves of
 * the capture identity because a modify-only rewrite moves
 * `sourceArtifactSha256` alone and a re-chunk moves `selectionSha256` alone:
 * a token keyed on either half would call one of the two plans the same.
 * `buildChunkLaunchPrompt` writes the line (`planTokenLine`); the coverage
 * seal reads it back (`launchPlanToken`) and refuses a launch marked with
 * another plan's token.
 *
 * `null` on absence and on any shape `selectionDrift` would not read — the
 * seal fails open on token absence exactly the way the drift check does:
 * absence of evidence, not evidence of staleness.
 */
export function planIdentityToken(selection: unknown): string | null {
  if (selection === undefined || selection === null) return null;
  if (typeof selection !== 'object' || Array.isArray(selection)) return null;
  const id = selection as Partial<SelectionIdentity>;
  if (id.schemaVersion !== SELECTION_SCHEMA_VERSION) return null;
  if (
    typeof id.sourceArtifactSha256 !== 'string' ||
    typeof id.selectionSha256 !== 'string'
  ) {
    return null;
  }
  return `${id.sourceArtifactSha256.slice(0, 8)}${id.selectionSha256.slice(
    0,
    8,
  )}`;
}

/** The marker a token-bearing launch writes, defined once for writer and reader. */
export const PLAN_TOKEN_LABEL = 'Plan identity:';

/** The launch line an identity-carrying plan earns; `null` on every other plan. */
export function planTokenLine(selection: unknown): string | null {
  const token = planIdentityToken(selection);
  return token === null ? null : `${PLAN_TOKEN_LABEL} ${token}`;
}

// Line-anchored, on purpose: the marker is read out of RENDERED launch text,
// and two entrances let foreign text carry one. `buildRoleLaunchPrompt`
// renders the PR-controlled file path on the identity line ahead of the token
// line (`inertPath` preserves spaces and colons), and `foldFindings` inserts
// the findings section between the identity and token lines — on the
// write-failure fallback that section inlines the prior findings list, which
// can QUOTE a marker. A writer always emits the marker as its own line, and
// `inertPath` strips newline and line-separator chars, so no filename can
// forge a standalone line — the anchor is what a forged marker cannot reach.
const PLAN_TOKEN_RE = new RegExp(`^${PLAN_TOKEN_LABEL} ([0-9a-f]{16})$`, 'mg');

/** The token a launch prompt carries, or `null` when it carries no marker. */
export function launchPlanToken(launchPrompt: string): string | null {
  // The LAST standalone marker: the launch's own. Foreign markers can only
  // PRECEDE it — folded findings land between the identity line and the
  // token line, and nothing after the token line carries PR-controlled text
  // that could open a line of its own.
  let token: string | null = null;
  for (const m of launchPrompt.matchAll(PLAN_TOKEN_RE)) token = m[1];
  return token;
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
 * rather than skip it silently, which is the same rule `plannedChunks`'
 * schema gate follows.
 */
export function selectionDrift(
  identity: unknown,
  actualDiffText: string,
  actualChunks: readonly DiffChunk[],
): SelectionDrift {
  if (identity === undefined || identity === null) return null;
  if (typeof identity !== 'object' || Array.isArray(identity)) {
    return 'the plan carries a `selection` field that is not an object';
  }
  const id = identity as Partial<SelectionIdentity>;
  if (id.schemaVersion !== SELECTION_SCHEMA_VERSION) {
    return (
      `the plan's selection identity is schema ` +
      `${JSON.stringify(id.schemaVersion)}, which this build cannot read ` +
      `(it knows ${SELECTION_SCHEMA_VERSION})`
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
  if (id.chunkCount !== actualChunks.length) {
    return (
      `the plan records ${id.chunkCount} chunk(s) but carries ` +
      `${actualChunks.length} — re-plan`
    );
  }
  return null;
}
