/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildTeammatePromptAddendum } from './promptAddendum.js';

describe('buildTeammatePromptAddendum', () => {
  it('uses ordinary teammate reporting instructions by default', () => {
    const prompt = buildTeammatePromptAddendum('worker', 'team', 'leader');

    expect(prompt).toContain('call send_message(to: "leader"');
    expect(prompt).not.toContain('call exit_plan_mode');
  });

  it('tells plan-required teammates to submit plans through exit_plan_mode', () => {
    const prompt = buildTeammatePromptAddendum('planner', 'team', 'leader', {
      planModeRequired: true,
    });

    expect(prompt).toContain('start in plan mode');
    expect(prompt).toContain('call exit_plan_mode');
    expect(prompt).toContain('Do not use send_message for plan approval');
  });
});
