/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { isAbsolute } from 'node:path';
import express from 'express';
import {
  allowOriginCors,
  bearerAuth,
  hostAllowlist,
  parseAllowOriginPatterns,
} from './auth.js';
import { mountManagedLocalWeb } from './managed-local-web.js';
import { resolveServeToken } from './serve-token.js';
import { isLoopbackAddress } from './loopback-binds.js';
import {
  installRemoteSelfOriginMiddleware,
  installSelfOriginStripMiddleware,
} from './server/self-origin.js';
import { mountWebShellAssets } from './web-shell-static.js';
import { resolveWebShellDir } from './web-shell-resolver.js';

interface ManagedWebConfig {
  apiUrl: string;
  tenantId: string;
  actorId: string;
  signingKeyFile: string;
}

interface ManagedWebServeOptions {
  configFile: string;
  hostname: string;
  port: number;
  token?: string;
  allowOrigins?: string[];
}

async function readConfig(file: string): Promise<ManagedWebConfig> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new Error('Cannot read the Managed Web gateway JSON configuration.');
  }
  const keys = ['apiUrl', 'tenantId', 'actorId', 'signingKeyFile'];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some(
      (key) =>
        !(key in value) ||
        typeof (value as Record<string, unknown>)[key] !== 'string',
    )
  ) {
    throw new Error(
      `Managed Web configuration requires only ${keys.join(', ')}.`,
    );
  }
  const config = value as ManagedWebConfig;
  let api: URL;
  try {
    api = new URL(config.apiUrl);
  } catch {
    throw new Error('Managed Web apiUrl must be a loopback HTTP origin.');
  }
  if (
    api.protocol !== 'http:' ||
    !isLoopbackAddress(api.hostname) ||
    api.username ||
    api.password ||
    api.pathname !== '/' ||
    api.search ||
    api.hash
  ) {
    throw new Error('Managed Web apiUrl must be a loopback HTTP origin.');
  }
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(config.tenantId) ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(config.actorId)
  ) {
    throw new Error(
      'Managed Web tenantId and actorId require 1-128 safe characters.',
    );
  }
  if (!isAbsolute(config.signingKeyFile)) {
    throw new Error('Managed Web signingKeyFile must be an absolute path.');
  }
  return config;
}

export async function runManagedWebServe(
  options: ManagedWebServeOptions,
  deps: { webShellDir?: string; installSignalHandlers?: boolean } = {},
) {
  const config = await readConfig(options.configFile);
  const signingKey = await readFile(config.signingKeyFile, 'utf8');
  const token = resolveServeToken(options.token);
  if (
    !token ||
    Buffer.byteLength(token) < 32 ||
    Buffer.byteLength(signingKey) < 32 ||
    token === signingKey ||
    token === signingKey.trim()
  ) {
    throw new Error(
      'Managed Web requires independent browser and signing keys of at least 32 bytes.',
    );
  }
  if (
    !options.hostname.trim() ||
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535
  ) {
    throw new Error(
      'Managed Web requires a hostname and a port between 0 and 65535.',
    );
  }
  const webShellDir = deps.webShellDir ?? resolveWebShellDir();
  if (!webShellDir)
    throw new Error('Managed Web requires built Web Shell assets.');

  const app = express();
  app.disable('x-powered-by');
  let port = options.port;
  installSelfOriginStripMiddleware(app, () => port, options.hostname);
  app.use(hostAllowlist(options.hostname, () => port));
  installRemoteSelfOriginMiddleware(app, options.hostname, token);
  app.use(
    allowOriginCors(parseAllowOriginPatterns(options.allowOrigins ?? [])),
  );

  const assets = express();
  mountWebShellAssets(assets, webShellDir, [], false, true);
  app.use((req, res, next) => {
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      (['/', '/manifest.webmanifest', '/sw.js'].includes(req.path) ||
        req.path.startsWith('/assets/'))
    ) {
      assets(req, res, next);
    } else next();
  });
  app.use(bearerAuth(token));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/capabilities', (_req, res) => res.json({ mode: 'managed' }));
  mountManagedLocalWeb(app, {
    javaUrl: config.apiUrl,
    signingKey,
    tenantId: config.tenantId,
    actorId: config.actorId,
    productScope: `gateway:${createHash('sha256')
      .update(JSON.stringify([config.apiUrl, config.tenantId, config.actorId]))
      .digest('hex')}`,
    agentId: 'qwen-code',
    managedOnly: true,
  });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  const server = createServer(app);
  server.maxConnections = 256;
  server.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.hostname, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Managed Web has no TCP listener.');
  port = address.port;
  let finish!: (code: number) => void;
  const finished = new Promise<number>((resolve) => {
    finish = resolve;
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve, reject) => {
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
        process.removeListener(signal, stop);
      server.close((error) => {
        finish(error ? 1 : 0);
        if (error) reject(error);
        else resolve();
      });
      server.closeAllConnections();
    });
    return closing;
  };
  const stop = () => {
    void close().catch(() => {});
  };
  if (deps.installSignalHandlers !== false) {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
      process.once(signal, stop);
  }
  const host = options.hostname.includes(':')
    ? `[${options.hostname.replace(/^\[|\]$/gu, '')}]`
    : options.hostname;
  return { url: `http://${host}:${port}`, finished, close };
}
