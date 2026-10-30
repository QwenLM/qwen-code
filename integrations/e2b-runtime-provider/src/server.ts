/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { ZodError } from 'zod';
import { ProviderError, sameSecret } from './provider.js';
import type { Cloud, E2bProvider } from './provider.js';

const runtimeRoutes = new Set([
  '/internal/managed-runtime/v3/attest',
  '/internal/managed-runtime/v3/context',
  '/internal/managed-runtime/v3/activation',
  '/internal/managed-runtime/v3/publications:install',
  ...['execute', 'status', 'cancel', 'acknowledge'].map(
    (name) => '/internal/managed-runtime/v3/' + name,
  ),
  '/internal/managed-runtime/provider/v1/control',
  ...['execute', 'status', 'cancel', 'acknowledge'].map(
    (name) => '/internal/managed-runtime/v2/' + name,
  ),
]);
const publicationRoutes = new Set([
  '/internal/managed-runtime/v2/publication:files-stop-drained',
  '/internal/managed-runtime/v2/publication:tools-stop-drained',
]);
const forwardedHeaders = [
  'authorization',
  'cache-control',
  'content-type',
  'x-qwen-managed-lease-id',
  'x-qwen-managed-lease-epoch',
  'x-qwen-managed-runtime-incarnation',
  'x-qwen-managed-storage-revision',
];

async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new ProviderError(413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function providerServer(
  provider: E2bProvider,
  cloud: Cloud,
  token: string,
) {
  if (
    token.startsWith('replace-') ||
    !/^[A-Za-z0-9._~+/=-]{16,4096}$/u.test(token)
  )
    throw new Error('Invalid provider credential.');
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    try {
      if (
        request.method !== 'POST' ||
        request.headers['content-type']?.split(';')[0] !== 'application/json' ||
        request.headers['content-encoding'] !== undefined ||
        !request.url ||
        request.url.includes('?')
      )
        throw new ProviderError(400);
      if (
        request.url === '/provider/provision' ||
        request.url === '/provider/observe' ||
        request.url === '/provider/retire'
      ) {
        if (!sameSecret(request.headers.authorization, 'Bearer ' + token))
          throw new ProviderError(401);
        if (request.headers['cache-control'] !== 'no-store')
          throw new ProviderError(400);
        const input: unknown = JSON.parse(
          (await body(request, 64 * 1024)).toString('utf8'),
        );
        const answer = request.url.endsWith('/provision')
          ? await provider.provision(input)
          : request.url.endsWith('/retire')
            ? await provider.retire(input)
            : await provider.observe(input);
        response.end(JSON.stringify(answer));
        return;
      }
      const placement = provider.route(
        (request.headers.host ?? '').split(':')[0]!,
      );
      if (
        !placement ||
        !placement.connection ||
        !sameSecret(
          request.headers.authorization,
          'Bearer ' + placement.boot.token,
        ) ||
        request.headers['x-qwen-managed-lease-id'] !== placement.boot.leaseId ||
        request.headers['x-qwen-managed-lease-epoch'] !==
          String(placement.boot.epoch)
      )
        throw new ProviderError(401);
      const port = runtimeRoutes.has(request.url)
        ? 43190
        : publicationRoutes.has(request.url)
          ? 43191
          : undefined;
      if (!port) throw new ProviderError(404);
      const headers: Record<string, string> = {};
      for (const key of forwardedHeaders)
        if (typeof request.headers[key] === 'string')
          headers[key] = request.headers[key];
      const upstream = await cloud.forward(
        placement,
        port,
        request.url,
        headers,
        await body(request, 1024 * 1024),
      );
      const chunks: Uint8Array[] = [];
      let length = 0;
      const reader = upstream.body?.getReader();
      try {
        if (reader)
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            length += item.value.length;
            if (length > 8 * 1024 * 1024) throw new ProviderError(502);
            chunks.push(item.value);
          }
      } finally {
        await reader?.cancel();
      }
      response.statusCode = upstream.status;
      for (const key of [
        'content-type',
        'cache-control',
        'x-qwen-managed-runtime-incarnation',
      ]) {
        const value = upstream.headers.get(key);
        if (value) response.setHeader(key, value);
      }
      response.end(Buffer.concat(chunks));
    } catch (error) {
      response.statusCode =
        error instanceof ProviderError
          ? error.status
          : error instanceof ZodError || error instanceof SyntaxError
            ? 400
            : 503;
      response.end(JSON.stringify({ code: 'e2b_provider_unavailable' }));
    }
  });
}
