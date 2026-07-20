/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolNames } from '../tools/tool-names.js';

export const PLAN_MODE_ENTRY_SIBLING_SKIP_MESSAGE =
  'Tool call skipped because enter_plan_mode is an execution boundary. Retry it in the next model turn after observing the resulting approval mode.';

export function findPlanModeEntryBatchBoundaryIndex(
  toolNames: ReadonlyArray<string | undefined>,
): number | undefined {
  if (toolNames.length <= 1) return undefined;

  const index = toolNames.indexOf(ToolNames.ENTER_PLAN_MODE);
  return index === -1 ? undefined : index;
}
