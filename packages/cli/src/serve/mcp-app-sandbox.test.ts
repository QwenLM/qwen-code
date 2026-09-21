/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express, {
  type Application,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { runInNewContext } from 'node:vm';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMcpAppCsp,
  mountMcpAppSandbox,
  parseMcpAppCsp,
} from './mcp-app-sandbox.js';

describe('MCP App sandbox', () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });
  const makeApp = () => {
    const app = express();
    disposers.push(mountMcpAppSandbox(app));
    return app;
  };
  const readSandbox = (location: string, path = '/mcp-app-sandbox') => {
    const url = new URL(location);
    return request(`http://127.0.0.1:${url.port}`)
      .get(path)
      .set('Host', url.host);
  };

  it('keeps declared origins and drops CSP injection attempts', () => {
    const parsed = parseMcpAppCsp(
      JSON.stringify({
        connectDomains: [
          'https://api.example.com',
          'HTTPS://API2.EXAMPLE.COM',
          'https://bad.test; script-src *',
        ],
        resourceDomains: ['https://*.example.com'],
      }),
    );

    expect(buildMcpAppCsp(parsed)).toContain(
      "connect-src 'self' https://api.example.com",
    );
    expect(buildMcpAppCsp(parsed)).toContain('HTTPS://API2.EXAMPLE.COM');
    expect(buildMcpAppCsp(parsed)).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https://*.example.com",
    );
    expect(buildMcpAppCsp(parsed)).toContain("form-action 'none'");
    expect(buildMcpAppCsp(parsed)).not.toContain('bad.test');
  });

  it('keeps declared frame and base-uri origins', () => {
    const parsed = parseMcpAppCsp(
      JSON.stringify({
        frameDomains: ['https://frames.example.com'],
        baseUriDomains: ['https://base.example.com'],
      }),
    );

    expect(buildMcpAppCsp(parsed)).toContain(
      'frame-src https://frames.example.com',
    );
    expect(buildMcpAppCsp(parsed)).toContain(
      'base-uri https://base.example.com',
    );
    expect(buildMcpAppCsp(parsed)).toContain("form-action 'none'");
  });

  it('redirects to an isolated one-use origin with server-pinned CSP', async () => {
    const app = makeApp();
    const redirect = await request(app)
      .get('/mcp-app-sandbox')
      .query({ hostOrigin: 'http://127.0.0.1:4170' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers['cache-control']).toBe('no-store');
    expect(redirect.text).not.toContain('sandbox-proxy-ready');
    const url = new URL(redirect.headers['location']);
    expect(url.hostname).toMatch(/^[a-f0-9-]{36}\.localhost$/);
    expect(url.search).toBe('');
    expect((await readSandbox(url.href, '/session')).status).toBe(404);
    expect(
      (await readSandbox(url.href, '/mcp-app-sandbox?csp=changed')).status,
    ).toBe(404);
    const response = await readSandbox(url.href);
    expect(response.status).toBe(200);
    expect(response.headers['content-security-policy']).toContain(
      "frame-src 'none'",
    );
    expect(response.headers['content-security-policy']).toContain(
      "form-action 'none'",
    );
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['origin-agent-cluster']).toBe('?1');
    expect(response.text).toContain(
      "'allow-scripts allow-forms allow-same-origin'",
    );
    expect(response.text).not.toContain("inner.setAttribute('allow'");
    expect((await readSandbox(url.href)).status).toBe(404);

    const script = response.text.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    const inner = {
      setAttribute: vi.fn(),
      style: {},
      contentWindow: { postMessage: vi.fn() },
    };
    const parent = { postMessage: vi.fn() };
    const addEventListener = vi.fn();
    runInNewContext(script!, {
      window: {
        self: {},
        top: {},
        parent,
        location: { origin: url.origin },
        addEventListener,
      },
      document: { createElement: () => inner, body: { appendChild: vi.fn() } },
    });
    const onMessage = addEventListener.mock.calls[0][1];
    onMessage({
      source: parent,
      origin: 'http://other.localhost',
      data: {
        method: 'ui/notifications/sandbox-resource-ready',
        params: { html: 'wrong' },
      },
    });
    expect(inner).not.toHaveProperty('srcdoc');
    onMessage({
      source: parent,
      origin: 'http://127.0.0.1:4170',
      data: {
        method: 'ui/notifications/sandbox-resource-ready',
        params: { html: 'right' },
      },
    });
    expect(inner).toHaveProperty('srcdoc', 'right');
    parent.postMessage.mockClear();
    onMessage({ source: inner.contentWindow, origin: 'null', data: 'wrong' });
    expect(parent.postMessage).not.toHaveBeenCalled();
    onMessage({
      source: inner.contentWindow,
      origin: url.origin,
      data: 'right',
    });
    expect(parent.postMessage).toHaveBeenCalledWith(
      'right',
      'http://127.0.0.1:4170',
    );
  });

  it('settles a registration when shutdown races initial listener startup', async () => {
    let handle!: (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => Promise<void>;
    const app = {
      get: (_path: string, handler: typeof handle) => {
        handle = handler;
      },
    } as unknown as Application;
    const dispose = mountMcpAppSandbox(app);
    disposers.push(dispose);
    const next = vi.fn();
    const response = {
      status: vi.fn().mockReturnThis(),
      end: vi.fn(),
      redirect: vi.fn(),
    };
    const registration = handle(
      { query: { hostOrigin: 'http://127.0.0.1:4170' } } as unknown as Request,
      response as unknown as Response,
      next,
    );
    dispose();
    await registration;
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(response.redirect).not.toHaveBeenCalled();
  });

  it('assigns concurrent Apps distinct origins on one static listener', async () => {
    const app = makeApp();
    const replies = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(app)
          .get('/mcp-app-sandbox')
          .query({ hostOrigin: 'http://localhost:4170' }),
      ),
    );
    const urls = replies.map((reply) => new URL(reply.headers['location']));
    expect(new Set(urls.map((url) => url.origin)).size).toBe(4);
    expect(new Set(urls.map((url) => url.port)).size).toBe(1);
  });

  it.each([
    'http://app.localhost:4170',
    'https://evil.example',
    'file://localhost',
    'null',
    '',
  ])('rejects an untrusted parent %s', async (hostOrigin) => {
    const response = await request(makeApp())
      .get('/mcp-app-sandbox')
      .query({ hostOrigin });
    expect(response.status).toBe(400);
  });

  it.each([
    'https://K.example.com',
    'https://ſ.example.com',
    'httpſ://example.com',
  ])(
    'drops Unicode case-folding match %s before writing CSP headers',
    async (domain) => {
      const redirect = await request(makeApp())
        .get('/mcp-app-sandbox')
        .query({
          hostOrigin: 'http://127.0.0.1:4170',
          csp: JSON.stringify({ connectDomains: [domain] }),
        });
      const response = await readSandbox(redirect.headers['location']);
      expect(response.status).toBe(200);
      expect(response.headers['content-security-policy']).not.toContain(domain);
    },
  );
});
