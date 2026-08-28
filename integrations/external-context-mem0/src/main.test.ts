/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadRuntimeConfiguration = vi.hoisted(() => vi.fn());
const createMem0McpServer = vi.hoisted(() => vi.fn());
const createRequestEngine = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn());

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  loadRuntimeConfiguration,
}));
vi.mock('./mcp.js', () => ({ createMem0McpServer }));
vi.mock('./request-engine.js', () => ({ createRequestEngine }));

let previousExitCode: string | number | null | undefined;

beforeEach(() => {
  vi.resetModules();
  loadRuntimeConfiguration.mockReset();
  createMem0McpServer.mockReset();
  createRequestEngine.mockReset();
  connect.mockReset();
  createMem0McpServer.mockReturnValue({ connect });
  previousExitCode = process.exitCode;
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
});

describe('Mem0 extension startup', () => {
  it('connects the configured MCP server', async () => {
    const runtime = { instance: {}, dialect: {}, credential: 'secret' };
    const search = vi.fn();
    loadRuntimeConfiguration.mockResolvedValue(runtime);
    createRequestEngine.mockReturnValue(search);
    connect.mockResolvedValue(undefined);

    await import('./main.js');

    expect(createRequestEngine).toHaveBeenCalledWith(runtime);
    expect(createMem0McpServer).toHaveBeenCalledWith({
      instance: runtime.instance,
      search,
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(previousExitCode);
  });

  it('prints sanitized configuration errors', async () => {
    const { ConfigurationError } = await import('./schemas.js');
    loadRuntimeConfiguration.mockRejectedValue(
      new ConfigurationError('Mem0 extension configuration is invalid.'),
    );
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await import('./main.js');

    expect(write).toHaveBeenCalledWith(
      'Mem0 extension configuration is invalid.\n',
    );
    expect(connect).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('keeps unexpected startup errors opaque', async () => {
    loadRuntimeConfiguration.mockRejectedValue(
      new Error('/secret/path token=secret'),
    );
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await import('./main.js');

    expect(write).toHaveBeenCalledWith(
      'Mem0 external context extension failed to start.\n',
    );
    expect(connect).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
