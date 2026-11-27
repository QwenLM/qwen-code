/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

vi.mock('../../config/createCliSettingsService.js', () => ({
  resolveCommandSettings: vi.fn(() => ({ merged: {} })),
}));
import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import { createRemoveCommand } from './remove.js';

vi.mock('../../utils/exitCli.js', () => ({
  exitCli: vi.fn(),
}));

const mockGetMcpServersByScope = vi.fn().mockReturnValue({});
const mockRemoveMcpServer = vi.fn();
const mockForServer = vi.hoisted(() => vi.fn());
const mockFindMcpServerScopes = vi.fn().mockReturnValue([]);
const mockGetScopeSettingsPath = vi
  .fn()
  .mockImplementation((scope: string) => `/mock/${scope}/settings.json`);

vi.mock('../../config/localSettings.js', () => ({
  getMcpServersByScope: (...args: unknown[]) =>
    mockGetMcpServersByScope(...args),
  removeMcpServer: (...args: unknown[]) => mockRemoveMcpServer(...args) ?? [],
  findMcpServerScopes: (...args: unknown[]) => mockFindMcpServerScopes(...args),
  getScopeSettingsPath: (...args: unknown[]) =>
    mockGetScopeSettingsPath(...args),
}));

const mockDeleteCredentials = vi.fn();
vi.mock('@qwen-code/core', async () => {
  const actual = await vi.importActual<
    typeof import('@qwen-code/core')
  >('@qwen-code/core');
  return {
    ...actual,
    MCPOAuthTokenStorage: class {
      static forServer(name: string, server: unknown) {
        mockForServer(name, server);
        return new this();
      }
      deleteCredentials(name: string) {
        return mockDeleteCredentials(name);
      }
    },
  };
});

describe('mcp remove command', () => {
  describe('unit tests with mocks', () => {
    let parser: ReturnType<typeof createRemoveCommand>;
    let debugLogSpy: MockInstance;
    let debugErrorSpy: MockInstance;

    beforeEach(() => {
      vi.resetAllMocks();
      debugLogSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      debugErrorSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      parser = createRemoveCommand();
    });

    afterEach(() => {
      debugLogSpy.mockRestore();
      debugErrorSpy.mockRestore();
    });

    it('should remove from the single scope a server is defined in when no --scope given', async () => {
      mockFindMcpServerScopes.mockReturnValue(['user']);
      mockGetMcpServersByScope.mockImplementation((scope: string) => {
        if (scope === 'user') {
          return { 'test-server': { command: 'echo "hello"' } };
        }
        return {};
      });

      await parser.parseAsync(['test-server'], { from: 'user' });

      expect(mockRemoveMcpServer).toHaveBeenCalledWith(
        'test-server',
        'user',
        expect.any(String),
        expect.objectContaining({ merged: {} }),
        undefined,
      );
      expect(debugLogSpy).toHaveBeenCalledWith(
        'Removed MCP server "test-server" from user config.\n',
      );
    });

    it('should error when the server exists in multiple scopes and no --scope is given', async () => {
      mockFindMcpServerScopes.mockReturnValue(['user', 'local']);

      const mockProcessExit = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => {
          throw new Error('process.exit called');
        }) as (code?: number | string | null) => never);

      await expect(
        parser.parseAsync(['test-server'], { from: 'user' }),
      ).rejects.toThrow('process.exit called');

      expect(mockRemoveMcpServer).not.toHaveBeenCalled();
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      expect(debugErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('exists in multiple scopes'),
      );
    });

    it('should remove from specific scope when --scope is used', async () => {
      mockGetMcpServersByScope.mockReturnValue({
        'test-server': { command: 'echo "hello"' },
      });
      await parser.parseAsync(['--scope', 'user', 'test-server'], {
        from: 'user',
      });

      expect(mockRemoveMcpServer).toHaveBeenCalledWith(
        'test-server',
        'user',
        expect.any(String),
        expect.objectContaining({ merged: {} }),
        undefined,
      );
    });

    it('should error when --scope is given but server not found in that scope', async () => {
      mockGetMcpServersByScope.mockReturnValue({});
      const mockProcessExit = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => {
          throw new Error('process.exit called');
        }) as (code?: number | string | null) => never);

      await expect(
        parser.parseAsync(['--scope', 'user', 'non-existent-server'], {
          from: 'user',
        }),
      ).rejects.toThrow('process.exit called');

      expect(mockRemoveMcpServer).not.toHaveBeenCalled();
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      expect(debugErrorSpy).toHaveBeenCalledWith(
        'Error: No MCP server found with name "non-existent-server" in user config.\n',
      );
    });

    it('should error when the server is not found at all and no --scope given', async () => {
      mockFindMcpServerScopes.mockReturnValue([]);

      const mockProcessExit = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => {
          throw new Error('process.exit called');
        }) as (code?: number | string | null) => never);

      await expect(
        parser.parseAsync(['non-existent-server'], { from: 'user' }),
      ).rejects.toThrow('process.exit called');

      expect(mockRemoveMcpServer).not.toHaveBeenCalled();
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      expect(debugErrorSpy).toHaveBeenCalledWith(
        'Error: No MCP server found with name "non-existent-server".\n',
      );
    });

    it('should clean up OAuth token storage when removing an http server', async () => {
      const config = { type: 'http', url: 'https://example.com/mcp' };
      mockRemoveMcpServer.mockReturnValue([config]);
      mockFindMcpServerScopes.mockReturnValue(['user']);
      mockGetMcpServersByScope.mockImplementation((scope: string) => {
        if (scope === 'user') {
          return {
            'http-server': {
              type: 'http',
              url: 'https://example.com/mcp',
            },
          };
        }
        return {};
      });

      await parser.parseAsync(['http-server'], { from: 'user' });

      expect(mockRemoveMcpServer).toHaveBeenCalled();
      expect(mockDeleteCredentials).toHaveBeenCalledWith('http-server');
    });

    it('cleans up the credentials of every config it removed', async () => {
      const mcpJson = { type: 'http', url: 'https://a.example.com/mcp' };
      const legacy = { type: 'http', url: 'https://b.example.com/mcp' };
      mockRemoveMcpServer.mockReturnValue([mcpJson, legacy]);
      mockFindMcpServerScopes.mockReturnValue(['project']);
      mockGetMcpServersByScope.mockImplementation((scope: string) =>
        scope === 'project' ? { 'http-server': mcpJson } : {},
      );

      await parser.parseAsync(['http-server'], { from: 'user' });

      expect(mockForServer).toHaveBeenCalledWith('http-server', mcpJson);
      expect(mockForServer).toHaveBeenCalledWith('http-server', legacy);
      expect(mockDeleteCredentials).toHaveBeenCalledTimes(2);
    });

    it('hands the entry to the identity as written', async () => {
      const config = {
        type: 'http',
        url: 'https://${MCP_REMOVE_TENANT}.example.com/mcp',
      };
      mockRemoveMcpServer.mockReturnValue([config]);
      mockFindMcpServerScopes.mockReturnValue(['user']);
      mockGetMcpServersByScope.mockImplementation((scope: string) =>
        scope === 'user' ? { 'http-server': config } : {},
      );

      await parser.parseAsync(['http-server'], { from: 'user' });

      expect(mockForServer).toHaveBeenCalledWith('http-server', config);
      expect(mockDeleteCredentials).toHaveBeenCalledWith('http-server');
    });

    it('should NOT clean up OAuth token storage when removing a stdio server', async () => {
      mockFindMcpServerScopes.mockReturnValue(['user']);
      mockGetMcpServersByScope.mockImplementation((scope: string) => {
        if (scope === 'user') {
          return { 'stdio-server': { command: 'echo' } };
        }
        return {};
      });

      await parser.parseAsync(['stdio-server'], { from: 'user' });

      expect(mockRemoveMcpServer).toHaveBeenCalled();
      expect(mockDeleteCredentials).not.toHaveBeenCalled();
    });
  });
});
