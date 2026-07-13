import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

type SpawnOptions = {
  env?: Record<string, string | undefined>;
  stdio?: string[];
};

type TransportOptions = {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
};

const spawnOptions: SpawnOptions[] = [];
const transportOptions: TransportOptions[] = [];

const spawnMock = mock(
  (_command: string, _args: string[], options: SpawnOptions) => {
    spawnOptions.push(options);
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      exitCode: number | null;
      killed: boolean;
      kill: () => void;
    };
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.killed = false;
    child.kill = mock(() => {
      child.killed = true;
    });
    return child;
  },
);

class MockClient {
  async connect(): Promise<void> {}

  async listTools(): Promise<{ tools: { name: string }[] }> {
    return { tools: [{ name: 'ok' }] };
  }

  async close(): Promise<void> {}
}

class MockStdioClientTransport {
  constructor(options: TransportOptions) {
    transportOptions.push(options);
  }
}

mock.module('child_process', () => ({
  spawn: spawnMock,
}));

mock.module('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}));

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: MockStdioClientTransport,
}));

const { validateStdioMcpConnection } = await import('./validation.ts');

describe('validateStdioMcpConnection', () => {
  const originalEnv = { ...process.env };
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(() => {
    spawnMock.mockClear();
    spawnOptions.length = 0;
    transportOptions.length = 0;
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    Object.defineProperty(process, 'platform', originalPlatform!);
  });

  it('uses the sanitized environment for both the probe and stdio transport', async () => {
    process.env.QWEN_SERVER_TOKEN = 'server-token';
    process.env.LLM_API_KEY = 'llm-key';
    process.env.SAFE_BASE_VAR = 'safe-base';

    const result = await validateStdioMcpConnection({
      command: 'node',
      args: ['server.js'],
      env: {
        QWEN_SERVER_TOKEN: 'override-server-token',
        LLM_API_KEY: 'override-llm-key',
        CUSTOM_MCP_ENV: 'custom',
      },
      timeout: 1000,
    });

    expect(result.success).toBe(true);
    expect(spawnOptions).toHaveLength(1);
    expect(transportOptions).toHaveLength(1);

    const probeEnv = spawnOptions[0]?.env;
    const transportEnv = transportOptions[0]?.env;

    expect(probeEnv).toBe(transportEnv);
    expect(probeEnv?.QWEN_SERVER_TOKEN).toBeUndefined();
    expect(probeEnv?.LLM_API_KEY).toBeUndefined();
    expect(transportEnv?.QWEN_SERVER_TOKEN).toBeUndefined();
    expect(transportEnv?.LLM_API_KEY).toBeUndefined();
    expect(probeEnv?.SAFE_BASE_VAR).toBe('safe-base');
    expect(probeEnv?.CUSTOM_MCP_ENV).toBe('custom');
  });

  it('scrubs sensitive environment keys case-insensitively on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.qwen_server_token = 'server-token';
    process.env.Github_Token = 'github-token';
    process.env.Safe_Base_Var = 'safe-base';

    const result = await validateStdioMcpConnection({
      command: 'node',
      env: {
        Qwen_Api_Key: 'qwen-key',
        Custom_Mcp_Env: 'custom',
      },
      timeout: 1000,
    });

    expect(result.success).toBe(true);

    const probeEnv = spawnOptions[0]?.env;
    const transportEnv = transportOptions[0]?.env;

    expect(probeEnv).toBe(transportEnv);
    expect(probeEnv?.qwen_server_token).toBeUndefined();
    expect(probeEnv?.Github_Token).toBeUndefined();
    expect(probeEnv?.Qwen_Api_Key).toBeUndefined();
    expect(transportEnv?.qwen_server_token).toBeUndefined();
    expect(transportEnv?.Github_Token).toBeUndefined();
    expect(transportEnv?.Qwen_Api_Key).toBeUndefined();
    expect(probeEnv?.Safe_Base_Var).toBe('safe-base');
    expect(probeEnv?.Custom_Mcp_Env).toBe('custom');
  });
});
