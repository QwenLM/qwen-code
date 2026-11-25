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
  describe,
  it,
  expect,
  vi,
  beforeEach,
  type MockInstance,
} from 'vitest';
import { createAddCommand } from './add.js';

vi.mock('../../utils/exitCli.js', () => ({
  exitCli: vi.fn(),
}));

vi.mock('@qwen-code/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/core')>()),
  sessionLogger: { setExitContext: vi.fn() },
}));

vi.mock('os', () => {
  const homedir = vi.fn(() => '/home/user');
  return {
    default: {
      homedir,
    },
    homedir,
  };
});

const mockUpsertMcpServer = vi.fn();
const mockUpsertMcpServerArgs: unknown[][] = [];
const mockGetMcpServersByScope = vi.fn().mockReturnValue({});
const mockGuardHomeDirScope = vi.fn();

vi.mock('../../config/localSettings.js', () => ({
  upsertMcpServer: (...args: unknown[]) => {
    mockUpsertMcpServerArgs.push(args);
    return mockUpsertMcpServer(...args.slice(0, 4));
  },
  getMcpServersByScope: (...args: unknown[]) =>
    mockGetMcpServersByScope(...args),
  guardHomeDirScope: (...args: unknown[]) => mockGuardHomeDirScope(...args),
}));

const mockReadClientSecret = vi.fn();
vi.mock('../../utils/clientSecret.js', () => ({
  readClientSecret: (...args: unknown[]) => mockReadClientSecret(...args),
}));

describe('mcp add command', () => {
  let parser: ReturnType<typeof createAddCommand>;
  let debugLoggerErrorSpy: MockInstance;

  beforeEach(() => {
    mockUpsertMcpServerArgs.length = 0;
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    mockGetMcpServersByScope.mockReturnValue({});
    parser = createAddCommand();
    debugLoggerErrorSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('should add a stdio server to local settings by default', async () => {
    await parser.parseAsync(
      ['my-server', '/path/to/server', 'arg1', 'arg2', '-e', 'FOO=bar'],
      { from: 'user' },
    );

    expect(mockUpsertMcpServer).toHaveBeenCalledWith(
      'my-server',
      {
        command: '/path/to/server',
        args: ['arg1', 'arg2'],
        env: { FOO: 'bar' },
      },
      'local',
      expect.any(String),
    );
  });

  it('should handle multiple env vars', async () => {
    await parser.parseAsync(
      ['my-server', '/path/to/server', '-e', 'FOO=bar', '-e', 'BAZ=qux'],
      { from: 'user' },
    );

    expect(mockUpsertMcpServer).toHaveBeenCalledWith(
      'my-server',
      {
        command: '/path/to/server',
        args: [],
        env: { FOO: 'bar', BAZ: 'qux' },
      },
      'local',
      expect.any(String),
    );
  });

  it('should add an sse server to user settings', async () => {
    await parser.parseAsync(
      [
        'sse-server',
        'https://example.com/sse-endpoint',
        '--transport',
        'sse',
        '--scope',
        'user',
        '-H',
        'X-API-Key: your-key',
      ],
      { from: 'user' },
    );

    expect(mockUpsertMcpServer).toHaveBeenCalledWith(
      'sse-server',
      {
        url: 'https://example.com/sse-endpoint',
        type: 'sse',
        headers: { 'X-API-Key': 'your-key' },
      },
      'user',
      expect.any(String),
    );
  });

  it('should add an http server to user settings', async () => {
    await parser.parseAsync(
      [
        'http-server',
        'https://example.com/mcp',
        '--transport',
        'http',
        '-H',
        'Authorization: Bearer your-token',
      ],
      { from: 'user' },
    );

    expect(mockUpsertMcpServer).toHaveBeenCalledWith(
      'http-server',
      {
        url: 'https://example.com/mcp',
        type: 'http',
        headers: { Authorization: 'Bearer your-token' },
      },
      'local',
      expect.any(String),
    );
  });

  it('should add an sse server using --type alias', async () => {
    await parser.parseAsync(
      [
        'sse-server',
        'https://example.com/sse',
        '--transport',
        'sse',
        '--scope',
        'user',
        '-H',
        'X-API-Key: your-key',
      ],
      { from: 'user' },
    );

    expect(mockUpsertMcpServer).toHaveBeenCalledWith(
      'sse-server',
      {
        url: 'https://example.com/sse',
        type: 'sse',
        headers: { 'X-API-Key': 'your-key' },
      },
      'user',
      expect.any(String),
    );
  });

  it('should handle MCP server args with -- separator', async () => {
    await parser.parseAsync(
      ['my-server', 'npx', '--', '-y', 'http://example.com/some-package'],
      { from: 'user' },
    );

    expect(mockUpsertMcpServer).toHaveBeenCalledWith(
      'my-server',
      {
        command: 'npx',
        args: ['-y', 'http://example.com/some-package'],
      },
      'local',
      expect.any(String),
    );
  });

  it('should handle unknown options as MCP server args', async () => {
    await parser.parseAsync(
      ['test-server', 'npx', '--', '-y', 'http://example.com/some-package'],
      { from: 'user' },
    );

    expect(mockUpsertMcpServer).toHaveBeenCalledWith(
      'test-server',
      {
        command: 'npx',
        args: ['-y', 'http://example.com/some-package'],
      },
      'local',
      expect.any(String),
    );
  });

  describe('when handling scope and directory', () => {
    const serverName = 'test-server';
    const command = 'echo';

    describe('when in a project directory', () => {
      beforeEach(() => {
        vi.spyOn(process, 'cwd').mockReturnValue('/path/to/project');
      });

      it('should use local scope by default', async () => {
        await parser.parseAsync([serverName, command], { from: 'user' });
        expect(mockUpsertMcpServer).toHaveBeenCalledWith(
          serverName,
          expect.any(Object),
          'local',
          '/path/to/project',
        );
      });

      it('should use project scope when --scope=project is used', async () => {
        await parser.parseAsync(['--scope', 'project', serverName, command], {
          from: 'user',
        });
        expect(mockUpsertMcpServer).toHaveBeenCalledWith(
          serverName,
          expect.any(Object),
          'project',
          '/path/to/project',
        );
      });

      it('should use user scope when --scope=user is used', async () => {
        await parser.parseAsync(['--scope', 'user', serverName, command], {
          from: 'user',
        });
        expect(mockUpsertMcpServer).toHaveBeenCalledWith(
          serverName,
          expect.any(Object),
          'user',
          '/path/to/project',
        );
      });
    });

    describe('when in the home directory', () => {
      beforeEach(() => {
        vi.spyOn(process, 'cwd').mockReturnValue('/home/user');
      });

      it('should use local scope by default (no error)', async () => {
        await parser.parseAsync([serverName, command], { from: 'user' });
        expect(mockUpsertMcpServer).toHaveBeenCalledWith(
          serverName,
          expect.any(Object),
          'local',
          '/home/user',
        );
        expect(mockGuardHomeDirScope).toHaveBeenCalledWith(
          'local',
          '/home/user',
        );
      });

      it('should call guardHomeDirScope when --scope=project is used', async () => {
        mockGuardHomeDirScope.mockImplementation((scope: string) => {
          if (scope === 'local' || scope === 'project') {
            process.stderr.write(
              'Error: Please use --scope user to edit settings in the home directory.\n',
            );
            process.exit(1);
          }
        });

        const mockProcessExit = vi
          .spyOn(process, 'exit')
          .mockImplementation((() => {
            throw new Error('process.exit called');
          }) as (code?: number | string | null) => never);

        await expect(
          parser.parseAsync(['--scope', 'project', serverName, command], {
            from: 'user',
          }),
        ).rejects.toThrow('process.exit called');

        expect(debugLoggerErrorSpy).toHaveBeenCalledWith(
          'Error: Please use --scope user to edit settings in the home directory.\n',
        );
        expect(mockProcessExit).toHaveBeenCalledWith(1);
        expect(mockUpsertMcpServer).not.toHaveBeenCalled();
      });
    });
  });

  describe('when the server already exists (create-only semantics)', () => {
    it('checks inside the upsert transaction and exits when it already exists', async () => {
      mockUpsertMcpServer.mockReturnValueOnce(true);

      const mockProcessExit = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => {
          throw new Error('process.exit called');
        }) as (code?: number | string | null) => never);

      await expect(
        parser.parseAsync(['my-server', '/path/to/server'], { from: 'user' }),
      ).rejects.toThrow('process.exit called');

      expect(debugLoggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('already exists'),
      );
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      expect(mockUpsertMcpServerArgs[0]?.[4]).toBe(true);
    });
  });

  describe('transport defaulting (cc alignment)', () => {
    it('should default to http when a URL is passed without --transport', async () => {
      await parser.parseAsync(['my-server', 'https://example.com/mcp'], {
        from: 'user',
      });

      expect(mockUpsertMcpServer).toHaveBeenCalledWith(
        'my-server',
        {
          url: 'https://example.com/mcp',
          type: 'http',
        },
        'local',
        expect.any(String),
      );
    });

    it('should not warn about URL shape when --transport is explicit', async () => {
      const writeSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      await parser.parseAsync(
        ['--transport', 'http', 'my-server', 'https://example.com/mcp'],
        { from: 'user' },
      );

      const writtenCalls = writeSpy.mock.calls.map((c) => String(c[0]));
      expect(writtenCalls.some((s) => s.includes('looks like a URL'))).toBe(
        false,
      );
    });

    it('should respect explicit --transport sse for URL', async () => {
      await parser.parseAsync(
        ['--transport', 'sse', 'my-server', 'https://example.com/sse'],
        { from: 'user' },
      );

      expect(mockUpsertMcpServer).toHaveBeenCalledWith(
        'my-server',
        {
          url: 'https://example.com/sse',
          type: 'sse',
        },
        'local',
        expect.any(String),
      );
    });

    it('should respect explicit --transport stdio even for URL', async () => {
      await parser.parseAsync(
        ['--transport', 'stdio', 'my-server', 'https://example.com/mcp'],
        { from: 'user' },
      );

      expect(mockUpsertMcpServer).toHaveBeenCalledWith(
        'my-server',
        {
          command: 'https://example.com/mcp',
          args: [],
        },
        'local',
        expect.any(String),
      );
    });
  });

  describe('OAuth flags', () => {
    it('should attach oauth.clientId / callbackPort on an HTTP server', async () => {
      await parser.parseAsync(
        [
          '--transport',
          'http',
          '--client-id',
          'my-id',
          '--callback-port',
          '9876',
          'my-server',
          'https://example.com/mcp',
        ],
        { from: 'user' },
      );

      expect(mockUpsertMcpServer).toHaveBeenCalledWith(
        'my-server',
        {
          url: 'https://example.com/mcp',
          type: 'http',
          oauth: { clientId: 'my-id', callbackPort: 9876 },
        },
        'local',
        expect.any(String),
      );
    });

    it('should prompt for the client secret via readClientSecret when --client-secret is passed with --client-id', async () => {
      mockReadClientSecret.mockResolvedValue('super-secret');

      await parser.parseAsync(
        [
          '--transport',
          'http',
          '--client-id',
          'my-id',
          '--client-secret',
          'my-server',
          'https://example.com/mcp',
        ],
        { from: 'user' },
      );

      expect(mockReadClientSecret).toHaveBeenCalledTimes(1);
      expect(mockUpsertMcpServer).toHaveBeenCalledWith(
        'my-server',
        {
          url: 'https://example.com/mcp',
          type: 'http',
          oauth: { clientId: 'my-id', clientSecret: 'super-secret' },
        },
        'local',
        expect.any(String),
      );
    });

    it('should warn and ignore OAuth flags when transport is stdio', async () => {
      const writeSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      await parser.parseAsync(
        ['--client-id', 'my-id', 'my-server', '/path/to/server'],
        { from: 'user' },
      );

      const writtenCalls = writeSpy.mock.calls.map((c) => String(c[0]));
      expect(
        writtenCalls.some((s) =>
          s.includes('only supported for HTTP/SSE transports'),
        ),
      ).toBe(true);

      // No oauth field in the stdio config written
      expect(mockUpsertMcpServer).toHaveBeenCalledWith(
        'my-server',
        {
          command: '/path/to/server',
          args: [],
        },
        'local',
        expect.any(String),
      );
    });
  });
});
