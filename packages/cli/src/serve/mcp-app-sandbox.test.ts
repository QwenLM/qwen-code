/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import { runInNewContext } from 'node:vm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  buildMcpAppCsp,
  mountMcpAppSandbox,
  parseMcpAppCsp,
} from './mcp-app-sandbox.js';

describe('MCP App sandbox', () => {
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

  it('serves the proxy with CSP and no-store headers', async () => {
    const app = express();
    mountMcpAppSandbox(app);

    const response = await request(app).get('/mcp-app-sandbox');

    expect(response.status).toBe(200);
    expect(response.headers['content-security-policy']).toContain(
      "frame-src 'none'",
    );
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['content-security-policy']).toContain(
      "form-action 'none'",
    );
    expect(response.text).toContain('ui/notifications/sandbox-proxy-ready');
    expect(response.text).toContain(
      "inner.setAttribute('sandbox', 'allow-scripts allow-forms')",
    );
    expect(response.text).not.toContain(
      "inner.setAttribute('sandbox', 'allow-scripts allow-same-origin",
    );
    expect(response.text).not.toContain("inner.setAttribute('allow'");
    expect(response.text).not.toContain("clipboardWrite: 'clipboard-write'");
    expect(response.text).not.toContain("camera: 'camera'");
    expect(response.text).not.toContain("microphone: 'microphone'");
    expect(response.text).not.toContain("geolocation: 'geolocation'");
    expect(response.text).toContain('inner.srcdoc = params.html');
    expect(response.text).toContain("event.origin === 'null'");

    const script = response.text.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();

    const runSandbox = (hostOrigin: string) => {
      const appendChild = vi.fn();
      const postMessage = vi.fn();
      const window = {
        self: {},
        top: {},
        location: {
          href: `http://127.0.0.2:4170/mcp-app-sandbox?hostOrigin=${encodeURIComponent(hostOrigin)}`,
        },
        parent: { postMessage },
        addEventListener: vi.fn(),
      };
      const document = {
        referrer: '',
        createElement: () => ({
          setAttribute: vi.fn(),
          style: { cssText: '' },
          contentWindow: { postMessage: vi.fn() },
        }),
        body: { appendChild },
      };
      runInNewContext(script!, { window, document, URL });
      return { appendChild, postMessage };
    };

    const loopback = runSandbox('http://127.0.0.2:4170');
    expect(loopback.appendChild).toHaveBeenCalledOnce();
    expect(loopback.postMessage).toHaveBeenCalledOnce();

    const nonLoopback = runSandbox('https://example.com');
    expect(nonLoopback.appendChild).not.toHaveBeenCalled();
    expect(nonLoopback.postMessage).not.toHaveBeenCalled();
  });

  it.each([
    'https://K.example.com',
    'https://ſ.example.com',
    'httpſ://example.com',
  ])(
    'drops Unicode case-folding match %s before writing CSP headers',
    async (domain) => {
      const app = express();
      mountMcpAppSandbox(app);

      const response = await request(app)
        .get('/mcp-app-sandbox')
        .query({
          csp: JSON.stringify({ connectDomains: [domain] }),
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-security-policy']).not.toContain(domain);
    },
  );
});
