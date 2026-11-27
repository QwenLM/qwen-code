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
  it(
    'reports each inline expansion through ordinary post hooks without changing the prompt',
    async () => {
      mockLoadAll.mockReturnValue([makeDef({ content: 'receipt $ARGUMENTS' })]);
      const post = vi.fn(async () => {});
      mockConfig.getHookSystem = () => ({ firePostToolUseEvent: post });
      const [cmd] = await new PluginCommandLoader(mockConfig).loadCommands(
        new AbortController().signal);
      for (let i = 0; i < 2; i++) {
        expect(await cmd.action!(
          {} as never,
          'ok'
        )).toEqual({
          type: 'submit_prompt',
          content: 'receipt ok',
          isMeta: true
        });
      }
      expect(post).toHaveBeenCalledTimes(2);
      const calls = post.mock.calls as unknown[][];
      expect(calls[0][3]).not.toBe(calls[1][3]);
      expect(calls[0][11]).toMatchObject({
        extensionExecution: {
          kind: 'plugin',
          name: 'demo',
          status: 'success'
        }
      });
      expect(calls[0][11]).not.toHaveProperty('pluginCommand');
    }
  );

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

  it.each([undefined, 'KNOWN_CODE'])(
    'preserves the original expansion error while reporting explicit code (%s)',
    async (code) => {
      const originalError = Object.assign(
        new Error('expand failed'),
        {
          code,
          errorType: 'expansion_error'
        }
      );
      const def = makeDef();
      Object.defineProperty(
        def,
        'content',
        {
          get: () => {
            throw originalError;
          }
        }
      );
      mockLoadAll.mockReturnValue([def]);
      const failure = vi.fn(async (..._args: unknown[]) => {});
      mockConfig.getHookSystem = () => ({
        firePostToolUseFailureEvent: failure
      });
      const [cmd] = await new PluginCommandLoader(mockConfig).loadCommands(
        new AbortController().signal);
      await expect(cmd.action!(
        {} as never,
        ''
      )).rejects.toBe(originalError);
      expect(failure).toHaveBeenCalledOnce();
      const attribution = failure.mock.calls[0][12] as {
        extensionExecution: { name: string; errorCode?: string }
      };
      expect(attribution.extensionExecution.name).toBe('demo');
      expect(attribution.extensionExecution.errorCode).toBe(code);
    }
  );

  it(
    'returns the original prompt when post hook dispatch throws',
    async () => {
      mockLoadAll.mockReturnValue([makeDef({ content: 'receipt' })]);
      mockConfig.getHookSystem = () => ({
        firePostToolUseEvent: async () => {
          throw new Error('metrics unavailable');
        }
      });
      const [cmd] = await new PluginCommandLoader(mockConfig).loadCommands(
        new AbortController().signal);
      await expect(cmd.action!(
        {} as never,
        ''
      )).resolves.toMatchObject({
        type: 'submit_prompt',
        content: 'receipt'
      });
    }
  );

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
