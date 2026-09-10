/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendRegistry } from './adaptor/registry.js';
import { DEFAULT_PROACTIVE_CONFIG, type LiveConfig } from './config.js';
import { DEFAULT_MEMORY_CONFIG } from './memory/config.js';
import { LiveDaemon } from './daemon.js';
import {
  getLiveDiscoveryPath,
  type LiveDiscoveryRecord,
} from './host/discovery.js';
import { LIVE_HOST_PROTOCOL_VERSION } from './host/types.js';
import { LiveLogger } from './logger.js';
import { LiveSession } from './orchestrator/live-session.js';
import { MemoryService } from './memory/service.js';
import { SessionLog } from './log/session-log.js';
import { MonitorDebugStore } from './proactive/monitor-debug-store.js';
import {
  MAX_SUBAGENTS_REQUEST_BYTES,
  parseSubagentsSnapshot,
} from './subagents/types.js';

const temporaryDirectories: string[] = [];
const daemons: LiveDaemon[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-live-daemon-'));
  temporaryDirectories.push(directory);
  return directory;
}

// A structural BackendAdaptor whose name matches the registry default.
function fakeAdaptor(): import('./adaptor/types.js').BackendAdaptor {
  return {
    name: 'qwen-code',
    preflight: async () => undefined,
    close: async () => undefined,
  } as unknown as import('./adaptor/types.js').BackendAdaptor;
}

async function testConfig(): Promise<LiveConfig> {
  const base = await temporaryDirectory();
  return {
    realtime: {
      endpoint: 'https://dashscope.example.invalid',
      apiKey: 'test-api-key',
      model: 'test-model',
    },
    backends: [
      {
        name: 'qwen-code',
        kind: 'qwen-code',
        baseUrl: 'http://127.0.0.1:1',
        isDefault: true,
      },
    ],
    dataDir: join(base, 'data'),
    discoveryDir: join(base, 'discovery'),
    visualInput: {
      source: 'screen',
      mode: 'on-demand',
      fps: 1,
      cameraResolution: { width: 1280, height: 720 },
      cameraSnapshotResolution: 'native',
      liveResolution: { width: 1280, height: 720 },
      snapshotResolution: 'native',
    },
    proactive: DEFAULT_PROACTIVE_CONFIG,
    memory: {
      ...structuredClone(DEFAULT_MEMORY_CONFIG),
      enabled: false,
      dir: join(base, 'data', 'memories'),
    },
    port: 0,
  };
}

function startedDaemon(config: LiveConfig): LiveDaemon {
  const daemon = new LiveDaemon(config, {
    registry: new BackendRegistry([
      { adaptor: fakeAdaptor(), isDefault: true },
    ]),
    // 'error' level keeps expected warnings (discovery cleanup) off stderr.
    logger: new LiveLogger('error'),
  });
  daemons.push(daemon);
  return daemon;
}

function ownedBackend(daemon: LiveDaemon) {
  return (daemon as unknown as { registry: BackendRegistry }).registry
    .defaultAdaptor;
}

async function readDiscoveryRecord(
  discoveryDir: string,
): Promise<LiveDiscoveryRecord> {
  const raw = await readFile(getLiveDiscoveryPath(discoveryDir), 'utf8');
  return JSON.parse(raw) as LiveDiscoveryRecord;
}

async function plantDiscoveryRecord(
  discoveryDir: string,
  record: LiveDiscoveryRecord,
): Promise<void> {
  const discoveryPath = getLiveDiscoveryPath(discoveryDir);
  await mkdir(dirname(discoveryPath), { recursive: true, mode: 0o700 });
  await writeFile(discoveryPath, `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds).unref();
  });
}

function connectHost(url: string, headers: Record<string, string>): WebSocket {
  const target = url.replace(/^http/, 'ws');
  return new WebSocket(`${target}/live/host`, { headers });
}

function hostHeaders(record: LiveDiscoveryRecord): Record<string, string> {
  return {
    authorization: `Bearer ${record.token}`,
    'x-qwen-live-nonce': record.instanceNonce,
  };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

/** Resolves with the HTTP status of a refused upgrade, rejects on success. */
function waitForRefusal(socket: WebSocket): Promise<number | 'destroyed'> {
  return new Promise((resolve, reject) => {
    socket.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 'destroyed');
      socket.terminate();
    });
    socket.once('error', () => {
      resolve('destroyed');
    });
    socket.once('open', () => {
      reject(new Error('the upgrade was accepted'));
    });
  });
}

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('LiveDaemon', () => {
  it.each([false, true])(
    'keeps local startup available when memory is %s and its default endpoint cannot be derived',
    async (enabled) => {
      const config = await testConfig();
      config.realtime.endpoint =
        'wss://private-user:private-password@proxy.example.invalid/realtime?token=private-query';
      config.memory.enabled = enabled;
      const warn = vi.spyOn(LiveLogger.prototype, 'warn');
      const daemon = startedDaemon(config);
      await expect(daemon.start()).resolves.toMatchObject({
        port: expect.any(Number),
      });
      await expect(
        readDiscoveryRecord(config.discoveryDir),
      ).resolves.toMatchObject({
        pid: process.pid,
      });
      const memory = (
        daemon as unknown as {
          memory: { options: { connection: { baseUrl: string } } };
        }
      ).memory;
      expect(memory.options.connection.baseUrl).toBe('');
      const warning = warn.mock.calls.map(([message]) => message).join('\n');
      expect(warning).toContain('Memory default endpoint unavailable');
      expect(warning).toContain('realtimeEndpoint');
      for (const secret of [
        'private-user',
        'private-password',
        'private-query',
      ])
        expect(warning).not.toContain(secret);
    },
  );

  it.each(['debug', 'info'] as const)(
    'initializes Monitor archives only with %s diagnostics enabled',
    async (level) => {
      const initialize = vi
        .spyOn(MonitorDebugStore.prototype, 'initialize')
        .mockResolvedValue(true);
      const flush = vi.spyOn(MonitorDebugStore.prototype, 'flush');
      const logger = new LiveLogger(level);
      vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
      vi.spyOn(logger, 'info').mockImplementation(() => undefined);
      const daemon = new LiveDaemon(await testConfig(), {
        registry: new BackendRegistry([
          { adaptor: fakeAdaptor(), isDefault: true },
        ]),
        logger,
      });
      daemons.push(daemon);
      await daemon.start();
      const session = (
        daemon as unknown as {
          session: { options: { monitorDebug?: MonitorDebugStore } };
        }
      ).session;
      expect(initialize).toHaveBeenCalledTimes(level === 'debug' ? 1 : 0);
      expect(session.options.monitorDebug).toBe(
        level === 'debug' ? initialize.mock.contexts[0] : undefined,
      );
      await daemon.stop();
      expect(flush).toHaveBeenCalledTimes(level === 'debug' ? 1 : 0);
    },
  );

  it('continues startup when debug archive initialization is unavailable', async () => {
    vi.spyOn(MonitorDebugStore.prototype, 'initialize').mockResolvedValue(
      false,
    );
    const flush = vi.spyOn(MonitorDebugStore.prototype, 'flush');
    const logger = new LiveLogger('debug');
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const daemon = new LiveDaemon(await testConfig(), {
      registry: new BackendRegistry([
        { adaptor: fakeAdaptor(), isDefault: true },
      ]),
      logger,
    });
    daemons.push(daemon);
    await expect(daemon.start()).resolves.toMatchObject({
      url: expect.any(String),
    });
    await daemon.stop();
    expect(flush).not.toHaveBeenCalled();
  });

  it('authenticates standalone subagent management by bearer and instance without an active call', async () => {
    const config = await testConfig();
    const daemon = startedDaemon(config);
    const { url } = await daemon.start();
    const record = await readDiscoveryRecord(config.discoveryDir);
    const action = vi.spyOn(LiveSession.prototype, 'handleSubagentsRequest');
    const requestPage = (headers: Record<string, string>) =>
      fetch(`${url}/live/subagents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ action: 'list' }),
      });
    expect((await requestPage({})).status).toBe(401);
    expect(
      (
        await requestPage({
          ...hostHeaders(record),
          origin: 'https://untrusted.invalid',
        })
      ).status,
    ).toBe(401);
    expect(
      (await requestPage({ authorization: `Bearer ${record.token}` })).status,
    ).toBe(409);
    expect(
      (
        await requestPage({
          ...hostHeaders(record),
          'x-qwen-live-nonce': 'previous-instance',
        })
      ).status,
    ).toBe(409);
    expect(action).not.toHaveBeenCalled();
    const accepted = await requestPage(hostHeaders(record));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      type: 'page',
      page: { offset: 0, total: 0, snapshot: { tasks: [] } },
    });
    expect(action).toHaveBeenCalledExactlyOnceWith({ action: 'list' });
  });

  it('rejects malformed or oversized controls without dispatch and returns owned failures', async () => {
    const config = await testConfig();
    const daemon = startedDaemon(config);
    const { url } = await daemon.start();
    const record = await readDiscoveryRecord(config.discoveryDir);
    const action = vi.spyOn(LiveSession.prototype, 'handleSubagentsRequest');
    for (const [body, status] of [
      ['{', 400],
      [JSON.stringify({ action: 'stop', taskId: '' }), 400],
      [JSON.stringify({ action: 'stop', taskId: 'job:1', all: true }), 400],
      ['x'.repeat(MAX_SUBAGENTS_REQUEST_BYTES + 1), 413],
    ] as const) {
      const response = await fetch(`${url}/live/subagents`, {
        method: 'POST',
        headers: { ...hostHeaders(record), 'content-type': 'application/json' },
        body,
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        type: 'error',
        code: 'invalid_request',
      });
    }
    expect(action).not.toHaveBeenCalled();
    action.mockRejectedValueOnce(
      new Error('backend credentials must not escape'),
    );
    const response = await fetch(`${url}/live/subagents`, {
      method: 'POST',
      headers: { ...hostHeaders(record), 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop', taskId: 'harness:job_1' }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      type: 'error',
      code: 'action_failed',
    });
  });

  it.each(['absolute', 'relative'])(
    'advertises the configuration under a custom %s data directory',
    async (pathType) => {
      const config = await testConfig();
      config.dataDir = join(config.dataDir, 'custom data');
      const configPath = resolve(config.dataDir, 'config.json');
      if (pathType === 'relative')
        config.dataDir = relative(process.cwd(), config.dataDir);
      const daemon = startedDaemon(config);

      await daemon.start();

      const record = await readDiscoveryRecord(config.discoveryDir);
      expect(record.configPath).toBe(configPath);
      await expect(readFile(configPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('confirms and persists language independently of disabled Memory', async () => {
    const config = await testConfig();
    await mkdir(config.dataDir, { recursive: true });
    const configPath = join(config.dataDir, 'config.json');
    const previous = {
      realtimeApiKey: 'fixture-private-key',
      memory: { enabled: false },
      custom: ['preserved'],
    };
    await writeFile(configPath, JSON.stringify(previous), { mode: 0o600 });
    const daemon = startedDaemon(config);
    const { url } = await daemon.start();
    const record = await readDiscoveryRecord(config.discoveryDir);
    const socket = connectHost(url, hostHeaders(record));
    await waitForOpen(socket);
    const messages: Array<Record<string, unknown>> = [];
    socket.on('message', (message) =>
      messages.push(JSON.parse(String(message))),
    );
    socket.send(
      JSON.stringify({
        type: 'host.hello',
        subagentsV1: true,
        protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
        hostVersion: '1.0.0',
        bundleId: 'com.alibaba.qwen-code.live-host',
        instanceNonce: 'host_instance_nonce_0001',
        permissions: {
          microphone: 'granted',
          camera: 'granted',
          accessibility: 'granted',
          screenRecording: 'granted',
        },
        selfChecks: {
          audioInput: true,
          audioOutput: true,
          globalShortcut: true,
          appshot: true,
        },
      }),
    );
    await vi.waitFor(() =>
      expect(
        messages.find((message) => message['type'] === 'host.welcome'),
      ).toMatchObject({
        uiLanguageV1: { language: 'en' },
        subagentsControlV1: true,
      }),
    );
    expect(
      parseSubagentsSnapshot(
        messages.find((message) => message['type'] === 'host.welcome')?.[
          'subagentsV1'
        ],
      ),
    ).toMatchObject({
      revision: 0,
      tasks: [],
      omitted: 0,
      counts: { running: 0, completed: 0, needsAttention: 0 },
    });
    socket.send(
      JSON.stringify({
        type: 'host.language_action',
        requestId: 'language-1',
        epoch: 0,
        language: 'zh-CN',
      }),
    );
    await vi.waitFor(() =>
      expect(
        messages.find((message) => message['type'] === 'host.language_result'),
      ).toMatchObject({
        requestId: 'language-1',
        ok: true,
        uiLanguageV1: { language: 'zh-CN' },
      }),
    );
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      ...previous,
      language: 'zh-CN',
    });
    expect(config.language).toBe('zh-CN');
    socket.terminate();
  });

  it('stop() without start() resolves quickly', async () => {
    const daemon = startedDaemon(await testConfig());
    const outcome = await Promise.race([
      daemon.stop().then(() => 'stopped' as const),
      delay(2_000).then(() => 'timeout' as const),
    ]);
    expect(outcome).toBe('stopped');
  });

  it('accepts a discovered Host and advertises independent visual resolutions', async () => {
    const config = await testConfig();
    config.visualInput.cameraSnapshotResolution = { width: 3840, height: 2160 };
    config.visualInput.snapshotResolution = { width: 2560, height: 1440 };
    config.visualInput.screenDisplayId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await mkdir(config.dataDir, { recursive: true });
    const previous = {
      custom: 'preserved',
      visualInput: { source: 'screen', mode: 'on-demand', fps: 3 },
    };
    await writeFile(
      join(config.dataDir, 'config.json'),
      JSON.stringify(previous),
    );
    const daemon = startedDaemon(config);
    const { url, port } = await daemon.start();
    expect(url).toBe(`http://127.0.0.1:${port}`);

    const record = await readDiscoveryRecord(config.discoveryDir);
    expect(record.pid).toBe(process.pid);
    expect(record.url).toBe(url);
    expect(record.protocolVersion).toBe(LIVE_HOST_PROTOCOL_VERSION);

    const socket = connectHost(url, hostHeaders(record));
    await waitForOpen(socket);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const welcome = new Promise<Record<string, unknown>>((resolve) => {
      socket.once('message', (message) => resolve(JSON.parse(String(message))));
    });
    socket.send(
      JSON.stringify({
        type: 'host.hello',
        protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
        hostVersion: '1.0.0',
        bundleId: 'com.alibaba.qwen-code.live-host',
        instanceNonce: 'host_instance_nonce_0001',
        permissions: {
          microphone: 'granted',
          camera: 'granted',
          accessibility: 'granted',
          screenRecording: 'granted',
        },
        selfChecks: {
          audioInput: true,
          audioOutput: true,
          globalShortcut: true,
          appshot: true,
        },
      }),
    );
    await expect(welcome).resolves.toMatchObject({
      type: 'host.welcome',
      daemonShutdownV1: true,
      displayCaptureV1: true,
      visualInput: {
        screenDisplayId: config.visualInput.screenDisplayId,
        cameraWidth: 1280,
        cameraHeight: 720,
        cameraSnapshotWidth: 3840,
        cameraSnapshotHeight: 2160,
        snapshotWidth: 2560,
        snapshotHeight: 1440,
      },
    });
    const selected = new Promise<void>((resolve) => {
      socket.on('message', (data) => {
        const message = JSON.parse(String(data));
        if (
          message.type === 'host.state' &&
          message.visualInput?.screenDisplayId === 'primary'
        )
          resolve();
      });
    });
    socket.send(
      JSON.stringify({
        type: 'host.visual_settings',
        epoch: 0,
        source: 'camera',
        mode: 'live-feed',
        screenDisplayId: 'primary',
        permissions: {
          camera: 'granted',
          accessibility: 'granted',
          screenRecording: 'granted',
        },
        appshot: true,
      }),
    );
    await selected;
    expect(
      JSON.parse(await readFile(join(config.dataDir, 'config.json'), 'utf8')),
    ).toEqual({
      ...previous,
      visualInput: { ...previous.visualInput, screenDisplayId: 'primary' },
    });
    socket.terminate();
  });

  it('wires active-epoch playback receipts and gracefully quits during a call', async () => {
    const start = vi
      .spyOn(LiveSession.prototype, 'start')
      .mockResolvedValue(undefined);
    const playbackStarted = vi
      .spyOn(LiveSession.prototype, 'playbackStarted')
      .mockImplementation(() => undefined);
    const playbackCompleted = vi
      .spyOn(LiveSession.prototype, 'playbackCompleted')
      .mockImplementation(() => undefined);
    const config = await testConfig();
    const daemon = startedDaemon(config);
    const { url } = await daemon.start();
    const record = await readDiscoveryRecord(config.discoveryDir);
    const socket = connectHost(url, hostHeaders(record));
    await waitForOpen(socket);

    socket.send(
      JSON.stringify({
        type: 'host.hello',
        protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
        hostVersion: '1.0.0',
        bundleId: 'com.alibaba.qwen-code.live-host',
        instanceNonce: 'host_instance_nonce_0001',
        permissions: {
          microphone: 'granted',
          camera: 'granted',
          accessibility: 'granted',
          screenRecording: 'granted',
        },
        selfChecks: {
          audioInput: true,
          audioOutput: true,
          globalShortcut: true,
          appshot: true,
        },
      }),
    );
    socket.send(JSON.stringify({ type: 'host.action', action: 'toggle' }));
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const call = start.mock.calls[0]?.[0];
    if (!call) throw new Error('Live call did not start');
    const coordinator = (
      daemon as unknown as {
        coordinator?: {
          sendOutputAudio(epoch: number, audio: Uint8Array): boolean;
          finishOutputAudio(epoch: number): void;
        };
      }
    ).coordinator;
    expect(coordinator?.sendOutputAudio(call.epoch, Buffer.from([0, 0]))).toBe(
      true,
    );
    coordinator?.finishOutputAudio(call.epoch);

    socket.send(
      JSON.stringify({
        type: 'host.playback_started',
        epoch: call.epoch - 1,
        outputId: 1,
      }),
    );
    socket.send(
      JSON.stringify({
        type: 'host.playback_completed',
        epoch: call.epoch - 1,
        outputId: 1,
      }),
    );
    socket.send(
      JSON.stringify({
        type: 'host.playback_started',
        epoch: call.epoch,
        outputId: 2,
      }),
    );
    socket.send(
      JSON.stringify({
        type: 'host.playback_started',
        epoch: call.epoch,
        outputId: 1,
      }),
    );
    socket.send(
      JSON.stringify({
        type: 'host.playback_completed',
        epoch: call.epoch,
        outputId: 1,
      }),
    );

    await vi.waitFor(() => {
      expect(playbackStarted).toHaveBeenCalledOnce();
      expect(playbackCompleted).toHaveBeenCalledOnce();
    });
    expect(playbackStarted).toHaveBeenCalledWith({ epoch: call.epoch });
    expect(playbackCompleted).toHaveBeenCalledWith({ epoch: call.epoch });
    const dispose = vi.spyOn(LiveSession.prototype, 'dispose');
    const closeBackends = vi.spyOn(ownedBackend(daemon), 'close');
    const hostClosed = new Promise<void>((resolve) =>
      socket.once('close', () => resolve()),
    );
    const response = await fetch(`${url}/live/quit`, {
      method: 'POST',
      headers: hostHeaders(record),
    });
    expect(response.status).toBe(200);
    await response.text();
    await daemon.stop();
    await hostClosed;
    expect(dispose).toHaveBeenCalledOnce();
    expect(closeBackends).toHaveBeenCalledOnce();
    await expect(readDiscoveryRecord(config.discoveryDir)).rejects.toThrow();
  });

  it('refuses an upgrade that carries an Origin header (CSRF wall)', async () => {
    const config = await testConfig();
    const daemon = startedDaemon(config);
    const { url } = await daemon.start();
    const record = await readDiscoveryRecord(config.discoveryDir);

    // Even a correct token is refused when Origin marks a browser context.
    const socket = connectHost(url, {
      ...hostHeaders(record),
      origin: 'https://evil.example.com',
    });
    await expect(waitForRefusal(socket)).resolves.toBe(401);
  });

  it('refuses a wrong bearer token with 401', async () => {
    const config = await testConfig();
    const daemon = startedDaemon(config);
    const { url } = await daemon.start();
    const record = await readDiscoveryRecord(config.discoveryDir);

    const socket = connectHost(url, {
      ...hostHeaders(record),
      authorization: 'Bearer not-the-token',
    });
    await expect(waitForRefusal(socket)).resolves.toBe(401);
  });

  it('refuses shutdown without authentication or with the wrong instance', async () => {
    const config = await testConfig();
    const daemon = startedDaemon(config);
    const { url } = await daemon.start();
    const record = await readDiscoveryRecord(config.discoveryDir);
    for (const [headers, status] of [
      [{}, 401],
      [{ ...hostHeaders(record), origin: 'https://untrusted.example' }, 401],
      [{ ...hostHeaders(record), authorization: 'Bearer wrong' }, 401],
      [{ ...hostHeaders(record), 'x-qwen-live-nonce': 'wrong-instance' }, 409],
    ] as const) {
      const response = await fetch(`${url}/live/quit`, {
        method: 'POST',
        headers,
      });
      expect(response.status).toBe(status);
      await response.text();
      expect((await fetch(`${url}/healthz`)).status).toBe(200);
    }
    expect(await readDiscoveryRecord(config.discoveryDir)).toEqual(record);
  });

  it('acknowledges concurrent authenticated shutdowns only after cleaning owned resources', async () => {
    const config = await testConfig();
    const daemon = startedDaemon(config);
    const { url } = await daemon.start();
    const record = await readDiscoveryRecord(config.discoveryDir);
    const dispose = vi.spyOn(LiveSession.prototype, 'dispose');
    let finishMemory!: () => void;
    const actualClose = MemoryService.prototype.close;
    const close = vi
      .spyOn(MemoryService.prototype, 'close')
      .mockImplementation(async function (this: MemoryService) {
        await new Promise<void>((resolve) => {
          finishMemory = resolve;
        });
        await actualClose.call(this);
      });
    let acknowledged = 0;
    const requests = [1, 2].map(() =>
      fetch(`${url}/live/quit`, {
        method: 'POST',
        headers: hostHeaders(record),
      }).then(async (response) => {
        acknowledged++;
        expect(response.status).toBe(200);
        return response.json();
      }),
    );
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(dispose).toHaveBeenCalledOnce();
    expect(acknowledged).toBe(0);
    const refusedSetup = await fetch(`${url}/live/setup`, {
      headers: hostHeaders(record),
    });
    expect(refusedSetup.status).toBe(503);
    await refusedSetup.text();
    const firstStop = daemon.stop();
    const secondStop = daemon.stop();
    expect(firstStop).toBe(secondStop);
    finishMemory();
    expect(await Promise.all(requests)).toEqual([
      { stopped: true, instanceNonce: record.instanceNonce },
      { stopped: true, instanceNonce: record.instanceNonce },
    ]);
    await firstStop;
    await expect(readDiscoveryRecord(config.discoveryDir)).rejects.toThrow();
    await expect(fetch(`${url}/healthz`)).rejects.toThrow();
  });

  it.each(['session', 'backend'] as const)(
    'keeps shutdown-only control and retries only failed %s cleanup',
    async (failure) => {
      const config = await testConfig();
      const daemon = startedDaemon(config);
      const { url } = await daemon.start();
      const record = await readDiscoveryRecord(config.discoveryDir);
      const dispose = vi.spyOn(LiveSession.prototype, 'dispose');
      const backendClose = vi.spyOn(ownedBackend(daemon), 'close');
      const warn = vi.spyOn(LiveLogger.prototype, 'warn');
      if (failure === 'session')
        dispose.mockImplementationOnce(() => {
          throw new Error('Simulated session cleanup failure');
        });
      else
        backendClose.mockRejectedValueOnce(
          new Error('Simulated backend cleanup failure'),
        );
      const close = vi.spyOn(MemoryService.prototype, 'close');
      const closeLog = vi.spyOn(SessionLog.prototype, 'close');
      const response = await fetch(`${url}/live/quit`, {
        method: 'POST',
        headers: hostHeaders(record),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: 'Live shutdown cleanup failed.',
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`Simulated ${failure} cleanup failure`),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `cleanup of '${failure === 'session' ? 'session' : 'backend:qwen-code'}' failed:`,
        ),
      );
      expect(close).toHaveBeenCalledOnce();
      expect(await readDiscoveryRecord(config.discoveryDir)).toEqual(record);
      const blocked = await fetch(`${url}/live/setup`, {
        headers: hostHeaders(record),
      });
      expect(blocked.status).toBe(503);
      await blocked.text();
      const repeated = await fetch(`${url}/live/quit`, {
        method: 'POST',
        headers: hostHeaders(record),
      });
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toEqual({
        stopped: true,
        instanceNonce: record.instanceNonce,
      });
      await daemon.stop();
      expect(dispose).toHaveBeenCalledTimes(failure === 'session' ? 2 : 1);
      expect(backendClose).toHaveBeenCalledTimes(failure === 'backend' ? 2 : 1);
      expect(close).toHaveBeenCalledOnce();
      expect(closeLog).toHaveBeenCalledOnce();
      await expect(readDiscoveryRecord(config.discoveryDir)).rejects.toThrow();
      await expect(fetch(`${url}/healthz`)).rejects.toThrow();
    },
  );

  it('logs bounded nested cleanup causes without connection credentials', async () => {
    const config = await testConfig();
    config.backends[0] = {
      kind: 'qwen-code',
      name: 'qwen-code',
      baseUrl: 'http://127.0.0.1:1',
      token: 'private-backend-token',
      isDefault: true,
    };
    config.memory.updater.baseUrl =
      'https://memory.example.invalid/compatible-mode/v1';
    config.memory.updater.apiKeyEnv = 'TEST_LIVE_MEMORY_KEY';
    vi.stubEnv('TEST_LIVE_MEMORY_KEY', 'private-memory-key');
    const daemon = startedDaemon(config);
    await daemon.start();
    const record = await readDiscoveryRecord(config.discoveryDir);
    const warn = vi.spyOn(LiveLogger.prototype, 'warn');
    const nested = new Error(
      `SQLite checkpoint failed: ${config.realtime.apiKey} private-backend-token private-memory-key ${record.token} Bearer unconfigured-secret https://private-user:private-password@example.invalid/?token=private-query`,
    );
    const failure = new AggregateError(
      [nested, new Error('x'.repeat(10_000))],
      'Memory database close failed.',
    );
    failure.cause = failure;
    vi.spyOn(MemoryService.prototype, 'close').mockRejectedValueOnce(failure);
    await expect(daemon.stop()).rejects.toThrow(
      'Live shutdown cleanup failed.',
    );
    const warning = warn.mock.calls.map(([message]) => message).join('\n');
    expect(warning).toContain("cleanup of 'memory' failed:");
    expect(warning).toContain('Memory database close failed.');
    expect(warning).toContain('SQLite checkpoint failed:');
    expect(warning).toContain('[redacted]');
    for (const secret of [
      config.realtime.apiKey,
      'private-backend-token',
      'private-memory-key',
      record.token,
      'unconfigured-secret',
      'private-user',
      'private-password',
      'private-query',
    ])
      expect(warning).not.toContain(secret);
    expect(warning.length).toBeLessThan(2100);
  });

  it('does not remove a different discovery owner while exiting after cleanup failure', async () => {
    const config = await testConfig();
    const daemon = startedDaemon(config);
    await daemon.start();
    const ownRecord = await readDiscoveryRecord(config.discoveryDir);
    const replacement = {
      ...ownRecord,
      instanceNonce: 'replacement_daemon_instance_0001',
    };
    await plantDiscoveryRecord(config.discoveryDir, replacement);
    vi.spyOn(ownedBackend(daemon), 'close').mockRejectedValueOnce(
      new Error('Synthetic backend cleanup failure'),
    );
    try {
      await expect(daemon.stopForProcessExit()).rejects.toThrow(
        'Live shutdown cleanup failed.',
      );
      expect(await readDiscoveryRecord(config.discoveryDir)).toEqual(
        replacement,
      );
    } finally {
      await plantDiscoveryRecord(config.discoveryDir, ownRecord);
    }
  });

  it('shares a failed stop attempt and permits an explicit retry without re-closing successful resources', async () => {
    const config = await testConfig();
    const daemon = startedDaemon(config);
    await daemon.start();
    const backendClose = vi
      .spyOn(ownedBackend(daemon), 'close')
      .mockRejectedValueOnce(new Error('Retry this cleanup'));
    const closeMemory = vi.spyOn(MemoryService.prototype, 'close');
    const first = daemon.stop();
    expect(daemon.stop()).toBe(first);
    await expect(first).rejects.toThrow('Live shutdown cleanup failed.');
    const retry = daemon.stop();
    expect(daemon.stop()).toBe(retry);
    await retry;
    expect(backendClose).toHaveBeenCalledTimes(2);
    expect(closeMemory).toHaveBeenCalledOnce();
  });

  it('does not retry successful backends when a different owned backend fails', async () => {
    const config = await testConfig();
    const first = fakeAdaptor();
    const second = { ...fakeAdaptor(), name: 'second' };
    const firstClose = vi
      .spyOn(first, 'close')
      .mockRejectedValueOnce(new Error('First backend is busy'));
    const secondClose = vi.spyOn(second, 'close');
    const daemon = new LiveDaemon(config, {
      registry: new BackendRegistry([
        { adaptor: first, isDefault: true },
        { adaptor: second, isDefault: false },
      ]),
      logger: new LiveLogger('error'),
    });
    daemons.push(daemon);
    await daemon.start();
    await expect(daemon.stop()).rejects.toThrow(
      'Live shutdown cleanup failed.',
    );
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
    await daemon.stop();
    expect(firstClose).toHaveBeenCalledTimes(2);
    expect(secondClose).toHaveBeenCalledOnce();
  });

  it('stop() resolves within a deadline while a Host keeps reconnecting', async () => {
    const config = await testConfig();
    const daemon = startedDaemon(config);
    const { port } = await daemon.start();
    const record = await readDiscoveryRecord(config.discoveryDir);

    // A raw upgraded socket that never answers the server's close frame —
    // the worst-case peer graceful close would wait on. Resolves with the
    // socket once the 101 handshake completed, or undefined when refused.
    const rawHostSocket = (): Promise<Socket | undefined> =>
      new Promise((resolve) => {
        const req = request({
          host: '127.0.0.1',
          port,
          path: '/live/host',
          headers: {
            ...hostHeaders(record),
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          },
        });
        req.on('upgrade', (_res, socket) => {
          socket.on('error', () => {});
          resolve(socket);
        });
        req.on('response', () => {
          resolve(undefined);
        });
        req.on('error', () => {
          resolve(undefined);
        });
        req.end();
      });

    const sockets: Socket[] = [];
    let redialing = true;
    const redial = (socket: Socket) => {
      socket.on('close', () => {
        if (!redialing) return;
        setTimeout(() => {
          if (!redialing) return;
          void rawHostSocket().then((next) => {
            if (!next) return;
            sockets.push(next);
            redial(next);
          });
        }, 5).unref();
      });
    };

    const first = await rawHostSocket();
    expect(first).toBeDefined();
    sockets.push(first!);
    redial(first!);

    try {
      const outcome = await Promise.race([
        daemon.stop().then(() => 'stopped' as const),
        delay(3_000).then(() => 'timeout' as const),
      ]);
      expect(outcome).toBe('stopped');
    } finally {
      redialing = false;
      for (const socket of sockets) socket.destroy();
    }
  });

  it('reclaims a stale dead-owner discovery record and republishes', async () => {
    const config = await testConfig();
    await plantDiscoveryRecord(config.discoveryDir, {
      url: 'http://127.0.0.1:3210',
      token: 'stale-token',
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      pid: 999_999,
      instanceNonce: 'daemon_instance_nonce_stale_01',
    });

    const daemon = startedDaemon(config);
    const { url } = await daemon.start();

    const record = await readDiscoveryRecord(config.discoveryDir);
    expect(record.pid).toBe(process.pid);
    expect(record.url).toBe(url);
    expect(record.instanceNonce).not.toBe('daemon_instance_nonce_stale_01');
    expect(record.token).not.toBe('stale-token');
  });

  it('fails fast on a live discovery owner instead of stealing the file', async () => {
    const config = await testConfig();
    const planted: LiveDiscoveryRecord = {
      url: 'http://127.0.0.1:3210',
      token: 'live-owner-token',
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      // This test process is alive, so the record reads as a live owner.
      pid: process.pid,
      instanceNonce: 'daemon_instance_nonce_live_01',
    };
    await plantDiscoveryRecord(config.discoveryDir, planted);

    const daemon = startedDaemon(config);
    await expect(daemon.start()).rejects.toThrow(
      /Another Live daemon \(pid \d+\) already owns/,
    );
    // The live owner's record is untouched.
    await expect(readDiscoveryRecord(config.discoveryDir)).resolves.toEqual(
      planted,
    );
  });
});
