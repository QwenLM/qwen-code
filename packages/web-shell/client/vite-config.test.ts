/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConfigEnv, ProxyOptions, UserConfig } from 'vite';
import viteConfig, { QUALIFIED_VOICE_STREAM_PROXY } from '../vite.config';

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

describe('Web Shell MCP App development proxy', () => {
  it('proxies the sandbox document to the daemon', () => {
    const sandboxProxy = loadConfig().server?.proxy?.['/mcp-app-sandbox'];
    expect(sandboxProxy).not.toBeTypeOf('string');
    expect(sandboxProxy).toBeDefined();
    expect((sandboxProxy as ProxyOptions).bypass).toBeUndefined();
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
