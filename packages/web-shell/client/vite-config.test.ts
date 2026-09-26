/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { preview } from 'vite';
import type { ConfigEnv, ProxyOptions, UserConfig } from 'vite';
import viteConfig, {
  BRAND_ROUTE_PROXY,
  MANAGED_AGENT_JAVA_ROUTE_PROXY,
  QUALIFIED_ACP_WS_PROXY,
  QUALIFIED_VOICE_STREAM_PROXY,
} from '../vite.config';

function loadConfig(): UserConfig {
  const factory = viteConfig as (env: ConfigEnv) => UserConfig;
  return factory({
    command: 'serve',
    mode: 'test',
    isSsrBuild: false,
    isPreview: false,
  });
}

it.each([
  [undefined, false],
  ['0', false],
  [' FALSE ', false],
  ['1', true],
  [' TRUE ', true],
  ['', true],
] as const)(
  'serves preview documents with CSP scoped to the selected daemon (desktop=%s)',
  async (desktopRelay, enabled) => {
    vi.stubEnv('QWEN_SERVE_CLIENT_MCP_OVER_WS', desktopRelay);
    onTestFinished(() => vi.unstubAllEnvs());
    const dist = await mkdtemp(join(tmpdir(), 'web-shell-preview-'));
    onTestFinished(() => rm(dist, { recursive: true, force: true }));
    await writeFile(
      join(dist, 'index.html'),
      '<!doctype html><title>Preview</title>',
    );
    const server = await preview({
      ...loadConfig(),
      configFile: false,
      build: { outDir: dist },
      preview: { host: '127.0.0.1', port: 0 },
    });
    onTestFinished(() => server.close());
    const baseUrl = server.resolvedUrls!.local[0];
    for (const [query, expected] of [
      [
        '?daemon=https%3A%2F%2Fdaemon.example.com%3A4170',
        "connect-src 'self' https://daemon.example.com:4170 wss://daemon.example.com:4170",
      ],
      ['//', "connect-src 'self'"],
      ['', "connect-src 'self'"],
    ]) {
      const response = await fetch(`${baseUrl}${query}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<title>Preview</title>');
      expect(
        response.headers.get('Content-Security-Policy')?.split('; '),
      ).toContain(expected + (enabled ? ' http://127.0.0.1:47821' : ''));
    }
  },
);

describe('Web Shell Voice development proxy', () => {
  it('proxies only qualified Voice stream upgrades', () => {
    const config = loadConfig();
    const proxy = config.server?.proxy;
    const qualified = proxy?.[QUALIFIED_VOICE_STREAM_PROXY];

    expect(qualified).not.toBeTypeOf('string');
    expect(
      qualified && typeof qualified !== 'string' ? qualified.ws : false,
    ).toBe(true);
    expect(
      new RegExp(QUALIFIED_VOICE_STREAM_PROXY).test(
        '/workspaces/id/voice/stream',
      ),
    ).toBe(true);
    expect(
      new RegExp(QUALIFIED_VOICE_STREAM_PROXY).test('/voice/voiceModels.ts'),
    ).toBe(false);
  });
});

describe('Web Shell local-files development proxy', () => {
  it('proxies qualified ACP WebSocket upgrades for secondary workspaces', () => {
    const config = loadConfig();
    const proxy = config.server?.proxy;
    const qualified = proxy?.[QUALIFIED_ACP_WS_PROXY];

    expect(qualified).not.toBeTypeOf('string');
    expect(
      qualified && typeof qualified !== 'string' ? qualified.ws : false,
    ).toBe(true);
    expect(new RegExp(QUALIFIED_ACP_WS_PROXY).test('/workspaces/id/acp')).toBe(
      true,
    );
    expect(new RegExp(QUALIFIED_ACP_WS_PROXY).test('/acp')).toBe(false);
    expect(new RegExp(QUALIFIED_ACP_WS_PROXY).test('/workspaces/a/b/acp')).toBe(
      false,
    );
  });
});

describe('Web Shell brand development proxy', () => {
  it('proxies the brand route without claiming the brandContext source module', () => {
    const proxy = loadConfig().server?.proxy;
    const brand = proxy?.[BRAND_ROUTE_PROXY];

    expect(brand).not.toBeTypeOf('string');
    expect(brand).toBeDefined();
    // A bare `/brand` prefix also matches `/brandContext.ts`, the client source
    // module main.tsx and App.tsx import for a value; proxying that to the
    // daemon stops the module graph from loading and blanks the dev page.
    expect(new RegExp(BRAND_ROUTE_PROXY).test('/brand')).toBe(true);
    expect(new RegExp(BRAND_ROUTE_PROXY).test('/brand/')).toBe(true);
    expect(new RegExp(BRAND_ROUTE_PROXY).test('/brandContext.ts')).toBe(false);
  });
});

describe('Web Shell MCP App development proxy', () => {
  it('proxies the sandbox document to the daemon', () => {
    const sandboxProxy = loadConfig().server?.proxy?.['/mcp-app-sandbox'];
    expect(sandboxProxy).not.toBeTypeOf('string');
    expect(sandboxProxy).toBeDefined();
    expect((sandboxProxy as ProxyOptions).bypass).toBeUndefined();
  });
});

describe('Web Shell standalone session development proxy', () => {
  it('proxies standalone session routes to the daemon', () => {
    const proxy = loadConfig().server?.proxy;
    expect(proxy?.['/standalone/sessions']).toBe(proxy?.['/session']);
  });
});

describe('Web Shell Java Managed Agent development proxy', () => {
  it('proxies only the public Java WebShell API prefix', () => {
    const proxy = loadConfig().server?.proxy;
    const managed = proxy?.[MANAGED_AGENT_JAVA_ROUTE_PROXY];

    expect(managed).not.toBeTypeOf('string');
    expect(managed).toBeDefined();
    expect((managed as ProxyOptions).target).toBe('http://127.0.0.1:8080');
    expect(MANAGED_AGENT_JAVA_ROUTE_PROXY).toBe('/api/agent/web-shell/v1');
  });
});

describe('Web Shell client source proxy bypass', () => {
  it('serves session catalog source modules instead of proxying them', () => {
    const sessionProxy = loadConfig().server?.proxy?.['/session'];
    expect(sessionProxy).not.toBeTypeOf('string');
    expect(sessionProxy).toBeDefined();
    const options = sessionProxy as ProxyOptions;
    const request = {
      method: 'GET',
      url: '/session-catalog/session-catalog-hooks.ts',
      headers: { 'sec-fetch-dest': 'script' },
    } as unknown as IncomingMessage;

    expect(
      options.bypass?.(request, {} as unknown as ServerResponse, options),
    ).toBe(request.url);
  });

  it('serves live source modules instead of proxying them', () => {
    const liveProxy = loadConfig().server?.proxy?.['/live'];
    expect(liveProxy).not.toBeTypeOf('string');
    expect(liveProxy).toBeDefined();
    const options = liveProxy as ProxyOptions;
    const request = {
      method: 'GET',
      url: '/live/useLiveVoice.ts',
      headers: { 'sec-fetch-dest': 'script' },
    } as unknown as IncomingMessage;

    expect(
      options.bypass?.(request, {} as unknown as ServerResponse, options),
    ).toBe(request.url);
  });
});

describe('Web Shell daemon API proxy coverage', () => {
  it.each(['/standalone', '/live'])('proxies %s API routes', (prefix) => {
    const proxy = loadConfig().server?.proxy?.[prefix];
    expect(proxy).not.toBeTypeOf('string');
    expect(proxy).toBeDefined();
    const options = proxy as ProxyOptions;
    const request = {
      method: 'GET',
      url: `${prefix}/status`,
      headers: { accept: '*/*' },
    } as unknown as IncomingMessage;

    // API fetches must NOT bypass to the shell; undefined means "proxy it".
    expect(
      options.bypass?.(request, {} as unknown as ServerResponse, options),
    ).toBeUndefined();
  });
});

describe('Web Shell remote workspace development proxy', () => {
  // Proxy keys are path-prefix matches, so the `/workspace` entry cannot reach
  // `/remote-workspace*`. Without their own entries the SPA fallback answers
  // the browse leg with index.html and the dialog fails JSON parsing in dev.
  it.each([
    {
      key: '/remote-workspace-path-suggestions',
      method: 'GET',
      url: '/remote-workspace-path-suggestions?daemon=http%3A%2F%2Fb.test%3A4170&prefix=%2Fsrv%2F',
    },
    { key: '/remote-workspaces', method: 'POST', url: '/remote-workspaces' },
  ])('proxies $key to the daemon', ({ key, method, url }) => {
    const proxy = loadConfig().server?.proxy;
    expect(proxy?.[key]).not.toBeTypeOf('string');
    const options = proxy?.[key] as ProxyOptions | undefined;
    expect(options).toBeDefined();
    const request = {
      method,
      url,
      headers: { accept: '*/*' },
    } as unknown as IncomingMessage;

    expect(
      options?.bypass?.(request, {} as unknown as ServerResponse, options),
    ).toBeUndefined();
  });
});
