/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LiveDaemon wires everything together: the Host WebSocket endpoint
 * (protocol v6, same wire contract as the shipped Qwen Live Host), the
 * discovery file that Host binaries poll, the realtime orchestrator, and
 * the qwen serve adaptor.
 *
 * Discovery mutual exclusion: writing `~/.qwen/live/daemon.json` fails fast
 * when a live owner (typically qwen serve's built-in Live integration)
 * already holds it — the two must not fight over the Host.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { AcpAdaptor } from './adaptor/acp-adaptor.js';
import { QwenCodeAdaptor } from './adaptor/qwen-code-adaptor.js';
import { BackendRegistry } from './adaptor/registry.js';
import type { BackendConfig, LiveConfig } from './config.js';
import { LiveHostInstaller } from './host/live-host-installer.js';
import {
  handoffLiveDiscoveryOwner,
  LiveDiscoveryOwnerActiveError,
  removeLiveDiscoveryFile,
  writeLiveDiscoveryFile,
} from './host/discovery.js';
import { LiveHostCoordinator } from './host/live-host-coordinator.js';
import { LIVE_HOST_PROTOCOL_VERSION } from './host/types.js';
import { SessionLog } from './log/session-log.js';
import { LiveLogger } from './logger.js';
import { LiveSession } from './orchestrator/live-session.js';

const HOST_WS_PATH = '/live/host';

export interface LiveDaemonDeps {
  /** Pre-built registry (tests); built from config.backends otherwise. */
  registry?: BackendRegistry;
  /** Installer (tests inject a fake); production installs the real Host. */
  installer?: LiveHostInstaller;
  logger?: LiveLogger;
}

/** Build one adaptor from its config entry. */
function buildAdaptor(
  backend: BackendConfig,
  fields: { defaultCwd?: string; logger: LiveLogger; clientId: string },
): QwenCodeAdaptor | AcpAdaptor {
  if (backend.kind === 'qwen-code') {
    return new QwenCodeAdaptor({
      baseUrl: backend.baseUrl,
      ...(backend.token ? { token: backend.token } : {}),
      ...(fields.defaultCwd ? { defaultCwd: fields.defaultCwd } : {}),
      clientId: fields.clientId,
      name: backend.name,
    });
  }
  return new AcpAdaptor({
    name: backend.name,
    command: backend.command,
    args: backend.args,
    env: backend.env,
    ...(backend.cwd ? { cwd: backend.cwd } : {}),
    ...(fields.defaultCwd ? { defaultCwd: fields.defaultCwd } : {}),
    logger: fields.logger,
  });
}

export class LiveDaemon {
  private readonly logger: LiveLogger;
  private readonly registry: BackendRegistry;
  private readonly installer: LiveHostInstaller;
  private readonly token = randomUUID();
  private readonly instanceNonce = randomUUID();
  private server: Server | undefined;
  private wss: WebSocketServer | undefined;
  private coordinator: LiveHostCoordinator | undefined;
  private session: LiveSession | undefined;
  private log: SessionLog | undefined;
  private discoveryPublished = false;
  private stopping = false;

  constructor(
    private readonly config: LiveConfig,
    deps: LiveDaemonDeps = {},
  ) {
    this.logger = deps.logger ?? new LiveLogger();
    this.installer = deps.installer ?? new LiveHostInstaller();
    this.registry =
      deps.registry ??
      new BackendRegistry(
        config.backends.map((backend) => ({
          adaptor: buildAdaptor(backend, {
            ...(config.defaultCwd ? { defaultCwd: config.defaultCwd } : {}),
            logger: this.logger,
            clientId: `qwen-live-${this.instanceNonce.slice(0, 8)}-${backend.name}`,
          }),
          isDefault: backend.isDefault,
        })),
      );
  }

  async start(): Promise<{ port: number; url: string }> {
    // Fail fast when the default backend is missing or too old — before we
    // take the Host discovery file from anyone. Secondary backends are
    // best-effort: a failure marks them unavailable and startup continues.
    await this.registry.preflight((message) => this.logger.warn(message));

    const coordinator = new LiveHostCoordinator({
      daemonInstanceNonce: this.instanceNonce,
      ...(this.config.shortcut ? { shortcut: this.config.shortcut } : {}),
      getProviderReadiness: () =>
        this.config.realtime.apiKey
          ? { state: 'ready' }
          : {
              state: 'unavailable',
              blocker: 'provider_config',
              message: 'DashScope realtime API key is not configured.',
            },
    });
    this.coordinator = coordinator;
    // The ported coordinator fails closed until the Appshot delivery channel
    // is verified (in qwen serve that channel is a separate reverse-RPC hop
    // booted lazily). Here the channel is the in-process
    // captureScreenContext call, verified by construction.
    coordinator.setAppshotReadiness({ state: 'ready' });

    const log = new SessionLog({
      directory: join(this.config.dataDir, 'sessions'),
      liveSessionId: `live-${Date.now()}-${this.instanceNonce.slice(0, 8)}`,
    });
    this.log = log;

    const session = new LiveSession({
      host: coordinator,
      registry: this.registry,
      realtime: {
        endpoint: this.config.realtime.endpoint,
        apiKey: this.config.realtime.apiKey,
        model: this.config.realtime.model,
        ...(this.config.realtime.voice
          ? { voice: this.config.realtime.voice }
          : {}),
      },
      log,
    });
    this.session = session;

    coordinator.setHandlers({
      onStart: (call) => session.start(call),
      onStop: (call) => session.stop(call),
      onInputAudio: (call) => session.pushAudio(call),
    });

    const port = await this.listen();
    const url = `http://127.0.0.1:${port}`;

    await this.publishDiscovery(url);

    // The single machine-readable stdout line; harnesses parse the port
    // from it (same pattern as `qwen serve`).
    process.stdout.write(`qwen-live listening on ${url}\n`);
    this.logger.info(
      `host endpoint ready at ${url}${HOST_WS_PATH} (protocol v${LIVE_HOST_PROTOCOL_VERSION})`,
    );
    return { port, url };
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.session?.dispose();
    this.coordinator?.dispose();
    // Pumps are aborted by dispose, so no event can race the close; this
    // terminates ACP subprocesses (and clears the serve adaptor's state).
    await this.registry.closeAll((message) => this.logger.warn(message));
    if (this.discoveryPublished) {
      try {
        await removeLiveDiscoveryFile(this.config.discoveryDir, {
          pid: process.pid,
          instanceNonce: this.instanceNonce,
        });
      } catch (error) {
        this.logger.warn(
          `could not remove the discovery file: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await this.log?.close();
    // Graceful close waits on the peer; shutdown must not. Any client still
    // attached (or attached between dispose() and here) is torn down hard.
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.terminate();
      }
    }
    await new Promise<void>((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }
      this.wss.close(() => {
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        resolve();
      });
    });
  }

  // -- internals ------------------------------------------------------------

  private handleRequest(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
  ): void {
    const url = (req.url ?? '').split('?', 1)[0];
    const route = `${req.method} ${url}`;
    if (
      (route === 'GET /live/setup' ||
        route === 'POST /live/setup/install' ||
        route === 'POST /live/setup/launch') &&
      this.authorize(req)
    ) {
      void this.serveSetup(route, res);
      return;
    }
    if (route === 'GET /healthz') {
      res.statusCode = 200;
      res.end('ok');
      return;
    }
    res.statusCode = route.startsWith('GET /live/setup') ? 401 : 404;
    res.end();
  }

  private async serveSetup(
    route: string,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const status =
      route === 'GET /live/setup'
        ? await this.installer.refresh()
        : route === 'POST /live/setup/install'
          ? // force=true is the recovery path: a corrupted-but-present
            // installation (bad Info.plist, revoked notarization) would
            // otherwise permanently fail inspection while the status still
            // says retryable. Force re-downloads and re-verifies.
            await this.installer.ensureInstalled(true)
          : await this.installer.launch();
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(status));
  }

  private authorize(req: IncomingMessage): boolean {
    // CSRF wall: a browser context always sends Origin; the Host never does.
    if (req.headers['origin'] !== undefined) return false;
    const auth = req.headers['authorization'];
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false;
    const presented = Buffer.from(auth.slice('Bearer '.length));
    const expected = Buffer.from(this.token);
    return (
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    );
  }

  private listen(): Promise<number> {
    const server = createServer((req, res) => {
      this.handleRequest(req, res);
    });
    this.server = server;
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    server.on('upgrade', (req, socket, head) => {
      // A Host redialing its cached discovery URL during shutdown must not
      // re-register — stop() would then wait on the fresh lease forever.
      if (this.stopping) {
        socket.destroy();
        return;
      }
      const path = (req.url ?? '').split('?', 1)[0];
      if (path !== HOST_WS_PATH) {
        socket.destroy();
        return;
      }
      if (!this.authorize(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const nonce = req.headers['x-qwen-live-nonce'];
        this.coordinator?.attachHost(
          ws,
          typeof nonce === 'string' ? nonce : undefined,
        );
      });
    });

    return new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.port, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('could not determine the listening port'));
          return;
        }
        resolve(address.port);
      });
    });
  }

  private async publishDiscovery(url: string): Promise<void> {
    const record = {
      url,
      token: this.token,
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      pid: process.pid,
      instanceNonce: this.instanceNonce,
    };
    try {
      await writeLiveDiscoveryFile(this.config.discoveryDir, record);
      this.discoveryPublished = true;
      return;
    } catch (error) {
      if (!(error instanceof LiveDiscoveryOwnerActiveError)) {
        // A dead owner's record can be reclaimed through the handoff path.
        // The handoff's commitOwner must not touch the discovery file: the
        // handoff holds the directory lock (a nested write would deadlock)
        // and its confirm step expects the stale record to still be there.
        // Publish the new record after the reclaim completes — the same
        // contract qwen serve's wiring follows.
        await handoffLiveDiscoveryOwner(
          this.config.discoveryDir,
          { pid: process.pid, instanceNonce: this.instanceNonce },
          async () => undefined,
          { waitForHandoffGrace: false },
        );
        await writeLiveDiscoveryFile(this.config.discoveryDir, record);
        this.discoveryPublished = true;
        return;
      }
      throw new Error(
        `Another Live daemon (pid ${error.ownerPid}) already owns the Host ` +
          'discovery file — most likely qwen serve with its built-in Live ' +
          'Voice enabled. Stop it (or disable its Live integration) and ' +
          'start qwen-live again.',
      );
    }
  }
}
