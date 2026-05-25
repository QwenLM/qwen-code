/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect } from 'vitest';
import { skillsCommand } from './skillsCommand.js';
import { type CommandContext, type SlashCommand } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import { SettingScope } from '../../config/settings.js';

interface FakeSkill {
  name: string;
  description?: string;
  priority?: number;
}

function findSubCommand(name: string): SlashCommand {
  const sub = skillsCommand.subCommands?.find((c) => c.name === name);
  if (!sub) throw new Error(`Subcommand ${name} not found on /skills`);
  return sub;
}

function makeContext(opts: {
  skills?: FakeSkill[];
  workspaceDisabled?: string[];
  mergedDisabled?: string[];
  isTrusted?: boolean;
  executionMode?: 'interactive' | 'non_interactive' | 'acp';
  reloadCommands?: () => void | Promise<void>;
  notifyConfigChanged?: () => Promise<void>;
}): CommandContext {
  const {
    skills = [],
    workspaceDisabled = [],
    mergedDisabled = workspaceDisabled,
    isTrusted = true,
    executionMode = 'interactive',
    reloadCommands,
    notifyConfigChanged,
  } = opts;

  const skillManager = {
    listSkills: vi.fn().mockResolvedValue(skills),
    notifyConfigChanged:
      notifyConfigChanged ?? vi.fn().mockResolvedValue(undefined),
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
      reloadCommands: reloadCommands ?? vi.fn().mockResolvedValue(undefined),
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
    // dialog rather than emitting a SKILLS_LIST. The list view has been
    // collapsed into the dialog (which has search, sort, toggle).
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

describe('skillsCommand completion', () => {
  it('prepends enable/disable subcommand suggestions on empty partial', async () => {
    if (!skillsCommand.completion) throw new Error('completion missing');
    const context = makeContext({
      skills: [{ name: 'alpha', description: 'a' }],
    });

    const out = await skillsCommand.completion(context, '');

    // Subcommand suggestions appear FIRST so users can discover them.
    // `manage` was removed — bare `/skills` opens the dialog directly.
    expect(out[0].value).toBe('enable');
    expect(out[1].value).toBe('disable');
    // Followed by skills.
    expect(out.some((s) => s.value === 'alpha')).toBe(true);
  });

  it('filters subcommand suggestions to matching prefix', async () => {
    if (!skillsCommand.completion) throw new Error('completion missing');
    const context = makeContext({ skills: [] });

    const out = await skillsCommand.completion(context, 'en');
    const subValues = out
      .map((c) => c.value)
      .filter((v) => ['enable', 'disable'].includes(v));

    expect(subValues).toEqual(['enable']);
  });

  it('does not surface a removed `manage` subcommand in completion', async () => {
    if (!skillsCommand.completion) throw new Error('completion missing');
    const context = makeContext({ skills: [] });

    const out = await skillsCommand.completion(context, '');
    expect(out.some((s) => s.value === 'manage')).toBe(false);
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
    const skillNames = out
      .map((c) => c.value)
      .filter((v) => !['enable', 'disable'].includes(v));

    expect(skillNames).toEqual(['alpha']);
  });

  it('does NOT duplicate a skill named after a subcommand reserved word', async () => {
    // Reserved-name tradeoff: a skill literally named `enable` resolves
    // to the subcommand on `/skills enable`. Completion should still show
    // the subcommand, not list the skill in its place — otherwise users
    // see `enable` twice.
    if (!skillsCommand.completion) throw new Error('completion missing');
    const context = makeContext({
      skills: [{ name: 'enable', description: 'shadowed by subcommand' }],
    });

    const out = await skillsCommand.completion(context, '');
    const enableEntries = out.filter((c) => c.value === 'enable');
    expect(enableEntries).toHaveLength(1);
    expect(enableEntries[0].description).toMatch(/Re-enable/);
  });
});

describe('skillsCommand: /skills disable <name>', () => {
  const disable = () => findSubCommand('disable');

  it('refuses in untrusted workspace with a clear message', async () => {
    const context = makeContext({
      skills: [{ name: 'foo' }],
      isTrusted: false,
    });

    await disable().action!(context, 'foo');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.ERROR,
        text: expect.stringMatching(/untrusted|trust/i),
      },
      expect.any(Number),
    );
    // No write happened.
    expect(context.services.settings!.setValue).not.toHaveBeenCalled();
  });

  it('refuses in ACP mode (no live refresh) and does not write', async () => {
    const context = makeContext({
      skills: [{ name: 'foo' }],
      executionMode: 'acp',
    });

    await disable().action!(context, 'foo');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.ERROR,
        text: expect.stringMatching(/interactive-only|ACP/i),
      },
      expect.any(Number),
    );
    expect(context.services.settings!.setValue).not.toHaveBeenCalled();
  });

  it('rejects unknown skill names', async () => {
    const context = makeContext({ skills: [{ name: 'foo' }] });

    await disable().action!(context, 'bogus');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.ERROR,
        text: expect.stringMatching(/Unknown skill: bogus/),
      },
      expect.any(Number),
    );
  });

  it('appends to workspace skills.disabled and triggers refresh in order', async () => {
    const order: string[] = [];
    const reloadCommands = vi.fn(async () => {
      order.push('reload');
    });
    const notifyConfigChanged = vi.fn(async () => {
      order.push('notify');
    });

    const context = makeContext({
      skills: [{ name: 'foo' }, { name: 'bar' }],
      workspaceDisabled: ['existing'],
      reloadCommands,
      notifyConfigChanged,
    });

    await disable().action!(context, 'foo');

    expect(context.services.settings!.setValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'skills.disabled',
      ['existing', 'foo'],
    );
    // CRITICAL: reloadCommands must complete BEFORE notifyConfigChanged.
    // Promise.all would let SkillTool.refreshSkills read the stale
    // CommandService provider closure, leaking the just-disabled skill
    // back into <available_skills> as a command-form entry.
    expect(order).toEqual(['reload', 'notify']);
  });

  it('is a no-op when the skill is already in workspace.disabled', async () => {
    const context = makeContext({
      skills: [{ name: 'foo' }],
      workspaceDisabled: ['foo'],
      mergedDisabled: ['foo'],
    });

    await disable().action!(context, 'foo');

    expect(context.services.settings!.setValue).not.toHaveBeenCalled();
    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.INFO,
        text: expect.stringMatching(/already disabled/i),
      },
      expect.any(Number),
    );
  });
});

describe('skillsCommand: /skills enable <name>', () => {
  const enable = () => findSubCommand('enable');

  it('refuses in untrusted workspace with a clear message', async () => {
    const context = makeContext({
      skills: [{ name: 'foo' }],
      workspaceDisabled: ['foo'],
      mergedDisabled: ['foo'],
      isTrusted: false,
    });

    await enable().action!(context, 'foo');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.ERROR,
        text: expect.stringMatching(/untrusted|trust/i),
      },
      expect.any(Number),
    );
    expect(context.services.settings!.setValue).not.toHaveBeenCalled();
  });

  it('refuses in ACP mode and does not write', async () => {
    const context = makeContext({
      skills: [{ name: 'foo' }],
      workspaceDisabled: ['foo'],
      mergedDisabled: ['foo'],
      executionMode: 'acp',
    });

    await enable().action!(context, 'foo');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.ERROR,
        text: expect.stringMatching(/interactive-only|ACP/i),
      },
      expect.any(Number),
    );
    expect(context.services.settings!.setValue).not.toHaveBeenCalled();
  });

  it('removes the skill from workspace and triggers refresh in order', async () => {
    const order: string[] = [];
    const reloadCommands = vi.fn(async () => {
      order.push('reload');
    });
    const notifyConfigChanged = vi.fn(async () => {
      order.push('notify');
    });

    // workspace lists 'foo'; merged is empty because we represent the
    // post-write state (in real LoadedSettings, `merged` recomputes after
    // setValue; the mock returns a fixed snapshot, so we set it to the
    // expected post-removal value to exercise the success path).
    const context = makeContext({
      skills: [{ name: 'foo' }, { name: 'bar' }],
      workspaceDisabled: ['foo'],
      mergedDisabled: [],
      reloadCommands,
      notifyConfigChanged,
    });

    await enable().action!(context, 'foo');

    expect(context.services.settings!.setValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'skills.disabled',
      undefined, // empty list collapses to undefined to avoid persisting `[]`
    );
    expect(order).toEqual(['reload', 'notify']);
    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.INFO,
        text: expect.stringMatching(/Enabled/),
      },
      expect.any(Number),
    );
  });

  it('warns when a higher scope still disables the skill (UNION-blocked enable)', async () => {
    // workspace: ['foo'], merged: ['foo'] — but assume user/system also
    // listed it so removal at workspace can't fully enable it.
    const context = makeContext({
      skills: [{ name: 'foo' }],
      workspaceDisabled: ['foo'],
      mergedDisabled: ['foo'], // still disabled even after workspace removal
    });

    // Simulate the merged set still containing 'foo' AFTER setValue (the
    // UNION merge keeps user/system entries). We can't re-derive that
    // through the mock, so we assert that the warning is emitted because
    // mergedDisabled.includes('foo') already.
    await enable().action!(context, 'foo');

    const warnings = vi
      .mocked(context.ui.addItem)
      .mock.calls.filter((c) => c[0].type === MessageType.WARNING);
    expect(warnings).toHaveLength(1);
    expect((warnings[0][0] as { text: string }).text).toMatch(
      /higher scope|systemDefaults|user|system/i,
    );
  });

  it('emits "already enabled" when there is nothing to remove and no higher block', async () => {
    const context = makeContext({
      skills: [{ name: 'foo' }],
      workspaceDisabled: [],
      mergedDisabled: [],
    });

    await enable().action!(context, 'foo');

    expect(context.services.settings!.setValue).not.toHaveBeenCalled();
    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.INFO,
        text: expect.stringMatching(/already enabled/i),
      },
      expect.any(Number),
    );
  });
});

describe('skillsCommand: subcommand surface', () => {
  it('exposes only enable + disable as subcommands (manage was removed)', () => {
    const names = (skillsCommand.subCommands ?? []).map((c) => c.name).sort();
    expect(names).toEqual(['disable', 'enable']);
  });
});
