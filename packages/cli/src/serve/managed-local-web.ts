/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, createHmac } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import path from 'node:path';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { bearerAuth, denyBrowserOriginCors, hostAllowlist } from './auth.js';
import { isLoopbackAddress } from './loopback-binds.js';
import { installSelfOriginStripMiddleware } from './server/self-origin.js';
import { mountWebShellAssets } from './web-shell-static.js';
import { resolveWebShellDir } from './web-shell-resolver.js';

export interface ManagedLocalWebOptions {
  port: number;
  token: string;
  javaUrl: string;
  signingKey: string;
  tenantId: string;
  actorId: string;
  productScope: string;
  agentId: string;
  webShellDir?: string;
}

export function signedManagedHeaders(options: {
  method: string;
  path: string;
  body: Buffer;
  signingKey: string;
  tenantId: string;
  actorId: string;
  idempotencyKey?: string;
}): Record<string, string> {
  const queryIndex = options.path.indexOf('?');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const canonical = [
    'qwen-broker-auth-v1',
    options.method,
    queryIndex < 0 ? options.path : options.path.slice(0, queryIndex),
    queryIndex < 0 ? '' : options.path.slice(queryIndex + 1),
    options.tenantId,
    options.actorId,
    timestamp,
    createHash('sha256').update(options.body).digest('hex'),
    options.idempotencyKey ?? '',
  ].join('\n');
  return {
    'X-Qwen-Tenant-Id': options.tenantId,
    'X-Qwen-Actor-Id': options.actorId,
    'X-Qwen-Signature-Timestamp': timestamp,
    'X-Qwen-Signature': `v1=${createHmac('sha256', options.signingKey).update(canonical).digest('hex')}`,
    ...(options.idempotencyKey === undefined
      ? {}
      : { 'Idempotency-Key': options.idempotencyKey }),
  };
}

const RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'etag',
  'retry-after',
  'x-qwen-request-id',
  'x-qwen-idempotent-replay',
];
const ARTIFACT_CONTENT =
  /^\/v1\/agents\/sessions\/[^/?]+\/artifacts\/[^/?]+\/content$/u;

export async function startManagedLocalWeb(options: ManagedLocalWebOptions) {
  if (!options.token.trim()) {
    throw new Error('Managed local serve requires a bearer token.');
  }
  const java = new URL(options.javaUrl);
  if (
    java.protocol !== 'http:' ||
    !isLoopbackAddress(java.hostname) ||
    java.username ||
    java.password ||
    java.pathname !== '/' ||
    java.search ||
    java.hash
  ) {
    throw new Error('Managed local Java URL must be a loopback HTTP origin.');
  }
  const webShellDir = options.webShellDir ?? resolveWebShellDir();
  if (
    !webShellDir ||
    !(await stat(path.join(webShellDir, 'index.html')).then(
      (file) => file.isFile(),
      () => false,
    )) ||
    !(await stat(path.join(webShellDir, 'assets')).then(
      (directory) => directory.isDirectory(),
      () => false,
    ))
  ) {
    throw new Error('Managed local serve requires built Web Shell assets.');
  }

  const app = express();
  app.disable('x-powered-by');
  const server = createServer(app);
  const getPort = () => {
    const address = server.address();
    return typeof address === 'object' && address ? address.port : 0;
  };
  app.use(hostAllowlist('127.0.0.1', getPort));
  installSelfOriginStripMiddleware(app, getPort, '127.0.0.1');
  app.use(denyBrowserOriginCors);
  mountWebShellAssets(app, webShellDir, [], false, true);
  app.use(bearerAuth(options.token));
  app.get('/capabilities', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ mode: 'managed' });
  });
  app.get('/managed/boot', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      mode: 'managed',
      productScope: options.productScope,
      agentId: options.agentId,
      enableWorkspaceBinding: true,
    });
  });
  app.use(
    ['/api/agent/web-shell/v1', ARTIFACT_CONTENT],
    express.raw({ type: () => true, limit: 10 * 1024 * 1024, inflate: false }),
    (req, res) => {
      const rawPath = req.originalUrl.split('?')[0]!;
      if (
        !(
          /^\/api\/agent\/web-shell\/v1\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*\/?$/iu.test(
            rawPath,
          ) ||
          ((req.method === 'GET' || req.method === 'HEAD') &&
            ARTIFACT_CONTENT.test(rawPath))
        )
      ) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      let idempotencyHeaders = 0;
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        if (req.rawHeaders[index]?.toLowerCase() === 'idempotency-key') {
          idempotencyHeaders++;
        }
      }
      if (idempotencyHeaders > 1) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const idempotencyKey = req.get('idempotency-key');
      const headers: Record<string, string> = {
        ...signedManagedHeaders({
          method: req.method,
          path: req.originalUrl,
          body,
          signingKey: options.signingKey,
          tenantId: options.tenantId,
          actorId: options.actorId,
          idempotencyKey,
        }),
        'content-length': String(body.byteLength),
      };
      for (const name of ['content-type', 'accept', 'if-match', 'range']) {
        const value = req.get(name);
        if (value !== undefined) headers[name] = value;
      }
      const upstream = httpRequest(
        java,
        { method: req.method, path: req.originalUrl, headers },
        (response) => {
          res.status(response.statusCode ?? 502);
          for (const name of RESPONSE_HEADERS) {
            const value = response.headers[name];
            if (value !== undefined) res.setHeader(name, value);
          }
          res.setHeader('cache-control', 'no-store');
          res.setHeader('x-content-type-options', 'nosniff');
          response.on('error', () => res.destroy());
          response.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (res.destroyed) return;
        if (res.headersSent) res.destroy();
        else res.status(502).json({ error: 'managed_service_unavailable' });
      });
      res.once('close', () => upstream.destroy());
      upstream.end(body);
    },
  );
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
    res
      .status(error?.type === 'entity.too.large' ? 413 : 400)
      .json({ error: 'invalid_request' });
  };
  app.use(handleError);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  let closePromise: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${getPort()}`,
    webShellMounted: true as const,
    resolvedToken: options.token,
    close(): Promise<void> {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}
