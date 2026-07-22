/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleMcpMessage, type McpGatewayClient } from './mcp-server.js';
import { AgentStateStore } from './state-store.js';

const directories: string[] = [];
const PROPOSAL_OPERATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FEEDBACK_OPERATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMORY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class RecordingGateway implements McpGatewayClient {
  readonly calls: { path: string; value?: unknown; operationId: string }[] = [];
  error?: Error;

  async post<T>(path: string, value: unknown, operationId: string): Promise<T> {
    if (this.error) {
      throw this.error;
    }
    this.calls.push({ path, value, operationId });
    return { accepted: true } as T;
  }

  async get<T>(path: string, operationId: string): Promise<T> {
    this.calls.push({ path, operationId });
    return { id: 'memory-a' } as T;
  }
}

async function fixture(): Promise<{
  gateway: RecordingGateway;
  states: AgentStateStore;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'qwen-memory-mcp-'));
  directories.push(directory);
  return {
    gateway: new RecordingGateway(),
    states: new AgentStateStore(directory),
  };
}

describe('handleMcpMessage', () => {
  it('negotiates the protocol and advertises only bounded memory tools', async () => {
    const { gateway, states } = await fixture();
    const initialized = await handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25' },
      },
      gateway,
      states,
    );
    const listed = await handleMcpMessage(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      gateway,
      states,
    );

    expect(initialized?.result).toMatchObject({
      protocolVersion: '2025-11-25',
      capabilities: { tools: { listChanged: false } },
    });
    expect(
      (listed?.result as { tools: { name: string }[] }).tools.map(
        (tool) => tool.name,
      ),
    ).toEqual([
      'memory_search',
      'memory_get',
      'memory_propose_personal',
      'memory_propose_repository',
      'memory_feedback',
    ]);
  });

  it('validates and forwards a candidate-only tool call', async () => {
    const { gateway, states } = await fixture();
    const response = await handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 'call-a',
        method: 'tools/call',
        params: {
          name: 'memory_propose_repository',
          arguments: {
            operationId: PROPOSAL_OPERATION_ID,
            summary: 'Use the release checklist',
          },
        },
      },
      gateway,
      states,
    );

    expect(response?.error).toBeUndefined();
    expect(gateway.calls[0]).toMatchObject({
      path: '/v1/runtime/proposals',
      value: {
        scope: 'repository',
        summary: 'Use the release checklist',
        references: [],
      },
    });
    expect(gateway.calls[0]?.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/,
    );
  });

  it('uses the caller operation ID across MCP reconnects', async () => {
    const { gateway, states } = await fixture();
    const request = (id: string) => ({
      jsonrpc: '2.0' as const,
      id,
      method: 'tools/call',
      params: {
        name: 'memory_propose_repository',
        arguments: {
          operationId: PROPOSAL_OPERATION_ID,
          summary: 'Use the release checklist',
        },
      },
    });

    await handleMcpMessage(request('call-a'), gateway, states, 'connection-a');
    await handleMcpMessage(request('call-b'), gateway, states, 'connection-b');

    expect(gateway.calls[0]?.operationId).toBe(gateway.calls[1]?.operationId);
  });

  it('does not reuse read operation IDs when JSON-RPC IDs restart', async () => {
    const { gateway, states } = await fixture();
    const request = {
      jsonrpc: '2.0' as const,
      id: 0,
      method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'build' } },
    };

    await handleMcpMessage(request, gateway, states, 'connection-a');
    await handleMcpMessage(request, gateway, states, 'connection-b');

    expect(gateway.calls[0]?.operationId).not.toBe(
      gateway.calls[1]?.operationId,
    );
  });

  it('requires an explicit idempotency key for MCP writes', async () => {
    const { gateway, states } = await fixture();
    const response = await handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 'call-a',
        method: 'tools/call',
        params: {
          name: 'memory_propose_repository',
          arguments: { summary: 'Use the release checklist' },
        },
      },
      gateway,
      states,
    );

    expect(response?.error).toEqual({
      code: -32602,
      message: 'Invalid parameters',
    });
    expect(gateway.calls).toEqual([]);
  });

  it('keeps feedback retries stable without process-specific metadata', async () => {
    const { gateway, states } = await fixture();
    const request = (id: string) => ({
      jsonrpc: '2.0' as const,
      id,
      method: 'tools/call',
      params: {
        name: 'memory_feedback',
        arguments: {
          operationId: FEEDBACK_OPERATION_ID,
          memoryId: MEMORY_ID,
          signal: 'helpful',
        },
      },
    });

    await handleMcpMessage(request('call-a'), gateway, states, 'connection-a');
    await handleMcpMessage(request('call-b'), gateway, states, 'connection-b');

    expect(gateway.calls[0]).toEqual(gateway.calls[1]);
    expect(gateway.calls[0]?.value).toMatchObject({
      event_id: gateway.calls[0]?.operationId,
      session_id: 'mcp',
      memory_id: MEMORY_ID,
      signal: 'helpful',
    });
    expect(gateway.calls[0]?.value).not.toHaveProperty('operationId');
  });

  it('returns a stable tool error without dependency details', async () => {
    const { gateway, states } = await fixture();
    gateway.error = new Error('secret dependency response');
    const response = await handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'memory_search', arguments: { query: 'build' } },
      },
      gateway,
      states,
    );

    expect(response?.result).toMatchObject({ isError: true });
    expect(JSON.stringify(response)).not.toContain('secret dependency');
  });
});
