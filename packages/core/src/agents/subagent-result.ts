/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AgentTerminateMode } from './runtime/agent-types.js';

function stripSummaryTags(text: string): string {
  return text.replace(/<\/?summary\b[^>]*>/gi, ' ').replace(/ {2,}/g, ' ');
}

/** Keeps successful subagent scratchpad tags out of the parent model context. */
export function toModelVisibleSubagentResult(
  text: string,
  terminateMode = AgentTerminateMode.GOAL,
): string {
  if (terminateMode !== AgentTerminateMode.GOAL) {
    return text;
  }

  const withoutAnalysis = text
    .replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, '')
    .replace(/<analysis\b[^>]*>[\s\S]*?(?=<summary\b[^>]*>|$)/gi, '');
  const trimmed = withoutAnalysis.trim();
  const summaryOpen = trimmed.match(/^<summary\b[^>]*>/i);
  if (summaryOpen && trimmed.toLowerCase().endsWith('</summary>')) {
    return stripSummaryTags(
      trimmed.slice(summaryOpen[0].length, -'</summary>'.length),
    ).trim();
  }

  return stripSummaryTags(trimmed).trim();
}
