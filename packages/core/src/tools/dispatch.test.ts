/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConfigParameters } from '../config/config.js';
import { Config, ApprovalMode } from '../config/config.js';
import { ToolRegistry } from './tool-registry.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { DispatchTool } from './dispatch.js';
import type { ToolResult } from './tools.js';

const baseConfigParams: ConfigParameters = {
  cwd: '/tmp',
  model: 'test-model',
  embeddingModel: 'test-embedding-model',
  sandbox: undefined,
  targetDir: '/test/dir',
  debugMode: false,
  userMemory: '',
  geminiMdFileCount: 0,
  approvalMode: ApprovalMode.DEFAULT,
};

function makeConfigWithRegistry(): {
  config: Config;
  registry: ToolRegistry;
} {
  const config = new Config(baseConfigParams);
  const registry = new ToolRegistry(config);
  vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
  return { config, registry };
}

describe('DispatchTool', () => {
  let config: Config;
  let registry: ToolRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ config, registry } = makeConfigWithRegistry());
  });

  it('has correct name and alwaysLoad', () => {
    expect(DispatchTool.Name).toBe('dispatch');
    const tool = new DispatchTool(config);
    expect(tool.alwaysLoad).toBe(true);
  });

  it('dispatches to a registered tool and returns result', async () => {
    const mockResult = {
      returnDisplay: 'target_result',
      llmContent: 'target_content',
    } as ToolResult;
    registry.registerTool(
      new MockTool({
        name: 'target_tool',
        execute: () => Promise.resolve(mockResult),
      }),
    );
    const tool = new DispatchTool(config);
    const result = await tool
      .build({ tool: 'target_tool', args: { key: 'value' } })
      .execute(new AbortController().signal);

    expect(result.returnDisplay).toBe('target_result');
    expect(result.llmContent).toBe('target_content');
    expect(result.error).toBeUndefined();
  });

  it('rejects empty string tool name', async () => {
    const tool = new DispatchTool(config);
    const result = await tool
      .build({ tool: '', args: {} })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain(
      'Error: "tool" must be a non-empty string',
    );
    expect(result.returnDisplay).toBe('Invalid tool name');
    expect(result.error?.message).toBe('"tool" must be a non-empty string');
  });

  it('blocks recursive dispatch of itself', async () => {
    const tool = new DispatchTool(config);
    const result = await tool
      .build({ tool: 'dispatch', args: {} })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain('cannot dispatch "dispatch"');
    expect(result.returnDisplay).toBe('Recursive dispatch blocked');
    expect(result.error?.message).toBe('Recursive dispatch blocked');
  });

  it('returns error when tool is not found in registry', async () => {
    const tool = new DispatchTool(config);
    const result = await tool
      .build({ tool: 'nonexistent_tool', args: {} })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain(
      'no tool named "nonexistent_tool" is registered',
    );
    expect(result.returnDisplay).toBe('Unknown tool: nonexistent_tool');
  });

  it('returns error and logs when ensureTool throws', async () => {
    const realEnsure = registry.ensureTool.bind(registry);
    vi.spyOn(registry, 'ensureTool').mockImplementation(async (name) => {
      if (name === 'broken_tool') throw new Error('factory failure');
      return realEnsure(name);
    });

    const dispatchTool = new DispatchTool(config);
    const result = await dispatchTool
      .build({ tool: 'broken_tool', args: {} })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain('ensureTool("broken_tool") threw');
    expect(result.llmContent).toContain('factory failure');
    expect(result.returnDisplay).toBe('ensureTool failed: broken_tool');
  });

  it('returns error when target tool execution fails', async () => {
    registry.registerTool(
      new MockTool({
        name: 'failing_tool',
        execute: () => Promise.reject(new Error('target execution error')),
      }),
    );
    const dispatchTool = new DispatchTool(config);
    const result = await dispatchTool
      .build({ tool: 'failing_tool', args: {} })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain('tool "failing_tool" execution failed');
    expect(result.llmContent).toContain('target execution error');
    expect(result.error?.message).toContain(
      'Tool "failing_tool" execution failed',
    );
  });

  it('forwards args to target tool', async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    const inputArgs = { foo: 'bar', nested: { x: 1 } };

    registry.registerTool(
      new MockTool({
        name: 'args_forwarder',
        execute: (params) => {
          capturedArgs = params;
          return Promise.resolve({ returnDisplay: 'ok', llmContent: 'ok' });
        },
      }),
    );

    const dispatchTool = new DispatchTool(config);
    await dispatchTool
      .build({ tool: 'args_forwarder', args: inputArgs })
      .execute(new AbortController().signal);

    expect(capturedArgs).toEqual(inputArgs);
  });
});
