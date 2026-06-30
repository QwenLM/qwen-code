/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AgentTerminateMode } from './runtime/agent-types.js';

function stripVisibleTags(text: string): string {
  return text
    .replace(/<analysis\b[^>]*\/>/gi, ' ')
    .replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, ' ')
    .replace(/<\/?summary\b[^>]*>/gi, ' ')
    .replace(/ {2,}/g, ' ');
}

function stripAnalysisOutsideSummary(text: string): string {
  const tagPattern = /<\/?(?:analysis|summary)\b[^>]*>/gi;
  let result = '';
  let index = 0;
  let summaryDepth = 0;

  while (true) {
    tagPattern.lastIndex = index;
    const match = tagPattern.exec(text);
    if (!match) {
      return result + text.slice(index);
    }

    const tag = match[0].toLowerCase();
    const start = match.index;
    const end = start + match[0].length;

    if (summaryDepth > 0) {
      result += text.slice(index, end);
      if (tag.startsWith('<summary')) {
        summaryDepth += 1;
      } else if (tag.startsWith('</summary')) {
        summaryDepth -= 1;
      }
      index = end;
      continue;
    }

    if (tag.startsWith('<summary')) {
      result += text.slice(index, end);
      summaryDepth = 1;
      index = end;
      continue;
    }

    if (!tag.startsWith('<analysis')) {
      result += text.slice(index, end);
      index = end;
      continue;
    }

    result += text.slice(index, start);
    const rest = text.slice(end);
    const closeIndex = rest.search(/<\/analysis>/i);
    const summaryIndex = rest.search(/<summary\b[^>]*>/i);
    if (closeIndex !== -1) {
      index = end + closeIndex + '</analysis>'.length;
    } else {
      index = summaryIndex === -1 ? text.length : end + summaryIndex;
    }
  }
}

/** Keeps successful subagent scratchpad tags out of the parent model context. */
export function toModelVisibleSubagentResult(
  text: string,
  terminateMode = AgentTerminateMode.GOAL,
): string {
  if (terminateMode !== AgentTerminateMode.GOAL) {
    return text;
  }

  return stripVisibleTags(stripAnalysisOutsideSummary(text).trim()).trim();
}
