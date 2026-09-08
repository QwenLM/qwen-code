/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LiveDaemon wires everything together: the Host WebSocket endpoint
 * (protocol v9, including optional visual input), the
 * discovery file that Host binaries poll, the realtime orchestrator, and
 * the qwen serve adaptor.
 *
 * Discovery mutual exclusion: writing `~/.qwen/live/daemon.json` fails fast
 * when a live owner (typically qwen serve's built-in Live integration)
 * already holds it — the two must not fight over the Host.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join, resolve } from 'node:path';
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
import { MemoryService } from './memory/service.js';
import { MemoryStoreError } from './memory/store.js';
import { deriveMemoryBaseUrl } from './memory/config.js';
import { persistLanguagePreference } from './language-preferences.js';
import { liveMessage } from './i18n/messages.js';

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
  private memory: MemoryService | undefined;
  private log: SessionLog | undefined;
  private discoveryPublished = false;
  private stopping = false;
  private resourcesStopPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private pendingCleanup: Map<string, () => unknown> | undefined;

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

    this.memory = new MemoryService({
      config: this.config.memory,
      dataDir: this.config.dataDir,
      connection: {
        baseUrl: deriveMemoryBaseUrl(this.config.realtime.endpoint),
        apiKey: this.config.realtime.apiKey,
      },
      log: (event, details) =>
        this.logger.debug(`${event} ${JSON.stringify(details ?? {})}`),
      onChange: () => this.coordinator?.refreshMemoryState(),
    });

    const coordinator = new LiveHostCoordinator({
      daemonInstanceNonce: this.instanceNonce,
      daemonShutdownV1: true,
      getUiLanguage: () => ({ language: this.config.language ?? 'en' }),
      getSubagents: () => this.session?.getSubagentsSnapshot(),
      onLanguageAction: (language) => {
        this.config.language = persistLanguagePreference(
          this.config.dataDir,
          language,
        );
        return { language: this.config.language };
      },
      getMemoryState: () => this.memory!.state(),
      onMemoryAction: (action) => {
        try {
          this.memory!.applyAction(action);
        } catch (error) {
          if (error instanceof MemoryStoreError)
            throw new Error(liveMessage(error.messageKey));
          if (
            error instanceof Error &&
            error.message.startsWith('qwen-live-ui:')
          )
            throw error;
          throw new Error(liveMessage('memoryUI.updateFailed'));
        }
        this.session?.syncMemorySettings();
        return this.memory!.state();
      },
      visualInput: {
        source: this.config.visualInput.source,
        mode: this.config.visualInput.mode,
        fps: this.config.visualInput.fps,
        cameraWidth: this.config.visualInput.cameraResolution.width,
        cameraHeight: this.config.visualInput.cameraResolution.height,
        ...(this.config.visualInput.cameraSnapshotResolution === 'native'
          ? {}
          : {
              cameraSnapshotWidth:
                this.config.visualInput.cameraSnapshotResolution.width,
              cameraSnapshotHeight:
                this.config.visualInput.cameraSnapshotResolution.height,
            }),
        liveWidth: this.config.visualInput.liveResolution.width,
        liveHeight: this.config.visualInput.liveResolution.height,
        ...(this.config.visualInput.snapshotResolution === 'native'
          ? {}
          : {
              snapshotWidth: this.config.visualInput.snapshotResolution.width,
              snapshotHeight: this.config.visualInput.snapshotResolution.height,
            }),
      },
      logger: this.logger,
      ...(this.config.shortcut ? { shortcut: this.config.shortcut } : {}),
      getProviderReadiness: () =>
        this.config.realtime.apiKey
          ? { state: 'ready' }
          : {
              state: 'unavailable',
              blocker: 'provider_config',
              message: liveMessage('runtime.apiKeyMissing'),
            },
    });
    this.coordinator = coordinator;
    // The ported coordinator fails closed until the Appshot delivery channel
    // is verified (in qwen serve that channel is a separate reverse-RPC hop
    // booted lazily). Here the channel is the in-process visual capture call,
    // verified by construction.
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
      proactive: this.config.proactive,
      memory: this.memory,
      log,
      logger: this.logger,
      onSubagentsChanged: () => coordinator.refreshSubagentsState(),
    });
    this.session = session;

    coordinator.setHandlers({
      onStart: (call) => session.start(call),
      onStop: (call) => session.stop(call),
      onInputAudio: (call) => session.pushAudio(call),
      onInputImage: (call) => session.pushImage(call),
      onVisualSettings: (call) => session.setVisualSettings(call),
      onPlaybackStarted: (call) => session.playbackStarted(call),
      onPlaybackCompleted: (call) => session.playbackCompleted(call),
      onOutputMuted: (call) => session.outputMuted(call),
    });

    const port = await this.listen();
    const url = `http://127.0.0.1:${port}`;

    await this.publishDiscovery(url);

    // The single machine-readable stdout line; harnesses parse the port
    // from it (same pattern as `qwen serve`).
    process.stdout.write(`qwen-live listening on ${url}\n`);
    this.logger.debug(
      `configuration ${JSON.stringify({
        model: this.config.realtime.model,
        visualInput: this.config.visualInput,
        proactive: this.config.proactive,
        backends: this.config.backends.map((backend) => backend.name),
        sessionLog: log.filePath,
      })}`,
    );
    this.logger.info(
      `host endpoint ready at ${url}${HOST_WS_PATH} (protocol v${LIVE_HOST_PROTOCOL_VERSION})`,
    );
    return { port, url };
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.finishStop().catch((error: unknown) => {
      this.stopPromise = undefined;
      throw error;
    });
    return this.stopPromise;
  }

  private stopResources(): Promise<void> {
    this.stopping = true;
    this.pendingCleanup ??= new Map<string, () => unknown>([
      ['session', () => this.session?.dispose()],
      ['coordinator', () => this.coordinator?.dispose()],
      ...this.registry
        .all()
        .map(({ adaptor }): [string, () => unknown] => [
          `backend:${adaptor.name}`,
          () => adaptor.close(),
        ]),
      ['memory', () => this.memory?.close()],
      ['log', () => this.log?.close()],
      [
        'discovery',
        () =>
          this.discoveryPublished
            ? removeLiveDiscoveryFile(this.config.discoveryDir, {
                pid: process.pid,
                instanceNonce: this.instanceNonce,
              })
            : undefined,
      ],
    ]);
    const pending = this.pendingCleanup;
    this.resourcesStopPromise ??= (async () => {
      const errors: unknown[] = [];
      const clean = async (
        name: string,
        dispose: () => unknown,
      ): Promise<void> => {
        try {
          await dispose();
          pending.delete(name);
        } catch (error) {
          errors.push(error);
        }
      };
      await Promise.all(
        ['session', 'coordinator'].map((name) => {
          const dispose = pending.get(name);
          return dispose ? clean(name, dispose) : undefined;
        }),
      );
      await Promise.all(
        [...pending]
          .filter(([name]) => name.startsWith('backend:'))
          .map(([name, dispose]) => clean(name, dispose)),
      );
      for (const [name, dispose] of pending) {
        if (
          name === 'session' ||
          name === 'coordinator' ||
          name.startsWith('backend:')
        )
          continue;
        if (name === 'discovery' && errors.length) continue;
        await clean(name, dispose);
      }
      if (errors.length)
        throw new AggregateError(errors, 'Live shutdown cleanup failed.');
    })().catch((error: unknown) => {
      this.resourcesStopPromise = undefined;
      throw error;
    });
    return this.resourcesStopPromise;
  }

  private async finishStop(): Promise<void> {
    await this.stopResources();
    await this.closeTransports();
  }

  private async closeTransports(): Promise<void> {
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
    if (route === 'POST /live/quit') {
      if (!this.authorize(req)) {
        res.writeHead(401).end();
        return;
      }
      const nonce = req.headers['x-qwen-live-nonce'];
      const presented = Buffer.from(typeof nonce === 'string' ? nonce : '');
      const expected = Buffer.from(this.instanceNonce);
      if (
        presented.length !== expected.length ||
        !timingSafeEqual(presented, expected)
      ) {
        res.writeHead(409).end();
        return;
      }
      void this.serveQuit(res);
      return;
    }
    if (this.stopping) {
      res.writeHead(503).end();
      return;
    }
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

  private async serveQuit(
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    try {
      await this.stopResources();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ stopped: true, instanceNonce: this.instanceNonce }),
      );
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Live shutdown cleanup failed.' }));
      this.logger.error('Live shutdown cleanup failed; retry Quit.');
      return;
    }
    // Close the listener after replying; server.close otherwise waits on
    // the very HTTP request that is awaiting its shutdown acknowledgement.
    void this.stop().catch(() =>
      this.logger.error('Live shutdown cleanup failed; retry Quit.'),
    );
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
      configPath: resolve(this.config.dataDir, 'config.json'),
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
