/**
 * Shared severity thresholds for context-window occupancy, used by the
 * composer ring and the /context panel so the two surfaces never disagree
 * about when usage turns warning or error.
 */
export const CONTEXT_USAGE_WARNING_PCT = 60;
export const CONTEXT_USAGE_ERROR_PCT = 80;

export type ContextUsageLevel = 'normal' | 'warning' | 'error';

export function getContextUsageLevel(pct: number): ContextUsageLevel {
  if (pct > CONTEXT_USAGE_ERROR_PCT) return 'error';
  if (pct > CONTEXT_USAGE_WARNING_PCT) return 'warning';
  return 'normal';
}
