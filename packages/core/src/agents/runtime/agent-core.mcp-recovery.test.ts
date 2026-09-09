/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CallableTool } from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../../config/config.js';
import type { LlmChat } from '../../core/llm-chat.js';
import { DiscoveredMCPTool } from '../../tools/mcp-tool.js';
import type { McpTransportPool } from '../../tools/mcp-transport-pool.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { AgentCore } from './agent-core.js';
import { runWithAgentContext } from './agent-context.js';
import { AgentTerminateMode } from './agent-types.js';

function fixture() {
  const config = new Config({
    cwd: process.cwd(),
    targetDir: process.cwd(),
    model: 'test-model',
    debugMode: false,
  });
  const source = new ToolRegistry(config);
  const child = new ToolRegistry(config);
  child.copyDiscoveredToolsFrom(source);
  vi.spyOn(config, 'getToolRegistry').mockReturnValue(child);
  vi.spyOn(config, 'getMcpTransportPool').mockReturnValue(
    {} as McpTransportPool,
  );
  const core = new AgentCore(
    'test-agent',
    config,
    {},
    { model: 'test-model' },
    { max_turns: 3 },
    { tools: ['*'], disallowedTools: ['mcp__server__forbidden'] },
  );
  return { config, source, child, core };
}

function tool(name: string, description: string) {
  return new DiscoveredMCPTool(
    {} as CallableTool,
    'server',
    name,
    description,
    { type: 'object', properties: {} },
  ).withSessionConfig(false, false, false);
}

function chat() {
  const sendMessageStream = vi.fn(async function* () {
    yield {
      type: 'chunk',
      value: {
        candidates: [{ content: { parts: [{ text: 'Done.' }] } }],
      },
    };
  });
  return {
    value: {
      getHistoryToolCallFingerprints: () => new Map(),
      sendMessageStream,
    } as unknown as LlmChat,
    sendMessageStream,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('AgentCore pooled MCP recovery', () => {
  it('refreshes inherited declarations before the first and subsequent model sends', async () => {
    const { source, child, core } = fixture();
    source.registerTool(tool('read', 'old connection'));
    child.copyDiscoveredToolsFrom(source);
    let recoveries = 0;
    const recover = vi
      .spyOn(source.getMcpClientManager(), 'recoverFailedConnections')
      .mockImplementation(async () => {
        recoveries++;
        if (recoveries === 1) {
          source.removeMcpToolsByServer('server');
          source.registerTool(tool('read', 'recovered before first send'));
        } else {
          source.removeMcpToolsByServer('server');
          source.registerTool(tool('inspect', 'recovered before next send'));
          source.registerTool(tool('forbidden', 'must stay hidden'));
        }
        return [];
      });
    const model = chat();
    let externalReads = 0;

    const result = await runWithAgentContext('test-agent', async () =>
      core.runReasoningLoop(
        model.value,
        [{ role: 'user', parts: [{ text: 'Read data.' }] }],
        await core.prepareTools(),
        new AbortController(),
        {
          maxTurns: 3,
          getExternalMessages: () =>
            externalReads++ === 0 ? ['Inspect the next record.'] : [],
        },
      ),
    );

    expect(result.turnsUsed).toBe(2);
    expect(recover).toHaveBeenCalledTimes(2);
    const calls = model.sendMessageStream.mock.calls as unknown as Array<
      [
        string,
        { config: { tools: Array<{ functionDeclarations: unknown[] }> } },
      ]
    >;
    expect(calls[0][1].config.tools[0].functionDeclarations).toEqual([
      expect.objectContaining({
        name: 'mcp__server__read',
        description: 'recovered before first send',
      }),
    ]);
    expect(calls[1][1].config.tools[0].functionDeclarations).toEqual([
      expect.objectContaining({
        name: 'mcp__server__inspect',
        description: 'recovered before next send',
      }),
    ]);
    expect(child.getTool('mcp__server__read')).toBeUndefined();
  });

  it('does not send to the model when cancellation arrives during recovery', async () => {
    const { source, core } = fixture();
    const abort = new AbortController();
    vi.spyOn(
      source.getMcpClientManager(),
      'recoverFailedConnections',
    ).mockImplementation(async () => {
      abort.abort();
      return [];
    });
    const model = chat();

    const result = await core.runReasoningLoop(
      model.value,
      [{ role: 'user', parts: [{ text: 'Read data.' }] }],
      [],
      abort,
    );

    expect(result.terminateMode).toBe(AgentTerminateMode.CANCELLED);
    expect(model.sendMessageStream).not.toHaveBeenCalled();
    expect(result.turnsUsed).toBe(0);
  });
});
