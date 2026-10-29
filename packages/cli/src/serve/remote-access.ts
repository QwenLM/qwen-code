/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import type { Socket } from 'node:net';
import type { Application } from 'express';
import { MutableOriginAllowlist, parseAllowOriginPatterns } from './auth.js';
import type { CredentialStore } from './local-control/credentials.js';
import { tagListener } from './local-control/listener-identity.js';

export function remoteAccessInterfaces() {
  return Object.entries(networkInterfaces()).flatMap(
    ([interfaceName, entries]) =>
      (entries ?? [])
        .filter((entry) => entry.family === 'IPv4' && !entry.internal)
        .map(({ address }) => ({ interfaceName, address })),
  );
}

export class RemoteAccessError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RemoteAccessOptions {
  address?: string;
  port?: number;
  origins?: string[];
}

interface ActiveEntrance {
  server: Server;
  sockets: Set<Socket>;
  url: string;
  address: string;
  port: number;
  token: string;
  generation: string;
  origins: string[];
}

const LOCAL_ORIGINS = ['http://127.0.0.1:*', 'http://localhost:*'];

function exactOrigins(origins: string[]): string[] {
  if (origins.length > 32) {
    throw new RemoteAccessError(
      'invalid_origins',
      'At most 32 page origins are supported.',
    );
  }
  return [
    ...new Set(
      origins.map((origin) => {
        try {
          const url = new URL(origin);
          if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.pathname !== '/' ||
            url.search ||
            url.hash ||
            url.hostname.includes('*')
          )
            throw new Error();
          return url.origin;
        } catch {
          throw new RemoteAccessError(
            'invalid_origins',
            'Enter exact HTTP or HTTPS page origins, without paths or wildcards.',
          );
        }
      }),
    ),
  ];
}

export class RemoteAccessService {
  #active?: ActiveEntrance;
  #transition: Promise<unknown> = Promise.resolve();
  #disposed = false;

  constructor(
    private readonly deps: {
      app: Application;
      credentials: CredentialStore;
      getPort(): number;
      attachWebSocket(server: Server): void;
      detachWebSocket(server: Server): void;
      tlsPaths?: { cert: string; key: string };
    },
  ) {}

  status() {
    const active = this.#active;
    return {
      active: Boolean(active),
      defaultPort: this.deps.getPort(),
      interfaces: remoteAccessInterfaces(),
      ...(active
        ? {
            url: active.url,
            address: active.address,
            port: active.port,
            generation: active.generation,
            origins: active.origins,
            encrypted: Boolean(this.deps.tlsPaths),
          }
        : {}),
    };
  }

  reveal() {
    return { ...this.status(), token: this.#active?.token };
  }

  enable(options: RemoteAccessOptions = {}) {
    return this.#serialize(async () => {
      if (this.#disposed)
        throw new RemoteAccessError(
          'daemon_draining',
          'The daemon is shutting down.',
        );
      if (this.#active) return this.status();
      const interfaces = remoteAccessInterfaces();
      const address =
        options.address ??
        (interfaces.length === 1 ? interfaces[0]!.address : undefined);
      if (!address || !interfaces.some((entry) => entry.address === address)) {
        throw new RemoteAccessError(
          'select_interface',
          'Select a current network interface on this server.',
        );
      }
      const port = options.port ?? this.deps.getPort();
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new RemoteAccessError(
          'invalid_port',
          'Port must be an integer between 0 and 65535.',
        );
      }
      const origins = exactOrigins(options.origins ?? []);
      const matcher = new MutableOriginAllowlist(
        parseAllowOriginPatterns([...LOCAL_ORIGINS, ...origins]),
      );
      const tls = this.deps.tlsPaths;
      const server = tls
        ? createSecureServer(
            { cert: readFileSync(tls.cert), key: readFileSync(tls.key) },
            this.deps.app,
          )
        : createServer(this.deps.app);
      const token = randomBytes(32).toString('base64url');
      const sockets = new Set<Socket>();
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      server.maxConnections = 64;
      server.headersTimeout = 10_000;
      server.requestTimeout = 30 * 60_000;
      server.keepAliveTimeout = 5000;
      tagListener(server, { kind: 'remote-access', allowedOrigins: matcher });
      this.deps.credentials.setRemoteToken(token);
      try {
        this.deps.attachWebSocket(server);
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, address, () => {
            server.removeListener('error', reject);
            const bound = server.address();
            if (!bound || typeof bound === 'string') {
              reject(new Error('Remote listener has no TCP address.'));
              return;
            }
            const url = new URL(
              `${tls ? 'https' : 'http'}://${address}:${bound.port}`,
            ).origin;
            matcher.add('self', url);
            tagListener(server, {
              kind: 'remote-access',
              authority: `${address}:${bound.port}`,
              origin: url,
              allowedOrigins: matcher,
            });
            this.#active = {
              server,
              sockets,
              url,
              address,
              port: bound.port,
              token,
              generation: randomUUID(),
              origins,
            };
            resolve();
          });
        });
      } catch (error) {
        this.deps.credentials.setRemoteToken(undefined);
        this.deps.detachWebSocket(server);
        for (const socket of sockets) socket.destroy();
        if (server.listening) server.close();
        const code = (error as NodeJS.ErrnoException).code;
        throw new RemoteAccessError(
          code ?? 'enable_failed',
          error instanceof Error
            ? error.message
            : 'Could not open the remote listener.',
        );
      }
      server.on('error', () => {
        void this.disable().catch(() => {});
      });
      return this.status();
    });
  }

  updateOrigins(origins: string[]) {
    return this.#serialize(async () => {
      const active = this.#requireActive();
      const exact = exactOrigins(origins);
      const matcher = new MutableOriginAllowlist(
        parseAllowOriginPatterns([...LOCAL_ORIGINS, ...exact, active.url]),
      );
      active.origins = exact;
      tagListener(active.server, {
        kind: 'remote-access',
        authority: `${active.address}:${active.port}`,
        origin: active.url,
        allowedOrigins: matcher,
      });
      this.#disconnect(active);
      return this.status();
    });
  }

  resetToken() {
    return this.#serialize(async () => {
      const active = this.#requireActive();
      active.token = randomBytes(32).toString('base64url');
      active.generation = randomUUID();
      this.deps.credentials.setRemoteToken(active.token);
      this.#disconnect(active);
      return this.reveal();
    });
  }

  disable() {
    return this.#serialize(async () => {
      const active = this.#active;
      this.deps.credentials.setRemoteToken(undefined);
      if (!active) return this.status();
      const closed = new Promise<void>((resolve, reject) => {
        active.server.close((error) => (error ? reject(error) : resolve()));
      });
      this.deps.detachWebSocket(active.server);
      for (const socket of active.sockets) socket.destroy();
      await closed;
      this.#active = undefined;
      return this.status();
    });
  }

  dispose() {
    this.#disposed = true;
    return this.disable();
  }

  #requireActive() {
    if (!this.#active)
      throw new RemoteAccessError('remote_access_off', 'Remote access is off.');
    return this.#active;
  }

  #disconnect(active: ActiveEntrance) {
    this.deps.detachWebSocket(active.server);
    for (const socket of active.sockets) socket.destroy();
    this.deps.attachWebSocket(active.server);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#transition.then(operation);
    this.#transition = next.catch(() => {});
    return next;
  }
}
