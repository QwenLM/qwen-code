/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { REPORT_ID_PATTERN } from '../contracts.js';

export type SendAnalysis = (
  failureIds: string[],
  signal: AbortSignal,
) => Promise<{ isError?: boolean }>;

export function analysisRequestText(
  reportId: string,
  failureIds: string[],
): string {
  if (
    !REPORT_ID_PATTERN.test(reportId) ||
    failureIds.length === 0 ||
    failureIds.length > 20 ||
    new Set(failureIds).size !== failureIds.length ||
    failureIds.some(
      (id) => !/^f(?:0|[1-9]\d{0,3}):(?:a(?:0|[1-9]\d{0,4})|error)$/.test(id),
    )
  ) {
    throw new Error('Select 1–20 unique failure IDs from this report.');
  }
  return `Read-only analysis of these test failures. Use test_report_query to inspect the original snapshot evidence first, and distinguish observed facts from possible causes. Analyze only; do not modify files or rerun tests.\n${JSON.stringify({ reportId, itemIds: failureIds }, null, 2)}`;
}
