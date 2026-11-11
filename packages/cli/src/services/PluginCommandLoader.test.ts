/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PluginCommandLoader } from './PluginCommandLoader.js';
import {
  loadAllPluginCommands,
  type PluginCommandDefinition,
} from '@qwen-code/core';

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    loadAllPluginCommands: vi.fn(),
  };
});

const mockLoadAll = vi.mocked(loadAllPluginCommands);

function makeDef(
  overrides: Partial<PluginCommandDefinition> = {},
): PluginCommandDefinition {
  return {
    name: 'demo:cmd',
    description: 'demo',
    content: 'Read ${QWEN_PLUGIN_ROOT}/data.json and ${CLAUDE_PLUGIN_ROOT}/x',
    context: 'inline',
    pluginName: 'demo',
    pluginSource: 'local',
    pluginRoot: '/plugins/demo',
    pluginId: 'demo@local',
    ...overrides,
  };
}

describe('PluginCommandLoader', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockConfig: any;

  beforeEach(() => {
    mockLoadAll.mockReset();
    mockConfig = {
      getEnabledPlugins: vi.fn().mockReturnValue([{ name: 'demo' }]),
      getModel: vi.fn().mockReturnValue('test-model'),
      getSessionId: vi.fn().mockReturnValue(''),
      getSkillManager: vi.fn(() => ({ getSkill: () => null })),
    };
  });

  it('defers a colliding inline plugin command to the selected Workflow Skill', async () => {
    mockLoadAll.mockReturnValue([makeDef(), makeDef({ name: 'demo:other' })]);
    mockConfig.getSkillManager = () => ({ getSkill: (name: string) => name === 'demo:cmd' ? { workflow: { name } } : null });
    const commands = await new PluginCommandLoader(mockConfig).loadCommands(new AbortController().signal);
    expect(commands.map(command => command.name)).toEqual(['demo:other']);
  });

  it('substitutes plugin path vars in inline command content', async () => {
    mockLoadAll.mockReturnValue([makeDef()]);
    const loader = new PluginCommandLoader(mockConfig);
    const [cmd] = await loader.loadCommands(new AbortController().signal);

    const result = await cmd.action!({} as never, '');
    expect(result).toEqual({
      type: 'submit_prompt',
      content: 'Read /plugins/demo/data.json and /plugins/demo/x',
      isMeta: true,
    });
  });

  it('appends "ARGUMENTS: ..." when inline content lacks placeholders', async () => {
    mockLoadAll.mockReturnValue([makeDef()]);
    const loader = new PluginCommandLoader(mockConfig);
    const [cmd] = await loader.loadCommands(new AbortController().signal);

    const result = (await cmd.action!({} as never, 'hello')) as {
      type: string;
      content: string;
    };
    expect(result.content).toBe(
      'Read /plugins/demo/data.json and /plugins/demo/x\n\nARGUMENTS: hello',
    );
  });

  it('filters out fork-context commands (delegated to SkillCommandLoader)', async () => {
    mockLoadAll.mockReturnValue([
      makeDef({ name: 'demo:inline' }),
      makeDef({ name: 'demo:forked', context: 'fork' }),
    ]);
    const loader = new PluginCommandLoader(mockConfig);
    const cmds = await loader.loadCommands(new AbortController().signal);
    expect(cmds.map((c) => c.name)).toEqual(['demo:inline']);
  });

  it('propagates allowedTools / model / effort on the inline submit_prompt result', async () => {
    mockLoadAll.mockReturnValue([
      makeDef({
        content: 'do stuff',
        allowedTools: ['Edit', 'Write'],
        model: 'gpt-mini',
        effort: 'high',
      }),
    ]);
    const loader = new PluginCommandLoader(mockConfig);
    const [cmd] = await loader.loadCommands(new AbortController().signal);

    const result = (await cmd.action!({} as never, '')) as {
      type: string;
      content: string;
      isMeta?: boolean;
      allowedTools?: string[];
      model?: string;
      effort?: string;
    };

    expect(result.type).toBe('submit_prompt');
    expect(result.isMeta).toBe(true);
    expect(result.allowedTools).toEqual(['Edit', 'Write']);
    expect(result.model).toBe('gpt-mini');
    expect(result.effort).toBe('high');
  });

  it('substitutes $ARGUMENTS and named args at invocation time', async () => {
    mockLoadAll.mockReturnValue([
      makeDef({
        content: 'Hello $who, your role is $role ($ARGUMENTS)',
        argNames: ['who', 'role'],
      }),
    ]);
    const loader = new PluginCommandLoader(mockConfig);
    const [cmd] = await loader.loadCommands(new AbortController().signal);

    const result = (await cmd.action!({} as never, 'alice admin')) as {
      content: string;
    };

    expect(result.content).toBe('Hello alice, your role is admin (alice admin)');
  });

  it('replaces ${QWEN_SESSION_ID} and ${CLAUDE_SESSION_ID} at invocation time', async () => {
    mockConfig.getSessionId = vi.fn().mockReturnValue('sess-42');
    mockLoadAll.mockReturnValue([
      makeDef({
        content:
          'Q=${QWEN_SESSION_ID} C=${CLAUDE_SESSION_ID}',
      }),
    ]);
    const loader = new PluginCommandLoader(mockConfig);
    const [cmd] = await loader.loadCommands(new AbortController().signal);

    const result = (await cmd.action!({} as never, '')) as { content: string };
    expect(result.content).toBe('Q=sess-42 C=sess-42');
  });

  it('hides commands flagged user-invocable: false', async () => {
    mockLoadAll.mockReturnValue([
      makeDef({ name: 'demo:visible' }),
      makeDef({ name: 'demo:hidden', userInvocable: false }),
    ]);
    const loader = new PluginCommandLoader(mockConfig);
    const cmds = await loader.loadCommands(new AbortController().signal);
    expect(cmds.map((c) => c.name)).toEqual(['demo:visible']);
  });
});
