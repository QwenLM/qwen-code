/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect } from 'vitest';
import { skillsCommand } from './skillsCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';

interface FakeSkill {
  name: string;
  description?: string;
  priority?: number;
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

  return createMockCommandContext({
    executionMode,
    services: {
      config: {
        getSkillManager: () => skillManager,
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

  it('falls back to listing in non-interactive mode (no dialog UI to render)', async () => {
    if (!skillsCommand.action) throw new Error('action missing');
    const context = makeContext({
      skills: [
        { name: 'high', priority: 100 },
        { name: 'low', priority: -5 },
        { name: 'mid', priority: 10 },
      ],
      executionMode: 'acp',
    });

    await skillsCommand.action(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.SKILLS_LIST,
        skills: [{ name: 'high' }, { name: 'mid' }, { name: 'low' }],
      },
      expect.any(Number),
    );
  });

  it('omits disabled skills from the non-interactive listing', async () => {
    if (!skillsCommand.action) throw new Error('action missing');
    const context = makeContext({
      skills: [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }],
      workspaceDisabled: ['beta'],
      mergedDisabled: ['beta'],
      executionMode: 'non_interactive',
    });

    await skillsCommand.action(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.SKILLS_LIST,
        skills: [{ name: 'alpha' }, { name: 'gamma' }],
      },
      expect.any(Number),
    );
  });

  it('emits the disabled-specific error for /skills <disabled-name>', async () => {
    if (!skillsCommand.action) throw new Error('action missing');
    const context = makeContext({
      skills: [{ name: 'beta', description: 'b' }],
      workspaceDisabled: ['beta'],
      mergedDisabled: ['beta'],
    });

    await skillsCommand.action(context, 'beta');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.ERROR,
        text: expect.stringMatching(/is disabled/),
      },
      expect.any(Number),
    );
    const errorCall = vi
      .mocked(context.ui.addItem)
      .mock.calls.find((c) => c[0].type === MessageType.ERROR);
    expect((errorCall?.[0] as { text: string }).text).not.toMatch(
      /Unknown skill/,
    );
  });

  it('shows a clarifying message when all skills are disabled in non-interactive mode', async () => {
    if (!skillsCommand.action) throw new Error('action missing');
    const context = makeContext({
      skills: [{ name: 'a' }, { name: 'b' }],
      workspaceDisabled: ['a', 'b'],
      mergedDisabled: ['a', 'b'],
      executionMode: 'acp',
    });

    await skillsCommand.action(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.INFO,
        text: expect.stringMatching(
          /disabled.*settings\.json|skills\.disabled/i,
        ),
      },
      expect.any(Number),
    );
  });
});

describe('skillsCommand has no subcommands', () => {
  it('exposes no subCommands (single-entry dialog UX)', () => {
    expect(skillsCommand.subCommands ?? []).toEqual([]);
  });
});

describe('skillsCommand completion', () => {
  it('returns skill-name suggestions only (no enable/disable/manage)', async () => {
    if (!skillsCommand.completion) throw new Error('completion missing');
    const context = makeContext({
      skills: [
        { name: 'alpha', description: 'a' },
        { name: 'beta', description: 'b' },
      ],
    });

    const out = await skillsCommand.completion(context, '');
    const values = out.map((c) => c.value);

    // Subcommand suggestions are gone — bare `/skills` is dialog-only and
    // toggling happens inside the dialog. The popup at `/skills <space>`
    // should only suggest skill names for the legacy invocation path.
    expect(values).not.toContain('manage');
    expect(values).not.toContain('enable');
    expect(values).not.toContain('disable');
    expect(values).toEqual(['alpha', 'beta']);
  });

  it('omits disabled skills from completion', async () => {
    if (!skillsCommand.completion) throw new Error('completion missing');
    const context = makeContext({
      skills: [
        { name: 'alpha', description: 'a' },
        { name: 'beta', description: 'b' },
      ],
      workspaceDisabled: ['beta'],
      mergedDisabled: ['beta'],
    });

    const out = await skillsCommand.completion(context, '');
    expect(out.map((c) => c.value)).toEqual(['alpha']);
  });

  it('fuzzy-matches the partial against skill names', async () => {
    if (!skillsCommand.completion) throw new Error('completion missing');
    const context = makeContext({
      skills: [
        { name: 'alpha', description: 'a' },
        { name: 'apple', description: 'fruit' },
        { name: 'beta', description: 'b' },
      ],
    });

    const out = await skillsCommand.completion(context, 'al');
    // alpha matches "al" prefix; apple doesn't but fzf may include it.
    // The key invariant: alpha is in the result and beta isn't.
    const values = out.map((c) => c.value);
    expect(values).toContain('alpha');
    expect(values).not.toContain('beta');
  });
});
