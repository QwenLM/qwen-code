/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application } from 'express';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

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
        const hostOrigin = __HOST_ORIGIN__;
        const inner = document.createElement('iframe');
        inner.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin');
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
          if (event.source === inner.contentWindow && event.origin === window.location.origin) {
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

function parseHostOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    const octets = url.hostname.split('.');
    const ipv4Loopback =
      octets.length === 4 &&
      octets[0] === '127' &&
      octets
        .slice(1)
        .every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255);
    if (
      ['http:', 'https:'].includes(url.protocol) &&
      (['localhost', '[::1]'].includes(url.hostname) || ipv4Loopback)
    ) {
      return url.origin;
    }
  } catch {
    // Invalid origins must not mint a sandbox document.
  }
  return undefined;
}

export function mountMcpAppSandbox(app: Application): () => void {
  const pending = new Map<
    string,
    { hostOrigin: string; csp: string; expiresAt: number }
  >();
  let closed = false;
  let port: Promise<number> | undefined;
  const server = createServer((req, res) => {
    const host = req.headers.host;
    const resource = host ? pending.get(host) : undefined;
    if (
      req.method !== 'GET' ||
      req.url !== '/mcp-app-sandbox' ||
      !resource ||
      resource.expiresAt <= Date.now()
    ) {
      res.writeHead(404).end();
      return;
    }
    // A consumed origin cannot be repopulated with another App or weaker CSP.
    pending.delete(host!);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': resource.csp,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'origin',
      'Origin-Agent-Cluster': '?1',
    });
    res.end(
      MCP_APP_SANDBOX_HTML.replace(
        '__HOST_ORIGIN__',
        JSON.stringify(resource.hostOrigin),
      ),
    );
  });
  const start = () => {
    port ??= new Promise<number>((resolve, reject) => {
      const onClose = () => {
        server.off('error', onError);
        reject(new Error('MCP App sandbox is closed'));
      };
      const onError = (error: Error) => {
        server.off('close', onClose);
        reject(error);
      };
      server.once('close', onClose);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        server.off('close', onClose);
        if (closed) {
          server.close();
          reject(new Error('MCP App sandbox is closed'));
          return;
        }
        server.unref();
        resolve((server.address() as { port: number }).port);
      });
    }).catch((error: unknown) => {
      port = undefined;
      throw error;
    });
    return port;
  };
  app.get('/mcp-app-sandbox', async (req, res, next) => {
    const hostOrigin = parseHostOrigin(req.query['hostOrigin']);
    if (!hostOrigin) {
      res.status(400).end();
      return;
    }
    if (closed) {
      res.status(503).end();
      return;
    }
    try {
      const sandboxPort = await start();
      if (closed) {
        res.status(503).end();
        return;
      }
      for (const [host, resource] of pending) {
        if (resource.expiresAt <= Date.now()) pending.delete(host);
      }
      while (pending.size >= 256) {
        pending.delete(pending.keys().next().value!);
      }
      const host = `${randomUUID()}.localhost:${sandboxPort}`;
      pending.set(host, {
        hostOrigin,
        csp: buildMcpAppCsp(parseMcpAppCsp(req.query['csp'])),
        expiresAt: Date.now() + 60_000,
      });
      res
        .set('Cache-Control', 'no-store')
        .redirect(302, `http://${host}/mcp-app-sandbox`);
    } catch (error) {
      next(error);
    }
  });
  return () => {
    closed = true;
    pending.clear();
    server.close();
    server.closeAllConnections();
  };
}
