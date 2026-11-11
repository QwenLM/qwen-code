/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SkillCommandLoader } from './SkillCommandLoader.js';
import { CommandKind } from '../ui/commands/types.js';
import {
  activateInlineSkill,
  executeForkedSkillDirect,
} from '@qwen-code/core';

// Mock activateInlineSkill and executeForkedSkillDirect
vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    activateInlineSkill: vi.fn(),
    executeForkedSkillDirect: vi.fn(),
  };
});

const mockActivateInline = vi.mocked(activateInlineSkill);
const mockExecuteForked = vi.mocked(executeForkedSkillDirect);

describe('SkillCommandLoader', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockConfig: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockSkillManager: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockContext: any;

  beforeEach(() => {
    mockSkillManager = {
      getDisplayableSkills: vi.fn(),
      isAdminEnabled: vi.fn().mockReturnValue(true),
      getSkill: vi.fn().mockReturnValue(undefined),
    };

    mockConfig = {
      isSkillsSupportEnabled: vi.fn().mockReturnValue(true),
      getSkillManager: vi.fn().mockReturnValue(mockSkillManager),
    };

    mockContext = {
      ui: {
        addItem: vi.fn(),
      },
    };

    mockActivateInline.mockReset();
    mockExecuteForked.mockReset();
  });

  it('should return an empty array if skills support is disabled', async () => {
    mockConfig.isSkillsSupportEnabled.mockReturnValue(false);
    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);
    expect(commands).toEqual([]);
  });

  it('should return an empty array if SkillManager is missing', async () => {
    mockConfig.getSkillManager.mockReturnValue(null);
    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);
    expect(commands).toEqual([]);
  });

  it('should return an empty array if skills are admin-disabled', async () => {
    mockSkillManager.isAdminEnabled.mockReturnValue(false);
    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);
    expect(commands).toEqual([]);
  });

  it('should load skills as slash commands', async () => {
    const mockSkills = [
      { name: 'skill1', description: 'Description 1' },
      { name: 'skill2', description: '' },
    ];
    mockSkillManager.getDisplayableSkills.mockReturnValue(mockSkills);

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    expect(commands).toHaveLength(2);

    expect(commands[0]).toMatchObject({
      name: 'skill1',
      description: 'Description 1',
      kind: CommandKind.SKILL,
      autoExecute: true,
    });

    expect(commands[1]).toMatchObject({
      name: 'skill2',
      description: 'Activate the skill2 skill',
      kind: CommandKind.SKILL,
      autoExecute: true,
    });
  });

  it('should execute fork skills directly and return local_command_result', async () => {
    const forkSkillDef = { context: 'fork', name: 'test-skill' };
    const mockSkills = [{ name: 'test-skill', description: 'Test skill' }];
    mockSkillManager.getDisplayableSkills.mockReturnValue(mockSkills);
    mockSkillManager.getSkill.mockReturnValue(forkSkillDef);
    mockExecuteForked.mockResolvedValue('Fork skill output text');

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    const actionResult = await commands[0].action!(mockContext, '');
    expect(actionResult).toEqual({
      type: 'local_command_result',
      text: 'Fork skill output text',
    });
    expect(mockExecuteForked).toHaveBeenCalledWith(
      mockConfig,
      forkSkillDef,
      undefined,
      expect.any(AbortSignal),
    );
  });

  it('should pass args to executeForkedSkillDirect for fork skills', async () => {
    const forkSkillDef = { context: 'fork', name: 'test-skill' };
    const mockSkills = [{ name: 'test-skill', description: 'Test skill' }];
    mockSkillManager.getDisplayableSkills.mockReturnValue(mockSkills);
    mockSkillManager.getSkill.mockReturnValue(forkSkillDef);
    mockExecuteForked.mockResolvedValue('Result with args');

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    const actionResult = await commands[0].action!(mockContext, 'hello world');
    expect(actionResult).toEqual({
      type: 'local_command_result',
      text: 'Result with args',
    });
    expect(mockExecuteForked).toHaveBeenCalledWith(
      mockConfig,
      forkSkillDef,
      'hello world',
      expect.any(AbortSignal),
    );
  });

  it('should return submit_prompt for inline skills and show info message', async () => {
    const mockSkills = [{ name: 'inline-skill', description: 'Inline skill' }];
    mockSkillManager.getDisplayableSkills.mockReturnValue(mockSkills);
    // getSkill returns undefined (not fork) → inline path
    mockSkillManager.getSkill.mockReturnValue(undefined);

    mockActivateInline.mockResolvedValue({
      ok: true,
      result: {
        metadataContent: '<command-name>/inline-skill</command-name>',
        userMessageContent: 'skill instructions here',
        skillBodyContent: 'skill instructions here',
        llmContent: 'Skill activated.',
        returnDisplay: 'Skill **inline-skill** activated.',
        isMeta: true,
        skillOverrides: undefined,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    const actionResult = await commands[0].action!(mockContext, '');
    expect(actionResult).toEqual({
      type: 'submit_prompt',
      content: 'skill instructions here',
      isMeta: true,
      skillActivation: {
        skillName: 'inline-skill',
        activationSource: 'slash_command',
      },
    });

    // Verify the info message was shown in TUI
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      { type: 'info', text: 'Skill **inline-skill** activated.' },
      expect.any(Number),
    );
  });

  it('should return error message when inline skill activation fails', async () => {
    const mockSkills = [{ name: 'bad-skill', description: 'Bad skill' }];
    mockSkillManager.getDisplayableSkills.mockReturnValue(mockSkills);
    mockSkillManager.getSkill.mockReturnValue(undefined);

    mockActivateInline.mockResolvedValue({
      ok: false,
      error: {
        errorMessage: 'Skill not found',
        errorType: 'INVALID_TOOL_PARAMS',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    const actionResult = await commands[0].action!(mockContext, '');
    expect(actionResult).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Skill not found',
    });

    // No info item shown on error
    expect(mockContext.ui.addItem).not.toHaveBeenCalled();
  });

  it('should pass skill.name verbatim without sanitization', async () => {
    const forkSkillDef = {
      context: 'fork',
      name: 'my awesome skill',
    };
    const mockSkills = [{ name: 'my awesome skill', description: 'Desc' }];
    mockSkillManager.getDisplayableSkills.mockReturnValue(mockSkills);
    mockSkillManager.getSkill.mockReturnValue(forkSkillDef);
    mockExecuteForked.mockResolvedValue('output');

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    expect(commands[0].name).toBe('my awesome skill');

    await commands[0].action!(mockContext, '');
    // Fork skills are now executed directly, not via tool action
    expect(mockExecuteForked).toHaveBeenCalled();
  });

  it('should propagate pluginName to the generated slash command', async () => {
    const mockSkills = [
      { name: 'skill1', description: 'desc', pluginName: 'ext1' },
    ];
    mockSkillManager.getDisplayableSkills.mockReturnValue(mockSkills);

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    expect(commands[0].pluginName).toBe('ext1');
  });

  it('propagates allowedTools / model / effort from the SkillDefinition on /skill-name inline activation', async () => {
    const mockSkills = [
      { name: 'guarded-skill', description: 'Skill with allow-list' },
    ];
    mockSkillManager.getDisplayableSkills.mockReturnValue(mockSkills);
    mockSkillManager.getSkill.mockReturnValue({
      name: 'guarded-skill',
      allowedTools: ['Edit', 'Write'],
      model: 'gpt-mini',
      effort: 'high',
    });

    mockActivateInline.mockResolvedValue({
      ok: true,
      result: {
        metadataContent: '<command-name>/guarded-skill</command-name>',
        userMessageContent: 'body',
        skillBodyContent: 'body',
        llmContent: 'Skill activated.',
        returnDisplay: 'Skill **guarded-skill** activated.',
        isMeta: true,
        skillOverrides: undefined,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    const actionResult = (await commands[0].action!(mockContext, '')) as {
      type: string;
      allowedTools?: string[];
      model?: string;
      effort?: string;
    };
    expect(actionResult.type).toBe('submit_prompt');
    expect(actionResult.allowedTools).toEqual(['Edit', 'Write']);
    expect(actionResult.model).toBe('gpt-mini');
    expect(actionResult.effort).toBe('high');
  });

  it('emits CommandKind.PLUGIN when the skill carries kind: "plugin-command"', async () => {
    const mockSkills = [
      { name: 'demo:cmd', description: 'fork cmd', kind: 'plugin-command' },
      { name: 'my-skill', description: 'regular' },
    ];
    mockSkillManager.getDisplayableSkills.mockReturnValue(mockSkills);

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    expect(commands[0]).toMatchObject({
      name: 'demo:cmd',
      kind: CommandKind.PLUGIN,
    });
    expect(commands[1]).toMatchObject({
      name: 'my-skill',
      kind: CommandKind.SKILL,
    });
  });

  it('routes plugin-command + fork-context through executeForkedSkillDirect with CommandKind.PLUGIN', async () => {
    const forkPluginCmd = {
      name: 'demo:cmd',
      description: 'fork plugin command',
      kind: 'plugin-command',
      context: 'fork',
    };
    mockSkillManager.getDisplayableSkills.mockReturnValue([forkPluginCmd]);
    mockSkillManager.getSkill.mockReturnValue(forkPluginCmd);
    mockExecuteForked.mockResolvedValue('plugin fork output');

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    // UI surface: CommandKind.PLUGIN (driven by `kind`).
    expect(commands[0]).toMatchObject({
      name: 'demo:cmd',
      kind: CommandKind.PLUGIN,
    });

    // Execution surface: fork-context routes through executeForkedSkillDirect.
    const actionResult = await commands[0].action!(mockContext, 'arg1');
    expect(actionResult).toEqual({
      type: 'local_command_result',
      text: 'plugin fork output',
    });
    expect(mockExecuteForked).toHaveBeenCalledWith(
      mockConfig,
      forkPluginCmd,
      'arg1',
      expect.any(AbortSignal),
    );
  });
});
