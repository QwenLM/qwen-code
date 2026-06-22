/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const sdkMocks = vi.hoisted(() => {
  const state = {
    stdioTransports: [] as unknown[],
    httpTransports: [] as unknown[],
    clients: [] as unknown[],
    connectError: undefined as Error | undefined,
    toolResult: { content: [{ type: 'text', text: 'ok' }] } as unknown,
  };

  class MockStdioClientTransport {
    close = vi.fn(async () => {});

    constructor(public options: unknown) {
      state.stdioTransports.push(this);
    }
  }

  class MockStreamableHTTPClientTransport {
    close = vi.fn(async () => {});

    constructor(public url: URL) {
      state.httpTransports.push(this);
    }
  }

  class MockClient {
    connect = vi.fn(async () => {
      if (state.connectError) throw state.connectError;
    });
    callTool = vi.fn(async () => state.toolResult);
    close = vi.fn(async () => {});

    constructor(public clientInfo: unknown) {
      state.clients.push(this);
    }
  }

  return {
    state,
    MockClient,
    MockStdioClientTransport,
    MockStreamableHTTPClientTransport,
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: sdkMocks.MockClient,
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: sdkMocks.MockStdioClientTransport,
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: sdkMocks.MockStreamableHTTPClientTransport,
}));

import {
  registerA2uiActionRoutes,
  buildTransport,
  callA2uiAction,
  extractA2uiActionResult,
  findFromSettingsFile,
  usableServerConfig,
  type A2uiActionArgs,
  type A2uiActionResult,
  type McpServerCell,
  type McpServerConfigLike,
} from './a2ui-action.js';

function makeApp(opts: {
  servers?: McpServerCell[];
  serversError?: boolean;
  callAction?: (
    cfg: McpServerConfigLike,
    args: A2uiActionArgs,
  ) => Promise<A2uiActionResult>;
  workspace?: string;
}) {
  const app = express();
  app.use(express.json());
  const calls: A2uiActionArgs[] = [];
  const configs: McpServerConfigLike[] = [];
  registerA2uiActionRoutes(app, {
    boundWorkspace: opts.workspace ?? '/nonexistent-workspace',
    mutate: () => (_req, _res, next) => next(),
    safeBody: (req) =>
      req.body && typeof req.body === 'object' ? req.body : {},
    getMcpServers: async () => {
      if (opts.serversError) throw new Error('status unavailable');
      return opts.servers ?? [];
    },
    callAction:
      opts.callAction ??
      (async (cfg, args) => {
        configs.push(cfg);
        calls.push(args);
        return { commands: [{ version: 'v0.9' }], fallback: 'ok' };
      }),
  });
  return { app, calls, configs };
}

const STDIO_SERVER: McpServerCell = {
  name: 'a2ui-ui',
  mcpStatus: 'connected',
  config: { command: 'node', args: ['server.mjs'] },
};

describe('POST /session/:id/a2ui-action', () => {
  it('rejects a missing or empty name with 400', async () => {
    const { app } = makeApp({ servers: [STDIO_SERVER] });
    await request(app).post('/session/s1/a2ui-action').send({}).expect(400);
    await request(app)
      .post('/session/s1/a2ui-action')
      .send({ name: '  ' })
      .expect(400);
  });

  it('returns 503 when no a2ui server is discoverable anywhere', async () => {
    const { app } = makeApp({
      servers: [{ name: 'github', config: { command: 'x' } }],
    });
    const res = await request(app)
      .post('/session/s1/a2ui-action')
      .send({ name: 'go' })
      .expect(503);
    expect(res.body.error).toMatch(/no a2ui MCP server/);
  });

  it('proxies to the action tool and returns its continuation', async () => {
    const { app, calls } = makeApp({ servers: [STDIO_SERVER] });
    const res = await request(app)
      .post('/session/s1/a2ui-action')
      .send({ name: ' submit ', surfaceId: 'ui_1', context: { a: 1 } })
      .expect(200);
    expect(res.body).toEqual({
      commands: [{ version: 'v0.9' }],
      fallback: 'ok',
    });
    expect(calls).toEqual([
      { name: 'submit', surfaceId: 'ui_1', context: { a: 1 } },
    ]);
  });

  it('strips a non-object/array context instead of forwarding it', async () => {
    const { app, calls } = makeApp({ servers: [STDIO_SERVER] });
    await request(app)
      .post('/session/s1/a2ui-action')
      .send({ name: 'go', context: [1, 2, 3] })
      .expect(200);
    expect(calls[0].context).toBeUndefined();
  });

  it('prefers a connected server over a merely-listed one', async () => {
    const disconnected: McpServerCell = {
      name: 'a2ui-old',
      mcpStatus: 'disconnected',
      config: { command: 'old' },
    };
    const { app, configs } = makeApp({ servers: [disconnected, STDIO_SERVER] });
    await request(app)
      .post('/session/s1/a2ui-action')
      .send({ name: 'go' })
      .expect(200);
    expect(configs[0]).toEqual(STDIO_SERVER.config);
  });

  it('falls back to workspace settings when daemon status is unavailable', async () => {
    const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'a2ui-action-test-'));
    await fsp.mkdir(path.join(ws, '.qwen'), { recursive: true });
    await fsp.writeFile(
      path.join(ws, '.qwen', 'settings.json'),
      JSON.stringify({
        mcpServers: { 'my-a2ui': { command: 'node', args: ['x.mjs'] } },
      }),
    );
    try {
      const { app, configs } = makeApp({ serversError: true, workspace: ws });
      await request(app)
        .post('/session/s1/a2ui-action')
        .send({ name: 'go' })
        .expect(200);
      expect(configs[0]).toEqual({ command: 'node', args: ['x.mjs'] });
    } finally {
      await fsp.rm(ws, { recursive: true, force: true });
    }
  });

  it('maps proxy failures to a generic 502 without leaking details', async () => {
    const errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const { app } = makeApp({
      servers: [STDIO_SERVER],
      callAction: async () => {
        throw new Error('spawn /secret/path failed');
      },
    });
    const res = await request(app)
      .post('/session/s1/a2ui-action')
      .send({ name: 'go' })
      .expect(502);
    expect(res.body).toEqual({ error: 'a2ui action call failed' });
    expect(JSON.stringify(res.body)).not.toContain('/secret/path');
    errSpy.mockRestore();
  });
});

describe('helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sdkMocks.state.stdioTransports.length = 0;
    sdkMocks.state.httpTransports.length = 0;
    sdkMocks.state.clients.length = 0;
    sdkMocks.state.connectError = undefined;
    sdkMocks.state.toolResult = { content: [{ type: 'text', text: 'ok' }] };
  });
  afterEach(() => vi.restoreAllMocks());

  it('extracts the first A2UI resource and accumulates text fallback', () => {
    const result = extractA2uiActionResult({
      content: [
        { type: 'text', text: 'before ' },
        {
          type: 'resource',
          resource: {
            mimeType: 'application/a2ui+json',
            text: JSON.stringify([
              {
                command: 'update',
                payload: { items: [['nested']], label: 'say "hi"' },
              },
            ]),
          },
        },
        {
          type: 'resource',
          resource: {
            mimeType: 'application/a2ui+json',
            text: JSON.stringify([{ command: 'ignored' }]),
          },
        },
        { type: 'text', text: 'after' },
      ],
    });

    expect(result).toEqual({
      commands: [
        {
          command: 'update',
          payload: { items: [['nested']], label: 'say "hi"' },
        },
      ],
      fallback: 'before after',
    });
  });

  it('keeps empty arrays and ignores invalid or non-array resources', () => {
    expect(
      extractA2uiActionResult({
        content: [
          {
            type: 'resource',
            resource: {
              mimeType: 'application/a2ui+json',
              text: '[',
            },
          },
          {
            type: 'resource',
            resource: {
              mimeType: 'application/a2ui+json',
              text: '{"command":"not-array"}',
            },
          },
        ],
      }),
    ).toEqual({ commands: null, fallback: '' });

    expect(
      extractA2uiActionResult({
        content: [
          {
            type: 'resource',
            resource: {
              mimeType: 'application/a2ui+json',
              text: '[]',
            },
          },
        ],
      }),
    ).toEqual({ commands: [], fallback: '' });
  });

  it('throws MCP tool errors with text details when present', () => {
    expect(() =>
      extractA2uiActionResult({
        isError: true,
        content: [
          { type: 'text', text: 'bad ' },
          { type: 'text', text: 'input' },
        ],
      }),
    ).toThrow('a2ui action tool returned error: bad input');

    expect(() => extractA2uiActionResult({ isError: true })).toThrow(
      'a2ui action tool returned error: unknown error',
    );
  });

  it('usableServerConfig accepts stdio or streamable-http shapes only', () => {
    expect(usableServerConfig({ command: 'node' })).toBe(true);
    expect(usableServerConfig({ httpUrl: 'https://x/mcp' })).toBe(true);
    expect(usableServerConfig({})).toBe(false);
    expect(usableServerConfig(undefined)).toBe(false);
  });

  it('buildTransport creates streamable HTTP transports', () => {
    buildTransport({ httpUrl: 'https://example.com/mcp' });

    const transport = sdkMocks.state.httpTransports[0] as { url: URL };
    expect(transport.url.href).toBe('https://example.com/mcp');
    expect(sdkMocks.state.stdioTransports).toHaveLength(0);
  });

  it('buildTransport merges stdio env only when provided', () => {
    buildTransport({
      command: 'node',
      args: ['server.mjs'],
      env: { A2UI_TOKEN: 'secret' },
      cwd: '/workspace',
    });
    buildTransport({ command: 'node' });

    const withEnv = sdkMocks.state.stdioTransports[0] as {
      options: {
        command: string;
        args: string[];
        env?: Record<string, string | undefined>;
        cwd?: string;
      };
    };
    const withoutEnv = sdkMocks.state.stdioTransports[1] as {
      options: { env?: Record<string, string | undefined> };
    };
    expect(withEnv.options).toMatchObject({
      command: 'node',
      args: ['server.mjs'],
      cwd: '/workspace',
    });
    expect(withEnv.options.env?.['A2UI_TOKEN']).toBe('secret');
    expect(withEnv.options.env?.['PATH']).toBe(process.env['PATH']);
    expect(withoutEnv.options).not.toHaveProperty('env');
  });

  it('callA2uiAction connects, calls the action tool, and closes resources', async () => {
    const result = await callA2uiAction({ command: 'node' }, { name: 'tap' });

    const transport = sdkMocks.state.stdioTransports[0];
    const client = sdkMocks.state.clients[0] as {
      connect: unknown;
      callTool: unknown;
      close: unknown;
    };
    expect(result).toEqual({ commands: null, fallback: 'ok' });
    expect(client.connect).toHaveBeenCalledWith(transport, {
      timeout: 15_000,
    });
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'action', arguments: { name: 'tap' } },
      undefined,
      { timeout: 15_000 },
    );
    expect((transport as { close: unknown }).close).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('callA2uiAction closes resources when connect fails', async () => {
    sdkMocks.state.connectError = new Error('connect failed');

    await expect(
      callA2uiAction({ command: 'node' }, { name: 'tap' }),
    ).rejects.toThrow('connect failed');

    const transport = sdkMocks.state.stdioTransports[0] as { close: unknown };
    const client = sdkMocks.state.clients[0] as {
      callTool: unknown;
      close: unknown;
    };
    expect(client.callTool).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('findFromSettingsFile returns null for a missing or unparseable file', async () => {
    expect(await findFromSettingsFile('/definitely-missing-dir')).toBeNull();
    const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'a2ui-action-test-'));
    await fsp.mkdir(path.join(ws, '.qwen'), { recursive: true });
    await fsp.writeFile(path.join(ws, '.qwen', 'settings.json'), '{not json');
    try {
      expect(await findFromSettingsFile(ws)).toBeNull();
    } finally {
      await fsp.rm(ws, { recursive: true, force: true });
    }
  });
});
