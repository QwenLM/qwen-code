/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import type {
  Browser,
  BrowserContext,
  BrowserType,
  Frame,
  Page,
} from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { startFakeOpenAIServer } from '../fake-openai-server.js';
import type { spawnDaemon, SpawnedDaemon } from '../cli/_daemon-harness.js';
import {
  SHOW_TOOL,
  startAcceptanceEnv,
  waitForCardOn,
  type AcceptanceEnv,
} from './harness.js';

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

function liveMode(port: number) {
  return {
    kind: 'live',
    model: {
      label: 'test',
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      model: 'test',
    },
  } as const;
}

describe('acceptance environment startup', () => {
  it.each(['replay', 'live'] as const)(
    'waits for MCP discovery before the first %s prompt',
    async (kind) => {
      vi.stubEnv('QWEN_CODE_LEGACY_MCP_BLOCKING', '0');
      let env: AcceptanceEnv | undefined;
      try {
        env = await startAcceptanceEnv({
          mode: kind === 'replay' ? options.mode : liveMode(1),
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

  it('authorizes only the Generated UI call and its bundled skill', async () => {
    const env = await startAcceptanceEnv(options);
    try {
      const settings = JSON.parse(
        await fs.readFile(path.join(env.root, 'home', 'settings.json'), 'utf8'),
      );
      expect(settings.tools.approvalMode).toBe('default');
      expect(settings.permissions.allow).toEqual([
        SHOW_TOOL,
        'Skill(generated-ui)',
      ]);
      expect(settings.permissions.deny).toEqual(
        expect.arrayContaining([
          'run_shell_command',
          'edit',
          'write_file',
          'agent',
          'workflow',
        ]),
      );
      expect(settings.mcp.allowed).toEqual(['generated-ui']);
    } finally {
      await env.close();
    }
  });
});

describe('acceptance daemon environment', () => {
  it('starts the daemon without the operator environment', async () => {
    vi.stubEnv('QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP', '1');
    vi.stubEnv('QWEN_GENERATED_UI_LIVE_API_KEY', 'operator-secret');
    vi.stubEnv('OPENAI_BASE_URL', 'https://operator.invalid/v1');
    vi.stubEnv('PATH', '/operator/bin');
    let env: AcceptanceEnv | undefined;
    try {
      env = await startAcceptanceEnv(options);
      const daemonEnv = mocks.spawnDaemon.mock.calls[0]?.[0]?.env ?? {};
      // Blank values override what the daemon would inherit from the parent.
      expect(daemonEnv['QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP']).toBe('');
      expect(daemonEnv['QWEN_GENERATED_UI_LIVE_API_KEY']).toBe('');
      expect(daemonEnv['OPENAI_BASE_URL']).toBe('http://127.0.0.1:12345');
      expect(daemonEnv['PATH']).toBe('/operator/bin');
      expect(
        Object.values(daemonEnv).filter((value) => value.includes('operator')),
      ).toEqual(['/operator/bin']);
    } finally {
      await env?.close();
      vi.unstubAllEnvs();
    }
  });
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
  function proxyFetch(init?: RequestInit) {
    const env = mocks.spawnDaemon.mock.calls[0][0]?.env;
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${env?.['OPENAI_API_KEY']}`);
    return fetch(`${env?.['OPENAI_BASE_URL']}/chat/completions`, {
      ...init,
      headers,
    });
  }

  it('authenticates clients before recording or forwarding', async () => {
    const authorizations: Array<string | undefined> = [];
    const upstream = createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      response.end('ok');
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    let env: AcceptanceEnv | undefined;
    try {
      env = await startAcceptanceEnv({
        mode: liveMode((upstream.address() as AddressInfo).port),
      });
      const daemonEnv = mocks.spawnDaemon.mock.calls[0][0]?.env;
      const url = `${daemonEnv?.['OPENAI_BASE_URL']}/chat/completions`;
      const body = JSON.stringify({
        messages: [{ role: 'user', content: 'test message' }],
      });
      expect(daemonEnv?.['OPENAI_API_KEY']).toMatch(/^[a-f0-9]{64}$/);

      const missing = await fetch(url, { method: 'POST', body });
      expect(missing.status).toBe(401);
      const invalid = await fetch(url, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-key' },
        body,
      });
      expect(invalid.status).toBe(401);
      expect(authorizations).toEqual([]);
      expect(env.requests).toEqual([]);

      const valid = await proxyFetch({ method: 'POST', body });
      expect(await valid.text()).toBe('ok');
      expect(authorizations).toEqual(['Bearer test-key']);
      expect(env.requests).toMatchObject([{ lastUserText: 'test message' }]);
    } finally {
      await env?.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it.each(['client disconnect', 'proxy close'])(
    'cancels upstream generation after %s',
    async (cause) => {
      let upstreamClosed = false;
      let requests = 0;
      const upstream = createServer((_request, response) => {
        if (requests++ > 0) {
          response.end('ok');
          return;
        }
        response.on('close', () => {
          upstreamClosed = true;
        });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: partial\n\n');
      });
      await new Promise<void>((resolve) =>
        upstream.listen(0, '127.0.0.1', resolve),
      );
      let env: AcceptanceEnv | undefined;
      const controller = new AbortController();
      try {
        const { port } = upstream.address() as AddressInfo;
        env = await startAcceptanceEnv({ mode: liveMode(port) });
        const response = await proxyFetch({
          signal: controller.signal,
        });
        const first = await response.body!.getReader().read();
        expect(new TextDecoder().decode(first.value)).toBe('data: partial\n\n');
        if (cause === 'client disconnect') controller.abort();
        else await env.close();

        await expect.poll(() => upstreamClosed, { timeout: 2_000 }).toBe(true);
        if (cause === 'client disconnect') {
          const next = await proxyFetch();
          expect(await next.text()).toBe('ok');
        }
      } finally {
        controller.abort();
        await env?.close();
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
      }
    },
  );

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
        env = await startAcceptanceEnv({ mode: liveMode(port) });
        const signal = AbortSignal.timeout(5_000);
        const response = await proxyFetch({
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
        const next = await proxyFetch();
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

describe('card readiness', () => {
  it('finds visible content when the first element is hidden', async () => {
    const app = { name: () => 'app' } as Frame;
    const view = {
      name: () => 'view',
      parentFrame: () => app,
      isDetached: () => false,
      locator: (selector: string) => ({
        first: () => ({ isVisible: async () => selector === 'body *:visible' }),
      }),
    } as unknown as Frame;
    const page = {
      frames: () => [app, view],
      waitForTimeout: async () => {},
    } as unknown as Page;

    await expect(waitForCardOn(page, 0, 20)).resolves.toEqual({ view, app });
  });
});
