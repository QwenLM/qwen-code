/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mocked,
  type Mock,
} from 'vitest';

const { mockUndiciFetch, mockProxyAgent, mockEnvHttpProxyAgent } = vi.hoisted(
  () => {
    const proxyAgent = { kind: 'env-proxy-agent' };
    return {
      mockUndiciFetch: vi.fn(),
      mockProxyAgent: proxyAgent,
      mockEnvHttpProxyAgent: vi.fn(() => proxyAgent),
    };
  },
);
const { mockDebugLogger } = vi.hoisted(() => ({
  mockDebugLogger: {
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('undici', () => ({
  EnvHttpProxyAgent: mockEnvHttpProxyAgent,
  fetch: mockUndiciFetch,
}));
vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => mockDebugLogger,
}));

import {
  IdeClient,
  IDEConnectionStatus,
  getIdeServerHost,
  _resetCachedIdeServerHost,
} from './ide-client.js';
import * as fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as dns from 'node:dns';
import { getIdeProcessInfo } from './process-utils.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { detectIde, IDE_DEFINITIONS } from './detect-ide.js';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...(actual as object),
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
      readdir: vi.fn(),
      stat: vi.fn(),
      unlink: vi.fn(),
    },
    realpathSync: (p: string) => p,
    existsSync: vi.fn().mockReturnValue(false),
  };
});
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof dns>();
  return {
    ...(actual as object),
    lookup: vi.fn(),
  };
});
vi.mock('./process-utils.js');
vi.mock('@modelcontextprotocol/sdk/client/index.js');
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js');
vi.mock('@modelcontextprotocol/sdk/client/stdio.js');
vi.mock('./detect-ide.js');
vi.mock('node:os');

const readFile = vi.mocked(fs.promises.readFile);
const readdir = vi.mocked(fs.promises.readdir) as Mock<
  (path: fs.PathLike) => Promise<string[]>
>;
const stat = vi.mocked(fs.promises.stat) as Mock<
  (path: fs.PathLike) => Promise<fs.Stats>
>;
const IDE_DIR = path.join('/home/test', '.qwen', 'ide');
const lockFile = (port: string) => path.join(IDE_DIR, `${port}.lock`);
const legacyFile = (id: string) =>
  path.join('/tmp', `qwen-code-ide-server-${id}.json`);
const mcpUrl = (port: string, host = '127.0.0.1') =>
  new URL(`http://${host}:${port}/mcp`);
const bearer = (token: string) =>
  expect.objectContaining({
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
const mismatch = (source: string) =>
  `Ignoring ${source}: workspace "/other/workspace" does not match cwd "/test/workspace/sub-dir".`;

/** Every readFile resolves to `config` as JSON. */
const mockConfigFile = (config: object) =>
  readFile.mockResolvedValue(JSON.stringify(config));
/**
 * readFile serves `files` by path: an object comes back as JSON, `null`
 * throws 'not found', and any other path throws 'unexpected path'.
 */
const mockFiles = (files: Record<string, object | null>) =>
  readFile.mockImplementation(async (filePath: fs.PathLike | FileHandle) => {
    const file = String(filePath);
    if (!(file in files)) throw new Error(`unexpected path: ${file}`);
    const config = files[file];
    if (config === null) throw new Error('not found');
    return JSON.stringify(config);
  });
/** Locks ending in `fresh` are stamped now, every other one 1s earlier. */
const mockStatFresh = (fresh: string) =>
  stat.mockImplementation(async (filePath: fs.PathLike) => {
    const now = Date.now();
    const file = String(filePath);
    return { mtimeMs: file.endsWith(fresh) ? now : now - 1000 } as fs.Stats;
  });
const inContainer = (marker = '/.dockerenv') =>
  vi
    .mocked(fs.existsSync)
    .mockImplementation((filePath: fs.PathLike) => filePath === marker);

interface IdeClientInternals {
  createProxyAwareFetch: (
    host: string,
  ) => (url: string, init?: RequestInit) => Promise<Response>;
  getPortFromEnv: () => string | undefined;
  getConnectionConfigFromFile: () => Promise<unknown>;
  getAllConnectionConfigs: (dir: string) => Promise<unknown[]>;
  workspaceRejectedPorts: Set<string>;
}
const internals = (client: IdeClient) =>
  client as unknown as IdeClientInternals;
const connectClient = async () => {
  const ideClient = await IdeClient.getInstance();
  await ideClient.connect();
  return ideClient;
};
/** Run the private getConnectionConfigFromFile on `client` (default: the singleton). */
const readConfig = async (client?: IdeClient) =>
  internals(
    client ?? (await IdeClient.getInstance()),
  ).getConnectionConfigFromFile();
const statusOf = (client: IdeClient) => client.getConnectionStatus().status;
const detailsOf = (client: IdeClient) => client.getConnectionStatus().details;

describe('IdeClient', () => {
  let mockClient: Mocked<Client>;
  let mockHttpTransport: Mocked<StreamableHTTPClientTransport>;
  let mockStdioTransport: Mocked<StdioClientTransport>;

  beforeEach(async () => {
    // Reset singleton instance and cached host for test isolation
    (
      IdeClient as unknown as {
        instancePromise: Promise<IdeClient> | null;
      }
    ).instancePromise = null;
    _resetCachedIdeServerHost();

    // Mock environment variables
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    process.env['QWEN_CODE_IDE_WORKSPACE_PATH'] = '/test/workspace';
    delete process.env['QWEN_CODE_IDE_SERVER_PORT'];
    delete process.env['QWEN_CODE_IDE_SERVER_STDIO_COMMAND'];
    delete process.env['QWEN_CODE_IDE_SERVER_STDIO_ARGS'];

    // Mock dependencies
    vi.spyOn(process, 'cwd').mockReturnValue('/test/workspace/sub-dir');
    vi.mocked(fs.existsSync).mockImplementation((filePath: fs.PathLike) => {
      const file = String(filePath);
      return file !== '/.dockerenv' && file !== '/run/.containerenv';
    });
    vi.mocked(detectIde).mockReturnValue(IDE_DEFINITIONS.vscode);
    vi.mocked(getIdeProcessInfo).mockResolvedValue({
      pid: 12345,
      command: 'test-ide',
    });
    vi.mocked(os.tmpdir).mockReturnValue('/tmp');
    vi.mocked(os.homedir).mockReturnValue('/home/test');
    mockDebugLogger.debug.mockClear();
    mockDebugLogger.error.mockClear();

    // Mock MCP client and transports
    mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      setNotificationHandler: vi.fn(),
      callTool: vi.fn(),
      request: vi.fn(),
    } as unknown as Mocked<Client>;
    mockHttpTransport = {
      close: vi.fn(),
    } as unknown as Mocked<StreamableHTTPClientTransport>;
    mockStdioTransport = {
      close: vi.fn(),
    } as unknown as Mocked<StdioClientTransport>;

    vi.mocked(Client).mockReturnValue(mockClient);
    vi.mocked(StreamableHTTPClientTransport).mockReturnValue(mockHttpTransport);
    vi.mocked(StdioClientTransport).mockReturnValue(mockStdioTransport);
    mockUndiciFetch.mockReset();
    mockEnvHttpProxyAgent.mockClear();

    await IdeClient.getInstance();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete process.env['QWEN_CODE_IDE_SERVER_PORT'];
  });

  it('skips the IDE process walk outside VS Code terminals', async () => {
    vi.stubEnv('TERM_PROGRAM', 'iTerm.app');
    vi.mocked(getIdeProcessInfo).mockClear();

    await IdeClient.getInstance();

    expect(getIdeProcessInfo).not.toHaveBeenCalled();
  });

  describe('createProxyAwareFetch', () => {
    it('uses undici fetch with the proxy-aware dispatcher', async () => {
      mockUndiciFetch.mockResolvedValue(
        new Response('ok', {
          status: 201,
          statusText: 'Created',
          headers: { 'x-test': 'yes' },
        }),
      );
      const ideClient = await IdeClient.getInstance();
      const fetch = internals(ideClient).createProxyAwareFetch('127.0.0.1');

      const response = await fetch('http://127.0.0.1:8080/mcp', {
        method: 'POST',
      });

      expect(response.status).toBe(201);
      expect(response.headers.get('x-test')).toBe('yes');
      expect(mockEnvHttpProxyAgent).toHaveBeenCalled();
      expect(mockUndiciFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:8080/mcp',
        expect.objectContaining({
          method: 'POST',
          dispatcher: mockProxyAgent,
        }),
      );
    });
  });

  describe('connect', () => {
    it('should connect using HTTP when port is provided in config file', async () => {
      process.env['QWEN_CODE_IDE_SERVER_PORT'] = '8080';
      mockConfigFile({ port: '8080' });

      const ideClient = await connectClient();

      expect(readFile).toHaveBeenCalledWith(lockFile('8080'), 'utf8');
      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        mcpUrl('8080'),
        expect.any(Object),
      );
      expect(mockClient.connect).toHaveBeenCalledWith(mockHttpTransport);
      expect(statusOf(ideClient)).toBe(IDEConnectionStatus.Connected);
    });

    it('should connect using stdio when stdio config is provided in file', async () => {
      process.env['QWEN_CODE_IDE_SERVER_PORT'] = '8080';
      mockConfigFile({ stdio: { command: 'test-cmd', args: ['--foo'] } });

      const ideClient = await connectClient();

      expect(StdioClientTransport).toHaveBeenCalledWith({
        command: 'test-cmd',
        args: ['--foo'],
      });
      expect(mockClient.connect).toHaveBeenCalledWith(mockStdioTransport);
      expect(statusOf(ideClient)).toBe(IDEConnectionStatus.Connected);
    });

    it('should prioritize port over stdio when both are in config file', async () => {
      process.env['QWEN_CODE_IDE_SERVER_PORT'] = '8080';
      mockConfigFile({
        port: '8080',
        stdio: { command: 'test-cmd', args: ['--foo'] },
      });

      const ideClient = await connectClient();

      expect(StreamableHTTPClientTransport).toHaveBeenCalled();
      expect(StdioClientTransport).not.toHaveBeenCalled();
      expect(statusOf(ideClient)).toBe(IDEConnectionStatus.Connected);
    });

    it('should connect using HTTP when port is provided in environment variables', async () => {
      readFile.mockRejectedValue(new Error('File not found'));
      readdir.mockResolvedValue([]);
      process.env['QWEN_CODE_IDE_SERVER_PORT'] = '9090';

      const ideClient = await connectClient();

      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        mcpUrl('9090'),
        expect.any(Object),
      );
      expect(mockClient.connect).toHaveBeenCalledWith(mockHttpTransport);
      expect(statusOf(ideClient)).toBe(IDEConnectionStatus.Connected);
    });

    it('should fall back to host.docker.internal when localhost fails in container', async () => {
      process.env['QWEN_CODE_IDE_SERVER_PORT'] = '9090';
      readFile.mockRejectedValue(new Error('File not found'));
      readdir.mockResolvedValue([]);
      inContainer();
      (dns.lookup as unknown as Mock).mockImplementation(
        (
          _hostname: string,
          callback: (
            err: Error | null,
            address?: string,
            family?: number,
          ) => void,
        ) => {
          callback(null, '192.168.65.254', 4);
        },
      );
      mockClient.connect
        .mockRejectedValueOnce(new Error('localhost unreachable'))
        .mockResolvedValueOnce(undefined);

      const ideClient = await connectClient();

      // Localhost is always tried first.
      expect(StreamableHTTPClientTransport).toHaveBeenNthCalledWith(
        1,
        mcpUrl('9090'),
        expect.any(Object),
      );
      // In a container, host.docker.internal is used as fallback.
      expect(StreamableHTTPClientTransport).toHaveBeenNthCalledWith(
        2,
        mcpUrl('9090', 'host.docker.internal'),
        expect.any(Object),
      );
      expect(statusOf(ideClient)).toBe(IDEConnectionStatus.Connected);
    });

    it('should try a newer lock-file port when the configured port is stale', async () => {
      process.env['QWEN_CODE_IDE_SERVER_PORT'] = '1111';
      mockFiles({
        [lockFile('1111')]: {
          port: '1111',
          authToken: 'stale-token',
          workspacePath: '/test/workspace',
        },
        [lockFile('2222')]: {
          port: '2222',
          authToken: 'fresh-token',
          workspacePath: '/test/workspace',
        },
      });
      readdir.mockResolvedValue(['1111.lock', '2222.lock']);
      mockStatFresh('2222.lock');
      vi.mocked(fs.existsSync).mockImplementation(
        (filePath: fs.PathLike) => String(filePath) === '/test/workspace',
      );
      mockClient.request.mockResolvedValue({ tools: [] });
      mockClient.connect
        .mockRejectedValueOnce(new Error('stale port'))
        .mockResolvedValueOnce(undefined);

      const ideClient = await connectClient();

      expect(StreamableHTTPClientTransport).toHaveBeenNthCalledWith(
        1,
        mcpUrl('1111'),
        bearer('stale-token'),
      );
      expect(StreamableHTTPClientTransport).toHaveBeenNthCalledWith(
        2,
        mcpUrl('2222'),
        bearer('fresh-token'),
      );
      expect(statusOf(ideClient)).toBe(IDEConnectionStatus.Connected);
    });

    it('should not retry raw env port when its lock belongs to another workspace', async () => {
      process.env['QWEN_CODE_IDE_SERVER_PORT'] = '1234';
      mockFiles({
        [lockFile('1234')]: { port: '1234', workspacePath: '/other/workspace' },
        [legacyFile('12345')]: null,
        [legacyFile('1234')]: null,
      });
      readdir.mockResolvedValue([]);

      const ideClient = await connectClient();

      expect(StreamableHTTPClientTransport).not.toHaveBeenCalled();
      expect(mockClient.connect).not.toHaveBeenCalled();
      expect(statusOf(ideClient)).toBe(IDEConnectionStatus.Disconnected);
      expect(detailsOf(ideClient)).toContain('workspace does not match');
    });

    it('should skip explicit workspace mismatches when trying fallback ports', async () => {
      mockFiles({
        [legacyFile('12345')]: {
          port: '1111',
          workspacePath: '/test/workspace',
          ppid: 12345,
        },
        [lockFile('2222')]: { port: '2222', workspacePath: '/other/workspace' },
        [lockFile('3333')]: { port: '3333' },
      });
      readdir.mockResolvedValue(['2222.lock', '3333.lock']);
      mockStatFresh('2222.lock');
      mockClient.request.mockResolvedValue({ tools: [] });
      mockClient.connect
        .mockRejectedValueOnce(new Error('primary port failed'))
        .mockResolvedValueOnce(undefined);

      const ideClient = await connectClient();

      expect(StreamableHTTPClientTransport).toHaveBeenNthCalledWith(
        1,
        mcpUrl('1111'),
        expect.any(Object),
      );
      expect(StreamableHTTPClientTransport).toHaveBeenNthCalledWith(
        2,
        mcpUrl('3333'),
        expect.any(Object),
      );
      expect(StreamableHTTPClientTransport).not.toHaveBeenCalledWith(
        mcpUrl('2222'),
        expect.any(Object),
      );
      expect(statusOf(ideClient)).toBe(IDEConnectionStatus.Connected);
    });

    it('should connect using stdio when stdio config is in environment variables', async () => {
      readFile.mockRejectedValue(new Error('File not found'));
      readdir.mockResolvedValue([]);
      process.env['QWEN_CODE_IDE_SERVER_STDIO_COMMAND'] = 'env-cmd';
      process.env['QWEN_CODE_IDE_SERVER_STDIO_ARGS'] = '["--bar"]';

      const ideClient = await connectClient();

      expect(StdioClientTransport).toHaveBeenCalledWith({
        command: 'env-cmd',
        args: ['--bar'],
      });
      expect(mockClient.connect).toHaveBeenCalledWith(mockStdioTransport);
      expect(statusOf(ideClient)).toBe(IDEConnectionStatus.Connected);
    });

    it('should prioritize file config over environment variables', async () => {
      mockConfigFile({ port: '8080' });
      readdir.mockResolvedValue([]);
      process.env['QWEN_CODE_IDE_SERVER_PORT'] = '9090';

      const ideClient = await connectClient();

      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        mcpUrl('8080'),
        expect.any(Object),
      );
      expect(statusOf(ideClient)).toBe(IDEConnectionStatus.Connected);
    });

    it('should be disconnected if no config is found', async () => {
      readFile.mockRejectedValue(new Error('File not found'));
      readdir.mockResolvedValue([]);

      const ideClient = await connectClient();

      expect(StreamableHTTPClientTransport).not.toHaveBeenCalled();
      expect(StdioClientTransport).not.toHaveBeenCalled();
      expect(statusOf(ideClient)).toBe(IDEConnectionStatus.Disconnected);
      expect(detailsOf(ideClient)).toContain('Failed to connect');
    });

    it('should report workspace mismatch when discovered locks belong to another workspace', async () => {
      mockFiles({
        [legacyFile('12345')]: null,
        [lockFile('2222')]: { port: '2222', workspacePath: '/other/workspace' },
      });
      readdir.mockResolvedValue(['2222.lock']);
      stat.mockResolvedValue({ mtimeMs: Date.now() } as fs.Stats);

      const ideClient = await connectClient();

      expect(StreamableHTTPClientTransport).not.toHaveBeenCalled();
      expect(statusOf(ideClient)).toBe(IDEConnectionStatus.Disconnected);
      expect(detailsOf(ideClient)).toContain('workspace does not match');
    });
  });

  describe('validateWorkspacePath', () => {
    it.each([
      [
        'accepts JSON encoded multi-root workspace paths',
        JSON.stringify(['/test/other', '/test/workspace']),
      ],
      [
        'ignores relative workspace entries in IDE env parsing',
        JSON.stringify(['relative/path', '/test/workspace']),
      ],
      [
        'keeps delimiter encoded workspace paths working',
        ['/test/other', '/test/workspace'].join(path.delimiter),
      ],
    ])('%s', (_title, workspacePath) => {
      const result = IdeClient.validateWorkspacePath(
        workspacePath,
        '/test/workspace/sub-dir',
      );

      expect(result.isValid).toBe(true);
    });
  });

  describe('getPortFromEnv', () => {
    const invalidPorts = [
      undefined,
      '',
      '0',
      '65536',
      '99999',
      '../evil',
      '12345/../../etc',
      'abc',
      ' 8080 ',
      '8080.0',
    ];
    const portFromEnv = async () =>
      internals(await IdeClient.getInstance()).getPortFromEnv();

    it.each(['1', '12345', '65535'])(
      'should return valid env port %s',
      async (port) => {
        process.env['QWEN_CODE_IDE_SERVER_PORT'] = port;
        expect(await portFromEnv()).toBe(port);
      },
    );

    it.each(invalidPorts)('should ignore invalid env port %s', async (port) => {
      if (port === undefined) {
        delete process.env['QWEN_CODE_IDE_SERVER_PORT'];
      } else {
        process.env['QWEN_CODE_IDE_SERVER_PORT'] = port;
      }
      expect(await portFromEnv()).toBeUndefined();
    });
  });

  describe('getConnectionConfigFromFile', () => {
    it('should return config from the env port lock file if it exists', async () => {
      process.env['QWEN_CODE_IDE_SERVER_PORT'] = '12345';
      const config = { port: '12345', workspacePath: '/test/workspace' };
      mockConfigFile(config);

      expect(await readConfig()).toEqual(config);
      expect(readFile).toHaveBeenCalledWith(lockFile('12345'), 'utf8');
    });

    it('should not scan the lock directory when the env port lock file exists', async () => {
      process.env['QWEN_CODE_IDE_SERVER_PORT'] = '1234';
      const config = { port: '1234', workspacePath: '/test/workspace' };
      mockConfigFile(config);

      const ideClient = await IdeClient.getInstance();
      readdir.mockClear();

      expect(await readConfig(ideClient)).toEqual(config);
      expect(readdir).not.toHaveBeenCalled();
    });

    it('should fall back to scanned locks when the env port lock belongs to another workspace', async () => {
      process.env['QWEN_CODE_IDE_SERVER_PORT'] = '1234';
      const matchingConfig = { port: '5678', workspacePath: '/test/workspace' };
      mockFiles({
        [lockFile('1234')]: { port: '1234', workspacePath: '/other/workspace' },
        [legacyFile('12345')]: null,
        [legacyFile('1234')]: null,
        [lockFile('5678')]: matchingConfig,
      });
      readdir.mockResolvedValue(['1234.lock', '5678.lock']);
      mockStatFresh('1234.lock');

      expect(await readConfig()).toEqual(matchingConfig);
      expect(readFile).toHaveBeenCalledWith(lockFile('1234'), 'utf8');
      expect(readdir).toHaveBeenCalledWith(IDE_DIR);
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        mismatch('IDE env lock file'),
      );
    });

    it('should accept env lock config when workspacePath is undefined', async () => {
      process.env['QWEN_CODE_IDE_SERVER_PORT'] = '1234';
      const config = { port: '1234' };
      mockConfigFile(config);
      readdir.mockClear();

      expect(await readConfig()).toEqual(config);
      expect(readdir).not.toHaveBeenCalled();
    });

    it('should return legacy config when workspacePath is undefined', async () => {
      const config = { port: '1111', ppid: 12345 };
      readFile.mockResolvedValueOnce(JSON.stringify(config));
      readdir.mockClear();

      expect(await readConfig()).toEqual(config);
      expect(readFile).toHaveBeenCalledWith(legacyFile('12345'), 'utf8');
      expect(readdir).not.toHaveBeenCalled();
    });

    it('should return legacy config when env lock belongs to another workspace', async () => {
      process.env['QWEN_CODE_IDE_SERVER_PORT'] = '1234';
      const legacyConfig = {
        port: '1111',
        workspacePath: '/test/workspace',
        ppid: 12345,
      };
      mockFiles({
        [lockFile('1234')]: { port: '1234', workspacePath: '/other/workspace' },
        [legacyFile('12345')]: legacyConfig,
      });
      readdir.mockClear();

      expect(await readConfig()).toEqual(legacyConfig);
      expect(readdir).not.toHaveBeenCalled();
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        mismatch('IDE env lock file'),
      );
    });

    it('should reject env-port legacy config from another workspace', async () => {
      process.env['QWEN_CODE_IDE_SERVER_PORT'] = '1234';
      mockFiles({
        [lockFile('1234')]: null,
        [legacyFile('12345')]: null,
        [legacyFile('1234')]: {
          port: '9999',
          workspacePath: '/other/workspace',
        },
      });
      readdir.mockResolvedValue([]);

      const ideClient = await IdeClient.getInstance();
      const result = await readConfig(ideClient);
      const rejectedPorts = internals(ideClient).workspaceRejectedPorts;

      expect(result).toBeUndefined();
      expect(rejectedPorts.has('9999')).toBe(true);
      expect(rejectedPorts.has('1234')).toBe(true);
      expect(readdir).toHaveBeenCalledWith(IDE_DIR);
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        mismatch('legacy IDE connection config'),
      );
    });

    it.each(['../evil', '12345/../../etc', 'abc', ' 8080 ', '8080.0'])(
      'should scan the lock directory when env port is invalid: %s',
      async (port) => {
        process.env['QWEN_CODE_IDE_SERVER_PORT'] = port;
        const config = { port: '2345', workspacePath: '/test/workspace' };
        mockFiles({ [legacyFile('12345')]: null, [lockFile('2345')]: config });
        readdir.mockResolvedValue(['2345.lock']);
        stat.mockResolvedValue({ mtimeMs: Date.now() } as fs.Stats);
        readFile.mockClear();

        expect(await readConfig()).toEqual(config);
        expect(readFile).not.toHaveBeenCalledWith(lockFile(port), 'utf8');
        expect(readFile).not.toHaveBeenCalledWith(legacyFile(port), 'utf8');
        expect(readdir).toHaveBeenCalledWith(IDE_DIR);
      },
    );

    it('should return undefined if no config files are found', async () => {
      readFile.mockRejectedValue(new Error('not found'));

      expect(await readConfig()).toBeUndefined();
    });

    it('should read legacy pid config when available', async () => {
      const config = {
        port: '5678',
        workspacePath: '/test/workspace',
        ppid: 12345,
      };
      readFile.mockResolvedValueOnce(JSON.stringify(config));

      expect(await readConfig()).toEqual(config);
      expect(readFile).toHaveBeenCalledWith(legacyFile('12345'), 'utf8');
    });

    it('should fall back to scanned locks when the legacy config belongs to another workspace', async () => {
      const matchingConfig = { port: '5678', workspacePath: '/test/workspace' };
      mockFiles({
        [legacyFile('12345')]: {
          port: '1111',
          workspacePath: '/other/workspace',
          ppid: 12345,
        },
        [lockFile('5678')]: matchingConfig,
      });
      readdir.mockResolvedValue(['5678.lock']);
      stat.mockResolvedValue({ mtimeMs: Date.now() } as fs.Stats);

      expect(await readConfig()).toEqual(matchingConfig);
      expect(readdir).toHaveBeenCalledWith(IDE_DIR);
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        mismatch('legacy IDE connection config'),
      );
    });

    it('should fall back to legacy port file when pid file is missing', async () => {
      process.env['QWEN_CODE_IDE_SERVER_PORT'] = '2222';
      const config2 = { port: '2222', workspacePath: '/test/workspace' };
      readFile
        .mockRejectedValueOnce(new Error('not found')) // ~/.qwen/ide/<port>.lock
        .mockRejectedValueOnce(new Error('not found')) // legacy pid file
        .mockResolvedValueOnce(JSON.stringify(config2));

      expect(await readConfig()).toEqual(config2);
      expect(readFile).toHaveBeenCalledWith(legacyFile('12345'), 'utf8');
      expect(readFile).toHaveBeenCalledWith(legacyFile('2222'), 'utf8');
    });

    it('should fall back to legacy config when env lock file has invalid JSON', async () => {
      process.env['QWEN_CODE_IDE_SERVER_PORT'] = '3333';
      const config = { port: '1111', workspacePath: '/test/workspace' };
      readFile
        .mockResolvedValueOnce('invalid json')
        .mockResolvedValueOnce(JSON.stringify(config));

      expect(await readConfig()).toEqual(config);
    });

    it('should keep a live lock file even when it is older than 7 days', async () => {
      const liveConfig = {
        port: '1000',
        workspacePath: '/test/workspace',
        ppid: 4242,
      };
      const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000;
      mockFiles({
        [legacyFile('12345')]: null,
        [lockFile('1000')]: liveConfig,
      });
      readdir.mockResolvedValue(['1000.lock']);
      stat.mockResolvedValue({ mtimeMs: oldTime } as fs.Stats);
      vi.spyOn(process, 'kill').mockImplementation(() => true);

      expect(await readConfig()).toEqual(liveConfig);
      expect(fs.promises.unlink).not.toHaveBeenCalled();
    });

    it('should keep incomplete old lock files when there is no stronger stale signal', async () => {
      const latestConfig = { port: '2000', workspacePath: '/test/workspace' };
      const now = Date.now();
      const staleTime = now - 7 * 24 * 60 * 60 * 1000 - 1000;
      mockFiles({
        [legacyFile('12345')]: null,
        [lockFile('1000')]: { port: '1000' },
        [lockFile('2000')]: latestConfig,
      });
      readdir.mockResolvedValue(['1000.lock', '2000.lock']);
      stat.mockImplementation(async (filePath: fs.PathLike) => {
        const file = String(filePath);
        return {
          mtimeMs: file.endsWith('1000.lock') ? staleTime : now,
        } as fs.Stats;
      });
      vi.mocked(fs.existsSync).mockImplementation(
        (filePath: fs.PathLike) => String(filePath) === '/test/workspace',
      );

      const result = await readConfig();

      expect(fs.promises.unlink).not.toHaveBeenCalled();
      expect(result).toEqual(latestConfig);
    });

    it('should scan IDE lock directory when env and legacy config are unavailable', async () => {
      const latestConfig = { port: '2000', workspacePath: '/test/workspace' };
      mockFiles({
        [legacyFile('12345')]: null,
        [lockFile('1000')]: { port: '1000', workspacePath: '/older/workspace' },
        [lockFile('2000')]: latestConfig,
      });
      readdir.mockResolvedValue(['1000.lock', '2000.lock']);
      mockStatFresh('2000.lock');

      expect(await readConfig()).toEqual(latestConfig);
      expect(readdir).toHaveBeenCalledWith(IDE_DIR);
    });

    it('should return undefined when scanned lock files do not match current workspace', async () => {
      mockFiles({
        [legacyFile('12345')]: null,
        [lockFile('1000')]: {
          port: '1000',
          workspacePath: '/another/workspace',
        },
        [lockFile('2000')]: {
          port: '2000',
          workspacePath: '/yet/another/workspace',
        },
      });
      readdir.mockResolvedValue(['1000.lock', '2000.lock']);
      mockStatFresh('2000.lock');

      expect(await readConfig()).toBeUndefined();
    });
  });

  describe('isDiffingEnabled', () => {
    it('should return false if not connected', async () => {
      const ideClient = await IdeClient.getInstance();
      expect(ideClient.isDiffingEnabled()).toBe(false);
    });

    // Rows: [title, tool discovery result (an Error rejects it), expected].
    it.each([
      [
        'should return false if tool discovery fails',
        new Error('Method not found'),
        false,
      ],
      [
        'should return false if diffing tools are not available',
        [{ name: 'someOtherTool' }],
        false,
      ],
      [
        'should return false if only openDiff tool is available',
        [{ name: 'openDiff' }],
        false,
      ],
      [
        'should return true if connected and diffing tools are available',
        [{ name: 'openDiff' }, { name: 'closeDiff' }],
        true,
      ],
    ])('%s', async (_title, tools, enabled) => {
      mockConfigFile({ port: '8080' });
      readdir.mockResolvedValue([]);
      if (tools instanceof Error) {
        mockClient.request.mockRejectedValue(tools);
      } else {
        mockClient.request.mockResolvedValue({ tools });
      }

      const ideClient = await connectClient();

      expect(statusOf(ideClient)).toBe(IDEConnectionStatus.Connected);
      expect(ideClient.isDiffingEnabled()).toBe(enabled);
    });
  });

  describe('authentication', () => {
    it('should connect with an auth token if provided in the discovery file', async () => {
      const authToken = 'test-auth-token';
      mockConfigFile({ port: '8080', authToken });
      readdir.mockResolvedValue([]);

      const ideClient = await connectClient();

      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        mcpUrl('8080'),
        bearer(authToken),
      );
      expect(statusOf(ideClient)).toBe(IDEConnectionStatus.Connected);
    });
  });

  describe('getAllConnectionConfigs ENOENT guard', () => {
    /** Make readdir reject with a `code` error, then list configs in a test dir. */
    const listAfterReaddirError = async (code: string, message: string) => {
      const error = new Error(message);
      (error as NodeJS.ErrnoException).code = code;
      readdir.mockRejectedValue(error);
      mockDebugLogger.debug.mockClear();

      const ideClient = await IdeClient.getInstance();
      return internals(ideClient).getAllConnectionConfigs('/some/test/dir');
    };

    it('returns empty array silently when readdir rejects with ENOENT', async () => {
      const result = await listAfterReaddirError(
        'ENOENT',
        'ENOENT: no such file or directory',
      );

      expect(result).toEqual([]);
      expect(mockDebugLogger.debug).not.toHaveBeenCalledWith(
        'Failed to read IDE connection directory:',
        expect.any(Error),
      );
    });

    it('returns empty array and logs debug when readdir rejects with other error', async () => {
      const result = await listAfterReaddirError(
        'EPERM',
        'EPERM: operation not permitted',
      );

      expect(result).toEqual([]);
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'Failed to read IDE connection directory:',
        expect.any(Error),
      );
    });
  });
});

describe('getIdeServerHost', () => {
  const dnsLookupMock = dns.lookup as unknown as Mock;

  function mockDnsResolvable(reachable: boolean): void {
    dnsLookupMock.mockImplementation(
      (_hostname: string, callback: (err: Error | null) => void) => {
        if (reachable) {
          callback(null);
        } else {
          callback(new Error('ENOTFOUND'));
        }
      },
    );
  }
  const expectDockerLookup = () =>
    expect(dnsLookupMock).toHaveBeenCalledWith(
      'host.docker.internal',
      expect.any(Function),
    );

  beforeEach(() => {
    _resetCachedIdeServerHost();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return 127.0.0.1 when not in a container', async () => {
    expect(await getIdeServerHost()).toBe('127.0.0.1');
    expect(dnsLookupMock).not.toHaveBeenCalled();
  });

  it('should return host.docker.internal when in a container and the host is reachable', async () => {
    inContainer();
    mockDnsResolvable(true);

    expect(await getIdeServerHost()).toBe('host.docker.internal');
    expectDockerLookup();
  });

  it('should fall back to 127.0.0.1 when in a container but host.docker.internal is not reachable', async () => {
    inContainer();
    mockDnsResolvable(false);

    expect(await getIdeServerHost()).toBe('127.0.0.1');
    expectDockerLookup();
  });

  it('should detect container via /run/.containerenv', async () => {
    inContainer('/run/.containerenv');
    mockDnsResolvable(true);

    expect(await getIdeServerHost()).toBe('host.docker.internal');
  });

  it('should cache the result and not perform DNS lookup again', async () => {
    inContainer();
    mockDnsResolvable(true);

    const host1 = await getIdeServerHost();
    const host2 = await getIdeServerHost();

    expect(host1).toBe('host.docker.internal');
    expect(host2).toBe('host.docker.internal');
    expect(dnsLookupMock).toHaveBeenCalledTimes(1);
  });

  it('should fall back to 127.0.0.1 when DNS lookup times out in a container', async () => {
    vi.useFakeTimers();
    inContainer();
    dnsLookupMock.mockImplementation(() => {
      // Never call the callback to simulate a hung lookup.
    });

    const hostPromise = getIdeServerHost();
    await vi.advanceTimersByTimeAsync(3000);
    const host = await hostPromise;

    expect(host).toBe('127.0.0.1');
    expectDockerLookup();
  });

  it('should perform only one DNS lookup when called concurrently', async () => {
    vi.useRealTimers();
    inContainer();

    // Simulate a slow DNS lookup
    dnsLookupMock.mockImplementation(
      (_hostname: string, callback: (err: Error | null) => void) => {
        setTimeout(() => callback(null), 50);
      },
    );

    const promises = Array.from({ length: 5 }, () => getIdeServerHost());
    const results = await Promise.all(promises);

    expect(results.every((r) => r === 'host.docker.internal')).toBe(true);
    expect(dnsLookupMock).toHaveBeenCalledTimes(1);
  });
});
