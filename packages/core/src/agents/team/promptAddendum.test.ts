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

  it('marks read-only tasks complete before the turn-ending report', () => {
    const prompt = buildTeammatePromptAddendum('reader', 'team', 'leader', {
      readOnly: true,
    });

    expect(prompt).toContain('MARK COMPLETE');
    expect(prompt.indexOf('MARK COMPLETE')).toBeLessThan(
      prompt.indexOf('REPORT RESULTS'),
    );
  });

  // The runtime forwards an unreported final answer to the leader when a
  // teammate goes idle (TeamManager's IDLE transition reports it unless
  // the teammate already sent an explicit message). The prompts must
  // describe that instead of contradicting it (#9283): saying an explicit
  // send_message is the ONLY delivery path pushes teammates into redundant
  // structured reports. Prose assertions flatten whitespace first — the
  // addendum is line-wrapped source text, and the pin is on the wording,
  // not the wrap points.
  const flatten = (prompt: string) => prompt.replace(/\s+/g, ' ');

  it('tells ordinary teammates their final answer is delivered automatically', () => {
    const prompt = flatten(
      buildTeammatePromptAddendum('worker', 'team', 'leader'),
    );

    expect(prompt).toContain(
      'the runtime forwards your final answer to the leader automatically',
    );
    // Explicit reporting stays the recommended path — the fix describes a
    // fallback, it does not demote send_message.
    expect(prompt).toContain('call send_message(to: "leader"');
    expect(prompt).not.toContain('ONLY way');
  });

  it('tells plan-required teammates their final answer is delivered automatically', () => {
    const prompt = flatten(
      buildTeammatePromptAddendum('planner', 'team', 'leader', {
        planModeRequired: true,
      }),
    );

    expect(prompt).toContain(
      'the runtime forwards your final answer to the leader automatically',
    );
    expect(prompt).toContain('call send_message(to: "leader"');
  });

  // Control: the read-only prompt already states automatic delivery and
  // passed before the fix — pin it so the alignment reference itself
  // cannot regress unnoticed.
  it('keeps the read-only prompt stating automatic delivery', () => {
    const prompt = buildTeammatePromptAddendum('reader', 'team', 'leader', {
      readOnly: true,
    });

    expect(prompt).toContain('forwards it to the leader automatically');
  });
});
