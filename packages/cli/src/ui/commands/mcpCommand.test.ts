/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mcpCommand } from './mcpCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import * as cliConfig from '../../config/config.js';

describe('mcpCommand', () => {
  let mockContext: ReturnType<typeof createMockCommandContext>;
  let mockConfig: {
    getToolRegistry: ReturnType<typeof vi.fn>;
    getMcpServers: ReturnType<typeof vi.fn>;
    getDiskMcpServers: ReturnType<typeof vi.fn>;
    getMcpSettingsSourcesEnabled: ReturnType<typeof vi.fn>;
    getBlockedMcpServers: ReturnType<typeof vi.fn>;
    getPromptRegistry: ReturnType<typeof vi.fn>;
    getMcpClientManager: ReturnType<typeof vi.fn>;
    getResourceRegistry: ReturnType<typeof vi.fn>;
    setUserInteractedWithMcp: ReturnType<typeof vi.fn>;
    refreshMcpContext: ReturnType<typeof vi.fn>;
    getSessionArtifactProjectRoot: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();

    mockConfig = {
      getToolRegistry: vi.fn().mockReturnValue({
        getAllTools: vi.fn().mockReturnValue([]),
      }),
      getMcpServers: vi.fn().mockReturnValue({}),
      getDiskMcpServers: vi.fn().mockReturnValue({}),
      getMcpSettingsSourcesEnabled: vi.fn().mockReturnValue(false),
      getBlockedMcpServers: vi.fn().mockReturnValue([]),
      getPromptRegistry: vi.fn().mockReturnValue({
        getAllPrompts: vi.fn().mockReturnValue([]),
        getPromptsByServer: vi.fn().mockReturnValue([]),
      }),
      getMcpClientManager: vi.fn().mockImplementation(() => ({
        getBlockedMcpServers: vi.fn().mockReturnValue([]),
        getMcpServers: vi.fn().mockReturnValue({}),
        getLastError: vi.fn().mockReturnValue(undefined),
        restart: vi.fn().mockResolvedValue(undefined),
      })),
      getResourceRegistry: vi.fn().mockReturnValue({
        getAllResources: vi.fn().mockReturnValue([]),
      }),
      setUserInteractedWithMcp: vi.fn(),
      refreshMcpContext: vi.fn().mockResolvedValue(undefined),
      getSessionArtifactProjectRoot: vi.fn(() => '/original'),
    };

    mockContext = createMockCommandContext({
      services: {
        agentContext: {
          config: mockConfig,
          toolRegistry: mockConfig.getToolRegistry(),
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits for the MCP startup budget before opening the browser', () => {
    expect(mcpCommand.requiredStartupGates).toEqual(['mcp-budget']);
  });

  describe('default action', () => {
    it('should open the mcpBrowser dialog when no args provided', async () => {
      const result = await mcpCommand.action!(mockContext, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'mcpBrowser',
      });
    });
  });

  describe('reload subcommand', () => {
    it('loads pending approval from the original project when reloading in a worktree', async () => {
      const pending = { 'project-server': { command: 'server' } };
      vi.spyOn(cliConfig, 'refreshMcpServersFromDisk').mockImplementation(
        (_config, cwd) => ({
          approved: {},
          pending: cwd === '/original' ? pending : {},
        }),
      );

      expect(await mcpCommand.action!(mockContext, 'reload')).toEqual({
        type: 'dialog',
        dialog: 'mcpApproval',
        props: { pending },
      });
    });

    it('should return error if config is not available', async () => {
      const contextWithoutConfig = createMockCommandContext({
        services: {
          agentContext: null,
        },
      });

      const result = await mcpCommand.action!(contextWithoutConfig, 'reload');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Config not loaded.',
      });
    });

    it('should reload MCP servers and return success message', async () => {
      const result = await mcpCommand.action!(mockContext, 'reload');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'MCP servers reloaded successfully.',
      });
      expect(mockConfig.getDiskMcpServers).toHaveBeenCalledOnce();
    });
  });
});
