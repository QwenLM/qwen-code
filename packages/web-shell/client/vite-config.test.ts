/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConfigEnv, ProxyOptions, UserConfig } from 'vite';
import viteConfig, {
  QUALIFIED_VOICE_STREAM_PROXY,
  QUALIFIED_TERMINAL_PROXY,
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

  it('proxies only qualified terminal attach upgrades', () => {
    const config = loadConfig();
    const terminal = config.server?.proxy?.[QUALIFIED_TERMINAL_PROXY];

    expect(terminal).not.toBeTypeOf('string');
    expect(terminal && typeof terminal !== 'string' ? terminal.ws : false).toBe(
      true,
    );
    // The attach URL carries the session/task query pair.
    expect(
      new RegExp(QUALIFIED_TERMINAL_PROXY).test(
        '/terminal?sessionId=sess-1&taskId=bg_abc123',
      ),
    ).toBe(true);
    expect(new RegExp(QUALIFIED_TERMINAL_PROXY).test('/terminal')).toBe(true);
    // The client's own `client/terminal/*` source modules must be served by
    // vite, not proxied to the daemon.
    expect(
      new RegExp(QUALIFIED_TERMINAL_PROXY).test(
        '/terminal/useTerminalSocket.ts',
      ),
    ).toBe(false);
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
