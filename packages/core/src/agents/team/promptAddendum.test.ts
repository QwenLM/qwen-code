/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTeammatePromptAddendum } from './promptAddendum.js';

const mockIsBashSearchAvailable = vi.hoisted(() => vi.fn());
vi.mock('../../utils/bash-search-tools.js', () => ({
  isBashSearchAvailable: mockIsBashSearchAvailable,
}));

describe('buildTeammatePromptAddendum', () => {
  beforeEach(() => {
    mockIsBashSearchAvailable.mockReturnValue(false);
  });

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

  it('uses Bash search guidance when available', () => {
    mockIsBashSearchAvailable.mockReturnValue(true);

    const prompt = buildTeammatePromptAddendum('worker', 'team', 'leader');

    expect(prompt).toContain('run_shell_command with `rg` / `rg --files`');
    expect(prompt).not.toContain('grep_search, glob');
  });

  it('keeps dedicated search guidance when the teammate has no Shell', () => {
    mockIsBashSearchAvailable.mockReturnValue(true);

    const prompt = buildTeammatePromptAddendum('worker', 'team', 'leader', {
      canUseShellSearch: false,
    });

    expect(prompt).toContain('grep_search, glob');
    expect(prompt).not.toContain('run_shell_command with `rg`');
  });

  it('uses Bash search guidance in plan mode when available', () => {
    mockIsBashSearchAvailable.mockReturnValue(true);

    const prompt = buildTeammatePromptAddendum('planner', 'team', 'leader', {
      planModeRequired: true,
    });

    expect(prompt).toContain('other available read-only investigation tools');
    expect(prompt).not.toContain('grep_search, glob');
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

  // TeamManager forwards final round text when a teammate goes idle. Round
  // text after an explicit send_message is forwarded too, so the prompts must
  // not describe automatic delivery as only a fallback (#9283). Prose
  // assertions flatten whitespace first — the addendum is line-wrapped source
  // text, and the pin is on the wording, not the wrap points.
  const flatten = (prompt: string) => prompt.replace(/\s+/g, ' ');

  it('tells ordinary teammates their last text output is delivered automatically', () => {
    const prompt = flatten(
      buildTeammatePromptAddendum('worker', 'team', 'leader'),
    );

    expect(prompt).toContain(
      'the runtime forwards the last text you emitted to the leader automatically',
    );
    expect(prompt).toContain('end your turn with your report');
    // Explicit reporting arrives sooner; automatic forwarding fires again only
    // when non-empty round text follows it.
    expect(prompt).toContain('call send_message(to: "leader"');
    expect(prompt).toContain('earlier additionally delivers it sooner');
    expect(prompt).toContain(
      'Your text output is NOT visible to peer teammates',
    );
    expect(prompt).not.toContain('NOT visible to other agents');
    expect(prompt.toLowerCase()).not.toContain('only way');
    expect(prompt).not.toContain('without an explicit report');
  });

  it('tells plan-required teammates their last text output is delivered automatically', () => {
    const prompt = flatten(
      buildTeammatePromptAddendum('planner', 'team', 'leader', {
        planModeRequired: true,
      }),
    );

    expect(prompt).toContain(
      'the runtime forwards the last text you emitted to the leader automatically',
    );
    expect(prompt).toContain('end your turn with your report');
    expect(prompt).toContain('call send_message(to: "leader"');
    expect(prompt).toContain('earlier additionally delivers it sooner');
    expect(prompt).not.toContain('without an explicit report');
  });

  // Control: the read-only prompt already states automatic delivery and
  // passed before the fix — pin it so the alignment reference itself
  // cannot regress unnoticed.
  it('keeps the read-only prompt stating automatic delivery', () => {
    const prompt = flatten(
      buildTeammatePromptAddendum('reader', 'team', 'leader', {
        readOnly: true,
      }),
    );

    expect(prompt).toContain('forwards it to the leader automatically');
  });
});
