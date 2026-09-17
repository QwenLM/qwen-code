/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  getPromptCountFloor,
  mintLivePromptId,
  recordPromptCountFloor,
  resetPromptCountFloorForTesting,
  spendLivePromptId,
} from './prompt-count-floor.js';

const config = { getSessionId: () => 'session-1' };

describe('prompt-count-floor', () => {
  beforeEach(() => {
    resetPromptCountFloorForTesting();
  });

  it('mints from the counter when no floor is recorded', () => {
    expect(mintLivePromptId(config, () => 3)).toBe('session-1########3');
  });

  it('spends a minted id so the next mint does not re-issue it (R51-1)', () => {
    const minted = mintLivePromptId(config, () => 5);
    spendLivePromptId(config, minted);
    expect(mintLivePromptId(config, () => 5)).toBe('session-1########6');
  });

  it('ignores foreign-format ids instead of poisoning the floor', () => {
    spendLivePromptId(config, 'unrelated-id');
    spendLivePromptId(config, 'session-1########abc');
    spendLivePromptId(config, 'other-session########9');
    expect(getPromptCountFloor('session-1')).toBe(0);
    expect(mintLivePromptId(config, () => 5)).toBe('session-1########5');
  });

  it('never lowers a floor the counter already ran past', () => {
    recordPromptCountFloor('session-1', 8);
    spendLivePromptId(config, 'session-1########2');
    expect(getPromptCountFloor('session-1')).toBe(8);
  });
});
