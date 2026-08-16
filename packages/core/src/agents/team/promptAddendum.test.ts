/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildTeammatePromptAddendum } from './promptAddendum.js';

describe('buildTeammatePromptAddendum', () => {
  it('describes automatic final delivery for ordinary teammates', () => {
    const prompt = buildTeammatePromptAddendum('worker', 'team', 'leader');

    expect(prompt).toContain(
      'The runtime forwards it to the leader automatically.',
    );
  });

  it('keeps send_message for normal-teammate interim communication', () => {
    const prompt = buildTeammatePromptAddendum('worker', 'team', 'leader');

    expect(prompt).toContain(
      'blockers, questions, and material interim findings',
    );
  });

  it('does not describe explicit reporting as the only delivery path', () => {
    const prompt = buildTeammatePromptAddendum('worker', 'team', 'leader');

    expect(prompt).not.toContain('This is the ONLY way');
  });

  it('describes automatic final delivery for plan-required teammates', () => {
    const prompt = buildTeammatePromptAddendum('planner', 'team', 'leader', {
      planModeRequired: true,
    });

    expect(prompt).toContain('start in plan mode');
    expect(prompt).toContain('call exit_plan_mode');
    expect(prompt).toContain('Do not use send_message for plan approval');
    expect(prompt).toContain(
      'blockers, questions, and material interim findings',
    );
    expect(prompt).toContain(
      'The runtime forwards it to the leader automatically.',
    );
  });

  it('marks read-only tasks complete before the turn-ending report', () => {
    const prompt = buildTeammatePromptAddendum('reader', 'team', 'leader', {
      readOnly: true,
    });

    expect(prompt).toContain('MARK COMPLETE');
    expect(prompt.indexOf('MARK COMPLETE')).toBeLessThan(
      prompt.indexOf('REPORT RESULTS'),
    );
  });
});
