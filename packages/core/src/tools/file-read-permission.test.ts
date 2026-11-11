/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import type { PermissionMode } from '../permissions/manager/decision/index.js';
import { createPermissionManager } from '../test-utils/config.js';
import type { Config } from '../config/config.js';
import type { ToolUseContext } from './tool-types.js';
import { constrainAgentPermissions } from '../permissions/agent-tool-constraints.js';
import { canReadFileWithoutPrompt } from './file-read-permission.js';

function setup(mode: PermissionMode = 'default') {
  const ask = vi.fn(async () => ({ kind: 'approved' as const }));
  const permission: ReturnType<typeof createPermissionManager> = createPermissionManager({
    checkerDeps: {
      skill: {
        isAllowedForMainSession: () => true,
        isDisabled: () => false,
        hasOnlySafeProperties: () => false,
      },
      mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
    },
    cwd: '/workspace',
    permissionMode: mode,
    rules: { allow: {}, deny: {}, ask: {} },
    additionalDirectories: [],
    askHandler: ask,
  });
  const config = { permission, getTargetDir: () => '/workspace' } as Config;
  const agent = {
    permission,
    toolRegistry: { getTool: () => ({ name: 'Read' }) },
  };
  const context = {
    agentLoopContext: agent,
    signal: new AbortController().signal,
  } as unknown as ToolUseContext;
  return { permission, config, agent, context, ask };
}

describe('non-interactive Read permission probe', () => {
  it('keeps agent disallowedTools even when the shared config allows Read', async () => {
    const { permission, config, agent, context, ask } = setup();
    expect(await canReadFileWithoutPrompt(config, '/workspace/file')).toBe(
      true,
    );
    agent.permission = constrainAgentPermissions(permission, ['Read']);
    expect(
      await canReadFileWithoutPrompt(config, '/workspace/file', context),
    ).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it('applies per-agent rule overrides and does not call their ask handler', async () => {
    const { config, context, ask } = setup();
    const overridden = {
      ...context,
      agentLoopContext: {
        ...context.agentLoopContext,
        permissionContext: () => ({
          rules: { allow: {}, deny: {}, ask: { session: ['Read'] } },
          canPrompt: false,
        }),
      },
    } as unknown as ToolUseContext;
    expect(
      await canReadFileWithoutPrompt(config, '/workspace/file', overridden),
    ).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it('uses skill read grants without mutating global rules', async () => {
    const { config, permission, context } = setup();
    const withSkill = {
      ...context,
      skillPermissionOverlay: { allowedToolPatterns: ['Read(//outside/**)'] },
    };
    expect(
      await canReadFileWithoutPrompt(config, '/outside/file', withSkill),
    ).toBe(true);
    expect(permission.getRules().allow).toEqual({});
  });

  it.each(['deny', 'ask'] as const)(
    'merges agent and skill grants while retaining agent %s rules',
    async (behavior) => {
      const { config, permission, context, ask } = setup();
      const combined = {
        ...context,
        agentLoopContext: {
          ...context.agentLoopContext,
          permissionContext: () => ({
            additionalRules: {
              allow: { session: ['Read(//agent/**)'] },
              deny: {},
              ask: {},
              [behavior]: { session: ['Read(//skill/blocked)'] },
            },
          }),
        },
        skillPermissionOverlay: { allowedToolPatterns: ['Read(//skill/**)'] },
      } as unknown as ToolUseContext;

      expect(
        await canReadFileWithoutPrompt(config, '/agent/file', combined),
      ).toBe(true);
      expect(
        await canReadFileWithoutPrompt(config, '/skill/file', combined),
      ).toBe(true);
      expect(
        await canReadFileWithoutPrompt(config, '/skill/blocked', combined),
      ).toBe(false);
      expect(permission.getRules()).toEqual({ allow: {}, deny: {}, ask: {} });
      expect(ask).not.toHaveBeenCalled();
    },
  );

  it.each(['deny', 'ask'] as const)(
    'preserves explicit %s in yolo mode',
    async (behavior) => {
      const { permission, config, ask } = setup('yolo');
      permission.setRules({
        allow: {},
        deny: {},
        ask: {},
        [behavior]: { session: ['Read'] },
      });
      expect(await canReadFileWithoutPrompt(config, '/workspace/file')).toBe(
        false,
      );
      expect(ask).not.toHaveBeenCalled();
    },
  );

  it('allows an otherwise ungranted path only in yolo mode without prompting', async () => {
    const { config, ask } = setup('yolo');
    expect(await canReadFileWithoutPrompt(config, '/outside/file')).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    const normal = setup();
    expect(await canReadFileWithoutPrompt(normal.config, '/outside/file')).toBe(
      false,
    );
    expect(normal.ask).not.toHaveBeenCalled();
  });

  it('fails closed when the active context has no permission or Read tool', async () => {
    const { config, context } = setup();
    for (const agent of [
      { ...context.agentLoopContext, permission: undefined },
      {
        ...context.agentLoopContext,
        toolRegistry: { getTool: () => undefined },
      },
    ]) {
      expect(
        await canReadFileWithoutPrompt(config, '/workspace/file', {
          ...context,
          agentLoopContext: agent,
        } as unknown as ToolUseContext),
      ).toBe(false);
    }
  });
});
