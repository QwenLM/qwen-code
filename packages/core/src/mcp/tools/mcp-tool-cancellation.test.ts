/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { McpProgressTracker } from '../client/progress.js';
import { coreEvents, CoreEvent } from '../../utils/events.js';
import { runWithToolCallContext } from '../../utils/toolCallContext.js';
import type { ToolUseContext } from '../../tools/tool-types.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { MCPServerConfig } from '../mcpServerConfig.js';
import type { McpClientContext } from '../mcpClientContext.js';
import { discoverTools, type McpToolCaller } from './mcp-tool.js';

const config = {
  type: 'http',
  url: 'http://example.test/mcp',
} as MCPServerConfig;
const context = {
  sanitizationConfig: {
    enableEnvironmentVariableRedaction: true,
    allowedEnvironmentVariables: [],
    blockedEnvironmentVariables: [],
  },
  emitMcpDiagnostic: vi.fn(),
} as unknown as McpClientContext;

const client = {
  getServerCapabilities: () => ({ tools: {}, prompts: {} }),
  listTools: async () => ({
    tools: [
      {
        name: 'slow',
        description: 'slow tool',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }),
} as unknown as Client;

describe('MCP tool cancellation', () => {
  it('forwards the caller abort signal to the MCP call', async () => {
    let receivedSignal: AbortSignal | undefined;
    const callMcpTool: McpToolCaller['callMcpTool'] = vi.fn(
      async (_params, options): Promise<never> => {
        receivedSignal = options?.signal;
        return await new Promise<never>((_resolve, reject) => {
          if (options?.signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
      },
    );

    const tools = await discoverTools(
      'slow-server',
      config,
      client,
      { callMcpTool },
      context,
    );
    const controller = new AbortController();
    const promise = tools[0].build({}).execute(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    await expect(promise).rejects.toThrow('Tool call aborted');
    expect(receivedSignal?.aborted).toBe(true);
  });
});

it('共享 MCP 连接按 token 记录发起会话，调用结束后清除归属', async () => {
  const tracker = new McpProgressTracker('shared');
  const pending: Array<{ token: string; finish: () => void }> = [];
  const [tool] = await discoverTools(
    'shared',
    config,
    client,
    {
      callMcpTool: (params) =>
        new Promise((resolve) => {
          pending.push({
            token: String(params._meta?.['progressToken']),
            finish: () => resolve({ content: [{ type: 'text', text: 'ok' }] }),
          });
        }),
    },
    context,
    { progressReporter: tracker },
  );
  const run = (sessionId?: string) =>
    runWithToolCallContext({ callId: 'same', toolCallScopeId: 'root' }, () =>
      tool.build({}).executeWithContext!({
        sessionId,
        signal: new AbortController().signal,
      } as ToolUseContext),
    );
  const progress = (index: number) =>
    tracker.handleProgress({
      params: { progressToken: pending[index].token, progress: index },
    });
  const observed = vi.fn();
  coreEvents.on(CoreEvent.McpProgress, observed);
  const tasks = [run('A'), run('B'), run()];
  try {
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    progress(1);
    progress(0);
    progress(2);
    pending[0].finish();
    await tasks[0];
    progress(0);
    progress(1);
    expect(
      observed.mock.calls.map(([event]) => [event.sessionId, event.callId]),
    ).toEqual([
      ['B', 'same'],
      ['A', 'same'],
      ['B', 'same'],
    ]);
  } finally {
    coreEvents.off(CoreEvent.McpProgress, observed);
    pending.forEach((call) => call.finish());
    await Promise.all(tasks);
  }
});
