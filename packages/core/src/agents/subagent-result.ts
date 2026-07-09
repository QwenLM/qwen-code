/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AgentTerminateMode } from './runtime/agent-types.js';
import { stripAnalysisSummaryProtocolTags } from '../utils/protocol-tag-sanitizer.js';

/** Keeps successful subagent scratchpad tags out of the parent model context. */
export function toModelVisibleSubagentResult(
  text: string,
  terminateMode = AgentTerminateMode.GOAL,
): string {
  if (terminateMode !== AgentTerminateMode.GOAL) {
    return text;
  }

  return stripAnalysisSummaryProtocolTags(text);
}
