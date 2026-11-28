/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext } from 'react';
import type { ToolAskUserQuestionConfirmationDetails } from '@qwen-code/qwen-code-core/tools/tools.js';

export interface QuestionDraft {
  currentQuestionIndex: number;
  selectedIndex: number;
  selectedOptions: Record<number, string>;
  multiSelectedOptions: Record<number, string[]>;
  customInputValues: Record<number, string>;
  customInputChecked: Record<number, boolean>;
}

interface PendingQuestion {
  key: number;
  draft?: QuestionDraft;
}

// The viewport outlives its rows. Key by the scheduler's pending confirmation
// object so identical prompts (or reused wire call IDs) never share answers.
export function createQuestionDraftCache() {
  const pending = new WeakMap<
    ToolAskUserQuestionConfirmationDetails,
    PendingQuestion
  >();
  let nextKey = 0;
  return (details: ToolAskUserQuestionConfirmationDetails) => {
    let entry = pending.get(details);
    if (!entry) {
      entry = { key: nextKey++ };
      pending.set(details, entry);
    }
    return entry;
  };
}

export const QuestionDraftContext = createContext<ReturnType<
  typeof createQuestionDraftCache
> | null>(null);
