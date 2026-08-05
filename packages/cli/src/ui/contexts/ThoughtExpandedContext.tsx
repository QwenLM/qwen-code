/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';

/**
 * Head-id key used while a thought is still streaming (pending). A pending
 * thought has no committed head id yet, so its inline expansion is recorded
 * under this sentinel and migrated to the real committed head id when the
 * thought commits (see `settlePendingExpansion` below). Negative so it can
 * never collide with a real committed head id, which is always a large
 * positive `baseTimestamp + counter` value.
 */
export const PENDING_THOUGHT_HEAD_ID = -1;

/**
 * Migrate a pending thought's provisional expansion, keyed by
 * PENDING_THOUGHT_HEAD_ID, to its committed head id so a thought expanded
 * while streaming stays expanded. Pass `null` when the pending thought was
 * dropped without committing — the provisional key is then just removed.
 * Returns `prev` unchanged when nothing is pending.
 */
export function settlePendingExpansion(
  prev: ReadonlySet<number>,
  committedHeadId: number | null,
): ReadonlySet<number> {
  if (!prev.has(PENDING_THOUGHT_HEAD_ID)) return prev;
  const next = new Set(prev);
  next.delete(PENDING_THOUGHT_HEAD_ID);
  if (committedHeadId != null) next.add(committedHeadId);
  return next;
}

export interface ThoughtExpandedValue {
  /**
   * Ctrl+O / Alt+T global toggle. Despite the name this is the app-wide
   * full-detail switch: it force-expands every thinking block AND every tool
   * group (untruncating tool results), not thinking alone. `MainContent` reads
   * it and forwards it to each `HistoryItemDisplay` as `fullDetail`.
   */
  allExpanded: boolean;
  /**
   * Head ids of thoughts the user expanded individually (by clicking the
   * collapsed line in VP mode). A "thought" is one `gemini_thought` head item
   * plus its trailing `gemini_thought_content` continuations; all of them key
   * off the head id so a single click expands the whole group.
   */
  expandedHeadIds: ReadonlySet<number>;
  /** Toggle the per-thought expansion for a head id. */
  toggle: (headId: number) => void;
}

const EMPTY_IDS: ReadonlySet<number> = new Set<number>();

const ThoughtExpandedContext = createContext<ThoughtExpandedValue>({
  allExpanded: false,
  expandedHeadIds: EMPTY_IDS,
  toggle: () => {},
});

export const useThoughtExpanded = (): ThoughtExpandedValue =>
  useContext(ThoughtExpandedContext);

export const ThoughtExpandedProvider = ThoughtExpandedContext.Provider;
