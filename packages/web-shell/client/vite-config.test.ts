/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { preview } from 'vite';
import type { ConfigEnv, ProxyOptions, UserConfig } from 'vite';
import viteConfig, {
  BRAND_ROUTE_PROXY,
  createDevelopmentMiddleware,
  MANAGED_AGENT_JAVA_ROUTE_PROXY,
  MANAGED_AGENT_PUBLIC_ROUTE_PROXY,
  probeHostname,
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

describe('Web Shell settings development route', () => {
  function runMiddleware(method: string, url: string, accept?: string) {
    const req = {
      method,
      url,
      headers: accept ? { accept } : {},
    } as unknown as IncomingMessage;
    const res = { setHeader: vi.fn() } as unknown as ServerResponse;
    const next = vi.fn();

    createDevelopmentMiddleware()(req, res, next);
    return { req, res, next };
  }

  it.each(['/settings', '/settings?theme=dark', '/settings/'])(
    'rewrites %s to the SPA document',
    (url) => {
      const { req, res, next } = runMiddleware('GET', url, 'text/html');

      expect(req.url).toBe('/index.html');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Security-Policy',
        expect.stringContaining("default-src 'self'"),
      );
      expect(next).toHaveBeenCalledOnce();
    },
  );

  it('does not claim the settings source module', () => {
    const { req, next } = runMiddleware('GET', '/settings.ts', 'text/html');

    expect(req.url).toBe('/settings.ts');
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([
    ['POST', '/settings', 'text/html'],
    ['GET', '/settings', '*/*'],
  ])('leaves non-document requests untouched', (method, url, accept) => {
    const { req } = runMiddleware(method, url, accept);

    expect(req.url).toBe(url);
  });
});

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
  it('proxies Java WebShell metadata and public artifact bytes', () => {
    const proxy = loadConfig().server?.proxy;
    const managed = proxy?.[MANAGED_AGENT_JAVA_ROUTE_PROXY];

    expect(managed).not.toBeTypeOf('string');
    expect(managed).toBeDefined();
    // Compare against the same expression the config uses: the README's
    // dual-path setup exports this variable for real development.
    expect((managed as ProxyOptions).target).toBe(
      process.env['QWEN_MANAGED_AGENT_JAVA_URL'] ?? 'http://127.0.0.1:8080',
    );
    expect(MANAGED_AGENT_JAVA_ROUTE_PROXY).toBe('/api/agent/web-shell/v1');
    expect(MANAGED_AGENT_PUBLIC_ROUTE_PROXY).toBe('/v1/agents');
    expect(proxy?.[MANAGED_AGENT_PUBLIC_ROUTE_PROXY]).toBe(managed);
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
  // Without its own entry the SPA fallback answers these with index.html in
  // dev and the page fails JSON parsing on open.
  it.each([
    { prefix: '/standalone', url: '/standalone/status' },
    { prefix: '/live', url: '/live/status' },
    // The only unqualified route in this namespace is the watches listing.
    { prefix: '/autofix-pr', url: '/autofix-pr/watches' },
  ])('proxies $prefix API routes', ({ prefix, url }) => {
    const proxy = loadConfig().server?.proxy?.[prefix];
    expect(proxy).not.toBeTypeOf('string');
    expect(proxy).toBeDefined();
    const options = proxy as ProxyOptions;
    const request = {
      method: 'GET',
      url,
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

describe('Web Shell launcher-supplied open path', () => {
  // scripts/managed-agent-dev.js hands the token-bearing open path through
  // the environment instead of argv; server.open is where it lands.
  it('opens the path QWEN_WEB_SHELL_OPEN_PATH carries', () => {
    vi.stubEnv('QWEN_WEB_SHELL_OPEN_PATH', '/?managed=1&token=PROBETOKEN');
    onTestFinished(() => vi.unstubAllEnvs());

    expect(loadConfig().server?.open).toBe('/?managed=1&token=PROBETOKEN');
  });

  it('stays closed when no launcher set the variable', () => {
    vi.stubEnv('QWEN_WEB_SHELL_OPEN_PATH', undefined);
    onTestFinished(() => vi.unstubAllEnvs());

    expect(loadConfig().server?.open).toBeUndefined();
  });
});

describe('Web Shell daemon target fallback', () => {
  // daemonTarget is bound at module evaluation, so observing an env change
  // needs a fresh module registry, not just another call to the factory.
  it('falls back to the default daemon target for an empty QWEN_DAEMON_URL', async () => {
    vi.stubEnv('QWEN_DAEMON_URL', '');
    onTestFinished(() => vi.unstubAllEnvs());
    vi.resetModules();

    const { default: config } = await import('../vite.config');
    const options = (config as (env: ConfigEnv) => UserConfig)({
      command: 'serve',
      mode: 'test',
      isSsrBuild: false,
      isPreview: false,
    }).server?.proxy?.['/session'] as ProxyOptions;

    expect(options.target).toBe('http://127.0.0.1:4170');
  });
});

describe('Web Shell daemon proxy failure', () => {
  function emitProxyError(res: unknown) {
    const options = loadConfig().server?.proxy?.['/session'] as ProxyOptions;
    const proxy = new EventEmitter();
    (options.configure as (proxy: EventEmitter) => void)(proxy);
    proxy.emit(
      'error',
      new Error('connect ECONNREFUSED 127.0.0.1:59999'),
      {} as IncomingMessage,
      res,
    );
  }

  it('answers an unreachable daemon with a labeled 502 instead of an empty 500', () => {
    const res = {
      headersSent: false,
      writableEnded: false,
      writeHead: vi.fn(),
      end: vi.fn(),
    };

    emitProxyError(res);

    expect(res.writeHead).toHaveBeenCalledWith(502, {
      'content-type': 'application/json',
    });
    const body = JSON.parse(String(res.end.mock.calls[0]?.[0]));
    expect(body.code).toBe('daemon_unreachable');
    // readDaemonError surfaces `error` to the operator; the sentence with
    // the target and errno must live there, not under a machine token.
    expect(body.error).toContain('ECONNREFUSED');
    // The fixture port deliberately avoids the substring `4170`, so this
    // pins the daemon target sentence rather than the injected errno text.
    expect(body.error).toContain('No daemon answered at http://127.0.0.1:4170');
  });

  it('leaves an already-answered response alone', () => {
    const res = {
      headersSent: true,
      writableEnded: false,
      writeHead: vi.fn(),
      end: vi.fn(),
    };

    emitProxyError(res);

    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('does not write an HTTP response onto a websocket upgrade socket', () => {
    const res = { destroy: vi.fn() };

    expect(() => emitProxyError(res)).not.toThrow();
  });
});

describe('Web Shell daemon probe hostname', () => {
  // The launcher's `--hostname ::1` exports QWEN_DAEMON_URL=http://[::1]:<port>.
  // WHATWG URL keeps the brackets, so a raw `.hostname` hands net the literal
  // "[::1]", which fails name resolution instead of connecting.
  it.each([
    ['http://[::1]:51840', '::1'],
    // Node compresses an explicit long form to `[::1]` before it reaches us.
    ['http://[0:0:0:0:0:0:0:1]:51840', '::1'],
    ['http://127.0.0.1:4170', '127.0.0.1'],
    ['http://daemon.internal:8080', 'daemon.internal'],
  ])('probes %s as host %s', (target, expected) => {
    expect(probeHostname(new URL(target).hostname)).toBe(expected);
  });
});
