/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { ToolConfig } from '../agents/runtime/agent-types.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { PermissionManager } from '../permissions/permission-manager.js';
import { SubagentManager } from './subagent-manager.js';
import { AgentHeadless } from '../agents/runtime/agent-headless.js';
import { AgentCore } from '../agents/runtime/agent-core.js';
import { resolveAgentDelegationSurface } from '../skills/agent-delegation-skill.js';
import { ToolMode } from '../tools/code-mode.js';

describe('nested agents retain their actual Skill availability', () => {
  it.each([
    { mode: ToolMode.CodeMode, visible: false },
    { mode: ToolMode.CodeMode, visible: true },
    { mode: ToolMode.CodeModeOnly, visible: false },
  ])(
    'preserves Skill policy in $mode visible=$visible',
    async ({ mode, visible }) => {
      const config = makeFakeConfig({
        targetDir: process.cwd(),
        cwd: process.cwd(),
        toolMode: mode,
        eagerTools: ['exec', 'agent', ...(visible ? ['skill'] : [])],
        coreTools: ['exec', 'agent', 'skill', 'tool_search', 'tool_call'],
      });
      const skills = {
        addChangeListener: () => () => {},
        listSkills: async () => [],
        getCachedSkills: () => [],
        hasDiscoveryErrors: () => false,
        isSkillActive: () => true,
      };
      const permissions = new PermissionManager(config);
      permissions.initialize();
      vi.spyOn(config, 'getPermissionManager').mockReturnValue(permissions);
      vi.spyOn(config, 'getSkillManager').mockReturnValue(skills as never);
      const manager = new SubagentManager(config);
      vi.spyOn(manager, 'listSubagents').mockResolvedValue([]);
      vi.spyOn(config, 'getSubagentManager').mockReturnValue(manager);
      const rootRegistry = await config.createToolRegistry(undefined, {
        skipDiscovery: true,
      });
      vi.spyOn(config, 'getToolRegistry').mockReturnValue(rootRegistry);

      let capture:
        | { context: Config; tools: ToolConfig | undefined }
        | undefined;
      const createSpy = vi
        .spyOn(AgentHeadless, 'create')
        .mockImplementation(
          async (_name, context, _prompt, _model, _run, tools) => {
            capture = { context, tools };
            return {
              getCore: () => ({ subagentId: 'skill-eager-review' }),
            } as unknown as AgentHeadless;
          },
        );
      const handles: Array<{ dispose(): Promise<void> }> = [];
      let parent = config;
      const expected = mode === ToolMode.CodeModeOnly || visible;
      try {
        for (let depth = 1; depth <= 3; depth++) {
          handles.push(
            await manager.createAgentHeadless(
              {
                name: `skill-eager-review-${depth}`,
                description: 'Isolated nested Skill test',
                systemPrompt: 'Inspect Skill availability only.',
                level: 'session',
                ...(depth === 2 ? { tools: ['exec', 'agent'] } : {}),
              },
              parent,
            ),
          );
          expect(capture).toBeDefined();
          const { context, tools } = capture!;
          const core = new AgentCore(
            'skill-eager-review',
            context,
            { systemPrompt: 'Inspect Skill availability only.' },
            { model: 'test-model' },
            { max_turns: 1 },
            tools,
          );
          const observed = core as unknown as {
            willHaveSkillTool(): boolean;
            canInvokeSkill(names: ReadonlySet<string | undefined>): boolean;
          };
          const announced = observed.willHaveSkillTool();
          const declared = new Set(
            (await core.prepareTools()).map((declaration) => declaration.name),
          );
          expect
            .soft(!!context.getSkillManager(), `depth ${depth}`)
            .toBe(expected);
          expect
            .soft(announced, `announcement at depth ${depth}`)
            .toBe(expected);
          expect
            .soft(
              observed.canInvokeSkill(declared),
              `invocation at depth ${depth}`,
            )
            .toBe(expected);
          if (!expected) {
            expect
              .soft(
                resolveAgentDelegationSurface(context),
                `pointer at depth ${depth}`,
              )
              .toBe('inline');
          }
          parent = context;
        }
      } finally {
        createSpy.mockRestore();
        for (const handle of handles.reverse()) await handle.dispose();
        await rootRegistry.stop();
        vi.restoreAllMocks();
      }
    },
  );
});
