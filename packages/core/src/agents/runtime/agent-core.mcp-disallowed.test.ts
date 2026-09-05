/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionDeclaration } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../config/config.js';
import { AgentCore } from './agent-core.js';
import type { ToolConfig } from './agent-types.js';

const REGISTERED_NAME = 'mcp__foo_bar__evil_1oxrpi0';

function buildCore(disallowedTools: string[]): AgentCore {
  const declaration = {
    name: REGISTERED_NAME,
    description: 'collision regression tool',
  } as FunctionDeclaration;
  const toolRegistry = {
    warmAll: vi.fn().mockResolvedValue(undefined),
    getFunctionDeclarations: vi.fn().mockReturnValue([declaration]),
    isPermissionDeferred: vi.fn().mockReturnValue(false),
    isDeferredAndHidden: vi.fn().mockReturnValue(false),
    getTool: vi.fn().mockImplementation((name: string) =>
      name === REGISTERED_NAME
        ? { serverName: 'foo.bar', serverToolName: 'evil' }
        : undefined,
    ),
  };
  const config = {
    getToolRegistry: vi.fn().mockReturnValue(toolRegistry),
    getMaxSubagentDepth: vi.fn().mockReturnValue(1),
    getDebugLogger: vi.fn().mockReturnValue({ debug: vi.fn() }),
  } as unknown as Config;

  return new AgentCore(
    'mcp-disallowed-test',
    config,
    { systemPrompt: '' },
    { model: 'test-model' },
    { max_turns: 1 },
    { tools: ['*'], disallowedTools } as ToolConfig,
  );
}

describe('AgentCore.prepareTools MCP disallowedTools', () => {
  it.each(['mcp__foo.bar', 'mcp__foo.bar__*'])(
    'blocks the raw MCP spelling %s',
    async (pattern) => {
      const tools = await buildCore([pattern]).prepareTools();
      expect(tools.map((tool) => tool.name)).not.toContain(REGISTERED_NAME);
    },
  );

  it.each(['mcp__foo_bar', 'mcp__foo_bar__*'])(
    'also blocks the provider-safe spelling %s',
    async (pattern) => {
      const tools = await buildCore([pattern]).prepareTools();
      expect(tools.map((tool) => tool.name)).not.toContain(REGISTERED_NAME);
    },
  );

  it('does not block an unrelated provider-safe server spelling', async () => {
    const tools = await buildCore(['mcp__other_server__*']).prepareTools();
    expect(tools.map((tool) => tool.name)).toContain(REGISTERED_NAME);
  });
});
