/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  commitAiTitleCadenceForTurn,
  getAiTitleCheckOptionsForHumanPromptCount,
  planAiTitleCadenceForTurn,
} from './aiTitleTrigger.js';

describe('getAiTitleCheckOptionsForHumanPromptCount', () => {
  it('triggers the initial ai-title attempt on the first human prompt', () => {
    expect(getAiTitleCheckOptionsForHumanPromptCount(1)).toEqual({
      allowOverwriteAiTitle: false,
    });
  });

  it('skips all other prompt counts', () => {
    expect(getAiTitleCheckOptionsForHumanPromptCount(0)).toBeNull();
    expect(getAiTitleCheckOptionsForHumanPromptCount(2)).toBeNull();
    expect(getAiTitleCheckOptionsForHumanPromptCount(3)).toBeNull();
    expect(getAiTitleCheckOptionsForHumanPromptCount(4)).toBeNull();
  });

  it('plans cadence against the next successful prompt count', () => {
    expect(planAiTitleCadenceForTurn(0, true)).toEqual({
      pendingPromptCount: 1,
      aiTitleOptionsForTurn: { allowOverwriteAiTitle: false },
    });
    expect(planAiTitleCadenceForTurn(2, true)).toEqual({
      pendingPromptCount: 3,
      aiTitleOptionsForTurn: null,
    });
  });

  it('does not plan cadence for prompts that should not count', () => {
    expect(planAiTitleCadenceForTurn(1, false)).toEqual({
      pendingPromptCount: null,
      aiTitleOptionsForTurn: null,
    });
  });

  it('commits cadence only after a successful turn', () => {
    expect(commitAiTitleCadenceForTurn(1, false)).toBeNull();
    expect(commitAiTitleCadenceForTurn(1, true)).toBe(1);
  });
});
