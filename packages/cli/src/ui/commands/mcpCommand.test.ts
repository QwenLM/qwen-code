/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { mcpCommand } from './mcpCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import {
  MCPServerStatus,
  MCPDiscoveryState,
  getMCPServerStatus,
  getMCPDiscoveryState,
} from '@qwen-code/qwen-code-core';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  const mockAuthenticate = vi.fn();
  return {
    ...actual,
    getMCPServerStatus: vi.fn(),
    getMCPDiscoveryState: vi.fn(),
    MCPOAuthProvider: vi.fn(() => ({
      authenticate: mockAuthenticate,
    })),
    MCPOAuthTokenStorage: vi.fn(() => ({
      getToken: vi.fn(),
      isTokenExpired: vi.fn(),
    })),
  };
});

describe('mcpCommand', () => {
  let mockContext: ReturnType<typeof createMockCommandContext>;
  let mockConfig: {
    getToolRegistry: ReturnType<typeof vi.fn>;
    getMcpServers: ReturnType<typeof vi.fn>;
    getBlockedMcpServers: ReturnType<typeof vi.fn>;
    getPromptRegistry: ReturnType<typeof vi.fn>;
    getGeminiClient: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up default mock environment
    vi.unstubAllEnvs();

    // Default mock implementations - these are kept for auth subcommand tests
    vi.mocked(getMCPServerStatus).mockReturnValue(MCPServerStatus.CONNECTED);
    vi.mocked(getMCPDiscoveryState).mockReturnValue(
      MCPDiscoveryState.COMPLETED,
    );

    // Create mock config with all necessary methods
    mockConfig = {
      getToolRegistry: vi.fn().mockReturnValue({
        getAllTools: vi.fn().mockReturnValue([]),
      }),
      getMcpServers: vi.fn().mockReturnValue({}),
      getBlockedMcpServers: vi.fn().mockReturnValue([]),
      getPromptRegistry: vi.fn().mockResolvedValue({
        getAllPrompts: vi.fn().mockReturnValue([]),
        getPromptsByServer: vi.fn().mockReturnValue([]),
      }),
      getGeminiClient: vi.fn(),
    };

    mockContext = createMockCommandContext({
      services: {
        config: mockConfig,
      },
    });
  });

  describe('basic functionality', () => {
    it('should open MCP management dialog by default', async () => {
      const result = await mcpCommand.action!(mockContext, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'mcp',
      });
    });

    it('should open MCP management dialog even if config is not available', async () => {
      const contextWithoutConfig = createMockCommandContext({
        services: {
          config: null,
        },
      });

      const result = await mcpCommand.action!(contextWithoutConfig, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'mcp',
      });
    });

    it('should open MCP management dialog even if tool registry is not available', async () => {
      mockConfig.getToolRegistry = vi.fn().mockReturnValue(undefined);

      const result = await mcpCommand.action!(mockContext, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'mcp',
      });
    });
  });

  describe('with configured MCP servers', () => {
    beforeEach(() => {
      const mockMcpServers = {
        server1: { command: 'cmd1' },
        server2: { command: 'cmd2' },
        server3: { command: 'cmd3' },
      };

      mockConfig.getMcpServers = vi.fn().mockReturnValue(mockMcpServers);
    });

    it('should open MCP management dialog regardless of server configuration', async () => {
      const result = await mcpCommand.action!(mockContext, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'mcp',
      });
    });

    it('should open MCP management dialog with desc argument', async () => {
      const result = await mcpCommand.action!(mockContext, 'desc');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'mcp',
      });
    });

    it('should open MCP management dialog with nodesc argument', async () => {
      const result = await mcpCommand.action!(mockContext, 'nodesc');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'mcp',
      });
    });
  });
});
