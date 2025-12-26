/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpClientManager } from './mcp-client-manager.js';
import { McpClient } from './mcp-client.js';
import type { ToolRegistry } from './tool-registry.js';
import type { PromptRegistry } from '../prompts/prompt-registry.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import type { Config } from '../config/config.js';

vi.mock('./mcp-client.js', async () => {
  const originalModule = await vi.importActual('./mcp-client.js');
  return {
    ...originalModule,
    McpClient: vi.fn(),
    // Return the input servers unchanged (identity function)
    populateMcpServerCommand: vi.fn((servers) => servers),
  };
});

describe('McpClientManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should discover tools from all servers', async () => {
    const mockedMcpClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn(),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );
    const manager = new McpClientManager(
      {
        'test-server': {},
      },
      '',
      {} as ToolRegistry,
      {} as PromptRegistry,
      false,
      {} as WorkspaceContext,
    );
    await manager.discoverAllMcpTools({
      isTrustedFolder: () => true,
    } as unknown as Config);
    expect(mockedMcpClient.connect).toHaveBeenCalledOnce();
    expect(mockedMcpClient.discover).toHaveBeenCalledOnce();
  });

  it('should not discover tools if folder is not trusted', async () => {
    const mockedMcpClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn(),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );
    const manager = new McpClientManager(
      {
        'test-server': {},
      },
      '',
      {} as ToolRegistry,
      {} as PromptRegistry,
      false,
      {} as WorkspaceContext,
    );
    await manager.discoverAllMcpTools({
      isTrustedFolder: () => false,
    } as unknown as Config);
    expect(mockedMcpClient.connect).not.toHaveBeenCalled();
    expect(mockedMcpClient.discover).not.toHaveBeenCalled();
  });

  it('should disconnect all clients when stop is called', async () => {
    // Track disconnect calls across all instances
    const disconnectCalls: string[] = [];
    vi.mocked(McpClient).mockImplementation((name: string) => ({
        connect: vi.fn(),
        discover: vi.fn(),
        disconnect: vi.fn().mockImplementation(() => {
          disconnectCalls.push(name);
          return Promise.resolve();
        }),
        getStatus: vi.fn(),
      } as unknown as McpClient));
    const manager = new McpClientManager(
      {
        'test-server': {},
        'another-server': {},
      },
      '',
      {} as ToolRegistry,
      {} as PromptRegistry,
      false,
      {} as WorkspaceContext,
    );
    // First connect to create the clients
    await manager.discoverAllMcpTools({
      isTrustedFolder: () => true,
    } as unknown as Config);

    // Clear the disconnect calls from initial stop() in discoverAllMcpTools
    disconnectCalls.length = 0;

    // Then stop
    await manager.stop();
    expect(disconnectCalls).toHaveLength(2);
    expect(disconnectCalls).toContain('test-server');
    expect(disconnectCalls).toContain('another-server');
  });

  it('should be idempotent - stop can be called multiple times safely', async () => {
    const mockedMcpClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );
    const manager = new McpClientManager(
      {
        'test-server': {},
      },
      '',
      {} as ToolRegistry,
      {} as PromptRegistry,
      false,
      {} as WorkspaceContext,
    );
    await manager.discoverAllMcpTools({
      isTrustedFolder: () => true,
    } as unknown as Config);

    // Call stop multiple times - should not throw
    await manager.stop();
    await manager.stop();
    await manager.stop();
  });
});
