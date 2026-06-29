/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** Keeps subagent scratchpad tags out of the parent model context. */
export function toModelVisibleSubagentResult(text: string): string {
  const withoutAnalysis = text
    .replace(/<analysis\b[^>]*>[\s\S]*?(?:<\/analysis>|$)/gi, '')
    .replace(/<\/analysis>/gi, '');
  // Only unwrap summaries that cover the whole payload.
  const summaryMatch = withoutAnalysis.match(
    /^\s*<summary\b[^>]*>\s*([\s\S]*?)\s*<\/summary>\s*$/i,
  );

  return (summaryMatch?.[1] ?? withoutAnalysis).trim();
}
