/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import yargs from 'yargs';
import { addCommand } from './add.js';
import { loadSettings, SettingScope } from '../../config/settings.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
  clearScreen: vi.fn(),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(),
    writeFile: vi.fn(),
  };
});

vi.mock('os', () => {
  const homedir = vi.fn(() => '/home/user');
  return {
    default: {
      homedir,
    },
    homedir,
  };
});

vi.mock('../../config/settings.js', async () => {
  const actual = await vi.importActual('../../config/settings.js');
  return {
    ...actual,
    loadSettings: vi.fn(),
  };
});

const mockedLoadSettings = loadSettings as vi.Mock;

describe('mcp add command', () => {
  let parser: yargs.Argv;
  let mockSetValue: vi.Mock;

  beforeEach(() => {
    vi.resetAllMocks();
    const yargsInstance = yargs([]).command(addCommand);
    parser = yargsInstance;
    mockSetValue = vi.fn();
    mockWriteStderrLine.mockClear();
    mockedLoadSettings.mockReturnValue({
      forScope: () => ({ settings: {} }),
      setValue: mockSetValue,
      workspace: { path: '/path/to/project' },
      user: { path: '/home/user' },
    });
  });

  it('should add a stdio server to user settings by default', async () => {
    await parser.parseAsync(
      'add my-server /path/to/server arg1 arg2 -e FOO=bar',
    );

    expect(mockSetValue).toHaveBeenCalledWith(SettingScope.User, 'mcpServers', {
      'my-server': {
        command: '/path/to/server',
        args: ['arg1', 'arg2'],
        env: { FOO: 'bar' },
      },
    });
  });

  it('should auto-detect http transport when commandOrUrl is an https URL', async () => {
    await parser.parseAsync('add http-server https://example.com/mcp');

    expect(mockSetValue).toHaveBeenCalledWith(SettingScope.User, 'mcpServers', {
      'http-server': {
        httpUrl: 'https://example.com/mcp',
      },
    });
  });

  it('should auto-detect http transport when commandOrUrl is an http URL', async () => {
    await parser.parseAsync('add http-server http://localhost:8080/mcp');

    expect(mockSetValue).toHaveBeenCalledWith(SettingScope.User, 'mcpServers', {
      'http-server': {
        httpUrl: 'http://localhost:8080/mcp',
      },
    });
  });

  it('should respect explicit transport even when commandOrUrl is a URL', async () => {
    await parser.parseAsync(
      'add --transport sse sse-server https://example.com/sse-endpoint',
    );

    expect(mockSetValue).toHaveBeenCalledWith(SettingScope.User, 'mcpServers', {
      'sse-server': {
        url: 'https://example.com/sse-endpoint',
      },
    });
  });

  it('should add an sse server to user settings', async () => {
    await parser.parseAsync(
      'add --transport sse sse-server https://example.com/sse-endpoint --scope user -H "X-API-Key: your-key"',
    );

    expect(mockSetValue).toHaveBeenCalledWith(SettingScope.User, 'mcpServers', {
      'sse-server': {
        url: 'https://example.com/sse-endpoint',
        headers: { 'X-API-Key': 'your-key' },
      },
    });
  });

  it('should add an http server to user settings by default', async () => {
    await parser.parseAsync(
      'add --transport http http-server https://example.com/mcp -H "Authorization: Bearer your-token"',
    );

    expect(mockSetValue).toHaveBeenCalledWith(SettingScope.User, 'mcpServers', {
      'http-server': {
        httpUrl: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer your-token' },
      },
    });
  });

  it('should handle MCP server args with -- separator', async () => {
    await parser.parseAsync(
      'add my-server npx -- -y http://example.com/some-package',
    );

    expect(mockSetValue).toHaveBeenCalledWith(SettingScope.User, 'mcpServers', {
      'my-server': {
        command: 'npx',
        args: ['-y', 'http://example.com/some-package'],
      },
    });
  });

  it('should handle unknown options as MCP server args', async () => {
    await parser.parseAsync(
      'add test-server npx -y http://example.com/some-package',
    );

    expect(mockSetValue).toHaveBeenCalledWith(SettingScope.User, 'mcpServers', {
      'test-server': {
        command: 'npx',
        args: ['-y', 'http://example.com/some-package'],
      },
    });
  });

  describe('when handling scope and directory', () => {
    const serverName = 'test-server';
    const command = 'echo';

    const setupMocks = (cwd: string, workspacePath: string) => {
      vi.spyOn(process, 'cwd').mockReturnValue(cwd);
      mockedLoadSettings.mockReturnValue({
        forScope: () => ({ settings: {} }),
        setValue: mockSetValue,
        workspace: { path: workspacePath },
        user: { path: '/home/user' },
      });
    };

    describe('when in a project directory', () => {
      beforeEach(() => {
        setupMocks('/path/to/project', '/path/to/project');
      });

      it('should use user scope by default', async () => {
        await parser.parseAsync(`add ${serverName} ${command}`);
        expect(mockSetValue).toHaveBeenCalledWith(
          SettingScope.User,
          'mcpServers',
          expect.any(Object),
        );
      });

      it('should use project scope when --scope=project is used', async () => {
        await parser.parseAsync(`add --scope project ${serverName} ${command}`);
        expect(mockSetValue).toHaveBeenCalledWith(
          SettingScope.Workspace,
          'mcpServers',
          expect.any(Object),
        );
      });

      it('should use user scope when --scope=user is used', async () => {
        await parser.parseAsync(`add --scope user ${serverName} ${command}`);
        expect(mockSetValue).toHaveBeenCalledWith(
          SettingScope.User,
          'mcpServers',
          expect.any(Object),
        );
      });
    });

    describe('when in a subdirectory of a project', () => {
      beforeEach(() => {
        setupMocks('/path/to/project/subdir', '/path/to/project');
      });

      it('should use user scope by default', async () => {
        await parser.parseAsync(`add ${serverName} ${command}`);
        expect(mockSetValue).toHaveBeenCalledWith(
          SettingScope.User,
          'mcpServers',
          expect.any(Object),
        );
      });
    });

    describe('when in the home directory', () => {
      beforeEach(() => {
        setupMocks('/home/user', '/home/user');
      });

      it('should use user scope by default without error', async () => {
        await parser.parseAsync(`add ${serverName} ${command}`);
        expect(mockSetValue).toHaveBeenCalledWith(
          SettingScope.User,
          'mcpServers',
          expect.any(Object),
        );
        expect(mockWriteStderrLine).not.toHaveBeenCalled();
      });

      it('should show an error when --scope=project is used explicitly', async () => {
        const mockProcessExit = vi
          .spyOn(process, 'exit')
          .mockImplementation((() => {
            throw new Error('process.exit called');
          }) as (code?: number) => never);

        await expect(
          parser.parseAsync(`add --scope project ${serverName} ${command}`),
        ).rejects.toThrow('process.exit called');

        expect(mockWriteStderrLine).toHaveBeenCalledWith(
          'Error: Please use --scope user to edit settings in the home directory.',
        );
        expect(mockProcessExit).toHaveBeenCalledWith(1);
        expect(mockSetValue).not.toHaveBeenCalled();
      });

      it('should use user scope when --scope=user is used', async () => {
        await parser.parseAsync(`add --scope user ${serverName} ${command}`);
        expect(mockSetValue).toHaveBeenCalledWith(
          SettingScope.User,
          'mcpServers',
          expect.any(Object),
        );
        expect(mockWriteStderrLine).not.toHaveBeenCalled();
      });
    });

    describe('when in a subdirectory of home (not a project)', () => {
      beforeEach(() => {
        setupMocks('/home/user/some/dir', '/home/user/some/dir');
      });

      it('should use user scope by default', async () => {
        await parser.parseAsync(`add ${serverName} ${command}`);
        expect(mockSetValue).toHaveBeenCalledWith(
          SettingScope.User,
          'mcpServers',
          expect.any(Object),
        );
      });

      it('should write to the USER scope by default', async () => {
        await parser.parseAsync(`add my-new-server echo`);

        // We expect setValue to be called once.
        expect(mockSetValue).toHaveBeenCalledTimes(1);

        // We get the scope that setValue was called with.
        const calledScope = mockSetValue.mock.calls[0][0];

        // We assert that the scope was User by default.
        expect(calledScope).toBe(SettingScope.User);
      });
    });

    describe('when outside of home (not a project)', () => {
      beforeEach(() => {
        setupMocks('/tmp/foo', '/tmp/foo');
      });

      it('should use user scope by default', async () => {
        await parser.parseAsync(`add ${serverName} ${command}`);
        expect(mockSetValue).toHaveBeenCalledWith(
          SettingScope.User,
          'mcpServers',
          expect.any(Object),
        );
      });
    });
  });

  describe('when updating an existing server', () => {
    const serverName = 'existing-server';
    const initialCommand = 'echo old';
    const updatedCommand = 'echo';
    const updatedArgs = ['new'];

    beforeEach(() => {
      mockedLoadSettings.mockReturnValue({
        forScope: () => ({
          settings: {
            mcpServers: {
              [serverName]: {
                command: initialCommand,
              },
            },
          },
        }),
        setValue: mockSetValue,
        workspace: { path: '/path/to/project' },
        user: { path: '/home/user' },
      });
    });

    it('should update the existing server in the user scope by default', async () => {
      await parser.parseAsync(
        `add ${serverName} ${updatedCommand} ${updatedArgs.join(' ')}`,
      );
      expect(mockSetValue).toHaveBeenCalledWith(
        SettingScope.User,
        'mcpServers',
        expect.objectContaining({
          [serverName]: expect.objectContaining({
            command: updatedCommand,
            args: updatedArgs,
          }),
        }),
      );
    });

    it('should update the existing server in the user scope', async () => {
      await parser.parseAsync(
        `add --scope user ${serverName} ${updatedCommand} ${updatedArgs.join(' ')}`,
      );
      expect(mockSetValue).toHaveBeenCalledWith(
        SettingScope.User,
        'mcpServers',
        expect.objectContaining({
          [serverName]: expect.objectContaining({
            command: updatedCommand,
            args: updatedArgs,
          }),
        }),
      );
    });
  });

  describe('OAuth configuration', () => {
    it('should add OAuth config when OAuth options are provided', async () => {
      await parser.parseAsync(
        'add oauth-server https://example.com/mcp --transport http ' +
          '--oauth-client-id test-client-id ' +
          '--oauth-client-secret test-client-secret ' +
          '--oauth-redirect-uri https://example.com/oauth/callback ' +
          '--oauth-authorization-url https://provider.example.com/authorize ' +
          '--oauth-token-url https://provider.example.com/token ' +
          '--oauth-scopes read,write',
      );

      expect(mockSetValue).toHaveBeenCalledWith(
        SettingScope.User,
        'mcpServers',
        expect.objectContaining({
          'oauth-server': expect.objectContaining({
            httpUrl: 'https://example.com/mcp',
            oauth: {
              enabled: true,
              clientId: 'test-client-id',
              clientSecret: 'test-client-secret',
              redirectUri: 'https://example.com/oauth/callback',
              authorizationUrl: 'https://provider.example.com/authorize',
              tokenUrl: 'https://provider.example.com/token',
              scopes: ['read', 'write'],
            },
          }),
        }),
      );
    });

    it('should add OAuth config with only redirect URI', async () => {
      await parser.parseAsync(
        'add oauth-server https://example.com/mcp --transport sse ' +
          '--oauth-redirect-uri https://example.com/oauth/callback',
      );

      expect(mockSetValue).toHaveBeenCalledWith(
        SettingScope.User,
        'mcpServers',
        expect.objectContaining({
          'oauth-server': expect.objectContaining({
            url: 'https://example.com/mcp',
            oauth: {
              enabled: true,
              redirectUri: 'https://example.com/oauth/callback',
            },
          }),
        }),
      );
    });

    it('should not include oauth field when no OAuth options are provided', async () => {
      await parser.parseAsync(
        'add my-server https://example.com/mcp --transport http',
      );

      expect(mockSetValue).toHaveBeenCalledWith(
        SettingScope.User,
        'mcpServers',
        expect.objectContaining({
          'my-server': expect.objectContaining({
            httpUrl: 'https://example.com/mcp',
          }),
        }),
      );
    });

    it('should reject OAuth options when transport is stdio', async () => {
      const mockProcessExit = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => {
          throw new Error('process.exit called');
        }) as (code?: number) => never);

      await expect(
        parser.parseAsync(
          'add stdio-server /usr/bin/my-server --transport stdio ' +
            '--oauth-client-id id',
        ),
      ).rejects.toThrow('process.exit called');

      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        expect.stringContaining(
          'OAuth options (--oauth-*) are only supported with --transport sse or --transport http.',
        ),
      );
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      expect(mockSetValue).not.toHaveBeenCalled();
    });

    it('should split comma-separated scopes and trim whitespace', async () => {
      await parser.parseAsync(
        'add oauth-server https://example.com/mcp --transport http ' +
          '--oauth-scopes "read, write , admin"',
      );

      expect(mockSetValue).toHaveBeenCalledWith(
        SettingScope.User,
        'mcpServers',
        expect.objectContaining({
          'oauth-server': expect.objectContaining({
            oauth: expect.objectContaining({
              scopes: ['read', 'write', 'admin'],
            }),
          }),
        }),
      );
    });
  });
});
