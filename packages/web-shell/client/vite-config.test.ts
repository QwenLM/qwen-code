/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConfigEnv, ProxyOptions, UserConfig } from 'vite';
import viteConfig, {
  BRAND_ROUTE_PROXY,
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
});

describe('Web Shell daemon API proxy coverage', () => {
  it.each(['/standalone'])('proxies %s API routes', (prefix) => {
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
