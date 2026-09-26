/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AgentCore,
  buildInheritedForkExecutionToolNames,
} from './agent-core.js';
import { getCurrentAgentConfiguredToolAllowlist } from './agent-context.js';
import type { ToolConfig } from './agent-types.js';
import { makeFakeConfig } from '../../test-utils/config.js';
import { MockTool } from '../../test-utils/mock-tool.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { ExecTool } from '../../tools/exec.js';
import { ToolMode } from '../../tools/code-mode.js';

describe('fork MCP policy inheritance', () => {
  it.each([ToolMode.CodeMode, ToolMode.CodeModeOnly])(
    'does not turn the %s exec wrapper into an inherited grant',
    async (mode) => {
      const config = makeFakeConfig({ toolMode: mode });
      const registry = new ToolRegistry(config);
      vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
      registry.registerTool(new ExecTool(config));
      registry.registerTool(new MockTool({ name: 'read_file' }));
      registry.registerTool(new MockTool({ name: 'write_file' }));
      for (const separate of [false, true]) {
        let tools: ToolConfig = {
          tools: ['read_file'],
          ...(separate ? { executionAllowedTools: ['read_file'] } : {}),
        };
        for (let generation = 0; generation < 3; generation++) {
          const core = new AgentCore(
            'fork',
            config,
            { systemPrompt: '' },
            { model: 'test' },
            { max_turns: 1 },
            tools,
          );
          const declarations = await core.prepareTools();
          const exec = declarations.find((d) => d.name === 'exec')!;
          expect(exec.description).toContain('read_file');
          expect(exec.description).not.toContain('write_file');
          let frame: readonly string[] | undefined;
          await core.runInAgentFrames(async () => {
            frame = getCurrentAgentConfiguredToolAllowlist();
          });
          const inherited = buildInheritedForkExecutionToolNames(
            declarations.map((d) => d.name!),
            registry.getAllToolNames(),
            frame,
          );
          expect(inherited).toEqual(['read_file']);
          tools = {
            tools: declarations.map((d) => d.name!),
            executionAllowedTools: inherited,
          };
        }
      }
    },
  );

  it.each([
    [ToolMode.CodeMode, false],
    [ToolMode.CodeMode, true],
    [ToolMode.CodeModeOnly, false],
    [ToolMode.CodeModeOnly, true],
  ] as const)(
    'keeps %s restrictions with execution list=%s across generations',
    async (mode, separate) => {
      const config = makeFakeConfig({ toolMode: mode });
      const registry = new ToolRegistry(config);
      vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
      registry.registerTool(new ExecTool(config));
      for (const [serverName, serverToolName] of [
        ['github', 'read_file'],
        ['github', 'create_issue'],
        ['payments', 'charge'],
      ]) {
        registry.registerTool(
          Object.assign(
            new MockTool({
              name: `mcp__${serverName}__${serverToolName}`,
            }),
            { serverName, serverToolName },
          ),
        );
      }
      for (const pattern of ['mcp__github__read_*', 'mcp__offline__read_*']) {
        let tools: ToolConfig = {
          tools: ['exec', pattern],
          ...(separate ? { executionAllowedTools: ['exec', pattern] } : {}),
        };
        for (let generation = 0; generation < 3; generation++) {
          const core = new AgentCore(
            'fork',
            config,
            { systemPrompt: '' },
            { model: 'test' },
            { max_turns: 1 },
            tools,
          );
          const declarations = await core.prepareTools();
          const exec = declarations.find((d) => d.name === 'exec')!;
          expect(exec.description).not.toContain('mcp__payments__charge');
          expect(exec.description).not.toContain('mcp__github__create_issue');
          if (pattern.includes('github')) {
            expect(exec.description).toContain('mcp__github__read_file');
          }
          let frame: readonly string[] | undefined;
          await core.runInAgentFrames(async () => {
            frame = getCurrentAgentConfiguredToolAllowlist();
          });
          const inherited = buildInheritedForkExecutionToolNames(
            declarations.map((d) => d.name!),
            registry.getAllToolNames(),
            frame,
          );
          expect(inherited).not.toContain(pattern);
          expect(inherited).not.toContain('exec');
          expect(inherited).not.toContain('mcp__payments__charge');
          if (pattern.includes('github'))
            expect(inherited).toContain('mcp__github__read_file');
          tools = {
            tools: declarations.map((d) => d.name!),
            executionAllowedTools: inherited,
          };
        }
      }
    },
  );
});
