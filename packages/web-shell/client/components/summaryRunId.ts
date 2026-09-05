/**
 * Synthetic ids for compact-mode aggregated tool runs.
 * `mergeCompactToolGroups` builds them via `summaryRunId`; render paths detect
 * them through the shared predicate so the prefix scheme lives in one place.
 */
export const SUMMARY_RUN_ID_PREFIX = 'summary-';

export const summaryRunId = (firstMemberId: string): string =>
  `${SUMMARY_RUN_ID_PREFIX}${firstMemberId}`;

export const isSummaryRunId = (id: string): boolean =>
  id.startsWith(SUMMARY_RUN_ID_PREFIX);

export const summaryRunFirstMemberId = (id: string): string | undefined =>
  isSummaryRunId(id) ? id.slice(SUMMARY_RUN_ID_PREFIX.length) : undefined;
