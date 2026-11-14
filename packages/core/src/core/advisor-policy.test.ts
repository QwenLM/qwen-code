/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { buildAdvisorReminder } from './advisor-policy.js';

describe('Advisor task policy', () => {
  it('guides discovery before the advisor schema is declared', () => {
    const reminder = buildAdvisorReminder(true, ['tool_search', 'tool_call']);
    expect(reminder).toContain('select:advisor');
    expect(reminder).toContain('gather context first');
    expect(reminder).toContain('Advice is not user approval');
  });

  it('uses a direct declaration when available', () => {
    expect(buildAdvisorReminder(true, ['advisor'])).toContain(
      'Call advisor with no arguments.',
    );
  });

  it('does not advertise a disabled or unreachable advisor', () => {
    expect(buildAdvisorReminder(false, ['advisor'])).toBeUndefined();
    expect(buildAdvisorReminder(true, ['tool_search'])).toBeUndefined();
    expect(buildAdvisorReminder(true, ['tool_call'])).toBeUndefined();
    expect(buildAdvisorReminder(true, [])).toBeUndefined();
  });
});
