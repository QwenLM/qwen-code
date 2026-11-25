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
import { createAddJsonCommand } from './addJson.js';

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
const mockGuardHomeDirScope = vi.fn();

vi.mock('../../config/localSettings.js', () => ({
  upsertMcpServer: (...args: unknown[]) => mockUpsertMcpServer(...args),
  getMcpServersByScope: () => ({}),
  guardHomeDirScope: (...args: unknown[]) => mockGuardHomeDirScope(...args),
}));

const mockReadClientSecret = vi.fn();
vi.mock('../../utils/clientSecret.js', () => ({
  readClientSecret: (...args: unknown[]) => mockReadClientSecret(...args),
}));

describe('mcp add-json command', () => {
  let parser: ReturnType<typeof createAddJsonCommand>;
  let debugLoggerErrorSpy: MockInstance;
  let debugLoggerLogSpy: MockInstance;

  beforeEach(() => {
    vi.resetAllMocks();
    mockUpsertMcpServer.mockReturnValue(false);
    parser = createAddJsonCommand();
    debugLoggerErrorSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    debugLoggerLogSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });


  it('should add a stdio server from JSON to local settings (default scope)', async () => {
    await parser.parseAsync(
      [
        'my-server',
        '{"command":"/path/to/server","args":["arg1","arg2"],"env":{"FOO":"bar"}}',
      ],
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
      true,
      expect.objectContaining({ merged: {} }),
      undefined,
    );
  });

  it('should add an http server from JSON with url, type, and headers', async () => {
    await parser.parseAsync(
      [
        'http-server',
        '{"url":"https://example.com/mcp","type":"http","headers":{"Authorization":"Bearer token"}}',
      ],
      { from: 'user' },
    );

    expect(mockUpsertMcpServer).toHaveBeenCalledWith(
      'http-server',
      {
        url: 'https://example.com/mcp',
        type: 'http',
        headers: { Authorization: 'Bearer token' },
      },
      'local',
      expect.any(String),
      true,
      expect.objectContaining({ merged: {} }),
      undefined,
    );
  });




  it('should error on invalid JSON string', async () => {
    const mockProcessExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit called');
      }) as (code?: number | string | null) => never);

    await expect(
      parser.parseAsync(['my-server', '{invalid json}'], { from: 'user' }),
    ).rejects.toThrow('process.exit called');

    expect(debugLoggerErrorSpy).toHaveBeenCalledWith(
      'Error: Invalid JSON string. Please provide a valid JSON configuration.\n',
    );
    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(mockUpsertMcpServer).not.toHaveBeenCalled();
  });

  it('should error when JSON is an array', async () => {
    const mockProcessExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit called');
      }) as (code?: number | string | null) => never);

    await expect(
      parser.parseAsync(['my-server', '[1,2,3]'], { from: 'user' }),
    ).rejects.toThrow('process.exit called');

    expect(debugLoggerErrorSpy).toHaveBeenCalledWith(
      'Error: JSON configuration must be an object, not an array.\n',
    );
    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(mockUpsertMcpServer).not.toHaveBeenCalled();
  });

  it('should error when JSON is null', async () => {
    const mockProcessExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit called');
      }) as (code?: number | string | null) => never);

    await expect(
      parser.parseAsync(['my-server', 'null'], { from: 'user' }),
    ).rejects.toThrow('process.exit called');

    expect(debugLoggerErrorSpy).toHaveBeenCalledWith(
      'Error: JSON configuration must be an object, not null.\n',
    );
    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(mockUpsertMcpServer).not.toHaveBeenCalled();
  });

  it('should default to local scope', async () => {
    await parser.parseAsync(['my-server', '{"command":"echo"}'], {
      from: 'user',
    });

    expect(mockUpsertMcpServer).toHaveBeenCalledWith(
      'my-server',
      expect.any(Object),
      'local',
      expect.any(String),
      true,
      expect.objectContaining({ merged: {} }),
      undefined,
    );
  });

  it('should use user scope when --scope=user is used', async () => {
    await parser.parseAsync(
      ['--scope', 'user', 'my-server', '{"command":"echo"}'],
      { from: 'user' },
    );

    expect(mockUpsertMcpServer).toHaveBeenCalledWith(
      'my-server',
      expect.any(Object),
      'user',
      expect.any(String),
      true,
      expect.objectContaining({ merged: {} }),
      undefined,
    );
  });

  it('should use project scope when --scope=project is used', async () => {
    await parser.parseAsync(
      ['--scope', 'project', 'my-server', '{"command":"echo"}'],
      { from: 'user' },
    );

    expect(mockUpsertMcpServer).toHaveBeenCalledWith(
      'my-server',
      expect.any(Object),
      'project',
      expect.any(String),
      true,
      expect.objectContaining({ merged: {} }),
      undefined,
    );
  });

  it('should log "added" for new servers', async () => {
    await parser.parseAsync(['my-server', '{"command":"echo"}'], {
      from: 'user',
    });

    expect(debugLoggerLogSpy).toHaveBeenCalledWith(
      'MCP server "my-server" added to local settings.\n',
    );
  });

  it('should exit 1 when the server already exists (create-only semantics)', async () => {
    mockUpsertMcpServer.mockReturnValue(true);

    const mockProcessExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit called');
      }) as (code?: number | string | null) => never);

    await expect(
      parser.parseAsync(['my-server', '{"command":"echo"}'], { from: 'user' }),
    ).rejects.toThrow('process.exit called');

    expect(debugLoggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('already exists'),
    );
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });

  describe('--client-secret support', () => {
    it('should prompt for the secret before write when config is HTTP with oauth.clientId', async () => {
      mockReadClientSecret.mockResolvedValue('super-secret');

      await parser.parseAsync(
        [
          '--client-secret',
          'http-server',
          '{"type":"http","url":"https://example.com/mcp","oauth":{"clientId":"my-id"}}',
        ],
        { from: 'user' },
      );

      expect(mockReadClientSecret).toHaveBeenCalledTimes(1);
      expect(mockUpsertMcpServer).toHaveBeenCalledWith(
        'http-server',
        expect.objectContaining({
          type: 'http',
          url: 'https://example.com/mcp',
          oauth: { clientId: 'my-id', clientSecret: 'super-secret' },
        }),
        'local',
        expect.any(String),
        true,
        expect.objectContaining({ merged: {} }),
        undefined,
      );
    });

    it('should NOT prompt when --client-secret is passed without oauth.clientId', async () => {
      await parser.parseAsync(
        [
          '--client-secret',
          'http-server',
          '{"type":"http","url":"https://example.com/mcp"}',
        ],
        { from: 'user' },
      );

      expect(mockReadClientSecret).not.toHaveBeenCalled();
      expect(mockUpsertMcpServer).toHaveBeenCalled();
    });

    it('should NOT prompt when the parsed config is stdio', async () => {
      await parser.parseAsync(
        [
          '--client-secret',
          'stdio-server',
          '{"command":"echo","oauth":{"clientId":"my-id"}}',
        ],
        { from: 'user' },
      );

      expect(mockReadClientSecret).not.toHaveBeenCalled();
    });
  });

  describe('when in the home directory', () => {
    beforeEach(() => {
      // Simulate guardHomeDirScope throwing for local/project scope
      mockGuardHomeDirScope.mockImplementation((scope: string) => {
        if (scope === 'local' || scope === 'project') {
          process.stderr.write(
            'Error: Please use --scope user to edit settings in the home directory.\n',
          );
          process.exit(1);
        }
      });
    });

    it('should show an error when --scope=project is used explicitly', async () => {
      const mockProcessExit = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => {
          throw new Error('process.exit called');
        }) as (code?: number | string | null) => never);

      await expect(
        parser.parseAsync(
          ['--scope', 'project', 'my-server', '{"command":"echo"}'],
          { from: 'user' },
        ),
      ).rejects.toThrow('process.exit called');

      expect(debugLoggerErrorSpy).toHaveBeenCalledWith(
        'Error: Please use --scope user to edit settings in the home directory.\n',
      );
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      expect(mockUpsertMcpServer).not.toHaveBeenCalled();
    });

    it('should show an error when --scope=local is used explicitly', async () => {
      const mockProcessExit = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => {
          throw new Error('process.exit called');
        }) as (code?: number | string | null) => never);

      await expect(
        parser.parseAsync(
          ['--scope', 'local', 'my-server', '{"command":"echo"}'],
          { from: 'user' },
        ),
      ).rejects.toThrow('process.exit called');

      expect(debugLoggerErrorSpy).toHaveBeenCalledWith(
        'Error: Please use --scope user to edit settings in the home directory.\n',
      );
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      expect(mockUpsertMcpServer).not.toHaveBeenCalled();
    });
  });
});
