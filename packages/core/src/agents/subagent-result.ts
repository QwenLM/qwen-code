/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** Keeps subagent scratchpad tags out of the parent model context. */
export function toModelVisibleSubagentResult(text: string): string {
  const withoutAnalysis = text
    .replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, '')
    .replace(/<analysis\b[^>]*>[\s\S]*?(?=<summary\b[^>]*>|$)/gi, '');
  const trimmed = withoutAnalysis.trim();
  const summaryOpen = trimmed.match(/^<summary\b[^>]*>/i);
  if (summaryOpen && trimmed.toLowerCase().endsWith('</summary>')) {
    return trimmed.slice(summaryOpen[0].length, -'</summary>'.length).trim();
  }

  return trimmed.replace(/<\/?summary\b[^>]*>/gi, '').trim();
}
