/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ToolNames } from '../tools/tool-names.js';
import { findPlanModeEntryBatchBoundaryIndex } from './plan-mode-entry-policy.js';

describe('findPlanModeEntryBatchBoundaryIndex', () => {
  it.each([
    { names: [], expected: undefined },
    { names: [ToolNames.ENTER_PLAN_MODE], expected: undefined },
    { names: [ToolNames.READ_FILE], expected: undefined },
    {
      names: [ToolNames.ENTER_PLAN_MODE, ToolNames.READ_FILE],
      expected: 0,
    },
    {
      names: [ToolNames.WRITE_FILE, ToolNames.ENTER_PLAN_MODE],
      expected: 1,
    },
    {
      names: [
        ToolNames.READ_FILE,
        ToolNames.ENTER_PLAN_MODE,
        ToolNames.WRITE_FILE,
      ],
      expected: 1,
    },
    {
      names: [ToolNames.ENTER_PLAN_MODE, ToolNames.ENTER_PLAN_MODE],
      expected: 0,
    },
    {
      names: [undefined, ToolNames.ENTER_PLAN_MODE],
      expected: 1,
    },
  ])('returns $expected for $names', ({ names, expected }) => {
    expect(findPlanModeEntryBatchBoundaryIndex(names)).toBe(expected);
  });
});
