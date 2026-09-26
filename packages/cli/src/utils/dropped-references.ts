/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { stripAnsiAndControl } from '@qwen-code/qwen-code-core/utils/textUtils.js';

/**
 * A reference the `@` resolver dropped without producing content, and the
 * one-line notice that tells the user about it (#8226).
 *
 * This lives outside `ui/hooks/atCommandProcessor.ts` on purpose: that module
 * is auto-mocked wholesale by several suites, and the headless CLI has to be
 * able to format a notice in tests that stub the resolver.
 */

/**
 * Why an `@`-reference produced no content. The fail-closed reasons
 * (`outside-workspace`, `identity-changed`, `not-validated`) are security
 * drops; the rest are environmental or plain misses.
 */
export type AtReferenceDropReason =
  | 'outside-workspace'
  | 'ignored'
  | 'not-found'
  | 'unreadable'
  | 'identity-changed'
  | 'not-validated'
  | 'snapshot-failed'
  | 'ambiguous';

/**
 * The reasons that mean a guard refused the reference rather than failing to
 * find it. `unreadable` is included because an identity check that cannot
 * complete is refused, not missed.
 */
const SECURITY_DROP_REASONS: ReadonlySet<AtReferenceDropReason> = new Set([
  'outside-workspace',
  'identity-changed',
  'not-validated',
  'unreadable',
]);

export interface DroppedAtReference {
  /** The reference as the user wrote it, without the leading `@`. */
  path: string;
  reason: AtReferenceDropReason;
}

const DROP_REASON_LABELS: Record<AtReferenceDropReason, string> = {
  'outside-workspace': 'outside the workspace',
  ignored: 'ignored by the git or qwen filters',
  'not-found': 'not found',
  unreadable: 'unreadable',
  'identity-changed': 'changed after it was validated',
  'not-validated': 'not validated',
  'snapshot-failed': 'could not be snapshotted',
  ambiguous: 'matched more than one',
};

/**
 * Whether a missed token reads as a file the user meant to attach. A bare word
 * with no extension is how handles, npm scopes and code decorators look, and
 * the resolver passes those through to the model as text either way, so
 * reporting them would put a false "Skipped" line on ordinary prose and teach
 * readers to ignore the refusals that matter. Path-shaped tokens still report.
 */
export function looksLikeFileReference(token: string): boolean {
  const lastSegment = token.split(/[\\/]/).pop() ?? token;
  const dot = lastSegment.lastIndexOf('.');
  return dot > 0 && dot < lastSegment.length - 1;
}

/** Keeps a bulk drop from flooding the transcript with one line per path. */
const DROPPED_NOTICE_MAX_ENTRIES = 5;

/** Longest rendered reference. A path longer than this is a detail, not a name. */
const DROPPED_NOTICE_PATH_LIMIT = 200;

function boundLabel(label: string): string {
  return label.length > DROPPED_NOTICE_PATH_LIMIT
    ? `${label.slice(0, DROPPED_NOTICE_PATH_LIMIT)}…`
    : label;
}

/**
 * Renders the dropped `@`-references as one line for the user, or null when
 * nothing was dropped.
 */
export function formatDroppedReferencesNotice(
  dropped: readonly DroppedAtReference[] | undefined,
): string | null {
  if (!dropped || dropped.length === 0) return null;
  // Refusals rank first, so a cap filled with unresolvable names cannot hide
  // the one entry that reports a guard firing. The sort is stable, so entries
  // sharing a rank keep the order they were recorded in.
  const rank = (drop: DroppedAtReference) =>
    SECURITY_DROP_REASONS.has(drop.reason) ? 0 : 1;
  const shown = dropped
    .map((drop, index) => ({ drop, index }))
    .sort((a, b) => rank(a.drop) - rank(b.drop) || a.index - b.index)
    .slice(0, DROPPED_NOTICE_MAX_ENTRIES)
    .map((entry) => entry.drop);
  const listed = shown
    .map(
      (drop) =>
        `@${boundLabel(stripAnsiAndControl(drop.path))} (${DROP_REASON_LABELS[drop.reason]})`,
    )
    .join(', ');
  const rest = dropped.length - shown.length;
  return (
    `Skipped ${dropped.length} @-reference` +
    `${dropped.length === 1 ? '' : 's'}: ${listed}` +
    (rest > 0 ? `, and ${rest} more` : '')
  );
}
