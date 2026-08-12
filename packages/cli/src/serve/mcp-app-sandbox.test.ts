/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
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
          'https://bad.test; script-src *',
        ],
        resourceDomains: ['https://*.example.com'],
      }),
    );

    expect(buildMcpAppCsp(parsed)).toContain(
      "connect-src 'self' https://api.example.com",
    );
    expect(buildMcpAppCsp(parsed)).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https://*.example.com",
    );
    expect(buildMcpAppCsp(parsed)).not.toContain('bad.test');
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
    expect(response.text).toContain('ui/notifications/sandbox-proxy-ready');
    expect(response.text).toContain(
      "inner.setAttribute('sandbox', 'allow-scripts allow-forms')",
    );
    expect(response.text).not.toContain(
      "inner.setAttribute('sandbox', 'allow-scripts allow-same-origin",
    );
    expect(response.text).toContain('inner.srcdoc = params.html');
    expect(response.text).toContain("event.origin === 'null'");
  });
});
