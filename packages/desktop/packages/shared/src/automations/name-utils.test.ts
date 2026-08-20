/**
 * Tests for deriveAutomationName helper
 */

import { describe, it, expect } from 'bun:test';
import { deriveAutomationName } from './name-utils.ts';
import type { AutomationMatcher } from './types.ts';

describe('deriveAutomationName', () => {
  it('should return explicit matcher.name when set', () => {
    const matcher: AutomationMatcher = {
      name: 'Daily Triage',
      actions: [{ type: 'prompt', prompt: 'Review all open issues' }],
    };
    expect(deriveAutomationName('SchedulerTick', matcher)).toBe('Daily Triage');
  });

  it('should derive name from @mention in first action', () => {
    const matcher: AutomationMatcher = {
      actions: [{ type: 'prompt', prompt: '@linear check for issues' }],
    };
    expect(deriveAutomationName('LabelAdd', matcher)).toBe('linear prompt');
  });

  it('should use prompt text when no @mention and prompt is short', () => {
    const matcher: AutomationMatcher = {
      actions: [{ type: 'prompt', prompt: 'Review the code' }],
    };
    expect(deriveAutomationName('LabelAdd', matcher)).toBe('Review the code');
  });

  it('should truncate long prompts to 40 chars', () => {
    const longPrompt = 'This is a very long prompt that exceeds the forty character limit';
    const matcher: AutomationMatcher = {
      actions: [{ type: 'prompt', prompt: longPrompt }],
    };
    const result = deriveAutomationName('LabelAdd', matcher);
    expect(result).toBe(longPrompt.slice(0, 40) + '...');
    expect(result.length).toBe(43); // 40 + '...'
  });

  it('should not add ... for exactly 40-char prompts', () => {
    const prompt = 'A'.repeat(40);
    const matcher: AutomationMatcher = {
      actions: [{ type: 'prompt', prompt }],
    };
    expect(deriveAutomationName('LabelAdd', matcher)).toBe(prompt);
  });

  it('should fall back to event name when no actions', () => {
    const matcher: AutomationMatcher = {
      actions: [],
    };
    expect(deriveAutomationName('LabelAdd', matcher)).toBe('LabelAdd');
  });

  it('should prefer matcher.name over @mention', () => {
    const matcher: AutomationMatcher = {
      name: 'Custom Name',
      actions: [{ type: 'prompt', prompt: '@linear do something' }],
    };
    expect(deriveAutomationName('LabelAdd', matcher)).toBe('Custom Name');
  });
});
