/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  recordDiscovery,
  recordSearchResults,
  searchRank,
  takeFirstMcpSuccess,
} from './discovery-stats.js';

describe('discovery stats', () => {
  it('keeps the earliest rank and reports the effort before the first MCP success once', () => {
    recordDiscovery('s1', 'turn-1');
    recordSearchResults('s1', ['a', 'b'], 'turn-1');
    recordSearchResults('s1', ['b', 'c'], 'turn-2');
    expect([searchRank('s1', 'a'), searchRank('s1', 'b'), searchRank('s1', 'c')]).toEqual([1, 2, 2]);
    expect(searchRank('s2', 'a')).toBeUndefined();
    expect(takeFirstMcpSuccess('s1', 'turn-2')).toEqual({
      operations: 3,
      firstPromptId: 'turn-1',
      sameTurn: false,
    });
    expect(takeFirstMcpSuccess('s1', 'turn-2')).toBeUndefined();
    expect(takeFirstMcpSuccess('s3', 'turn-1')).toEqual({
      operations: 0,
      sameTurn: true,
    });
  });
});
