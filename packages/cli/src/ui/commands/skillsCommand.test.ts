/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect } from 'vitest';
import { skillsCommand } from './skillsCommand.js';
import type { SlashCommandActionReturn , type CommandContext  } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

interface FakeSkill {
  name: string;
  description?: string;
  priority?: number;
  userInvocable?: boolean;
  level?: string;
}

function makeContext(opts: {
  skills?: FakeSkill[];
  workspaceDisabled?: string[];
  mergedDisabled?: string[];
  isTrusted?: boolean;
  executionMode?: 'interactive' | 'non_interactive' | 'acp';
}): CommandContext {
  const {
    skills = [],
    workspaceDisabled = [],
    mergedDisabled = workspaceDisabled,
    isTrusted = true,
    executionMode = 'interactive',
  } = opts;

  const skillManager = {
    listSkills: vi.fn().mockResolvedValue(skills),
  };

  // Mirror the normalization that buildDisabledSkillNamesProvider applies
  // (trim + lowercase + filter non-strings) so this fake matches the real
  // Config.getDisabledSkillNames() contract — skillsCommand calls into it
  // directly now instead of doing its own string munging.
  const disabledSet = new Set(
    mergedDisabled
      .filter((n): n is string => typeof n === 'string')
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean),
  );

  return createMockCommandContext({
    executionMode,
    services: {
      config: {
        getSkillManager: () => skillManager,
        getDisabledSkillNames: () => disabledSet,
      } as never,
      settings: {
        isTrusted,
        merged: { skills: { disabled: mergedDisabled } },
        forScope: vi.fn().mockReturnValue({
          settings: { skills: { disabled: workspaceDisabled } },
        }),
        setValue: vi.fn(),
      } as never,
    },
    ui: {
      addItem: vi.fn(),
    } as never,
  });
}

describe('skillsCommand bare entry', () => {
  it('opens the manage dialog directly in interactive mode', async () => {
    if (!skillsCommand.action) {
      throw new Error('skillsCommand must have an action.');
    }
    const context = makeContext({
      skills: [{ name: 'alpha' }, { name: 'beta' }],
      executionMode: 'interactive',
    });

    const result = await skillsCommand.action(context, '');

    // Single-entry UX: bare `/skills` (no args) goes straight to the
    // dialog. No SKILLS_LIST emitted in interactive mode.
    expect(result).toEqual({ type: 'dialog', dialog: 'skills_manage' });
    expect(context.ui.addItem).not.toHaveBeenCalled();
  });

  it('opens the dialog even when args are passed in interactive mode', async () => {
    // `/skills` is dialog-only — any trailing args are ignored. The legacy
    // `/skills <name>` invocation path was removed; users invoke skills
    // via `/<skill-name>` directly (loaded by SkillCommandLoader) or by
    // picking inside the dialog.
    if (!skillsCommand.action) throw new Error('action missing');
    const context = makeContext({
      skills: [{ name: 'beta' }],
      executionMode: 'interactive',
    });

    const result = await skillsCommand.action(context, 'beta');

    expect(result).toEqual({ type: 'dialog', dialog: 'skills_manage' });
    expect(context.ui.addItem).not.toHaveBeenCalled();
  });

  it('falls back to listing in non-interactive mode (no dialog UI to render)', async () => {
    if (!skillsCommand.action) throw new Error('action missing');
    const context = makeContext({
      skills: [
        {
          name: 'high',
          priority: 100,
          description: 'High priority',
          level: 'project',
        },
        {
          name: 'low',
          priority: -5,
          description: 'Low priority',
          level: 'bundled',
        },
        {
          name: 'mid',
          priority: 10,
          description: 'Mid priority',
          level: 'user',
        },
      ],
      executionMode: 'acp',
    });

    const result = await skillsCommand.action(context, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining('high'),
    });
    const content = (
      result as Extract<SlashCommandActionReturn, { type: 'message' }>
    ).content;
    expect(content).toContain('High priority');
    expect(content).toContain('(Project)');
    expect(content).toContain('Mid priority');
    expect(content).toContain('(User)');
    expect(content).toContain('Low priority');
    expect(content).toContain('(Bundled)');
    const highIdx = content.indexOf('high');
    const midIdx = content.indexOf('mid');
    const lowIdx = content.indexOf('low');
    expect(highIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lowIdx);
  });

  it('omits non-user-invocable skills from the non-interactive listing', async () => {
    if (!skillsCommand.action) throw new Error('action missing');
    const context = makeContext({
      skills: [
        { name: 'alpha', description: 'Alpha skill', level: 'bundled' },
        {
          name: 'model-only',
          userInvocable: false,
          description: 'Model only',
          level: 'bundled',
        },
        { name: 'gamma', description: 'Gamma skill', level: 'bundled' },
      ],
      executionMode: 'non_interactive',
    });

    const result = await skillsCommand.action(context, '');

    const content = (
      result as Extract<SlashCommandActionReturn, { type: 'message' }>
    ).content;
    expect(content).toContain('alpha');
    expect(content).toContain('gamma');
    expect(content).not.toContain('model-only');
  });

  it('omits disabled skills from the non-interactive listing', async () => {
    if (!skillsCommand.action) throw new Error('action missing');
    const context = makeContext({
      skills: [
        { name: 'alpha', description: 'Alpha', level: 'bundled' },
        { name: 'beta', description: 'Beta', level: 'bundled' },
        { name: 'gamma', description: 'Gamma', level: 'bundled' },
      ],
      workspaceDisabled: ['beta'],
      mergedDisabled: ['beta'],
      executionMode: 'non_interactive',
    });

    const result = await skillsCommand.action(context, '');

    const content = (
      result as Extract<SlashCommandActionReturn, { type: 'message' }>
    ).content;
    expect(content).toContain('alpha');
    expect(content).toContain('gamma');
    expect(content).not.toContain('beta');
  });

  it('shows no available skills when all loaded skills are not user invocable', async () => {
    if (!skillsCommand.action) throw new Error('action missing');
    const context = makeContext({
      skills: [{ name: 'model-only', userInvocable: false }],
      executionMode: 'acp',
    });

    const result = await skillsCommand.action(context, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'All skills are marked as non-user-invocable.',
    });
  });

  it('shows a clarifying message when all skills are disabled in non-interactive mode', async () => {
    if (!skillsCommand.action) throw new Error('action missing');
    const context = makeContext({
      skills: [
        { name: 'a', description: 'Skill A', level: 'bundled' },
        { name: 'b', description: 'Skill B', level: 'bundled' },
      ],
      workspaceDisabled: ['a', 'b'],
      mergedDisabled: ['a', 'b'],
      executionMode: 'acp',
    });

    const result = await skillsCommand.action(context, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: expect.stringMatching(
        /disabled.*settings\.json|skills\.disabled/i,
      ),
    });
  });
});

describe('skillsCommand surface', () => {
  it('exposes no subCommands and no completion (single-entry, no args)', () => {
    expect(skillsCommand.subCommands ?? []).toEqual([]);
    expect(skillsCommand.completion).toBeUndefined();
  });

  it('opts into submit-on-accept so /skil<Enter> opens the dialog in one keystroke', () => {
    // Without this flag, accepting the `skills` suggestion from the
    // auto-completion popup would only fill the buffer with `/skills `
    // and force a second Enter to submit. See `Suggestion.submitOnAccept`
    // and the InputPrompt accept-suggestion branch.
    expect(skillsCommand.submitOnAccept).toBe(true);
  });
});
