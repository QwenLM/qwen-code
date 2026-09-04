import { describe, expect, it } from 'vitest';
import {
  CONTEXT_USAGE_ERROR_PCT,
  CONTEXT_USAGE_WARNING_PCT,
  getContextUsageLevel,
} from './contextUsage';

describe('getContextUsageLevel', () => {
  it('escalates strictly above each threshold, matching the /context panel', () => {
    // Both thresholds are strict `>`: exactly 60% is still normal and
    // exactly 80% is still warning. The composer ring and the /context
    // panel both consume this helper, so these boundaries are the shared
    // contract between the two surfaces.
    expect(getContextUsageLevel(0)).toBe('normal');
    expect(getContextUsageLevel(CONTEXT_USAGE_WARNING_PCT)).toBe('normal');
    expect(getContextUsageLevel(CONTEXT_USAGE_WARNING_PCT + 1)).toBe('warning');
    expect(getContextUsageLevel(CONTEXT_USAGE_ERROR_PCT)).toBe('warning');
    expect(getContextUsageLevel(CONTEXT_USAGE_ERROR_PCT + 1)).toBe('error');
    expect(getContextUsageLevel(150)).toBe('error');
  });
});
