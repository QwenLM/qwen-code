/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getMcpHeadersFromHelper,
  getMcpServerHeaders,
} from './headers-helper.js';
import type { MCPServerConfig } from '../../../config/config.js';
import { McpClientContext } from '../../mcpClientContext.js';
import * as childProcess from 'node:child_process';

vi.mock('node:child_process');

function makeConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    url: 'https://mcp.example.com',
    headers: { 'X-Static': 'static-value' },
    ...overrides,
  } as MCPServerConfig;
}

function makeTrustedContext(): McpClientContext {
  return new McpClientContext({
    sanitizationConfig: {
      allowedEnvironmentVariables: [],
      blockedEnvironmentVariables: [],
      enableEnvironmentVariableRedaction: false,
    },
    emitDiagnostic: vi.fn(),
    isTrustedFolder: () => true,
  });
}

function makeUntrustedContext(): McpClientContext {
  return new McpClientContext({
    sanitizationConfig: {
      allowedEnvironmentVariables: [],
      blockedEnvironmentVariables: [],
      enableEnvironmentVariableRedaction: false,
    },
    emitDiagnostic: vi.fn(),
    isTrustedFolder: () => false,
  });
}

describe('getMcpHeadersFromHelper', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when headersHelper is not configured', async () => {
    const config = makeConfig({ headersHelper: undefined });
    const result = await getMcpHeadersFromHelper('test-server', config);
    expect(result).toBeNull();
  });

  it('returns null when workspace is not trusted', async () => {
    const config = makeConfig({ headersHelper: '/usr/bin/get-token' });
    const result = await getMcpHeadersFromHelper(
      'test-server',
      config,
      makeUntrustedContext(),
    );
    expect(result).toBeNull();
  });

  it('executes headersHelper and returns parsed JSON headers', async () => {
    const expectedHeaders = {
      Authorization: 'Bearer dynamic-token-123',
      'X-Custom': 'custom-value',
    };

    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, JSON.stringify(expectedHeaders), '');
        return {} as any;
      },
    );

    const config = makeConfig({ headersHelper: '/usr/bin/get-token' });
    const result = await getMcpHeadersFromHelper(
      'test-server',
      config,
      makeTrustedContext(),
    );
    expect(result).toEqual(expectedHeaders);
  });

  it('passes server context as environment variables', async () => {
    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: any, _args: any, opts: any, cb: any) => {
        cb(
          null,
          JSON.stringify({ Token: opts.env.QODEER_MCP_SERVER_NAME }),
          '',
        );
        return {} as any;
      },
    );

    const config = makeConfig({
      headersHelper: '/usr/bin/get-token',
      url: 'https://mcp.example.com/sse',
    });
    const result = await getMcpHeadersFromHelper(
      'my-server',
      config,
      makeTrustedContext(),
    );

    expect(result).toEqual({ Token: 'my-server' });

    const callOpts = vi.mocked(childProcess.execFile).mock.calls[0][2] as any;
    expect(callOpts.env.QODEER_MCP_SERVER_NAME).toBe('my-server');
    expect(callOpts.env.QODEER_MCP_SERVER_URL).toBe(
      'https://mcp.example.com/sse',
    );
  });

  it('returns null on non-zero exit code', async () => {
    const error = new Error('command failed') as any;
    error.code = 1;
    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(error, '', 'some error');
        return {} as any;
      },
    );

    const config = makeConfig({ headersHelper: '/usr/bin/get-token' });
    const result = await getMcpHeadersFromHelper(
      'test-server',
      config,
      makeTrustedContext(),
    );
    expect(result).toBeNull();
  });

  it('returns null when output is not valid JSON', async () => {
    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, 'not-json', '');
        return {} as any;
      },
    );

    const config = makeConfig({ headersHelper: '/usr/bin/get-token' });
    const result = await getMcpHeadersFromHelper(
      'test-server',
      config,
      makeTrustedContext(),
    );
    expect(result).toBeNull();
  });

  it('returns null when output is a JSON array', async () => {
    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, '["a","b"]', '');
        return {} as any;
      },
    );

    const config = makeConfig({ headersHelper: '/usr/bin/get-token' });
    const result = await getMcpHeadersFromHelper(
      'test-server',
      config,
      makeTrustedContext(),
    );
    expect(result).toBeNull();
  });

  it('returns null when header values are not strings', async () => {
    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, JSON.stringify({ key: 123 }), '');
        return {} as any;
      },
    );

    const config = makeConfig({ headersHelper: '/usr/bin/get-token' });
    const result = await getMcpHeadersFromHelper(
      'test-server',
      config,
      makeTrustedContext(),
    );
    expect(result).toBeNull();
  });

  it('uses 10s timeout for script execution', async () => {
    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, '{}', '');
        return {} as any;
      },
    );

    const config = makeConfig({ headersHelper: '/usr/bin/get-token' });
    await getMcpHeadersFromHelper('test-server', config, makeTrustedContext());

    const callOpts = vi.mocked(childProcess.execFile).mock.calls[0][2] as any;
    expect(callOpts.timeout).toBe(10_000);
    expect(callOpts.shell).toBe(true);
  });
});

describe('getMcpServerHeaders', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns static headers when no headersHelper', async () => {
    const config = makeConfig({
      headers: { 'X-Static': 'value1' },
    });
    const result = await getMcpServerHeaders('test-server', config);
    expect(result).toEqual({ 'X-Static': 'value1' });
  });

  it('merges static and dynamic headers with dynamic taking precedence', async () => {
    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(
          null,
          JSON.stringify({
            'X-Static': 'overridden',
            'X-Dynamic': 'dynamic-value',
          }),
          '',
        );
        return {} as any;
      },
    );

    const config = makeConfig({
      headers: { 'X-Static': 'original' },
      headersHelper: '/usr/bin/get-token',
    });
    const result = await getMcpServerHeaders(
      'test-server',
      config,
      makeTrustedContext(),
    );
    expect(result).toEqual({
      'X-Static': 'overridden',
      'X-Dynamic': 'dynamic-value',
    });
  });

  it('returns static headers when headersHelper fails', async () => {
    const error = new Error('script failed') as any;
    error.code = 1;
    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(error, '', 'error');
        return {} as any;
      },
    );

    const config = makeConfig({
      headers: { 'X-Static': 'value1' },
      headersHelper: '/usr/bin/get-token',
    });
    const result = await getMcpServerHeaders(
      'test-server',
      config,
      makeTrustedContext(),
    );
    expect(result).toEqual({ 'X-Static': 'value1' });
  });
});
