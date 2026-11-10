/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import type { Browser, BrowserContext, BrowserType, Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { startFakeOpenAIServer } from '../fake-openai-server.js';
import type { spawnDaemon, SpawnedDaemon } from '../cli/_daemon-harness.js';
import { startAcceptanceEnv, type AcceptanceEnv } from './harness.js';

const mocks = vi.hoisted(() => ({
  startFakeOpenAIServer: vi.fn<typeof startFakeOpenAIServer>(),
  spawnDaemon: vi.fn<typeof spawnDaemon>(),
  launch: vi.fn<BrowserType['launch']>(),
  newContext: vi.fn<Browser['newContext']>(),
  grantPermissions: vi.fn<BrowserContext['grantPermissions']>(),
  newPage: vi.fn<BrowserContext['newPage']>(),
  goto: vi.fn<Page['goto']>(),
  browserClose: vi.fn<Browser['close']>(),
  daemonDispose: vi.fn<SpawnedDaemon['dispose']>(),
  backendClose: vi.fn<() => Promise<void>>(),
}));

vi.mock('playwright', () => ({ chromium: { launch: mocks.launch } }));
vi.mock('../fake-openai-server.js', () => ({
  startFakeOpenAIServer: mocks.startFakeOpenAIServer,
}));
vi.mock('../cli/_daemon-harness.js', () => ({
  DEFAULT_CLI_BIN: '/test/cli.js',
  spawnDaemon: mocks.spawnDaemon,
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.backendClose.mockResolvedValue(undefined);
  mocks.daemonDispose.mockResolvedValue(undefined);
  mocks.browserClose.mockResolvedValue(undefined);
  mocks.startFakeOpenAIServer.mockResolvedValue({
    baseUrl: 'http://127.0.0.1:12345',
    requests: [],
    close: mocks.backendClose,
  });
  mocks.spawnDaemon.mockResolvedValue({
    base: 'http://127.0.0.1:23456',
    token: 'test-token',
    dispose: mocks.daemonDispose,
  } as unknown as SpawnedDaemon);
  mocks.launch.mockResolvedValue({
    newContext: mocks.newContext,
    close: mocks.browserClose,
  } as unknown as Browser);
  mocks.newContext.mockResolvedValue({
    grantPermissions: mocks.grantPermissions,
    newPage: mocks.newPage,
  } as unknown as BrowserContext);
  mocks.grantPermissions.mockResolvedValue(undefined);
  mocks.newPage.mockResolvedValue({
    on: vi.fn(),
    goto: mocks.goto,
  } as unknown as Page);
  mocks.goto.mockResolvedValue(null);
});

afterEach(async () => {
  const home = mocks.spawnDaemon.mock.calls[0]?.[0]?.env?.['QWEN_HOME'];
  if (home) await fs.rm(path.dirname(home), { recursive: true, force: true });
});

const options = {
  mode: { kind: 'replay', script: () => ({ content: '' }) },
} as const;

describe('acceptance environment startup', () => {
  it.each(['replay', 'live'] as const)(
    'waits for MCP discovery before the first %s prompt',
    async (kind) => {
      vi.stubEnv('QWEN_CODE_LEGACY_MCP_BLOCKING', '0');
      let env: AcceptanceEnv | undefined;
      try {
        env = await startAcceptanceEnv({
          mode:
            kind === 'replay'
              ? options.mode
              : {
                  kind,
                  model: {
                    label: 'test',
                    baseUrl: 'http://127.0.0.1:1',
                    apiKey: 'test-key',
                    model: 'test',
                  },
                },
        });
        expect(mocks.spawnDaemon).toHaveBeenCalledWith(
          expect.objectContaining({
            env: expect.objectContaining({
              QWEN_CODE_LEGACY_MCP_BLOCKING: '1',
            }),
          }),
        );
      } finally {
        await env?.close();
        vi.unstubAllEnvs();
      }
    },
  );
});

describe('acceptance environment setup cleanup', () => {
  it.each([
    ['daemon creation', mocks.spawnDaemon, false, false],
    ['browser launch', mocks.launch, true, false],
    ['context creation', mocks.newContext, true, true],
    ['permission setup', mocks.grantPermissions, true, true],
    ['page creation', mocks.newPage, true, true],
    ['page navigation', mocks.goto, true, true],
  ] as const)('cleans up after failed %s', async (_, fail, daemon, browser) => {
    const error = new Error('setup failed');
    fail.mockRejectedValueOnce(error);

    await expect(startAcceptanceEnv(options)).rejects.toBe(error);

    expect(mocks.backendClose).toHaveBeenCalledTimes(1);
    expect(mocks.daemonDispose).toHaveBeenCalledTimes(daemon ? 1 : 0);
    expect(mocks.browserClose).toHaveBeenCalledTimes(browser ? 1 : 0);
  });

  it('preserves the setup error and continues cleanup when closing fails', async () => {
    const error = new Error('navigation failed');
    mocks.goto.mockRejectedValueOnce(error);
    mocks.browserClose.mockRejectedValueOnce(new Error('browser close failed'));
    mocks.daemonDispose.mockRejectedValueOnce(new Error('daemon close failed'));
    mocks.backendClose.mockRejectedValueOnce(new Error('backend close failed'));

    await expect(startAcceptanceEnv(options)).rejects.toBe(error);

    expect(mocks.browserClose).toHaveBeenCalledTimes(1);
    expect(mocks.daemonDispose).toHaveBeenCalledTimes(1);
    expect(mocks.backendClose).toHaveBeenCalledTimes(1);
  });
});

describe('live recording proxy', () => {
  it.each([false, true])(
    'handles an upstream reset with headersSent=%s',
    async (afterHeaders) => {
      let failedResponse: ServerResponse | undefined;
      let requests = 0;
      const upstream = createServer((_request, response) => {
        if (requests++ > 0) {
          response.end('ok');
        } else if (afterHeaders) {
          failedResponse = response;
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write('data: partial\n\n');
        } else {
          response.destroy();
        }
      });
      await new Promise<void>((resolve) =>
        upstream.listen(0, '127.0.0.1', resolve),
      );
      let env: AcceptanceEnv | undefined;
      try {
        const { port } = upstream.address() as AddressInfo;
        env = await startAcceptanceEnv({
          mode: {
            kind: 'live',
            model: {
              label: 'test',
              baseUrl: `http://127.0.0.1:${port}`,
              apiKey: 'test-key',
              model: 'test',
            },
          },
        });
        const baseUrl =
          mocks.spawnDaemon.mock.calls[0][0]?.env?.['OPENAI_BASE_URL'];
        const signal = AbortSignal.timeout(5_000);
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          body: '{}',
          signal,
        });
        if (afterHeaders) {
          expect(response.status).toBe(200);
          const reader = response.body!.getReader();
          const first = await reader.read();
          expect(new TextDecoder().decode(first.value)).toBe(
            'data: partial\n\n',
          );
          failedResponse!.destroy();
          await expect(reader.read()).rejects.toThrow();
          expect(signal.aborted).toBe(false);
        } else {
          expect(response.status).toBe(502);
          expect(await response.json()).toEqual({
            error: { message: expect.any(String) },
          });
        }
        const next = await fetch(`${baseUrl}/chat/completions`);
        expect(next.status).toBe(200);
        expect(await next.text()).toBe('ok');
      } finally {
        await env?.close();
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
      }
    },
  );
});
