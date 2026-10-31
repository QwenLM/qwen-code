/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import express from 'express';
import type { Application, ErrorRequestHandler } from 'express';
import { isLoopbackAddress } from './loopback-binds.js';

export interface ManagedLocalWebOptions {
  javaUrl: string;
  signingKey: string;
  tenantId: string;
  actorId: string;
  productScope: string;
  agentId: string;
  managedOnly?: boolean;
  modelPresets?: ReadonlyArray<{
    agentId: string;
    label: string;
    modelId?: string;
  }>;
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

export function mountManagedLocalWeb(
  app: Application,
  options: ManagedLocalWebOptions,
): void {
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
  app.get('/managed/boot', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      mode: 'managed',
      productScope: options.productScope,
      agentId: options.agentId,
      enableWorkspaceBinding: true,
      modelPresets: options.modelPresets,
      ...(options.managedOnly ? { managedOnly: true } : {}),
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
  app.use(
    ['/api/agent', '/v1/agents', '/internal/managed-session-store'],
    (_req, res) => {
      res.status(404).json({ error: 'not_found' });
    },
  );
  const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
    res
      .status(error?.type === 'entity.too.large' ? 413 : 400)
      .json({ error: 'invalid_request' });
  };
  app.use(handleError);
}
