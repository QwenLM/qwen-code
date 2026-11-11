/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ToolNames } from '../tools/tool-names.js';
import {
  findPlanModeEntryBatchBoundaryIndex,
  getPlanModeLifecyclePrefix,
} from './plan-mode-entry-policy.js';
import { getPlanModeSystemReminder } from './prompts.js';

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

describe('getPlanModeLifecyclePrefix', () => {
  // Red-if-removed: the Todo-capture variant is the third list entry. If it
  // is dropped, the tool response finalizer applies the truncation budget to
  // the whole reminder that enter_plan_mode emits when both gates are on.
  it('recognises the Todo-capture reminder as a protected prefix', () => {
    const reminder = getPlanModeSystemReminder(false, true, true);
    expect(
      getPlanModeLifecyclePrefix(ToolNames.ENTER_PLAN_MODE, reminder),
    ).toBe(reminder);
    expect(
      getPlanModeLifecyclePrefix(
        ToolNames.ENTER_PLAN_MODE,
        `${reminder}\n\n<extra output>`,
      ),
    ).toBe(`${reminder}\n\n`);
  });

  it('ignores outputs of other tools', () => {
    expect(
      getPlanModeLifecyclePrefix(
        ToolNames.READ_FILE,
        getPlanModeSystemReminder(false, true, true),
      ),
    ).toBeUndefined();
  });
});
