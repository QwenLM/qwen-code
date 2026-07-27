/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvHttpProxyAgent } from 'undici';

const runMcp = vi.hoisted(() => vi.fn());
const setGlobalDispatcher = vi.hoisted(() => vi.fn());
const proxyEnvironmentNames = [
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'no_proxy',
  'NO_PROXY',
] as const;

vi.mock('./mcp.js', () => ({ runMcp }));
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  setGlobalDispatcher,
}));

let previousExitCode: string | number | undefined;

beforeEach(() => {
  vi.resetModules();
  runMcp.mockReset();
  setGlobalDispatcher.mockReset();
  previousExitCode = process.exitCode;
  for (const name of proxyEnvironmentNames) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('external context startup', () => {
  it('installs an environment-aware HTTP proxy dispatcher', async () => {
    runMcp.mockResolvedValue(undefined);

    await import('./main.js');

    expect(setGlobalDispatcher).toHaveBeenCalledWith(
      expect.any(EnvHttpProxyAgent),
    );
    expect(runMcp).toHaveBeenCalledOnce();
  });

  it('prints a sanitized error for invalid proxy configuration', async () => {
    process.env['HTTP_PROXY'] = 'not a URL';
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await import('./main.js');

    expect(write).toHaveBeenCalledWith(
      '[external-context] Proxy environment configuration is invalid. Check HTTP_PROXY, HTTPS_PROXY, and NO_PROXY.\n',
    );
    expect(runMcp).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('prints sanitized configuration errors', async () => {
    const { ConfigurationError } = await import('./config.js');
    runMcp.mockRejectedValue(
      new ConfigurationError('External context config is not valid JSON.'),
    );
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await import('./main.js');

    expect(write).toHaveBeenCalledWith(
      '[external-context] External context config is not valid JSON.\n',
    );
    expect(process.exitCode).toBe(1);
  });

  it('keeps unexpected startup errors opaque', async () => {
    runMcp.mockRejectedValue(new Error('/secret/path and credential'));
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await import('./main.js');

    expect(write).toHaveBeenCalledWith(
      '[external-context] External context startup failed.\n',
    );
  });
});
