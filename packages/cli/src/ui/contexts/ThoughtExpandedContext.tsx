/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';

export interface ThoughtExpandedValue {
  /** Alt+T global toggle — expands every thinking block at once. */
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
