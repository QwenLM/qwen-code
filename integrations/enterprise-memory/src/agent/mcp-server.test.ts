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
          arguments: { summary: 'Use the release checklist' },
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
