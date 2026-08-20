/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application } from 'express';

interface McpAppResourceCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

const MAX_CSP_QUERY_LENGTH = 8192;
const CSP_SOURCE_PATTERN =
  /^(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9.-]+(?::\d+)?$/i;

function sanitizeCspDomains(domains: unknown): string[] {
  if (!Array.isArray(domains)) return [];
  return domains.filter(
    (domain): domain is string =>
      typeof domain === 'string' && CSP_SOURCE_PATTERN.test(domain),
  );
}

export function parseMcpAppCsp(value: unknown): McpAppResourceCsp | undefined {
  if (typeof value !== 'string' || value.length > MAX_CSP_QUERY_LENGTH) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      connectDomains: sanitizeCspDomains(parsed['connectDomains']),
      resourceDomains: sanitizeCspDomains(parsed['resourceDomains']),
      frameDomains: sanitizeCspDomains(parsed['frameDomains']),
      baseUriDomains: sanitizeCspDomains(parsed['baseUriDomains']),
    };
  } catch {
    return undefined;
  }
}

export function buildMcpAppCsp(csp?: McpAppResourceCsp): string {
  const resources = sanitizeCspDomains(csp?.resourceDomains).join(' ');
  const connections = sanitizeCspDomains(csp?.connectDomains).join(' ');
  const frames = sanitizeCspDomains(csp?.frameDomains).join(' ');
  const baseUris = sanitizeCspDomains(csp?.baseUriDomains).join(' ');
  return [
    "default-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resources}`.trim(),
    `style-src 'self' 'unsafe-inline' blob: data: ${resources}`.trim(),
    `img-src 'self' data: blob: ${resources}`.trim(),
    `font-src 'self' data: blob: ${resources}`.trim(),
    `media-src 'self' data: blob: ${resources}`.trim(),
    `connect-src 'self' ${connections}`.trim(),
    `worker-src 'self' blob: ${resources}`.trim(),
    frames ? `frame-src ${frames}` : "frame-src 'none'",
    "form-action 'none'",
    "object-src 'none'",
    baseUris ? `base-uri ${baseUris}` : "base-uri 'none'",
  ].join('; ');
}

const MCP_APP_SANDBOX_HTML = String.raw`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>html,body,iframe{box-sizing:border-box;width:100%;height:100%;margin:0;border:0;background:transparent}</style>
  </head>
  <body>
    <script>
      (() => {
        if (window.self === window.top) return;
        const configuredHostOrigin = new URL(window.location.href).searchParams.get('hostOrigin');
        const hostUrl = new URL(configuredHostOrigin || document.referrer);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(hostUrl.hostname)) return;
        const hostOrigin = hostUrl.origin;
        const inner = document.createElement('iframe');
        inner.setAttribute('sandbox', 'allow-scripts allow-forms');
        inner.style.cssText = 'width:100%;height:100%;border:0;background:transparent';
        document.body.appendChild(inner);

        window.addEventListener('message', (event) => {
          if (event.source === window.parent) {
            if (event.origin !== hostOrigin) return;
            if (event.data?.method === 'ui/notifications/sandbox-resource-ready') {
              const params = event.data.params || {};
              if (typeof params.html === 'string') {
                inner.srcdoc = params.html;
              }
              return;
            }
            inner.contentWindow?.postMessage(event.data, '*');
            return;
          }
          if (event.source === inner.contentWindow && event.origin === 'null') {
            window.parent.postMessage(event.data, hostOrigin);
          }
        });
        window.parent.postMessage({
          jsonrpc: '2.0',
          method: 'ui/notifications/sandbox-proxy-ready',
          params: {},
        }, hostOrigin);
      })();
    </script>
  </body>
</html>`;

export function mountMcpAppSandbox(app: Application): void {
  app.get('/mcp-app-sandbox', (req, res) => {
    const csp = parseMcpAppCsp(req.query['csp']);
    res
      .status(200)
      .set('Content-Security-Policy', buildMcpAppCsp(csp))
      .set('Cache-Control', 'no-cache, no-store, must-revalidate')
      .set('X-Content-Type-Options', 'nosniff')
      .set('Referrer-Policy', 'strict-origin-when-cross-origin')
      .type('html')
      .send(MCP_APP_SANDBOX_HTML);
  });
}
