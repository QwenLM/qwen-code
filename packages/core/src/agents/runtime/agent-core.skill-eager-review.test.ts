/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { AgentCore } from './agent-core.js';
import { makeFakeConfig } from '../../test-utils/config.js';
import { MockTool } from '../../test-utils/mock-tool.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { ToolNames } from '../../tools/tool-names.js';
import { ToolMode } from '../../tools/code-mode.js';
import { ExecTool } from '../../tools/exec.js';

describe('Skill announcement for eager-hidden subagent tools', () => {
  it.each(
    [ToolMode.CodeMode, ToolMode.CodeModeOnly].flatMap((mode) =>
      [false, true].flatMap((warm) =>
        ['hidden', 'visible', 'revealed'].flatMap((visibility) =>
          [false, true].flatMap((copyRegistry) =>
            [['*'], [ToolNames.SKILL], [ToolNames.EXEC]].map((tools) => ({
              mode,
              warm,
              visibility,
              copyRegistry,
              tools,
            })),
          ),
        ),
      ),
    ),
  )(
    'matches invocation for $mode tools=$tools warm=$warm visibility=$visibility copied=$copyRegistry',
    async ({ mode, warm, visibility, copyRegistry, tools }) => {
      const config = makeFakeConfig({ toolMode: mode });
      const makeRegistry = () => {
        const registry = new ToolRegistry(config);
        registry.registerTool(new ExecTool(config));
        registry.registerPermissionDeferredFactory(
          ToolNames.SKILL,
          async () => new MockTool({ name: ToolNames.SKILL }),
        );
        return registry;
      };
      let registry = makeRegistry();
      vi.spyOn(config, 'getToolRegistry').mockImplementation(() => registry);
      if (warm || visibility === 'revealed') {
        await registry.ensureTool(ToolNames.SKILL);
      }
      if (visibility === 'visible') {
        vi.spyOn(config, 'getVisibleTools').mockReturnValue(
          new Set([ToolNames.SKILL]),
        );
      } else if (visibility === 'revealed') {
        registry.revealDeferredTool(ToolNames.SKILL);
      }
      if (copyRegistry) {
        const childRegistry = makeRegistry();
        childRegistry.copyDiscoveredToolsFrom(registry);
        registry = childRegistry;
      }
      const core = new AgentCore(
        'skill-eager-review',
        config,
        { systemPrompt: '' },
        { model: 'test-model' },
        { max_turns: 1 },
        { tools },
      );
      const observed = core as unknown as {
        willHaveSkillTool(): boolean;
        canInvokeSkill(names: ReadonlySet<string | undefined>): boolean;
      };
      const announced = observed.willHaveSkillTool();
      const declared = new Set(
        (await core.prepareTools()).map((declaration) => declaration.name),
      );
      const invokable = observed.canInvokeSkill(declared);
      const expected =
        mode === ToolMode.CodeModeOnly ||
        visibility === 'visible' ||
        (visibility === 'revealed' && !copyRegistry);

      expect.soft(invokable).toBe(expected);
      expect.soft(announced).toBe(expected);
      expect(announced).toBe(invokable);
    },
  );
});
