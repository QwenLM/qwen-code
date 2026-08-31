/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { createServer } from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as tls from 'node:tls';
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import express from 'express';
import {
  createLazyBridgeProxy,
  extractContextFilename,
  assertChannelWorkerDaemonUrlIsLocal,
  formatChannelWorkerDaemonUrl,
  describeWorkerTlsTrustGaps,
  InvalidPolicyConfigError,
  createDisabledChannelWorkerSupervisor,
  createBoundChannelDeliveryHandler,
  resolveRuntimeStartupTimeoutMs,
  runQwenServe,
  type RunHandle,
  type RunQwenServeDeps,
  subSessionConcurrencyCapsFromSettings,
  validatePolicyConfig,
  verifyWorkerTlsTrust,
  waitForRuntimeStartingForShutdown,
} from './run-qwen-serve.js';
import { isBrowserAutomationMcpAvailable } from './cdp-mcp-command.js';
import * as nativeDirectoryPicker from './native-directory-picker.js';
import { loadServeFastPathEnvironment } from './fast-path-settings.js';
import { loadEnvironment } from '../config/environment.js';
import { RUNTIME_STARTUP_CANCELLED_MESSAGE } from './runtime-startup-errors.js';
import { isLoopbackBind } from './loopback-binds.js';
import { isOwnInterfaceAddress } from './local-bind-addresses.js';
import { ChannelDeliveryAuthorizationStore } from './channel-delivery-authorization.js';
import * as acpBridge from '@qwen-code/acp-bridge/bridge';
import { SessionNotFoundError } from '@qwen-code/acp-bridge/bridgeErrors';
import {
  journalGrowthPoolMb,
  resolveDaemonMemoryBudget,
} from '@qwen-code/acp-bridge/daemonMemoryBudget';
import { canonicalizeWorkspace } from '@qwen-code/acp-bridge/workspacePaths';
import {
  DEFAULT_MAX_JOURNAL_BYTES,
  DEFAULT_MAX_JOURNAL_EVENTS,
  JOURNAL_GROWTH_HARD_CAP_BYTES,
} from '@qwen-code/acp-bridge/replayWindowLimits';
import type {
  BridgeDaemonStatusSnapshot,
  HttpAcpBridge,
} from '@qwen-code/acp-bridge/bridgeTypes';
import * as qwenCore from '@qwen-code/qwen-code-core';
import * as serverModule from './server.js';
import * as pemCertificateBlocks from './pem-certificate-blocks.js';
import * as webShellResolver from './web-shell-resolver.js';
import * as webShellStatic from './web-shell-static.js';
import { applyOpenWithAuth } from './open-with-auth.js';
import * as settingsRuntime from '../config/settings.js';
import * as environmentRuntime from '../config/environment.js';
import * as trustedFoldersRuntime from '../config/trustedFolders.js';
import * as trustPolicyRuntime from '../config/daemon-trust-policy.js';
import * as workspaceServiceRuntime from './workspace-service/index.js';
import type {
  ChannelWorkerSnapshot,
  CreateChannelWorkerSupervisorOptions,
} from './channel-worker-supervisor.js';
import type {
  ServiceInfo,
  ServiceInfoWorker,
} from '../commands/channel/pidfile.js';
import { LARGE_PIPE_FRAME_THRESHOLD_BYTES } from './large-pipe-frame-observer.js';
import type { ChannelWebhookEnqueueError } from './channel-webhook-ipc.js';
import { ChannelDeliveryError } from '../runtime/channel-delivery-ipc.js';
import {
  workspaceRegistrationId,
  type WorkspaceRegistrationStore,
} from './workspace-registration-store.js';
import { getDeferredRuntimeRequestTiming } from './server/request-helpers.js';
import type { WorkspaceFileSystemFactory } from './fs/workspace-file-system.js';
import { ConversationWorkspace } from './conversations/conversation-workspace.js';
import type { WorkspaceRuntimeProvenance } from './managed-scratch-workspace.js';
import * as scheduledTaskKeepalive from './scheduled-task-keepalive.js';

const originalTestRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
const isolatedTestRuntimeDir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'qws-run-serve-tests-')),
);
process.env['QWEN_RUNTIME_DIR'] = isolatedTestRuntimeDir;

afterEach(() => {
  process.env['QWEN_RUNTIME_DIR'] = isolatedTestRuntimeDir;
  // Unconditional: a test that pins host memory but rejects before its
  // try/finally cleanup would otherwise leak the figure into later
  // memory-budget tests.
  mockTotalMemBytes.value = undefined;
  mockNetworkInterfaces.value = undefined;
});

afterAll(() => {
  if (originalTestRuntimeDir === undefined) {
    delete process.env['QWEN_RUNTIME_DIR'];
  } else {
    process.env['QWEN_RUNTIME_DIR'] = originalTestRuntimeDir;
  }
  fs.rmSync(isolatedTestRuntimeDir, { recursive: true, force: true });
});

const BASE_BRIDGE_SNAPSHOT: BridgeDaemonStatusSnapshot = {
  limits: {
    maxSessions: 20,
    maxPendingPromptsPerSession: 5,
    eventRingSize: 8000,
    compactedReplayMaxBytes: 4 * 1024 * 1024,
    maxJournalEvents: 10_000,
    maxJournalBytes: 8 * 1024 * 1024,
    journalGrowth: null,
    channelIdleTimeoutMs: 0,
    sessionIdleTimeoutMs: 1_800_000,
  },
  sessionCount: 0,
  pendingPermissionCount: 0,
  channelLive: true,
  permissionPolicy: 'first-responder',
  sessions: [],
};

describe('createBoundChannelDeliveryHandler', () => {
  const info = {
    sessionId: 'session-1',
    deliveryId: 'prompt-1',
    source: 'prompt' as const,
    target: { channelName: 'dingtalk', type: 'user' as const, id: 'user-1' },
    text: 'answer',
    promptId: 'prompt-1',
  };

  it('routes only to the workspace captured by the bridge', async () => {
    const deliverChannelMessage = vi.fn(async () => ({
      delivered: true as const,
    }));
    const authorizations = new ChannelDeliveryAuthorizationStore();
    authorizations.authorizePrompt('/canonical', {
      sessionId: info.sessionId,
      deliveryId: info.deliveryId,
      target: info.target,
    });
    const handler = createBoundChannelDeliveryHandler(
      '/canonical',
      () => ({ deliverChannelMessage }) as never,
      authorizations,
    );

    await expect(
      handler({ ...info, workspaceCwd: '/forged' } as never),
    ).resolves.toEqual({ status: 'delivered' });
    expect(deliverChannelMessage).toHaveBeenCalledWith('/canonical', {
      deliveryId: 'prompt-1',
      channelName: 'dingtalk',
      target: { type: 'user', id: 'user-1' },
      text: 'answer',
    });
  });

  it('does not lazily start a missing manager and returns a clear failure', async () => {
    const getManager = vi.fn(() => undefined);
    const warn = vi.fn(() => {
      throw new Error('logger unavailable');
    });
    const authorizations = new ChannelDeliveryAuthorizationStore();
    authorizations.authorizePrompt('/canonical', {
      sessionId: info.sessionId,
      deliveryId: info.deliveryId,
      target: info.target,
    });
    const handler = createBoundChannelDeliveryHandler(
      '/canonical',
      getManager,
      authorizations,
      { warn } as never,
    );

    await expect(handler(info)).resolves.toEqual({
      status: 'failed',
      code: 'channel_worker_unavailable',
      error: 'Channel worker is not running.',
    });
    expect(getManager).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('channel delivery failed', {
      sessionId: info.sessionId,
      deliveryId: info.deliveryId,
      source: info.source,
      channelName: info.target.channelName,
      code: 'channel_worker_unavailable',
    });
  });

  it('rejects an unauthorized or changed target before worker IPC', async () => {
    const deliverChannelMessage = vi.fn(async () => ({
      delivered: true as const,
    }));
    const authorizations = new ChannelDeliveryAuthorizationStore();
    const handler = createBoundChannelDeliveryHandler(
      '/canonical',
      () => ({ deliverChannelMessage }) as never,
      authorizations,
    );

    await expect(handler(info)).resolves.toEqual({
      status: 'failed',
      code: 'channel_delivery_invalid',
      error: 'Channel delivery is not authorized.',
    });
    authorizations.authorizePrompt('/canonical', {
      sessionId: info.sessionId,
      deliveryId: info.deliveryId,
      target: info.target,
    });
    await expect(
      handler({ ...info, target: { ...info.target, id: 'user-2' } }),
    ).resolves.toEqual({
      status: 'failed',
      code: 'channel_delivery_invalid',
      error: 'Channel delivery is not authorized.',
    });
    expect(deliverChannelMessage).not.toHaveBeenCalled();

    await expect(handler(info)).resolves.toEqual({ status: 'delivered' });
    expect(deliverChannelMessage).toHaveBeenCalledTimes(1);
  });

  it('consumes prompt authorization before skipping an empty final', async () => {
    const getManager = vi.fn(() => undefined);
    const authorizations = new ChannelDeliveryAuthorizationStore();
    authorizations.authorizePrompt('/canonical', {
      sessionId: info.sessionId,
      deliveryId: info.deliveryId,
      target: info.target,
    });
    const handler = createBoundChannelDeliveryHandler(
      '/canonical',
      getManager,
      authorizations,
    );

    await expect(handler({ ...info, text: '  \n' })).resolves.toEqual({
      status: 'skipped',
    });
    expect(getManager).not.toHaveBeenCalled();
    await expect(handler(info)).resolves.toEqual({
      status: 'failed',
      code: 'channel_delivery_invalid',
      error: 'Channel delivery is not authorized.',
    });
  });

  it('advances recurring scheduled authorization before skipping an empty final', async () => {
    const deliverChannelMessage = vi.fn(async () => ({
      delivered: true as const,
    }));
    const authorizations = new ChannelDeliveryAuthorizationStore();
    authorizations.registerScheduledTask('/canonical', {
      sessionId: info.sessionId,
      taskId: 'task-1',
      target: info.target,
      recurring: true,
    });
    const handler = createBoundChannelDeliveryHandler(
      '/canonical',
      () => ({ deliverChannelMessage }) as never,
      authorizations,
    );
    const scheduledInfo = {
      ...info,
      deliveryId: 'task-1:100',
      source: 'scheduled' as const,
      text: '',
      promptId: undefined,
      taskId: 'task-1',
      firedAt: 100,
    };

    await expect(handler(scheduledInfo)).resolves.toEqual({
      status: 'skipped',
    });
    expect(deliverChannelMessage).not.toHaveBeenCalled();
    await expect(handler(scheduledInfo)).resolves.toMatchObject({
      status: 'failed',
      code: 'channel_delivery_invalid',
    });
    await expect(
      handler({
        ...scheduledInfo,
        deliveryId: 'task-1:101',
        firedAt: 101,
        text: 'next answer',
      }),
    ).resolves.toEqual({ status: 'delivered' });
  });

  it('consumes one-shot scheduled authorization before skipping an empty final', async () => {
    const getManager = vi.fn(() => undefined);
    const authorizations = new ChannelDeliveryAuthorizationStore();
    authorizations.registerScheduledTask('/canonical', {
      sessionId: info.sessionId,
      taskId: 'task-once',
      target: info.target,
      recurring: false,
    });
    const handler = createBoundChannelDeliveryHandler(
      '/canonical',
      getManager,
      authorizations,
    );
    const scheduledInfo = {
      ...info,
      deliveryId: 'task-once:100',
      source: 'scheduled' as const,
      text: '',
      promptId: undefined,
      taskId: 'task-once',
      firedAt: 100,
    };

    await expect(handler(scheduledInfo)).resolves.toEqual({
      status: 'skipped',
    });
    expect(getManager).not.toHaveBeenCalled();
    await expect(
      handler({
        ...scheduledInfo,
        deliveryId: 'task-once:101',
        firedAt: 101,
        text: 'later answer',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      code: 'channel_delivery_invalid',
    });
  });

  it('logs a sanitized diagnostic for unexpected delivery failures', async () => {
    vi.stubEnv('CHANNEL_DELIVERY_TEST_API_KEY', 'worker-secret');
    const deliverChannelMessage = vi
      .fn()
      .mockRejectedValue(new Error('EPIPE worker-secret daemon-secret user-1'));
    const warn = vi.fn();
    const authorizations = new ChannelDeliveryAuthorizationStore();
    authorizations.authorizePrompt('/canonical', {
      sessionId: info.sessionId,
      deliveryId: info.deliveryId,
      target: info.target,
    });
    const handler = createBoundChannelDeliveryHandler(
      '/canonical',
      () => ({ deliverChannelMessage }) as never,
      authorizations,
      { warn } as never,
      {
        daemonToken: 'daemon-secret',
        workerEnv: process.env,
      },
    );

    try {
      const result = await handler(info);
      expect(result).toEqual({
        status: 'failed',
        code: 'channel_delivery_failed',
        error: 'Channel delivery failed.',
      });
      expect(warn).toHaveBeenCalledWith('channel delivery failed', {
        sessionId: info.sessionId,
        deliveryId: info.deliveryId,
        source: info.source,
        channelName: info.target.channelName,
        code: 'channel_delivery_failed',
        diagnostic: 'EPIPE <redacted> <redacted> <redacted>',
      });
      expect(JSON.stringify({ result, calls: warn.mock.calls })).not.toMatch(
        /worker-secret|daemon-secret|user-1/u,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('sanitizes typed delivery failures before returning them', async () => {
    vi.stubEnv('CHANNEL_DELIVERY_TEST_API_KEY', 'abcdworkerxyz');
    const collidingInfo = {
      ...info,
      target: { ...info.target, id: 'worker' },
    };
    const deliverChannelMessage = vi
      .fn()
      .mockRejectedValue(
        new ChannelDeliveryError(
          'channel_worker_unavailable',
          'Channel worker is not running. abcdworkerxyz daemon-secret /canonical',
        ),
      );
    const warn = vi.fn();
    const authorizations = new ChannelDeliveryAuthorizationStore();
    authorizations.authorizePrompt('/canonical', {
      sessionId: collidingInfo.sessionId,
      deliveryId: collidingInfo.deliveryId,
      target: collidingInfo.target,
    });
    const handler = createBoundChannelDeliveryHandler(
      '/canonical',
      () => ({ deliverChannelMessage }) as never,
      authorizations,
      { warn } as never,
      {
        daemonToken: 'daemon-secret',
        workerEnv: process.env,
      },
    );

    try {
      const result = await handler(collidingInfo);
      expect(result).toEqual({
        status: 'failed',
        code: 'channel_worker_unavailable',
        error: 'Channel worker is unavailable.',
      });
      expect(warn).toHaveBeenCalledWith('channel delivery failed', {
        sessionId: collidingInfo.sessionId,
        deliveryId: collidingInfo.deliveryId,
        source: collidingInfo.source,
        channelName: collidingInfo.target.channelName,
        code: 'channel_worker_unavailable',
        diagnostic:
          'Channel <redacted> is not running. <redacted> <redacted> /canonical',
      });
      expect(JSON.stringify({ result, calls: warn.mock.calls })).not.toMatch(
        /abcdworkerxyz|abcd|xyz|daemon-secret/u,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps diagnostic formatting failures out of the delivery result path', async () => {
    const diagnosticFailure = {
      toString: () => {
        throw new Error('diagnostic formatting failed');
      },
    };
    const deliverChannelMessage = vi.fn().mockRejectedValue(diagnosticFailure);
    const warn = vi.fn();
    const authorizations = new ChannelDeliveryAuthorizationStore();
    authorizations.authorizePrompt('/canonical', {
      sessionId: info.sessionId,
      deliveryId: info.deliveryId,
      target: info.target,
    });
    const handler = createBoundChannelDeliveryHandler(
      '/canonical',
      () => ({ deliverChannelMessage }) as never,
      authorizations,
      { warn } as never,
    );

    await expect(handler(info)).resolves.toEqual({
      status: 'failed',
      code: 'channel_delivery_failed',
      error: 'Channel delivery failed.',
    });
  });
});

function makeRuntimeBridge(): HttpAcpBridge {
  return {
    spawnOrAttach: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    killAllSync: vi.fn(),
    getSession: vi.fn(),
    getAllSessions: vi.fn().mockReturnValue([]),
    publishWorkspaceEvent: vi.fn(),
    getEventRing: vi.fn().mockReturnValue({ getAll: () => [] }),
    resume: vi.fn(),
    preheat: vi.fn().mockResolvedValue(undefined),
    invokeWorkspaceCommand: vi.fn().mockResolvedValue({ configsFailed: 0 }),
    sessionCount: 0,
    pendingPermissionCount: 0,
    activePromptCount: 0,
    activeWork: false,
    activeWorkCoverage: {
      total: 0,
      covered: 0,
      onNegotiatedChannel: 0,
      oldestCoveredReportAt: null,
    },
    lastActivityAt: null,
    getDaemonStatusSnapshot: vi.fn().mockReturnValue(BASE_BRIDGE_SNAPSHOT),
    isChannelLive: vi.fn().mockReturnValue(true),
  } as unknown as HttpAcpBridge;
}

it('restores the Conversations runtime for a persisted scheduled task', async () => {
  delete process.env['QWEN_RUNTIME_DIR'];
  const tempRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qws-live-task-keepalive-')),
  );
  const workspace = path.join(tempRoot, 'workspace');
  const physicalHome = path.join(tempRoot, 'home');
  const linkedHome = path.join(tempRoot, 'home-link');
  const runtimeDir = path.join(tempRoot, 'runtime');
  fs.mkdirSync(workspace);
  fs.mkdirSync(physicalHome);
  fs.symlinkSync(
    physicalHome,
    linkedHome,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const liveConversationWorkspace = new ConversationWorkspace({
    homeDir: linkedHome,
  });
  const { canonicalRoot } = await liveConversationWorkspace.getRoot();
  fs.mkdirSync(path.join(canonicalRoot, '.qwen'));
  fs.writeFileSync(
    path.join(canonicalRoot, '.qwen', 'settings.json'),
    JSON.stringify({ advanced: { runtimeOutputDir: runtimeDir } }),
  );
  await qwenCore.Storage.runWithResolvedRuntimeBaseDir(runtimeDir, () =>
    qwenCore.updateCronTasks(canonicalRoot, () => [
      {
        id: 'live-task',
        cron: '0 9 * * *',
        prompt: 'p',
        recurring: true,
        createdAt: 1_700_000_000_000,
        lastFiredAt: null,
        sessionId: 'live-session',
        sessionOwnedByTask: false,
      },
    ]),
  );
  const startKeepalive = vi
    .spyOn(scheduledTaskKeepalive, 'startScheduledTaskKeepalive')
    .mockReturnValue({
      stop: vi.fn(),
      tick: vi.fn().mockResolvedValue(undefined),
    });
  vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(
    () =>
      ({
        ...makeRuntimeBridge(),
        recordHeartbeat: vi.fn(),
        resumeSession: vi.fn().mockResolvedValue({}),
        setLiveScreenContextCaptureHandler: vi.fn(),
        setLiveTaskToolRequestHandler: vi.fn(),
        setLiveSpeakToUserHandler: vi.fn(),
      }) as ReturnType<typeof acpBridge.createAcpSessionBridge>,
  );
  let handle: RunHandle | undefined;

  try {
    handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge: makeRuntimeBridge(),
        liveConversationWorkspace,
        // Isolate the Conversations-runtime ownership record from the
        // machine-global ~/.qwen path: a concurrent live owner there
        // (another worker / a developer's qwen serve) would fail this boot.
        liveDiscoveryStableBaseDir: path.join(tempRoot, 'stable'),
        resolveOnListen: true,
      },
    );
    await handle.runtimeReady;
    await vi.waitFor(() => {
      expect(startKeepalive).toHaveBeenCalledWith(
        expect.objectContaining({
          boundWorkspace: canonicalRoot,
        }),
      );
    });
  } finally {
    await handle?.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});

function writeWebShellFixture(workspaceDir: string): string {
  const shellDir = path.join(workspaceDir, 'web-shell');
  fs.mkdirSync(path.join(shellDir, 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(shellDir, 'index.html'),
    '<!doctype html><body><div id="root"></div></body>',
  );
  vi.spyOn(webShellResolver, 'resolveWebShellDir').mockReturnValue(shellDir);
  return shellDir;
}

async function startDeferredDaemon(
  workspace: string,
  overrides: {
    serveOptions?: Partial<Parameters<typeof runQwenServe>[0]>;
    createBridge?: () => HttpAcpBridge;
  } = {},
) {
  const createBridge = vi
    .spyOn(acpBridge, 'createAcpSessionBridge')
    .mockImplementation(() => {
      const bridge = overrides.createBridge
        ? overrides.createBridge()
        : makeRuntimeBridge();
      return bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>;
    });
  const handle = await runQwenServe(
    {
      port: 0,
      hostname: '127.0.0.1',
      mode: 'http-bridge',
      workspace,
      maxSessions: 1,
      token: 'secret-token',
      ...overrides.serveOptions,
    },
    {
      resolveOnListen: true,
      deferRuntimeUntilFirstHealth: true,
      runtimeStartupTimeoutMs: 0,
    },
  );
  return { handle, createBridge };
}

const mockCreateSpawnChannelFactoryOptions = vi.hoisted(
  () => [] as Array<Record<string, unknown>>,
);
const mockChannelWorkerEnabledState = vi.hoisted(() => ({
  value: undefined as boolean | undefined,
}));
const mockTotalMemBytes = vi.hoisted(() => ({
  value: undefined as number | undefined,
}));
const mockNetworkInterfaces = vi.hoisted(() => ({
  value: undefined as NodeJS.Dict<os.NetworkInterfaceInfo[]> | undefined,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  // Mock both the named and the default export: consumers do
  // `import os from 'node:os'`, which a bare spread would leave unmocked.
  const totalmem = () => mockTotalMemBytes.value ?? actual.totalmem();
  const networkInterfaces = () =>
    mockNetworkInterfaces.value ?? actual.networkInterfaces();
  return {
    ...actual,
    totalmem,
    networkInterfaces,
    default: { ...actual, totalmem, networkInterfaces },
  };
});

async function getFreeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

vi.mock('@qwen-code/acp-bridge/spawnChannel', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/acp-bridge/spawnChannel')>();
  return {
    ...actual,
    createSpawnChannelFactory: vi.fn(
      (options: Record<string, unknown> = {}) => {
        mockCreateSpawnChannelFactoryOptions.push(options);
        return actual.createSpawnChannelFactory(options);
      },
    ),
  };
});

vi.mock('./channel-worker-manager.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./channel-worker-manager.js')>();
  return {
    ...actual,
    createChannelWorkerManager: (
      ...args: Parameters<typeof actual.createChannelWorkerManager>
    ) => {
      const manager = actual.createChannelWorkerManager(...args);
      return {
        ...manager,
        state: () => {
          const state = manager.state();
          return mockChannelWorkerEnabledState.value === undefined
            ? state
            : { ...state, enabled: mockChannelWorkerEnabledState.value };
        },
      };
    },
  };
});

describe('workspace skill settings persistence', () => {
  let handle: RunHandle | undefined;
  let workspace = '';
  let qwenHome = '';
  let previousQwenHome: string | undefined;

  afterEach(async () => {
    await handle?.close();
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
    if (qwenHome) fs.rmSync(qwenHome, { recursive: true, force: true });
    if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = previousQwenHome;
    settingsRuntime.resetHomeEnvBootstrapForTesting();
    vi.restoreAllMocks();
  });

  it('canonicalizes, deduplicates, preserves orphans, and serializes updates across settings scopes', async () => {
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-skill-settings-')),
    );
    qwenHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-skill-home-')),
    );
    previousQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = qwenHome;
    settingsRuntime.resetHomeEnvBootstrapForTesting();
    fs.mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({
        skills: { disabled: ['orphan', ' ReViEw ', 'review'] },
      }),
    );
    fs.writeFileSync(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify({
        skills: {
          disabled: ['locked-skill'],
          defaultDisabled: ['opt-in-skill', 'inherited-opt-in'],
          enabled: ['INHERITED-OPT-IN'],
        },
      }),
    );

    const originalCreateServeApp = serverModule.createServeApp;
    let persistDisabledSkills:
      | NonNullable<
          Parameters<typeof serverModule.createServeApp>[2]
        >['persistDisabledSkills']
      | undefined;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      persistDisabledSkills = args[2]?.persistDisabledSkills;
      return originalCreateServeApp(...args);
    });
    handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace,
        serveWebShell: false,
      },
      { bridge: makeRuntimeBridge() },
    );
    await handle.runtimeReady;
    expect(persistDisabledSkills).toBeDefined();
    await expect(
      persistDisabledSkills!(workspace, 'inherited-opt-in', true),
    ).resolves.toEqual({
      changed: false,
      disabled: ['orphan', ' ReViEw ', 'review'],
    });

    await expect(
      persistDisabledSkills!(workspace, 'review', false),
    ).resolves.toEqual({
      changed: true,
      disabled: ['orphan', 'review'],
      settingsChanges: [
        { key: 'skills.disabled', value: ['orphan', 'review'] },
      ],
    });
    await expect(
      persistDisabledSkills!(workspace, 'review', false),
    ).resolves.toEqual({
      changed: false,
      disabled: ['orphan', 'review'],
    });

    await Promise.all([
      persistDisabledSkills!(workspace, 'alpha', false),
      persistDisabledSkills!(workspace, 'beta', false),
    ]);
    await expect(
      persistDisabledSkills!(workspace, 'review', true),
    ).resolves.toMatchObject({ changed: true });
    await expect(
      persistDisabledSkills!(workspace, 'opt-in-skill', true),
    ).resolves.toEqual({
      changed: true,
      disabled: ['orphan', 'alpha', 'beta'],
      settingsChanges: [{ key: 'skills.enabled', value: ['opt-in-skill'] }],
    });

    const saved = JSON.parse(
      fs.readFileSync(path.join(workspace, '.qwen', 'settings.json'), 'utf8'),
    ) as { skills: { disabled: string[]; enabled: string[] } };
    expect(saved.skills.disabled).toEqual(['orphan', 'alpha', 'beta']);
    expect(saved.skills.enabled).toEqual(['opt-in-skill']);
    await expect(
      persistDisabledSkills!(workspace, 'locked-skill', false),
    ).resolves.toEqual({
      changed: true,
      disabled: ['orphan', 'alpha', 'beta', 'locked-skill'],
      settingsChanges: [
        {
          key: 'skills.disabled',
          value: ['orphan', 'alpha', 'beta', 'locked-skill'],
        },
      ],
    });
    await expect(
      persistDisabledSkills!(workspace, 'locked-skill', true),
    ).resolves.toEqual({
      changed: true,
      disabled: ['orphan', 'alpha', 'beta'],
      settingsChanges: [
        {
          key: 'skills.disabled',
          value: ['orphan', 'alpha', 'beta'],
        },
      ],
    });
    const savedUser = JSON.parse(
      fs.readFileSync(path.join(qwenHome, 'settings.json'), 'utf8'),
    ) as { skills: { disabled: string[] } };
    expect(savedUser.skills.disabled).toEqual(['locked-skill']);
  });

  it('produces both skills.disabled and skills.enabled changes when enabling a workspace-hard-disabled default-disabled skill', async () => {
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-skill-dual-')),
    );
    qwenHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-skill-dual-home-')),
    );
    previousQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = qwenHome;
    settingsRuntime.resetHomeEnvBootstrapForTesting();
    fs.mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({
        skills: { disabled: ['dual-skill'] },
      }),
    );
    fs.writeFileSync(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify({
        skills: { defaultDisabled: ['dual-skill'] },
      }),
    );

    const originalCreateServeApp = serverModule.createServeApp;
    let persistDisabledSkills:
      | NonNullable<
          Parameters<typeof serverModule.createServeApp>[2]
        >['persistDisabledSkills']
      | undefined;
    let persistDisabledTools:
      | Parameters<
          typeof workspaceServiceRuntime.createDaemonWorkspaceService
        >[0]['persistDisabledTools']
      | undefined;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      persistDisabledSkills = args[2]?.persistDisabledSkills;
      persistDisabledTools = args[2]?.persistDisabledTools;
      return originalCreateServeApp(...args);
    });
    handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace,
        serveWebShell: false,
      },
      { bridge: makeRuntimeBridge() },
    );
    await handle.runtimeReady;
    expect(persistDisabledSkills).toBeDefined();
    expect(persistDisabledTools).toBeDefined();

    await expect(
      persistDisabledSkills!(workspace, 'dual-skill', true),
    ).resolves.toEqual({
      changed: true,
      disabled: [],
      settingsChanges: [
        { key: 'skills.disabled', value: undefined },
        { key: 'skills.enabled', value: ['dual-skill'] },
      ],
    });

    const saved = JSON.parse(
      fs.readFileSync(path.join(workspace, '.qwen', 'settings.json'), 'utf8'),
    ) as { skills: { disabled?: string[]; enabled: string[] } };
    expect(saved.skills.disabled).toBeUndefined();
    expect(saved.skills.enabled).toEqual(['dual-skill']);

    const setValue = vi.spyOn(
      settingsRuntime.LoadedSettings.prototype,
      'setValue',
    );
    const setValues = vi.spyOn(
      settingsRuntime.LoadedSettings.prototype,
      'setValues',
    );

    const skillGuard = vi.fn();
    await persistDisabledSkills!(workspace, 'guarded-skill', false, skillGuard);
    expect(setValues.mock.calls).toHaveLength(1);
    expect(setValues.mock.calls[0]?.[2]).toBe(skillGuard);

    const toolGuard = vi.fn();
    await persistDisabledTools!(workspace, 'guarded-tool', false, toolGuard);
    expect(setValue.mock.calls).toHaveLength(1);
    expect(setValue.mock.calls[0]?.[3]).toBe(toolGuard);
  });

  it('persists a Skill batch with one settings write across settings scopes', async () => {
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-skill-batch-')),
    );
    qwenHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-skill-batch-home-')),
    );
    previousQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = qwenHome;
    settingsRuntime.resetHomeEnvBootstrapForTesting();
    fs.mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({ skills: { disabled: ['orphan'] } }),
    );
    fs.writeFileSync(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify({
        skills: {
          disabled: ['locked-skill'],
          defaultDisabled: ['opt-in'],
        },
      }),
    );

    const originalCreateServeApp = serverModule.createServeApp;
    let persistDisabledSkillsBatch:
      | NonNullable<
          Parameters<typeof serverModule.createServeApp>[2]
        >['persistDisabledSkillsBatch']
      | undefined;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      persistDisabledSkillsBatch = args[2]?.persistDisabledSkillsBatch;
      return originalCreateServeApp(...args);
    });
    handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace,
        serveWebShell: false,
      },
      { bridge: makeRuntimeBridge() },
    );
    await handle.runtimeReady;
    expect(persistDisabledSkillsBatch).toBeDefined();
    const setValues = vi.spyOn(
      settingsRuntime.LoadedSettings.prototype,
      'setValues',
    );

    const result = await persistDisabledSkillsBatch!(
      workspace,
      ['review', 'alpha', 'locked-skill'],
      false,
    );

    expect(result.outcomes).toHaveLength(3);
    expect(result.outcomes[0]).toEqual({
      skillName: 'review',
      changed: true,
    });
    expect(result.outcomes[1]).toEqual({
      skillName: 'alpha',
      changed: true,
    });
    expect(result.outcomes[2]).toEqual({
      skillName: 'locked-skill',
      changed: true,
    });
    expect(result.settingsChanges).toEqual([
      {
        key: 'skills.disabled',
        value: ['orphan', 'review', 'alpha', 'locked-skill'],
      },
    ]);
    expect(setValues).toHaveBeenCalledOnce();

    const noopResult = await persistDisabledSkillsBatch!(
      workspace,
      ['review'],
      false,
    );
    expect(noopResult.outcomes).toEqual([
      { skillName: 'review', changed: false },
    ]);
    expect(noopResult.settingsChanges).toEqual([]);
    expect(setValues).toHaveBeenCalledOnce();

    const savedAfterDisable = JSON.parse(
      fs.readFileSync(path.join(workspace, '.qwen', 'settings.json'), 'utf8'),
    ) as { skills: { disabled: string[]; enabled?: string[] } };
    expect(savedAfterDisable.skills.disabled).toEqual([
      'orphan',
      'review',
      'alpha',
      'locked-skill',
    ]);
    expect(savedAfterDisable.skills.enabled).toBeUndefined();
    const savedUser = JSON.parse(
      fs.readFileSync(path.join(qwenHome, 'settings.json'), 'utf8'),
    ) as { skills: { disabled: string[]; enabled?: string[] } };
    expect(savedUser.skills.disabled).toEqual(['locked-skill']);
    expect(savedUser.skills.enabled).toBeUndefined();

    const preinstallNoop = await persistDisabledSkillsBatch!(
      workspace,
      ['future-skill'],
      true,
    );
    expect(preinstallNoop.outcomes).toEqual([
      { skillName: 'future-skill', changed: false },
    ]);
    expect(preinstallNoop.settingsChanges).toEqual([]);
    expect(setValues).toHaveBeenCalledOnce();

    const preinstallEnable = await persistDisabledSkillsBatch!(
      workspace,
      ['orphan'],
      true,
    );
    expect(preinstallEnable.outcomes).toEqual([
      { skillName: 'orphan', changed: true },
    ]);
    expect(preinstallEnable.settingsChanges).toEqual([
      {
        key: 'skills.disabled',
        value: ['review', 'alpha', 'locked-skill'],
      },
    ]);
    expect(setValues).toHaveBeenCalledTimes(2);

    const enableResult = await persistDisabledSkillsBatch!(
      workspace,
      ['opt-in'],
      true,
    );

    expect(enableResult.outcomes).toEqual([
      { skillName: 'opt-in', changed: true },
    ]);
    expect(enableResult.settingsChanges).toEqual([
      {
        key: 'skills.enabled',
        value: ['opt-in'],
      },
    ]);
    expect(setValues).toHaveBeenCalledTimes(3);

    const savedAfterEnable = JSON.parse(
      fs.readFileSync(path.join(workspace, '.qwen', 'settings.json'), 'utf8'),
    ) as { skills: { disabled: string[]; enabled: string[] } };
    expect(savedAfterEnable.skills.disabled).toEqual([
      'review',
      'alpha',
      'locked-skill',
    ]);
    expect(savedAfterEnable.skills.enabled).toEqual(['opt-in']);

    const guard = vi.fn();
    await persistDisabledSkillsBatch!(workspace, ['guarded'], false, guard);
    expect(setValues.mock.calls.at(-1)?.[2]).toBe(guard);
    expect(guard).toHaveBeenCalled();

    const blockingGuard = vi.fn(() => {
      throw new Error('generation closed');
    });
    const writesBefore = setValues.mock.calls.length;
    await expect(
      persistDisabledSkillsBatch!(
        workspace,
        ['guarded-too'],
        false,
        blockingGuard,
      ),
    ).rejects.toThrow('generation closed');
    expect(setValues.mock.calls).toHaveLength(writesBefore);
  });
});

/**
 * #4297 fold-in 7 (deepseek S1, addresses #3262690842). Lock the
 * `context.fileName` extraction logic so a regression doesn't
 * silently re-enable the P2-1 bug (init writes default `QWEN.md`
 * even when the workspace configured `AGENTS.md` etc.). The four
 * branches the suggestion called out are exercised explicitly here;
 * the runQwenServe boot path itself stays integration-tested
 * end-to-end via the daemon-process tests in
 * `integration-tests/cli/qwen-serve-routes.test.ts`.
 */
describe('extractContextFilename (#4297 fold-in 7 P2-1 helper)', () => {
  it('returns a trimmed string when given a non-empty string', () => {
    expect(extractContextFilename('AGENTS.md')).toBe('AGENTS.md');
    expect(extractContextFilename('  CUSTOM.md  ')).toBe('CUSTOM.md');
  });

  it('returns undefined for empty / whitespace-only strings', () => {
    expect(extractContextFilename('')).toBeUndefined();
    expect(extractContextFilename('   ')).toBeUndefined();
    expect(extractContextFilename('\n\t')).toBeUndefined();
  });

  it('returns the first non-empty string when given an array', () => {
    expect(extractContextFilename(['AGENTS.md', 'BACKUP.md'])).toBe(
      'AGENTS.md',
    );
    // Skips empty and whitespace entries to find the first valid name.
    expect(extractContextFilename(['', '  ', 'PRIMARY.md', 'OTHER.md'])).toBe(
      'PRIMARY.md',
    );
    // Trims the picked element.
    expect(extractContextFilename(['  CUSTOM.md  '])).toBe('CUSTOM.md');
  });

  it('returns undefined when the array has no string entries', () => {
    expect(extractContextFilename([])).toBeUndefined();
    expect(extractContextFilename(['', '  ', '\n'])).toBeUndefined();
    // Non-string entries are filtered out — when nothing valid remains,
    // the bridge falls back to its own default.
    expect(
      extractContextFilename([null, undefined, 42, { a: 1 }] as unknown[]),
    ).toBeUndefined();
  });

  it('returns undefined for non-string non-array inputs', () => {
    // Hand-edited `settings.json` could land any of these shapes;
    // the helper must NOT coerce (avoids the literal `[object Object]`
    // filename that the previous `String(...)` cast produced).
    expect(extractContextFilename(undefined)).toBeUndefined();
    expect(extractContextFilename(null)).toBeUndefined();
    expect(extractContextFilename(42)).toBeUndefined();
    expect(extractContextFilename(true)).toBeUndefined();
    expect(extractContextFilename({ fileName: 'AGENTS.md' })).toBeUndefined();
  });
});

describe('subSessionConcurrencyCapsFromSettings', () => {
  it('passes through positive integer caps', () => {
    expect(
      subSessionConcurrencyCapsFromSettings({
        maxConcurrentSubSessionsPerCaller: 8,
        maxConcurrentSubSessionsTotal: 12,
      }),
    ).toEqual({ maxConcurrentPerCaller: 8, maxConcurrentTotal: 12 });
  });

  it('omits absent keys so launcher defaults apply', () => {
    expect(subSessionConcurrencyCapsFromSettings({})).toEqual({});
  });

  it('rejects values outside positive integers', () => {
    // Hand-edited settings.json could land any of these; coercing (e.g.
    // accepting 0 or "10") would silently disable or misread a resource cap.
    const onWarning = vi.fn();
    expect(
      subSessionConcurrencyCapsFromSettings(
        {
          maxConcurrentSubSessionsPerCaller: 0,
          maxConcurrentSubSessionsTotal: -1,
        },
        onWarning,
      ),
    ).toEqual({});
    expect(
      subSessionConcurrencyCapsFromSettings(
        {
          maxConcurrentSubSessionsPerCaller: 2.5,
          maxConcurrentSubSessionsTotal: '10',
        },
        onWarning,
      ),
    ).toEqual({});
    expect(onWarning).toHaveBeenCalledTimes(4);
  });

  it('keeps a valid cap when the sibling key is invalid', () => {
    expect(
      subSessionConcurrencyCapsFromSettings(
        {
          maxConcurrentSubSessionsPerCaller: 8,
          maxConcurrentSubSessionsTotal: Number.NaN,
        },
        () => {},
      ),
    ).toEqual({ maxConcurrentPerCaller: 8 });
  });

  it('warns naming a present-but-invalid cap', () => {
    const onWarning = vi.fn();
    expect(
      subSessionConcurrencyCapsFromSettings(
        { maxConcurrentSubSessionsTotal: '50' },
        onWarning,
      ),
    ).toEqual({});
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0][0]).toContain(
      'maxConcurrentSubSessionsTotal',
    );
    // JSON.stringify keeps the quotes, revealing the value is a string.
    expect(onWarning.mock.calls[0][0]).toContain('"50"');
  });

  it('does not warn when the keys are absent', () => {
    const onWarning = vi.fn();
    subSessionConcurrencyCapsFromSettings({}, onWarning);
    expect(onWarning).not.toHaveBeenCalled();
  });
});

const dialLoopback = (
  host: string,
  port: number,
): Promise<{ ok: boolean; code?: string }> =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port, autoSelectFamily: false }, () => {
      socket.destroy();
      resolve({ ok: true });
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve({ ok: false, code: err.code });
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve({ ok: false, code: 'ETIMEDOUT' });
    });
  });

const listenOn = (options: net.ListenOptions): Promise<net.Server> =>
  new Promise((resolve, reject) => {
    const server = net.createServer((connection) => connection.end());
    server.once('error', reject);
    server.listen(options, () => resolve(server));
  });

describe('formatChannelWorkerDaemonUrl', () => {
  it('uses IPv4 loopback for the IPv4 wildcard bind', () => {
    expect(formatChannelWorkerDaemonUrl('0.0.0.0', 4170)).toBe(
      'http://127.0.0.1:4170',
    );
  });

  it.each(['0', '0.0'])(
    'canonicalizes IPv4 wildcard spelling %j before choosing loopback',
    (host) => {
      expect(formatChannelWorkerDaemonUrl(host, 4170)).toBe(
        'http://127.0.0.1:4170',
      );
    },
  );

  // R7-7: the IPv6 wildcard's dial-back loopback follows what the host
  // ASSIGNS — `[::1]` when the host carries it (an IPv4-less host has no
  // other loopback). Node keeps the bound socket dual-stack (libuv pins
  // IPV6_V6ONLY=0), so the `net.ipv6.bindv6only` sysctl never changes this.
  it.each(['::', '[::]'])(
    'uses IPv6 loopback for the IPv6 wildcard host %j when the host assigns ::1',
    (host) => {
      expect(
        formatChannelWorkerDaemonUrl(host, 4170, false, undefined, true),
      ).toBe('http://[::1]:4170');
    },
  );

  // The other half of R7-7 (#9406): a host that binds `::` while its
  // loopback carries no `::1` (e.g. `net.ipv6.conf.lo.disable_ipv6=1`)
  // reaches the dual-stack socket only through `127.0.0.1` — the old
  // spelling-based `[::1]` dialled an address nothing owned there, and the
  // first worker's `fetch failed` exited the daemon.
  it.each(['::', '[::]'])(
    'falls back to IPv4 loopback for the IPv6 wildcard host %j when the host carries no ::1',
    (host) => {
      expect(
        formatChannelWorkerDaemonUrl(host, 4170, false, undefined, false),
      ).toBe('http://127.0.0.1:4170');
    },
  );

  // R10-1: `listen(port, '')` tries the IPv6 unspecified address first and
  // falls back to binding `0.0.0.0` when IPv6 is unavailable, so an empty
  // --hostname decides by the socket that actually bound, not by spelling —
  // on the fallback host the old spelling-based rule handed workers `[::1]`,
  // which nothing listened on, and the first worker's failure exited the
  // daemon. Explicit `::`/`0.0.0.0` keep their spelling-based mapping: those
  // binds fail loud when their family is unavailable.
  it('uses IPv6 loopback for an empty hostname on an IPv6 socket when the host assigns ::1', () => {
    expect(formatChannelWorkerDaemonUrl('', 4170, false, undefined, true)).toBe(
      'http://[::1]:4170',
    );
    expect(formatChannelWorkerDaemonUrl('', 4170, false, 'IPv6', true)).toBe(
      'http://[::1]:4170',
    );
  });

  it('falls back to IPv4 loopback for an empty hostname on an IPv6 socket when the host carries no ::1', () => {
    expect(
      formatChannelWorkerDaemonUrl('', 4170, false, undefined, false),
    ).toBe('http://127.0.0.1:4170');
    expect(formatChannelWorkerDaemonUrl('', 4170, false, 'IPv6', false)).toBe(
      'http://127.0.0.1:4170',
    );
  });

  it('falls back to IPv4 loopback for an empty hostname on an IPv4-bound socket', () => {
    expect(formatChannelWorkerDaemonUrl('', 4170, false, 'IPv4')).toBe(
      'http://127.0.0.1:4170',
    );
    expect(formatChannelWorkerDaemonUrl('', 4170, true, 'IPv4')).toBe(
      'https://127.0.0.1:4170',
    );
  });

  it.each(['::0', '0::0', '[::0]', '0:0:0:0:0:0:0:0'])(
    'canonicalizes IPv6 wildcard spelling %j before choosing loopback',
    (host) => {
      expect(
        formatChannelWorkerDaemonUrl(host, 4170, false, undefined, true),
      ).toBe('http://[::1]:4170');
    },
  );

  // R14-2: the v4 wildcard's IPv4-mapped spelling canonicalizes to
  // `::ffff:0:0` (WHATWG URL serializes `[::ffff:0.0.0.0]` by dropping the
  // dotted quad), so it matches NEITHER wildcard branch above and used to
  // fall through to the raw literal — which `assertChannelWorkerDaemonUrlIsLocal`
  // then refused, even though Node binds it as a working wildcard. The
  // mapping is v4 loopback, NOT `[::1]`: measured against such a bind,
  // `dial 127.0.0.1` -> ok while `dial ::1` -> ECONNREFUSED even though
  // the socket reports family IPv6.
  it.each([
    '::ffff:0.0.0.0',
    '::ffff:0:0',
    '[::ffff:0.0.0.0]',
    '[::ffff:0:0]',
    '::FFFF:0.0.0.0',
  ])('uses IPv4 loopback for the v4-mapped wildcard spelling %j', (host) => {
    expect(formatChannelWorkerDaemonUrl(host, 4170)).toBe(
      'http://127.0.0.1:4170',
    );
    expect(formatChannelWorkerDaemonUrl(host, 4170, true)).toBe(
      'https://127.0.0.1:4170',
    );
  });

  // The oracle for the mappings above: a real socket per bind shape, dialled
  // at the address the worker is actually handed. The certification reads
  // the host's interface table, so whichever loopback it picks IS assigned
  // and the dial must succeed on every host where the bind itself succeeds —
  // including runners that bind `::` yet carry no `::1`, the one state where
  // the old spelling-based mapping was wrong (#9406). There is no v6-only
  // arm: the daemon listens via `server.listen(port, host)`, and libuv pins
  // IPV6_V6ONLY=0 unless `ipv6Only` is requested, so the product never binds
  // a v6-only wildcard socket (`net.ipv6.bindv6only` cannot change that).
  it('hands workers a loopback address the bound socket really answers', async () => {
    for (const [bind, listenOptions] of [
      ['::', { host: '::', port: 0 }],
      ['0.0.0.0', { host: '0.0.0.0', port: 0 }],
      // R14-2: the v4-mapped wildcard binds a WORKING wildcard that serves
      // v4 loopback only — measured here through the same dial the workers
      // use; mutating the mapping to `[::1]` reddens this arm.
      ['::ffff:0.0.0.0', { host: '::ffff:0.0.0.0', port: 0 }],
      // R10-1: the daemon's real bind shape for an empty --hostname. The
      // loopback family is read from the socket that actually bound, so on a
      // host without IPv6 this same arm binds 0.0.0.0 and exercises the
      // IPv4 fallback instead.
      ['', { host: '', port: 0 }],
    ] as const) {
      let server: net.Server;
      try {
        server = await listenOn(listenOptions);
      } catch {
        // No AF_INET6 (or no AF_INET) on this runner: nothing to measure.
        continue;
      }
      try {
        const addr = server.address() as AddressInfo;
        const certified = new URL(
          formatChannelWorkerDaemonUrl(
            bind,
            addr.port,
            false,
            bind === '' && (addr.family === 'IPv4' || addr.family === 'IPv6')
              ? addr.family
              : undefined,
          ),
        );
        // URL keeps IPv6 literals bracketed; net.connect wants them bare.
        const dialHost = certified.hostname.replace(/^\[|\]$/g, '');
        const dial = await dialLoopback(dialHost, addr.port);
        expect({
          bind: listenOptions,
          certified: certified.host,
          dial,
        }).toEqual({
          bind: listenOptions,
          certified: certified.host,
          dial: { ok: true },
        });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  });

  it('formats concrete IPv6 hosts for URLs', () => {
    expect(formatChannelWorkerDaemonUrl('::1', 4170)).toBe('http://[::1]:4170');
  });

  it('preserves and accepts concrete IPv4 loopback hosts in 127/8', () => {
    expect(formatChannelWorkerDaemonUrl('127.0.0.2', 4170)).toBe(
      'http://127.0.0.2:4170',
    );
    expect(isLoopbackBind('127.0.0.2')).toBe(true);
  });

  it('uses https when the daemon serves TLS', () => {
    expect(formatChannelWorkerDaemonUrl('0.0.0.0', 4170, true)).toBe(
      'https://127.0.0.1:4170',
    );
    expect(formatChannelWorkerDaemonUrl('::1', 4170, true)).toBe(
      'https://[::1]:4170',
    );
  });
});

describe('assertChannelWorkerDaemonUrlIsLocal', () => {
  it('accepts loopback and wildcard-rewritten worker URLs', () => {
    for (const host of [
      '',
      '0',
      '0.0',
      '0.0.0.0',
      '::',
      '::0',
      '0::0',
      '[::]',
      '[::0]',
      '0:0:0:0:0:0:0:0',
      '127.0.0.1',
      '::1',
      '::ffff:0.0.0.0',
      '::ffff:0:0',
    ]) {
      expect(() =>
        assertChannelWorkerDaemonUrlIsLocal(
          formatChannelWorkerDaemonUrl(host, 4170, true),
          host,
        ),
      ).not.toThrow();
    }
  });

  it("accepts a concrete bind on one of this host's own interfaces", () => {
    const ownAddress = Object.values(os.networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;
    // A machine with no non-loopback IPv4 interface cannot exercise this.
    if (!ownAddress) return;
    expect(() =>
      assertChannelWorkerDaemonUrlIsLocal(
        formatChannelWorkerDaemonUrl(ownAddress, 4170, true),
        ownAddress,
      ),
    ).not.toThrow();
  });

  it('refuses a bind this host cannot answer, naming the hostname', () => {
    expect(() =>
      assertChannelWorkerDaemonUrlIsLocal(
        formatChannelWorkerDaemonUrl('203.0.113.7', 4170, true),
        '203.0.113.7',
      ),
    ).toThrow(/Channels cannot start: --hostname "203\.0\.113\.7"/);
  });

  it('refuses a DNS-name bind — resolving it is not on the worker startup path', () => {
    expect(() =>
      assertChannelWorkerDaemonUrlIsLocal(
        formatChannelWorkerDaemonUrl('daemon.internal', 4170, true),
        'daemon.internal',
      ),
    ).toThrow(/does not name an address on this host/);
  });

  it('accepts all IPv4 loopback spellings the Host gate can answer', () => {
    for (const host of ['127.0.0.2', '127.0.1.1', '127.255.255.254']) {
      expect(() =>
        assertChannelWorkerDaemonUrlIsLocal(
          formatChannelWorkerDaemonUrl(host, 4170, true),
          host,
        ),
      ).not.toThrow();
    }
  });

  it('accepts an assigned wide loopback', () => {
    mockNetworkInterfaces.value = {
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
        {
          address: '127.0.0.2',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.2/8',
        },
        {
          address: '::1',
          netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
          family: 'IPv6',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '::1/128',
          scopeid: 0,
        },
      ],
    };
    expect(isOwnInterfaceAddress('127.0.0.2')).toBe(true);
    expect(() =>
      assertChannelWorkerDaemonUrlIsLocal('http://127.0.0.2:8080', '127.0.0.2'),
    ).not.toThrow();
  });

  it('accepts the canonical loopback spellings', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '[::1]']) {
      expect(() =>
        assertChannelWorkerDaemonUrlIsLocal(
          formatChannelWorkerDaemonUrl(host, 4170, true),
          host,
        ),
      ).not.toThrow();
    }
  });

  // A zone-scoped link-local bind (`fe80::…%eth0`) is an address this host
  // answers on, but `formatHostForUrl` percent-encodes the zone into the
  // worker URL and WHATWG URL rejects zone IDs outright — so the parse
  // inside the guard used to throw a raw `ERR_INVALID_URL` instead of the
  // named boot diagnostic. Refuse it with an actionable message: the worker
  // pipeline cannot carry a zone.
  it('refuses a zone-scoped bind with the named diagnostic, not a raw URL error', () => {
    const hostname = 'fe80::1%eth0';
    expect(() =>
      assertChannelWorkerDaemonUrlIsLocal(
        formatChannelWorkerDaemonUrl(hostname, 4170, true),
        hostname,
      ),
    ).toThrow(/Channels cannot start: --hostname "fe80::1%eth0"/);
  });
});

// A CA-issued leaf, the shape the documented `mkcert` flow produces: usable
// as a serving cert, useless as a trust anchor. Not a real secret.
const TEST_TLS_CERT_CA_ISSUED = `-----BEGIN CERTIFICATE-----
MIIDHjCCAgagAwIBAgIUMfJwZrF6DjLX1ypLgu2A4v/SwKEwDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UEAwwRcXdlbiB0ZXN0IHJvb3QgQ0EwIBcNMjYwODE4MDk0NzE4
WhgPMjEyNjA3MjUwOTQ3MThaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAOff38zsoMq+oe2koKyZJ7aoGJC8CuAc
oYoLcJaWdp6yJaj5BpYeHAnQt8QCQZB86Fj1f3yuK6KwmGm3p49NrVJMl/T39CnK
ZAcIWATBw8mCWLFWlWhRgqrIQ5ka935m+z63gVhSQiCq2mNkAzm9I4UcbeAucSXn
Plk0Bc/CBUh5knrjxPEebicbCUaKteWnG3SBe5PjgP6DKZojd0VakmbrDhTW+yD4
9LRqURfzvQZghA7stqErp+WJREKAaJbNNUEhGvRSwucIsah6u7OAbYP1IRaYBGDm
nlxaYBETRg0/3Kzx4SnPUuyx3uR6YP9MNuSzK5udCf39+iWSFCC+AnMCAwEAAaNe
MFwwGgYDVR0RBBMwEYcEfwAAAYIJbG9jYWxob3N0MB0GA1UdDgQWBBSItY/bpVFx
QRATvUzvo+JRFVpuyjAfBgNVHSMEGDAWgBRfCBabaBn4orvntHRiDcBU8W3vEzAN
BgkqhkiG9w0BAQsFAAOCAQEAjIiKztoj9JtpKfP2qSYsTe+4nvCZ1ZT4PtmXQMVp
lyHI02iH+NSSY92/ZdvGn2jBMzAFpVgJFlI6aZOne/qHI5qMf1RW7BfHBXza7wF6
mdILIKRUYzm96o6IEuObE+QkSjRuA5OpLkObzGZLWfem0+fxnz0djbzeEBhHpP+b
VUUcl7r2wFb3+ClobIYS24Y+tWCl53XF+2YFNebECkA+19TivHPYgyywljyFNmzk
jCELOKOvOESV6kWBGUcrj8rcXoaF3BABInxZURGMRqWuivfYSjkGj65Trf2sVCXS
9mkiDfB/mYPvq3ODVYLvOjcxqPFsKaRA0Gw5Nm7WKGiOhg==
-----END CERTIFICATE-----
`;

// Self-signed, but its only SAN is a name the worker never dials — the
// classic `openssl req -x509 -subj "/CN=localhost"` cert. Not a real secret.
const TEST_TLS_CERT_NO_LOOPBACK_SAN = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUAVVYUcnN8DryJZGEaaVCTk+wO8EwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDgxODA5NDcxOFoYDzIxMjYw
NzI1MDk0NzE4WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQC/B3++tHrPbzLk0vSJrIbqxM1PYAIlEnxc/Jz/PAkX
TH2ChYAqdAIUnUK18/WecgDAVUMNbuOh8+JjS2O/+eOwa9McMFBD9KLzwClkFQXY
i9w0EQ+SI8haXYQhHo931KW/dP6JaNLhAxmGuTsypbvxRmJ3PKnOwcDZZYZ4uHgj
DOVROEVTMrm+QUh1gfPZRStPFePUFLggcjmaWzF0Zyi5DX9KKMvTMrgaSKm5nHev
WYMK/tEDTh7ofJqt1a9RRscixQlhp/8GkP39uXB2xfQjzHuybK0lvTYHLK4WMjw2
tjU3ClZSaZ2kgxN6/cPn6dPMZeZWEyaH11wa0DDmzOWZAgMBAAGjbzBtMB0GA1Ud
DgQWBBQ36jRlglSAhVatEXwAqTfbvDaT0zAfBgNVHSMEGDAWgBQ36jRlglSAhVat
EXwAqTfbvDaT0zAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCD2V4YW1wbGUu
aW52YWxpZDANBgkqhkiG9w0BAQsFAAOCAQEAYSXyw7t8KeTir/G94izDvKIvkOZW
DxmdDDFDDEeeyKIo0MRttJoHbcmYkSTLz2UcOKn1bnAgx3ZQWjAm3NdeKF7XSiwH
NQTyGw0OxvTtzCX72xtBhS8md+dstcQ20YGN8rIEEgkUUOZlwJkhfe9URLNsSbBX
dcAfcNrfExtg49r1kpwhKL6lXmAi3lNKBgHz6+oyhJpCVehCEtoE4pvwRFW9oyrB
gI/irGYXddbzWJQla/KPV53wn5nK6Ho4dY1Z76slnwMoufrLM1oUt1QKUeyOKsOD
8rRyH3UVlQkkJUGlQHPaJ+OU65xrNMkTLS7MdSQfJ1Eti4GyiR2P0vySrg==
-----END CERTIFICATE-----
`;

// Self-signed and covering `::1` via an iPAddress SAN — the shape a daemon
// bound to IPv6 loopback needs. Not a real secret.
const TEST_TLS_CERT_IPV6_SAN = `-----BEGIN CERTIFICATE-----
MIIDOjCCAiKgAwIBAgIUYLTXyX2vAhC+OaM3JD4xKLtyfV8wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDgxODEyMjEzMFoYDzIxMjYw
NzI1MTIyMTMwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCY6GprczPMvANzG1zLli+HDkEyyUk9lnk3Lsgu8yQJ
TqpBNBR+dTN7sYPccZpNbZ/N3G6vETbtvQ5VtKXI8izvliZMNGm2WNhr+OpMnWVb
RQ03qiwxzISFArGwYPF9mDTDpS+fwvkIN7B0N88rdmlaPez5Oy3egHQfwSrzrzId
dnd29tvGq9EnUps1xBgspFD8buK9fK1na4iypzSzYy9ub2tZ5ZliiqIGdmLxtE8j
FdyIiASOCujAxjovrDcJ+Xnr3ANRgyzHS3tQdbemLlEmu9zRk/ic7FFK2acNji/O
s5e8pJUKPmZnyyqIFlhFl8iIKvuZZev81p7Hnvmc0SHDAgMBAAGjgYEwfzAdBgNV
HQ4EFgQUzZj7sxpXzyOiet7XS0oRiV8TQtIwHwYDVR0jBBgwFoAUzZj7sxpXzyOi
et7XS0oRiV8TQtIwDwYDVR0TAQH/BAUwAwEB/zAsBgNVHREEJTAjhxAAAAAAAAAA
AAAAAAAAAAABhwR/AAABgglsb2NhbGhvc3QwDQYJKoZIhvcNAQELBQADggEBAFEK
M3+ggPGi6bFk3z9AjBWBLkJ2JsuHC1IwJ2ReXCBzwlzlHfJq8TyVTHeH+oHChVyK
KZlWn2GDXZMrDzLxZLwH52iKq3seYw/bZZ/TpugO6OHj1WmGXyl0sajMFye3VQAT
+M+irxpT/2eQqGV73lNbuNFvcwu4FaO3n8Ux6eG1BusQCx1vc6wvoK42kb9wSJN8
qpqn1pNDH9P3Ub/1GbhWEytVsB8B3EewG/SE11cGhXSup1K4IiPcLMJX9SYGq+uM
GcrrZsPYuLm5eL6J3QjkFzMqyS6/4L881mihR/HKLdEnDyMzayGZ44O+DmZilUKv
w3Chmx7wNIzXjtZRcUk=
-----END CERTIFICATE-----
`;

// A CA-issued leaf shipped together with its issuing root in one file, the
// standard `fullchain.pem` a real CA hands out. Not a real secret.
const TEST_TLS_CERT_FULLCHAIN = `-----BEGIN CERTIFICATE-----
MIIDMzCCAhugAwIBAgIUfMQ0J1fG/BhJQuzOilTasy8quOMwDQYJKoZIhvcNAQEL
BQAwJjEkMCIGA1UEAwwbcXdlbiBmdWxsY2hhaW4gdGVzdCByb290IENBMCAXDTI2
MDgxODEyMjEzN1oYDzIxMjYwNzI1MTIyMTM3WjAUMRIwEAYDVQQDDAlsb2NhbGhv
c3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCE4sZa+FxusjUk7TzX
9FV/x7KAIy+lu7G20F2TjSeQ6mHhwkFb/rsADoi+9RU4MF+m/Mx+Lilccu2pVk+b
Ri+GksxX4xAC8L7XIhRwDdYWHHOMr1WnERKMqdRcEbzCAuQhR32Z0vFdg+T3o+TH
MkQ3AXQkQc0uu5r40e3VWuRweWnOfJqojH4VQfjk/44cLZBBRAS3owOWC9fAciJI
C5IgBnuYC7TOoZ1A69Lo+2C5UhIm6QEBzPtzVI87gzbDwqM7x8e3mMhLDQmNS3uD
+EVd05spuBq/KXMTSqHK7OIUPMFr3wXgVRm8i+68/4C2TnZANS6WSD5QZYivB4r7
MUTtAgMBAAGjaTBnMBoGA1UdEQQTMBGHBH8AAAGCCWxvY2FsaG9zdDAJBgNVHRME
AjAAMB0GA1UdDgQWBBQr5x1h5l442pqfn0GFyn77KiWz0TAfBgNVHSMEGDAWgBSA
9DApi3O49l8S/UWWA91PrZWtQDANBgkqhkiG9w0BAQsFAAOCAQEAaxo+Y/u1iCNt
Vz4bmiRlqfhjVVe9yxa0Q8rzC/V9V7qrWpHjONXLErEKZ59oi8a80ndjugdXyw0g
gUKCmeykUtSbRLUTsZ741VKADjt87YceLrxsSVrtwMJjX2GoDNXIggRzmzdEjz3d
nRzDXFIEEn/g90kaNCYJSkPld2wk4M0IbEGpc8V7sO09I3T0igwfduVMO31X+mV4
7A/J5QSE/oAF3PbuUvfzI9Hl1vdzgDUal3v8Sqh4oDgucc+YVZeCUuthq8zVT4Z5
V6y0UOsNXHRE41EN7hK3zOKWJFwoS+ga2ACg+K4yuOnlhU+2MHa4XENVyaTsQaPo
B6U6dT+UdA==
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDLzCCAhegAwIBAgIUFRsEYHgjJUpGISLDoybs5vSsCmEwDQYJKoZIhvcNAQEL
BQAwJjEkMCIGA1UEAwwbcXdlbiBmdWxsY2hhaW4gdGVzdCByb290IENBMCAXDTI2
MDgxODEyMjEzN1oYDzIxMjYwNzI1MTIyMTM3WjAmMSQwIgYDVQQDDBtxd2VuIGZ1
bGxjaGFpbiB0ZXN0IHJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQDuh/DLVFUTeOwksyGdtViAHe9TNBFWUdeq5zGlcxvX5c7Qbjkclyajclb3
yY0pJ6zgD+uSw6zAE5jID4rtsmSyciakqgHMpPmBMn7GE0I5JCrBnxsN3g7P7EUE
qKzgj8rbUIyNQQt1E43wx4dJy4qN2hlKTusBvnUTtPB2ocRmC6+nXX/+nZWPahzI
MALyl17Nq5w/pzODEtSaC18jscN/bs8CkcDB0kjnKUV8UlbPtMy//n/WjXfDiQV4
KUbQQ832Xl6xwuQTHEGq01Gb/NZO5CE/zdu86/82Jnn2Mv2uBDL+1CBL7kOxgZ0Y
axxW/a55BNpMElTbZxkgTSYivBwLAgMBAAGjUzBRMB0GA1UdDgQWBBSA9DApi3O4
9l8S/UWWA91PrZWtQDAfBgNVHSMEGDAWgBSA9DApi3O49l8S/UWWA91PrZWtQDAP
BgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBfH7T/zM7pVxh4Qv+m
InAyvXPPDdBXmVfoBwHKEMyRts7rbxBHa7BV+qVyBkgXyfjXUL6QQmSXNfG/aHIx
rW9yVN1nM9sUwO5mTO3v07Hjqg00OJQYrqFMI8ba0nxpuIgr8Joj296/25/zwpxW
BjkdDp6EK2LHD4JU73jEMWDMDhQ3VMf8eb6bL3SxujhhhD1T7omTJkPKcUt4BCsn
boUKNFYlbk0HHXZmoXxTIoBxv8aOTWIIJ++sASqH7+9QY2iYtoW7kmdWLcM95nGb
Ptz8eWt0AkYE+GuX4GgOQxWJi0IuHzM7ke3fqjOw/tu01V1inWvVx2eg4Gv+vq2I
x2ZE
-----END CERTIFICATE-----
`;

// The same leaf on its own — the chain does not terminate anywhere in the
// file, so the workers really would fail to verify it. Not a real secret.
const TEST_TLS_CERT_FULLCHAIN_LEAF_ONLY = `-----BEGIN CERTIFICATE-----
MIIDMzCCAhugAwIBAgIUfMQ0J1fG/BhJQuzOilTasy8quOMwDQYJKoZIhvcNAQEL
BQAwJjEkMCIGA1UEAwwbcXdlbiBmdWxsY2hhaW4gdGVzdCByb290IENBMCAXDTI2
MDgxODEyMjEzN1oYDzIxMjYwNzI1MTIyMTM3WjAUMRIwEAYDVQQDDAlsb2NhbGhv
c3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCE4sZa+FxusjUk7TzX
9FV/x7KAIy+lu7G20F2TjSeQ6mHhwkFb/rsADoi+9RU4MF+m/Mx+Lilccu2pVk+b
Ri+GksxX4xAC8L7XIhRwDdYWHHOMr1WnERKMqdRcEbzCAuQhR32Z0vFdg+T3o+TH
MkQ3AXQkQc0uu5r40e3VWuRweWnOfJqojH4VQfjk/44cLZBBRAS3owOWC9fAciJI
C5IgBnuYC7TOoZ1A69Lo+2C5UhIm6QEBzPtzVI87gzbDwqM7x8e3mMhLDQmNS3uD
+EVd05spuBq/KXMTSqHK7OIUPMFr3wXgVRm8i+68/4C2TnZANS6WSD5QZYivB4r7
MUTtAgMBAAGjaTBnMBoGA1UdEQQTMBGHBH8AAAGCCWxvY2FsaG9zdDAJBgNVHRME
AjAAMB0GA1UdDgQWBBQr5x1h5l442pqfn0GFyn77KiWz0TAfBgNVHSMEGDAWgBSA
9DApi3O49l8S/UWWA91PrZWtQDANBgkqhkiG9w0BAQsFAAOCAQEAaxo+Y/u1iCNt
Vz4bmiRlqfhjVVe9yxa0Q8rzC/V9V7qrWpHjONXLErEKZ59oi8a80ndjugdXyw0g
gUKCmeykUtSbRLUTsZ741VKADjt87YceLrxsSVrtwMJjX2GoDNXIggRzmzdEjz3d
nRzDXFIEEn/g90kaNCYJSkPld2wk4M0IbEGpc8V7sO09I3T0igwfduVMO31X+mV4
7A/J5QSE/oAF3PbuUvfzI9Hl1vdzgDUal3v8Sqh4oDgucc+YVZeCUuthq8zVT4Z5
V6y0UOsNXHRE41EN7hK3zOKWJFwoS+ga2ACg+K4yuOnlhU+2MHa4XENVyaTsQaPo
B6U6dT+UdA==
-----END CERTIFICATE-----
`;

/**
 * A leaf signed by a SELF-SIGNED issuer carrying `basicConstraints CA:FALSE`.
 * Chain geometry alone calls this anchored; OpenSSL refuses the issuer the
 * purpose of signing and every handshake fails INVALID_PURPOSE.
 */
const TEST_TLS_CERT_FULLCHAIN_NON_CA_ROOT = `-----BEGIN CERTIFICATE-----
MIIDLzCCAhegAwIBAgIUZ0Gvb+9679AdH7Z3UTSH3bpFClUwDQYJKoZIhvcNAQEL
BQAwIjEgMB4GA1UEAwwXcXdlbiBub24tQ0EgdGVzdCBpc3N1ZXIwIBcNMjYwODE4
MTkzNzUxWhgPMjEyNjA3MjUxOTM3NTFaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAPV+RuIkLGY4UssJmrTVgT2N
+6NC/Z5zFOscBbe06uFIr+Afe4663XDykVKRBpsW99lGi4MHhuF7+an3RLpNE6NW
cr8IFMcPWJs6PlvG72CGiO84cbjSWSu9HuZc9usQpryqaENB672xD80eIpazwfsQ
rR0lgqhf8jACcOmGjbkmXZ7V5GOLFESmOT2W6Pyph0dRWRyDJ9hONYUURCWhKsDq
KrUqEzR7hAYbAqp4MIY9pptAnZsWlTjClaynG9xh4OQckT+0kKXeA375AyMojb12
y9yCqTHgIedkgMS9kJkzcuJCFaN8fl04XCEhK9YZFNteDD2UuNFWSljKSLFR588C
AwEAAaNpMGcwCQYDVR0TBAIwADAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEw
HQYDVR0OBBYEFMDmmEJGwv7U1oNopBAgez9nxWjbMB8GA1UdIwQYMBaAFPMJzoYw
2Kpic33Wk1grw6CvY51dMA0GCSqGSIb3DQEBCwUAA4IBAQAV+WxQ3pMUOPQUT92t
3VzRD4k679a5NDB47MaXh0HMPqVbph0UQRg4+BAg8pSpf7tF0Ba84eUgLHUxNrEB
sLRew6Sm5HQn6hRnYj9PQaeWmKvCLRZmKmeF93z5QyNCLtHsqb5ttJKbt+yM7ESH
KiQcEC1LnZjFMgR9ItEuK8Xtjb6IVkN05V54DkF6cq/MVAX6dvRGCjo1jkRqFpNJ
+sil11vK3aAjD7BP3iw/v/1iYU2qLwcpXbqNXuM7ucVTvsxP5C1Ae4WTYvoZ2fid
r/EUKFMwxP7u9kLyOXi9EzKkb0zpVhfAcd8+yOyTZ4bs8Cc7kIEBYvcXhNL/BrVi
6wO7
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDNDCCAhygAwIBAgIUVsyE+9hGRXVXW98Yxi5WgUsuAsAwDQYJKoZIhvcNAQEL
BQAwIjEgMB4GA1UEAwwXcXdlbiBub24tQ0EgdGVzdCBpc3N1ZXIwIBcNMjYwODE4
MTkzNzUxWhgPMjEyNjA3MjUxOTM3NTFaMCIxIDAeBgNVBAMMF3F3ZW4gbm9uLUNB
IHRlc3QgaXNzdWVyMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmS4z
ZtAqYZ+SnMeyaHlTkV6+601FGfgglpa3th/4ZO7fSILfsDZIN7X3aAaz3u8lOhm4
IIE5OuqNTX0Nn5CIEoxaDBjP81/pw0vgIqIjmjRacTzLU7Pe1Jl4TtbXKLTOP1At
nfnGuiHS+shw4vkqo47/C9OT18gJLvXuB/aIDYyI6DwCpUfljagrAHdmCvzfhKMj
EuYw3E+OIErLYb3THAvShVcrpsnuW1Csj8WRnWsmB+S6FttEKFM6C5GnALOuGnmZ
p9x39qbDtYZoKRHMGxt8V2LWVnnWbEAyFbGnkItI+dA2xjoCFKkUoIrtr1Z4A+jF
f9gqDd3c0UNRaQvQ1QIDAQABo2AwXjAdBgNVHQ4EFgQU8wnOhjDYqmJzfdaTWCvD
oK9jnV0wHwYDVR0jBBgwFoAU8wnOhjDYqmJzfdaTWCvDoK9jnV0wDAYDVR0TAQH/
BAIwADAOBgNVHQ8BAf8EBAMCAoQwDQYJKoZIhvcNAQELBQADggEBAFvpSYNXbtl6
RHE9Dt+GjRfBWAb73n7CVi+Ep7KBB4M/G7eHY9646T+Rzp0y/+mxEn2JDJP5yUhE
FLEOzQvXUrc0bdwWUYPbsKhG0p0KhK4+B34GogORcv3+6AiXBvGdqjyMT5zwj9OJ
sVV/Nswkn2dfkZr+JXj8sikllPjEn+LXto8nXNPbjZRe3MzIU32bYyOcJl+wQc4t
TJEPPVrdusShzahl0xEBAfuctVmmVvdv9st1DsoFiaEQ+vGZkJzTbhm6ggXyKpNE
1u3aBtPdxWWjuaF3Oy6jb+HG5BrQMemzExU1izkIg+cb9VJTZyP+cm0NjOp1Oo+E
c9BNon/M6I0=
-----END CERTIFICATE-----
`;

/**
 * A self-signed leaf with `basicConstraints CA:FALSE` covering the loopback
 * host — the shape `openssl req -x509` produces without an explicit CA
 * extension. Measured on Node 22: trusted as its own anchor at depth 0, it
 * handshakes fine, so the CA constraint must not be applied here.
 */
const TEST_TLS_CERT_SELF_SIGNED_NON_CA = `-----BEGIN CERTIFICATE-----
MIIDJDCCAgygAwIBAgIUDFbAwso3M9+z+ZUt6pZ8vk1wS+QwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDgxODE5MzgxM1oYDzIxMjYw
NzI1MTkzODEzWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCyGf9lrTPBEDjZE91Mhw+0yISrs5UdR8ZF6UBntzIt
xjnqOmv4SSNo9Uj+Nr2Fm3YZ2SRnyFgGVyfHICHdPddbMEo9YnFyq9PQeDy1CU2X
l2YspCdcsgMzlUWwjqj2uaGdzW5a3kPP17VwoxMOFRJ0dMOnu/OLJQWK/2ouSR/2
vDcGvVYV8oLwB60G6sgiWmxaBAoymfscU+ljFa9Q+FV8ma0Grtw6MU5g70Eo8hUT
vdmhh3QdXEqPphN8Ehj1jnLkzgheLj6WUtSj0mXNgx9WiW82Eql+caQ65wyL66Lx
kb23+Bp9jXFO4EQqcExx0del6sWA04aD4zPNzzeGaz6zAgMBAAGjbDBqMB0GA1Ud
DgQWBBQAKIylvj34CVhT0ywSlIHBUdQtcTAfBgNVHSMEGDAWgBQAKIylvj34CVhT
0ywSlIHBUdQtcTAMBgNVHRMBAf8EAjAAMBoGA1UdEQQTMBGCCWxvY2FsaG9zdIcE
fwAAATANBgkqhkiG9w0BAQsFAAOCAQEAc9QfHZfvh5+tFWOa+7zZeXtH6EazImKu
50iVfu4sI9noV+k+pA2WokMnShT3dDhp2DP0n2VRXet9CMhACz7KAEpgtpG7JTr6
EIHFgT42V+/WVte/uxw2Uj5hfMoycvRCy8J8JFuGzdPKc2z7bn2angtXoQxZfOAk
VNRXkOxi5lPsuJ3bW8of2DI1/q1EJkR/Ha1gdzuk/h0W6JpO2epuzOkuwckPMuu2
FWlN+yXXWHUsIHCosHSqesOhS4qlxDoYihsggPJ2rWnibwMr7t6GC0Bo5xsMRWFS
6gw2hOfWIeMnoRQ0ZkCB5t5z+RYPMBuCOMJoR8HxUOKm1EMHjVhoaQ==
-----END CERTIFICATE-----
`;

/**
 * A leaf signed by an X.509 **v1** self-signed root — no extensions at all, so
 * no `basicConstraints` either. `X509Certificate.ca` reads `false` for it
 * exactly as it does for an explicit `CA:FALSE`, but OpenSSL accepts a v1 cert
 * as an issuer (`X509_check_ca` returns 3, not 2). Measured on Node 22 /
 * OpenSSL 3 with this very pair: serving the leaf with this root as the trust
 * store handshakes `authorized: true, status 200`.
 */
const TEST_TLS_CERT_FULLCHAIN_V1_ROOT = `-----BEGIN CERTIFICATE-----
MIIDTTCCAjWgAwIBAgIUFRagk0s8Vw5T5dtWVS4OF+GJC2YwDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UEAwwRcXdlbiB2MSB0ZXN0IHJvb3QwIBcNMjYwODE4MjIyOTM5
WhgPMjEyNjA3MjUyMjI5MzlaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBALB1h9AB5sJAdQaa0FRmK0EfDaVpaftc
OgsNYp7jkjBdvE/DKcINxoOOTUyO2Qs0/Q0lyWaZNjb5jTjzSqya+XBM9hYJdzHC
AJaNAPE86v/tS3sAsrCT1nKLjlPsHQsDcpyiQR3mJNjlAKOclrey2o44xBkhdiu4
qBW1p1MEJe3tfu4rpH3//cDj6//T44ic9oNhIKH3hW+3QRunhqc/RCllAz82P37M
bI2/nQzWuBMhuGj4RHZN6njkhIlAqdyIt9Qgv2v7NPtCde5r0UiR6bLaSHpx4m9o
YmY7F7A9UOdUuRB+FY97/kzF7I9JmLH+/U9gyVcR0x+ML0SvXVN1Ph0CAwEAAaOB
jDCBiTAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCQYDVR0TBAIwADAdBgNV
HQ4EFgQURZaMk15Cc6OZB/hbGR13/X/tAe8wQQYDVR0jBDowOKEgpB4wHDEaMBgG
A1UEAwwRcXdlbiB2MSB0ZXN0IHJvb3SCFHH+EHqV3xnb3Gh9bPdocEReVG0hMA0G
CSqGSIb3DQEBCwUAA4IBAQBhYyi5FHhgQ78b5kgFHGDrhZS313H+9IEGJgH6W/08
9INcdz4MGlTgNoHAFRVmXOIz3hV7bgR6gQdQ7SSsL8fJ0suVG4Wh2tDhtRqzEMwK
JTUVD8fGOM/CG8t6LPMjLpnfHyTkbLjQfRhpQI1nCVMBP+KecOU/7kjUIBBKBcAA
T8MRH1zQvV0YeZitPPrmDQ/LK7pxEfQGcmrsN7ZbqEQ4lnlXPx4xP3RBdEy7ks7t
P23W8Ez2eO9E86lqXTbxnpk9W2eYxU7/SlaT07BdY3RbcABcCMLrQUvlAiLXS7NV
hFnvenEMXip5w/oNnaIdojARaUGdX8KjIt4u+dV7JzH4
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIICwTCCAakCFHH+EHqV3xnb3Gh9bPdocEReVG0hMA0GCSqGSIb3DQEBCwUAMBwx
GjAYBgNVBAMMEXF3ZW4gdjEgdGVzdCByb290MCAXDTI2MDgxODIyMjkzOVoYDzIx
MjYwNzI1MjIyOTM5WjAcMRowGAYDVQQDDBFxd2VuIHYxIHRlc3Qgcm9vdDCCASIw
DQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALfC+t0FBQURbzAdroq3P4BPP3Kl
ZB23rI9ZK2Qb7hHvC0hbeWLCjnt+CTtQALe8yFxVa9f0VI6+4mUinQ425C29tC7Z
5gPbzxukOurD+zFOGArW9uYg6DtQFqxaXmttuEv/cP+lOTsDbarEH42yrlVRg72v
OJmAGFoy/eXwXgVvsEM54SdU5uF0sPKuGJMZ4KPp3v8KKaTFfs/Ru8UPCOUlQ7nY
o7WemUlbMKIcpEfah/ZOo9f02br9K2P/+R8K1SHUpTq3kmW43vemh03sGsPZ5u1t
B7WT/0BRI6larvSHHQD9Hw331VbenxqRK5LWLiwpx0hu7QUmUn76L+2FPXcCAwEA
ATANBgkqhkiG9w0BAQsFAAOCAQEAEMnzsmDeOzmbSyKHuH3zzUTi8mWU1DgUtyLf
oFxDNDxGBef4o8ufTotKmkxhj6he6O2Mx4et5aYZgNu+KMyZpRIzgAh0+pC8ezEe
b29oLD570mOcEx8MpOOnjuJfYxnBzZigkhZq6VLh27A64hgxQhKAoySGxGDjN+C1
Zw3xJnGWe7k7KvOPWMsbVYH1D0QCeUlzqWSmAl3L+e42OynIvOnKj6Vuh4/SxVdX
kBv3KlcMXmaGVC8AEo/M5Zzfkq/a+IC3aVYvhQPOkv1ByeObs5+Sjy2mKb2sNqU8
sxyEYG5sNF7HPXac1j3PqROJ8O1X1lpXWyd2MChHhhCnFCteAQ==
-----END CERTIFICATE-----
`;

/**
 * leaf <- intermediate with an explicit `basicConstraints CA:FALSE` <- CA:TRUE
 * self-signed root. Chain geometry is complete and the terminator IS a CA, so
 * every check short of issuer capability blesses it. Measured on Node 22 /
 * OpenSSL 3 with a real `tls.createServer`/`tls.connect` handshake using this
 * exact file as both the served chain and the trust store:
 * `authorized=false code=INVALID_PURPOSE`.
 */
const TEST_TLS_CERT_FULLCHAIN_NON_CA_INTERMEDIATE = `-----BEGIN CERTIFICATE-----
MIIDNjCCAh6gAwIBAgIUefcAWISh+F6Emetu1Y++2m4bKd8wDQYJKoZIhvcNAQEL
BQAwKDEmMCQGA1UEAwwdcXdlbiBub24tQ0EgdGVzdCBpbnRlcm1lZGlhdGUwHhcN
MjYwODE5MDIyNzIzWhcNNDYwODE0MDIyNzIzWjAUMRIwEAYDVQQDDAlsb2NhbGhv
c3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCk3+570b8ulBlD9+nk
AEuH5T4ptxIpEF1ICep6Lr6E+4a3e36Xw8Dj3pWLcbTzE2cWatxeBOfsxzAPTjPA
ijHfn/7l4uEdj2VO2wdaCx+KnTY3dBDfcugsQJD1x3sRYaI2lEbql9dzlUQsoBFS
vfOJvKAAf8ld2prnEgwK4iL8SXQxGpiRHRZxZSX5BD3hY9qNHPUg5UbxF/3bqeFd
WRlw5clo+KmrIXZT/jpEaCUsJV4AsvzBa4T1lgfi1bXfJc13UcVuKSAdZwVBg86I
ULLK/Tm6GxuCE5tz0mAIdVlHgLg0nZRRBqT+uCSpfYyM3ZjBntExCJVLtnpomHIL
8YWRAgMBAAGjbDBqMBoGA1UdEQQTMBGCCWxvY2FsaG9zdIcEfwAAATAMBgNVHRMB
Af8EAjAAMB0GA1UdDgQWBBRXeK7yvKdpEUq/SBpScRyrdPU91TAfBgNVHSMEGDAW
gBSs7k1wDaAA+5+e9J7OaevGnakJ7TANBgkqhkiG9w0BAQsFAAOCAQEApurke98w
xA8lUbXQUiqJ+7e5p2OeBmBklQ5ugac78ChVB60BQA4/eVQGKGU66FcbE4I9o0+6
fbSwa8tZBF4VxDB++jF/m4v4UgldmxFSOq+zLuBdCcdvE4QDK32R+6B31qiNbaqw
rDeT3cyugIHWz+gMt+X40HRoIHYHwvdEMgYh6xudQxycsqQNklkUsAMlEAMBGEp4
TkiudWy9u1JbAAfrJ4SlR9BL7IlsgFK/xFntyDK4eFxC2cYPx/gayFBod/4W/msB
KeYjaUsUyzO/D883ox2WMIFtYDIMLySoEcBro3y92MR8ncLRKk7wByZAhNXtYKCb
g+/g99FTckehrQ==
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDMzCCAhugAwIBAgIUIqd02dCREIdTnnN3wt3E0a9Zcb8wDQYJKoZIhvcNAQEL
BQAwLTErMCkGA1UEAwwicXdlbiBub24tQ0EgaW50ZXJtZWRpYXRlIHRlc3Qgcm9v
dDAeFw0yNjA4MTkwMjI3MjNaFw00NjA4MTQwMjI3MjNaMCgxJjAkBgNVBAMMHXF3
ZW4gbm9uLUNBIHRlc3QgaW50ZXJtZWRpYXRlMIIBIjANBgkqhkiG9w0BAQEFAAOC
AQ8AMIIBCgKCAQEAslKbC3Lox1Zs6ikaKk7IgD/HzDdcqOpXtO+AIxJy2O7aZg6L
im1qolayFT+88/arTIOxaq1KGGh3dexWBBCo6h363BYrx4OGAQjI+1GKs98DQO5Q
1nnnadZRyU25D3ra0v78Bm+lJjCA3xsor7jfh7GUxBbxbPKfTI3OJ5QQH91OreCK
Ctk9ONMNVz4nt1NvFnnUKSbPfm7HdMvquB16nXuyAB/Uqgj997w2EGfeNXRO2/7x
64EbDtYgMjuraAiM8eD2cMluY74lb3sGRcCR/xMHBlpZeTpkXgjtc5VR14RygGv4
1QTNNsNl34jsq9nfOTzUAUspkEqKmFf+nF46qQIDAQABo1AwTjAMBgNVHRMBAf8E
AjAAMB0GA1UdDgQWBBSs7k1wDaAA+5+e9J7OaevGnakJ7TAfBgNVHSMEGDAWgBSK
0a9cMx46PmKxxogtlcPWrbiyrzANBgkqhkiG9w0BAQsFAAOCAQEAOSUiVqnkGec6
uRs4nXM0fR+ouwC0lxqc8E4BGdnv8crJYKjGWxIib1W/NES/zsnwasu5sglMY0Kh
IkeHhiAYFNVir++alT5YPdUAXU8ckohhbzixPMgOSFvnyZ2xCO64fsDwb7tNe3/c
7dtknvkngkGHJHKtKPKkZ0/jQu6LjsfcIIz5bruEfTeETY6joYjrwZL26NpYslgg
OmOMAitXmMnbbUMEEIzIW7mXFPRBMu+Q5qp4KlD5gfJeu7upRn+NqvXu+Ne2Z0fZ
Si8ev1QSbEku6WmNG9EFzwTC9Y8dQalrAgVegDBHsfTJWdEwfwVs2iApHB3Z+8YE
98DkVAtPXg==
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDOzCCAiOgAwIBAgIUZ+xVhIOhGz7UzQUUPwJYZueIk/kwDQYJKoZIhvcNAQEL
BQAwLTErMCkGA1UEAwwicXdlbiBub24tQ0EgaW50ZXJtZWRpYXRlIHRlc3Qgcm9v
dDAeFw0yNjA4MTkwMjI3MjNaFw00NjA4MTQwMjI3MjNaMC0xKzApBgNVBAMMInF3
ZW4gbm9uLUNBIGludGVybWVkaWF0ZSB0ZXN0IHJvb3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCs+QZ+ov2ClU5axpK1Q7sWUS1f2+7s/2bClYk8L56d
/jByGWD4HCsDNa39nn0Vgq98+4AO9WlpZQUcJlmd16yXusY078ZhNq382fJJ7cn3
FZZBHBmESZMeHNx8HX9MslQjL29vmpHLTRWNSMO66VeTpkRpAnMY0KVrXvQV2nRp
pulRVPagZ0DNgO6puxkJZpInyt/ieIwJ1ZU1gwF3wyX7FcSgN0UwrwBnVsCvXr62
w3WsuXAllLf+YTys9NS7ZLqAFFyhez8lXhplx8dtNQi0iHLOF4jN5jAyCn19tVT5
deQ6qtPVOd/7I9r5Ye6s8HaHa5peYTKn0zBocaiXcumnAgMBAAGjUzBRMB0GA1Ud
DgQWBBSK0a9cMx46PmKxxogtlcPWrbiyrzAfBgNVHSMEGDAWgBSK0a9cMx46PmKx
xogtlcPWrbiyrzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQA/
q1Eu2qiT3/6c8A5o9La2dSwj15/MIgD7C5OauBTKtfhDoVqBVTCeYG/2I+wPm8PX
6EXC7AC7S2Jy97g7F6q+2PgyNpGrk2iuwjfTLJxgpjGbDkej7qUpn1NqbnUQrQh6
yurBZVQi9x6na4HX7pfLVPF76IYLKqdoRdqMtl2EZD1mol0tZGIimQoYqhInSwZ0
3zXzQ+KDMBG1qC1TKQo/8WSiUncdGRzzGKStW+Fp/q1foZsp8bZ4/XNdoJV/ESkk
RjOhHLQYLkulVXNP/fK0cm5haD9yiS11LoFqmscwb+NXdFanLn07ibbHx/DCyyOL
E6mwm4nEjVj2B5cT62Pv
-----END CERTIFICATE-----
`;

/**
 * A leaf signed by a SELF-SIGNED v3 root that carries other extensions but NO
 * `basicConstraints` and no `keyCertSign` — a minimal `openssl req -x509`
 * config. `.ca` is false and the basicConstraints OID is absent, so reading
 * the extension's presence alone called this anchored. Measured on Node
 * v22.23.0 / OpenSSL 3.0.13 with this exact file as the served chain and the
 * trust store: `authorized=false code=INVALID_PURPOSE`.
 */
const TEST_TLS_CERT_FULLCHAIN_V3_NO_CONSTRAINTS_ROOT = `-----BEGIN CERTIFICATE-----
MIIDYjCCAkqgAwIBAgIUL+Czws2mkPECmIm4mHcilV9XdJQwDQYJKoZIhvcNAQEL
BQAwKzEpMCcGA1UEAwwgcXdlbiB2MyBuby1jb25zdHJhaW50cyB0ZXN0IHJvb3Qw
IBcNMjYwODE5MDgzMTM3WhgPMjEyNjA3MjYwODMxMzdaMBQxEjAQBgNVBAMMCWxv
Y2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALfG3fzKWPFd
wBpo2iK6tnEFehEsBIW0S6zrtGgceEZhRhk2SzKaOLvNOjGAbbFHfqF4G07jNC8Y
saW9jc6wx2laTMD1nbKkBou5J30eAyY3ftsQC59Uz/QUT0MT4RUgaUfrC1HAfkmT
JeMfAOVM1fgFVFVoAarzvBveFP3/cb4Uxi6aU861CDdzDFxE7gNnDNLUPNm1ebI0
Sb7nTBFwlxIovjl1xLHy8+CRXpLHlUYvv1ymchU9bZ0fsQWa3XXLThR5pk8mFRCq
fTX+/f+rNipRF21iakVTj4kgWHLnFD6BW96fOBHte5WlRHt6npYTlIdh6vor8ITy
Y0+F9Sz46p0CAwEAAaOBkjCBjzAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEw
DAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCBaAwEwYDVR0lBAwwCgYIKwYBBQUH
AwEwHQYDVR0OBBYEFDPwXdZ1QK0zSZhOHji0XB3eIL8EMB8GA1UdIwQYMBaAFH4p
oiFHk2vPmA0ABIa0Ho3YCG+MMA0GCSqGSIb3DQEBCwUAA4IBAQBxFGLgmPg8ZmBw
wFpTt9i/6TWQQvZPjCyhxGctlDpGfSc58sTUnI2wx2yNkKUWgN5KsMGG9wn4BH5D
cT70/qXWLy4W28xT4fgDyrEXe2ATsJW3h0HG2aAgkRAcSkPaOB5E2eKRvMS+ZvR3
FqH5XeC1RV6hnASOMUUODfXwZghoUuuDZft8Z1oz1gvMCB69RMJpOYWIOmp33NGK
I3y/x0GVCHWpEXWTA9YSzfc0MqLK6COY670kUMSmld40oEEgvfLnd7VOjy/zhzj6
sAxazcSeR4ryrgjNJa757inhMJKhZ5bf4dM47NPPwO72wsrqS1HrVFxJ5BjwDsmQ
8V3Glu9E
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDBzCCAe+gAwIBAgIUJfbInAk7zaTBwG+qu3ibJYtKYKAwDQYJKoZIhvcNAQEL
BQAwKzEpMCcGA1UEAwwgcXdlbiB2MyBuby1jb25zdHJhaW50cyB0ZXN0IHJvb3Qw
IBcNMjYwODE5MDgzMTM2WhgPMjEyNjA3MjYwODMxMzZaMCsxKTAnBgNVBAMMIHF3
ZW4gdjMgbm8tY29uc3RyYWludHMgdGVzdCByb290MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAuIzZKOMbeKpu7j815yc9RHBbzRWJmDxRTrEmorrjZpUM
NRh3BT3lLUY4Ur5zgOqpDNT5vj/rSY/ExBOBM4RfgInCipu3vv7jis94hXbTfr0P
IC8nC+hKS+V8HO6xy1VGoXYLzpQm78r1obgd7PBZuQajZue+La46dbKJmnWx8NOC
nZSDW5auOtDhniOn19FiCumn96OSVR+Nk9j/bWrE9AFzhj0GFcx6xQKqadD8AS0Z
NP30bQkFE6wEnE05p1l6SS3AtX8L21JBeAAL0SVLgNgjlry4geIS7HzufxNUBI6L
GASFissx1eOtuqJTf6aKM4TDVOzjJdw4l3ROsB5nJwIDAQABoyEwHzAdBgNVHQ4E
FgQUfimiIUeTa8+YDQAEhrQejdgIb4wwDQYJKoZIhvcNAQELBQADggEBABpU1Vlo
cO3G91gr6a3cwm4/wmL3EIWH6sl4cj/AmkEvG+eQl4ESxhLpq4pqwtIKEHFuFLmu
3STHsLsqbKpnHBwLfqXwsAtJOccm+MixHfN6pTe236LaNAdfA9Ds8q6LWdJFL6v0
cj8q1Y3++uZ0W3DwrKXwvc/VEam4k2/c0eEyaMllx/2pQofvTrYt3F7uh9j42UdF
u3ygoQgmsOrLAc3RIipdSZbqvOA2yXkod3IiZ8cmnHK+juKocHzqChFAqrfD45qI
nGT2/DL35St8Giv/BW9xCta5LRpMcvEWoGi+NVW4l6ysWkqMtFU2BKwCEYYn/+NL
mptrWqez+gyVuWc=
-----END CERTIFICATE-----
`;

/**
 * The control for the shape above: the same geometry, but the root carries
 * `keyUsage keyCertSign` instead of `basicConstraints`. OpenSSL accepts it
 * (`X509_check_ca` returns 4) and the same measurement returns
 * `authorized=true`, so warning on it would send an operator to reissue a CA
 * that already works.
 */
const TEST_TLS_CERT_FULLCHAIN_KEY_CERT_SIGN_ROOT = `-----BEGIN CERTIFICATE-----
MIIDYTCCAkmgAwIBAgIUA2xZ/OKAOVYnn87IuQxZFcpIQncwDQYJKoZIhvcNAQEL
BQAwKjEoMCYGA1UEAwwfcXdlbiBrZXlDZXJ0U2lnbi1vbmx5IHRlc3Qgcm9vdDAg
Fw0yNjA4MTkwODMxMzdaGA8yMTI2MDcyNjA4MzEzN1owFDESMBAGA1UEAwwJbG9j
YWxob3N0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnd71W3Um3fL7
t/t92+aUI7XmGojNx55LY2xRVWgjdZ9Ay+sYPuyFmXZOghBIJiZwa1BEaLnekwFV
XTlmcVJyyQCnBLfv/daRNK045MMYwvnDvWK8VqjlJ0m6dEwhiBwSxlywVfdJqRFf
nFRuDVx8AD5Au9DxLPsGCF/uPc2igYZsX6aawOAFd13xy9Edqvh1e8abbur/R3V5
hvPj9XwaXNZ9f57oCOIqYsZzj+HRcstB11osi2nUFBY3xqjrWfXf9a6lvAEgRiKg
F38qKSFIPKtzugj+BSr2thcaaPfxrMdQNo/fD7x3NLCqqpATe7Q3/W071cfaMd5V
mTEUzJRuowIDAQABo4GSMIGPMBoGA1UdEQQTMBGCCWxvY2FsaG9zdIcEfwAAATAM
BgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIFoDATBgNVHSUEDDAKBggrBgEFBQcD
ATAdBgNVHQ4EFgQUUkOyIDrbksN2PTnBmpFoOE99GRIwHwYDVR0jBBgwFoAUOI7p
nDt+WfQ5OYGwOrbxgX1MC5wwDQYJKoZIhvcNAQELBQADggEBAErDgA8Ur3CJXFGx
Qr1tnWfkMxJTiLNH5aupSSNFP77l7C8mro/IJNfUcnVCvSWnEl51cS6YLxszsmIZ
GTBqu64KhNVdt6WLhySFbBuHUpa9VBwrdJ8UIbMNcYcm0Ujl6lZyTrT3+edzWqw+
yTGUJPaWo//V66BIpgCvJ3iu0Hv3sK4Rdf4LsXnIsmLdvSunKxlucQkyGJZzjEnh
9pPNOhnP3X5+L2fZEFBwcXfHMaACXt6wf6GmVFr7X9HeU7Jh6ESTNwzSHyDHAe3g
IgVFua1W4jSzQKNjBY/Atdfq4RivA6UcWYR3isa9xI0gnXxBeXl0+PmaFI8QfgER
KKuNYiw=
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDFTCCAf2gAwIBAgIUGXmj0/4osqrN2l0rhucDv3hJda8wDQYJKoZIhvcNAQEL
BQAwKjEoMCYGA1UEAwwfcXdlbiBrZXlDZXJ0U2lnbi1vbmx5IHRlc3Qgcm9vdDAg
Fw0yNjA4MTkwODMxMzZaGA8yMTI2MDcyNjA4MzEzNlowKjEoMCYGA1UEAwwfcXdl
biBrZXlDZXJ0U2lnbi1vbmx5IHRlc3Qgcm9vdDCCASIwDQYJKoZIhvcNAQEBBQAD
ggEPADCCAQoCggEBAKiH7Sh0cuJGLD+Jm8I48v2EOBTaISptGXW+JrJtIHcJ6xS1
Lz275QZXQvVm5n82ENut35Vr014yOpVl0nWjTXifcpgJlz3DXxXJZJunJ2SafZ/p
lcOa2zy71DkD1CAE0YYXHcIXqKR5AQhi1YVEuLqAPyWwHzo2NY6pLLKL/f9e6kSP
jEOdU3x2QZax//3wEBKCgut+Y4D/BWSXQZexRqxdiuIvaWomS6koAdvAfHZI/p46
QZr8dTdHs0PHLhUKfBE6X/HNA2sOFdA+4N/KCohVSKtaX3xr7ixkvJ9E9+IBUSlx
mh0yTr9Gc1mKU9/fGgtsgGo8D76VdF/o1WXY3n8CAwEAAaMxMC8wHQYDVR0OBBYE
FDiO6Zw7fln0OTmBsDq28YF9TAucMA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0B
AQsFAAOCAQEAoTlR5omIlNcaMz80KdFRf/JSQIfS3ROaaCcY8RiuO9GVGe4dsTXs
iHn8RM1j+WH7bGPR5ycs7akWCruCGexcawu5xX26/e7iLIu4QQzqVOVwkGw/SxWU
LgLXo4AvoewCQoBh0ooi+6DhTPaTwSeYf0FmtnQ4+1cBpXaPKcvD5frvb7mI8iop
f8TBZEgy5uAaBvnhh5ljW/mGtzhVQJL2kNI56F89+jLNFayKOr/NAH+Wq6/y4XH/
JW5ZVSTzUm/5lVinhjJlzI1qgTKKLnyPC9y/lwsV1pgg4QSqp5NcZe+tPGwVawcu
lL9BpPKvalzsE/s0y64+00JmSW6oWzLfMg==
-----END CERTIFICATE-----
`;

/**
 * A leaf signed by an X.509 v1 INTERMEDIATE (`openssl x509 -req` with no
 * `-extfile`, the legacy flow) under a real CA:TRUE root. The v1 exemption
 * that keeps a v1 ROOT trusted does not reach an intermediate: OpenSSL
 * refuses it. Measured on Node v22.23.0 / OpenSSL 3.0.13 with this file as
 * the served chain and the trust store: `authorized=false
 * code=INVALID_PURPOSE`.
 */
const TEST_TLS_CERT_FULLCHAIN_V1_INTERMEDIATE = `-----BEGIN CERTIFICATE-----
MIIDijCCAnKgAwIBAgIUO1NXDZn7sUcLyXoOb6Zrn/5CuFEwDQYJKoZIhvcNAQEL
BQAwJDEiMCAGA1UEAwwZcXdlbiB2MSB0ZXN0IGludGVybWVkaWF0ZTAgFw0yNjA4
MTkwODMxMzdaGA8yMTI2MDcyNjA4MzEzN1owFDESMBAGA1UEAwwJbG9jYWxob3N0
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxlNIMiQni4GBg2hccTRg
EvxF1UGCVsfjljhGhT5CbSbRrZ9rtvKoGBIixR6e+2EPxHmd50jF2SdS5HzHCPQf
n2+k59BbE0W7KJrpVHQspYE2OtpxR6Wu9y+C31q1Bs8ZxPWkXbQNBbeRTlgUlM18
GTXw6wVuRH4PF5425ovrMlJZ1hT4k/PROSQbU3cvjbl2mFVOEWqVgDXt/+h9AOvY
zqeiIEWJrjh3Rn8bZZm5ssBG2JzRzCS6PQUA/O8CFiFeWVnmJstYV+cXfYnFf4RJ
5y9aOG7WO3oQANUg+5dfhEwKJR4AvE/1+kGFzxLdpQrRo8e7zZ9bDUs513oISk66
tQIDAQABo4HBMIG+MBoGA1UdEQQTMBGCCWxvY2FsaG9zdIcEfwAAATAMBgNVHRMB
Af8EAjAAMA4GA1UdDwEB/wQEAwIFoDATBgNVHSUEDDAKBggrBgEFBQcDATAdBgNV
HQ4EFgQU5Eg1xUApem+UABc1aALOYRPsnqQwTgYDVR0jBEcwRaEtpCswKTEnMCUG
A1UEAwwecXdlbiB2MS1pbnRlcm1lZGlhdGUgdGVzdCByb290ghRvrElfAutwhBeV
dilnIiiZ0S/nRzANBgkqhkiG9w0BAQsFAAOCAQEAgQkUeanJNofoponB3Q7ekhl4
nFI8yPWogFBQDBh+6Iz7i0FMUBMG6iJ0RjKMBjz7JhK9VnxCf9VB14wF634pfLE2
dnWhsme8ZNOQFd3TACT76air+8RGm19RBVgxe3NTc1POtCZ68UE/8L4EMZtOIQNm
eWadm3gw+w6qzJ+c8dnUmOLjBMD6J3k9Asma+uauYGdwiJPbgrOXSRqVa8HDyXj4
9gVxremJRza+BdWtiATgKiO/jIc7aiBOIW2PhX8Idg97FirK5dRNQY0pxvAAWp6f
gvmOMpY5YCDoZjjApzRLMQBeBsDqQU2XBIjnidcbGYrNh2F4A2AUfFEQHOPt6w==
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIC1jCCAb4CFG+sSV8C63CEF5V2KWciKJnRL+dHMA0GCSqGSIb3DQEBCwUAMCkx
JzAlBgNVBAMMHnF3ZW4gdjEtaW50ZXJtZWRpYXRlIHRlc3Qgcm9vdDAgFw0yNjA4
MTkwODMxMzdaGA8yMTI2MDcyNjA4MzEzN1owJDEiMCAGA1UEAwwZcXdlbiB2MSB0
ZXN0IGludGVybWVkaWF0ZTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
AJ5qNPjDicSDvYlPa9OLT0cXhxdwn4E/zWOcBCrqX2gjxKSjsY2zQJt2dqfCAM4W
JOujxvSJdqOMDiAm5L1cT6Zgx1AJZMsG5834Kr8cDdxhxh67fb4xFe3xRUI6dKJd
GgtNHRsGjK4z2pbTtkqcxIWrbd8Ndn9djzYzNezxvP3PGVaJnL6b6wLTHS2t97FO
etATd34rekL1a5AmIMBA/7+LTxTRzh7CqJa5twQGwFlBzXUv8xVKqLfxTX5exigf
SmseMGuDey/x67nlmxV2w8uw/bmRiSdeohaJIvhteoMjl2we9wJsNTb4EedPvD4X
jhfsnAugn/XnR7KRI6OU7IMCAwEAATANBgkqhkiG9w0BAQsFAAOCAQEAeyzQQaOc
3Q7qeQuk/7YTE6xfZzIH32Dt2px6+WyiK6/bKnYHtc8zdCB808IWI+rLUnX6EPTE
uzReIBNV7AtmMZJ0tgrlR8E4qJ/+b555erOIJ/Eh4ZBVNIvIkuNEUpm1jQ3f620R
BnWgvtD1X8eC62r8EH8Dp47ZbLr8EPOtb+cxFiM2XuNHptgweoA3ppwejxygZRhn
cKowxl7QdSBmU3oGHA+j6QD9pEr5z+9GilQJkla6RnVwLLLjYI5I6/g+1bynMEoK
3ertff8Ors1iSqoY7BE06S4ceR5fLgsRbUmDKu1oPCpTWcyoCgkXu5jvLVxqI7EF
t1VyeqQyWL/vrA==
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDJDCCAgygAwIBAgIUZT8tp1esTrrlMkdlYKFtxGQsYS0wDQYJKoZIhvcNAQEL
BQAwKTEnMCUGA1UEAwwecXdlbiB2MS1pbnRlcm1lZGlhdGUgdGVzdCByb290MCAX
DTI2MDgxOTA4MzEzN1oYDzIxMjYwNzI2MDgzMTM3WjApMScwJQYDVQQDDB5xd2Vu
IHYxLWludGVybWVkaWF0ZSB0ZXN0IHJvb3QwggEiMA0GCSqGSIb3DQEBAQUAA4IB
DwAwggEKAoIBAQDdCK44mQgKprzHTRn8YrJzivRO0jGPr3+RM6iVlKorBK+dcL4b
vHX+Pp8huIELMxqH07izfWVKjGZmJRWBpZQYOX8Ss+LXejKEtg7ssXoQw5gx37Io
4atPQ5lI33E9PK4XN79h8oMZl3vhBByA5GduhIiwXJKlxvYFi6TYp9O5jnzqb/hh
1fkcG1nX9Np6Hfr+Pi6MC0UsAFoCyTm7XPhXfEXs98EHdZkQSy8apIz1zm/nTDrq
2lpcuvSh3HA8Gr2cSk5aBb2h39G9s2SFneKE/bQZU2ZzuhJmRvcWxiL4307DrW7d
Glp443R0WEfRMy0J3PE61ukfkgDFViSdn2ohAgMBAAGjQjBAMB0GA1UdDgQWBBSq
bE6kxv3+Oz9pjqZM8pxJ4GQ+sDAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQE
AwIBBjANBgkqhkiG9w0BAQsFAAOCAQEACM90IqAYKt7dA/Mkv5nzHFx8tebR7lla
+p08sSNYnht6/xd3n8s/zmO1twXRwibsnXjBdTIcWCBgTp8XSYGtuA3TZHldjDTj
C3/ZpHBNxyKv8QXJvEfF6U9CH0dQpReZeknvd1oDOQm6Qf8lRbQ3VAFnrHKaBq3V
78cN9L48r4XJXmiAolcd3n0OtOxUqr1d/t0Jw6cF2M8p0jeH5qlLIlWZy/P5d2sk
mWMSI6CNSQ2o03oMXHbSXqNV8cnPq9U84Wg0y+Hm6YcNKdC6gxSUDUqMc3YvmRpS
XfHP3tzFMIHT/tvv1dVrWFnYMgOQ30vUE0ddHXIpk0cFVAlQW4+BJw==
-----END CERTIFICATE-----
`;

/**
 * A `pathlen:0` root over one intermediate over the daemon leaf — the shape
 * every certificate in verifies while the chain as a whole does not. Measured
 * on Node v22.23.0 / OpenSSL 3.0.13 in the exact worker shape (serve
 * leaf+intermediate, `NODE_EXTRA_CA_CERTS` = the root):
 * `{"clientError":"PATH_LENGTH_EXCEEDED"}`, and `openssl verify` reports
 * `error 25 … path length constraint exceeded`.
 */
const TEST_TLS_CERT_FULLCHAIN_PATHLEN_0 = `-----BEGIN CERTIFICATE-----
MIIDKzCCAhOgAwIBAgIUKPEX/In/CWkx9CPAPZY4rT6UCHQwDQYJKoZIhvcNAQEL
BQAwIDEeMBwGA1UEAwwVUGF0aExlbjAgSW50ZXJtZWRpYXRlMB4XDTI2MDgxOTE0
MzQyN1oXDTI4MTEyMTE0MzQyN1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmQmp9NEsuVlZEJ+T0cCCF28faD4I
GVbX657CAsJYgTVC2kgGqGZAuk/N95urWB+1x296+PdNZHMtxJWXNQxCJISUKwKU
xqdSNIX/BM2Bw/SHJ2dUC923pe5ddEn+pTtx5qxDNUbBcxAPljtlO3mSNxfgAFPV
roUUvI1fsqss+mfRek+zMY1fwJb3RiVxfThu1Go4drQKNhT9xXuJwPqvDBR4IC4z
Xp+6ctUCJpoS/icsKUmOIcWHobTSNZ3bcjZoVLr55YOYJxdtBdT4x031xsQPnjNc
/YZAbQJj/w43WkF43+wT5nvAtJydMrkEDoMYupcBzDVSEVRxYv8ck65SqwIDAQAB
o2kwZzAJBgNVHRMEAjAAMBoGA1UdEQQTMBGCCWxvY2FsaG9zdIcEfwAAATAdBgNV
HQ4EFgQUmePr78NC5ICqJj5Vt7GIrT5KNMswHwYDVR0jBBgwFoAUBRtTi7BDp7xZ
oJz88pc6Tw7D438wDQYJKoZIhvcNAQELBQADggEBABt3Cmom/XV1XaPFo7eT30PT
an68hPC5q0/pYK2373mQ4xVLTDn2ChTbTCqluO4NURF5acCQ+V/3RPlCYiMHkNDK
zgmpd806EFXguZ9+7DSzE3rxK1xF1CryExH7Ru2+5qWYn0d+Ij0fOwjJkzTIWw8W
3r19lFIaIzkxs55tQRK4GK18Cfsa9h07SJKaEJjXcRRQVtwKkaEo4h9CLivRO8sz
JcwbIt00DnYaEKd8WiD+n4K/Sb0mg5q+GiYrj+aOdWYtoqLFQ+kkbchFsLnFWohk
TQ9jqYZXM6WvkZPQ53jnKvzEug5/egOSVEeeFKwJf7D+WVM37nF+6P0VH3o5ieE=
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDKTCCAhGgAwIBAgIUZQIIOfcMuP83bsNDsqpUM+xjTsQwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNUGF0aExlbjAgUm9vdDAeFw0yNjA4MTkxNDM0MjZaFw0z
NDExMDUxNDM0MjZaMCAxHjAcBgNVBAMMFVBhdGhMZW4wIEludGVybWVkaWF0ZTCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAOh4aqVYOmdtfI1XF7ZTl6Ur
dE/0lM6zzdW4kNWyFii24snW0FyuYgSkiH2RElZq9En5MYrTRNNx9V8MDuncVE2V
QVjnzVEFJ9jLrIf1rNCYGGCxg7Jv5hEjnPfaiiryKNXWQbDOaZrX9QQTl5Qm6S3d
k0siDNuKaHkdo9HY7JFECn2yHyGAHsDAQsCGv/ljuE+AY0W4tNC/KeNFGhL6zM30
W3p+pxcKTPWd0Uww504ICU27tpkokbd5o/QstrL/C6yfNqBJ59tQ+zzKYoOvIfCB
3fz0ykLmAQoFRqJv9gb6lXTQht6jpynjcZh8UMtmu2cyxjLnXesmGEUs78vu4vUC
AwEAAaNjMGEwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0O
BBYEFAUbU4uwQ6e8WaCc/PKXOk8Ow+N/MB8GA1UdIwQYMBaAFKBHB2UoNLqlrtA1
habAVNvODRfnMA0GCSqGSIb3DQEBCwUAA4IBAQBDtqkUCdRx8hMoERKNCv1b/mSV
WmvvjqLRlU/npuSQYlunhkK15kKZImn0FCtIWhOQCRUMXYlIwU8lmcFsJLxSBFwy
MBPVXTI9Hbapb8Wnyjt3spHV4SG8VlQaQYd2g+w7iJTZvb07TC7fcwFmilJoIVIb
sdsKHedv8dLxuVX8QDbBk59Q0K9Iw38CkgjvTbqTpG3Edo3MNTUOxln4s5EpEysf
5wIZkZ5Tq5bRyrwavoMomN3+cEJb1OHnx0U/m1v4KvOGPUTJJ2o7IGPVYPUOKa5b
W3/N6aVXs6jGCGfGYtJE3jr+OlszBPRodNE8fPu6l5rLS2D2Sz7iKwdVK9Ym
-----END CERTIFICATE-----
`;

/** The `pathlen:0` root of TEST_TLS_CERT_FULLCHAIN_PATHLEN_0, on its own. */
const TEST_TLS_CERT_PATHLEN_0_ROOT = `-----BEGIN CERTIFICATE-----
MIIDJDCCAgygAwIBAgIUF8LRjezZ3wMtc85KljUsisa21y8wDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNUGF0aExlbjAgUm9vdDAeFw0yNjA4MTkxNDM0MjZaFw0z
NjA4MTYxNDM0MjZaMBgxFjAUBgNVBAMMDVBhdGhMZW4wIFJvb3QwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQC2bqZOeahGQmYlznllex5VZUKc7vDx4FYT
n5iEGeopOIG/J0RRrZSEbh5ZeIh+SQ32rUYgKcR3Dt5lPgFtagzoeh4MwbpIhhM4
ed5bDMIMwXVo14cthRRF1O2lvcDwvNQggB5vJy5QveCZRU8kRJbmsy6wnWrsdv+N
MGxAxSPRBP336wjmaKgXyBKas/nzvWuz/xWerJP9+3xAdQLwOCP4qgr7XUOD0QxR
lDgRQ3loX61yX6b5so4piylOq8elEMuuA8qyenfYjWU5ExkixKKWLuh4RA+HIyWd
fE71JbcXSebJuTsma8EpuqDQ6hyR/SqFK8o8EFByDJaPbXnIWrBFAgMBAAGjZjBk
MB0GA1UdDgQWBBSgRwdlKDS6pa7QNYWmwFTbzg0X5zAfBgNVHSMEGDAWgBSgRwdl
KDS6pa7QNYWmwFTbzg0X5zASBgNVHRMBAf8ECDAGAQH/AgEAMA4GA1UdDwEB/wQE
AwIBBjANBgkqhkiG9w0BAQsFAAOCAQEADr2EiW5TTsgzXZqMh5zzZoeIvmd8w8PR
rYLKgoZKVgccqhJg5zZmKjah6FZW6YpEocnFQI0IHiB3bm2vSoMBg/YKDbz0UoKU
gWIEeGuwr2LVv7Vyfn4mrflTCLe5lxcTCcoxWvyYbRP9lwiXLwq/6v1E1MoWCBpx
5MRNo1Ez7o9f672WnI8hIR3vIsLk/ShJDsJU0PKnwq5ryWh88u2qMqJeXo3zqu5w
1QakZCZv+ySS3FAk9db5FimFCZV8tvbMxu8I1x7zScsbC21N8Ko2Bi21God9KtC5
z8EF1AJ+8689DK5PojVAsyu8QZDPpluZOR9/nkygdWkgj3J9RtMg3Q==
-----END CERTIFICATE-----
`;

/**
 * An intermediate carrying `basicConstraints critical CA:TRUE` but a keyUsage
 * WITHOUT `keyCertSign`. Measured on the same host: `leaf.checkIssued(int)` is
 * false while `leaf.verify(int.publicKey)` is true — so an issuer search keyed
 * on `checkIssued` never finds it — `int.ca` is false, `openssl verify`
 * reports `error 79 … invalid CA certificate`, and the worker-shape handshake
 * is refused.
 */
const TEST_TLS_CERT_FULLCHAIN_NO_KEY_CERT_SIGN_INTERMEDIATE = `-----BEGIN CERTIFICATE-----
MIIDLTCCAhWgAwIBAgIUC3zUptfYAXjsPB1f9xdG9OJzT8EwDQYJKoZIhvcNAQEL
BQAwIjEgMB4GA1UEAwwXTm9DZXJ0U2lnbiBJbnRlcm1lZGlhdGUwHhcNMjYwODE5
MTQzNDUwWhcNMjgxMTIxMTQzNDUwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC8p0QBgKVyD3AmjuJC/TkFIl8g
AnuxybIlzXDqMgiPlTaj/hjLESO3SUZr9nnKQ5gDd8yNWQGCibls1Y/JO8H4n10U
oPhlu5dnaAdoqLpLDvrPKBEpJCGKhVS67mDdsQfgVxgClXfmipdboeFPwxiHxNx0
pMvTCmCyQnlDV98oKMEfuNBBUFnViv6pUI0oQe65MvRqnHEc9HnnH0GByWqak//b
MWWS7LdFZcxNejXzyM2JxTY2XdM0xyzNrqaZEICJwNMp7XzS6S+W+Nbh3ih/rb9H
tVOB6vcOEuwn/qvGd+pxHcZtOtMH4nVXf4LPzS/YIXBtCmTchXdDI0RP1BAHAgMB
AAGjaTBnMAkGA1UdEwQCMAAwGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMB0G
A1UdDgQWBBSS8LxKf6par1jdsWc9rHDxPLT6TjAfBgNVHSMEGDAWgBQn8pEbETuO
TCJxuhlxAgCdR3XT2TANBgkqhkiG9w0BAQsFAAOCAQEAm+kHRcepxj3ymLvqNE0m
rb/Uvi4cE1m481hy9ND5kY3qE754vXaKOTAfSAQtlYC8N9XUTf90c1VuAoA3cJ36
MzbfH1QYNoj2+rJwzxxQ7Ii4wTXOETDv75u0OFkInOi/bREnF8x2lKYbO8DOZgb1
3FRo7CMsoXceh3D/5QJgpVIE6GcPIHFoxNdovv7MGeg8aCGOV8AdfmKJdgNnN0h4
TbvUDioDqs6Ii7BGoQIF+2CAtOujFIm1bX5RWVLzAev4bAhczWzA8xtVyaXdPcb0
6Uz+uzalrGWux2Vs8SI/GEW+bGvLWZdEGlLQ/9yPl9juKI4TrczLHehjnCMt8Icg
Bg==
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDLTCCAhWgAwIBAgIURUs4+qymFjpqVh8gVRkFQ3BMU14wDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPTm9DZXJ0U2lnbiBSb290MB4XDTI2MDgxOTE0MzQ0OVoX
DTM0MTEwNTE0MzQ0OVowIjEgMB4GA1UEAwwXTm9DZXJ0U2lnbiBJbnRlcm1lZGlh
dGUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQChSUT9K9bjB5RN3Th9
iym1f67YpVXsE/UalhlaygJxu2I8E4L/Fqr0Ime8oc6/8GucTYn0ARh35vhtL6LP
QdbjbIZSxphJsfG+QY9pia3IGMfTbSL8bVilrYMitjPZqCdvpMtYJQKI2e64nyMr
refO8bVZtcsX0SFUA8riXOVo7wjo+UPPOTlGuu1qP+9rsonobTKucs9khrcLa+QM
Itt7QonZTz8qUCf/pvsKdnQA9oBYIqcica3YoDDblGkx7HNz9grLujXno0mSSfno
GWv/fkCzQWlZWH8b3/lUOU+bfl+u0xvmb1tDfJdaqliemJ5+4nZGWvD7yCT5b6aV
DBVVAgMBAAGjYzBhMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgeAMB0G
A1UdDgQWBBQn8pEbETuOTCJxuhlxAgCdR3XT2TAfBgNVHSMEGDAWgBQ+7/MPc/s0
VJw5u4GlQbaQd6bqzjANBgkqhkiG9w0BAQsFAAOCAQEAEg9MJO8JsIqVMma54Kzs
j52bso1KgdpnV/KQ2IEsFwlg4C+wD24xLzEAyYNEYAhwRoO1YrfmxjUSAz5ugYd3
nPxFXJ/c/GSwWOPDuew5tjV6CsTgFBUF07Zz+/scE9ETuczlWRyYyWyDE3pWSlWw
QuI1ML9PDPGNyjZADILdQRE0Y3kavKVLs84Ct0UcikZkFngmmU/lv/sO3JzqmA0x
Duwy5TlXjKMS5uqXyqpuW+DMZtmQXQt2zuvXKles3L3n81ZEbHYug29BOMsbzXFQ
CjDc/j+/t/mzW3HyYqBjkmd782O/j3D+1/PCRFe5f85ZF+BkvQyXMduapQB5159H
BA==
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUYGGfWrUT80IZMy6CC45wikRv6jUwDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPTm9DZXJ0U2lnbiBSb290MB4XDTI2MDgxOTE0MzQ0OVoX
DTM2MDgxNjE0MzQ0OVowGjEYMBYGA1UEAwwPTm9DZXJ0U2lnbiBSb290MIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7bE5/gWLjTxrvncJwyYeoAaRe2Gs
8AJUazOa/TFgSJr3aVFpq6JiF1D3PwxAO+jzEwECtzbDvx+kfZIPb1DD8+yqNab1
U799wctKokr7xxAH4evIbmDHmEWYjqziEU5vnwhJkOjYsNOJHiawtgvoXRWVin27
0ebEYS9AkH4trgy6wJrSl0DVrOuHFc1QH8KEotIoT4IkMdFwDj8WJed6/WtQYLzS
jmQFmose82jeJy7UZGuMqLoK0rvzErWZjpXcgbongpY4wMM64j1mdGp1OqWxnTh/
4KhCYPbtojNX2/hiUzV26b2CRzEnLDzgsCJupKezoKw69hFUjvIhwjRWcwIDAQAB
o2MwYTAdBgNVHQ4EFgQUPu/zD3P7NFScObuBpUG2kHem6s4wHwYDVR0jBBgwFoAU
Pu/zD3P7NFScObuBpUG2kHem6s4wDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8E
BAMCAQYwDQYJKoZIhvcNAQELBQADggEBAJ+RswWBRUHQItyyOCCKL9gNe5ivaR+T
6phwcGIKmV54rac9mvkeNSTIvYGx2GUNMMoBpyPHpi8F0m058ibhfGhipXK6G9LT
cd5X4EcBdduJc9x500TjcMGtiyfkphVYM938pOG4tLLNFb/vWQrSIPJZ0pepJMaC
Erpq8v4dPDTqgiihMP59h/fsoiZ8KUQh3QrJAsl4Zw52bGqD6rofHYyCNaD2/1s4
h75jMHg9zFcEPPYec44/FXIRAbFgTCqe357jvq03r1Dp8zkpUAb61uHE5SObuC0a
uuMybpJUFN/3vvC2k9oJw7hlWQ/QRDzpWrWXQNUi0VtYoFkEefm81T0=
-----END CERTIFICATE-----
`;

/**
 * The same `pathlen:0` root issuing the daemon leaf DIRECTLY — zero
 * intermediates below it, so the constraint is satisfied exactly at its limit.
 * Measured in the worker shape: `authorized: true`, and `openssl verify` says
 * OK. This is the arm an off-by-one in the constraint check cries wolf on.
 */
const TEST_TLS_CERT_PATHLEN_0_DIRECT_LEAF = `-----BEGIN CERTIFICATE-----
MIIDIzCCAgugAwIBAgIUZQIIOfcMuP83bsNDsqpUM+xjTsUwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNUGF0aExlbjAgUm9vdDAeFw0yNjA4MTkxNDUwMjNaFw0y
ODExMjExNDUwMjNaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcN
AQEBBQADggEPADCCAQoCggEBAOR5+X6ahkMBJMG0dw8ncWuPj8znI3sV50dcnA/R
uBpGg3oeaesRfgw5LmDNfTJ1QBOT2476+IEsn+i3kyZsSOk1/NjeAZ2NtMSpzHT9
nUUIy4XUj/YAG+TvXxdzxlOBMSOyBOGVeGszPuRsIkUWYJKHUuJFRtyWnvOmdeu2
L+p6E2xHZam0Zs++tJLZMztbe/gJb1GEU4Kk963ikpe1J/9BkRXarzRPWbY2i5ZP
M3bsOeU/epwD6LV8X2jlYknMkwhU6KFUHzu7l1L+5FMa4ofqWOVdZLN3dM6ncU5u
Vj2pCHdHkOK3cD3jEujeXdZ10Zh/xyrrxKwXwvyuRrUryl8CAwEAAaNpMGcwCQYD
VR0TBAIwADAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwHQYDVR0OBBYEFMj9
HVSSrB0pRJ9pGHmU21o5gPW7MB8GA1UdIwQYMBaAFKBHB2UoNLqlrtA1habAVNvO
DRfnMA0GCSqGSIb3DQEBCwUAA4IBAQCaFiRyjHFsiNsrnB7ZYm7po9mbgilDynj3
3qpRbX0XJHyMHPzJMoAWHOiietEJdo4XvsBxWJgGZ4IKCoox+ApWR4ZO8de9dawc
wt56H29Y0jqNZWqyUesC5q+Y3po4oZtHdC72Ml/52bNRRMllE3FdJItMKUkLTonv
LgEqXJoDsVnVPXK5CQdt6KVUgiAnyf1f0pK3g8sUHPD6OI/U+Ut3UI7hFngRhweM
HVr9fDVzYBMysDqcBmD/p0vkVolkkgrxk1RaPHYWzh4CU6S3QHazTqU+wxFcC+HJ
3sOcf3nym2zfq9OYE1vM3381tdTzdee7HhkMJIdnsqu2au3ZPB0o
-----END CERTIFICATE-----
`;

/**
 * A leaf signed by a SELF-SIGNED root carrying `basicConstraints critical
 * CA:TRUE` but a keyUsage WITHOUT `keyCertSign` — the shape `openssl req -x509`
 * produces from an extfile that spells keyUsage out and forgets certificate
 * signing. Measured on Node v22.23.0 / OpenSSL 3.0.13: `openssl verify` reports
 * `error 32 … key usage does not include certificate signing`, and the real
 * worker-shape handshake (fullchain as the trust store) fails with that same
 * text — NOT `INVALID_PURPOSE`, and not for the reason `CA:FALSE` would give.
 */
const TEST_TLS_CERT_FULLCHAIN_NO_KEY_CERT_SIGN_ROOT = `-----BEGIN CERTIFICATE-----
MIIDODCCAiCgAwIBAgIUURD6Vxv0AXXGN/xK0YcSGqmSSQcwDQYJKoZIhvcNAQEL
BQAwKzEpMCcGA1UEAwwgcXdlbiBDQS1UUlVFIG5vLWtleUNlcnRTaWduIHJvb3Qw
IBcNMjYwODE5MjAyMDAwWhgPMjEyNjA3MjYyMDIwMDBaMBQxEjAQBgNVBAMMCWxv
Y2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAK7Zz4XfTUnj
0Y5+DeP6Ei05GByWGZ331oBxdj/b0GrqQCZoAMMPQJqpugMNieCwYAsZ0Urb5cMG
oC46lGti7LYgor63xEzkgdIUkzeAQbJtpBKsjWTrSD641qMaRrBfbNBju97eiuuk
A66mW/onq4CK9IlajvA9m/wALTaJ/ESWtyb4VuLShLZeE02EynqcwLvr0cYvK4cW
TzOtBeGwFpOfEjutuq73VKiZkBD28n1y10Iv7WroAZflZQpa/iPStHQMMM/FB3O2
saZnS7zPn8woxK8ujW/EIDL84iP9GCWmg+3GKgJw+GaSoFLW4l716JGjR7yzoRx7
bsb6k5ezoiMCAwEAAaNpMGcwCQYDVR0TBAIwADAaBgNVHREEEzARgglsb2NhbGhv
c3SHBH8AAAEwHQYDVR0OBBYEFE+SZE5YcAJmUXqBL+m+6azUZhAPMB8GA1UdIwQY
MBaAFGNjCta1mZzWt3LqXzvok+D0KdjAMA0GCSqGSIb3DQEBCwUAA4IBAQClqJU/
Gjp14Ifu5lBy+ofBYDqKLpVB0osatui2JDj2ZS5pAcUBnws8Jc+3duygkh9erFlG
ri1hTEh/xIiNMVOmAKZR04ynUfp1Po5jlz2/gAWl15VZtBIv4mNzufSQFaJNP/Li
UXDKlsxWYzEPY7FOZDBn6PlzcF0wKUphBOXi08xfKsL84Qqd86K+LrM/1ljX6eKt
i2SJktti2CrgcDJqZb91dyruvUiJQL14IiSttgHSipoIkwOlW+a/KbBPRnLvA3ch
JZjfQ6wBBevbkaoKKTXzFV+sw9F9IItfJPrXrnMiqulqR7018gtuSovpBPodAjSg
2fQmkJojRd/oyj6B
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDSTCCAjGgAwIBAgIUMsdEego3MpTS9isA461wuboYW+QwDQYJKoZIhvcNAQEL
BQAwKzEpMCcGA1UEAwwgcXdlbiBDQS1UUlVFIG5vLWtleUNlcnRTaWduIHJvb3Qw
IBcNMjYwODE5MjAyMDAwWhgPMjEyNjA3MjYyMDIwMDBaMCsxKTAnBgNVBAMMIHF3
ZW4gQ0EtVFJVRSBuby1rZXlDZXJ0U2lnbiByb290MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA2o7Q2xfnXyMgNzlG//yCNbTV+eJ2lZk34M+1iOIiH31z
UDzt2ZJ3jgMLrijMrQAlWNO4daK9JMk3oyxs50pHlN6T46LHq2sQPSEyxOOOnRuZ
8WvxWfFJ7SLUPrepvJ5o5Pg0oQDXR/mYq+BJCJY33RzE73yErPzGSyIKebRn3okb
W3IbwQWMfM5Piza+VSRTWMKIr8JS5Fwk7cthd//1DntMg7sljrBfobdg2hrKOPL+
o5KHR+SIxFfKfWb7iGiuh/RG7erulnS5e7n3Ua/rU+Yy1jpHuSvjzA8XZMbym22g
XusuwHka7bmHmkMjH00apDgafQze/dikKv/QusF4KQIDAQABo2MwYTAdBgNVHQ4E
FgQUY2MK1rWZnNa3cupfO+iT4PQp2MAwHwYDVR0jBBgwFoAUY2MK1rWZnNa3cupf
O+iT4PQp2MAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCBaAwDQYJKoZI
hvcNAQELBQADggEBAHYW0QOJ7OHjjav34scDKgF6LTeuPKdFr4hmYs9NFhmgz4ch
sPnDu/D4mMF0FnMl5t6XrdaG8ZIdDJs2OFjCx+N4S31FMmSBA9nIOIbyuNwKXdkU
mCAHQ66+9OGfwHPFNA2DgnQ/juQ9m47dclYFLRg01yKOgieLnBuXWE4hDOQrM1gs
vUt+YTM9mOBn0Sxr4LTqfu/MOtsTDFnysLi5IWApa96cOfl3KoCvti5Gmx5crFTw
DBgH1Rq+scl7kyyxeucobVMtUWK6eJRwZ5gfsrpeMH0nqCJLj7s80WMNL9BLojPm
rv3eIL/tayAWGZDmOpAiQdZn5pxv2jCLmv06Ae4=
-----END CERTIFICATE-----
`;
// A renewed root — two self-signed certificates sharing a
// subject AND a key, so both verify the leaf — with the SHORT-lived copy
// first in the bundle. The greedy first-match walk picked the expired copy
// and claimed every handshake fails CERT_HAS_EXPIRED while the merged bundle
// authorizes through the renewed one.
const TEST_TLS_CERT_FULLCHAIN_RENEWED_ROOT = `-----BEGIN CERTIFICATE-----
MIIDNDCCAhygAwIBAgIUO1dPcT+RFrKO9eAvR7RprjWBRZswDQYJKoZIhvcNAQEL
BQAwJDEiMCAGA1UEAwwZcXdlbiByZW5ld2VkIHRlc3Qgcm9vdCBDQTAgFw0yNjA4
MTkxMjEyMjBaGA8yMTI2MDcyNjEyMTIyMFowFDESMBAGA1UEAwwJbG9jYWxob3N0
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvXioBNIbk+BxfkQYG51E
4VpH2dEvI7CSVtDb9hCr6ejdrsOmIMuHgQoFNrj33WGVovXwqoUsy74j666mXwIU
E4uXM2kObg5rgmdT010CtqVk10NQ2zVP8HfocwvhfsGc+pXxIG3llLsEfEE4Sz6H
opapxI0J0KVngEiJtQ1pQ7ETmowE1ox9pHXg+uWNiWOfdSOffoEBdlbckl/LpPHq
JMzB7bDvKKl7Oj1/0mQjO/vVkPeFsyO0wUSzbo7RrEYfCq9ehZIHHkhTCDLZyy5x
DtPrvyq31LqQYdfFpM2r9hjIrAn4y9SjbrudLY7/mLAQ90gIO8/++CYfEUR7OOTY
gQIDAQABo2wwajAaBgNVHREEEzARhwR/AAABgglsb2NhbGhvc3QwDAYDVR0TAQH/
BAIwADAdBgNVHQ4EFgQUkteOCy+vH/p/7mLACkjh+sYr+YswHwYDVR0jBBgwFoAU
dNjaHx6CZDrwtW6UMTPqfrILgpAwDQYJKoZIhvcNAQELBQADggEBAGPSIBGUmoNm
ofVSh+2KNJhc5RzePoGUCBJa9wKa8RIpNGhIlKyD5UqvDXuQIK5GxpQ2B/B2T1zq
oyQFT1cvAedW4FbgvdF45IUAsuQmtArTduL7vawgAOW3NAZl8Ib6D8UM/bMZuMZl
78Nu8Amzuti1e4hIYceAFfs8HxgHPOhjA9O4TMr/A6hwHKsnR8CQTGE06lDkRa6p
R3EjMxkYWwzZm+3jaJlpkmxc4u2ouW5Ve7BAyCRb5afl9HD7TA/gLnPk6Z+EKbS9
avt2q89TDSohaR3fNGbSxWmyq6+gl/8c12kQZABY6FvvUAgfxMURCIoNhgTqJCNk
SJzaW9y9p4M=
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDOTCCAiGgAwIBAgIUFK4nnxLsa266COSbMQBio3y2to0wDQYJKoZIhvcNAQEL
BQAwJDEiMCAGA1UEAwwZcXdlbiByZW5ld2VkIHRlc3Qgcm9vdCBDQTAeFw0yNjA4
MTkxMjEyMjBaFw0yNjA4MjIxMjEyMjBaMCQxIjAgBgNVBAMMGXF3ZW4gcmVuZXdl
ZCB0ZXN0IHJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC1
WejFH2aVeBrJU/U9sMpdNxYDKB267SM7NckZwvukM/yw8uNTBnFTFmK0MMb18TVA
uxp12+gN1EYxgSHLQQbTHy6sGk8g8XOhbJmL5CM0OSSQ3o7lVI14hbMSLa4IoTpw
snTU/xH6FbT4F7MZc3rtKLLheymaZGaNvGGwZ6hQYSdjQxge1RLtUHqwsKR9utwF
FNxm7EmRrDRHuoxJofQGZORyUHwLZ4X0gLjO1BHNp3qcLfMXh3NM5zmgwwi0rO/u
7M3dv5MPz+EokG1ZdMywdOjYeMZMHKO8id75mmH7sKtePbsMyKbyNK+WtYqdsCSe
mhmwKLUwLPsXprwngzRTAgMBAAGjYzBhMB0GA1UdDgQWBBR02NofHoJkOvC1bpQx
M+p+sguCkDAfBgNVHSMEGDAWgBR02NofHoJkOvC1bpQxM+p+sguCkDAPBgNVHRMB
Af8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQsFAAOCAQEAryag
ROvm/WygCrsuMoeZvzGM+hIwYpq1nuOGput0zQUAqFQhyUistLCNBQ3zGxdRFEV9
FWIjBO3XdJArzc/34OWH28OOrf5OD24aXg3aK97NHk8RWCkx9AEU6mP3IAjgGnGy
Qnj3CXnEAXRkDG7iCgM0jrW6gjgXvt4Ytb5WqxuqkUUOjboa5Ib01mI1QUobSqA5
q3YiuRtwWCjJN5AyTHQnczRQU9GMcCaBd6d1Hs5DHx1dqYj5Vd6SDoUJojkydPiB
gux1cYPewfQh1p2SX6YLKRHheooVp1mgXju1x81nPl80cXsErrlFYLo7rVhjabNR
uhzf6T5xCyhBjj2XWA==
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDOzCCAiOgAwIBAgIURuDBy7kKe3JAEkySJTgKilHa8ecwDQYJKoZIhvcNAQEL
BQAwJDEiMCAGA1UEAwwZcXdlbiByZW5ld2VkIHRlc3Qgcm9vdCBDQTAgFw0yNjA4
MTkxMjEyMjBaGA8yMTI2MDcyNjEyMTIyMFowJDEiMCAGA1UEAwwZcXdlbiByZW5l
d2VkIHRlc3Qgcm9vdCBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
ALVZ6MUfZpV4GslT9T2wyl03FgMoHbrtIzs1yRnC+6Qz/LDy41MGcVMWYrQwxvXx
NUC7GnXb6A3URjGBIctBBtMfLqwaTyDxc6FsmYvkIzQ5JJDejuVUjXiFsxItrgih
OnCydNT/EfoVtPgXsxlzeu0osuF7KZpkZo28YbBnqFBhJ2NDGB7VEu1QerCwpH26
3AUU3GbsSZGsNEe6jEmh9AZk5HJQfAtnhfSAuM7UEc2nepwt8xeHc0znOaDDCLSs
7+7szd2/kw/P4SiQbVl0zLB06Nh4xkwco7yJ3vmaYfuwq149uwzIpvI0r5a1ip2w
JJ6aGbAotTAs+xemvCeDNFMCAwEAAaNjMGEwHQYDVR0OBBYEFHTY2h8egmQ68LVu
lDEz6n6yC4KQMB8GA1UdIwQYMBaAFHTY2h8egmQ68LVulDEz6n6yC4KQMA8GA1Ud
EwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMA0GCSqGSIb3DQEBCwUAA4IBAQCj
1C2V2wPvByLc9hmmx247jZs+kKiNmVW6HIEieTbRAgEr2X+sE3DGDdvxs9N7cBKW
hrrxW0DKfi86M3cqM3Z4+hpOyPukRpGF6MSuK+Z09gN/Mr8fHcpGqY37GdcREEbt
eSR8whZQy7mxoNBgPgDUa5dusMsemhkvQtT0kJNBo3mrVdxMrbT/iMqPHDnfUB5P
JuqlSTd6kmII8MLMkOPnlrBLE/IiMnpeq5bPbNqWJ3jSOWB0Y5urevXlhLvhhkZi
mfaYUhXXxhzIHbSGiqWkLbZH0m1OB7jZXhlee02W/9i/vmdFNBIAxTAfshB0X9d+
CLo3gjYAPFzEeGqHNP3E
-----END CERTIFICATE-----
`;

const CROSS_ROOT_1 = `-----BEGIN CERTIFICATE-----
MIIBkTCCATagAwIBAgIUeT/d3GHNmHzQitzyLZ3Yru0BnuIwCgYIKoZIzj0EAwIw
DTELMAkGA1UEAwwCUjEwHhcNMjYwODIwMTQwNjQ0WhcNMzYwODE3MTQwNjQ0WjAN
MQswCQYDVQQDDAJSMTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABAO2G4/eUMb5
8sSm9P6av/SB26kYM1spOgOtSbWFIB8i31RjDHnCUrktWQCix8gFk+KKOdSUIFfP
qjf1Z33RJbCjdDByMB0GA1UdDgQWBBSFh7tzjEtRhcFOt//KweX/vwzpUjAfBgNV
HSMEGDAWgBSFh7tzjEtRhcFOt//KweX/vwzpUjAPBgNVHRMBAf8EBTADAQH/MA4G
A1UdDwEB/wQEAwIBBjAPBgNVHREECDAGhwR/AAABMAoGCCqGSM49BAMCA0kAMEYC
IQDA9od9PwSd/dOFOnLq5gpCCzKWVBSzyXcn0KENGdgB/wIhAPU4TQLwx7xjPCHP
etkwf72rPOGL7sfG64FP0nna+Evz
-----END CERTIFICATE-----
`;

const CROSS_ROOT_2 = `-----BEGIN CERTIFICATE-----
MIIBgDCCASWgAwIBAgIUZ4f0aFowpdYuwYYw+VrJYpVolGowCgYIKoZIzj0EAwIw
DTELMAkGA1UEAwwCUjIwHhcNMjYwODIwMTQwNjQ0WhcNMzYwODE3MTQwNjQ0WjAN
MQswCQYDVQQDDAJSMjBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABEIEy3tDcQbR
wQ7jxHWCrZtXpB4HLkaYXbYxDgwhKRTvZ/2gch/GmBtvwIn0e7pv9wfjOP664xs2
iceOOosxacijYzBhMB0GA1UdDgQWBBSto4jb+M6nxv9BX7SwDXS9iFC88zAfBgNV
HSMEGDAWgBSto4jb+M6nxv9BX7SwDXS9iFC88zAPBgNVHRMBAf8EBTADAQH/MA4G
A1UdDwEB/wQEAwIBBjAKBggqhkjOPQQDAgNJADBGAiEAn2HbavxSri2nlXM/maDG
25rLQnEkgM+eDwje7dQco4UCIQC3uxTxRSH3mDJEcL2Uo/1/d7x8mq577XKnA/Q5
/1GhFQ==
-----END CERTIFICATE-----
`;

const CROSS_INTERMEDIATE_1 = `-----BEGIN CERTIFICATE-----
MIIBkDCCATWgAwIBAgIUK4jn+paxEGMFTbTURWtEGiEug6IwCgYIKoZIzj0EAwIw
DTELMAkGA1UEAwwCUjEwHhcNMjYwODIwMTQwNjQ1WhcNMzYwODE3MTQwNjQ1WjAd
MRswGQYDVQQDDBJDcm9zcyBJbnRlcm1lZGlhdGUwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAS7j4pX2nl4Nj+cUad0IFUnoLALZJ8DQQAlNUkBQ1wq+DfxBPWTXEpt
lbqJzIZhjku881LM0M9OdTdJyqRtvuEPo2MwYTAPBgNVHRMBAf8EBTADAQH/MA4G
A1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUyRN9LR6Pyjy6DW3xV6A+yujizkswHwYD
VR0jBBgwFoAUhYe7c4xLUYXBTrf/ysHl/78M6VIwCgYIKoZIzj0EAwIDSQAwRgIh
APBoGvl6f01SX3+SMMG1J+LbDRfe9cQVOTT2bG0IatGsAiEA+OqcZxyoWYxpnrNT
frAoKCmMH+K14TpboJ8W680Xq90=
-----END CERTIFICATE-----
`;

const CROSS_INTERMEDIATE_2 = `-----BEGIN CERTIFICATE-----
MIIBjjCCATWgAwIBAgIUDpfNzEOZOiy6xbvKRtBLuvadA84wCgYIKoZIzj0EAwIw
DTELMAkGA1UEAwwCUjIwHhcNMjYwODIwMTQwNjQ1WhcNMzYwODE3MTQwNjQ1WjAd
MRswGQYDVQQDDBJDcm9zcyBJbnRlcm1lZGlhdGUwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAS7j4pX2nl4Nj+cUad0IFUnoLALZJ8DQQAlNUkBQ1wq+DfxBPWTXEpt
lbqJzIZhjku881LM0M9OdTdJyqRtvuEPo2MwYTAPBgNVHRMBAf8EBTADAQH/MA4G
A1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUyRN9LR6Pyjy6DW3xV6A+yujizkswHwYD
VR0jBBgwFoAUraOI2/jOp8b/QV+0sA10vYhQvPMwCgYIKoZIzj0EAwIDRwAwRAIg
H9eYW8/Dvngv6kAY3bWUoqgulhWbNunKBzPTnxWmN2ICIH/quYOD05mxIzoeZGPS
gdrf8FnFYppVQzO5Z9ttA1v6
-----END CERTIFICATE-----
`;

const CROSS_LEAF = `-----BEGIN CERTIFICATE-----
MIIBuzCCAWGgAwIBAgIUMWkYua7nDRsl373Bt63skU//Qe8wCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSQ3Jvc3MgSW50ZXJtZWRpYXRlMB4XDTI2MDgyMDE0MDY0NVoX
DTM2MDgxNzE0MDY0NVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMFkwEwYHKoZIzj0C
AQYIKoZIzj0DAQcDQgAEDPZB0DN12lMCkk+2ICRewMXJKIUpc03YBQJqd3UOQW1F
yvxCCbT808DwKmLxHeJbg+kZ8yc3e/rNUz1cR4aZL6OBhzCBhDAMBgNVHRMBAf8E
AjAAMA4GA1UdDwEB/wQEAwIDiDATBgNVHSUEDDAKBggrBgEFBQcDATAPBgNVHREE
CDAGhwR/AAABMB0GA1UdDgQWBBTLt1u4Gt5B6g9xlFx75giiYQ+kfTAfBgNVHSME
GDAWgBTJE30tHo/KPLoNbfFXoD7K6OLOSzAKBggqhkjOPQQDAgNIADBFAiAgcRAh
6tcSyldzNpEgrNxX2xlAYRBDpkOkO9g8dEUDrwIhAPXeii8IRPw33QcetCJqyWvD
rTP2mq30SnHQaRt+IxuQ
-----END CERTIFICATE-----
`;

const CLIENT_ONLY_LEAF = `-----BEGIN CERTIFICATE-----
MIIBtTCCAVugAwIBAgIUOtV9BLAFWjW8r6Ni6yfEwPfbJ8kwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDgyMDE0MDY0NVoXDTM2MDgxNzE0
MDY0NVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAElLheYBUvnTKq5Ad/ZG+C9Q7EfYALIb0a4aQMRNCqn7X7MsXfq4VcWNup
DMXeYcmB9QCJ54NphWGXUdOdE1wGF6OBijCBhzAdBgNVHQ4EFgQUyALXrNmNOYTk
UeRJhl9YWnALHRYwHwYDVR0jBBgwFoAUyALXrNmNOYTkUeRJhl9YWnALHRYwDAYD
VR0TAQH/BAIwADAPBgNVHREECDAGhwR/AAABMA4GA1UdDwEB/wQEAwIHgDAWBgNV
HSUBAf8EDDAKBggrBgEFBQcDAjAKBggqhkjOPQQDAgNIADBFAiA1nG4YiUF1/hL3
OKfHPHH6pdZMNDN4drC88D4Kd97nFwIhAKz2Al1IEEy8mJhMPFIrXRWPGFOllP3k
Xb+fBUufjago
-----END CERTIFICATE-----
`;

const KEY_CERT_SIGN_ONLY_LEAF = `-----BEGIN CERTIFICATE-----
MIIBlDCCATqgAwIBAgIUDpfNzEOZOiy6xbvKRtBLuvadA9AwCgYIKoZIzj0EAwIw
DTELMAkGA1UEAwwCUjIwHhcNMjYwODIwMTQxMDA3WhcNMzYwODE3MTQxMDA3WjAU
MRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARc
EdR+oRz1xXNo5GY8XXMeLhv04CuM9RZBG1klDnGko30IOiOftFfK6931KKXp9psB
23hJWQ1d11KZZJ7H3qQJo3EwbzAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIC
BDAPBgNVHREECDAGhwR/AAABMB0GA1UdDgQWBBSrIj1Jon0+oUBfQK4PIpr1/7Iz
BzAfBgNVHSMEGDAWgBT8Y4nn1d43yR1R5Flb/R0BLjPPtzAKBggqhkjOPQQDAgNI
ADBFAiEAjz6JE5DEV0isXW3WGwPcxGgf3Hu1P+Qu4sdfJRlBY2gCIHoPr/7C+ZAw
rMHucyDXcw48wg3WmDIbBZ5iUHkVWntx
-----END CERTIFICATE-----
`;

const KEY_CERT_SIGN_ONLY_ISSUER = `-----BEGIN CERTIFICATE-----
MIIBfzCCASWgAwIBAgIURbqYh3ZfxfmU94nX3KroO2oztdcwCgYIKoZIzj0EAwIw
DTELMAkGA1UEAwwCUjIwHhcNMjYwODIwMTQxMDA3WhcNMzYwODE3MTQxMDA3WjAN
MQswCQYDVQQDDAJSMjBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABN/Gq3++mu9H
gxLRv9XJUIutKUQgKKQA+7FNfnECjfASpzq3w/kXIbNFasMEOh3N3jhe8sfMtLjW
LhjljS+orCWjYzBhMB0GA1UdDgQWBBT8Y4nn1d43yR1R5Flb/R0BLjPPtzAfBgNV
HSMEGDAWgBT8Y4nn1d43yR1R5Flb/R0BLjPPtzAPBgNVHRMBAf8EBTADAQH/MA4G
A1UdDwEB/wQEAwIBBjAKBggqhkjOPQQDAgNIADBFAiEAwp1eqjarkry11QpWoXDh
m6GdkDDlkgDVlo9xFthOW2gCIC4BOgSFQsZn1b6QrBbM3KeAogt0JbU/GganNV29
YTto
-----END CERTIFICATE-----
`;

const FAKE_SELF_VERIFIED_INTERMEDIATE = `-----BEGIN CERTIFICATE-----
MIIBkjCCATigAwIBAgIUcjMKrW8GdL4SWy0sjN6Ftta56IowCgYIKoZIzj0EAwIw
ETEPMA0GA1UEAwwGUm9vdCBBMB4XDTI2MDgyMDE0MDY0NVoXDTI2MDkxOTE0MDY0
NVowHDEaMBgGA1UEAwwRRmFrZSBJbnRlcm1lZGlhdGUwWTATBgcqhkjOPQIBBggq
hkjOPQMBBwNCAAQca5R8kwHIhxeEXFQZTyqtHGpSBjDkC3EpkcYWPbKGQseXR/J0
BZ8tKjrRisGrdn+FljIjl8VHAp2+vuzciqIPo2MwYTAdBgNVHQ4EFgQUAILGac/S
nAmumOqamezMPQlXOU0wHwYDVR0jBBgwFoAUAILGac/SnAmumOqamezMPQlXOU0w
DwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwIDSAAw
RQIgNd8m2NjLmo5lXx1zVGqNjVRK0DlwyLUVeUa3TN5VPa8CIQDLiUSxhpBdH/yI
konRu2+KHtLecnXRC/BaXvGWF3WoUQ==
-----END CERTIFICATE-----
`;

const FAKE_SELF_VERIFIED_LEAF = `-----BEGIN CERTIFICATE-----
MIIBuTCCAWCgAwIBAgIUWYfH7FMqwt08txV68JBoFkCKvGQwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRRmFrZSBJbnRlcm1lZGlhdGUwHhcNMjYwODIwMTQwNjQ1WhcN
MzYwODE3MTQwNjQ1WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAASBsAu8zOfr23TGC8avbWa29a6wkt8FPglHKw3G/Ab2+Cx0
NIiITXjWKwjopnHbBOfDfmjNFlCuCDp3/OhqdpWoo4GHMIGEMAwGA1UdEwEB/wQC
MAAwDgYDVR0PAQH/BAQDAgOIMBMGA1UdJQQMMAoGCCsGAQUFBwMBMA8GA1UdEQQI
MAaHBH8AAAEwHQYDVR0OBBYEFPtHA766j4WTqf5fWgMwmnsKTQxLMB8GA1UdIwQY
MBaAFACCxmnP0pwJrpjqmpnszD0JVzlNMAoGCCqGSM49BAMCA0cAMEQCIGpSpLfj
2SUSnRFfxP1w0tVF3hwUouurjlFgydBsNz81AiAQWZklgKzmnxLSR4W1CE5m5srR
FD7Sc2l6Dh2GBS56ZA==
-----END CERTIFICATE-----
`;

/**
 * A leaf signed by an intermediate that IS a CA (basicConstraints CA:TRUE,
 * keyCertSign) but carries `extendedKeyUsage=clientAuth` — the shape a
 * multi-purpose internal CA reissued with a wrong purpose template produces.
 * OpenSSL applies the server-purpose EKU test to EVERY chain member, not just
 * the leaf: measured on Node v22.23.2 / OpenSSL 3.0.20 with this exact file
 * as the served chain and the root as the trust store, a worker-shape
 * `tls.connect` fails `{"code":"INVALID_PURPOSE","message":"unsuitable
 * certificate purpose"}` and `openssl verify -purpose sslserver` reports
 * "error 26 at 1 depth lookup: unsuitable certificate purpose". The file
 * includes the root so the chain anchors — only the purpose fails. Not a
 * real secret.
 */
const TEST_TLS_CERT_CLIENT_EKU_CHAIN = `-----BEGIN CERTIFICATE-----
MIIDWTCCAkGgAwIBAgIUXgiovCRxbm0joqkwaCbrlJAg5VUwDQYJKoZIhvcNAQEL
BQAwJzElMCMGA1UEAwwccXdlbiBjbGllbnQtZWt1IGludGVybWVkaWF0ZTAeFw0y
NjA4MjMxMjM1NTZaFw0zNjA4MjAxMjM1NTZaMBQxEjAQBgNVBAMMCWxvY2FsaG9z
dDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAJmLMHPtMZw+1/DcCFeW
xVNsJwQyECgfARs1rxOgVInGlqsePZBFOadECFVP1Wj2EQiZUjBNe6PHWdWnu3/Z
WKbDxfOWR5DQn2h0EkhUJTrU929RwqnHuRaIgzaai54XWxezXakVD2vpoh3RlGRN
6FDZdLTmnrESX+618EPwKQI8w2iBjkTqLvOf4jpQJwNPLSQ/+AM/X1lgAgppA672
flHHtCwpMGJmKAKSivYolDHmdKXdbS8Uddc8aiTqTeaQB+8ExgMYidZ5R5OLYKOc
c5rg73dlk0tJOl5/YUb+iuKcY5MGTRlIcOOKcMoMzqpwxujbbvpNO4295n2ZXPSE
EMECAwEAAaOBjzCBjDAJBgNVHRMEAjAAMA4GA1UdDwEB/wQEAwIFoDATBgNVHSUE
DDAKBggrBgEFBQcDATAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwHQYDVR0O
BBYEFDzACaM+l1+De7ME7pcOKxJrQeylMB8GA1UdIwQYMBaAFLVfKnl9aiiN1eu9
UXsquyEzyolmMA0GCSqGSIb3DQEBCwUAA4IBAQCAOWCYES6p29FS09NEMiKEJPIZ
cElWVxVbmV0rr+8lzTUPP2N41TH3W7Kns5DYK1SQH90eFz+4POcInaLwAisKEUk2
WLn1MBq9n2v6o/E3eQ/9z901F0i25JYtF2JdWqzZwwHgDtcx7rWKyOe/g8JrgyO1
1qHMK83lNuTdX2nmM6LLR5fM+7HvH/B6A5t0SMy7jkRFBg/k5cxrcTb6mEpjSWs4
MT+9wic3NKX13RW7dMtstJRpaSUY2bK9J8eUJc1owYi7g6CzKdGYFzHormJi9oKr
vAmNnDnFLKjZecTjbNoiK04a41uhNQ16WVoviK3jrNHaOoCES1w951H9Q1ol
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDSjCCAjKgAwIBAgIUNyW6Y5XGTAL740qXa3847G6GyeYwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwScXdlbiBla3UgdGVzdCByb290MB4XDTI2MDgyMzEyMzU1
NloXDTM2MDgyMDEyMzU1NlowJzElMCMGA1UEAwwccXdlbiBjbGllbnQtZWt1IGlu
dGVybWVkaWF0ZTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAKcIGZnE
dIr9ea1NCD8VckHdQD6OJl8UUPneZWAfWcth7w1O7MGpbBSZDqMWr0XI6+hEgFeD
abZxQGRlPuAbC9Wc2B6QDg9BURafaD1ma6HKAkZtVTwfnK7i775aOyervcyKG6m8
SlNwU++Flc7C8M3S/pvZW/B5UsDPlQc7zSb4//tu4Oc61S/HDy4RldkziEBFGXik
uu1s37Fk5QvVEq6f3v1N3IaxdJpItPmYWbd8iqBJ3kOWU4yro7ZjAca2PKRuNzAb
J2opLxm+1V5B7/ny0OTL/0oGFgTEegBIWE92EJFN5tsdAfIQhRJYIeHIhEhs2v1t
JCpL3YKKeaG5t10CAwEAAaN4MHYwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8E
BAMCAQYwEwYDVR0lBAwwCgYIKwYBBQUHAwIwHQYDVR0OBBYEFLVfKnl9aiiN1eu9
UXsquyEzyolmMB8GA1UdIwQYMBaAFPNu3I4kv7G16WSFypNL4OpviRREMA0GCSqG
SIb3DQEBCwUAA4IBAQCZ5SScQb496KHb+OMHB/wqJO59zX2XFfLhOqEPWHpIXT/g
NMJenwlr/r9aB9I4yLFQpJcAMtnDXa2qfB91hOcKpoVyernnNqaD5lpEDBffrmJl
dKvebpHwdMNlfIbFelsEtb/ZU9F6SLGWuNK+QrnUkOvWTXy0GUBcmdOPiR6b90NP
r2IRn+UX3u+92/0OAKquhS34EM+T+cIwHqBWJuE3Acp4CELvDgVlJmAfCq/i1wnB
/UIlnEYhlHZ2pk/tIh5mujr+rFyANe8KzifDmvjC0o98CHLghYkcntcU01gsrYy8
bPH1/S0f5dB2rp7Ne0ZPLMStzjD87Pm2WKFk102l
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDKzCCAhOgAwIBAgIUOWUnEy0fcOcnsRZaSQ6B5JnUZzgwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwScXdlbiBla3UgdGVzdCByb290MB4XDTI2MDgyMzEyMzU1
NloXDTM2MDgyMDEyMzU1NlowHTEbMBkGA1UEAwwScXdlbiBla3UgdGVzdCByb290
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnzmx++Qvu1xQezLzRJUM
IiWo84LyLhAjj9z9cSQWV0gV6DVZjZh2NGiegKcTyj9a2hTG6vMNAa2eLyNpB4J3
a2RBPDE+A0t8f0aJDBJh8s2IG19gdJj2TCecx3BEk/nRtbjGYRQIqHkQuJcT5EhC
2igIkONRQ/fNKbXt1enTL/uc9TyAEOcDVzyvE+Y/4J10I6ZhrSAhZ5MvoZvK7SY0
agscsyH8ocKehD/FZJ+7lWNrZmNtwWJCyVRjvIK6E+9HkZYi8Lzn8SeuaMCeIKqt
TvYLgvp0Y21jumS3TeXKdcwwrJd5cPF8jSfVeTdA9Owi+u3Vx5H6xVl4r5oRmfa5
nQIDAQABo2MwYTAdBgNVHQ4EFgQU827cjiS/sbXpZIXKk0vg6m+JFEQwHwYDVR0j
BBgwFoAU827cjiS/sbXpZIXKk0vg6m+JFEQwDwYDVR0TAQH/BAUwAwEB/zAOBgNV
HQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQELBQADggEBAAjscSpURTsy4xP2uC9UlsCn
Lmb2bTWO+ejlcP2y5vsdP+cNaO8FtANbBPTkPV5+Kizu7a7L5QlDSuQxDEDWg54l
3+1Ize0KPILPA1SC5SEkh4JpvG+wN1udm0ykFiQyCyET/wfoWe3O74nKyZTVgtq0
09uLEVXaWBl3gZJ5NKOD73kM2StVyXsFkGEPz4FwVGMrQaFpPHHrzJOW3iU0xo3v
aa+iyqy+FppmCRJZKyqP1n3Bzk7m9tzSfYNb8vdFsLA5DlkV1lAhtBoSbkLAsYPN
gupdQ6qWEKa1z147s84N7ASbhYZhnluZs9t4gpYZ8PavMSggcPhYPxLDFshHkqo=
-----END CERTIFICATE-----
`;

/**
 * The same chain with a serverAuth-EKU intermediate — the control that
 * authorizes (measured on Node v22.23.2: `authorized: true`) and keeps the
 * chain-wide EKU rule from crying wolf. Not a real secret.
 */
const TEST_TLS_CERT_SERVER_EKU_CHAIN = `-----BEGIN CERTIFICATE-----
MIIDWTCCAkGgAwIBAgIUIFGbo8TlS1PT3vk6OaFo7I7i2XAwDQYJKoZIhvcNAQEL
BQAwJzElMCMGA1UEAwwccXdlbiBzZXJ2ZXItZWt1IGludGVybWVkaWF0ZTAeFw0y
NjA4MjMxMjM2MTJaFw0zNjA4MjAxMjM2MTJaMBQxEjAQBgNVBAMMCWxvY2FsaG9z
dDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAJmLMHPtMZw+1/DcCFeW
xVNsJwQyECgfARs1rxOgVInGlqsePZBFOadECFVP1Wj2EQiZUjBNe6PHWdWnu3/Z
WKbDxfOWR5DQn2h0EkhUJTrU929RwqnHuRaIgzaai54XWxezXakVD2vpoh3RlGRN
6FDZdLTmnrESX+618EPwKQI8w2iBjkTqLvOf4jpQJwNPLSQ/+AM/X1lgAgppA672
flHHtCwpMGJmKAKSivYolDHmdKXdbS8Uddc8aiTqTeaQB+8ExgMYidZ5R5OLYKOc
c5rg73dlk0tJOl5/YUb+iuKcY5MGTRlIcOOKcMoMzqpwxujbbvpNO4295n2ZXPSE
EMECAwEAAaOBjzCBjDAJBgNVHRMEAjAAMA4GA1UdDwEB/wQEAwIFoDATBgNVHSUE
DDAKBggrBgEFBQcDATAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwHQYDVR0O
BBYEFDzACaM+l1+De7ME7pcOKxJrQeylMB8GA1UdIwQYMBaAFB8Uo17wlkWbW8LR
gK2N72eca5TuMA0GCSqGSIb3DQEBCwUAA4IBAQBh+UhSnSp+rULQ/NwBFd81kYeW
ZWcWq+rDoGQoB2WoLKD7tfSgkdyKHoVJfgjR8VvS4oByGrsnuPQ5UihUEtLbvrZY
HHE3kcixwe0/xFyLrOMY7mXAcnCu9xps11hMk0yEgSrICGg5CSt1kK5mkIqf5sYx
2Em10IdH0436G+xLnlMzXJqEwwR2W/RA3a0R27Hp5+38L/UoSrTvmICa3BJ+oq4u
BAoMkvm2dmNR/FlxZ7MeArHOgyYC0aHwZi0fvFjKVATyuFEWIOYBCj/aJr5C/CVR
ZF6V0QbD+Yj0cvR7Uko/4BnPb/ig9gamQ/Un7Bpo0C+EHi3hOQH5hsjFpvrp
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDSjCCAjKgAwIBAgIUNyW6Y5XGTAL740qXa3847G6GyecwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwScXdlbiBla3UgdGVzdCByb290MB4XDTI2MDgyMzEyMzYx
MloXDTM2MDgyMDEyMzYxMlowJzElMCMGA1UEAwwccXdlbiBzZXJ2ZXItZWt1IGlu
dGVybWVkaWF0ZTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAPFGRLTl
0ZOQr8Em/a8Xkm6Zq6gYQCmAcwnQa+XFkTFJpDImYPakibECxIKzU0kJ2pFX4CfW
fdkDzssjVy7pLBGqqrqncQy4F6llbLAFYC+2/VNs7pmO3A1Ews52wMyZShqkItid
FmZcfeX+FiqwL9bdCJj47soA9PJ5vBnJlxECBM74B4aBVaWYespUGJFkjgq9+gMb
PWo/m8Nvb3T2ukqqzD0m6xuOqggrHHA34vrjl7xHyqcA92K70cTT1ObMWeDW2REQ
we3W0liWVRZtRfYozO8wQ/sotEW5O0cq0nbwVPtzXVEGtSir4QXV02cYua58Fue3
myFyUT+mqYpsyosCAwEAAaN4MHYwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8E
BAMCAQYwEwYDVR0lBAwwCgYIKwYBBQUHAwEwHQYDVR0OBBYEFB8Uo17wlkWbW8LR
gK2N72eca5TuMB8GA1UdIwQYMBaAFPNu3I4kv7G16WSFypNL4OpviRREMA0GCSqG
SIb3DQEBCwUAA4IBAQBXSGmK9T0d9wz8KEnsUOtWS3dY3oxjLU84i/zkwJwRwwzf
7f7XH/zyfr3teTG+bdFsgX1tUiOFzIWTzUZCCW7NV+cUbv5QD7/nIT/lYuqzcdIB
47FtghDEnyfm4CfiSomLKgmUbcXa+MXc0Z/u2G5uuSpBPwfBJnMQ8YrJwDlrXsnb
FTNESjvLkErHA2XUfKVimp9GiWSbqo60FjNmKam8sOTNpqzdfqtrj2qOty07TvQY
eLiRyfmLSJUSh3liAxHSgYRC46lMnM0NPgYY/0XssJZQb+rfNyCSuok2L74rNpEd
ybXgO+LWfjCIByNZOmzvPUEbpDbptYQlWwQBK4TB
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDKzCCAhOgAwIBAgIUOWUnEy0fcOcnsRZaSQ6B5JnUZzgwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwScXdlbiBla3UgdGVzdCByb290MB4XDTI2MDgyMzEyMzU1
NloXDTM2MDgyMDEyMzU1NlowHTEbMBkGA1UEAwwScXdlbiBla3UgdGVzdCByb290
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnzmx++Qvu1xQezLzRJUM
IiWo84LyLhAjj9z9cSQWV0gV6DVZjZh2NGiegKcTyj9a2hTG6vMNAa2eLyNpB4J3
a2RBPDE+A0t8f0aJDBJh8s2IG19gdJj2TCecx3BEk/nRtbjGYRQIqHkQuJcT5EhC
2igIkONRQ/fNKbXt1enTL/uc9TyAEOcDVzyvE+Y/4J10I6ZhrSAhZ5MvoZvK7SY0
agscsyH8ocKehD/FZJ+7lWNrZmNtwWJCyVRjvIK6E+9HkZYi8Lzn8SeuaMCeIKqt
TvYLgvp0Y21jumS3TeXKdcwwrJd5cPF8jSfVeTdA9Owi+u3Vx5H6xVl4r5oRmfa5
nQIDAQABo2MwYTAdBgNVHQ4EFgQU827cjiS/sbXpZIXKk0vg6m+JFEQwHwYDVR0j
BBgwFoAU827cjiS/sbXpZIXKk0vg6m+JFEQwDwYDVR0TAQH/BAUwAwEB/zAOBgNV
HQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQELBQADggEBAAjscSpURTsy4xP2uC9UlsCn
Lmb2bTWO+ejlcP2y5vsdP+cNaO8FtANbBPTkPV5+Kizu7a7L5QlDSuQxDEDWg54l
3+1Ize0KPILPA1SC5SEkh4JpvG+wN1udm0ykFiQyCyET/wfoWe3O74nKyZTVgtq0
09uLEVXaWBl3gZJ5NKOD73kM2StVyXsFkGEPz4FwVGMrQaFpPHHrzJOW3iU0xo3v
aa+iyqy+FppmCRJZKyqP1n3Bzk7m9tzSfYNb8vdFsLA5DlkV1lAhtBoSbkLAsYPN
gupdQ6qWEKa1z147s84N7ASbhYZhnluZs9t4gpYZ8PavMSggcPhYPxLDFshHkqo=
-----END CERTIFICATE-----
`;

// `tls.getCACertificates` arrives in Node 22.15, while engines still allow
// 22.0: there the loader oracle answers `legacy` and the inspection throws,
// so tests that drive the real oracle skip instead of failing.
const loaderOracleAvailable = typeof tls.getCACertificates === 'function';
const loaderOracleTest = it.skipIf(typeof tls.getCACertificates !== 'function');

describe.skipIf(!loaderOracleAvailable)('describeWorkerTlsTrustGaps', () => {
  const daemonUrl = 'https://127.0.0.1:4170';

  /** The issuing root of TEST_TLS_CERT_FULLCHAIN, on its own. */
  const fullchainRootPem = (): string => {
    const blocks = TEST_TLS_CERT_FULLCHAIN.match(
      /-----BEGIN CERTIFICATE-----[^-]*-----END CERTIFICATE-----/g,
    );
    return `${blocks!.at(-1)}\n`;
  };

  /** The renewed-root bundle minus its long-lived twin. */
  const leafPlusShortTwinOnlyPem = (): string => {
    const blocks = TEST_TLS_CERT_FULLCHAIN_RENEWED_ROOT.match(
      /-----BEGIN CERTIFICATE-----[^-]*-----END CERTIFICATE-----/g,
    );
    // Index 1 must hold the short-lived twin the boundary clock sits on;
    // a reordered fixture would silently un-pin the notAfter edge below.
    const shortTwin = new X509Certificate(blocks![1]);
    if (
      new Date(shortTwin.validTo).getTime() !==
      new Date('2026-08-22T12:12:20Z').getTime()
    ) {
      throw new Error('renewed-root fixture order changed');
    }
    return `${blocks![0]}\n${blocks![1]}\n`;
  };

  it('reports nothing for a self-signed cert covering the dialled host', () => {
    expect(
      describeWorkerTlsTrustGaps({
        cert: Buffer.from(TEST_TLS_CERT),
        certPath: '/certs/daemon.pem',
        daemonUrl,
      }),
    ).toEqual([]);
  });

  it('reports a leaf whose keyUsage only permits certificate signing', () => {
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(CROSS_ROOT_1),
      certPath: '/certs/daemon.pem',
      daemonUrl,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('INVALID_PURPOSE');
    expect(gaps[0]).toContain('keyUsage permits none');
  });

  it('reports an issued leaf whose keyUsage only permits certificate signing', () => {
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(
        `${KEY_CERT_SIGN_ONLY_LEAF}${KEY_CERT_SIGN_ONLY_ISSUER}`,
      ),
      certPath: '/certs/daemon.pem',
      daemonUrl,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('INVALID_PURPOSE');
    expect(gaps[0]).toContain('keyUsage permits none');
  });

  it('reports a leaf whose extendedKeyUsage only permits client auth', () => {
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(CLIENT_ONLY_LEAF),
      certPath: '/certs/daemon.pem',
      daemonUrl,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('INVALID_PURPOSE');
    expect(gaps[0]).toContain('extendedKeyUsage does not include serverAuth');
  });

  it('requires matching subject and issuer names for a self-signed anchor', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const gaps = describeWorkerTlsTrustGaps({
        cert: Buffer.from(
          `${FAKE_SELF_VERIFIED_LEAF}${FAKE_SELF_VERIFIED_INTERMEDIATE}`,
        ),
        certPath: '/certs/daemon.pem',
        daemonUrl,
      });
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    } finally {
      vi.useRealTimers();
    }
  });

  it('models operator certificates before serving certificates', () => {
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(`${CROSS_LEAF}${CROSS_INTERMEDIATE_2}${CROSS_ROOT_2}`),
      certPath: '/certs/daemon.pem',
      daemonUrl,
      operatorCaCertPath: '/certs/operator.pem',
      operatorCaCert: Buffer.from(CROSS_INTERMEDIATE_1),
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  });

  it('uses an operator-first cross-signed path when it is anchored', () => {
    expect(
      describeWorkerTlsTrustGaps({
        cert: Buffer.from(`${CROSS_LEAF}${CROSS_INTERMEDIATE_1}`),
        certPath: '/certs/daemon.pem',
        daemonUrl,
        operatorCaCertPath: '/certs/operator.pem',
        operatorCaCert: Buffer.from(`${CROSS_INTERMEDIATE_2}${CROSS_ROOT_2}`),
      }),
    ).toEqual([]);
  });

  it('names the leaf-as-trust-anchor gap for a CA-issued cert', () => {
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_CA_ISSUED),
      certPath: '/certs/daemon.pem',
      daemonUrl,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(gaps[0]).toContain('qwen test root CA');
  });

  it('stays quiet when the operator CA actually anchors the chain', () => {
    // R2-3: BEHAVIOUR FLIP. A set `operatorCaCertPath` used to suppress this
    // gap on its own. A typo'd, unrelated or unloadable NODE_EXTRA_CA_CERTS
    // anchors exactly as little as no CA at all, so coverage is now judged on
    // the file's contents — the certificates the workers really receive.
    expect(
      describeWorkerTlsTrustGaps({
        cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_LEAF_ONLY),
        certPath: '/certs/daemon.pem',
        daemonUrl,
        operatorCaCertPath: '/certs/rootCA.pem',
        operatorCaCert: Buffer.from(fullchainRootPem()),
      }),
    ).toEqual([]);
  });

  it('still names the gap when the operator CA does not anchor the chain', () => {
    // R2-3(a): the merge in resolveWorkerCaCertPath cannot make an unrelated
    // CA anchor this leaf, so the operator lands in exactly the boot-green /
    // workers-looping mode this warning exists to name.
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_CA_ISSUED),
      certPath: '/certs/daemon.pem',
      daemonUrl,
      operatorCaCertPath: '/certs/unrelated.pem',
      operatorCaCert: Buffer.from(fullchainRootPem()),
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(gaps[0]).toContain('/certs/unrelated.pem');
  });

  it('still names the gap when the operator CA path is unreadable', () => {
    // R2-3(a): a set-but-unreadable path reaches the check with no contents.
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_CA_ISSUED),
      certPath: '/certs/daemon.pem',
      daemonUrl,
      operatorCaCertPath: '/certs/typo.pem',
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(gaps[0]).toContain('/certs/typo.pem');
  });

  it('softens the leaf-anchor gap for a CA already in the default trust store', () => {
    // R2-3(c): the static model cannot see the workers' default trust store,
    // so an issuer already anchored there makes this warning cry wolf. Say
    // what the check actually knows instead of asserting a certain failure.
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_CA_ISSUED),
      certPath: '/certs/daemon.pem',
      daemonUrl,
    });
    expect(gaps[0]).toContain(
      "unless the issuing CA is already in the workers' default trust store",
    );
  });

  // The false-alarm direction: the walk took whichever copy
  // of a renewed CA came first and reported the expired one as the path the
  // handshake relies on. OpenSSL may use either; preferring the usable one
  // keeps the diagnostic from sending operators to renew a CA they already
  // renewed. The clock is moved past the short-lived copy only.
  it('prefers a usable issuer over an expired same-subject twin', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    try {
      expect(
        describeWorkerTlsTrustGaps({
          cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_RENEWED_ROOT),
          certPath: '/certs/fullchain.pem',
          daemonUrl,
        }),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // One-clock witnesses: the walk's issuer preference and the per-member
  // validity flags must judge the SAME instant the report samples. The
  // straddle test hands that one sample an instant inside the short-lived
  // twin's window and poisons any second sample with an instant past it —
  // two clocks would anchor through the short root AND tell the operator
  // to renew it, the false CERT_HAS_EXPIRED this PR removes. Sample order
  // routes the clocks, not a stack-name match on the module-private walk,
  // so a rename cannot silently no-op the guard. The boundary tests freeze
  // the clock on each edge of that window, where the expired/not-yet-valid
  // flags flip, so a one-sided edit to either predicate fails instead of
  // passing silently years away from any boundary.
  it('judges the walk and the report at one sampled instant', () => {
    const insideWindow = new Date('2026-08-20T00:00:00Z').getTime();
    const pastWindow = new Date('2026-08-25T00:00:00Z').getTime();
    // Production passes the serving file as certSourcePath; mirror that.
    // The temp-file fallback spends a Date.now sample of its own
    // (graceful-fs retry timing), which would shift the poison below.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-one-clock-'));
    const certSourcePath = path.join(dir, 'fullchain.pem');
    fs.writeFileSync(certSourcePath, TEST_TLS_CERT_FULLCHAIN_RENEWED_ROOT, {
      mode: 0o600,
    });
    let samples = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      samples += 1;
      return samples === 1 ? insideWindow : pastWindow;
    });
    try {
      expect(
        describeWorkerTlsTrustGaps({
          cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_RENEWED_ROOT),
          certPath: '/certs/fullchain.pem',
          certSourcePath,
          daemonUrl,
        }),
      ).toEqual([]);
      // A second sample IS the regression: the walk and the report judging
      // different instants. Fail on it even when the gap happens not to.
      expect(samples).toBe(1);
    } finally {
      clock.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('agrees on the exact instant the short-lived twin expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T12:12:20Z'));
    try {
      expect(
        describeWorkerTlsTrustGaps({
          cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_RENEWED_ROOT),
          certPath: '/certs/fullchain.pem',
          daemonUrl,
        }),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // The notAfter edge is pinned only when the expiring twin is the walk's
  // ONLY issuer: with the long-lived twin in the bundle, a strict `>` in
  // certValidAt re-anchors through it and still reports no gaps one
  // instant early — the same false CERT_HAS_EXPIRED class this PR removes.
  it('still anchors at the exact notAfter when the short twin is the only issuer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T12:12:20Z'));
    try {
      expect(
        describeWorkerTlsTrustGaps({
          cert: Buffer.from(leafPlusShortTwinOnlyPem()),
          certPath: '/certs/fullchain.pem',
          daemonUrl,
        }),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('agrees on the exact instant the short-lived twin becomes valid', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T12:12:20Z'));
    try {
      expect(
        describeWorkerTlsTrustGaps({
          cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_RENEWED_ROOT),
          certPath: '/certs/fullchain.pem',
          daemonUrl,
        }),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names an expired chain member the signature-only walk accepts', () => {
    // R2-3(b): `x509.verify` checks signatures and never consults dates, so an
    // expired root anchors a fullchain "fine" here while every worker
    // handshake fails CERT_HAS_EXPIRED. Boot validation covers the leaf alone,
    // so nothing else would ever name it. The fixture root outlives its leaf
    // by design, so the clock — not a second fullchain — is what moves.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2130-01-01T00:00:00Z'));
    try {
      const gaps = describeWorkerTlsTrustGaps({
        cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN),
        certPath: '/certs/fullchain.pem',
        daemonUrl,
      });
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toContain('CERT_HAS_EXPIRED');
      expect(gaps[0]).toContain('qwen fullchain test root CA');
      // The leaf's own dates are boot validation's job, not this warning's.
      expect(gaps[0]).not.toContain('CN=localhost,');
    } finally {
      vi.useRealTimers();
    }
  });

  it('names a chain member whose validity window has not started', () => {
    // Symmetric to the expiry branch: clock skew or a freshly minted root
    // fails every handshake CERT_NOT_YET_VALID with the same silent boot.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    try {
      const gaps = describeWorkerTlsTrustGaps({
        cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN),
        certPath: '/certs/fullchain.pem',
        daemonUrl,
      });
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toContain('CERT_NOT_YET_VALID');
      expect(gaps[0]).toContain('qwen fullchain test root CA');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing about certificates outside the anchor path', () => {
    // The bundle may carry unrelated CAs; only the members the leaf's walk
    // leans on are members whose validity the handshake enforces.
    expect(
      describeWorkerTlsTrustGaps({
        cert: Buffer.from(`${TEST_TLS_CERT}${TEST_TLS_CERT_EXPIRED}`),
        certPath: '/certs/daemon.pem',
        daemonUrl,
      }),
    ).toEqual([]);
  });

  it('names the SAN gap when the cert does not cover the dialled host', () => {
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_NO_LOOPBACK_SAN),
      certPath: '/certs/daemon.pem',
      daemonUrl,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('ERR_TLS_CERT_ALTNAME_INVALID');
    expect(gaps[0]).toContain('127.0.0.1');
  });

  it('checks the host actually dialled, not a fixed loopback literal', () => {
    expect(
      describeWorkerTlsTrustGaps({
        cert: Buffer.from(TEST_TLS_CERT_NO_LOOPBACK_SAN),
        certPath: '/certs/daemon.pem',
        daemonUrl: 'https://example.invalid:4170',
      }),
    ).toEqual([]);
  });

  it('anchors a fullchain serving file on the issuing CA it carries', () => {
    // R2-2: `X509Certificate` reads only the first PEM block, so a fullchain
    // used to be judged on its leaf alone and reported as unanchorable — even
    // though the supervisor injects the whole file, root included, as the
    // workers' trust store.
    expect(
      describeWorkerTlsTrustGaps({
        cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN),
        certPath: '/certs/fullchain.pem',
        daemonUrl,
      }),
    ).toEqual([]);
  });

  it('still names the gap when the bundle stops short of a root', () => {
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_LEAF_ONLY),
      certPath: '/certs/fullchain.pem',
      daemonUrl,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(gaps[0]).toContain('qwen fullchain test root CA');
  });

  it('checks an IPv6 dial host against the iPAddress SAN, brackets stripped', () => {
    // R2-1: `URL.hostname` yields `[::1]`, which `isIP` rejects, so the check
    // used to take the DNS-name branch and false-positive on every correct
    // IPv6 serving cert.
    expect(
      describeWorkerTlsTrustGaps({
        cert: Buffer.from(TEST_TLS_CERT_IPV6_SAN),
        certPath: '/certs/daemon.pem',
        daemonUrl: 'https://[::1]:4170',
      }),
    ).toEqual([]);
  });

  it('names the SAN gap for an IPv6 host the certificate does not cover', () => {
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_IPV6_SAN),
      certPath: '/certs/daemon.pem',
      daemonUrl: 'https://[fd00::1]:4170',
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('ERR_TLS_CERT_ALTNAME_INVALID');
    expect(gaps[0]).toContain('fd00::1');
    expect(gaps[0]).not.toContain('[fd00::1]');
  });

  it('reports both gaps when a CA-issued cert also misses the dialled host', () => {
    // R2-7: every other case produces 0 or 1 gap, so an inserted `return gaps`
    // after the first push — or turning the SAN `if` into an `else if` —
    // survived the whole suite. Under that mutant an operator fixes the trust
    // anchor, restarts, and only then discovers the SAN failure.
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_CA_ISSUED),
      certPath: '/certs/daemon.pem',
      daemonUrl: 'https://example.invalid:4170',
    });
    expect(gaps).toHaveLength(2);
    expect(gaps.join('\n')).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(gaps.join('\n')).toContain('ERR_TLS_CERT_ALTNAME_INVALID');
  });

  it('names a self-signed chain terminator that is not a CA', () => {
    // R2-10: chain geometry alone blesses this file as anchored, but OpenSSL
    // also requires a signing certificate to carry CA:TRUE. Measured on Node
    // 22: leaf + CA:FALSE self-signed issuer as the trust store fails
    // INVALID_PURPOSE, while boot stays green and warning-free.
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_NON_CA_ROOT),
      certPath: '/certs/fullchain.pem',
      daemonUrl,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('INVALID_PURPOSE');
    expect(gaps[0]).toContain('qwen non-CA test issuer');
  });

  it('names a chain that passes THROUGH an issuer that is not a CA', () => {
    // R4-4: the CA-suitability check only covered the self-signed terminator,
    // so a chain whose INTERMEDIATE carries basicConstraints CA:FALSE walked
    // all the way to a real CA root and was reported anchored. Measured on
    // Node 22 / OpenSSL 3 with this exact file as the served chain and the
    // trust store: authorized=false, code=INVALID_PURPOSE — daemon green,
    // /health green, every channel worker restart-looping with no boot hint.
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_NON_CA_INTERMEDIATE),
      certPath: '/certs/fullchain.pem',
      daemonUrl,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('INVALID_PURPOSE');
    expect(gaps[0]).toContain('qwen non-CA test intermediate');
  });

  it('names a v3 chain terminator with no basicConstraints at all', () => {
    // R5-1: the terminator check read basicConstraints' PRESENCE, so a v3 root
    // carrying only a subjectKeyIdentifier — `.ca === false`, no
    // basicConstraints OID, no keyCertSign — walked straight past it and boot
    // reported zero gaps. OpenSSL refuses that root as an issuer. Measured on
    // Node v22.23.0 / OpenSSL 3.0.13 with this exact file as the served chain
    // and the trust store: authorized=false, code=INVALID_PURPOSE, while the
    // daemon, /health and the boot log all stay green.
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_V3_NO_CONSTRAINTS_ROOT),
      certPath: '/certs/fullchain.pem',
      daemonUrl,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('INVALID_PURPOSE');
    expect(gaps[0]).toContain('qwen v3 no-constraints test root');
  });

  it('keeps trusting a root whose keyUsage alone allows certificate signing', () => {
    // The control for R5-1, and what stops the widened check from crying wolf:
    // the same geometry with `keyUsage keyCertSign` and still no
    // basicConstraints. `X509_check_ca` returns 4 for it and the same
    // measurement handshakes authorized=true.
    expect(
      describeWorkerTlsTrustGaps({
        cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_KEY_CERT_SIGN_ROOT),
        certPath: '/certs/fullchain.pem',
        daemonUrl,
      }),
    ).toEqual([]);
  });

  it('names a chain that passes through a v1 intermediate', () => {
    // R5-26: the intermediate check is the broad `!issuer.ca`, and the only
    // fixture pinning it was an explicit CA:FALSE one — so narrowing it to the
    // terminator's basicConstraints-presence test shipped green while a v1
    // intermediate (an internal PKI signed without `-extfile`) climbed past it
    // and reported anchored. The v1 exemption belongs to a self-signed ROOT
    // only. Measured on Node v22.23.0 / OpenSSL 3.0.13 with this file as the
    // served chain and the trust store: authorized=false,
    // code=INVALID_PURPOSE.
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_V1_INTERMEDIATE),
      certPath: '/certs/fullchain.pem',
      daemonUrl,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('INVALID_PURPOSE');
    expect(gaps[0]).toContain('qwen v1 test intermediate');
  });

  it('reports the discarded operator CA when the serving file is unloadable', () => {
    // R4-3: the model merged the operator CA into the serving chain
    // unconditionally, but `resolveWorkerCaCertPath` does the opposite when
    // the SERVING file yields no loadable block — `daemonBlocks === undefined`
    // discards the operator CA and hands workers the serving file alone. Boot
    // therefore reported no gap while every worker handshake failed.
    const der = new X509Certificate(TEST_TLS_CERT_FULLCHAIN_LEAF_ONLY).raw;
    const gaps = describeWorkerTlsTrustGaps({
      cert: der,
      certPath: '/certs/daemon.der',
      daemonUrl,
      operatorCaCertPath: '/certs/rootCA.pem',
      operatorCaCert: Buffer.from(fullchainRootPem()),
    });
    expect(gaps).toHaveLength(2);
    expect(
      gaps.some(
        (gap) =>
          gap.includes('/certs/daemon.der') &&
          gap.includes('/certs/rootCA.pem') &&
          gap.includes('is discarded'),
      ),
    ).toBe(true);
    // The operator CA no longer anchors a chain the workers never receive.
    expect(
      gaps.some((gap) => gap.includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE')),
    ).toBe(true);
  });

  it('names the unloadable serving file with no operator CA set', () => {
    // R6-1: the no-operator twin of R4-3. The workers receive the serving file
    // as their whole bundle and their loader takes NOTHING from it, so gating
    // this gap on `operatorChain` reported zero gaps at boot while every
    // worker restart-looped UNABLE_TO_VERIFY_LEAF_SIGNATURE — the precise
    // failure mode this function exists to name.
    const der = new X509Certificate(TEST_TLS_CERT_FULLCHAIN_LEAF_ONLY).raw;
    const gaps = describeWorkerTlsTrustGaps({
      cert: der,
      certPath: '/certs/daemon.der',
      daemonUrl,
    });
    expect(
      gaps.some(
        (gap) =>
          gap.includes('/certs/daemon.der') &&
          gap.includes('takes nothing from'),
      ),
    ).toBe(true);
    // Without an operator CA there is nothing to call discarded.
    expect(gaps.some((gap) => gap.includes('is discarded'))).toBe(false);
  });

  it('does not blame the operator CA it discarded along with the serving file', () => {
    // R6-3: in the discard scenario the operator file failed to anchor only
    // because it was thrown away with the unloadable serving file — the gap
    // above already says so and carries the working remedy. Claiming its
    // contents "do not carry a certificate that anchors it" and sending the
    // operator to re-point NODE_EXTRA_CA_CERTS is false and a no-op here: the
    // variable already points at the issuing CA.
    const der = new X509Certificate(TEST_TLS_CERT_FULLCHAIN_LEAF_ONLY).raw;
    const gaps = describeWorkerTlsTrustGaps({
      cert: der,
      certPath: '/certs/daemon.der',
      daemonUrl,
      operatorCaCertPath: '/certs/rootCA.pem',
      operatorCaCert: Buffer.from(fullchainRootPem()),
    });
    // The discard gap names the same error code, so select the ANCHOR gap by
    // the claim under test.
    const anchorGap = gaps.find((gap) =>
      gap.includes('is issued by another CA'),
    );
    expect(anchorGap).toBeDefined();
    expect(anchorGap).not.toContain(
      'does not carry a certificate that anchors',
    );
    expect(anchorGap).toContain('discarded together with');
    expect(anchorGap).toContain(
      'NODE_EXTRA_CA_CERTS is not the file to change',
    );
    // Control: the very same operator file anchors whenever it is not
    // discarded, which is what makes the claim above false rather than unlucky.
    expect(
      describeWorkerTlsTrustGaps({
        cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_LEAF_ONLY),
        certPath: '/certs/daemon.pem',
        daemonUrl,
        operatorCaCertPath: '/certs/rootCA.pem',
        operatorCaCert: Buffer.from(fullchainRootPem()),
      }),
    ).toEqual([]);
  });

  it('names an unreadable operator CA as unreadable, not as empty', () => {
    // R6-4: a root-owned mode-600 CA file (certbot/mkcert defaults) holding
    // exactly the issuing CA used to be downgraded to "no contents", so the
    // operator was told the file "does not carry a certificate that anchors
    // it" and to point NODE_EXTRA_CA_CERTS at the issuing CA — an unknowable
    // content claim plus an action they had already taken. The real fix is
    // permissions.
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_LEAF_ONLY),
      certPath: '/certs/daemon.pem',
      daemonUrl,
      operatorCaCertPath: '/root/ca/rootCA.pem',
      operatorCaCertReadError: 'EACCES',
    });
    expect(
      gaps.some(
        (gap) =>
          gap.includes('could not be read by the daemon (EACCES)') &&
          gap.includes("Fix that file's permissions or path"),
      ),
    ).toBe(true);
    for (const gap of gaps) {
      expect(gap).not.toContain('does not carry a certificate that anchors');
      expect(gap).not.toContain('Point NODE_EXTRA_CA_CERTS at the issuing CA');
    }
  });

  it('does not predict an outage when a read error leaves the serving file anchoring itself', () => {
    // R7-2: `resolveWorkerCaCertPath`'s catch hands the workers the SERVING
    // file as their extra-CA store, so a fullchain (certbot/mkcert's normal
    // shape) anchors itself through it — the anchor walk in this very function
    // returns `anchored: true` — while this gap still announced a certain
    // "Every worker handshake ... will fail UNABLE_TO_VERIFY_LEAF_SIGNATURE".
    // The one test that set `operatorCaCertReadError` used a leaf-only serving
    // file, where the claim happens to hold.
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN),
      certPath: '/certs/daemon.pem',
      daemonUrl,
      operatorCaCertPath: '/root/ca/rootCA.pem',
      operatorCaCertReadError: 'EACCES',
    });
    // Control: the same serving file with no read error reports no gap at all,
    // which is what makes the outage claim false rather than merely unproven.
    expect(
      describeWorkerTlsTrustGaps({
        cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN),
        certPath: '/certs/daemon.pem',
        daemonUrl,
      }),
    ).toEqual([]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('could not be read by the daemon (EACCES)');
    expect(gaps[0]).toContain('carries an anchor of its own');
    expect(gaps[0]).toContain("Fix that file's permissions or path");
    expect(gaps[0]).not.toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    // The leaf-only serving file DOES lose its anchor with the same read
    // error, so the outage sentence has to survive there — this is a scoping
    // fix, not a deletion.
    expect(
      describeWorkerTlsTrustGaps({
        cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_LEAF_ONLY),
        certPath: '/certs/daemon.pem',
        daemonUrl,
        operatorCaCertPath: '/root/ca/rootCA.pem',
        operatorCaCertReadError: 'EACCES',
      }).some((gap) =>
        gap.includes(
          'Every worker handshake to the daemon will fail ' +
            'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        ),
      ),
    ).toBe(true);
  });

  it('does not promise an anchor the serving file cannot hand the workers', () => {
    // R23-9: when `--tls-cert` holds no block the workers' loader reads — a
    // self-signed leaf exported by `openssl x509 -trustout` — the
    // `servingBlocks === undefined` fallback forces the walk to treat the
    // leaf as held, so it returns `anchored: true` for a certificate the
    // workers never receive, and this branch told the operator the serving
    // file "carries an anchor of its own" and to fix the CA file's
    // permissions. Both claims are false in that state:
    // `resolveWorkerCaCertPath`'s read-error fallback hands workers that
    // unloadable file verbatim and their loader extracts nothing from it, so
    // every handshake fails (measured on Node v22.23.2, worker shape:
    // DEPTH_ZERO_SELF_SIGNED_CERT) and fixing the CA file changes nothing.
    const trustLabelled = TEST_TLS_CERT_SELF_SIGNED_NON_CA.replace(
      /^-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/,
      '-----BEGIN TRUSTED CERTIFICATE-----$1-----END TRUSTED CERTIFICATE-----',
    );
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(trustLabelled),
      certPath: '/certs/daemon.pem',
      daemonUrl,
      operatorCaCertPath: '/root/ca/rootCA.pem',
      operatorCaCertReadError: 'EACCES',
    });
    const readErrorGap = gaps.find((gap) =>
      gap.includes('could not be read by the daemon (EACCES)'),
    );
    expect(readErrorGap).toBeDefined();
    expect(readErrorGap).not.toContain('carries an anchor of its own');
    expect(readErrorGap).not.toContain("Fix that file's permissions or path");
    expect(readErrorGap).toContain('changes nothing');
    // The outage itself keeps being named by the sibling gap.
    expect(
      gaps.some(
        (gap) =>
          gap.includes('holds no PEM certificate block') &&
          gap.includes('Re-export --tls-cert as PEM'),
      ),
    ).toBe(true);
  });

  it('names a self-signed terminator refused for keyUsage, not for CA:FALSE', () => {
    // R7-1: `cannotIssueCertificates` refuses a terminator for three
    // independent reasons and this branch described only one. A CA:TRUE root
    // whose keyUsage omits keyCertSign was told it "carries basicConstraints
    // CA:FALSE" (false), that handshakes fail INVALID_PURPOSE (measured on
    // Node v22.23.0 / OpenSSL 3.0.13: "key usage does not include certificate
    // signing"), and to reissue with CA:TRUE — which it already is. Both
    // remedies were no-ops, so the operator loops reissue/restart.
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_NO_KEY_CERT_SIGN_ROOT),
      certPath: '/certs/daemon.pem',
      daemonUrl,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('CN=qwen CA-TRUE no-keyCertSign root');
    expect(gaps[0]).toContain('keyUsage does not include keyCertSign');
    expect(gaps[0]).toContain('key usage does not include certificate signing');
    expect(gaps[0]).toContain('keyCertSign in its keyUsage');
    // The three claims the old wording made about this certificate, each
    // false: it is CA:TRUE, the code is not INVALID_PURPOSE, and reissuing it
    // "with CA:TRUE" changes nothing.
    expect(gaps[0]).not.toContain('basicConstraints CA:FALSE');
    expect(gaps[0]).not.toContain('INVALID_PURPOSE');
    expect(gaps[0]).not.toContain('Reissue that certificate with CA:TRUE');
    // The CA:FALSE terminator keeps its own wording — the split must not
    // collapse both causes onto the keyUsage branch.
    const caFalseGaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_NON_CA_ROOT),
      certPath: '/certs/daemon.pem',
      daemonUrl,
    });
    expect(
      caFalseGaps.some(
        (gap) =>
          gap.includes('INVALID_PURPOSE') &&
          gap.includes('is not a CA') &&
          !gap.includes('keyCertSign'),
      ),
    ).toBe(true);
  });

  it('anchors the walk at the served leaf when its label hides it from the loader', () => {
    // R8-1: `servingBlocks[0]` was assumed to be the served leaf, but the
    // loader takes nothing from a `-----BEGIN TRUSTED CERTIFICATE-----` block
    // (what `openssl x509 -trustout` writes), so a `trusted leaf + plain root`
    // serving file yields `servingBlocks = [root]`. The walk then started at
    // the ROOT, at depth 0, where the leaf-depth exemption waives the
    // CA-capability check — so an incapable root was reported anchored with
    // zero gaps while every worker handshake failed. Boot stays green either
    // way: `X509Certificate` reads the trusted label and `createSecureContext`
    // serves the file.
    //
    // Measured on Node v22.23.0 / OpenSSL 3.0.13, worker shape (the serving
    // file as both the served chain and NODE_EXTRA_CA_CERTS): CA:FALSE root
    // fails INVALID_PURPOSE, CA:TRUE-without-keyCertSign root fails
    // "key usage does not include certificate signing", capable root
    // authorizes — and before the fix the diagnostic returned `[]` for all
    // three.
    const trustLabelLeaf = (pem: string): string =>
      pem.replace(
        /^-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/,
        '-----BEGIN TRUSTED CERTIFICATE-----$1-----END TRUSTED CERTIFICATE-----',
      );
    const caFalseGaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(trustLabelLeaf(TEST_TLS_CERT_FULLCHAIN_NON_CA_ROOT)),
      certPath: '/certs/daemon.pem',
      daemonUrl,
    });
    expect(caFalseGaps).toHaveLength(1);
    expect(caFalseGaps[0]).toContain('INVALID_PURPOSE');
    expect(caFalseGaps[0]).toContain('qwen non-CA test issuer');

    const keyUsageGaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(
        trustLabelLeaf(TEST_TLS_CERT_FULLCHAIN_NO_KEY_CERT_SIGN_ROOT),
      ),
      certPath: '/certs/daemon.pem',
      daemonUrl,
    });
    expect(keyUsageGaps).toHaveLength(1);
    expect(keyUsageGaps[0]).toContain('CN=qwen CA-TRUE no-keyCertSign root');
    expect(keyUsageGaps[0]).toContain('key usage does not include certificate');

    // The control that stops the widened walk from crying wolf: the same
    // label-hidden leaf over a CAPABLE root authorizes, so it must stay quiet.
    expect(
      describeWorkerTlsTrustGaps({
        cert: Buffer.from(trustLabelLeaf(TEST_TLS_CERT_FULLCHAIN)),
        certPath: '/certs/daemon.pem',
        daemonUrl,
      }),
    ).toEqual([]);
  });

  it('judges the leaf boot parsed, not the one a loose split matched first', () => {
    // R6-2: `parseCertChain`'s regex is unanchored, so an INDENTED leading
    // block — prose to `new X509Certificate` and to the workers' loader — was
    // picked as the leaf, and every leaf-dependent check judged a certificate
    // the daemon never serves. Measured: boot parses the clean block, the
    // daemon serves it, and the worker handshake fails
    // ERR_TLS_CERT_ALTNAME_INVALID while this reported no gap at all.
    // Only the BEGIN line is indented: that is what makes the block prose to
    // the column-0 readers while leaving the loose regex a parseable match.
    // Verified on this buffer — `new X509Certificate` returns the SECOND
    // certificate while the regex's first match is the decoy.
    const indentedDecoy = TEST_TLS_CERT.trim()
      .split('\n')
      .map((line, at) => (at === 0 ? `  ${line}` : line))
      .join('\n');
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(`${indentedDecoy}\n${TEST_TLS_CERT_NO_LOOPBACK_SAN}`),
      certPath: '/certs/daemon.pem',
      daemonUrl,
    });
    expect(
      gaps.some((gap) => gap.includes('ERR_TLS_CERT_ALTNAME_INVALID')),
    ).toBe(true);
  });

  it('names an intermediate whose keyUsage omits keyCertSign', () => {
    // R6-5: `checkIssued` enforces the ISSUER's keyUsage, so keying the issuer
    // SEARCH on it meant such an intermediate was never found and the walk
    // fell through to the generic unanchored gap — whose cause ("nothing in
    // the bundle anchors their trust"), predicted code and remedy are all
    // wrong here: the issuing chain IS in the bundle and no
    // NODE_EXTRA_CA_CERTS change can fix it.
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_NO_KEY_CERT_SIGN_INTERMEDIATE),
      certPath: '/certs/daemon.pem',
      daemonUrl,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('NoCertSign Intermediate');
    expect(gaps[0]).toContain('keyCertSign');
    expect(gaps[0]).not.toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(gaps[0]).not.toContain(
      'Point NODE_EXTRA_CA_CERTS at the issuing CA',
    );
  });

  it('names an intermediate whose extendedKeyUsage omits serverAuth', () => {
    // R23-29: `tlsServerPurposeDefect` judged the LEAF alone, but OpenSSL's
    // `check_purpose_ssl_server` applies the EKU test to every certificate
    // in the chain — a CA:TRUE keyCertSign intermediate carrying only
    // clientAuth walked to `anchored: true` and reported zero gaps while
    // every worker handshake failed INVALID_PURPOSE (see the fixture's
    // measurement note; `anyExtendedKeyUsage` does not rescue the chain
    // either).
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_CLIENT_EKU_CHAIN),
      certPath: '/certs/daemon.pem',
      daemonUrl,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('qwen client-eku intermediate');
    expect(gaps[0]).toContain('extendedKeyUsage does not include serverAuth');
    expect(gaps[0]).toContain('INVALID_PURPOSE');
    // The control: the same chain with a serverAuth-EKU intermediate
    // authorizes and must stay quiet.
    expect(
      describeWorkerTlsTrustGaps({
        cert: Buffer.from(TEST_TLS_CERT_SERVER_EKU_CHAIN),
        certPath: '/certs/daemon.pem',
        daemonUrl,
      }),
    ).toEqual([]);
  });

  it('names a chain that exceeds a CA pathLenConstraint', () => {
    // R6-6: the constraint sits unread inside the same basicConstraints value
    // the capability checks already extract, so this chain walked to
    // `anchored: true` with ZERO gaps while every worker handshake failed
    // PATH_LENGTH_EXCEEDED and restart-looped against a silent daemon log.
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_PATHLEN_0),
      certPath: '/certs/daemon.pem',
      daemonUrl,
      operatorCaCertPath: '/certs/rootCA.pem',
      operatorCaCert: Buffer.from(TEST_TLS_CERT_PATHLEN_0_ROOT),
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('PATH_LENGTH_EXCEEDED');
    expect(gaps[0]).toContain('pathlen:0');
    expect(gaps[0]).toContain('PathLen0 Root');
  });

  it('stays quiet for a chain sitting exactly at its CA pathLenConstraint', () => {
    // The control that keeps the constraint from crying wolf, and the one that
    // catches an off-by-one: the SAME `pathlen:0` root directly over the leaf
    // is a valid path — 0 intermediates below it, measured `authorized: true`.
    // A `>=` comparison reports this healthy chain as PATH_LENGTH_EXCEEDED.
    expect(
      describeWorkerTlsTrustGaps({
        cert: Buffer.from(TEST_TLS_CERT_PATHLEN_0_DIRECT_LEAF),
        certPath: '/certs/daemon.pem',
        daemonUrl,
        operatorCaCertPath: '/certs/rootCA.pem',
        operatorCaCert: Buffer.from(TEST_TLS_CERT_PATHLEN_0_ROOT),
      }),
    ).toEqual([]);
  });

  it('reports the self-signed leaf the workers never receive', () => {
    // R8-1: the fingerprint check upstream only decides whether to PREPEND
    // the boot-parsed leaf to the modeled worker store. Once prepended, a
    // SELF-SIGNED leaf self-anchored the walk at path length 1 — anchored
    // unconditionally, because the CA constraint is waived at leaf depth —
    // and boot reported zero gaps for a certificate the workers do not hold.
    //
    // A self-signed certificate verifies only when it is ITSELF in the trust
    // store, so this is the silent-green outage the diagnostic exists to
    // catch. Measured on Node v22.23.0 for exactly this shape (a self-signed
    // loopback leaf under `openssl x509 -trustout`'s TRUSTED CERTIFICATE
    // label, plus an unrelated plain root): `new X509Certificate` parses it
    // and `tls.createSecureContext` serves it, while a worker handshake with
    // the same file as NODE_EXTRA_CA_CERTS fails DEPTH_ZERO_SELF_SIGNED_CERT
    // with an EMPTY stderr — no warning anywhere.
    const trustLabelled = TEST_TLS_CERT_SELF_SIGNED_NON_CA.replace(
      /^-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/,
      '-----BEGIN TRUSTED CERTIFICATE-----$1-----END TRUSTED CERTIFICATE-----',
    );
    const unrelatedRoot = TEST_TLS_CERT_FULLCHAIN.slice(
      TEST_TLS_CERT_FULLCHAIN.indexOf('-----END CERTIFICATE-----\n') +
        '-----END CERTIFICATE-----\n'.length,
    );
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(`${trustLabelled}${unrelatedRoot}`),
      certPath: '/certs/daemon.pem',
      daemonUrl,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('DEPTH_ZERO_SELF_SIGNED_CERT');
    expect(gaps[0]).toContain('TRUSTED CERTIFICATE');
    // Not the wrong diagnosis: this leaf is self-signed, so the generic
    // unanchored message ("is issued by another CA") would send the operator
    // after a CA that does not exist.
    expect(gaps[0]).not.toContain('issued by another CA');
  });

  it('keeps trusting a self-signed leaf that carries CA:FALSE', () => {
    // The constraint binds only past the leaf: a CA:FALSE self-signed cert in
    // its OWN trust store is verified at depth 0 and handshakes fine
    // (measured on Node 22), so requiring CA:TRUE here would cry wolf on the
    // ordinary `openssl req -x509` daemon cert.
    expect(
      describeWorkerTlsTrustGaps({
        cert: Buffer.from(TEST_TLS_CERT_SELF_SIGNED_NON_CA),
        certPath: '/certs/self-signed.pem',
        daemonUrl,
      }),
    ).toEqual([]);
  });

  it('defers to the boot parse guard on an unreadable certificate', () => {
    expect(
      describeWorkerTlsTrustGaps({
        cert: Buffer.from('not a certificate'),
        certPath: '/certs/daemon.pem',
        daemonUrl,
      }),
    ).toEqual([]);
  });

  it('keeps trusting a v1 root that carries no basicConstraints at all', () => {
    // R3-8: `X509Certificate.ca` is false both for an explicit CA:FALSE and
    // for a v1/no-extension root, but OpenSSL accepts the second as an issuer.
    // Measured on Node 22 / OpenSSL 3 with this exact pair: serving the leaf
    // with the v1 root as the trust store handshakes authorized=true, so the
    // INVALID_PURPOSE warning here would send the operator to reissue a CA
    // that already works.
    expect(
      describeWorkerTlsTrustGaps({
        cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_V1_ROOT),
        certPath: '/certs/daemon.pem',
        daemonUrl,
      }),
    ).toEqual([]);
  });

  it("names an operator CA file Node's loader cannot read", () => {
    // R3-2: the boot diagnostic used a looser parser than the spawn-time
    // merge. `cat a.pem b.pem` with no trailing newline in a.pem fuses the
    // markers onto one line: the loose regex still sees a CA and judged the
    // chain anchored, while the merge discarded the file and handed workers
    // the daemon cert alone — daemon log clean, every worker handshake failing
    // UNABLE_TO_VERIFY_LEAF_SIGNATURE.
    const root = fullchainRootPem();
    const fused = `${root.trimEnd()}${root}`;
    expect(fused).toContain(
      '-----END CERTIFICATE----------BEGIN CERTIFICATE-----',
    );
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_LEAF_ONLY),
      certPath: '/certs/daemon.pem',
      daemonUrl,
      operatorCaCertPath: '/certs/fused.pem',
      operatorCaCert: Buffer.from(fused),
    });
    // R4-7: `.some()` alone lets a mutant that pushes the unanchored gap twice
    // through, duplicating warnings in the log this diagnostic exists to keep
    // readable. Every single-gap sibling here pins the count; so do these.
    expect(gaps).toHaveLength(2);
    expect(gaps.some((gap) => gap.includes('/certs/fused.pem'))).toBe(true);
    expect(
      gaps.some((gap) =>
        gap.includes("holds no PEM certificate block Node's loader can read"),
      ),
    ).toBe(true);
    // And it no longer counts as an anchor.
    expect(
      gaps.some((gap) => gap.includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE')),
    ).toBe(true);
  });

  it('does not count a DER operator CA file as an anchor', () => {
    // R3-2(b): NODE_EXTRA_CA_CERTS is PEM-only — Node never loads a DER file
    // and says nothing about it — but the boot side used to fall back to a DER
    // parse and count it as an anchoring CA.
    const der = new X509Certificate(fullchainRootPem()).raw;
    const gaps = describeWorkerTlsTrustGaps({
      cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_LEAF_ONLY),
      certPath: '/certs/daemon.pem',
      daemonUrl,
      operatorCaCertPath: '/certs/root.der',
      operatorCaCert: der,
    });
    // R4-7: gating the unreadable-file message on a `-----BEGIN` marker being
    // present drops the DER diagnosis (DER has no markers) while the generic
    // anchor gap still satisfies a bare `.some()` — the operator is then told
    // the file 'does not carry a certificate that anchors it' instead of being
    // told to re-export it as PEM. Pin the count and the DER-specific text.
    expect(gaps).toHaveLength(2);
    expect(gaps.some((gap) => gap.includes('/certs/root.der'))).toBe(true);
    expect(
      gaps.some((gap) => gap.includes('a DER file is never read at all')),
    ).toBe(true);
    expect(
      gaps.some((gap) => gap.includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE')),
    ).toBe(true);
  });

  it('still anchors on a CRLF-terminated operator CA file', () => {
    // R3-1(strict arm): Node's loader accepts CRLF PEM (measured), so a
    // vendor-exported CRLF bundle must not be reported as unreadable.
    expect(
      describeWorkerTlsTrustGaps({
        cert: Buffer.from(TEST_TLS_CERT_FULLCHAIN_LEAF_ONLY),
        certPath: '/certs/daemon.pem',
        daemonUrl,
        operatorCaCertPath: '/certs/rootCA.pem',
        operatorCaCert: Buffer.from(fullchainRootPem().replace(/\n/g, '\r\n')),
      }),
    ).toEqual([]);
  });
});

/**
 * Wenshao review #4335 / 3272493818 — positive tests for the
 * `validatePolicyConfig` helper. Lock the contract so a future
 * refactor can't silently remove the `InvalidPolicyConfigError`
 * class or the validation paths.
 */
describe('validatePolicyConfig (#4335 boot validation)', () => {
  it('returns undefined for both fields when policyConfig is empty', () => {
    expect(validatePolicyConfig()).toEqual({
      permissionPolicy: undefined,
      permissionConsensusQuorum: undefined,
    });
    expect(validatePolicyConfig({})).toEqual({
      permissionPolicy: undefined,
      permissionConsensusQuorum: undefined,
    });
  });

  it.each([['first-responder'], ['designated'], ['consensus'], ['local-only']])(
    'accepts the %s permissionStrategy literal',
    (literal) => {
      expect(validatePolicyConfig({ permissionStrategy: literal })).toEqual({
        permissionPolicy: literal,
        permissionConsensusQuorum: undefined,
      });
    },
  );

  it('throws InvalidPolicyConfigError for an unknown permissionStrategy', () => {
    expect(() => validatePolicyConfig({ permissionStrategy: 'bogus' })).toThrow(
      InvalidPolicyConfigError,
    );
    expect(() => validatePolicyConfig({ permissionStrategy: 'bogus' })).toThrow(
      /invalid policy.permissionStrategy/,
    );
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'throws InvalidPolicyConfigError for non-positive-integer consensusQuorum (%s)',
    (badValue) => {
      expect(() =>
        validatePolicyConfig({
          permissionStrategy: 'consensus',
          consensusQuorum: badValue,
        }),
      ).toThrow(InvalidPolicyConfigError);
    },
  );

  it('accepts a positive-integer consensusQuorum with consensus strategy', () => {
    expect(
      validatePolicyConfig({
        permissionStrategy: 'consensus',
        consensusQuorum: 3,
      }),
    ).toEqual({
      permissionPolicy: 'consensus',
      permissionConsensusQuorum: 3,
    });
  });

  it('warns AND drops consensusQuorum when strategy is not consensus (#4335 / 3273077270)', () => {
    // Wenshao review #4335 / 3273077270 — public contract now
    // matches the warning text: when the operator sets
    // consensusQuorum alongside a non-consensus strategy, the
    // override is dropped (returned as undefined) so the
    // BridgeOptions surface stays consistent with what the warning
    // tells them. Pre-fix the function still propagated the value;
    // the downstream mediator ignored it but the function-level
    // contract contradicted itself.
    const warnings: string[] = [];
    const onWarning = vi.fn((m: string) => warnings.push(m));
    const result = validatePolicyConfig(
      {
        permissionStrategy: 'designated',
        consensusQuorum: 2,
      },
      onWarning,
    );
    expect(result).toEqual({
      permissionPolicy: 'designated',
      permissionConsensusQuorum: undefined,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('consensusQuorum is set');
    expect(warnings[0]).toContain('not "consensus"');
  });

  it('does not warn when consensusQuorum is set with consensus strategy', () => {
    const onWarning = vi.fn();
    validatePolicyConfig(
      { permissionStrategy: 'consensus', consensusQuorum: 2 },
      onWarning,
    );
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('error messages name the field that failed (operator-debugging signal)', () => {
    expect(() => validatePolicyConfig({ permissionStrategy: 'oops' })).toThrow(
      /permissionStrategy/,
    );
    expect(() => validatePolicyConfig({ consensusQuorum: 0 })).toThrow(
      /consensusQuorum/,
    );
  });
});

/**
 * Integration test: verify daemon logger is initialized and written to
 * during `runQwenServe` boot + shutdown. Uses a fake bridge to avoid
 * spawning real `qwen --acp` child processes.
 */
describe('runQwenServe daemon logger wiring', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates a daemon log file at boot and flushes on shutdown', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-dl-')));
    const workspace = tmpDir;
    const debugDir = path.join(tmpDir, 'debug');

    // Minimal fake bridge satisfying the shape runQwenServe expects.
    const fakeBridge: HttpAcpBridge = {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
      getSession: vi.fn(),
      getAllSessions: vi.fn().mockReturnValue([]),
      publishWorkspaceEvent: vi.fn(),
      getEventRing: vi.fn().mockReturnValue({ getAll: () => [] }),
      resume: vi.fn(),
      preheat: vi.fn().mockResolvedValue(undefined),
    } as unknown as HttpAcpBridge;

    // Point daemon logger at our temp debug dir
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    const originalScope = process.env['QWEN_CODE_MEMORY_PROJECT_SCOPE'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    delete process.env['QWEN_CODE_MEMORY_PROJECT_SCOPE'];

    try {
      const handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace,
          maxSessions: 1,
        },
        { bridge: fakeBridge },
      );

      // Daemon log directory should exist
      const daemonDir = path.join(debugDir, 'daemon');
      expect(fs.existsSync(daemonDir)).toBe(true);

      // Find the stable daemon log file.
      const logFiles = fs
        .readdirSync(daemonDir)
        .filter((f) => f.endsWith('.log'));
      expect(logFiles).toContain('daemon.log');

      const logContent = fs.readFileSync(
        path.join(daemonDir, 'daemon.log'),
        'utf8',
      );
      // Should contain the "daemon started" boot line
      expect(logContent).toContain('daemon started');
      expect(logContent).toContain(`pid=${process.pid}`);
      expect(logContent).toContain(
        `workspace=${fs.realpathSync.native(workspace)}`,
      );
      expect(logContent).toContain('project memory scope resolved');
      expect(logContent).toContain('projectMemoryScope=workspace');
      expect(logContent).toContain('projectMemoryScopeSource=default');
      expect(logContent).toContain('projectMemoryScopeRaw=workspace');

      await Promise.all(
        Array.from({ length: 70 }, (_, index) =>
          fetch(`${handle.url}/missing-${index}`),
        ),
      );

      // Close the handle (graceful shutdown)
      await handle.close();

      // close() is intentionally bounded, so the file finalizer may still be
      // draining when it returns under a slow filesystem.
      const logPath = path.join(daemonDir, 'daemon.log');
      let finalContent = '';
      await vi.waitFor(
        () => {
          finalContent = fs.readFileSync(logPath, 'utf8');
          expect(finalContent).toContain('access logs suppressed');
          expect(finalContent).toContain('daemon stopped');
        },
        { timeout: 7_000, interval: 50 },
      );
      expect(finalContent).toContain('daemon started');
      const suppressedIndex = finalContent.indexOf('access logs suppressed');
      const stoppedIndex = finalContent.indexOf('daemon stopped');
      expect(suppressedIndex).toBeGreaterThanOrEqual(0);
      expect(stoppedIndex).toBeGreaterThan(suppressedIndex);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
      if (originalScope === undefined) {
        delete process.env['QWEN_CODE_MEMORY_PROJECT_SCOPE'];
      } else {
        process.env['QWEN_CODE_MEMORY_PROJECT_SCOPE'] = originalScope;
      }
    }
  }, 10_000);
});

describe('runQwenServe telemetry validation', () => {
  let tmpDir: string;
  const originalSensitiveSpanAttributeMaxLengthEnv =
    process.env['QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH'];

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalSensitiveSpanAttributeMaxLengthEnv === undefined) {
      delete process.env['QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH'];
    } else {
      process.env['QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH'] =
        originalSensitiveSpanAttributeMaxLengthEnv;
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('wraps invalid daemon telemetry configuration as FatalConfigError', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tv-')));
    process.env['QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH'] = '';

    const run = runQwenServe({
      port: 0,
      hostname: '127.0.0.1',
      mode: 'http-bridge',
      workspace: tmpDir,
      maxSessions: 1,
    });

    await expect(run).rejects.toThrow(qwenCore.FatalConfigError);
    await expect(run).rejects.toThrow(/Invalid telemetry configuration:/);
  });

  it('accepts multiple explicit workspace inputs and advertises workspaces', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-ws-')));
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const shutdownResolvers: Array<() => void> = [];
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => {
        const bridge = makeRuntimeBridge();
        bridge.shutdown = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              shutdownResolvers.push(resolve);
            }),
        );
        return bridge;
      });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, secondary],
        maxSessions: 1,
        sessionRestoreTimeoutMs: 90_000,
        serveWebShell: false,
      },
      {
        preheatBridge: false,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );
    let closing: Promise<void> | undefined;
    try {
      const res = await fetch(`${handle.url}/capabilities`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        workspaceCwd: string;
        features: string[];
        workspaces: Array<{
          cwd: string;
          primary: boolean;
          removable?: boolean;
        }>;
        limits: {
          maxTotalSessions: number | null;
          sessionRestoreTimeoutMs: number;
        };
      };
      expect(body.workspaceCwd).toBe(canonicalizeWorkspace(primary));
      expect(body.features).toContain('multi_workspace_sessions');
      expect(body.features).toContain('workspace_runtime_removal');
      expect(body.features).toContain('scheduled_task_session_reuse');
      expect(body.limits.maxTotalSessions).toBe(2);
      expect(body.limits.sessionRestoreTimeoutMs).toBe(90_000);
      expect(body.workspaces).toEqual([
        expect.objectContaining({
          cwd: canonicalizeWorkspace(primary),
          primary: true,
          removable: false,
        }),
        expect.objectContaining({
          cwd: canonicalizeWorkspace(secondary),
          primary: false,
          removable: false,
        }),
      ]);

      for (const [
        index,
        [bridgeOptions],
      ] of createBridge.mock.calls.entries()) {
        expect(bridgeOptions.onCreateCurrentSessionScheduledTask).toBeTypeOf(
          'function',
        );
        const target = path.join(
          tmpDir,
          `static-runtime-external-${index}.txt`,
        );
        await bridgeOptions.fileSystem!.writeText({
          path: target,
          content: `runtime-${index}`,
          sessionId: `session-static-${index}`,
          _meta: {
            'qwen-code/tool-write-origin': {
              version: 1,
              source: 'write_file',
            },
          },
        });
        expect(fs.readFileSync(target, 'utf8')).toBe(`runtime-${index}`);
      }

      closing = handle.close();
      await vi.waitFor(() => expect(shutdownResolvers).toHaveLength(2));
    } finally {
      closing ??= handle.close();
      await vi.waitFor(() => expect(shutdownResolvers).toHaveLength(2));
      for (const resolve of shutdownResolvers) resolve();
      await closing;
    }
    expect(createBridge).toHaveBeenCalledTimes(2);
    for (const [options] of createBridge.mock.calls) {
      expect(options).toMatchObject({
        delegateReadTextFileToClient: false,
        sessionRestoreTimeoutMs: 90_000,
      });
    }
    for (const result of createBridge.mock.results) {
      expect(result.value.shutdown).toHaveBeenCalledWith({
        reason: 'daemon_shutdown',
      });
    }
  });

  it('keeps external built-in writes disabled for an injected primary filesystem factory', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-injected-fs-')),
    );
    const workspace = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspace);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => makeRuntimeBridge());
    const boundaryError = Object.assign(new Error('outside workspace'), {
      kind: 'path_outside_workspace',
    });
    const writeSameHostToolText = vi.fn(async () => undefined);
    const fsFactory = {
      assertCanWrite: vi.fn(),
      writeSameHostToolText,
      forRequest: () =>
        ({
          resolve: vi.fn(async () => {
            throw boundaryError;
          }),
        }) as never,
    } satisfies WorkspaceFileSystemFactory;

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace,
        serveWebShell: false,
      },
      {
        preheatBridge: false,
        trustedWorkspace: true,
        fsFactory,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );
    try {
      await expect(
        createBridge.mock.calls[0]?.[0].fileSystem!.writeText({
          path: path.join(tmpDir, 'outside.txt'),
          content: 'must-not-write',
          sessionId: 'session-injected-primary',
          _meta: {
            'qwen-code/tool-write-origin': {
              version: 1,
              source: 'write_file',
            },
          },
        }),
      ).rejects.toBe(boundaryError);
      expect(writeSameHostToolText).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('invalidates primary voice capabilities when its workspace service publishes settings changes', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-voice-capability-')),
    );
    const workspace = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspace);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() =>
      makeRuntimeBridge(),
    );
    const originalCreateWorkspaceService =
      workspaceServiceRuntime.createDaemonWorkspaceService;
    let publishWorkspaceEvent:
      | Parameters<
          typeof workspaceServiceRuntime.createDaemonWorkspaceService
        >[0]['publishWorkspaceEvent']
      | undefined;
    vi.spyOn(
      workspaceServiceRuntime,
      'createDaemonWorkspaceService',
    ).mockImplementation((deps) => {
      if (deps.boundWorkspace === canonicalizeWorkspace(workspace)) {
        publishWorkspaceEvent = deps.publishWorkspaceEvent;
      }
      return originalCreateWorkspaceService(deps);
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace,
        serveWebShell: false,
      },
      {
        preheatBridge: false,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );
    try {
      const before = (await (
        await fetch(`${handle.url}/capabilities`)
      ).json()) as { features: string[] };
      expect(before.features).not.toContain('workspace_voice_transcription');

      fs.mkdirSync(path.join(workspace, '.qwen'));
      fs.writeFileSync(
        path.join(workspace, '.qwen', 'settings.json'),
        JSON.stringify({
          modelProviders: {
            openai: [
              {
                id: 'qwen3-asr-flash',
                baseUrl: 'http://127.0.0.1:65535/v1',
              },
            ],
          },
        }),
        'utf8',
      );
      expect(publishWorkspaceEvent).toBeTypeOf('function');
      publishWorkspaceEvent?.({ type: 'settings_changed', data: {} });

      const after = (await (
        await fetch(`${handle.url}/capabilities`)
      ).json()) as { features: string[] };
      expect(after.features).toContain('workspace_voice_transcription');
    } finally {
      await handle.close();
    }
  });

  it('adds, advertises, and hot-removes a dynamic workspace runtime', async () => {
    mockCreateSpawnChannelFactoryOptions.length = 0;
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-hot-remove-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const secondaryCwd = canonicalizeWorkspace(secondary);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockImplementation(
      (workspace) =>
        ({
          merged:
            typeof workspace === 'string' &&
            canonicalizeWorkspace(workspace) === secondaryCwd
              ? {
                  policy: {
                    permissionStrategy: 'consensus',
                    consensusQuorum: 2,
                  },
                }
              : {},
        }) as ReturnType<typeof settingsRuntime.loadSettings>,
    );
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => makeRuntimeBridge());
    const removeByIds = vi.fn().mockResolvedValue(1);
    const store = {
      read: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        primaryWorkspace: canonicalizeWorkspace(primary),
        workspaces: [],
      }),
      add: vi.fn().mockResolvedValue(true),
      removeByIds,
    } as unknown as WorkspaceRegistrationStore;
    // The growth-parity assertions below derive the budget from host
    // memory; pin the figure so a small or cgroup-constrained runner
    // cannot flip this test red.
    mockTotalMemBytes.value = 8 * 1024 * 1024 * 1024;
    const constrainedSpy = vi
      .spyOn(
        process as { constrainedMemory: () => number },
        'constrainedMemory',
      )
      .mockReturnValue(0);
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: primary,
        token: 'hot-remove-token',
        sessionRestoreTimeoutMs: 90_000,
        serveWebShell: false,
      },
      {
        preheatBridge: false,
        bootSettings: { policy: { permissionStrategy: 'local-only' } },
        workspaceRegistrationStore: store,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );
    const headers = {
      Authorization: 'Bearer hot-remove-token',
      'Content-Type': 'application/json',
    };

    try {
      // Shift the host-memory pin between the two derivation points: the
      // boot bridge derived its pool from the 8 GiB pin above. A dynamic
      // attach that RE-DERIVED the budget would now see 16 GiB and build a
      // different pool, failing the parity assertion below; the correct
      // boot-closure implementation never re-reads host memory.
      mockTotalMemBytes.value = 16 * 1024 * 1024 * 1024;
      const added = await fetch(`${handle.url}/workspaces`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ cwd: secondary, persist: true }),
      });
      expect(added.status).toBe(201);
      expect(mockCreateSpawnChannelFactoryOptions).toHaveLength(2);
      for (const options of mockCreateSpawnChannelFactoryOptions) {
        expect(options['pipeLimits']).toEqual({
          maxFrameBytes: 64 * 1024 * 1024,
          maxQueuedMessages: 256,
          maxQueuedBytes: 64 * 1024 * 1024,
        });
      }
      expect(createBridge.mock.calls[0]?.[0].onChannelDelivery).toBeTypeOf(
        'function',
      );
      expect(createBridge.mock.calls[1]?.[0].onChannelDelivery).toBeTypeOf(
        'function',
      );
      expect(
        createBridge.mock.calls[0]?.[0].onCreateCurrentSessionScheduledTask,
      ).toBeTypeOf('function');
      expect(
        createBridge.mock.calls[1]?.[0].onCreateCurrentSessionScheduledTask,
      ).toBeTypeOf('function');
      expect(createBridge.mock.calls[1]?.[0]).toMatchObject({
        permissionPolicy: 'local-only',
        sessionRestoreTimeoutMs: 90_000,
      });
      // The dynamically attached workspace's bridge must carry the same
      // adaptive-growth pool as the boot bridge — the budget here is
      // host-derived, so assert parity, not a fixed figure.
      expect(createBridge.mock.calls[1]?.[0].journalGrowthPoolBytes).toEqual(
        expect.any(Number),
      );
      expect(createBridge.mock.calls[1]?.[0].journalGrowthPoolBytes).toBe(
        createBridge.mock.calls[0]?.[0].journalGrowthPoolBytes,
      );
      // The dynamically attached workspace must share the ONE aggregate
      // view and registrar, not a fresh per-runtime copy. Assert the
      // hooks exist first: `undefined === undefined` would pass the
      // identity checks if a regression unwired the pool from BOTH
      // bridges at once.
      expect(
        createBridge.mock.calls[0]?.[0].journalGrowthSessionLimits,
      ).toBeTypeOf('function');
      expect(createBridge.mock.calls[1]?.[0].journalGrowthSessionLimits).toBe(
        createBridge.mock.calls[0]?.[0].journalGrowthSessionLimits,
      );
      expect(
        createBridge.mock.calls[0]?.[0].registerJournalGrowthSessionLimits,
      ).toBeTypeOf('function');
      expect(
        createBridge.mock.calls[1]?.[0].registerJournalGrowthSessionLimits,
      ).toBe(
        createBridge.mock.calls[0]?.[0].registerJournalGrowthSessionLimits,
      );
      expect(createBridge.mock.calls[1]?.[0]).not.toHaveProperty(
        'permissionConsensusQuorum',
      );
      const firstDynamicFileSystem = createBridge.mock.calls[1]?.[0].fileSystem;
      const firstDynamicTarget = path.join(
        tmpDir,
        'dynamic-runtime-external.txt',
      );
      await firstDynamicFileSystem!.writeText({
        path: firstDynamicTarget,
        content: 'first-generation',
        sessionId: 'session-dynamic-first',
        _meta: {
          'qwen-code/tool-write-origin': {
            version: 1,
            source: 'write_file',
          },
        },
      });
      expect(fs.readFileSync(firstDynamicTarget, 'utf8')).toBe(
        'first-generation',
      );

      const before = (await (
        await fetch(`${handle.url}/capabilities`, { headers })
      ).json()) as {
        features: string[];
        workspaces: Array<{
          id: string;
          cwd: string;
          removable?: boolean;
        }>;
      };
      expect(before.features).toContain('workspace_runtime_removal');
      const removable = before.workspaces.find(
        (workspace) => workspace.cwd === canonicalizeWorkspace(secondary),
      );
      expect(removable).toMatchObject({ removable: true });

      const removed = await fetch(
        `${handle.url}/workspaces/${encodeURIComponent(removable!.id)}`,
        {
          method: 'DELETE',
          headers,
          body: JSON.stringify({ force: true }),
        },
      );
      expect(removed.status).toBe(200);
      await expect(removed.json()).resolves.toMatchObject({
        removed: true,
        workspaceId: removable!.id,
        persistedRegistrationRemoved: true,
      });
      expect(removeByIds).toHaveBeenCalledWith(
        expect.arrayContaining([
          workspaceRegistrationId(canonicalizeWorkspace(secondary)),
        ]),
      );
      const dynamicBridge = createBridge.mock.results[1]?.value;
      expect(dynamicBridge?.shutdown).toHaveBeenCalledWith({
        reason: 'workspace_removed',
      });
      await expect(
        firstDynamicFileSystem!.writeText({
          path: path.join(tmpDir, 'closed-dynamic-generation.txt'),
          content: 'must-not-write',
          sessionId: 'session-dynamic-closed',
          _meta: {
            'qwen-code/tool-write-origin': {
              version: 1,
              source: 'write_file',
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'workspace_generation_closed' });

      const afterResponse = await fetch(`${handle.url}/capabilities`, {
        headers,
      });
      expect(afterResponse.status).toBe(200);
      const after = (await afterResponse.json()) as {
        workspaces?: Array<{ id: string }>;
      };
      expect(
        (after.workspaces ?? []).some(
          (workspace) => workspace.id === removable!.id,
        ),
      ).toBe(false);

      const readded = await fetch(`${handle.url}/workspaces`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ cwd: secondary, persist: true }),
      });
      expect(readded.status).toBe(201);
      expect(createBridge).toHaveBeenCalledTimes(3);
      const secondDynamicTarget = path.join(
        tmpDir,
        'dynamic-runtime-readded.txt',
      );
      await createBridge.mock.calls[2]?.[0].fileSystem!.writeText({
        path: secondDynamicTarget,
        content: 'second-generation',
        sessionId: 'session-dynamic-second',
        _meta: {
          'qwen-code/tool-write-origin': {
            version: 1,
            source: 'write_file',
          },
        },
      });
      expect(fs.readFileSync(secondDynamicTarget, 'utf8')).toBe(
        'second-generation',
      );
      for (const [options] of createBridge.mock.calls) {
        expect(options).toMatchObject({
          delegateReadTextFileToClient: false,
          sessionRestoreTimeoutMs: 90_000,
        });
      }
      let releaseRemoval!: (count: number) => void;
      removeByIds.mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            releaseRemoval = resolve;
          }),
      );
      const pendingRemoval = fetch(
        `${handle.url}/workspaces/${encodeURIComponent(removable!.id)}`,
        {
          method: 'DELETE',
          headers,
          body: JSON.stringify({ force: true }),
        },
      );
      await vi.waitFor(() => expect(removeByIds).toHaveBeenCalledTimes(2));
      let closeSettled = false;
      const closing = handle.close().then(() => {
        closeSettled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(closeSettled).toBe(false);

      releaseRemoval(1);
      expect((await pendingRemoval).status).toBe(200);
      await closing;
      expect(closeSettled).toBe(true);
    } finally {
      constrainedSpy.mockRestore();
      mockTotalMemBytes.value = undefined;
      await handle.close();
    }
  });

  it('kills a half-built dynamic bridge when async construction cleanup fails', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-failure-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: {},
    } as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);

    const primaryBridge = makeRuntimeBridge();
    const failedBridge = makeRuntimeBridge();
    vi.mocked(failedBridge.shutdown).mockRejectedValue(
      new Error('async cleanup failed'),
    );
    vi.spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValueOnce(
        primaryBridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      )
      .mockReturnValueOnce(
        failedBridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );
    const originalCreateWorkspaceService =
      workspaceServiceRuntime.createDaemonWorkspaceService;
    const createWorkspaceService = vi.spyOn(
      workspaceServiceRuntime,
      'createDaemonWorkspaceService',
    );
    createWorkspaceService
      .mockImplementationOnce(originalCreateWorkspaceService)
      .mockImplementationOnce(() => {
        throw new Error('workspace service construction failed');
      });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: primary,
        token: 'runtime-failure-token',
        serveWebShell: false,
      },
      {
        preheatBridge: false,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );

    try {
      const response = await fetch(`${handle.url}/workspaces`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer runtime-failure-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cwd: secondary }),
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        code: 'runtime_creation_failed',
      });
      expect(failedBridge.shutdown).toHaveBeenCalledWith();
      expect(failedBridge.killAllSync).toHaveBeenCalledOnce();
      expect(primaryBridge.shutdown).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('uses the daemon-wide policy and limits when constructing workspace bridges', async () => {
    mockCreateSpawnChannelFactoryOptions.length = 0;
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-ws-')));
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const secondaryCwd = canonicalizeWorkspace(secondary);
    const primaryBridge = makeRuntimeBridge();
    const secondaryBridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValueOnce(
        primaryBridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      )
      .mockReturnValueOnce(
        secondaryBridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );
    const resolveBridgeFsFactory = vi.spyOn(
      serverModule,
      'resolveBridgeFsFactory',
    );
    const createWorkspaceService = vi.spyOn(
      workspaceServiceRuntime,
      'createDaemonWorkspaceService',
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockImplementation(
      (workspace) => {
        const workspaceCwd =
          typeof workspace === 'string' ? canonicalizeWorkspace(workspace) : '';
        return {
          merged:
            workspaceCwd === secondaryCwd
              ? {
                  policy: {
                    permissionStrategy: 'consensus',
                    consensusQuorum: 2,
                  },
                  context: {
                    fileName: 'SECONDARY.md',
                    fileFiltering: {
                      customIgnoreFiles: ['.secondaryignore'],
                    },
                  },
                }
              : {},
        } as unknown as ReturnType<typeof settingsRuntime.loadSettings>;
      },
    );
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, secondary],
        maxSessions: 1,
        eventRingSize: 1234,
        compactedReplayMaxBytes: 1024,
        sessionRestoreTimeoutMs: 90_000,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        bootSettings: { policy: { permissionStrategy: 'local-only' } },
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );
    try {
      await handle.runtimeReady;
      expect(createBridge).toHaveBeenCalledTimes(2);
      expect(mockCreateSpawnChannelFactoryOptions).toHaveLength(2);
      for (const options of mockCreateSpawnChannelFactoryOptions) {
        expect(options['pipeLimits']).toEqual({
          maxFrameBytes: 64 * 1024 * 1024,
          maxQueuedMessages: 256,
          maxQueuedBytes: 64 * 1024 * 1024,
        });
      }
      expect(createBridge.mock.calls[0]?.[0]).toMatchObject({
        compactedReplayMaxBytes: 1024,
        eventRingSize: 1234,
        sessionRestoreTimeoutMs: 90_000,
        permissionPolicy: 'local-only',
        onChannelDelivery: expect.any(Function),
      });
      expect(createBridge.mock.calls[1]?.[0]).toMatchObject({
        compactedReplayMaxBytes: 1024,
        eventRingSize: 1234,
        sessionRestoreTimeoutMs: 90_000,
        permissionPolicy: 'local-only',
        onChannelDelivery: expect.any(Function),
      });
      expect(createBridge.mock.calls[1]?.[0]).not.toHaveProperty(
        'permissionConsensusQuorum',
      );
      expect(
        resolveBridgeFsFactory.mock.calls.find(
          ([input]) =>
            input.boundWorkspaces.length === 1 &&
            input.boundWorkspaces[0] === secondaryCwd,
        )?.[0],
      ).toMatchObject({ customIgnoreFiles: ['.secondaryignore'] });
      expect(
        createWorkspaceService.mock.calls.find(
          ([input]) => input.boundWorkspace === secondaryCwd,
        )?.[0],
      ).toMatchObject({ contextFilename: 'SECONDARY.md' });
      // bootSettings above carries no `context.fileName`, so the primary
      // workspace must land on the hard-coded `QWEN.md` init default
      // (`contextFilenameForInit ?? 'QWEN.md'`). Without this assertion the
      // fallback literal could be swapped without any test noticing.
      expect(
        createWorkspaceService.mock.calls.find(
          ([input]) => input.boundWorkspace === canonicalizeWorkspace(primary),
        )?.[0],
      ).toMatchObject({ contextFilename: 'QWEN.md' });
    } finally {
      await handle.close();
    }
  });

  it('does not validate policy settings for untrusted secondary workspaces', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-ws-')));
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const secondaryCwd = canonicalizeWorkspace(secondary);
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValueOnce(
        makeRuntimeBridge() as ReturnType<
          typeof acpBridge.createAcpSessionBridge
        >,
      )
      .mockReturnValueOnce(
        makeRuntimeBridge() as ReturnType<
          typeof acpBridge.createAcpSessionBridge
        >,
      );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockImplementation(
      (workspace) => {
        const workspaceCwd =
          typeof workspace === 'string' ? canonicalizeWorkspace(workspace) : '';
        return {
          merged:
            workspaceCwd === secondaryCwd
              ? { policy: { permissionStrategy: 'bogus' } }
              : {},
        } as unknown as ReturnType<typeof settingsRuntime.loadSettings>;
      },
    );
    vi.spyOn(
      trustedFoldersRuntime,
      'getWorkspaceTrustStatus',
    ).mockImplementation(
      (_settings, workspace) =>
        ({
          effective: {
            state:
              canonicalizeWorkspace(workspace) === secondaryCwd
                ? 'untrusted'
                : 'trusted',
          },
        }) as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>,
    );
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, secondary],
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        bootSettings: { policy: { permissionStrategy: 'local-only' } },
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );
    try {
      await expect(handle.runtimeReady).resolves.toBeUndefined();
      expect(createBridge).toHaveBeenCalledTimes(2);
      expect(createBridge.mock.calls[1]?.[0]).toMatchObject({
        permissionPolicy: 'local-only',
      });
    } finally {
      await handle.close();
    }
  });

  it('accepts a single workspace array input as the primary workspace', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-ws-')));
    const primary = path.join(tmpDir, 'primary');
    fs.mkdirSync(primary);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary],
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge: makeRuntimeBridge(),
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );
    try {
      const res = await fetch(`${handle.url}/capabilities`);
      expect(res.status).toBe(200);
      expect((await res.json()) as { workspaceCwd: string }).toMatchObject({
        workspaceCwd: canonicalizeWorkspace(primary),
      });
    } finally {
      await handle.close();
    }
  });

  it('uses a daemon-scoped telemetry service instance id', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tv-')));
    const initializeTelemetry = vi
      .spyOn(qwenCore, 'initializeTelemetry')
      .mockResolvedValue(undefined);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge: makeRuntimeBridge(),
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );
    try {
      const runtimeConfig = initializeTelemetry.mock.calls[0]?.[0] as {
        getSessionId(): string;
        getTelemetryResourceAttributes(): Record<string, unknown>;
      };
      expect(runtimeConfig.getSessionId()).toBe(`daemon:${process.pid}`);
      expect(runtimeConfig.getTelemetryResourceAttributes()).toMatchObject({
        'service.instance.id': `daemon:${process.pid}`,
      });
    } finally {
      await handle.close();
    }
  });

  it('awaits telemetry initialization before daemon metrics', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tm-')));
    const callOrder: string[] = [];
    vi.spyOn(qwenCore, 'initializeTelemetry').mockImplementation(async () => {
      callOrder.push('telemetry-start');
      await Promise.resolve();
      callOrder.push('telemetry-resolved');
    });
    vi.spyOn(qwenCore, 'initializeDaemonMetrics').mockImplementation(() => {
      callOrder.push('daemon-metrics');
    });
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: true,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge: makeRuntimeBridge(),
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );
    try {
      expect(callOrder).toEqual([
        'telemetry-start',
        'telemetry-resolved',
        'daemon-metrics',
      ]);
    } finally {
      await handle.close();
    }
  });
});

/**
 * Boot validation for the embedded `runQwenServe` API: a non-finite
 * `permissionResponseTimeoutMs` (e.g. config- or NaN-derived) must fail
 * loud rather than reach the bridge, where it would be treated as the
 * "disabled" sentinel and silently drop the permission deadline.
 */
describe('runQwenServe permissionResponseTimeoutMs validation', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects a non-finite permissionResponseTimeoutMs', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-pt-')));
    const fakeBridge = {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
    } as unknown as HttpAcpBridge;

    // Keep the daemon logger inside the temp dir so the boot path before
    // the validation throw doesn't write into the real ~/.qwen.
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            permissionResponseTimeoutMs: Number.NaN,
          },
          { bridge: fakeBridge },
        ),
      ).rejects.toThrow(/permissionResponseTimeoutMs/);
      const log = fs.readFileSync(
        path.join(tmpDir, 'debug', 'daemon', 'daemon.log'),
        'utf8',
      );
      expect(log).toContain('daemon startup failed');
      expect(log).not.toContain('daemon stopped');
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('preserves the startup error and releases the log lease when stderr fails', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-pt-')));
    const fakeBridge = {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
    } as unknown as HttpAcpBridge;
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        if (String(chunk).includes('daemon startup failed')) {
          throw new Error('stderr unavailable');
        }
        return true;
      });

    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            permissionResponseTimeoutMs: Number.NaN,
          },
          { bridge: fakeBridge },
        ),
      ).rejects.toThrow(/permissionResponseTimeoutMs/);
    } finally {
      stderr.mockRestore();
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }

    expect(
      fs.existsSync(
        path.join(tmpDir, 'debug', 'daemon', '.stable-writer.lock'),
      ),
    ).toBe(false);
  });
});

/**
 * The budget is resolved at boot and reported. Whether it also sizes a child
 * depends on `childHeapMode`, which defaults to `observe` and sizes nothing.
 * The only boot-time behavior is rejecting an out-of-range flag value.
 */
describe('runQwenServe memory budget', () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  function makeTmpDir(): string {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-mem-')),
    );
    tmpDirs.push(dir);
    return dir;
  }

  it('reports the resolved budget over HTTP without sizing any child', async () => {
    const dir = makeTmpDir();
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: dir,
        maxSessions: 1,
        serveWebShell: false,
        memoryBudgetMb: 4096,
      },
      { resolveOnListen: true },
    );

    try {
      await handle.runtimeReady;
      const res = await fetch(`${handle.url}/daemon/status`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        limits: {
          memory: {
            enforced: boolean;
            childHeap: {
              mode: string;
              maxConcurrentChildren: number;
              perChildCeilingMb: number | null;
              refusals: number;
            } | null;
            configuredBudgetMb: number;
            effectiveBudgetMb: number;
            budgetSource: string;
            availableMemoryMb: number;
            insufficientMemory: boolean;
            modeled: {
              rootReserveMb: number;
              childPoolMb: number;
              minChildHeapMb: number;
              maxChildHeapMb: number;
              legacyChildCeilingMb: number;
            };
          } | null;
        };
        runtime: {
          memory?: {
            registeredWorkspaces: number;
            activeAcpChildren: number;
            childRssCoverage: string;
            children: {
              rssBytes: number;
              sampled: number;
              oldestReadingAgeMs: number | null;
            };
            modeled: {
              recommendedShareAtRegisteredMb: number;
              recommendedShareAtActiveMb: number | null;
            };
            // Restated rather than imported on purpose: this shape is the
            // wire contract, and casting to the internal type would make the
            // assertions below accept whatever that type happens to say.
            pressure: {
              mode: string;
              level: string;
              source: string;
              ratio: number;
              rssBytes: number;
              rssRatio: number;
              availableBytes: number;
              heapUsedBytes: number;
              heapRatio: number;
              heapLimitBytes: number;
            };
          };
        };
      };

      const memory = body.limits.memory;
      expect(memory).not.toBeNull();
      // The child-heap policy reached status on a daemon that really booted.
      // Default is `observe`, so it computed a share and applied nothing —
      // `enforced` has to stay false or the field means "the feature exists"
      // rather than "children are being sized by this".
      expect(memory?.enforced).toBe(false);
      // Pin the key set rather than the values, so an unannounced field added
      // to the wire still fails here. `toEqual` on the whole object was the
      // other option and it does not survive this suite booting a real daemon:
      // both derived figures follow the host's pool, and on a runner with
      // under ~1 GB available the model correctly publishes no partition at
      // all — so a matcher asserting `any(Number)` would fail on exactly the
      // host where the code is doing the right thing.
      expect(Object.keys(memory?.childHeap ?? {}).sort()).toEqual([
        'maxConcurrentChildren',
        'mode',
        'perChildCeilingMb',
        'refusals',
      ]);
      expect(memory?.childHeap?.mode).toBe('observe');
      expect(memory?.childHeap?.refusals).toBe(0);
      // Whichever branch this host took, the two figures agree with each
      // other. The arithmetic itself is pinned exhaustively in
      // `child-heap-policy.test.ts`; what this asserts is that a real daemon
      // put a self-consistent pair on the wire.
      if (memory?.childHeap?.perChildCeilingMb === null) {
        expect(memory?.childHeap?.maxConcurrentChildren).toBe(0);
      } else {
        // A fixed grant handed to every admitted child must total no more than
        // the pool it partitions. That product is the whole reason the
        // partition is a bound rather than a per-spawn share.
        expect(memory?.childHeap?.maxConcurrentChildren ?? 0).toBeGreaterThan(
          0,
        );
        expect(
          (memory?.childHeap?.maxConcurrentChildren ?? 0) *
            (memory?.childHeap?.perChildCeilingMb ?? 0),
        ).toBeLessThanOrEqual(memory?.modeled.childPoolMb ?? 0);
      }
      expect(memory?.configuredBudgetMb).toBe(4096);
      expect(memory?.budgetSource).toBe('flag');
      // The invariant that motivates separating configured from effective:
      // whatever is reported must be something the machine can back.
      expect(memory?.effectiveBudgetMb).toBeLessThanOrEqual(
        memory?.availableMemoryMb ?? 0,
      );
      // Modeled pools stay non-negative and inside the budget they come from.
      expect(memory?.modeled.rootReserveMb).toBeLessThanOrEqual(
        memory?.effectiveBudgetMb ?? 0,
      );
      expect(memory?.modeled.childPoolMb).toBeGreaterThanOrEqual(0);
      expect(memory?.modeled.childPoolMb).toBeLessThan(
        memory?.effectiveBudgetMb ?? 0,
      );
      expect(memory?.modeled.legacyChildCeilingMb).toBeGreaterThan(0);

      const runtimeMemory = body.runtime.memory;
      expect(runtimeMemory?.registeredWorkspaces).toBe(1);
      // Sampling now covers every live child; it still is not process-tree
      // observation, which `children`'s own docs spell out.
      expect(runtimeMemory?.childRssCoverage).toBe('active_children');
      expect(
        runtimeMemory?.modeled.recommendedShareAtRegisteredMb,
      ).toBeGreaterThan(0);

      // Pressure, from a daemon that actually booted. Every other test for it
      // calls the status builder directly, so nothing else would notice the
      // reading failing to reach a live response.
      const pressure = runtimeMemory?.pressure;
      expect(pressure?.mode).toBe('observe');
      // A real process against a real denominator: assert the invariants
      // rather than a level, which depends on the host running the test.
      expect(pressure?.rssBytes).toBeGreaterThan(0);
      expect(pressure?.heapLimitBytes).toBeGreaterThan(0);
      expect(pressure?.availableBytes).toBe(
        (memory?.availableMemoryMb ?? 0) * 1024 * 1024,
      );
      expect(pressure?.ratio).toBe(
        Math.max(pressure?.rssRatio ?? 0, pressure?.heapRatio ?? 0),
      );
      expect(pressure?.source).not.toBe('unknown');

      // Aggregate child RSS. This test opens no SSE/WS stream, so the
      // sampler's watch gate never fires and nothing is polled — assert the
      // invariants that hold regardless rather than a non-zero sum, which
      // only a streaming client would produce.
      const children = runtimeMemory?.children;
      expect(children?.sampled).toBeLessThanOrEqual(
        runtimeMemory?.activeAcpChildren ?? 0,
      );
      // Nothing sampled must read as nothing summed and no age — never as a
      // measured zero.
      if (children?.sampled === 0) {
        expect(children.rssBytes).toBe(0);
        expect(children.oldestReadingAgeMs).toBeNull();
      } else {
        expect(children?.rssBytes).toBeGreaterThan(0);
      }
    } finally {
      await handle.close();
    }
  }, 30_000);

  it('rejects a budget below the documented minimum', async () => {
    const dir = makeTmpDir();
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = dir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: dir,
            maxSessions: 1,
            memoryBudgetMb: 512,
          },
          {
            bridge: {
              spawnOrAttach: vi.fn(),
              shutdown: vi.fn().mockResolvedValue(undefined),
              killAllSync: vi.fn(),
            } as unknown as HttpAcpBridge,
          },
        ),
      ).rejects.toThrow(/memoryBudgetMb/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) process.env['QWEN_RUNTIME_DIR'] = origEnv;
    }
  });

  it('writes a stderr line when the budget comes from the flag', async () => {
    const dir = makeTmpDir();
    const stderrWrites: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: dir,
        maxSessions: 1,
        serveWebShell: false,
        memoryBudgetMb: 4096,
      },
      { resolveOnListen: true },
    );
    try {
      await handle.runtimeReady;
      expect(stderrWrites.join('')).toContain('memory budget');
    } finally {
      spy.mockRestore();
      await handle.close();
    }
  });

  it('writes no stderr line for a derived budget on a sufficient host', async () => {
    // The gate must stay conditional: a derived budget on a host above the
    // minimum prints nothing. If the gate were unconditional this test fails.
    // Pin host memory so the test is independent of the runner's cgroup.
    mockTotalMemBytes.value = 32_768 * 1024 * 1024;
    const constrainedSpy = vi
      .spyOn(
        process as { constrainedMemory: () => number },
        'constrainedMemory',
      )
      .mockReturnValue(0);
    const dir = makeTmpDir();
    const stderrWrites: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: dir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );
    try {
      await handle.runtimeReady;
      expect(stderrWrites.join('')).not.toContain('memory budget');
    } finally {
      spy.mockRestore();
      constrainedSpy.mockRestore();
      mockTotalMemBytes.value = undefined;
      await handle.close();
    }
  });

  it('derives an adaptive journal growth pool into every bridge', async () => {
    // 16 GiB host: the derived budget (8192 MB) differs from the flag
    // budget (4096 MB), so the parity assertion below can tell whether the
    // daemon actually consumed --memory-budget-mb when deriving the pool.
    mockTotalMemBytes.value = 16 * 1024 * 1024 * 1024;
    const constrainedSpy = vi
      .spyOn(
        process as { constrainedMemory: () => number },
        'constrainedMemory',
      )
      .mockReturnValue(0);
    const dir = makeTmpDir();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(
        () =>
          makeRuntimeBridge() as ReturnType<
            typeof acpBridge.createAcpSessionBridge
          >,
      );
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: dir,
        maxSessions: 1,
        serveWebShell: false,
        memoryBudgetMb: 4096,
      },
      { resolveOnListen: true },
    );
    try {
      await handle.runtimeReady;
      expect(createBridge).toHaveBeenCalled();
      // The arithmetic is pinned exhaustively in the acp-bridge
      // journalGrowthPoolMb tests; this asserts a real daemon derives the
      // same figure and hands it to every bridge it constructs. Recomputed
      // here (not hardcoded) because `effective` caps at the host's
      // available memory.
      const expectedPoolBytes =
        journalGrowthPoolMb(resolveDaemonMemoryBudget({ budgetMb: 4096 })) *
        1024 *
        1024;
      for (const [options] of createBridge.mock.calls) {
        expect(options.journalGrowthPoolBytes).toBe(expectedPoolBytes);
      }
    } finally {
      createBridge.mockRestore();
      constrainedSpy.mockRestore();
      mockTotalMemBytes.value = undefined;
      await handle.close();
    }
  });

  it('disables adaptive journal growth when a journal flag is pinned', async () => {
    // Pin host memory to a usable figure so ONLY the pinned-flag gate can
    // disable growth: on a runner below the minimum usable budget,
    // insufficientMemory would disable it independently and mask a gate
    // regression.
    mockTotalMemBytes.value = 8 * 1024 * 1024 * 1024;
    const constrainedSpy = vi
      .spyOn(
        process as { constrainedMemory: () => number },
        'constrainedMemory',
      )
      .mockReturnValue(0);
    const dir = makeTmpDir();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(
        () =>
          makeRuntimeBridge() as ReturnType<
            typeof acpBridge.createAcpSessionBridge
          >,
      );
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: dir,
        maxSessions: 1,
        serveWebShell: false,
        memoryBudgetMb: 4096,
        maxJournalBytes: 16 * 1024 * 1024,
      },
      { resolveOnListen: true },
    );
    try {
      await handle.runtimeReady;
      expect(createBridge).toHaveBeenCalled();
      for (const [options] of createBridge.mock.calls) {
        expect(options.maxJournalBytes).toBe(16 * 1024 * 1024);
        expect(options).not.toHaveProperty('journalGrowthPoolBytes');
      }
    } finally {
      createBridge.mockRestore();
      constrainedSpy.mockRestore();
      mockTotalMemBytes.value = undefined;
      await handle.close();
    }
  });

  it('disables adaptive journal growth when only the entry cap is pinned', async () => {
    // Symmetric to the byte-cap pin: the gate must disable growth on
    // EITHER pinned journal flag, as the docs promise. Host memory is
    // pinned as in the byte-cap case so only this gate can disable
    // growth.
    mockTotalMemBytes.value = 8 * 1024 * 1024 * 1024;
    const constrainedSpy = vi
      .spyOn(
        process as { constrainedMemory: () => number },
        'constrainedMemory',
      )
      .mockReturnValue(0);
    const dir = makeTmpDir();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(
        () =>
          makeRuntimeBridge() as ReturnType<
            typeof acpBridge.createAcpSessionBridge
          >,
      );
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: dir,
        maxSessions: 1,
        serveWebShell: false,
        memoryBudgetMb: 4096,
        maxJournalEvents: 5000,
      },
      { resolveOnListen: true },
    );
    try {
      await handle.runtimeReady;
      expect(createBridge).toHaveBeenCalled();
      for (const [options] of createBridge.mock.calls) {
        expect(options.maxJournalEvents).toBe(5000);
        expect(options).not.toHaveProperty('journalGrowthPoolBytes');
      }
    } finally {
      createBridge.mockRestore();
      constrainedSpy.mockRestore();
      mockTotalMemBytes.value = undefined;
      await handle.close();
    }
  });

  it('derives the adaptive journal growth pool into secondary-workspace bridges too', async () => {
    // 16 GiB host: derived budget (8192 MB) != flag budget (4096 MB), as
    // in the single-workspace sibling, so flag consumption is pinned.
    mockTotalMemBytes.value = 16 * 1024 * 1024 * 1024;
    const constrainedSpy = vi
      .spyOn(
        process as { constrainedMemory: () => number },
        'constrainedMemory',
      )
      .mockReturnValue(0);
    const root = makeTmpDir();
    const primary = path.join(root, 'primary');
    const secondary = path.join(root, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(
        () =>
          makeRuntimeBridge() as ReturnType<
            typeof acpBridge.createAcpSessionBridge
          >,
      );
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, secondary],
        maxSessions: 1,
        serveWebShell: false,
        memoryBudgetMb: 4096,
      },
      { resolveOnListen: true },
    );
    try {
      await handle.runtimeReady;
      // One bridge per workspace; every one of them must carry the pool,
      // not just the primary.
      expect(createBridge.mock.calls.length).toBeGreaterThanOrEqual(2);
      const expectedPoolBytes =
        journalGrowthPoolMb(resolveDaemonMemoryBudget({ budgetMb: 4096 })) *
        1024 *
        1024;
      for (const [options] of createBridge.mock.calls) {
        expect(options.journalGrowthPoolBytes).toBe(expectedPoolBytes);
      }
    } finally {
      createBridge.mockRestore();
      constrainedSpy.mockRestore();
      mockTotalMemBytes.value = undefined;
      await handle.close();
    }
  });
  it('disables adaptive journal growth on a host too small for the budget', async () => {
    // A budget capped below the minimum by host memory leaves no usable
    // pool: no bridge may receive one, so growth stays off entirely.
    mockTotalMemBytes.value = 1_023 * 1024 * 1024;
    const constrainedSpy = vi
      .spyOn(
        process as { constrainedMemory: () => number },
        'constrainedMemory',
      )
      .mockReturnValue(0);
    const dir = makeTmpDir();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(
        () =>
          makeRuntimeBridge() as ReturnType<
            typeof acpBridge.createAcpSessionBridge
          >,
      );
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: dir,
        maxSessions: 1,
        serveWebShell: false,
        memoryBudgetMb: 1024,
      },
      { resolveOnListen: true },
    );
    try {
      await handle.runtimeReady;
      expect(createBridge).toHaveBeenCalled();
      for (const [options] of createBridge.mock.calls) {
        expect(options).not.toHaveProperty('journalGrowthPoolBytes');
        expect(options).not.toHaveProperty('journalGrowthSessionLimits');
        expect(options).not.toHaveProperty(
          'registerJournalGrowthSessionLimits',
        );
      }
    } finally {
      createBridge.mockRestore();
      constrainedSpy.mockRestore();
      mockTotalMemBytes.value = undefined;
      await handle.close();
    }
  });

  it('wires every bridge to one shared daemon-wide growth-pool view', async () => {
    mockTotalMemBytes.value = 8 * 1024 * 1024 * 1024;
    const constrainedSpy = vi
      .spyOn(
        process as { constrainedMemory: () => number },
        'constrainedMemory',
      )
      .mockReturnValue(0);
    const root = makeTmpDir();
    const primary = path.join(root, 'primary');
    const secondary = path.join(root, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(
        () =>
          makeRuntimeBridge() as ReturnType<
            typeof acpBridge.createAcpSessionBridge
          >,
      );
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, secondary],
        maxSessions: 1,
        serveWebShell: false,
        memoryBudgetMb: 4096,
      },
      { resolveOnListen: true },
    );
    try {
      await handle.runtimeReady;
      expect(createBridge.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const [options] of createBridge.mock.calls) {
        expect(typeof options.journalGrowthSessionLimits).toBe('function');
        expect(typeof options.registerJournalGrowthSessionLimits).toBe(
          'function',
        );
      }
      // Caps registered through one bridge's registrar must be visible
      // through EVERY bridge's view — one aggregate, not a pool per
      // bridge — and the unregister hook must remove them again.
      const views = createBridge.mock.calls.map(
        ([options]) => options.journalGrowthSessionLimits,
      );
      const unregisters = createBridge.mock.calls.map(([options], index) =>
        options.registerJournalGrowthSessionLimits?.(() => [
          { limitBytes: 1000 + index, baselineBytes: 8 * 1024 * 1024 },
        ]),
      );
      for (const view of views) {
        expect(view?.()).toEqual([
          { limitBytes: 1000, baselineBytes: 8 * 1024 * 1024 },
          { limitBytes: 1001, baselineBytes: 8 * 1024 * 1024 },
        ]);
      }
      // Unregister one provider at a time with a view assertion between:
      // a hook that wiped the entire shared set on ANY unregister would
      // still pass a bulk end-state check.
      unregisters[0]?.();
      for (const view of views) {
        expect(view?.()).toEqual([
          { limitBytes: 1001, baselineBytes: 8 * 1024 * 1024 },
        ]);
      }
      unregisters[1]?.();
      for (const view of views) {
        expect(view?.()).toEqual([]);
      }
    } finally {
      createBridge.mockRestore();
      constrainedSpy.mockRestore();
      mockTotalMemBytes.value = undefined;
      await handle.close();
    }
  });
});

describe('runQwenServe initializeTimeoutMs validation', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects a non-positive initializeTimeoutMs', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-it-')));
    const fakeBridge = {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
    } as unknown as HttpAcpBridge;

    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            initializeTimeoutMs: 0,
          },
          { bridge: fakeBridge },
        ),
      ).rejects.toThrow(/initializeTimeoutMs/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('rejects a non-finite initializeTimeoutMs', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-it-')));
    const fakeBridge = {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
    } as unknown as HttpAcpBridge;

    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            initializeTimeoutMs: Number.NaN,
          },
          { bridge: fakeBridge },
        ),
      ).rejects.toThrow(/initializeTimeoutMs/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('rejects an initializeTimeoutMs above the JS timer ceiling', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-it-')));
    const fakeBridge = {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
    } as unknown as HttpAcpBridge;

    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            initializeTimeoutMs: 2_147_483_648,
          },
          { bridge: fakeBridge },
        ),
      ).rejects.toThrow(/initializeTimeoutMs/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('propagates a valid initializeTimeoutMs to the bridge options', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-it-')));
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });

    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      const handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          maxSessions: 1,
          initializeTimeoutMs: 30_000,
          serveWebShell: false,
        },
        { resolveOnListen: true },
      );
      try {
        await handle.runtimeReady;
        expect(createBridge.mock.calls[0]?.[0]).toMatchObject({
          initializeTimeoutMs: 30_000,
          // Below the restore default, so the restore budget holds at 60 s.
          sessionRestoreTimeoutMs: 60_000,
        });
      } finally {
        await handle.close();
      }
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });
});

// Long-lived self-signed cert (CN=localhost, SAN IP:127.0.0.1) used only
// to exercise the HTTPS listener path. Not a real secret.
const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUfuVC8Ulq3HIg+1tf36JrjAa6dr4wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDYzMDAyMjIxOVoYDzIxMjYw
NjA2MDIyMjE5WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCnEk5caJsr2ShJwi4bkAMr1/IzzueiUFbnnqs3XpaB
ANxpIZxi8WN1gf8MoAOioZteH51Q2nz8Zb2MVHoDMH3zx4V36VcXUaeR+/wZbFRN
94NlzYCXPnzPH+Mw/vle1PTM/boPON8F4ATGJZkzmGT8+M5CqDCW4isHlpGvbn0T
SdmqnmzihNBdaREVVkGJYa7JSFcgRth52+wTAOIM8e8HC1VTMw1OhXDAus6ro7z+
u5XKGpG+JfsCpimNPYzNOPSkIr/QmxuaMq7kmYwT9J1Gyw9cQQj8vcipyLq6q3Hz
iMhxUXbWp7moi4e6CzxLKyPrWwhuh+3SXqIYshAYRsKNAgMBAAGjbzBtMB0GA1Ud
DgQWBBSM8bvfq77vXg5fsuhYGXsLuKjqxzAfBgNVHSMEGDAWgBSM8bvfq77vXg5f
suhYGXsLuKjqxzAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGHBH8AAAGCCWxv
Y2FsaG9zdDANBgkqhkiG9w0BAQsFAAOCAQEAGUBgaBYEO119e28j61PTijfhw7mV
Q8AxlUjlv+HHx+IAPR+E8w7jiS97oxvFSIkmbV+FAQOWwTE+oNvrL5qSFlG7cI60
wj+Jxwxr+/SShV5Jm7JlynAGxOvOZ1mfxzyGrlm5cg4hoRvcoWAtB/qtiIyFIz/s
fDAdZiFXRoTaZnpyPWA6iydf3mc0ZOastHib+mlFb+aedKz9by/f2Z1CY6RfckEj
20c9Mar85RYkVtVTIWNSwItASmQVBaoXsXK33y4C0P1NmPoYBzyPSXsOlmIZXui5
WYj2mrPe2DL5gCeNUxMhmzgv0bgoYiksHmdyNjRmO5AQlcdjX/7CHg0zEQ==
-----END CERTIFICATE-----
`;

const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCnEk5caJsr2ShJ
wi4bkAMr1/IzzueiUFbnnqs3XpaBANxpIZxi8WN1gf8MoAOioZteH51Q2nz8Zb2M
VHoDMH3zx4V36VcXUaeR+/wZbFRN94NlzYCXPnzPH+Mw/vle1PTM/boPON8F4ATG
JZkzmGT8+M5CqDCW4isHlpGvbn0TSdmqnmzihNBdaREVVkGJYa7JSFcgRth52+wT
AOIM8e8HC1VTMw1OhXDAus6ro7z+u5XKGpG+JfsCpimNPYzNOPSkIr/QmxuaMq7k
mYwT9J1Gyw9cQQj8vcipyLq6q3HziMhxUXbWp7moi4e6CzxLKyPrWwhuh+3SXqIY
shAYRsKNAgMBAAECggEAQW/tG0qphEog+orAznDgnRqOtfYTScLX1w6RlzVIE60H
p3HPs/1B7HOHNyWxZtCPbxVI47NAAwfCbyVjSL6EhqgeQbI2N173GDmvKzH/7y3D
3GraM+L4tZOSw80KVTdpzqSObInk6IMuu4FceRX2cBLvjrIbne1l1yoFU8Yd3SCM
t8J46vMys7Rh4yR0iOl1hFeLYj8KolTdp6uNYTxaHMt363G7/TcJYRqjrLkpBpXJ
dJiP58a3WulvVKVHBjZYVmHLlkvla7LQ9tPRsk0gUQfzNpLzl6oBacrNrRv1F7Oe
keYqt+Kpy9HhZIHt57ahwKmjhjrfIUpyQadF/me0rQKBgQDVbLV6VngGjMSCPQOQ
VZcAMFZ+y1fgaHeVZwuFeRlCEHBDDmw5eWdUdUQNIRckpqf0IlU39aP/cLgjNZ0W
nmxfUwhdgEMam2aHZ/8eqrOl0HTa+F5PWz8NPLKsQ970vPb1XCsoEtDVXEsMqK+s
4h+zjRzy6lLy2cWvYZrDr/KwywKBgQDIZmitKO0MIJOWeqwI3MQvbBXCz9aEIG+3
0ISQreD/7Z/IEcwrMpDD+z1sOj9OUO2GFflECdhtqo416cv3uo8LLABxuzsYOgug
ZPgW9oPKVRLfqc43/n0JMtIvS+Na/7C/nCNwcZZZU91V+VG4+1rexINQybnCRbQw
cBZLcX8nBwKBgQDMdZhl2vChVbnsCwee/l/qjmROk/9bvLjTKCSheaH46Eaj9u03
IlcbUjwfV9QUCJReDYYWVf0GebXuBS64vIyVxbX93SJsGvPeRILjniT8dPd9zvKK
k5+TztJctaiiTWVJKUMu4NevjvtW5UNnHDnCiS1yiYltnbMEkTzyu1yEgQKBgAYk
pYbRX1rk0MFnJ0jqQ5VUkeIz7taEDAiterLYsbIGvcQrT3/vf+KSHBLqQjCLaIyY
tdhxGNJbzRo3/YmtjV8BTU4vOCOI+/xBvB0wF2AndXmnweuTgI+8oBbVE7YhanCl
P6zdvocke/97shailemISqI6XNhovJpThUtwwj4XAoGATwSvzX0VLRpoWwDl30oi
hxyfpb0iCzGik49j/oL+ZB5C8F8AdBpza8eTXJAeAVP7L5nvWffMgvcXs5sGMF7e
ARaOwZHpfsTw4Aq74yAWUKXumVGFXQpZMRj/QWgQEItTYF7rJVARIssv5miDbHvW
1Qm2tDpPnmCd1BedIYWCnHA=
-----END PRIVATE KEY-----
`;

// A self-signed localhost cert/key whose validity window is entirely in the
// past (notAfter = 2020-01-02). Not a real secret — and doubly worthless
// since it's already expired. Used to exercise the boot-time expiry guard.
/**
 * A CA-issued serving cert (leaf alone) with the key it pairs with, plus the
 * root that signs it — the shape the documented `mkcert` flow produces. The
 * leaf covers 127.0.0.1 and localhost and boots, but anchors nothing by
 * itself: only an operator `NODE_EXTRA_CA_CERTS` pointing at the root closes
 * the gap, which is what makes it able to tell the env wiring apart from a
 * hard-coded `undefined`.
 */
const TEST_TLS_CERT_ISSUED_LEAF = `-----BEGIN CERTIFICATE-----
MIIDMDCCAhigAwIBAgIUSUiporSz6CoX5xzIrRzMJUWh23owDQYJKoZIhvcNAQEL
BQAwIzEhMB8GA1UEAwwYcXdlbiB3aXJpbmcgdGVzdCByb290IENBMCAXDTI2MDgx
ODIyMzI1OFoYDzIxMjYwNzI1MjIzMjU4WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3Qw
ggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCyATi7Mip/VT+YWLvMdqpa
IrgUpR5xLaZ9HGOI6kavvCvtveN/SEu9CT1XKQDRMT+NrJeTi97JV56GXZStGAES
68wVnJDwV7EE5/VpRrmEZamn0lxOHeBMdu34F22aQ1xhw9bdRw+00kA5kE2rHEN1
ZVaE0orqBtj/tnfhWET11b/99W4V+91WJQn+P+HrJGbMUW58qGsoW9C6fa0Pj365
UymzgAWCLzf5DBziIqsevbcRzLwFUVw5bogjxmFIrd8k/R/xrjqNQJrRJX5SbS9O
uI4tHmUeUmtjsAql53skJ2j2qpVvldZ0QFUS09O+vUkuSoZQ52s/b4/6SFwqdIXZ
AgMBAAGjaTBnMBoGA1UdEQQTMBGCCWxvY2FsaG9zdIcEfwAAATAJBgNVHRMEAjAA
MB0GA1UdDgQWBBQuqaRKepsHMIxA1OlXRfS9ZcyY+TAfBgNVHSMEGDAWgBSa5IYk
ecO4EMlhojegvuVPj9xRTDANBgkqhkiG9w0BAQsFAAOCAQEASjn63nPtLzzDVWvq
h7tITuKvE4CeWGATghhJGYYn9FOsyJxnbvVgQN0zmuzpPoTtxVdiGYob5qMEAjZB
UsCGfWDNsJ6znUc1De0/sjvkq/uHdMgzaOldIgjdT+FO5cbtnDJx+fUe3QANW9or
uX4mMvMI6ikw2LWPk8yavW1f0JyORa76gl0IoGyTmgBf9v9T4OIqskiR5xB1vE31
nN5x4BuL5YnYN8x9GBDMOAGNn+HerAB8HSyygoB0A97eOGtxj5+DQh3EpirYx4bM
4uRnAzkc2poDlbMNG1lLO5MdXjvy4Hy5pu+tSOXkRokV7V3wJWm7TFNBRYjjogip
mt7FIw==
-----END CERTIFICATE-----
`;

const TEST_TLS_KEY_ISSUED_LEAF = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCyATi7Mip/VT+Y
WLvMdqpaIrgUpR5xLaZ9HGOI6kavvCvtveN/SEu9CT1XKQDRMT+NrJeTi97JV56G
XZStGAES68wVnJDwV7EE5/VpRrmEZamn0lxOHeBMdu34F22aQ1xhw9bdRw+00kA5
kE2rHEN1ZVaE0orqBtj/tnfhWET11b/99W4V+91WJQn+P+HrJGbMUW58qGsoW9C6
fa0Pj365UymzgAWCLzf5DBziIqsevbcRzLwFUVw5bogjxmFIrd8k/R/xrjqNQJrR
JX5SbS9OuI4tHmUeUmtjsAql53skJ2j2qpVvldZ0QFUS09O+vUkuSoZQ52s/b4/6
SFwqdIXZAgMBAAECggEAP8YgRTEb+LLaLgLchcyeC90UhpEB7xqj438gShVlbeDE
/FBkCV4lhHyi9W9DU6+JTYDgbYRXNVum+AzfD4TiHZ1NaRDG/NTuHwvb6PPl04F4
3x+G4pXhnoOdjp0WL4aiuoQnnu+uuOH7EKSarwtZP94muT+VdXMum68MFDhDvK9X
HPK8nS7LKYq4RMbkl6iY4HtudL7xFncrBM1rFW5tjJSemvoILmNzFNNndUO06qi5
39RJWnWjOavlH3KGE0eBRxld+6OVJ1u14uI4ZIJ20nnaBlXPedbPMVoU0d3VGzBk
MQZXnEIzEn5gKHu0WOH5rFjxSsBJ/LCuoXfkWzR34QKBgQDeFltt8chUENX7fpjH
IAdSqhPU6IXeeK5bHlebmnEoHk9HmXVOvVRvoy3rfMaFuTUqr1xKrSff4BNrayRs
TZjRc6Uhp6OL1UqEV3Wj4oIRARnl+X/7THP4c9D37i73h7wIPASRsybw+kQjPHDp
+Cy7EsMR9MtuWCuLvuuhk6ExMwKBgQDNL6CzH82RjaPRXFYliaO+0VZ4WD2zF7tm
IM908rQRZ534yL4vTopYxiQDErmgIy6oudtdjvL/GqbsGfpA+eMzChuqrMLjoYkW
wJkjt+8B0IjNW06gxjMhpKvOSqmyhqQUZLS/lh9bLTaEn+rBFGLSgj/eu1b8gA00
RLYRsPvEwwKBgCcB+EckW5JgbqVAxCbdekvLsbYIrVK5Ea7RcoPTKaLpR/WEf7U3
zffZynv9K4VbVXpM2MIJDeLloaORaxFWw8uuK0fxAOnTqcX68p+5biz8a4cYPqFt
+USfWwnhHQC/J4iuugK5W9KhsowZ1p9RxtGI5xhlTcHw3J0sCIkVvA8/AoGAHONm
wbFplOOXO+O/MTvGtRfuD7WEwlFGDiPycWm2Vnj7Mcq5lBl/uu3ypggd4GDzscex
DeQRbD9JXxZtOHa2OTpkGMyIB9p3XZ+yL+g2m0/L4vXHBTXCfysbEUlLyRnRwhlH
pW2ybnjYIyYMvDBtlWvHKEnB/nzc3w4JgEYlvFcCgYBoYs7vAT44eu1LSanMeD7m
317U0Rp+8CzVLg7Jx6cdyoY/aw797tayqNePn28pQiv8sPcsi07tfuwyP7+fuDIP
HpK7Y2PYdLHDw2uvpM3U5uO/EeHdbcJsyPGsOH7hl2PrbRxWI3o1uH2a2TyVj4o3
ZNK0I9xeA/IvxH54ZqElqA==
-----END PRIVATE KEY-----
`;

const TEST_TLS_CERT_ISSUING_ROOT = `-----BEGIN CERTIFICATE-----
MIIDKTCCAhGgAwIBAgIUPcGOSM9P9TbZ6hP5evWMiwSygd0wDQYJKoZIhvcNAQEL
BQAwIzEhMB8GA1UEAwwYcXdlbiB3aXJpbmcgdGVzdCByb290IENBMCAXDTI2MDgx
ODIyMzI1OFoYDzIxMjYwNzI1MjIzMjU4WjAjMSEwHwYDVQQDDBhxd2VuIHdpcmlu
ZyB0ZXN0IHJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCf
LOHXauGBhN4HTDHi+R+91uInim+k8vumqw6dbdbj6FcKZWF8iIIs2NsKRuLRaaOo
/HLV3y4rTGWBAVYF3FcYSybqCeMoMa4JJX2FTqzgVdIAog+fNQeQdqOrsAtNXf+W
weB1c751qJwqunKCyk02i0zbBRqLqd/PJ6lnGDA/Fv6MNvtpjN5ScC018j+RBXwF
ZHQ0Dm8LkHShBteOr3r8ychU3Q5AMao7MnJK1fa2lixUKKimtaEeH0/SFyHMfHNt
io9/GxQluEFrunsLcC+6USpdp9sk/N6dxG1IqKPJlpjv5D5tM5qRbDlCZD+QWS9m
q0vXHbkd/yppytewSfYVAgMBAAGjUzBRMB0GA1UdDgQWBBSa5IYkecO4EMlhojeg
vuVPj9xRTDAfBgNVHSMEGDAWgBSa5IYkecO4EMlhojegvuVPj9xRTDAPBgNVHRMB
Af8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAdypPZaHSwv1ptjv+l6hUIBM+O
5qNUV0Gk4jmt6UZD7lzIweurap8k2dQdYBF1BjHgo+2dCW7m4W4NHczgUzHwECCG
4jPNZhc3T0PyGQjqi/pQ1dwSfZn75H9qSq09GHbLq0Vqzp5zDav6Hv8OzSIy2Cm1
1SDbgTndiZzHiShBJrUhJymLTcaVM2EDad3poKsVoZ7ArFPWViMlJi5fFd8sWjii
tsVzO5eP6Ln9kRVz9DhyN5a8ky1ceVOX/KsB0fS10e9Ortldm8lbFmcNDbpaVJy1
35gz6UVTrBB7X/4E/XvBAo9rIiiL4PheAzLjHdDvhJuotdmHIzCfQ0LjQxIU
-----END CERTIFICATE-----
`;

const TEST_TLS_CERT_EXPIRED = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUW7rZvmhryKZI3pojRCfl3liQSEMwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTIwMDEwMTAwMDAwMFoXDTIwMDEw
MjAwMDAwMFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAzK9z67IJ0e5QGpnGoqCCY4jr401AKE0EuCx1TVkyGFck
2ESCkBPvV+ikMxvLuCOTdrKhgavlIVsnnrPgyND49WaVX6XrftoEU5hApDrWYtIV
TfHYSC1wWdS5yNL+tdqLnfiC8b1FolEdgChF5cBpv9jQ6jwjUwXDojVhoPv5Rf/+
7zWyCg4hoj4N5veluDp1uUJ3xYjT5bqgu54sSR8lDJ8quq48nei60iOy40QQ1z3N
+sDgoAwkkLDOt74iGnZpUOuKt4w0/v96epC12os40FrcYbbe880/trG0aWT4tvnr
t0WFMtLReBSgV/QPkXTZ4HXUVs+7QrqcDWElET2QXQIDAQABo1MwUTAdBgNVHQ4E
FgQUOy4xvXmhCSs0Msfb6mT3WuCjrwQwHwYDVR0jBBgwFoAUOy4xvXmhCSs0Msfb
6mT3WuCjrwQwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAZA0J
BSNEIrsyS/5MyiEmgZlhpPwdqxOfBGFTsHqD0jha30RSEl85iW4XIuwFH1nKoOKQ
Mw3Ns0FaXVJxsrLS7f+4QjzCtTNQ4jEHsnmkm+bLSXK9qA3XLYG7mogdiRE5qz91
9lwZCTBoWnfiG3phz7/Y/F4jM86JxJG4Fm/IQNhgxSGrNhyrRRfXR3rPOIA8pSpz
yN2OMgOQdMXhgE3IM8v7O/76OAYWhybO3zzNtL9d+mRW42B+Q5TCBIKwZXAALlLf
arfULiZOWgeWfNpoEvfbVqn6VXKNny0F8KDoTwoHzpTm0cb+RzfGiSRm0avJr20t
OmPpuyd1dcPjPSJEAQ==
-----END CERTIFICATE-----
`;

const TEST_TLS_KEY_EXPIRED = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDMr3PrsgnR7lAa
mcaioIJjiOvjTUAoTQS4LHVNWTIYVyTYRIKQE+9X6KQzG8u4I5N2sqGBq+UhWyee
s+DI0Pj1ZpVfpet+2gRTmECkOtZi0hVN8dhILXBZ1LnI0v612oud+ILxvUWiUR2A
KEXlwGm/2NDqPCNTBcOiNWGg+/lF//7vNbIKDiGiPg3m96W4OnW5QnfFiNPluqC7
nixJHyUMnyq6rjyd6LrSI7LjRBDXPc36wOCgDCSQsM63viIadmlQ64q3jDT+/3p6
kLXaizjQWtxhtt7zzT+2sbRpZPi2+eu3RYUy0tF4FKBX9A+RdNngddRWz7tCupwN
YSURPZBdAgMBAAECggEAAUw1eG+TB10y7dA+xaYt3XKvSCwjtX2zg3VosvpXSnc2
+RYKG968fDqx288Xzg2PsEd2patQ0xLQX/209aD5ixjA5q/XG+FG+L603jWvSUYa
s3lOjTqYhUFHgkHwMnf1vaUnM2AnUl2gScE3nDrJkNlPjcSe1rZpJJyhB1PBo1N2
w602QMMMsIOHrPeJ/THm6ENUD6xGvGsuDcYZWDP9Fa/Dj1oMW+B8FRV/lF91JHgh
cP+QLk/E4SZGDIOQQ86v1jst6MGzI+iQVYTxfyDgyuCop9DAc1X9hZpG3qOyp6NS
DwBK14fc2r0S9ImL9I/wOBL319s60sC6h8BdOoSWowKBgQDoDP51obLx4kX3YbFD
1huH64Y072LolopXfaNj+Albk1PaNe1oBp1V80wFIT57l0WpibYWOQM6zDWVjZ/5
83utLHOdPe1PzVt4W1Yrk0CcWBiPybGlVVsBrogkF0lCSDGW8rqzD/Cms6AuLB5k
3ypNZKrk976fXjLSvefA9w2QvwKBgQDhz3BFW4oKvksl7PWyc5fvPgh1+V4K622b
hfjcdnamPynkUT13S0ymwOkjNYW6QzCSpgas59X3EHp8JR6Z6CoWdI4Fixz01qLv
R2n41Cc7lKF4WsXoi2IAq489z8GTuQpxhwWGxRs6uWiexY6CResvIgf7fnG63Rrd
p6Ul8kCJ4wKBgQCTdkZyHEqqGd/agBN1B2fBbTOBCisxoRDS3n1pduMDddFQlvqC
I8nyJ8VEcUbSpWPYhDHZV2us/r6ChliGL2uFtfzWjNb04oxhJLHSySXC9NzO6x5f
8aj+nZnYTY/5dgVFZoSsa9HDLdz52oGKGqM4QWO0U5eokOT9NT9ESfst4wKBgG5K
raGSxmfc7kOF67PPteQKvoMw23gl6ZFO7HByBB3LOCDmdUkxJC1GiBjEaZ7CdpUK
NrR5QA6+o7TDRKETvordPwkCG5CSzV5l2SLKLKdzPzLT01pzydhd80bTlM8cUDeH
JXHgEB6stKboA2Up1WdeDdwOtGn62MZuvcE9A7zVAoGAdediZvzAK+yVIPwaNqpy
eeYB4svm8NxzReLF/SCx+j++LvdQlrZMaCfX5M+zPCjXP7WiMWKlCKFm3kCq0NxV
dfOrXxrzy0bEsqEN1JpFwcVI4sUXm/JQSxO6mI5osX1e9qGF3p12aK6fWrPwaj1T
0qHz65jIzFez4M7YrnWF6Ak=
-----END PRIVATE KEY-----
`;

describe('runQwenServe TLS (--tls-cert / --tls-key)', () => {
  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  const minimalBridge = () =>
    ({
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
    }) as unknown as HttpAcpBridge;

  it.each([
    ['only --tls-cert', { tlsCert: '/tmp/c.pem' }],
    ['only --tls-key', { tlsKey: '/tmp/k.pem' }],
  ])('rejects %s without its pair', async (_label, tlsOpts) => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tls-')),
    );
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            ...tlsOpts,
          },
          { bridge: minimalBridge() },
        ),
      ).rejects.toThrow(/--tls-cert and --tls-key must be provided together/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('rejects an unreadable cert file', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tls-')),
    );
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            tlsCert: path.join(tmpDir, 'does-not-exist.pem'),
            tlsKey: path.join(tmpDir, 'also-missing.pem'),
          },
          { bridge: minimalBridge() },
        ),
      ).rejects.toThrow(/Failed to read --tls-cert/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('rejects an unreadable key file', async () => {
    // A readable cert with an unreadable key must hit the key-read catch,
    // not the cert-read one — otherwise the --tls-key error message is
    // never exercised and could regress unnoticed.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tls-')),
    );
    const certPath = path.join(tmpDir, 'cert.pem');
    fs.writeFileSync(certPath, TEST_TLS_CERT);
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            tlsCert: certPath,
            tlsKey: path.join(tmpDir, 'no-key.pem'),
          },
          { bridge: minimalBridge() },
        ),
      ).rejects.toThrow(/Failed to read --tls-key/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('rejects an expired certificate at boot', async () => {
    // A cert past its notAfter must fail loud at boot rather than start a
    // listener that rejects every client handshake while /health stays green.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tls-')),
    );
    const certPath = path.join(tmpDir, 'cert.pem');
    const keyPath = path.join(tmpDir, 'key.pem');
    fs.writeFileSync(certPath, TEST_TLS_CERT_EXPIRED);
    fs.writeFileSync(keyPath, TEST_TLS_KEY_EXPIRED);
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            tlsCert: certPath,
            tlsKey: keyPath,
          },
          { bridge: minimalBridge() },
        ),
      ).rejects.toThrow(/expired on/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('rejects an unparseable certificate at boot', async () => {
    // A readable file whose contents aren't a valid PEM cert must hit the
    // X509Certificate parse catch and surface the framed message rather than
    // a raw OpenSSL string.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tls-')),
    );
    const certPath = path.join(tmpDir, 'cert.pem');
    const keyPath = path.join(tmpDir, 'key.pem');
    fs.writeFileSync(certPath, 'not a real certificate');
    fs.writeFileSync(keyPath, TEST_TLS_KEY);
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            tlsCert: certPath,
            tlsKey: keyPath,
          },
          { bridge: minimalBridge() },
        ),
      ).rejects.toThrow(/is not a valid certificate/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('rejects a cert/key mismatch at boot', async () => {
    // TEST_TLS_CERT and TEST_TLS_KEY_EXPIRED come from different keypairs, so
    // https.createServer's createSecureContext throws a raw OpenSSL
    // key-values-mismatch string. Assert it's wrapped into the actionable
    // "could not be loaded (do they match?)" framing.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tls-')),
    );
    const certPath = path.join(tmpDir, 'cert.pem');
    const keyPath = path.join(tmpDir, 'key.pem');
    fs.writeFileSync(certPath, TEST_TLS_CERT);
    fs.writeFileSync(keyPath, TEST_TLS_KEY_EXPIRED);
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            tlsCert: certPath,
            tlsKey: keyPath,
          },
          { bridge: minimalBridge() },
        ),
      ).rejects.toThrow(/could not be loaded/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('serves over https when both cert and key are valid', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tls-')),
    );
    const certPath = path.join(tmpDir, 'cert.pem');
    const keyPath = path.join(tmpDir, 'key.pem');
    fs.writeFileSync(certPath, TEST_TLS_CERT);
    fs.writeFileSync(keyPath, TEST_TLS_KEY);

    let resolveTelemetry:
      | ((settings: qwenCore.ResolvedTelemetrySettings) => void)
      | undefined;
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockReturnValue(
      new Promise<qwenCore.ResolvedTelemetrySettings>((resolve) => {
        resolveTelemetry = resolve;
      }),
    );
    const bridge = {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
      getSession: vi.fn(),
      getAllSessions: vi.fn().mockReturnValue([]),
      publishWorkspaceEvent: vi.fn(),
      getEventRing: vi.fn().mockReturnValue({ getAll: () => [] }),
      resume: vi.fn(),
      preheat: vi.fn().mockResolvedValue(undefined),
      getDaemonStatusSnapshot: vi.fn().mockReturnValue(BASE_BRIDGE_SNAPSHOT),
      isChannelLive: vi.fn().mockReturnValue(true),
    } as unknown as HttpAcpBridge;
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        tlsCert: certPath,
        tlsKey: keyPath,
      },
      { resolveOnListen: true, runtimeStartupTimeoutMs: 0 },
    );

    try {
      expect(handle.url).toMatch(/^https:\/\//);
      expect(handle.server instanceof https.Server).toBe(true);

      // A successful response over the self-signed listener proves the
      // TLS handshake completed (not just that the URL string says https).
      const statusCode = await new Promise<number>((resolve, reject) => {
        const req = https.get(
          `${handle.url}/health`,
          { rejectUnauthorized: false },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
      });
      expect(typeof statusCode).toBe('number');
    } finally {
      resolveTelemetry?.({
        enabled: false,
        sensitiveSpanAttributeMaxLength: 1024 * 1024,
      });
      await handle.close();
    }
  });
});

describe('runQwenServe pre-listen bridge option validation', () => {
  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['maxSessions', Number.NaN, /maxSessions/],
    ['maxSessions', -1, /maxSessions/],
    ['maxTotalSessions', Number.NaN, /maxTotalSessions/],
    ['maxTotalSessions', -1, /maxTotalSessions/],
    ['maxTotalSessions', 1.5, /maxTotalSessions/],
    ['eventRingSize', 0, /eventRingSize/],
    ['eventRingSize', 1.5, /eventRingSize/],
    ['eventRingSize', Number.POSITIVE_INFINITY, /eventRingSize/],
    ['compactedReplayMaxBytes', 0, /compactedReplayMaxBytes/],
    ['compactedReplayMaxBytes', 1.5, /compactedReplayMaxBytes/],
    [
      'compactedReplayMaxBytes',
      Number.POSITIVE_INFINITY,
      /compactedReplayMaxBytes/,
    ],
    ['memoryProjectScope', 'unsupported', /memoryProjectScope/],
  ] as const)(
    'rejects invalid %s=%s before printing the listening line',
    async (optionName, value, message) => {
      tmpDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qws-bridge-opt-')),
      );
      const stdoutWrites: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdoutWrites.push(String(chunk));
        return true;
      });

      await expect(
        runQwenServe({
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          [optionName]: value,
        }),
      ).rejects.toThrow(message);
      expect(stdoutWrites.join('')).not.toContain('qwen serve listening on');
    },
  );

  it.each([
    ['rateLimitPrompt', 0, /rateLimitPrompt/],
    ['rateLimitMutation', -1, /rateLimitMutation/],
    ['rateLimitRead', 1.5, /rateLimitRead/],
    ['rateLimitWindowMs', 999, /rateLimitWindowMs/],
  ] as const)(
    'rejects invalid %s=%s before printing the listening line',
    async (optionName, value, message) => {
      tmpDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qws-rate-opt-')),
      );
      const stdoutWrites: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdoutWrites.push(String(chunk));
        return true;
      });

      await expect(
        runQwenServe({
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          rateLimit: true,
          [optionName]: value,
        }),
      ).rejects.toThrow(message);
      expect(stdoutWrites.join('')).not.toContain('qwen serve listening on');
    },
  );

  it('rejects an injected bridge with multiple explicit workspaces before listening', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-bridge-opt-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    await expect(
      runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: [primary, secondary],
        },
        { bridge: makeRuntimeBridge() },
      ),
    ).rejects.toThrow(/Injected bridge dependencies/);
    expect(stdoutWrites.join('')).not.toContain('qwen serve listening on');
  });

  it.each(['root', 'child', 'missing-child', 'alias'] as const)(
    'rejects an explicit Conversations reserved %s before listening',
    async (candidateKind) => {
      tmpDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qws-reserved-workspace-')),
      );
      const liveConversationWorkspace = new ConversationWorkspace({
        homeDir: tmpDir,
      });
      fs.mkdirSync(liveConversationWorkspace.rootPath, { recursive: true });
      const child = path.join(liveConversationWorkspace.rootPath, 'session-1');
      fs.mkdirSync(child);
      const missingChild = path.join(
        liveConversationWorkspace.rootPath,
        'missing-session',
      );
      const alias = path.join(tmpDir, 'conversation-alias');
      fs.symlinkSync(
        liveConversationWorkspace.rootPath,
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const workspace =
        candidateKind === 'root'
          ? liveConversationWorkspace.rootPath
          : candidateKind === 'child'
            ? child
            : candidateKind === 'missing-child'
              ? missingChild
              : alias;
      const stdoutWrites: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdoutWrites.push(String(chunk));
        return true;
      });

      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace,
          },
          { liveConversationWorkspace },
        ),
      ).rejects.toThrow(/reserved for Conversations/);
      expect(stdoutWrites.join('')).not.toContain('qwen serve listening on');
    },
  );

  it('rejects an unknown embedded external Tool Guard mode before listening', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-guard-opt-')),
    );
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    process.env['QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN'] = 'ambient-secret';

    await expect(
      runQwenServe({
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        externalToolGuard: {
          mode: 'optional',
        },
      } as unknown as Parameters<typeof runQwenServe>[0]),
    ).rejects.toThrow(/externalToolGuard/);
    expect(stdoutWrites.join('')).not.toContain('qwen serve listening on');
    expect(process.env['QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN']).toBeUndefined();
  });

  it('rejects unsafe required provider configuration before listening', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-guard-config-')),
    );
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    await expect(
      runQwenServe({
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        externalToolGuard: {
          mode: 'required',
          endpoint: 'https://policy.example.com',
          token: 'secret',
        },
      }),
    ).rejects.toThrow(/loopback/);
    expect(stdoutWrites.join('')).not.toContain('qwen serve listening on');
  });
});

describe('runQwenServe session reaper timeout validation', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeFakeBridge(): HttpAcpBridge {
    return {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
      getSession: vi.fn(),
      getAllSessions: vi.fn().mockReturnValue([]),
      publishWorkspaceEvent: vi.fn(),
      getEventRing: vi.fn().mockReturnValue({ getAll: () => [] }),
      resume: vi.fn(),
      preheat: vi.fn().mockResolvedValue(undefined),
    } as unknown as HttpAcpBridge;
  }

  async function runWithReaperOption(
    optionName: 'sessionReapIntervalMs' | 'sessionIdleTimeoutMs',
    value: number,
  ) {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-rt-')));
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      return await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          maxSessions: 1,
          [optionName]: value,
        },
        { bridge: makeFakeBridge() },
      );
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  }

  it.each([
    ['sessionReapIntervalMs', -1],
    ['sessionReapIntervalMs', 1.5],
    ['sessionReapIntervalMs', Number.NaN],
    ['sessionReapIntervalMs', Number.POSITIVE_INFINITY],
    ['sessionIdleTimeoutMs', -1],
    ['sessionIdleTimeoutMs', 1.5],
    ['sessionIdleTimeoutMs', Number.NaN],
    ['sessionIdleTimeoutMs', Number.POSITIVE_INFINITY],
  ] as const)('rejects invalid %s=%s', async (optionName, value) => {
    await expect(runWithReaperOption(optionName, value)).rejects.toThrow(
      optionName,
    );
  });

  it.each([
    ['sessionReapIntervalMs', 0],
    ['sessionIdleTimeoutMs', 0],
  ] as const)(
    'keeps %s=0 as the disabled sentinel',
    async (optionName, value) => {
      const handle = await runWithReaperOption(optionName, value);
      await handle.close();
    },
  );
});

describe('runQwenServe runtime startup failures', () => {
  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  async function readBrowserMcpFeatureFlagsForEnv(
    raw: string | undefined,
    origin = 'chrome-extension://qwen-test-extension',
    cdpMcpCommand?: string,
  ) {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-fail-')),
    );
    const originalClientMcpOverWs =
      process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'];
    const originalCdpTunnelOverWs =
      process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
    const originalCdpMcpCommand = process.env['QWEN_CDP_MCP_COMMAND'];
    if (raw === undefined) {
      delete process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'];
      delete process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
    } else {
      process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'] = raw;
      process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'] = raw;
    }
    if (cdpMcpCommand === undefined) {
      delete process.env['QWEN_CDP_MCP_COMMAND'];
    } else {
      process.env['QWEN_CDP_MCP_COMMAND'] = cdpMcpCommand;
    }
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() => {
      throw new Error('runtime boom');
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        allowOrigins: [origin],
      },
      { resolveOnListen: true },
    );

    try {
      await expect(handle.runtimeReady).rejects.toThrow('runtime boom');
      const capabilitiesRes = await fetch(`${handle.url}/capabilities`, {
        headers: { Origin: origin },
      });
      expect(capabilitiesRes.status).toBe(200);
      return ((await capabilitiesRes.json()) as { features: string[] })
        .features;
    } finally {
      if (originalClientMcpOverWs === undefined) {
        delete process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'];
      } else {
        process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'] = originalClientMcpOverWs;
      }
      if (originalCdpTunnelOverWs === undefined) {
        delete process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
      } else {
        process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'] = originalCdpTunnelOverWs;
      }
      if (originalCdpMcpCommand === undefined) {
        delete process.env['QWEN_CDP_MCP_COMMAND'];
      } else {
        process.env['QWEN_CDP_MCP_COMMAND'] = originalCdpMcpCommand;
      }
      await handle.close();
    }
  }

  it('keeps the primary bridge reference from the reconciled startup generation', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-trust-race-')),
    );
    const bootSnapshot = {
      revision: 'boot-untrusted',
      folderTrustEnabled: true,
      ideTrust: undefined,
      trustedFolders: {},
    } as Awaited<
      ReturnType<typeof trustPolicyRuntime.readDaemonTrustPolicySnapshot>
    >;
    const reconciledSnapshot = {
      revision: 'reconciled-trusted',
      folderTrustEnabled: false,
      ideTrust: undefined,
      trustedFolders: {},
    } as Awaited<
      ReturnType<typeof trustPolicyRuntime.readDaemonTrustPolicySnapshot>
    >;
    vi.spyOn(trustPolicyRuntime, 'readDaemonTrustPolicySnapshot')
      .mockResolvedValueOnce(bootSnapshot)
      .mockResolvedValue(reconciledSnapshot);
    const loadSettings = vi.spyOn(settingsRuntime, 'loadSettings');
    const bootBridge = makeRuntimeBridge();
    const reconciledBridge = makeRuntimeBridge();
    vi.spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValueOnce(
        bootBridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      )
      .mockReturnValueOnce(
        reconciledBridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    try {
      await handle.runtimeReady;
      vi.mocked(bootBridge.preheat).mockClear();
      vi.mocked(reconciledBridge.preheat).mockClear();
      await handle.bridge.preheat();

      expect(bootBridge.shutdown).toHaveBeenCalledTimes(1);
      expect(bootBridge.preheat).not.toHaveBeenCalled();
      expect(reconciledBridge.preheat).toHaveBeenCalledTimes(1);
      expect(loadSettings).toHaveBeenCalledWith(
        tmpDir,
        expect.objectContaining({ workspaceTrusted: true }),
      );
    } finally {
      await handle.close();
    }
  });

  it('does not expose the disposed primary bridge after reconciliation blocks', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-trust-blocked-')),
    );
    const trustedSnapshot = {
      revision: 'trusted',
      folderTrustEnabled: false,
      ideTrust: undefined,
      trustedFolders: {},
    } as Awaited<
      ReturnType<typeof trustPolicyRuntime.readDaemonTrustPolicySnapshot>
    >;
    const untrustedSnapshot = {
      revision: 'untrusted',
      folderTrustEnabled: true,
      ideTrust: undefined,
      trustedFolders: {},
    } as Awaited<
      ReturnType<typeof trustPolicyRuntime.readDaemonTrustPolicySnapshot>
    >;
    let currentSnapshot = trustedSnapshot;
    vi.spyOn(
      trustPolicyRuntime,
      'readDaemonTrustPolicySnapshot',
    ).mockImplementation(async () => currentSnapshot);
    const bootBridge = makeRuntimeBridge();
    vi.spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValueOnce(
        bootBridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      )
      .mockImplementationOnce(() => {
        throw new Error('replacement failed');
      });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    try {
      await handle.runtimeReady;
      vi.mocked(bootBridge.preheat).mockClear();
      currentSnapshot = untrustedSnapshot;
      qwenCore.ideContextStore.set({
        workspaceState: { isTrusted: false },
      });
      await vi.waitFor(() =>
        expect(bootBridge.shutdown).toHaveBeenCalledTimes(1),
      );

      expect(() => handle.bridge.preheat()).toThrow(
        'Daemon bridge runtime is still starting.',
      );
      expect(bootBridge.preheat).not.toHaveBeenCalled();
    } finally {
      qwenCore.ideContextStore.clear();
      await handle.close();
    }
  });

  it('disposes ACP routing when runtime containment fails', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-acp-cleanup-')),
    );
    const trustedSnapshot = {
      revision: 'trusted',
      folderTrustEnabled: false,
      ideTrust: undefined,
      trustedFolders: {},
    } as Awaited<
      ReturnType<typeof trustPolicyRuntime.readDaemonTrustPolicySnapshot>
    >;
    const untrustedSnapshot = {
      revision: 'untrusted',
      folderTrustEnabled: true,
      ideTrust: undefined,
      trustedFolders: {},
    } as Awaited<
      ReturnType<typeof trustPolicyRuntime.readDaemonTrustPolicySnapshot>
    >;
    let currentSnapshot = trustedSnapshot;
    vi.spyOn(
      trustPolicyRuntime,
      'readDaemonTrustPolicySnapshot',
    ).mockImplementation(async () => currentSnapshot);
    const bootBridge = makeRuntimeBridge();
    vi.mocked(bootBridge.shutdown)
      .mockRejectedValueOnce(new Error('shutdown failed'))
      .mockResolvedValue(undefined);
    vi.mocked(bootBridge.killAllSync).mockImplementationOnce(() => {
      throw new Error('kill failed');
    });
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bootBridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    let disposeWorkspace:
      | ReturnType<typeof vi.fn<(workspaceId: string) => void>>
      | undefined;
    const originalCreateServeApp = serverModule.createServeApp;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      const app = originalCreateServeApp(...args);
      const acpHandle = app.locals['acpHandle'] as
        | { disposeWorkspace?: (workspaceId: string) => void }
        | undefined;
      if (acpHandle?.disposeWorkspace) {
        disposeWorkspace = vi.fn(acpHandle.disposeWorkspace);
        acpHandle.disposeWorkspace = disposeWorkspace;
      }
      return app;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    try {
      await handle.runtimeReady;
      expect(disposeWorkspace).toBeDefined();
      currentSnapshot = untrustedSnapshot;
      qwenCore.ideContextStore.set({
        workspaceState: { isTrusted: false },
      });
      await vi.waitFor(() => expect(disposeWorkspace).toHaveBeenCalledOnce());
    } finally {
      qwenCore.ideContextStore.clear();
      await handle.close();
    }
  });

  it('rejects the embedded run handle by default when the runtime fails to mount', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-fail-')),
    );
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() => {
      throw new Error('runtime boom');
    });

    await expect(
      runQwenServe({
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      }),
    ).rejects.toThrow('runtime boom');
  });

  it('closes the listener before rejecting when resolveOnListen is false and runtime startup fails', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-fail-close-')),
    );
    const port = await getFreeLoopbackPort();
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() => {
      throw new Error('runtime boom');
    });

    await expect(
      runQwenServe({
        port,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      }),
    ).rejects.toThrow('runtime boom');

    await expect(
      fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow();
  });

  it.each([
    ['0', false],
    ['false', false],
    ['FALSE', false],
    [' 0 ', false],
    ['1', true],
    ['true', true],
    ['anything', true],
  ] as const)(
    'normalizes browser MCP env flag %j',
    async (raw, shouldEnable) => {
      const features = await readBrowserMcpFeatureFlagsForEnv(raw);

      if (shouldEnable) {
        expect(features).toEqual(
          expect.arrayContaining(['client_mcp_over_ws', 'cdp_tunnel_over_ws']),
        );
      } else {
        expect(features).not.toContain('client_mcp_over_ws');
        expect(features).not.toContain('cdp_tunnel_over_ws');
      }
    },
  );

  it('auto-enables only the CDP tunnel for Chrome extension origins when the env flag is unset', async () => {
    const features = await readBrowserMcpFeatureFlagsForEnv(undefined);

    expect(features).toContain('cdp_tunnel_over_ws');
    expect(features).not.toContain('client_mcp_over_ws');
    expect(features).not.toContain('browser_automation_mcp');
  });

  it('advertises browser automation MCP when the external CDP adapter command is set', async () => {
    const features = await readBrowserMcpFeatureFlagsForEnv(
      undefined,
      'chrome-extension://qwen-test-extension',
      '/opt/qwen-cdp-mcp-adapter',
    );

    expect(features).toContain('cdp_tunnel_over_ws');
    expect(features).toContain('browser_automation_mcp');
    expect(features).not.toContain('client_mcp_over_ws');
  });

  it('does not advertise browser automation MCP without an active CDP tunnel', async () => {
    const features = await readBrowserMcpFeatureFlagsForEnv(
      undefined,
      'http://localhost:5173',
      '/opt/qwen-cdp-mcp-adapter',
    );

    expect(features).not.toContain('browser_automation_mcp');
  });

  it('does not enable browser automation MCP on bearer-protected endpoints', () => {
    expect(
      isBrowserAutomationMcpAvailable(
        {
          cdpTunnelOverWs: true,
          token: 'secret-token',
        },
        {},
      ),
    ).toBe(false);
  });

  it('forwards auto-enabled CDP tunnel state to the ACP child env', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-child-env-')),
    );
    const originalClientMcpOverWs =
      process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'];
    const originalCdpTunnelOverWs =
      process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
    delete process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'];
    delete process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        allowOrigins: ['chrome-extension://qwen-test-extension'],
      },
      { resolveOnListen: true },
    );

    try {
      await handle.runtimeReady;
      const bridgeOptions = createBridge.mock.calls[0]?.[0] as
        | {
            childEnvOverrides?: Record<string, string | undefined>;
            externalToolGuard?: unknown;
          }
        | undefined;
      expect(bridgeOptions?.childEnvOverrides).toMatchObject({
        QWEN_SERVE_CDP_TUNNEL_OVER_WS: '1',
        QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD: 'required-v1',
      });
      // No external provider is configured in this test: the child must see
      // the guard plumbing marker but NOT the provider-attached marker.
      expect(bridgeOptions?.childEnvOverrides).toHaveProperty(
        'QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER',
        undefined,
      );
      expect(createBridge.mock.calls.length).toBeGreaterThan(0);
      for (const call of createBridge.mock.calls) {
        const options = call[0] as { externalToolGuard?: unknown };
        expect(options.externalToolGuard).toEqual(expect.any(Function));
      }
      const daemonGuard = bridgeOptions?.externalToolGuard as (
        request: Record<string, unknown>,
      ) => Promise<{ allowed: boolean; reason?: string }>;
      await expect(
        daemonGuard({
          sessionId: 'session-1',
          promptId: 'prompt-1',
          toolCallId: 'call-1',
          toolName: 'run_shell_command',
          arguments: {
            command: `git -C ${path.join(os.tmpdir(), 'outside-repo')} reset --hard`,
          },
          effectiveCwd: tmpDir,
        }),
      ).resolves.toMatchObject({ allowed: false });
    } finally {
      if (originalClientMcpOverWs === undefined) {
        delete process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'];
      } else {
        process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'] = originalClientMcpOverWs;
      }
      if (originalCdpTunnelOverWs === undefined) {
        delete process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
      } else {
        process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'] = originalCdpTunnelOverWs;
      }
      await handle.close();
    }
  });

  // The negative side of the provider marker is asserted above. This is the
  // attached side, driven by a real handshake against a loopback provider so
  // the marker, the composed guard and the child env are all exercised.
  it('forwards the provider-attached marker when a real provider handshakes', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-guard-provider-')),
    );
    const provider = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          protocolVersion: number;
          nonce?: string;
        };
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            protocolVersion: body.protocolVersion,
            nonce: body.nonce,
            capabilities: { prepare: true },
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, '127.0.0.1', resolve),
    );
    const { port } = provider.address() as import('node:net').AddressInfo;
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        externalToolGuard: {
          mode: 'required',
          endpoint: `http://127.0.0.1:${port}`,
          token: 'guard-token',
        },
      } as Parameters<typeof runQwenServe>[0],
      { resolveOnListen: true },
    );

    try {
      await handle.runtimeReady;
      const bridgeOptions = createBridge.mock.calls[0]?.[0] as
        | {
            childEnvOverrides?: Record<string, string | undefined>;
            externalToolGuard?: unknown;
          }
        | undefined;
      expect(bridgeOptions?.childEnvOverrides).toMatchObject({
        QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD: 'required-v1',
        QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER: 'attached-v1',
      });
      expect(bridgeOptions?.externalToolGuard).toEqual(expect.any(Function));
    } finally {
      await handle.close();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });

  it.each([
    [
      'defaults every runtime to workspace project-memory scope',
      undefined,
      undefined,
      'workspace',
    ],
    [
      'applies memoryProjectScope to every runtime without mutating process.env',
      'workspace',
      'git-root',
      'git-root',
    ],
    [
      'preserves the launch environment scope when the option is omitted',
      'git-root',
      undefined,
      'git-root',
    ],
    [
      'treats a blank launch environment scope as unset',
      '',
      undefined,
      'workspace',
    ],
    [
      'treats a whitespace-only launch environment scope as unset',
      '   ',
      undefined,
      'workspace',
    ],
    [
      'passes an unrecognized launch environment scope through unchanged',
      'workspce',
      undefined,
      'workspce',
    ],
  ] as const)('%s', async (_name, launchScope, optionScope, expectedScope) => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-memory-project-scope-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const originalScope = process.env['QWEN_CODE_MEMORY_PROJECT_SCOPE'];
    if (launchScope === undefined) {
      delete process.env['QWEN_CODE_MEMORY_PROJECT_SCOPE'];
    } else {
      process.env['QWEN_CODE_MEMORY_PROJECT_SCOPE'] = launchScope;
    }
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: {},
    } as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    vi.spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValueOnce(
        makeRuntimeBridge() as ReturnType<
          typeof acpBridge.createAcpSessionBridge
        >,
      )
      .mockReturnValueOnce(
        makeRuntimeBridge() as ReturnType<
          typeof acpBridge.createAcpSessionBridge
        >,
      );
    let workspaceRegistry:
      | import('./workspace-registry.js').WorkspaceRegistry
      | undefined;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(
      (_opts, _getPort, deps) => {
        workspaceRegistry = deps?.workspaceRegistry;
        return express();
      },
    );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, secondary],
        ...(optionScope === undefined
          ? {}
          : { memoryProjectScope: optionScope }),
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    try {
      await handle.runtimeReady;
      expect(workspaceRegistry?.list()).toHaveLength(2);
      for (const runtime of workspaceRegistry?.list() ?? []) {
        expect(
          runtime.env.effectiveEnv?.['QWEN_CODE_MEMORY_PROJECT_SCOPE'],
        ).toBe(expectedScope);
      }
      expect(process.env['QWEN_CODE_MEMORY_PROJECT_SCOPE']).toBe(launchScope);
    } finally {
      if (originalScope === undefined) {
        delete process.env['QWEN_CODE_MEMORY_PROJECT_SCOPE'];
      } else {
        process.env['QWEN_CODE_MEMORY_PROJECT_SCOPE'] = originalScope;
      }
      await handle.close();
    }
  });

  it('rebuilds runtime env from the immutable daemon base after workspace reload', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-env-reload-')),
    );
    const originalRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    delete process.env['QWEN_RUNTIME_DIR'];
    const originalBase = process.env['QWEN_TEST_BOOT_BASE'];
    const originalLeak = process.env['QWEN_TEST_RELOAD_LEAK'];
    const originalRemoved = process.env['QWEN_TEST_REMOVED_FROM_DOTENV'];
    process.env['QWEN_TEST_BOOT_BASE'] = 'base';
    process.env['QWEN_TEST_REMOVED_FROM_DOTENV'] = 'stale';
    delete process.env['QWEN_TEST_RELOAD_LEAK'];

    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    let runtimeMounted = false;
    let reloadedRuntimeValue = 'reloaded';
    vi.spyOn(settingsRuntime, 'loadSettings').mockImplementation(
      () =>
        ({
          merged: {
            tools: { workflowsEnabled: !runtimeMounted },
            advanced: {
              runtimeOutputDir: runtimeMounted
                ? '.runtime-reloaded'
                : '.runtime-boot',
            },
            env: {
              QWEN_TEST_RUNTIME_VALUE: runtimeMounted
                ? reloadedRuntimeValue
                : 'boot',
            },
          },
        }) as unknown as ReturnType<typeof settingsRuntime.loadSettings>,
    );
    vi.spyOn(settingsRuntime, 'reloadEnvironment').mockImplementation(() => {
      process.env['QWEN_TEST_RELOAD_LEAK'] = 'workspace-a';
      delete process.env['QWEN_TEST_REMOVED_FROM_DOTENV'];
      return {
        updatedKeys: ['QWEN_TEST_RELOAD_LEAK'],
        removedKeys: ['QWEN_TEST_REMOVED_FROM_DOTENV'],
      };
    });
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    const buildRuntimeEnvironment = vi.spyOn(
      environmentRuntime,
      'buildRuntimeEnvironment',
    );
    let workspace:
      | {
          reload(ctx: {
            route: string;
            workspaceCwd: string;
          }): Promise<unknown>;
          reloadModelProviders(ctx: {
            route: string;
            workspaceCwd: string;
          }): Promise<unknown>;
        }
      | undefined;
    let primaryRuntimeEnv:
      | {
          effectiveEnv?: NodeJS.ProcessEnv;
        }
      | undefined;
    let primaryRuntime:
      | import('./workspace-registry.js').WorkspaceRuntime
      | undefined;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(
      (_opts, _getPort, deps) => {
        runtimeMounted = true;
        workspace = deps?.workspace as typeof workspace;
        primaryRuntimeEnv = deps?.primaryRuntimeEnv as typeof primaryRuntimeEnv;
        primaryRuntime = deps?.workspaceRegistry?.primary;
        return express();
      },
    );

    const bridge = makeRuntimeBridge();

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge,
        bootSettings: {},
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        resolveOnListen: true,
      },
    );

    try {
      await handle.runtimeReady;
      expect(workspace).toBeDefined();
      expect(primaryRuntimeEnv?.effectiveEnv).toBeDefined();
      const capturedRuntimeEnv = primaryRuntimeEnv!.effectiveEnv!;
      expect(capturedRuntimeEnv['QWEN_TEST_RUNTIME_VALUE']).toBe('boot');
      const pinnedRuntimeBaseDir = path.join(tmpDir, '.runtime-boot');
      expect(primaryRuntime?.sessionRuntimeBaseDir).toBe(pinnedRuntimeBaseDir);
      expect(capturedRuntimeEnv['QWEN_RUNTIME_DIR']).toBe(pinnedRuntimeBaseDir);
      expect(primaryRuntime?.env.workflowsEnabledBySettings).toBe(true);

      await workspace!.reload({
        route: 'POST /workspace/reload',
        workspaceCwd: tmpDir,
      });

      const reloadBaseEnv = buildRuntimeEnvironment.mock.calls.at(-1)?.[2];
      expect(reloadBaseEnv?.['QWEN_TEST_BOOT_BASE']).toBe('base');
      expect(reloadBaseEnv?.['QWEN_TEST_REMOVED_FROM_DOTENV']).toBe('stale');
      expect(reloadBaseEnv?.['QWEN_TEST_RELOAD_LEAK']).toBeUndefined();
      expect(primaryRuntimeEnv!.effectiveEnv).toBe(capturedRuntimeEnv);
      expect(capturedRuntimeEnv['QWEN_TEST_RUNTIME_VALUE']).toBe('reloaded');
      expect(capturedRuntimeEnv['QWEN_TEST_REMOVED_FROM_DOTENV']).toBe('stale');
      expect(capturedRuntimeEnv['QWEN_TEST_RELOAD_LEAK']).toBeUndefined();
      expect(primaryRuntime?.sessionRuntimeBaseDir).toBe(pinnedRuntimeBaseDir);
      expect(capturedRuntimeEnv['QWEN_RUNTIME_DIR']).toBe(pinnedRuntimeBaseDir);
      expect(primaryRuntime?.env.workflowsEnabledBySettings).toBe(false);

      reloadedRuntimeValue = 'hot-synced';
      await expect(
        workspace!.reloadModelProviders({
          route: 'POST /workspace/auth/provider',
          workspaceCwd: tmpDir,
        }),
      ).resolves.toEqual({ status: 'applied' });
      expect(capturedRuntimeEnv['QWEN_TEST_RUNTIME_VALUE']).toBe('hot-synced');
      expect(bridge.invokeWorkspaceCommand).toHaveBeenCalledWith(
        'qwen/control/workspace/model-providers/reload',
        { cwd: tmpDir },
        { timeoutMs: 30_000 },
      );
      expect(primaryRuntime?.sessionRuntimeBaseDir).toBe(pinnedRuntimeBaseDir);
      expect(capturedRuntimeEnv['QWEN_RUNTIME_DIR']).toBe(pinnedRuntimeBaseDir);

      vi.mocked(bridge.invokeWorkspaceCommand).mockRejectedValueOnce(
        new SessionNotFoundError(tmpDir),
      );
      await expect(
        workspace!.reloadModelProviders({
          route: 'POST /workspace/auth/provider',
          workspaceCwd: tmpDir,
        }),
      ).resolves.toEqual({ status: 'deferred' });
      vi.mocked(bridge.invokeWorkspaceCommand).mockResolvedValueOnce({
        configsFailed: 1,
      });
      await expect(
        workspace!.reloadModelProviders({
          route: 'POST /workspace/auth/provider',
          workspaceCwd: tmpDir,
        }),
      ).resolves.toEqual({ status: 'failed' });
      vi.mocked(bridge.invokeWorkspaceCommand).mockRejectedValueOnce(
        new Error('child reload failed'),
      );
      await expect(
        workspace!.reloadModelProviders({
          route: 'POST /workspace/auth/provider',
          workspaceCwd: tmpDir,
        }),
      ).resolves.toEqual({ status: 'failed' });
    } finally {
      if (originalBase === undefined) {
        delete process.env['QWEN_TEST_BOOT_BASE'];
      } else {
        process.env['QWEN_TEST_BOOT_BASE'] = originalBase;
      }
      if (originalLeak === undefined) {
        delete process.env['QWEN_TEST_RELOAD_LEAK'];
      } else {
        process.env['QWEN_TEST_RELOAD_LEAK'] = originalLeak;
      }
      if (originalRemoved === undefined) {
        delete process.env['QWEN_TEST_REMOVED_FROM_DOTENV'];
      } else {
        process.env['QWEN_TEST_REMOVED_FROM_DOTENV'] = originalRemoved;
      }
      if (originalRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = originalRuntimeDir;
      }
      await handle.close();
    }
  });

  it('preserves previous runtime env and marks fallback when reload env rebuild fails', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-env-fallback-')),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    let runtimeMounted = false;
    vi.spyOn(settingsRuntime, 'loadSettings').mockImplementation(
      () =>
        ({
          merged: {
            env: {
              QWEN_TEST_RUNTIME_VALUE: runtimeMounted ? 'reloaded' : 'boot',
            },
          },
        }) as unknown as ReturnType<typeof settingsRuntime.loadSettings>,
    );
    let failReloadRead = false;
    const reloadEnvironment = vi
      .spyOn(settingsRuntime, 'reloadEnvironment')
      .mockImplementation(() => ({
        updatedKeys: [],
        removedKeys: [],
        ...(failReloadRead ? { envFileReadFailed: true } : {}),
      }));
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    const buildRuntimeEnvironmentActual =
      environmentRuntime.buildRuntimeEnvironment;
    let failReloadBuild = false;
    let failEnvFileRead = false;
    vi.spyOn(environmentRuntime, 'buildRuntimeEnvironment').mockImplementation(
      (
        ...args: Parameters<typeof environmentRuntime.buildRuntimeEnvironment>
      ) => {
        if (failReloadBuild) {
          throw new Error('runtime env rebuild failed');
        }
        const result = buildRuntimeEnvironmentActual(...args);
        return failEnvFileRead
          ? {
              ...result,
              envFileReadFailed: true,
              envFileReadFailures: [
                { path: path.join(tmpDir, '.env'), error: 'read failed' },
              ],
            }
          : result;
      },
    );
    let workspace:
      | {
          reload(ctx: {
            route: string;
            workspaceCwd: string;
          }): Promise<unknown>;
          reloadModelProviders(ctx: {
            route: string;
            workspaceCwd: string;
          }): Promise<unknown>;
        }
      | undefined;
    let primaryRuntimeEnv:
      | {
          effectiveEnv?: NodeJS.ProcessEnv;
          fallbackReason?: string;
        }
      | undefined;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(
      (_opts, _getPort, deps) => {
        runtimeMounted = true;
        workspace = deps?.workspace as typeof workspace;
        primaryRuntimeEnv = deps?.primaryRuntimeEnv as typeof primaryRuntimeEnv;
        return express();
      },
    );

    const logBaseDir = path.join(tmpDir, 'debug');
    const bridge = makeRuntimeBridge();
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge,
        bootSettings: {},
        daemonLogBaseDir: logBaseDir,
        resolveOnListen: true,
      },
    );

    let closed = false;
    try {
      await handle.runtimeReady;
      expect(workspace).toBeDefined();
      expect(primaryRuntimeEnv?.effectiveEnv).toBeDefined();
      const capturedRuntimeEnv = primaryRuntimeEnv!.effectiveEnv!;
      expect(capturedRuntimeEnv['QWEN_TEST_RUNTIME_VALUE']).toBe('boot');

      failReloadBuild = true;
      await expect(
        workspace!.reloadModelProviders({
          route: 'POST /workspace/auth/provider',
          workspaceCwd: tmpDir,
        }),
      ).resolves.toEqual({ status: 'failed' });
      expect(reloadEnvironment).not.toHaveBeenCalled();
      await expect(
        workspace!.reload({
          route: 'POST /workspace/reload',
          workspaceCwd: tmpDir,
        }),
      ).resolves.toMatchObject({ runtimeEnvironmentApplied: false });
      expect(reloadEnvironment).not.toHaveBeenCalled();

      expect(primaryRuntimeEnv!.effectiveEnv).toBe(capturedRuntimeEnv);
      expect(capturedRuntimeEnv['QWEN_TEST_RUNTIME_VALUE']).toBe('boot');
      expect(primaryRuntimeEnv!.fallbackReason).toBe(
        'runtime env rebuild failed',
      );

      failReloadBuild = false;
      await expect(
        workspace!.reload({
          route: 'POST /workspace/reload',
          workspaceCwd: tmpDir,
        }),
      ).resolves.toMatchObject({ runtimeEnvironmentApplied: true });
      expect(reloadEnvironment).toHaveBeenCalledOnce();
      expect(primaryRuntimeEnv!.effectiveEnv).toBe(capturedRuntimeEnv);
      expect(capturedRuntimeEnv['QWEN_TEST_RUNTIME_VALUE']).toBe('reloaded');
      expect(primaryRuntimeEnv!.fallbackReason).toBeUndefined();

      failReloadRead = true;
      await expect(
        workspace!.reloadModelProviders({
          route: 'POST /workspace/auth/provider',
          workspaceCwd: tmpDir,
        }),
      ).resolves.toEqual({ status: 'failed' });
      expect(reloadEnvironment).toHaveBeenCalledTimes(2);
      expect(reloadEnvironment).toHaveBeenLastCalledWith(
        expect.any(Object),
        tmpDir,
        true,
        { failClosedOnEnvFileReadError: true },
      );
      expect(capturedRuntimeEnv['QWEN_TEST_RUNTIME_VALUE']).toBe('reloaded');

      failReloadRead = false;
      failEnvFileRead = true;
      await expect(
        workspace!.reloadModelProviders({
          route: 'POST /workspace/auth/provider',
          workspaceCwd: tmpDir,
        }),
      ).resolves.toEqual({ status: 'failed' });
      expect(reloadEnvironment).toHaveBeenCalledTimes(2);
      expect(primaryRuntimeEnv!.effectiveEnv).toBe(capturedRuntimeEnv);
      expect(capturedRuntimeEnv['QWEN_TEST_RUNTIME_VALUE']).toBe('reloaded');
      expect(primaryRuntimeEnv!.fallbackReason).toBeUndefined();

      await handle.close();
      closed = true;
      const logPath = path.join(logBaseDir, 'daemon', 'daemon.log');
      const log = fs.readFileSync(logPath, 'utf8');
      expect(log).toContain(
        'failed to rebuild runtime env snapshot before daemon env reload; preserving previous runtime env',
      );
    } finally {
      if (!closed) {
        await handle.close();
      }
    }
  });

  it('updates secondary runtime env metadata in place after workspace reload', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-secondary-env-reload-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    const dynamic = path.join(tmpDir, 'dynamic');
    const originalRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    delete process.env['QWEN_RUNTIME_DIR'];
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    fs.mkdirSync(dynamic);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    let runtimeMounted = false;
    let dynamicReloaded = false;
    let providerRuntimeMutation = false;
    let failEnvFileRead = false;
    vi.spyOn(settingsRuntime, 'loadSettings').mockImplementation(
      (...args: Parameters<typeof settingsRuntime.loadSettings>) => {
        const workspace = args[0];
        const isSecondary = workspace === secondary;
        return {
          merged: {
            tools: {
              workflowsEnabled:
                workspace === dynamic ? !dynamicReloaded : !runtimeMounted,
            },
            advanced: {
              runtimeOutputDir: isSecondary
                ? runtimeMounted
                  ? '.secondary-runtime-reloaded'
                  : '.secondary-runtime-boot'
                : '.primary-runtime',
            },
            env: {
              [isSecondary
                ? 'QWEN_TEST_SECONDARY_ENV'
                : 'QWEN_TEST_PRIMARY_ENV']: runtimeMounted
                ? failEnvFileRead
                  ? 'partial'
                  : providerRuntimeMutation
                    ? 'provider-reloaded'
                    : 'reloaded'
                : 'boot',
            },
          },
        } as unknown as ReturnType<typeof settingsRuntime.loadSettings>;
      },
    );
    const reloadEnvironment = vi
      .spyOn(settingsRuntime, 'reloadEnvironment')
      .mockReturnValue({
        updatedKeys: ['QWEN_TEST_SECONDARY_ENV'],
        removedKeys: [],
      });
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    const buildRuntimeEnvironmentActual =
      environmentRuntime.buildRuntimeEnvironment;
    vi.spyOn(environmentRuntime, 'buildRuntimeEnvironment').mockImplementation(
      (
        ...args: Parameters<typeof environmentRuntime.buildRuntimeEnvironment>
      ) => {
        const result = buildRuntimeEnvironmentActual(...args);
        return failEnvFileRead
          ? {
              ...result,
              envFileReadFailed: true,
              envFileReadFailures: [
                { path: path.join(secondary, '.env'), error: 'read failed' },
              ],
            }
          : result;
      },
    );
    vi.spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValueOnce(
        makeRuntimeBridge() as ReturnType<
          typeof acpBridge.createAcpSessionBridge
        >,
      )
      .mockReturnValueOnce(
        makeRuntimeBridge() as ReturnType<
          typeof acpBridge.createAcpSessionBridge
        >,
      );
    let workspaceRegistry:
      | import('./workspace-registry.js').WorkspaceRegistry
      | undefined;
    let createWorkspaceRuntime:
      | ((
          cwd: string,
          options: { provenance: WorkspaceRuntimeProvenance },
        ) => Promise<import('./workspace-registry.js').WorkspaceRuntime>)
      | undefined;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(
      (_opts, _getPort, deps) => {
        runtimeMounted = true;
        workspaceRegistry = deps?.workspaceRegistry;
        createWorkspaceRuntime = deps?.createWorkspaceRuntime;
        return express();
      },
    );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, secondary],
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    try {
      await handle.runtimeReady;
      const secondaryRuntime = workspaceRegistry
        ?.list()
        .find((runtime) => runtime.workspaceCwd === secondary);
      expect(secondaryRuntime).toBeDefined();
      const env = secondaryRuntime!.env;
      const overlayKeys = env.overlayKeys;
      const envFilePaths = env.envFilePaths;
      const envFileReadFailures = env.envFileReadFailures;
      expect(env.effectiveEnv?.['QWEN_TEST_SECONDARY_ENV']).toBe('boot');
      const pinnedRuntimeBaseDir = path.join(
        secondary,
        '.secondary-runtime-boot',
      );
      expect(secondaryRuntime!.sessionRuntimeBaseDir).toBe(
        pinnedRuntimeBaseDir,
      );
      expect(env.effectiveEnv?.['QWEN_RUNTIME_DIR']).toBe(pinnedRuntimeBaseDir);
      expect(env.workflowsEnabledBySettings).toBe(true);

      await expect(
        secondaryRuntime!.workspaceService.reload({
          route: 'POST /workspace/reload',
          workspaceCwd: secondary,
        }),
      ).resolves.toMatchObject({ runtimeEnvironmentApplied: true });
      expect(reloadEnvironment).toHaveBeenCalledOnce();

      expect(env.overlayKeys).toBe(overlayKeys);
      expect(env.envFilePaths).toBe(envFilePaths);
      expect(env.envFileReadFailures).toBe(envFileReadFailures);
      expect(env.effectiveEnv?.['QWEN_TEST_SECONDARY_ENV']).toBe('reloaded');
      expect(secondaryRuntime!.sessionRuntimeBaseDir).toBe(
        pinnedRuntimeBaseDir,
      );
      expect(env.effectiveEnv?.['QWEN_RUNTIME_DIR']).toBe(pinnedRuntimeBaseDir);
      expect(env.workflowsEnabledBySettings).toBe(false);

      const dynamicRuntime = await createWorkspaceRuntime!(dynamic, {
        provenance: 'existing',
      });
      expect(dynamicRuntime.env.workflowsEnabledBySettings).toBe(true);
      dynamicReloaded = true;
      await dynamicRuntime.workspaceService.reload({
        route: 'POST /workspace/reload',
        workspaceCwd: dynamic,
      });
      expect(dynamicRuntime.env.workflowsEnabledBySettings).toBe(false);

      providerRuntimeMutation = true;
      await expect(
        secondaryRuntime!.workspaceService.reloadModelProviders({
          route: 'POST /workspace/auth/provider',
          workspaceCwd: secondary,
        }),
      ).resolves.toEqual({ status: 'applied' });
      expect(reloadEnvironment).toHaveBeenCalledTimes(2);
      expect(env.effectiveEnv?.['QWEN_TEST_SECONDARY_ENV']).toBe(
        'provider-reloaded',
      );

      failEnvFileRead = true;
      await expect(
        secondaryRuntime!.workspaceService.reload({
          route: 'POST /workspace/reload',
          workspaceCwd: secondary,
        }),
      ).resolves.toMatchObject({ runtimeEnvironmentApplied: false });
      expect(reloadEnvironment).toHaveBeenCalledTimes(2);
      expect(env.effectiveEnv?.['QWEN_TEST_SECONDARY_ENV']).toBe(
        'provider-reloaded',
      );
      expect(env.envFileReadFailed).toBe(false);
      expect(env.envFileReadFailures).toEqual([]);
    } finally {
      await handle.close();
      if (originalRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = originalRuntimeDir;
      }
    }
  });

  it('restores persisted workspaces through the normal secondary runtime path', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-restored-workspace-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const explicitSecondary = path.join(tmpDir, 'explicit-secondary');
    const restoredSecondary = path.join(tmpDir, 'restored-secondary');
    const nestedSecondary = path.join(explicitSecondary, 'nested');
    const liveConversationWorkspace = new ConversationWorkspace({
      homeDir: tmpDir,
    });
    const reservedConversationChild = path.join(
      liveConversationWorkspace.rootPath,
      'legacy-child',
    );
    const missingReservedConversationChild = path.join(
      liveConversationWorkspace.rootPath,
      'missing-legacy-child',
    );
    fs.mkdirSync(primary);
    fs.mkdirSync(explicitSecondary);
    fs.mkdirSync(restoredSecondary);
    fs.mkdirSync(nestedSecondary);
    fs.mkdirSync(reservedConversationChild, { recursive: true });
    const restoredSecondaryAlias = path.join(
      tmpDir,
      'restored-secondary-alias',
    );
    fs.symlinkSync(
      restoredSecondary,
      restoredSecondaryAlias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const canonicalPrimary = canonicalizeWorkspace(primary);
    const canonicalExplicitSecondary = canonicalizeWorkspace(explicitSecondary);
    const canonicalRestoredSecondary = canonicalizeWorkspace(restoredSecondary);
    const missingPersistedWorkspace = path.join(tmpDir, 'missing-secondary');
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: {},
    } as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => makeRuntimeBridge());
    let restoredCwds: string[] = [];
    let restoredDisplayNames: Array<string | undefined> = [];
    let restoredRemovable: Array<boolean | undefined> = [];
    let restoredRegistrationIds: Array<readonly string[] | undefined> = [];
    let advertisedMaxTotalSessions: number | undefined;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(
      (opts, _getPort, deps) => {
        restoredCwds =
          deps?.workspaceRegistry
            ?.list()
            .map((runtime) => runtime.workspaceCwd) ?? [];
        restoredDisplayNames =
          deps?.workspaceRegistry
            ?.list()
            .map((runtime) => runtime.displayName) ?? [];
        restoredRemovable =
          deps?.workspaceRegistry?.list().map((runtime) => runtime.removable) ??
          [];
        restoredRegistrationIds =
          deps?.workspaceRegistry
            ?.list()
            .map((runtime) => runtime.registrationIds) ?? [];
        advertisedMaxTotalSessions = opts.maxTotalSessions;
        return express();
      },
    );
    const store = {
      read: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        primaryWorkspace: canonicalPrimary,
        workspaces: [
          missingPersistedWorkspace,
          canonicalExplicitSecondary,
          nestedSecondary,
          restoredSecondaryAlias,
          canonicalRestoredSecondary,
          liveConversationWorkspace.rootPath,
          reservedConversationChild,
          missingReservedConversationChild,
        ],
        displayNames: {
          [workspaceRegistrationId(canonicalExplicitSecondary)]:
            'Explicit workspace',
          [workspaceRegistrationId(restoredSecondaryAlias)]:
            'Restored workspace',
          [workspaceRegistrationId(canonicalRestoredSecondary)]:
            'Later alias name',
        },
      }),
    } as unknown as WorkspaceRegistrationStore;

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, explicitSecondary],
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        workspaceRegistrationStore: store,
        liveConversationWorkspace,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        resolveOnListen: true,
      },
    );

    try {
      await handle.runtimeReady;
      expect(store.read).toHaveBeenCalledTimes(1);
      expect(restoredCwds).toEqual([
        canonicalPrimary,
        canonicalExplicitSecondary,
        canonicalRestoredSecondary,
      ]);
      expect(restoredDisplayNames).toEqual([
        undefined,
        'Explicit workspace',
        'Restored workspace',
      ]);
      expect(restoredRemovable).toEqual([false, false, true]);
      expect(restoredRegistrationIds).toEqual([
        [],
        [workspaceRegistrationId(canonicalExplicitSecondary)],
        [
          workspaceRegistrationId(restoredSecondaryAlias),
          workspaceRegistrationId(canonicalRestoredSecondary),
        ],
      ]);
      expect(createBridge).toHaveBeenCalledTimes(3);
      expect(advertisedMaxTotalSessions).toBe(3);
      expect(
        stderrWrite.mock.calls.some(([message]) =>
          String(message).includes(
            `skipping persisted workspace registration ${JSON.stringify(
              missingPersistedWorkspace,
            )}`,
          ),
        ),
      ).toBe(true);
      expect(
        stderrWrite.mock.calls.some(([message]) =>
          String(message).includes('path nests with an explicit'),
        ),
      ).toBe(true);
      expect(
        stderrWrite.mock.calls.filter(([message]) =>
          String(message).includes('path is reserved for Conversations'),
        ),
      ).toHaveLength(3);
    } finally {
      await handle.close();
    }
  });

  it('continues with explicit workspaces when the registration store read fails', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-restored-read-error-')),
    );
    const primary = path.join(tmpDir, 'primary');
    fs.mkdirSync(primary);
    const canonicalPrimary = canonicalizeWorkspace(primary);
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: {},
    } as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => makeRuntimeBridge());
    let restoredCwds: string[] = [];
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(
      (_opts, _getPort, deps) => {
        restoredCwds =
          deps?.workspaceRegistry
            ?.list()
            .map((runtime) => runtime.workspaceCwd) ?? [];
        return express();
      },
    );
    const store = {
      read: vi.fn().mockRejectedValue(new Error('store unavailable')),
    } as unknown as WorkspaceRegistrationStore;

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: primary,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        workspaceRegistrationStore: store,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        resolveOnListen: true,
      },
    );

    try {
      await handle.runtimeReady;
      expect(restoredCwds).toEqual([canonicalPrimary]);
      expect(createBridge).toHaveBeenCalledTimes(1);
      expect(
        stderrWrite.mock.calls.some(([message]) =>
          String(message).includes(
            'failed to read persisted workspace registrations',
          ),
        ),
      ).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('skips persisted workspaces after the runtime limit is reached', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-restored-limit-')),
    );
    const explicitWorkspaces = Array.from({ length: 25 }, (_, index) => {
      const workspace = path.join(tmpDir, `explicit-${index}`);
      fs.mkdirSync(workspace);
      return workspace;
    });
    const overflow = path.join(tmpDir, 'persisted-overflow');
    fs.mkdirSync(overflow);
    const canonicalExplicit = explicitWorkspaces.map((workspace) =>
      canonicalizeWorkspace(workspace),
    );
    const canonicalOverflow = canonicalizeWorkspace(overflow);
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: {},
    } as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => makeRuntimeBridge());
    let restoredCwds: string[] = [];
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(
      (_opts, _getPort, deps) => {
        restoredCwds =
          deps?.workspaceRegistry
            ?.list()
            .map((runtime) => runtime.workspaceCwd) ?? [];
        return express();
      },
    );
    const store = {
      read: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        primaryWorkspace: canonicalExplicit[0],
        workspaces: [canonicalOverflow],
      }),
    } as unknown as WorkspaceRegistrationStore;

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: explicitWorkspaces,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        workspaceRegistrationStore: store,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        resolveOnListen: true,
      },
    );

    try {
      await handle.runtimeReady;
      expect(restoredCwds).toEqual(canonicalExplicit);
      expect(createBridge).toHaveBeenCalledTimes(25);
      expect(
        stderrWrite.mock.calls.some(([message]) =>
          String(message).includes('workspace limit reached'),
        ),
      ).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('filters secondary workspace roots before constructing the bridge filesystem', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-roots-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const trustedSecondary = path.join(tmpDir, 'trusted-secondary');
    const untrustedSecondary = path.join(tmpDir, 'untrusted-secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(trustedSecondary);
    fs.mkdirSync(untrustedSecondary);
    const roots = [primary, trustedSecondary, untrustedSecondary].map((root) =>
      canonicalizeWorkspace(root),
    );
    const bridgeFsBoundWorkspaces: string[][] = [];
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: {},
    } as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(
      trustedFoldersRuntime,
      'getWorkspaceTrustStatus',
    ).mockImplementation(
      (_settings, workspace) =>
        ({
          effective: {
            state: workspace === untrustedSecondary ? 'untrusted' : 'trusted',
          },
        }) as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>,
    );
    vi.spyOn(
      trustPolicyRuntime,
      'evaluateDaemonWorkspaceTrust',
    ).mockImplementation(
      (_snapshot, workspace) =>
        ({
          state: workspace === roots[2] ? 'untrusted' : 'trusted',
          targetTrusted: workspace !== roots[2],
          source: 'file',
          explicitTrustLevel: null,
        }) as ReturnType<
          typeof trustPolicyRuntime.evaluateDaemonWorkspaceTrust
        >,
    );
    vi.spyOn(
      serverModule,
      'resolveBoundWorkspacesFromIdeEnv',
    ).mockImplementation((_primary, _ide, includeWorkspace) =>
      includeWorkspace === undefined ? roots : roots.filter(includeWorkspace),
    );
    vi.spyOn(serverModule, 'resolveBridgeFsFactory').mockImplementation(
      (input) => {
        bridgeFsBoundWorkspaces.push([...input.boundWorkspaces]);
        return {} as ReturnType<typeof serverModule.resolveBridgeFsFactory>;
      },
    );
    vi.spyOn(serverModule, 'createServeApp').mockReturnValue(express());

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: primary,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge: makeRuntimeBridge(),
        bootSettings: {},
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        resolveOnListen: true,
      },
    );

    try {
      await handle.runtimeReady;
      expect(bridgeFsBoundWorkspaces[0]).toEqual([roots[0], roots[1]]);
    } finally {
      await handle.close();
    }
  });

  it('keeps trusted child roots when an untrusted parent is filtered out', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-roots-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const untrustedParent = path.join(tmpDir, 'parent');
    const trustedChild = path.join(untrustedParent, 'trusted-child');
    fs.mkdirSync(primary);
    fs.mkdirSync(trustedChild, { recursive: true });
    const roots = [primary, untrustedParent, trustedChild].map((root) =>
      canonicalizeWorkspace(root),
    );
    const originalIdeWorkspacePath =
      process.env['QWEN_CODE_IDE_WORKSPACE_PATH'];
    process.env['QWEN_CODE_IDE_WORKSPACE_PATH'] = JSON.stringify(roots);
    const bridgeFsBoundWorkspaces: string[][] = [];
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: {},
    } as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(
      trustedFoldersRuntime,
      'getWorkspaceTrustStatus',
    ).mockImplementation(
      (_settings, workspace) =>
        ({
          effective: {
            state: workspace === roots[1] ? 'untrusted' : 'trusted',
          },
        }) as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>,
    );
    vi.spyOn(
      trustPolicyRuntime,
      'evaluateDaemonWorkspaceTrust',
    ).mockImplementation(
      (_snapshot, workspace) =>
        ({
          state: workspace === roots[1] ? 'untrusted' : 'trusted',
          targetTrusted: workspace !== roots[1],
          source: 'file',
          explicitTrustLevel: null,
        }) as ReturnType<
          typeof trustPolicyRuntime.evaluateDaemonWorkspaceTrust
        >,
    );
    vi.spyOn(serverModule, 'resolveBridgeFsFactory').mockImplementation(
      (input) => {
        bridgeFsBoundWorkspaces.push([...input.boundWorkspaces]);
        return {} as ReturnType<typeof serverModule.resolveBridgeFsFactory>;
      },
    );
    vi.spyOn(serverModule, 'createServeApp').mockReturnValue(express());

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: primary,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge: makeRuntimeBridge(),
        bootSettings: {},
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        resolveOnListen: true,
      },
    );

    try {
      await handle.runtimeReady;
      expect(bridgeFsBoundWorkspaces[0]).toEqual([roots[0], roots[2]]);
    } finally {
      if (originalIdeWorkspacePath === undefined) {
        delete process.env['QWEN_CODE_IDE_WORKSPACE_PATH'];
      } else {
        process.env['QWEN_CODE_IDE_WORKSPACE_PATH'] = originalIdeWorkspacePath;
      }
      await handle.close();
    }
  });

  it('shares one path lock registry across bridge and REST filesystem factories', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-roots-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const roots = [primary, secondary].map((root) =>
      canonicalizeWorkspace(root),
    );
    const pathLocks: unknown[] = [];
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: {},
    } as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    vi.spyOn(
      serverModule,
      'resolveBoundWorkspacesFromIdeEnv',
    ).mockImplementation((_primary, _ide, includeWorkspace) =>
      includeWorkspace === undefined ? roots : roots.filter(includeWorkspace),
    );
    vi.spyOn(serverModule, 'resolveBridgeFsFactory').mockImplementation(
      (input) => {
        pathLocks.push(input.pathLocks);
        return {} as ReturnType<typeof serverModule.resolveBridgeFsFactory>;
      },
    );
    vi.spyOn(serverModule, 'createServeApp').mockReturnValue(express());

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: primary,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge: makeRuntimeBridge(),
        bootSettings: {},
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        resolveOnListen: true,
      },
    );

    try {
      await handle.runtimeReady;
      expect(pathLocks).toHaveLength(2);
      expect(pathLocks[0]).toBeDefined();
      expect(pathLocks[0]).toBe(pathLocks[1]);
    } finally {
      await handle.close();
    }
  });

  it('excludes secondary workspace roots when runtime trust settings are unavailable', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-roots-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const roots = [primary, secondary].map((root) =>
      canonicalizeWorkspace(root),
    );
    const bridgeFsBoundWorkspaces: string[][] = [];
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockImplementation(() => {
      throw new Error('settings unavailable');
    });
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus');
    vi.spyOn(
      trustPolicyRuntime,
      'evaluateDaemonWorkspaceTrust',
    ).mockImplementation(
      (_snapshot, workspace) =>
        ({
          state: workspace === roots[0] ? 'trusted' : 'error',
          targetTrusted: workspace === roots[0],
          source: workspace === roots[0] ? 'file' : 'none',
          explicitTrustLevel: null,
        }) as ReturnType<
          typeof trustPolicyRuntime.evaluateDaemonWorkspaceTrust
        >,
    );
    vi.spyOn(
      serverModule,
      'resolveBoundWorkspacesFromIdeEnv',
    ).mockImplementation((_primary, _ide, includeWorkspace) =>
      includeWorkspace === undefined ? roots : roots.filter(includeWorkspace),
    );
    vi.spyOn(serverModule, 'resolveBridgeFsFactory').mockImplementation(
      (input) => {
        bridgeFsBoundWorkspaces.push([...input.boundWorkspaces]);
        return {} as ReturnType<typeof serverModule.resolveBridgeFsFactory>;
      },
    );
    vi.spyOn(serverModule, 'createServeApp').mockReturnValue(express());

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: primary,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge: makeRuntimeBridge(),
        bootSettings: {},
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        resolveOnListen: true,
      },
    );

    try {
      await handle.runtimeReady;
      expect(bridgeFsBoundWorkspaces[0]).toEqual([roots[0]]);
      expect(
        trustedFoldersRuntime.getWorkspaceTrustStatus,
      ).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('keeps browser MCP features disabled for non-extension origins when the env flag is unset', async () => {
    const features = await readBrowserMcpFeatureFlagsForEnv(
      undefined,
      'http://localhost:5173',
    );

    expect(features).not.toContain('client_mcp_over_ws');
    expect(features).not.toContain('cdp_tunnel_over_ws');
  });

  it('bounds shutdown waiting when runtime startup never settles', async () => {
    const daemonLog = { warn: vi.fn() };

    await expect(
      waitForRuntimeStartingForShutdown(
        new Promise<void>(() => {}),
        daemonLog,
        1,
      ),
    ).resolves.toBeUndefined();

    expect(daemonLog.warn).toHaveBeenCalledWith(
      '1ms runtime-startup wait reached during shutdown; continuing listener close',
    );
  });

  it('proxies bridge access only after the runtime bridge is ready', async () => {
    const holder: { bridge?: HttpAcpBridge } = {};
    let runtimeStartupError: string | undefined;
    const proxy = createLazyBridgeProxy(
      () => holder.bridge,
      () => runtimeStartupError,
    );

    expect(() => proxy.getDaemonStatusSnapshot()).toThrow(
      'Daemon bridge runtime is still starting.',
    );

    runtimeStartupError = 'runtime boom';
    expect(() => proxy.getDaemonStatusSnapshot()).toThrow(
      'Daemon bridge runtime is not available: runtime boom',
    );

    const getDaemonStatusSnapshot = vi.fn(function (this: HttpAcpBridge) {
      return this === holder.bridge
        ? BASE_BRIDGE_SNAPSHOT
        : {
            ...BASE_BRIDGE_SNAPSHOT,
            channelLive: false,
          };
    });
    runtimeStartupError = undefined;
    holder.bridge = { getDaemonStatusSnapshot } as unknown as HttpAcpBridge;

    expect(proxy.getDaemonStatusSnapshot()).toBe(BASE_BRIDGE_SNAPSHOT);
    expect(getDaemonStatusSnapshot).toHaveBeenCalledTimes(1);
  });

  it.each([
    [undefined, 120_000],
    ['', 120_000],
    ['5000', 5000],
    ['0', 0],
    ['abc', 120_000],
    [String(Number.MAX_SAFE_INTEGER + 1), 120_000],
  ])(
    'resolves QWEN_SERVE_RUNTIME_STARTUP_TIMEOUT_MS=%s to %s',
    (envValue, expected) => {
      const originalEnv = process.env['QWEN_SERVE_RUNTIME_STARTUP_TIMEOUT_MS'];
      try {
        if (envValue === undefined) {
          delete process.env['QWEN_SERVE_RUNTIME_STARTUP_TIMEOUT_MS'];
        } else {
          process.env['QWEN_SERVE_RUNTIME_STARTUP_TIMEOUT_MS'] = envValue;
        }

        expect(resolveRuntimeStartupTimeoutMs(undefined)).toBe(expected);
      } finally {
        if (originalEnv === undefined) {
          delete process.env['QWEN_SERVE_RUNTIME_STARTUP_TIMEOUT_MS'];
        } else {
          process.env['QWEN_SERVE_RUNTIME_STARTUP_TIMEOUT_MS'] = originalEnv;
        }
      }
    },
  );

  it('returns bootstrap 503 for unknown routes while runtime is still starting', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-starting-route-')),
    );
    let resolveTelemetry:
      | ((settings: qwenCore.ResolvedTelemetrySettings) => void)
      | undefined;
    const telemetryPromise = new Promise<qwenCore.ResolvedTelemetrySettings>(
      (resolve) => {
        resolveTelemetry = resolve;
      },
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockReturnValue(
      telemetryPromise,
    );
    const bridge = makeRuntimeBridge();
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true, runtimeStartupTimeoutMs: 0 },
    );

    try {
      const res = await fetch(`${handle.url}/unknown-route`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        error: 'Daemon runtime is still starting',
        code: 'daemon_runtime_starting',
      });
    } finally {
      resolveTelemetry?.({
        enabled: false,
        sensitiveSpanAttributeMaxLength: 1024 * 1024,
      });
      await handle.close();
    }
  });

  it('returns bootstrap 503 for multi-workspace capabilities until runtime routes mount', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-starting-caps-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    let resolveTelemetry:
      | ((settings: qwenCore.ResolvedTelemetrySettings) => void)
      | undefined;
    const telemetryPromise = new Promise<qwenCore.ResolvedTelemetrySettings>(
      (resolve) => {
        resolveTelemetry = resolve;
      },
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockReturnValue(
      telemetryPromise,
    );
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => makeRuntimeBridge());
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: {},
    } as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, secondary],
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        runtimeStartupTimeoutMs: 0,
        bootSettings: {},
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );

    try {
      const bootstrapRes = await fetch(`${handle.url}/capabilities`);
      expect(bootstrapRes.status).toBe(503);
      expect(bootstrapRes.headers.get('retry-after')).toBe('1');
      expect(await bootstrapRes.json()).toMatchObject({
        error: 'Daemon runtime is still starting',
        code: 'daemon_runtime_starting',
      });
      expect(createBridge).not.toHaveBeenCalled();

      resolveTelemetry?.({
        enabled: false,
        sensitiveSpanAttributeMaxLength: 1024 * 1024,
      });
      await handle.runtimeReady;
      const runtimeRes = await fetch(`${handle.url}/capabilities`);
      expect(runtimeRes.status).toBe(200);
      const runtimeBody = (await runtimeRes.json()) as { features: string[] };
      expect(runtimeBody.features).toContain('multi_workspace_sessions');
    } finally {
      resolveTelemetry?.({
        enabled: false,
        sensitiveSpanAttributeMaxLength: 1024 * 1024,
      });
      await handle.close();
    }
  });

  it('keeps health responsive before starting deferred runtime work', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-first-')),
    );
    const logBaseDir = path.join(tmpDir, 'debug');
    const resolveTelemetrySettings = vi
      .spyOn(qwenCore, 'resolveTelemetrySettings')
      .mockResolvedValue({
        enabled: false,
        sensitiveSpanAttributeMaxLength: 1024 * 1024,
      });
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
        daemonLogBaseDir: logBaseDir,
      },
    );

    let closed = false;
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(resolveTelemetrySettings).not.toHaveBeenCalled();
      expect(createBridge).not.toHaveBeenCalled();
      const bootstrapCapabilities = (await (
        await fetch(`${handle.url}/capabilities`)
      ).json()) as { features: string[] };
      expect(bootstrapCapabilities.features).not.toContain(
        'scheduled_task_session_reuse',
      );
      expect(createBridge).not.toHaveBeenCalled();
      const healthRes = await fetch(`${handle.url}/health`);
      expect(healthRes.status).toBe(200);
      expect(await healthRes.json()).toEqual({ status: 'ok' });

      await vi.waitFor(() => expect(createBridge).toHaveBeenCalledTimes(1), {
        timeout: 500,
      });
      expect(resolveTelemetrySettings).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).resolves.toBeUndefined();
      const runtimeCapabilities = (await (
        await fetch(`${handle.url}/capabilities`)
      ).json()) as { features: string[] };
      expect(runtimeCapabilities.features).toContain(
        'scheduled_task_session_reuse',
      );
      await handle.close();
      closed = true;

      const daemonDir = path.join(logBaseDir, 'daemon');
      const [logFile] = fs
        .readdirSync(daemonDir)
        .filter((fileName) => fileName.endsWith('.log'));
      expect(logFile).toBeDefined();
      const logContent = fs.readFileSync(
        path.join(daemonDir, logFile!),
        'utf8',
      );
      expect(logContent).toContain(
        'deferred runtime: health timer fired, starting',
      );
    } finally {
      if (!closed) {
        await handle.close();
      }
    }
  });

  it('returns retryable bootstrap deep health while starting deferred runtime', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-deep-first-')),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      expect(createBridge).not.toHaveBeenCalled();
      const bootstrapRes = await fetch(`${handle.url}/health?deep=1`);
      expect(bootstrapRes.status).toBe(503);
      expect(bootstrapRes.headers.get('retry-after')).toBe('1');
      expect(await bootstrapRes.json()).toEqual({
        status: 'degraded',
        reason: 'bootstrap',
      });

      await vi.waitFor(() => expect(createBridge).toHaveBeenCalledTimes(1), {
        timeout: 500,
      });
      await expect(handle.runtimeReady).resolves.toBeUndefined();

      const runtimeRes = await fetch(`${handle.url}/health?deep=1`);
      expect(runtimeRes.status).toBe(200);
      expect(await runtimeRes.json()).toMatchObject({
        status: 'ok',
        workspaceCount: 1,
        sessions: 0,
      });
    } finally {
      await handle.close();
    }
  });

  it('starts deferred runtime once for duplicate health probes', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-dedupe-')),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      expect(createBridge).not.toHaveBeenCalled();
      const [firstHealthRes, secondHealthRes] = await Promise.all([
        fetch(`${handle.url}/health`),
        fetch(`${handle.url}/health`),
      ]);
      expect(firstHealthRes.status).toBe(200);
      expect(secondHealthRes.status).toBe(200);
      expect(await firstHealthRes.json()).toEqual({ status: 'ok' });
      expect(await secondHealthRes.json()).toEqual({ status: 'ok' });

      await vi.waitFor(() => expect(createBridge).toHaveBeenCalledTimes(1), {
        timeout: 500,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).resolves.toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('starts deferred runtime for the first runtime route and serves that request', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-route-start-')),
    );
    let resolveTelemetry:
      | ((settings: qwenCore.ResolvedTelemetrySettings) => void)
      | undefined;
    const telemetryPromise = new Promise<qwenCore.ResolvedTelemetrySettings>(
      (resolve) => {
        resolveTelemetry = resolve;
      },
    );
    const resolveTelemetrySettings = vi
      .spyOn(qwenCore, 'resolveTelemetrySettings')
      .mockReturnValue(telemetryPromise);
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(() => {
      const app = express();
      app.post('/session', (req, res) => {
        const timing = getDeferredRuntimeRequestTiming(req);
        res.status(201).json({
          sessionId: 'session-1',
          runtimePath: timing?.path,
          runtimeWaitMs: timing?.waitMs,
        });
      });
      return app;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    let sessionRequestCount = 0;
    let resolveSecondSessionRequest: (() => void) | undefined;
    const secondSessionRequest = new Promise<void>((resolve) => {
      resolveSecondSessionRequest = resolve;
    });
    const observeSessionRequest = (req: { method?: string; url?: string }) => {
      if (req.method !== 'POST' || req.url !== '/session') return;
      sessionRequestCount += 1;
      if (sessionRequestCount === 2) resolveSecondSessionRequest?.();
    };
    handle.server.on('request', observeSessionRequest);

    try {
      expect(createBridge).not.toHaveBeenCalled();
      const firstResponse = fetch(`${handle.url}/session`, { method: 'POST' });
      await vi.waitFor(() =>
        expect(resolveTelemetrySettings).toHaveBeenCalledOnce(),
      );
      const joinedResponse = fetch(`${handle.url}/session`, {
        method: 'POST',
      });
      await secondSessionRequest;
      resolveTelemetry?.({
        enabled: false,
        sensitiveSpanAttributeMaxLength: 1024 * 1024,
      });

      const [first, joined] = await Promise.all([
        firstResponse,
        joinedResponse,
      ]);
      expect(first.status).toBe(201);
      expect(await first.json()).toEqual({
        sessionId: 'session-1',
        runtimePath: 'started_on_request',
        runtimeWaitMs: expect.any(Number),
      });
      expect(joined.status).toBe(201);
      expect(await joined.json()).toEqual({
        sessionId: 'session-1',
        runtimePath: 'joined',
        runtimeWaitMs: expect.any(Number),
      });
      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).resolves.toBeUndefined();
    } finally {
      resolveTelemetry?.({
        enabled: false,
        sensitiveSpanAttributeMaxLength: 1024 * 1024,
      });
      handle.server.off('request', observeSessionRequest);
      await handle.close();
    }
  });

  it('rejects unauthenticated deferred runtime routes before starting runtime', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-route-auth-')),
    );
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(() => {
      const app = express();
      app.post('/session', (_req, res) => {
        res.status(201).json({ sessionId: 'session-1' });
      });
      return app;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        token: 'secret-token',
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      const res = await fetch(`${handle.url}/session`, { method: 'POST' });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
      expect(createBridge).not.toHaveBeenCalled();

      const authorizedRes = await fetch(`${handle.url}/session`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token' },
      });
      expect(authorizedRes.status).toBe(201);
      expect(await authorizedRes.json()).toEqual({ sessionId: 'session-1' });
      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).resolves.toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('serves Web Shell document navigations during the deferred runtime window', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-deferred-webshell-')),
    );
    writeWebShellFixture(tmpDir);
    const { handle, createBridge } = await startDeferredDaemon(tmpDir);

    try {
      // HEAD goes first so the cold deferred gate's pre-auth exemption is
      // exercised for both methods the warm app serves pre-auth.
      const headRes = await fetch(`${handle.url}/session/abc`, {
        method: 'HEAD',
        headers: { accept: 'text/html' },
      });
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get('content-type')).toContain('text/html');

      // A browser refresh of a session deep link carries no bearer header and
      // must load the shell (and start the runtime) instead of 401ing in the
      // deferred gate.
      const navRes = await fetch(`${handle.url}/session/abc`, {
        headers: { accept: 'text/html' },
      });
      expect(navRes.status).toBe(200);
      expect(navRes.headers.get('content-type')).toContain('text/html');
      expect(await navRes.text()).toContain('<div id="root">');
      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).resolves.toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('serves the Web Shell root during the deferred runtime window', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-deferred-root-')),
    );
    writeWebShellFixture(tmpDir);
    const { handle, createBridge } = await startDeferredDaemon(tmpDir);

    try {
      // First request to a cold daemon, so the `/` exemption is exercised at
      // the deferred gate itself — there is no warm-app path it could take.
      const rootRes = await fetch(`${handle.url}/`);
      expect(rootRes.status).toBe(200);
      expect(rootRes.headers.get('content-type')).toContain('text/html');
      expect(await rootRes.text()).toContain('<div id="root">');
      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).resolves.toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('serves the // root alias during the deferred window like the warm app', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-deferred-root-alias-')),
    );
    writeWebShellFixture(tmpDir);
    const { handle, createBridge } = await startDeferredDaemon(tmpDir);

    try {
      // Express non-strict routing matches a raw `//` against `app.get('/')`,
      // so the warm app serves it pre-auth; the cold gate must exempt it too
      // instead of 401ing.
      const aliasRes = await fetch(`${handle.url}//`);
      expect(aliasRes.status).toBe(200);
      expect(aliasRes.headers.get('content-type')).toContain('text/html');
      expect(await aliasRes.text()).toContain('<div id="root">');
      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).resolves.toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('degrades to the bearer gate when the pre-auth predicate rejects', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-deferred-predicate-fail-')),
    );
    writeWebShellFixture(tmpDir);
    const { handle, createBridge } = await startDeferredDaemon(tmpDir);
    const predicateSpy = vi
      .spyOn(webShellStatic, 'isPreAuthWebShellRequest')
      .mockImplementation(() => {
        throw new Error('predicate module glitch');
      });

    try {
      // Without the fail-closed guard, a rejecting predicate 500s the whole
      // deferred branch. A tokenless navigation must hit the bearer gate...
      const anonRes = await fetch(`${handle.url}/`, {
        headers: { accept: 'text/html' },
      });
      expect(anonRes.status).toBe(401);

      // ...and a correctly-tokened request must still get through.
      const authedRes = await fetch(`${handle.url}/session/abc`, {
        headers: {
          accept: 'text/html',
          authorization: 'Bearer secret-token',
        },
      });
      expect(authedRes.status).toBe(200);
      expect(authedRes.headers.get('content-type')).toContain('text/html');
      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).resolves.toBeUndefined();
    } finally {
      predicateSpy.mockRestore();
      await handle.close();
    }
  });

  it('serves Web Shell assets during the deferred runtime window', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-deferred-assets-')),
    );
    const shellDir = writeWebShellFixture(tmpDir);
    fs.writeFileSync(
      path.join(shellDir, 'assets', 'fixture.js'),
      'console.log("fixture");',
    );
    const { handle, createBridge } = await startDeferredDaemon(tmpDir);

    try {
      // First request to a cold daemon, so only the predicate's `/assets/`
      // branch can exempt this from the bearer gate.
      const assetRes = await fetch(`${handle.url}/assets/fixture.js`);
      expect(assetRes.status).toBe(200);
      expect(await assetRes.text()).toContain('console.log("fixture");');
      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).resolves.toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('answers bare /assets during the deferred window like the warm app', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-deferred-assets-bare-')),
    );
    writeWebShellFixture(tmpDir);
    const { handle, createBridge } = await startDeferredDaemon(tmpDir);

    try {
      // First request to a cold daemon. Express 5's `app.use('/assets', ...)`
      // also matches the bare mount path pre-auth — the warm app answers 301
      // to `/assets/` (then 404) — so the deferred gate must exempt it too
      // instead of 401ing.
      const bareRes = await fetch(`${handle.url}/assets`, {
        redirect: 'manual',
      });
      expect(bareRes.status).toBe(301);
      expect(bareRes.headers.get('location')).toBe('/assets/');
      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).resolves.toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('serves trailing-slash and case-variant session deep links during the deferred window', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-deferred-shapes-')),
    );
    writeWebShellFixture(tmpDir);
    const { handle, createBridge } = await startDeferredDaemon(tmpDir);

    try {
      // The warm app serves this shape pre-auth (Express matches routes
      // case-insensitively and non-strictly by default), so the cold gate
      // must exempt it too instead of 401ing the refresh.
      const navRes = await fetch(`${handle.url}/Session/abc/`, {
        headers: { accept: 'text/html' },
      });
      expect(navRes.status).toBe(200);
      expect(navRes.headers.get('content-type')).toContain('text/html');
      expect(await navRes.text()).toContain('<div id="root">');
      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).resolves.toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('serves query-carrying session deep links during the deferred window', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-deferred-query-')),
    );
    writeWebShellFixture(tmpDir);
    const { handle, createBridge } = await startDeferredDaemon(tmpDir);

    try {
      // First request to a cold daemon, with a query string (a real
      // deep-link refresh shape). The predicate matches on `req.path`, which
      // strips the query — pinning the gate against a mutation to `req.url`
      // that would 401 the refresh.
      const queryRes = await fetch(`${handle.url}/session/abc/?ref=1`, {
        headers: { accept: 'text/html' },
      });
      expect(queryRes.status).toBe(200);
      expect(queryRes.headers.get('content-type')).toContain('text/html');
      expect(await queryRes.text()).toContain('<div id="root">');
      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).resolves.toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('keeps JSON and API-subpath requests gated during the deferred runtime window', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-deferred-webshell-gate-')),
    );
    writeWebShellFixture(tmpDir);
    const { handle, createBridge } = await startDeferredDaemon(tmpDir);

    try {
      const jsonRes = await fetch(`${handle.url}/session/abc`, {
        headers: { accept: 'application/json' },
      });
      expect(jsonRes.status).toBe(401);

      const apiRes = await fetch(`${handle.url}/session/abc/status`, {
        headers: { accept: 'text/html' },
      });
      expect(apiRes.status).toBe(401);

      expect(createBridge).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('keeps session document navigations gated during the deferred window with --no-web', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-deferred-noweb-')),
    );
    const { handle, createBridge } = await startDeferredDaemon(tmpDir, {
      serveOptions: { serveWebShell: false },
    });

    try {
      const navRes = await fetch(`${handle.url}/session/abc`, {
        headers: { accept: 'text/html' },
      });
      expect(navRes.status).toBe(401);
      expect(createBridge).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('answers pre-auth Web Shell navigations with the failure envelope when the deferred runtime fails', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-deferred-webshell-fail-')),
    );
    writeWebShellFixture(tmpDir);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const { handle, createBridge } = await startDeferredDaemon(tmpDir, {
      createBridge: () => {
        throw new Error('runtime boom');
      },
    });

    try {
      // These paths are declared pre-auth, so on a startup failure they must
      // report the real fault instead of the bootstrap bearer gate's 401.
      const navRes = await fetch(`${handle.url}/session/abc`, {
        headers: { accept: 'text/html' },
      });
      expect(navRes.status).toBe(503);
      expect(await navRes.json()).toEqual({
        error: 'Daemon runtime failed to start',
        code: 'daemon_runtime_failed',
      });

      const rootRes = await fetch(`${handle.url}/`);
      expect(rootRes.status).toBe(503);
      expect(await rootRes.json()).toEqual({
        error: 'Daemon runtime failed to start',
        code: 'daemon_runtime_failed',
      });

      // Non-exempted requests stay behind the bearer gate.
      const jsonRes = await fetch(`${handle.url}/session/abc`, {
        headers: { accept: 'application/json' },
      });
      expect(jsonRes.status).toBe(401);

      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).rejects.toThrow('runtime boom');
    } finally {
      await handle.close();
    }
  });

  it('starts deferred runtime for webhook routes without bearer auth', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-webhook-start-')),
    );
    const previousQwenHome = process.env['QWEN_HOME'];
    const previousWebhookSecret = process.env['QWEN_DEFERRED_WEBHOOK_SECRET'];
    const tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qws-runtime-webhook-home-'),
    );
    process.env['QWEN_HOME'] = tempHome;
    process.env['QWEN_DEFERRED_WEBHOOK_SECRET'] = 'global-secret';
    settingsRuntime.resetHomeEnvBootstrapForTesting();
    fs.writeFileSync(
      path.join(tempHome, 'settings.json'),
      JSON.stringify({
        channels: {
          'dingtalk-main': {
            type: 'dingtalk',
            webhooks: {
              sources: {
                'github ci': {
                  secretEnv: 'QWEN_DEFERRED_WEBHOOK_SECRET',
                  targets: {
                    default: {
                      chatId: 'group-1',
                      senderId: 'webhook:github ci',
                    },
                  },
                },
              },
            },
          },
        },
      }),
      'utf8',
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(environmentRuntime, 'buildRuntimeEnvironment').mockImplementation(
      (_settings, _workspace, baseEnv) => ({
        effectiveEnv: Object.freeze({
          ...baseEnv,
          QWEN_DEFERRED_WEBHOOK_SECRET: 'workspace-secret',
        }),
        overlayKeys: Object.freeze(['QWEN_DEFERRED_WEBHOOK_SECRET']),
        envFilePaths: Object.freeze([]),
        envFileReadFailed: false,
        envFileReadFailures: Object.freeze([]),
      }),
    );
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        token: 'secret-token',
        channelSelection: {
          mode: 'names',
          names: ['dingtalk-main'],
        },
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
        trustedWorkspace: true,
        channelWorkerSupervisorFactory: (options) => {
          const workerSnapshot: ChannelWorkerSnapshot = {
            enabled: true,
            state: 'running',
            pid: 1234,
            channels: ['dingtalk-main'],
          };
          return {
            start: vi.fn(async () => {
              options.onReady?.(workerSnapshot);
            }),
            stop: vi.fn(async () => {}),
            restart: vi.fn(async () => workerSnapshot),
            killAllSync: vi.fn(),
            snapshot: vi.fn(() => workerSnapshot),
            enqueueWebhookTask: vi.fn(async () => ({
              accepted: true as const,
            })),
          };
        },
        channelServicePidfile: {
          readServiceInfo: vi.fn(() => null),
          writeServeServiceInfo: vi.fn(),
          reserveServeServiceInfo: vi.fn(),
          removeServiceInfo: vi.fn(),
          removeServeServiceInfo: vi.fn(() => true),
        },
      },
    );

    try {
      expect(createBridge).not.toHaveBeenCalled();
      const res = await fetch(
        `${handle.url}/channels/dingtalk-main/webhooks/github%20ci`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-qwen-webhook-secret': 'workspace-secret',
          },
          body: JSON.stringify({
            eventType: 'ci_failed',
            targetRef: 'default',
            title: 'CI failed',
          }),
        },
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ accepted: true });
      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).resolves.toBeUndefined();
    } finally {
      await handle.close();
      fs.rmSync(tempHome, { recursive: true, force: true });
      if (previousQwenHome === undefined) {
        delete process.env['QWEN_HOME'];
      } else {
        process.env['QWEN_HOME'] = previousQwenHome;
      }
      if (previousWebhookSecret === undefined) {
        delete process.env['QWEN_DEFERRED_WEBHOOK_SECRET'];
      } else {
        process.env['QWEN_DEFERRED_WEBHOOK_SECRET'] = previousWebhookSecret;
      }
      settingsRuntime.resetHomeEnvBootstrapForTesting();
    }
  });

  it('rejects bad-secret deferred webhook routes before starting runtime', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-webhook-auth-')),
    );
    const logBaseDir = path.join(tmpDir, 'debug');
    const previousQwenHome = process.env['QWEN_HOME'];
    const tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qws-runtime-webhook-home-'),
    );
    process.env['QWEN_HOME'] = tempHome;
    settingsRuntime.resetHomeEnvBootstrapForTesting();
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    fs.writeFileSync(
      path.join(tempHome, 'settings.json'),
      JSON.stringify({
        channels: {
          'dingtalk-main': {
            type: 'dingtalk',
            webhooks: {
              sources: {
                'github-ci': {
                  secret: 'webhook-secret',
                  targets: {
                    default: {
                      chatId: 'group-1',
                      senderId: 'webhook:github-ci',
                    },
                  },
                },
              },
            },
          },
        },
      }),
      'utf8',
    );
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(() => {
      const app = express();
      app.post('/channels/:channelName/webhooks/:source', (_req, res) => {
        res.status(202).json({ accepted: true });
      });
      return app;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        token: 'secret-token',
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
        daemonLogBaseDir: logBaseDir,
      },
    );

    let closed = false;
    try {
      const res = await fetch(
        `${handle.url}/channels/dingtalk-main/webhooks/github-ci`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-qwen-webhook-secret': 'wrong',
          },
          body: JSON.stringify({
            eventType: 'ci_failed',
            targetRef: 'default',
            title: 'CI failed',
          }),
        },
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Invalid webhook secret' });
      expect(createBridge).not.toHaveBeenCalled();
      await handle.close();
      closed = true;

      const log = fs.readFileSync(
        path.join(logBaseDir, 'daemon', 'daemon.log'),
        'utf8',
      );
      expect(log).toContain('deferred webhook auth failed');
      expect(log).toContain('channelName=dingtalk-main');
      expect(log).toContain('source=github-ci');
      expect(log).toContain('reason="secret mismatch"');
    } finally {
      if (!closed) {
        await handle.close();
      }
      fs.rmSync(tempHome, { recursive: true, force: true });
      if (previousQwenHome === undefined) {
        delete process.env['QWEN_HOME'];
      } else {
        process.env['QWEN_HOME'] = previousQwenHome;
      }
      settingsRuntime.resetHomeEnvBootstrapForTesting();
    }
  });

  it('logs deferred webhook secret lookup failures before starting runtime', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-webhook-log-')),
    );
    const previousQwenHome = process.env['QWEN_HOME'];
    const previousSecret = process.env['QWEN_MISSING_WEBHOOK_SECRET'];
    const tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qws-runtime-webhook-home-'),
    );
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    delete process.env['QWEN_MISSING_WEBHOOK_SECRET'];
    process.env['QWEN_HOME'] = tempHome;
    settingsRuntime.resetHomeEnvBootstrapForTesting();
    fs.writeFileSync(
      path.join(tempHome, 'settings.json'),
      JSON.stringify({
        channels: {
          'dingtalk-main': {
            type: 'dingtalk',
            webhooks: {
              sources: {
                'github\nci': {
                  secretEnv: 'QWEN_MISSING_WEBHOOK_SECRET',
                  targets: {
                    default: {
                      chatId: 'group-1',
                      senderId: 'webhook:github-ci',
                    },
                  },
                },
              },
            },
          },
        },
      }),
      'utf8',
    );
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(() => {
      const app = express();
      app.post('/channels/:channelName/webhooks/:source', (_req, res) => {
        res.status(202).json({ accepted: true });
      });
      return app;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        token: 'secret-token',
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      const res = await fetch(
        `${handle.url}/channels/dingtalk-main/webhooks/github%0Aci`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-qwen-webhook-secret': 'webhook-secret',
          },
          body: JSON.stringify({ eventType: 'ci_failed' }),
        },
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Invalid webhook secret' });
      expect(createBridge).not.toHaveBeenCalled();
      expect(stderrWrites.join('')).toContain(
        '[webhook-secret] failed to read deferred webhook secret for dingtalk-main/github\\nci:',
      );
      expect(stderrWrites.join('')).not.toContain('github\nci');
      expect(stderrWrites.join('')).toContain(
        'webhooks.sources.github\\nci.secretEnv',
      );
    } finally {
      await handle.close();
      fs.rmSync(tempHome, { recursive: true, force: true });
      if (previousSecret === undefined) {
        delete process.env['QWEN_MISSING_WEBHOOK_SECRET'];
      } else {
        process.env['QWEN_MISSING_WEBHOOK_SECRET'] = previousSecret;
      }
      if (previousQwenHome === undefined) {
        delete process.env['QWEN_HOME'];
      } else {
        process.env['QWEN_HOME'] = previousQwenHome;
      }
      settingsRuntime.resetHomeEnvBootstrapForTesting();
    }
  });

  it('allows deferred runtime CORS preflight without auth or runtime startup', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-preflight-')),
    );
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        token: 'secret-token',
        allowOrigins: ['http://localhost:5173'],
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      const res = await fetch(`${handle.url}/session/foo/prompt`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(
        'http://localhost:5173',
      );
      expect(res.headers.get('access-control-allow-methods')).toContain('POST');
      expect(createBridge).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('does not start deferred runtime for unsupported bootstrap route methods', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-bootstrap-method-')),
    );
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      const res = await fetch(`${handle.url}/health`, { method: 'POST' });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        code: 'daemon_runtime_starting',
      });
      expect(createBridge).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('serves trailing-slash bootstrap health without waiting for deferred runtime', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-bootstrap-trailing-')),
    );
    let resolveTelemetry:
      | ((settings: qwenCore.ResolvedTelemetrySettings) => void)
      | undefined;
    const telemetryPromise = new Promise<qwenCore.ResolvedTelemetrySettings>(
      (resolve) => {
        resolveTelemetry = resolve;
      },
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockReturnValue(
      telemetryPromise,
    );
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      const res = await Promise.race([
        fetch(`${handle.url}/health/`),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Trailing-slash health timed out')),
            200,
          ),
        ),
      ]);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
      expect(createBridge).not.toHaveBeenCalled();
    } finally {
      resolveTelemetry?.({
        enabled: false,
        sensitiveSpanAttributeMaxLength: 1024 * 1024,
      });
      await handle.close();
    }
  });

  it('reports deferred runtime startup failure for the triggering runtime route', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-route-fail-')),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => {
        throw new Error('runtime boom');
      });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      const res = await fetch(`${handle.url}/session`, { method: 'POST' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: 'Daemon runtime failed to start',
        code: 'daemon_runtime_failed',
      });
      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).rejects.toThrow('runtime boom');
    } finally {
      await handle.close();
    }
  });

  it('starts deferred runtime on fallback when no health probe arrives', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-fallback-')),
    );
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      expect(createBridge).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(createBridge).toHaveBeenCalledTimes(1), {
        timeout: 1500,
      });
      await expect(handle.runtimeReady).resolves.toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('does not start deferred runtime after close before first health', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-close-')),
    );
    const logBaseDir = path.join(tmpDir, 'debug');
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
        daemonLogBaseDir: logBaseDir,
      },
    );

    await handle.close();
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(createBridge).not.toHaveBeenCalled();
    await expect(handle.runtimeReady).rejects.toThrow(
      RUNTIME_STARTUP_CANCELLED_MESSAGE,
    );
    const daemonDir = path.join(logBaseDir, 'daemon');
    const [logFile] = fs
      .readdirSync(daemonDir)
      .filter((fileName) => fileName.endsWith('.log'));
    expect(logFile).toBeDefined();
    const logContent = fs.readFileSync(path.join(daemonDir, logFile!), 'utf8');
    expect(logContent).toContain(
      'deferred runtime: cancelled, server closed before startup',
    );
  });

  it('does not start deferred runtime after close following first health', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-close-after-')),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    const healthRes = await fetch(`${handle.url}/health`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ status: 'ok' });

    await handle.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(createBridge).not.toHaveBeenCalled();
    await expect(handle.runtimeReady).rejects.toThrow(
      RUNTIME_STARTUP_CANCELLED_MESSAGE,
    );
  });

  it('stops the deferred runtime extension reconciler during close', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-reconciler-close-')),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const bridge = makeRuntimeBridge();
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    const stopExtensionGenerationReconciler = vi.fn();
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(() => {
      const runtimeApp = express();
      runtimeApp.locals['stopExtensionGenerationReconciler'] =
        stopExtensionGenerationReconciler;
      return runtimeApp;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      const healthRes = await fetch(`${handle.url}/health`);
      expect(healthRes.status).toBe(200);
      await handle.runtimeReady;
    } finally {
      await handle.close();
    }

    expect(stopExtensionGenerationReconciler).toHaveBeenCalledOnce();
    expect(
      stopExtensionGenerationReconciler.mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(bridge.shutdown).mock.invocationCallOrder[0]!);
  });

  it('seals and drains admitted session maintenance before bridge shutdown', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-maintenance-drain-')),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const bridge = makeRuntimeBridge();
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    let finishMaintenance!: () => void;
    const maintenanceGate = new Promise<void>((resolve) => {
      finishMaintenance = resolve;
    });
    const sealMaintenanceAndWait = vi.fn(() => maintenanceGate);
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(() => {
      const runtimeApp = express();
      runtimeApp.locals['sessionArchiveCoordinator'] = {
        sealMaintenanceAndWait,
      };
      return runtimeApp;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );
    await handle.runtimeReady;

    const close = handle.close();
    expect(sealMaintenanceAndWait).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(bridge.shutdown).not.toHaveBeenCalled();

    finishMaintenance();
    await close;
    expect(bridge.shutdown).toHaveBeenCalledOnce();
  });

  it('propagates an admitted session maintenance drain failure', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-maintenance-failure-')),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const bridge = makeRuntimeBridge();
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    const sealMaintenanceAndWait = vi.fn(async () => {
      throw new Error('maintenance drain failed');
    });
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(() => {
      const runtimeApp = express();
      runtimeApp.locals['sessionArchiveCoordinator'] = {
        sealMaintenanceAndWait,
      };
      return runtimeApp;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );
    await handle.runtimeReady;

    await expect(handle.close()).rejects.toThrow('maintenance drain failed');
    expect(sealMaintenanceAndWait).toHaveBeenCalledOnce();
    expect(bridge.shutdown).not.toHaveBeenCalled();
  });

  it('does not cancel deferred runtime once startup is already running', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-close-running-')),
    );
    let resolveTelemetry:
      | ((settings: qwenCore.ResolvedTelemetrySettings) => void)
      | undefined;
    const telemetryPromise = new Promise<qwenCore.ResolvedTelemetrySettings>(
      (resolve) => {
        resolveTelemetry = resolve;
      },
    );
    const resolveTelemetrySettings = vi
      .spyOn(qwenCore, 'resolveTelemetrySettings')
      .mockReturnValue(telemetryPromise);
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    const healthRes = await fetch(`${handle.url}/health`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ status: 'ok' });
    await vi.waitFor(
      () => expect(resolveTelemetrySettings).toHaveBeenCalledTimes(1),
      { timeout: 500 },
    );

    const closePromise = handle.close();
    resolveTelemetry?.({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    await closePromise;

    expect(createBridge).toHaveBeenCalledTimes(1);
    await expect(handle.runtimeReady).rejects.toThrow(
      'Daemon runtime stopped before mounting.',
    );
  });

  it('disposes a deferred runtime app that finishes after the shutdown wait', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-close-late-app-')),
    );
    let resolveTelemetry:
      | ((settings: qwenCore.ResolvedTelemetrySettings) => void)
      | undefined;
    const telemetryPromise = new Promise<qwenCore.ResolvedTelemetrySettings>(
      (resolve) => {
        resolveTelemetry = resolve;
      },
    );
    const resolveTelemetrySettings = vi
      .spyOn(qwenCore, 'resolveTelemetrySettings')
      .mockReturnValue(telemetryPromise);
    const bridge = makeRuntimeBridge();
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    const stopExtensionGenerationReconciler = vi.fn();
    const stopScheduledTaskKeepalive = vi.fn(() => {
      throw new Error('keepalive dispose failed');
    });
    const stopWorkspaceGitState = vi.fn();
    const stopSubSession = vi.fn();
    const disposeEventLoopMonitor = vi.fn();
    vi.spyOn(qwenCore, 'startEventLoopLagMonitor').mockReturnValueOnce({
      snapshot: () => ({
        meanMs: 0,
        p50Ms: 0,
        p99Ms: 0,
        maxMs: 0,
      }),
      dispose: disposeEventLoopMonitor,
    });
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(() => {
      const runtimeApp = express();
      runtimeApp.locals['stopExtensionGenerationReconciler'] =
        stopExtensionGenerationReconciler;
      runtimeApp.locals['stopScheduledTaskKeepalive'] =
        stopScheduledTaskKeepalive;
      runtimeApp.locals['stopWorkspaceGitState'] = stopWorkspaceGitState;
      let subSessionStoppers: Array<() => void> = [];
      Object.defineProperty(runtimeApp.locals, 'subSessionStoppers', {
        configurable: true,
        get: () => subSessionStoppers,
        set: (stoppers: Array<() => void>) => {
          stoppers.push(stopSubSession);
          subSessionStoppers = stoppers;
        },
      });
      return runtimeApp;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    const healthRes = await fetch(`${handle.url}/health`);
    expect(healthRes.status).toBe(200);
    await vi.waitFor(
      () => expect(resolveTelemetrySettings).toHaveBeenCalledTimes(1),
      { timeout: 500 },
    );

    const nativeSetTimeout = globalThis.setTimeout;
    let acceleratedRuntimeWait = false;
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) => {
        if (!acceleratedRuntimeWait && delay === 5_000) {
          acceleratedRuntimeWait = true;
          return nativeSetTimeout(callback, 0, ...args);
        }
        return nativeSetTimeout(callback, delay, ...args);
      }) as typeof setTimeout);
    try {
      await handle.close();
    } finally {
      setTimeoutSpy.mockRestore();
    }
    expect(stopExtensionGenerationReconciler).not.toHaveBeenCalled();

    resolveTelemetry?.({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });

    await vi.waitFor(
      () => expect(stopExtensionGenerationReconciler).toHaveBeenCalledOnce(),
      { timeout: 1_000 },
    );
    expect(stopScheduledTaskKeepalive).toHaveBeenCalledOnce();
    expect(stopWorkspaceGitState).toHaveBeenCalledOnce();
    expect(stopSubSession).toHaveBeenCalledOnce();
    expect(disposeEventLoopMonitor).toHaveBeenCalledOnce();
    expect(bridge.shutdown).toHaveBeenCalledOnce();
    await expect(handle.runtimeReady).rejects.toThrow(
      'Daemon runtime stopped before mounting.',
    );
  });

  it('does not retry deferred runtime after startup failure and later health probe', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-fail-once-')),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => {
        throw new Error('runtime boom');
      });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      const firstHealthRes = await fetch(`${handle.url}/health`);
      expect(firstHealthRes.status).toBe(200);
      expect(await firstHealthRes.json()).toEqual({ status: 'ok' });
      await expect(handle.runtimeReady).rejects.toThrow('runtime boom');
      expect(createBridge).toHaveBeenCalledTimes(1);

      const secondHealthRes = await fetch(`${handle.url}/health`);
      expect(secondHealthRes.status).toBe(503);
      expect(await secondHealthRes.json()).toMatchObject({
        status: 'degraded',
        error: 'runtime boom',
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(createBridge).toHaveBeenCalledTimes(1);
    } finally {
      await handle.close();
    }
  });

  it('flushes runtime startup failures to the daemon log when closing', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-fail-log-')),
    );
    const originalRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() => {
      throw new Error('runtime boom');
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    try {
      await expect(handle.runtimeReady).rejects.toThrow('runtime boom');
      await handle.close();
      const daemonDir = path.join(tmpDir, 'debug', 'daemon');
      const logFile = fs
        .readdirSync(daemonDir)
        .find((file) => file.endsWith('.log'));
      expect(logFile).toBeDefined();
      const logContent = fs.readFileSync(
        path.join(daemonDir, logFile!),
        'utf8',
      );
      expect(logContent).toContain('runtime startup failed');
      expect(logContent).toContain('runtime boom');
    } finally {
      if (handle.server.listening) {
        await handle.close();
      }
      if (originalRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = originalRuntimeDir;
      }
    }
  });

  it('does not block shutdown on pending metrics flush', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-flush-pending-')),
    );
    const forceFlushMetrics = vi.spyOn(qwenCore, 'forceFlushMetrics');
    forceFlushMetrics.mockReturnValue(new Promise<void>(() => {}));
    const bridge = {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
      getSession: vi.fn(),
      getAllSessions: vi.fn().mockReturnValue([]),
      publishWorkspaceEvent: vi.fn(),
      getEventRing: vi.fn().mockReturnValue({ getAll: () => [] }),
      resume: vi.fn(),
      preheat: vi.fn().mockResolvedValue(undefined),
      getDaemonStatusSnapshot: vi.fn().mockReturnValue(BASE_BRIDGE_SNAPSHOT),
      isChannelLive: vi.fn().mockReturnValue(true),
    } as unknown as HttpAcpBridge;
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    await expect(handle.runtimeReady).resolves.toBeUndefined();
    let timeout: NodeJS.Timeout | undefined;
    const closeResult = await Promise.race([
      handle.close().then(() => 'closed'),
      new Promise<'timed-out'>((resolve) => {
        timeout = setTimeout(() => resolve('timed-out'), 1_000);
        timeout.unref();
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    expect(closeResult).toBe('closed');
    expect(forceFlushMetrics).toHaveBeenCalledTimes(1);
    expect(bridge.shutdown).toHaveBeenCalledTimes(1);
  });

  it('accumulates prompt queue wait stats in daemon status perf data', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-queue-wait-')),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const telemetry: ReturnType<typeof qwenCore.createDaemonBridgeTelemetry> = {
      captureContext() {
        return undefined;
      },
      runWithContext(_captured, fn) {
        return fn();
      },
      withSpan(_operation, _attributes, fn) {
        return fn();
      },
      event: vi.fn(),
      injectPromptContext(request) {
        return request;
      },
    };
    vi.spyOn(qwenCore, 'createDaemonBridgeTelemetry').mockReturnValue(
      telemetry,
    );
    const recordPromptQueueWait = vi.spyOn(
      qwenCore,
      'recordDaemonPromptQueueWait',
    );
    const bridge = makeRuntimeBridge();
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    try {
      await handle.runtimeReady;
      telemetry.metrics?.promptQueueWait(10);
      telemetry.metrics?.promptQueueWait(30);
      telemetry.metrics?.promptQueueWait(5);

      const res = await fetch(`${handle.url}/daemon/status`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        runtime?: {
          perf?: {
            promptQueueWait?: {
              count: number;
              meanMs: number;
              maxMs: number;
              lastMs: number | null;
            };
          };
        };
      };
      expect(body.runtime?.perf?.promptQueueWait).toEqual({
        count: 3,
        meanMs: 15,
        maxMs: 30,
        lastMs: 5,
      });
      expect(recordPromptQueueWait).toHaveBeenNthCalledWith(1, 10);
      expect(recordPromptQueueWait).toHaveBeenNthCalledWith(2, 30);
      expect(recordPromptQueueWait).toHaveBeenNthCalledWith(3, 5);
    } finally {
      await handle.close();
    }
  });

  it('fails runtimeReady and health when runtime startup times out', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-timeout-')),
    );
    let resolveTelemetry:
      | ((settings: qwenCore.ResolvedTelemetrySettings) => void)
      | undefined;
    const telemetryPromise = new Promise<qwenCore.ResolvedTelemetrySettings>(
      (resolve) => {
        resolveTelemetry = resolve;
      },
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockReturnValue(
      telemetryPromise,
    );
    const bridge = {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
      getSession: vi.fn(),
      getAllSessions: vi.fn().mockReturnValue([]),
      publishWorkspaceEvent: vi.fn(),
      getEventRing: vi.fn().mockReturnValue({ getAll: () => [] }),
      resume: vi.fn(),
      preheat: vi.fn().mockResolvedValue(undefined),
      getDaemonStatusSnapshot: vi.fn().mockReturnValue(BASE_BRIDGE_SNAPSHOT),
      isChannelLive: vi.fn().mockReturnValue(true),
    } as unknown as HttpAcpBridge;
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true, runtimeStartupTimeoutMs: 1 },
    );

    try {
      await expect(handle.runtimeReady).rejects.toThrow(
        'Daemon runtime startup timed out after 1ms.',
      );
      const healthRes = await fetch(`${handle.url}/health`);
      expect(healthRes.status).toBe(503);
      expect(await healthRes.json()).toMatchObject({
        status: 'degraded',
        error: 'Daemon runtime startup timed out after 1ms.',
      });
      expect(() => handle.bridge.getDaemonStatusSnapshot()).toThrow(
        'Daemon bridge runtime is not available: Daemon runtime startup timed out after 1ms.',
      );

      resolveTelemetry?.({
        enabled: false,
        sensitiveSpanAttributeMaxLength: 1024 * 1024,
      });
      await vi.waitFor(() => {
        expect(bridge.shutdown).toHaveBeenCalledTimes(1);
      });
    } finally {
      await handle.close();
    }
  });

  it('reports bootstrap status and capabilities when fast path resolves on listen', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-fail-')),
    );
    const originalClientMcpOverWs =
      process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'];
    const originalCdpTunnelOverWs =
      process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
    delete process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'];
    delete process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
    const boundWorkspace = canonicalizeWorkspace(tmpDir);
    const blockedLogBaseDir = path.join(tmpDir, 'blocked-log-base');
    fs.writeFileSync(blockedLogBaseDir, 'not a directory');
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() => {
      throw new Error('runtime boom');
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        sessionRestoreTimeoutMs: 90_000,
        serveWebShell: false,
      },
      { resolveOnListen: true, daemonLogBaseDir: blockedLogBaseDir },
    );

    try {
      await expect(handle.runtimeReady).rejects.toThrow('runtime boom');
      const healthRes = await fetch(`${handle.url}/health`);
      expect(healthRes.status).toBe(503);
      expect(await healthRes.json()).toMatchObject({
        status: 'degraded',
        error: 'runtime boom',
      });
      const unknownRes = await fetch(`${handle.url}/unknown-route`);
      expect(unknownRes.status).toBe(503);
      expect(await unknownRes.json()).toMatchObject({
        error: 'Daemon runtime failed to start',
        code: 'daemon_runtime_failed',
      });

      const capabilitiesRes = await fetch(`${handle.url}/capabilities`, {
        headers: { Origin: handle.url },
      });
      expect(capabilitiesRes.status).toBe(200);
      const capabilitiesBody = await capabilitiesRes.json();
      expect(capabilitiesBody).toMatchObject({
        v: 1,
        protocolVersions: { current: 'v1', supported: ['v1'] },
        mode: 'http-bridge',
        features: expect.arrayContaining([
          'capabilities',
          'daemon_status',
          'workspace_settings',
          'workspace_reload',
          'workspace_acp_preheat',
          'workspace_acp_status',
          'persistent_workspace_registration',
          'workspace_runtime_removal',
        ]),
        modelServices: [],
        workspaceCwd: boundWorkspace,
        transports: ['rest'],
        policy: { permission: 'first-responder' },
        limits: {
          maxPendingPromptsPerSession: 5,
          sessionRestoreTimeoutMs: 90_000,
        },
      });
      expect(capabilitiesBody.features).not.toContain('client_mcp_over_ws');
      expect(capabilitiesBody.features).not.toContain('cdp_tunnel_over_ws');
      expect(capabilitiesBody.features).not.toContain(
        'scheduled_task_session_reuse',
      );

      const port = new URL(handle.url).port;
      for (const origin of [
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        `http://[::1]:${port}`,
        `http://host.docker.internal:${port}`,
      ]) {
        const sameOriginRes = await fetch(`${handle.url}/capabilities`, {
          headers: { Origin: origin },
        });
        expect(sameOriginRes.status).toBe(200);
      }

      const crossOriginRes = await fetch(`${handle.url}/capabilities`, {
        headers: { Origin: 'http://example.com' },
      });
      expect(crossOriginRes.status).toBe(403);

      const res = await fetch(`${handle.url}/daemon/status`);
      const body = (await res.json()) as {
        status?: string;
        issues?: Array<{ code?: string; severity?: string }>;
        daemon?: {
          runId?: string;
          logMode?: string;
          logHealth?: string;
        };
        runtime?: { loading?: boolean; error?: string };
      };
      expect(body).toMatchObject({
        status: 'error',
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'daemon_runtime_failed',
            severity: 'error',
          }),
          expect.objectContaining({
            code: 'daemon_log_degraded',
            severity: 'warning',
          }),
        ]),
        daemon: {
          runId: expect.stringMatching(/^[0-9a-f]{32}$/),
          logMode: 'stderr-only',
          logHealth: 'degraded',
        },
        runtime: { loading: false, error: 'runtime boom' },
      });

      const sameOriginRes = await fetch(
        `${handle.url}/daemon/status?detail=full`,
        {
          headers: { Origin: handle.url },
        },
      );
      expect(sameOriginRes.status).toBe(200);
      const sameOriginBody = await sameOriginRes.json();
      expect(sameOriginBody).toMatchObject({
        v: 1,
        detail: 'full',
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'daemon_log_degraded',
            severity: 'warning',
          }),
        ]),
        daemon: {
          runId: body.daemon?.runId,
          logMode: 'stderr-only',
          logHealth: 'degraded',
          logIssues: ['init_failed'],
          logDroppedRecords: 0,
          logDroppedBytes: 0,
        },
        security: { allowOriginMode: 'none' },
        limits: {
          maxSessions: 1,
          maxPendingPromptsPerSession: 5,
          listenerMaxConnections: 256,
          eventRingSize: 8000,
          compactedReplayMaxBytes: 4 * 1024 * 1024,
          maxJournalEvents: 10_000,
          maxJournalBytes: 8 * 1024 * 1024,
          promptDeadlineMs: null,
          writerIdleTimeoutMs: null,
          channelIdleTimeoutMs: 0,
          sessionIdleTimeoutMs: 1_800_000,
          acpConnectionCap: null,
          memory: expect.objectContaining({ enforced: false }),
        },
        capabilities: {
          protocolVersions: { current: 'v1', supported: ['v1'] },
          features: expect.arrayContaining(['daemon_status']),
        },
        runtime: {
          loading: false,
          error: 'runtime boom',
          sessions: { active: 0 },
          permissions: { pending: 0, policy: 'first-responder' },
          channel: { live: false },
          transport: {
            restSseActive: 0,
            acp: { enabled: false },
          },
          rateLimit: {
            enabled: false,
            rejectedSinceStart: { prompt: 0, mutation: 0, read: 0 },
          },
        },
        full: {
          sessions: [],
          acpMounts: [],
          acpConnections: [],
          workspace: {},
          auth: {
            supportedDeviceFlowProviders: [],
            pendingDeviceFlowCount: 0,
          },
        },
      });
      expect(sameOriginBody.daemon).not.toHaveProperty('logPath');
    } finally {
      if (originalClientMcpOverWs === undefined) {
        delete process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'];
      } else {
        process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'] = originalClientMcpOverWs;
      }
      if (originalCdpTunnelOverWs === undefined) {
        delete process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
      } else {
        process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'] = originalCdpTunnelOverWs;
      }
      await handle.close();
    }
  });

  it('reports the journal growth pool on bootstrap daemon status', async () => {
    // The bootstrap route derives the pool from the resolved budget; pin
    // the host figure so the expectation is runner-independent.
    mockTotalMemBytes.value = 8 * 1024 * 1024 * 1024;
    const constrainedSpy = vi
      .spyOn(
        process as { constrainedMemory: () => number },
        'constrainedMemory',
      )
      .mockReturnValue(0);
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-bootstrap-growth-')),
    );
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() => {
      throw new Error('runtime boom');
    });
    try {
      const handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          maxSessions: 1,
          serveWebShell: false,
        },
        { resolveOnListen: true },
      );
      try {
        await expect(handle.runtimeReady).rejects.toThrow('runtime boom');
        const res = await fetch(`${handle.url}/daemon/status`);
        const body = (await res.json()) as {
          limits: {
            memory: {
              journalGrowth: {
                poolBytes: number;
                hardCapBytes: number;
                baselineMaxEvents: number;
                baselineMaxBytes: number;
              } | null;
            };
          };
        };
        expect(body.limits.memory.journalGrowth).toEqual({
          poolBytes:
            journalGrowthPoolMb(
              resolveDaemonMemoryBudget({ availableMemoryMb: 8 * 1024 }),
            ) *
            1024 *
            1024,
          hardCapBytes: JOURNAL_GROWTH_HARD_CAP_BYTES,
          baselineMaxEvents: DEFAULT_MAX_JOURNAL_EVENTS,
          baselineMaxBytes: DEFAULT_MAX_JOURNAL_BYTES,
        });
      } finally {
        await handle.close();
      }

      const pinned = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          maxSessions: 1,
          serveWebShell: false,
          maxJournalBytes: 16 * 1024 * 1024,
        },
        { resolveOnListen: true },
      );
      try {
        await expect(pinned.runtimeReady).rejects.toThrow('runtime boom');
        const res = await fetch(`${pinned.url}/daemon/status`);
        const body = (await res.json()) as {
          limits: {
            memory: { journalGrowth: unknown };
          };
        };
        expect(body.limits.memory.journalGrowth).toBeNull();
      } finally {
        await pinned.close();
      }
    } finally {
      constrainedSpy.mockRestore();
      mockTotalMemBytes.value = undefined;
    }
  });

  it.each([true, false])(
    'mirrors the native directory picker probe on the bootstrap envelopes (available: %s)',
    async (available) => {
      tmpDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qws-bootstrap-picker-')),
      );
      // Keep the runtime from mounting so the bootstrap `/capabilities` and
      // `/daemon/status` envelopes stay the ones being served.
      vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() => {
        throw new Error('runtime boom');
      });
      const probe = vi
        .spyOn(nativeDirectoryPicker, 'isNativeDirectoryPickerAvailable')
        .mockReturnValue(available);
      const handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          maxSessions: 1,
          serveWebShell: false,
        },
        { resolveOnListen: true },
      );
      try {
        await expect(handle.runtimeReady).rejects.toThrow('runtime boom');
        const probeCallsAfterBoot = probe.mock.calls.length;
        const capabilities = (await (
          await fetch(`${handle.url}/capabilities`)
        ).json()) as { features: string[] };
        const status = (await (
          await fetch(`${handle.url}/daemon/status`)
        ).json()) as { capabilities: { features: string[] } };
        if (available) {
          expect(capabilities.features).toContain('native_directory_picker');
          expect(status.capabilities.features).toContain(
            'native_directory_picker',
          );
        } else {
          expect(capabilities.features).not.toContain(
            'native_directory_picker',
          );
          expect(status.capabilities.features).not.toContain(
            'native_directory_picker',
          );
        }
        // Probed once while the bootstrap app was built, not per request.
        expect(probe.mock.calls.length).toBe(probeCallsAfterBoot);
      } finally {
        await handle.close();
      }
    },
  );

  it('shuts down a bridge when runtime mounting fails after bridge creation', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-partial-fail-')),
    );
    const bridge = {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
      getSession: vi.fn(),
      getAllSessions: vi.fn().mockReturnValue([]),
      publishWorkspaceEvent: vi.fn(),
      getEventRing: vi.fn().mockReturnValue({ getAll: () => [] }),
      resume: vi.fn(),
      preheat: vi.fn().mockResolvedValue(undefined),
      getDaemonStatusSnapshot: vi.fn().mockReturnValue(BASE_BRIDGE_SNAPSHOT),
    } as unknown as HttpAcpBridge;
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(() => {
      throw new Error('runtime app boom');
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    try {
      await expect(handle.runtimeReady).rejects.toThrow('runtime app boom');
      expect(bridge.shutdown).toHaveBeenCalledTimes(1);
    } finally {
      await handle.close();
    }
    expect(bridge.shutdown).toHaveBeenCalledTimes(1);
  });

  it('shuts down all workspace bridges when multi-workspace runtime mounting fails', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-partial-fail-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const primaryBridge = makeRuntimeBridge();
    const secondaryBridge = makeRuntimeBridge();
    vi.spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValueOnce(
        primaryBridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      )
      .mockReturnValueOnce(
        secondaryBridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(() => {
      throw new Error('runtime app boom');
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, secondary],
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    try {
      await expect(handle.runtimeReady).rejects.toThrow('runtime app boom');
      expect(primaryBridge.shutdown).toHaveBeenCalledTimes(1);
      expect(secondaryBridge.shutdown).toHaveBeenCalledTimes(1);
    } finally {
      await handle.close();
    }
    expect(primaryBridge.shutdown).toHaveBeenCalledTimes(1);
    expect(secondaryBridge.shutdown).toHaveBeenCalledTimes(1);
  });

  it('cleans up runtime locals when closed immediately after listening', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-close-')),
    );
    const bridge = {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
      getSession: vi.fn(),
      getAllSessions: vi.fn().mockReturnValue([]),
      publishWorkspaceEvent: vi.fn(),
      getEventRing: vi.fn().mockReturnValue({ getAll: () => [] }),
      resume: vi.fn(),
      preheat: vi.fn().mockResolvedValue(undefined),
      getDaemonStatusSnapshot: vi.fn().mockReturnValue(BASE_BRIDGE_SNAPSHOT),
    } as unknown as HttpAcpBridge;
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    const dispose = vi.fn();
    const attachServer = vi.fn();
    const originalCreateServeApp = serverModule.createServeApp;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      const app = originalCreateServeApp(...args);
      app.locals['acpHandle'] = {
        attachServer,
        dispose,
        getSnapshot: () => ({
          connectionCount: 0,
          connectionStreams: 0,
          sessionStreams: 0,
          sseStreams: 0,
          wsStreams: 0,
          pendingClientRequests: 0,
          mounts: [],
          connections: [],
        }),
        registry: { getSnapshot: () => undefined },
      };
      return app;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    await handle.close();

    expect(bridge.shutdown).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the daemon event loop monitor when closed after listening', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-monitor-close-')),
    );
    const bridge = {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
      getSession: vi.fn(),
      getAllSessions: vi.fn().mockReturnValue([]),
      publishWorkspaceEvent: vi.fn(),
      getEventRing: vi.fn().mockReturnValue({ getAll: () => [] }),
      resume: vi.fn(),
      preheat: vi.fn().mockResolvedValue(undefined),
      getDaemonStatusSnapshot: vi.fn().mockReturnValue(BASE_BRIDGE_SNAPSHOT),
    } as unknown as HttpAcpBridge;
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    const dispose = vi.fn();
    vi.spyOn(qwenCore, 'startEventLoopLagMonitor').mockReturnValueOnce({
      snapshot: () => ({
        meanMs: 0,
        p50Ms: 0,
        p99Ms: 0,
        maxMs: 0,
      }),
      dispose,
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    await handle.close();

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

// Simulate the refresh chunk vanishing under a running daemon (an in-place
// upgrade replacing dist/): the module factory throws, so the first
// health-triggered runtime build's dynamic import rejects.
vi.mock('./server/session-pr-refresh.js', () => {
  throw new Error(
    'Cannot find module session-pr-refresh (simulated chunk replacement)',
  );
});

describe('session-pr-refresh degraded load on the serve fast path', () => {
  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('degrades to no PR-state sweep instead of leaking an unhandled rejection', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-pr-refresh-degrade-')),
    );
    // The serve fast path installs no process-level unhandledRejection
    // handler before the runtime builds, so record them here: without the
    // import's .catch the rejection escapes and Node's default is to exit.
    const rejections: unknown[] = [];
    const recordRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', recordRejection);
    let handle: RunHandle | undefined;
    try {
      ({ handle } = await startDeferredDaemon(tmpDir));
      const health = await fetch(`${handle.url}/health`);
      expect(health.status).toBe(200);
      // The first health schedules the runtime build; the refresh module
      // import fires inside it and rejects on the next turns.
      await expect(handle.runtimeReady).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(rejections).toEqual([]);
      // The intended degradation is "no PR-state sweep" — the daemon keeps
      // serving everything else.
      const healthAfter = await fetch(`${handle.url}/health`);
      expect(healthAfter.status).toBe(200);
    } finally {
      process.off('unhandledRejection', recordRejection);
      await handle?.close();
    }
  });
});

describe('runQwenServe Web Shell signals on RunHandle', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeFakeBridge(): HttpAcpBridge {
    return {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
      getSession: vi.fn(),
      getAllSessions: vi.fn().mockReturnValue([]),
      publishWorkspaceEvent: vi.fn(),
      getEventRing: vi.fn().mockReturnValue({ getAll: () => [] }),
      resume: vi.fn(),
      preheat: vi.fn().mockResolvedValue(undefined),
      getDaemonStatusSnapshot: vi.fn().mockReturnValue(BASE_BRIDGE_SNAPSHOT),
      isChannelLive: vi.fn().mockReturnValue(true),
    } as unknown as HttpAcpBridge;
  }

  async function bootHandle(extra: {
    serveWebShell?: boolean;
    token?: string;
    experimentalLsp?: boolean;
    restoreAskUserQuestion?: boolean;
  }) {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-ws-')));
    return runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        ...extra,
      },
      { bridge: makeFakeBridge() },
    );
  }

  it('reports webShellMounted=false when serveWebShell is false (--no-web)', async () => {
    const handle = await bootHandle({ serveWebShell: false });
    try {
      expect(handle.webShellMounted).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it('rejects before creating a listener when required Web Shell assets disappear after pre-check', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-ws-')));
    const resolveWebShellDir = vi
      .spyOn(webShellResolver, 'resolveWebShellDir')
      .mockReturnValueOnce('/tmp/web-shell')
      .mockReturnValueOnce(undefined);
    const httpServerFactory = vi.fn(() => {
      throw new Error('listener created');
    });
    const serveOptions = {
      port: 0,
      hostname: '127.0.0.1',
      mode: 'http-bridge' as const,
      workspace: tmpDir,
      maxSessions: 1,
    };

    applyOpenWithAuth(serveOptions);

    await expect(
      runQwenServe(serveOptions, {
        bridge: makeFakeBridge(),
        httpServerFactory,
      }),
    ).rejects.toThrow('--open-with-auth requires built Web Shell assets.');
    expect(resolveWebShellDir).toHaveBeenCalledTimes(2);
    expect(httpServerFactory).not.toHaveBeenCalled();
  });

  it('exposes the trimmed bearer token as resolvedToken', async () => {
    const handle = await bootHandle({ token: '  secret-token  ' });
    try {
      expect(handle.resolvedToken).toBe('secret-token');
    } finally {
      await handle.close();
    }
  });

  it('leaves resolvedToken undefined when no token is configured', async () => {
    const handle = await bootHandle({});
    try {
      expect(handle.resolvedToken).toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('passes --experimental-lsp to spawned ACP children only when opted in', async () => {
    mockCreateSpawnChannelFactoryOptions.length = 0;

    const defaultHandle = await bootHandle({ serveWebShell: false });
    await defaultHandle.close();
    expect(mockCreateSpawnChannelFactoryOptions.at(-1)).not.toHaveProperty(
      'extraArgs',
    );

    const lspHandle = await bootHandle({
      serveWebShell: false,
      experimentalLsp: true,
    });
    await lspHandle.close();
    expect(mockCreateSpawnChannelFactoryOptions.at(-1)).toMatchObject({
      extraArgs: ['--experimental-lsp'],
    });
  });

  it('merges --restore-ask-user-question with --experimental-lsp on ACP children', async () => {
    mockCreateSpawnChannelFactoryOptions.length = 0;

    const handle = await bootHandle({
      serveWebShell: false,
      experimentalLsp: true,
      restoreAskUserQuestion: true,
    });
    await handle.close();
    expect(mockCreateSpawnChannelFactoryOptions.at(-1)).toMatchObject({
      extraArgs: ['--experimental-lsp', '--restore-ask-user-question'],
    });
  });

  // Regression for #8653: the daemon scrubs loader vars from its own
  // process.env (session subprocesses run here in other workspaces' cwds)
  // AND from the frozen base env the session-hosting children spawn with —
  // a loader var reaching the ACP child runs during Node bootstrap, before
  // the child's own post-boot scrub could remove it.
  it('scrubs loader env vars from the daemon process and the session-child base env', async () => {
    const previousNodeOptions = process.env['NODE_OPTIONS'];
    const previousNodePath = process.env['NODE_PATH'];
    process.env['NODE_OPTIONS'] =
      '--import file:///other-checkout/register.mjs';
    process.env['NODE_PATH'] = '/other-checkout/node_modules';
    mockCreateSpawnChannelFactoryOptions.length = 0;
    const stderrWrites: string[] = [];
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });
    try {
      const handle = await bootHandle({ serveWebShell: false });
      try {
        expect(process.env['NODE_OPTIONS']).toBeUndefined();
        expect(process.env['NODE_PATH']).toBeUndefined();
        // The scrub must leave a breadcrumb naming the removed keys so a
        // subprocess missing an inherited var can be traced back to it.
        expect(stderrWrites.join('')).toContain(
          'scrubbed inherited loader env vars',
        );
        expect(stderrWrites.join('')).toContain('NODE_OPTIONS');
        expect(stderrWrites.join('')).toContain('NODE_PATH');
        const sourceEnv = mockCreateSpawnChannelFactoryOptions.at(-1)?.[
          'sourceEnv'
        ] as NodeJS.ProcessEnv | undefined;
        expect(sourceEnv?.['NODE_OPTIONS']).toBeUndefined();
        expect(sourceEnv?.['NODE_PATH']).toBeUndefined();
      } finally {
        await handle.close();
      }
      // runQwenServe is a documented embeddable entry point; close() must
      // hand the host process its launch environment back.
      expect(process.env['NODE_OPTIONS']).toBe(
        '--import file:///other-checkout/register.mjs',
      );
      expect(process.env['NODE_PATH']).toBe('/other-checkout/node_modules');
    } finally {
      stderrWrite.mockRestore();
      if (previousNodeOptions === undefined) {
        delete process.env['NODE_OPTIONS'];
      } else {
        process.env['NODE_OPTIONS'] = previousNodeOptions;
      }
      if (previousNodePath === undefined) {
        delete process.env['NODE_PATH'];
      } else {
        process.env['NODE_PATH'] = previousNodePath;
      }
    }
  });

  // The dev harness (scripts/dev.js) stamps DEV=true into the same env that
  // carries the tsx loader: dev-mode ACP children and channel workers boot
  // .ts entries and still need the loader, so only then does the frozen
  // base env keep loader vars.
  it('keeps loader vars in the session-child base env under the dev harness', async () => {
    const previousDev = process.env['DEV'];
    const previousNodeOptions = process.env['NODE_OPTIONS'];
    process.env['DEV'] = 'true';
    process.env['NODE_OPTIONS'] =
      '--import file:///other-checkout/register.mjs';
    mockCreateSpawnChannelFactoryOptions.length = 0;
    try {
      const handle = await bootHandle({ serveWebShell: false });
      try {
        const sourceEnv = mockCreateSpawnChannelFactoryOptions.at(-1)?.[
          'sourceEnv'
        ] as NodeJS.ProcessEnv | undefined;
        expect(sourceEnv?.['NODE_OPTIONS']).toBe(
          '--import file:///other-checkout/register.mjs',
        );
      } finally {
        await handle.close();
      }
    } finally {
      if (previousDev === undefined) {
        delete process.env['DEV'];
      } else {
        process.env['DEV'] = previousDev;
      }
      if (previousNodeOptions === undefined) {
        delete process.env['NODE_OPTIONS'];
      } else {
        process.env['NODE_OPTIONS'] = previousNodeOptions;
      }
    }
  });

  // DEV gates the scrub and must only come from the launch environment: a
  // workspace .env carrying DEV=true cannot keep loader vars in the
  // session-child base env (the #8653 vector by way of a spoofable gate).
  it('scrubs loader vars even when a workspace .env sets DEV=true', async () => {
    const previousDev = process.env['DEV'];
    const previousNodeOptions = process.env['NODE_OPTIONS'];
    const previousQwenRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    delete process.env['DEV'];
    process.env['NODE_OPTIONS'] =
      '--import file:///other-checkout/register.mjs';
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-ws-')));
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    fs.writeFileSync(path.join(tmpDir, '.env'), 'DEV=true\n');
    mockCreateSpawnChannelFactoryOptions.length = 0;
    try {
      loadServeFastPathEnvironment({}, tmpDir);
      // The hardcoded exclusion keeps DEV out of process.env entirely —
      // both from .env files and from settings.env.
      expect(process.env['DEV']).toBeUndefined();
      loadServeFastPathEnvironment({ env: { DEV: 'true' } }, tmpDir);
      expect(process.env['DEV']).toBeUndefined();
      const handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          maxSessions: 1,
          serveWebShell: false,
        },
        { bridge: makeFakeBridge() },
      );
      try {
        const sourceEnv = mockCreateSpawnChannelFactoryOptions.at(-1)?.[
          'sourceEnv'
        ] as NodeJS.ProcessEnv | undefined;
        expect(sourceEnv?.['NODE_OPTIONS']).toBeUndefined();
      } finally {
        await handle.close();
      }
    } finally {
      if (previousDev === undefined) {
        delete process.env['DEV'];
      } else {
        process.env['DEV'] = previousDev;
      }
      if (previousNodeOptions === undefined) {
        delete process.env['NODE_OPTIONS'];
      } else {
        process.env['NODE_OPTIONS'] = previousNodeOptions;
      }
      if (previousQwenRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = previousQwenRuntimeDir;
      }
    }
  });

  // Desktop/systemd-launched daemons rarely surface boot stderr, so the
  // scrub breadcrumb is additionally persisted to the durable daemon log.
  it('persists the loader env scrub decision in the daemon log', async () => {
    const previousNodeOptions = process.env['NODE_OPTIONS'];
    const previousQwenRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    process.env['NODE_OPTIONS'] =
      '--import file:///other-checkout/register.mjs';
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-ws-')));
    // Point the daemon log at the temp workspace (mirrors the daemon logger
    // wiring test) so the assertion reads a test-owned file.
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      const handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          maxSessions: 1,
          serveWebShell: false,
        },
        { bridge: makeFakeBridge() },
      );
      try {
        const logPath = path.join(tmpDir, 'debug', 'daemon', 'daemon.log');
        await vi.waitFor(
          () => {
            const content = fs.readFileSync(logPath, 'utf8');
            expect(content).toContain('scrubbed inherited loader env vars');
            expect(content).toContain('NODE_OPTIONS');
          },
          { timeout: 7_000, interval: 50 },
        );
      } finally {
        await handle.close();
      }
    } finally {
      if (previousNodeOptions === undefined) {
        delete process.env['NODE_OPTIONS'];
      } else {
        process.env['NODE_OPTIONS'] = previousNodeOptions;
      }
      if (previousQwenRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = previousQwenRuntimeDir;
      }
    }
  });

  // The serve fast path rejects loader keys before initDaemonLogger exists,
  // and warn-once dedupes any later daemon-side warning for the same
  // file+key, so its rejections are persisted to the durable daemon log.
  it('persists serve fast-path loader key rejections in the daemon log', async () => {
    const previousQwenRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-ws-')));
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'NODE_OPTIONS=--max-old-space-size=8192\n',
    );
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      loadServeFastPathEnvironment({}, tmpDir);
      const handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          maxSessions: 1,
          serveWebShell: false,
        },
        { bridge: makeFakeBridge() },
      );
      try {
        const logPath = path.join(tmpDir, 'debug', 'daemon', 'daemon.log');
        await vi.waitFor(
          () => {
            const content = fs.readFileSync(logPath, 'utf8');
            expect(content).toContain(
              'rejected loader-affecting env keys during serve fast-path boot',
            );
            expect(content).toContain('NODE_OPTIONS');
          },
          { timeout: 7_000, interval: 50 },
        );
      } finally {
        await handle.close();
      }
    } finally {
      stderrWrite.mockRestore();
      if (previousQwenRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = previousQwenRuntimeDir;
      }
    }
  });

  // Per-workspace .env loads keep running long after boot (skill status,
  // settings reloads); boot stderr is gone by then, so fresh loader-key
  // rejections must be mirrored into the durable daemon log.
  it('persists post-boot loader key rejections in the daemon log', async () => {
    const previousQwenRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    const previousNodeOptions = process.env['NODE_OPTIONS'];
    delete process.env['NODE_OPTIONS'];
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-ws-')));
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          maxSessions: 1,
          serveWebShell: false,
        },
        { bridge: makeFakeBridge() },
      );
      try {
        fs.writeFileSync(
          path.join(tmpDir, '.env'),
          'NODE_OPTIONS=--max-old-space-size=8192\n',
        );
        loadEnvironment({}, tmpDir);
        const logPath = path.join(tmpDir, 'debug', 'daemon', 'daemon.log');
        await vi.waitFor(
          () => {
            const content = fs.readFileSync(logPath, 'utf8');
            expect(content).toContain(
              'rejected loader-affecting env keys; they were not applied',
            );
            expect(content).toContain('NODE_OPTIONS');
          },
          { timeout: 7_000, interval: 50 },
        );
      } finally {
        await handle.close();
      }
    } finally {
      stderrWrite.mockRestore();
      if (previousQwenRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = previousQwenRuntimeDir;
      }
      if (previousNodeOptions === undefined) {
        delete process.env['NODE_OPTIONS'];
      } else {
        process.env['NODE_OPTIONS'] = previousNodeOptions;
      }
    }
  });

  // close() uninstalls the daemon-log reporter; a later env load in the
  // same process must fall back to stderr instead of writing into the
  // closed daemon log.
  it('falls back to stderr for loader key rejections after close', async () => {
    const previousQwenRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    const previousNodeOptions = process.env['NODE_OPTIONS'];
    delete process.env['NODE_OPTIONS'];
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-ws-')));
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      const handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          maxSessions: 1,
          serveWebShell: false,
        },
        { bridge: makeFakeBridge() },
      );
      await handle.close();

      // The file appears only after close, so no earlier report could have
      // seeded the warn-once dedup for this source.
      fs.writeFileSync(
        path.join(tmpDir, '.env'),
        'NODE_OPTIONS=--max-old-space-size=8192\n',
      );
      const stderrWrites: string[] = [];
      const stderrWrite = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((chunk) => {
          stderrWrites.push(String(chunk));
          return true;
        });
      try {
        loadEnvironment({}, tmpDir);
      } finally {
        stderrWrite.mockRestore();
      }

      const warnings = stderrWrites.filter(
        (chunk) =>
          chunk.includes('cannot set loader-affecting env vars') &&
          chunk.includes(tmpDir),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('NODE_OPTIONS');
      expect(process.env['NODE_OPTIONS']).toBeUndefined();
    } finally {
      if (previousQwenRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = previousQwenRuntimeDir;
      }
      if (previousNodeOptions === undefined) {
        delete process.env['NODE_OPTIONS'];
      } else {
        process.env['NODE_OPTIONS'] = previousNodeOptions;
      }
    }
  });

  // runQwenServe is a documented embeddable entry point and startup can
  // reject after the scrub (malformed deadline env, TLS mismatch,
  // EADDRINUSE...). The close() restore is unreachable on that path, so the
  // catch must hand the host its launch environment back.
  it('restores the launch environment when startup fails after the scrub', async () => {
    const previousNodeOptions = process.env['NODE_OPTIONS'];
    const previousDeadline = process.env['QWEN_SERVE_PROMPT_DEADLINE_MS'];
    process.env['NODE_OPTIONS'] =
      '--import file:///other-checkout/register.mjs';
    process.env['QWEN_SERVE_PROMPT_DEADLINE_MS'] = 'not-a-number';
    try {
      await expect(bootHandle({ serveWebShell: false })).rejects.toThrow(
        /QWEN_SERVE_PROMPT_DEADLINE_MS/u,
      );
      expect(process.env['NODE_OPTIONS']).toBe(
        '--import file:///other-checkout/register.mjs',
      );
    } finally {
      if (previousNodeOptions === undefined) {
        delete process.env['NODE_OPTIONS'];
      } else {
        process.env['NODE_OPTIONS'] = previousNodeOptions;
      }
      if (previousDeadline === undefined) {
        delete process.env['QWEN_SERVE_PROMPT_DEADLINE_MS'];
      } else {
        process.env['QWEN_SERVE_PROMPT_DEADLINE_MS'] = previousDeadline;
      }
    }
  });

  it('wires the pipe message observer without changing existing pipe stats', async () => {
    mockCreateSpawnChannelFactoryOptions.length = 0;

    const handle = await bootHandle({ serveWebShell: false });
    try {
      await handle.runtimeReady;
      const pipeHooks = mockCreateSpawnChannelFactoryOptions.at(-1)?.[
        'pipeHooks'
      ] as
        | {
            onMessageSent?: (bytes: number) => void;
            onMessageReceived?: (bytes: number) => void;
            onMessageObserved?: (observation: {
              direction: 'sent' | 'received';
              bytes: number;
              message: unknown;
            }) => void;
          }
        | undefined;

      expect(pipeHooks?.onMessageObserved).toEqual(expect.any(Function));
      pipeHooks?.onMessageSent?.(123);
      pipeHooks?.onMessageReceived?.(456);
      pipeHooks?.onMessageObserved?.({
        direction: 'sent',
        bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
        message: {
          jsonrpc: '2.0',
          method: 'session/update',
          params: { update: { sessionUpdate: 'agent_message_chunk' } },
        },
      });

      const res = await fetch(`${handle.url}/daemon/status`);
      const body = (await res.json()) as {
        runtime?: {
          perf?: {
            pipe?: {
              inbound?: { count?: number; totalBytes?: number };
              outbound?: { count?: number; totalBytes?: number };
            };
          };
        };
      };

      expect(body.runtime?.perf?.pipe).toMatchObject({
        inbound: { count: 1, totalBytes: 456 },
        outbound: { count: 1, totalBytes: 123 },
      });
    } finally {
      await handle.close();
    }
  });
});

describe('runQwenServe channel worker supervisor', () => {
  let tmpDir: string | undefined;
  // Some CI containers disable IPv6 entirely; binding ::1 then fails with
  // EADDRNOTAVAIL.
  const hasIpv6Loopback = Object.values(os.networkInterfaces()).some(
    (addresses) =>
      addresses?.some(
        (info) => info.family === 'IPv6' && info.address === '::1',
      ),
  );

  afterEach(() => {
    mockChannelWorkerEnabledState.value = undefined;
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function makeFakeBridge(onShutdown?: () => void): HttpAcpBridge {
    return {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockImplementation(async () => {
        onShutdown?.();
      }),
      killAllSync: vi.fn(),
      getSession: vi.fn(),
      getAllSessions: vi.fn().mockReturnValue([]),
      publishWorkspaceEvent: vi.fn(),
      getEventRing: vi.fn().mockReturnValue({ getAll: () => [] }),
      resume: vi.fn(),
      preheat: vi.fn().mockResolvedValue(undefined),
      getDaemonStatusSnapshot: vi.fn().mockReturnValue(BASE_BRIDGE_SNAPSHOT),
      isChannelLive: vi.fn().mockReturnValue(true),
    } as unknown as HttpAcpBridge;
  }

  function makeWorker(snapshot: ChannelWorkerSnapshot) {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue(snapshot),
      killAllSync: vi.fn(),
      snapshot: vi.fn(() => snapshot),
      enqueueWebhookTask: vi
        .fn()
        .mockRejectedValue(new Error('Channel worker is not running.')),
      deliverChannelMessage: vi
        .fn()
        .mockRejectedValue(new Error('Channel worker is not running.')),
    };
  }

  function makeReadyWorkerFactory(worker: ReturnType<typeof makeWorker>) {
    return vi.fn((opts: CreateChannelWorkerSupervisorOptions) => {
      worker.start.mockImplementation(async () => {
        opts.onReady?.(worker.snapshot());
      });
      return worker;
    });
  }

  function makePidfileDeps() {
    return {
      readServiceInfo: vi.fn<() => ServiceInfo | null>(() => null),
      writeServeServiceInfo: vi.fn(),
      reserveServeServiceInfo: vi.fn(),
      removeServiceInfo: vi.fn(),
      removeServeServiceInfo: vi.fn(() => true),
    };
  }

  it('rejects webhook tasks when the channel worker is disabled', async () => {
    const supervisor = createDisabledChannelWorkerSupervisor();

    await expect(
      supervisor.enqueueWebhookTask({
        channelName: 'telegram',
        source: 'github-ci',
        eventType: 'check_failed',
        targetRef: 'default',
        title: 'CI failed',
        payload: { runId: 123 },
      }),
    ).rejects.toMatchObject({
      code: 'channel_worker_unavailable',
      message: 'Channel worker is not running.',
    } satisfies Partial<ChannelWebhookEnqueueError>);
  });

  it('hands workers an absolute --tls-cert path and an https daemon url', async () => {
    // Workers are forked with `cwd: opts.workspace`, so a relative
    // --tls-cert would resolve against the worker's cwd, load nothing, and
    // fail every handshake with DEPTH_ZERO_SELF_SIGNED_CERT.
    // `path.relative` returns the ABSOLUTE target across Windows drives, and
    // the merge-queue `Test (windows-latest, Node 22.x)` job runs from
    // `D:\a\qwen-code\qwen-code` while `os.tmpdir()` sits on C: — where the
    // precondition below fails and takes a required gate red. `TMPDIR` cannot
    // move it: win32 `os.tmpdir()` reads TMP/TEMP/USERPROFILE, never TMPDIR.
    // So fall back to a directory under the vitest cwd, which is reachable
    // relatively on every platform.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-tls-')),
    );
    if (path.isAbsolute(path.relative(process.cwd(), tmpDir))) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = fs.realpathSync(
        fs.mkdtempSync(path.join(process.cwd(), 'qws-channel-tls-')),
      );
    }
    const certPath = path.join(tmpDir, 'cert.pem');
    const keyPath = path.join(tmpDir, 'key.pem');
    fs.writeFileSync(certPath, TEST_TLS_CERT);
    fs.writeFileSync(keyPath, TEST_TLS_KEY);
    const relativeCert = path.relative(process.cwd(), certPath);
    expect(path.isAbsolute(relativeCert)).toBe(false);
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const factory = makeReadyWorkerFactory(worker);

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        tlsCert: relativeCert,
        tlsKey: path.relative(process.cwd(), keyPath),
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: factory,
        channelServicePidfile: makePidfileDeps(),
      },
    );

    try {
      await handle.runtimeReady;
      const opts = factory.mock.calls[0]![0];
      expect(opts.tlsCaCertPath).toBe(certPath);
      expect(opts.daemonUrl).toMatch(/^https:\/\//);
    } finally {
      await handle.close();
    }
  });

  it('certifies the channel worker daemon URL at boot before workers start', async () => {
    // Deleting the assertChannelWorkerDaemonUrlIsLocal call site in
    // ensureChannelWorkerManager leaves this uncalled (mutation M3 in the
    // #9406 review): the direct-call suite above never observes the boot
    // path, so pin the boot wiring itself.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-url-certify-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const factory = makeReadyWorkerFactory(worker);
    const channelWorkerUrlCertifier = vi.fn();
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: factory,
        channelServicePidfile: makePidfileDeps(),
        channelWorkerUrlCertifier,
      },
    );

    try {
      await handle.runtimeReady;
      expect(channelWorkerUrlCertifier).toHaveBeenCalledTimes(1);
      const [daemonUrl, hostname] = channelWorkerUrlCertifier.mock.calls[0]!;
      expect(hostname).toBe('127.0.0.1');
      expect(daemonUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(factory).toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('preserves localhost in the TLS channel worker daemon URL after resolving the bind', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-localhost-tls-')),
    );
    const certPath = path.join(tmpDir, 'cert.pem');
    const keyPath = path.join(tmpDir, 'key.pem');
    fs.writeFileSync(certPath, TEST_TLS_CERT);
    fs.writeFileSync(keyPath, TEST_TLS_KEY);
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const factory = makeReadyWorkerFactory(worker);
    const channelWorkerUrlCertifier = vi.fn();
    const bindHostnameLookup = vi.fn(async () => ({
      address: '127.0.0.1',
      family: 4,
    }));
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: 'localhost',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        tlsCert: certPath,
        tlsKey: keyPath,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        bindHostnameLookup,
        channelWorkerSupervisorFactory: factory,
        channelServicePidfile: makePidfileDeps(),
        channelWorkerUrlCertifier,
      },
    );

    try {
      await handle.runtimeReady;
      expect(bindHostnameLookup).toHaveBeenCalledWith('localhost');
      expect(channelWorkerUrlCertifier).toHaveBeenCalledTimes(1);
      const [daemonUrl, hostname] = channelWorkerUrlCertifier.mock.calls[0]!;
      expect(hostname).toBe('localhost');
      expect(daemonUrl).toMatch(/^https:\/\/localhost:\d+$/);
      expect(factory.mock.calls[0]![0].daemonUrl).toBe(daemonUrl);
    } finally {
      await handle.close();
    }
  });

  it('keeps the resolved address in a non-TLS channel worker daemon URL', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-localhost-http-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const factory = makeReadyWorkerFactory(worker);
    const channelWorkerUrlCertifier = vi.fn();
    const bindHostnameLookup = vi.fn(async () => ({
      address: '127.0.0.1',
      family: 4,
    }));
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: 'localhost',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        bindHostnameLookup,
        channelWorkerSupervisorFactory: factory,
        channelServicePidfile: makePidfileDeps(),
        channelWorkerUrlCertifier,
      },
    );

    try {
      await handle.runtimeReady;
      expect(bindHostnameLookup).toHaveBeenCalledWith('localhost');
      expect(channelWorkerUrlCertifier).toHaveBeenCalledTimes(1);
      const [daemonUrl, hostname] = channelWorkerUrlCertifier.mock.calls[0]!;
      expect(hostname).toBe('127.0.0.1');
      expect(daemonUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(factory.mock.calls[0]![0].daemonUrl).toBe(daemonUrl);
    } finally {
      await handle.close();
    }
  });

  it('fails the channel boot when the worker URL certification refuses the bind', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-url-refuse-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const factory = makeReadyWorkerFactory(worker);
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: factory,
        channelServicePidfile: makePidfileDeps(),
        resolveOnListen: true,
        channelWorkerUrlCertifier: () => {
          throw new Error(
            'Channels cannot start: --hostname "127.0.0.1" is not a ' +
              'loopback bind',
          );
        },
      },
    );

    try {
      await expect(handle.runtimeReady).rejects.toThrow(
        /Channels cannot start/,
      );
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  async function bootTlsDaemonForTrustGapLog(
    hostname: string,
    serving: { cert: string; key: string } = {
      cert: TEST_TLS_CERT,
      key: TEST_TLS_KEY,
    },
    workerTlsTrustVerifier?: RunQwenServeDeps['workerTlsTrustVerifier'],
  ): Promise<string> {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-gap-')),
    );
    const certPath = path.join(tmpDir, 'cert.pem');
    const keyPath = path.join(tmpDir, 'key.pem');
    fs.writeFileSync(certPath, serving.cert);
    fs.writeFileSync(keyPath, serving.key);
    const logBaseDir = path.join(tmpDir, 'debug');
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname,
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        tlsCert: certPath,
        tlsKey: keyPath,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: makeReadyWorkerFactory(worker),
        channelServicePidfile: makePidfileDeps(),
        daemonLogBaseDir: logBaseDir,
        ...(workerTlsTrustVerifier ? { workerTlsTrustVerifier } : {}),
      },
    );
    try {
      await handle.runtimeReady;
    } finally {
      await handle.close();
    }
    return fs.readFileSync(
      path.join(logBaseDir, 'daemon', 'daemon.log'),
      'utf8',
    );
  }

  it.skipIf(!hasIpv6Loopback)(
    'writes a worker TLS trust gap to the daemon log at boot',
    async () => {
      // R2-6: only the pure describeWorkerTlsTrustGaps was covered, so
      // deleting this loop, inverting its `tlsOptions && tlsCertPath` guard
      // or feeding it unresolved values all shipped green — and operators
      // were back in the silent mode this diagnostic exists to end: daemon
      // boots, /health green, every channel worker restart-looping with no
      // log line saying why. The fixture cert covers 127.0.0.1 and
      // localhost, so a ::1 bind is a real SAN gap on a cert that still
      // pairs with its key and boots.
      const log = await bootTlsDaemonForTrustGapLog('::1');

      expect(log).toContain('ERR_TLS_CERT_ALTNAME_INVALID');
      expect(log).toContain('::1');
    },
  );

  it('keeps the daemon log quiet when the serving cert covers the dialled host', async () => {
    // The other half of the wiring: a guard stuck on would bury real boot
    // warnings under a gap every TLS daemon reports.
    const log = await bootTlsDaemonForTrustGapLog('127.0.0.1');

    expect(log).not.toContain('ERR_TLS_CERT_ALTNAME_INVALID');
    expect(log).not.toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  });

  it('reports a real verifier failure the static explanation does not model', async () => {
    const log = await bootTlsDaemonForTrustGapLog(
      '127.0.0.1',
      { cert: TEST_TLS_CERT, key: TEST_TLS_KEY },
      async () => ({
        code: 'INVALID_PURPOSE',
        message: 'unsuitable certificate purpose',
      }),
    );

    expect(log).toContain('exact CA bundle workers receive');
    expect(log).toContain('INVALID_PURPOSE');
    expect(log).toContain('unsuitable certificate purpose');
  });

  it('skips the worker TLS trust check when NODE_TLS_REJECT_UNAUTHORIZED disables verification', async () => {
    // R23-10: workers inherit NODE_TLS_REJECT_UNAUTHORIZED unscrubbed
    // (createWorkerEnv copies the env wholesale) and dial via fetch, which
    // honors it — a first-class mode in this project (`--insecure` sets
    // it). The probe hardcodes `rejectUnauthorized: true`, so under ='0' it
    // fails while every worker connects fine, and boot logged a certain
    // outage for an outage that never happens. Measured on Node v22.23.2:
    // probe UNABLE_TO_VERIFY_LEAF_SIGNATURE, worker fetch 200.
    const workerTlsTrustVerifier = vi.fn().mockResolvedValue({
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      message: 'unable to verify the first certificate',
    });
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    try {
      const log = await bootTlsDaemonForTrustGapLog(
        '127.0.0.1',
        { cert: TEST_TLS_CERT, key: TEST_TLS_KEY },
        workerTlsTrustVerifier,
      );
      expect(workerTlsTrustVerifier).not.toHaveBeenCalled();
      expect(log).toContain('NODE_TLS_REJECT_UNAUTHORIZED=0');
      expect(log).not.toContain('exact CA bundle workers receive');
    } finally {
      delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    }
  });

  it('normalizes a TLS trust probe process exit code before logging it', async () => {
    const failure = await verifyWorkerTlsTrust({
      daemonUrl: 'not a URL',
      caCertPath: path.join(os.tmpdir(), 'qwen-missing-ca.pem'),
      timeoutMs: 250,
    });

    expect(failure?.code).toEqual(expect.any(String));
  });

  it('normalizes a killed TLS trust probe to the generic failure code', async () => {
    // R29-1: execFile reports error.code === null (not undefined) when its
    // timeout budget kills the child, so a null-blind check coerced the kill
    // to the literal code 'null' — a definitive CA-misconfiguration alarm for
    // an inconclusive probe. Block the child in a required module so the
    // parent's timeoutMs + 1_000 budget fires before the probe writes its
    // JSON verdict; the probe script's own handler already null-coalesces.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tls-kill-')),
    );
    const blocker = path.join(tmpDir, 'block.cjs');
    fs.writeFileSync(blocker, 'for (;;) {}');
    const previousNodeOptions = process.env['NODE_OPTIONS'];
    process.env['NODE_OPTIONS'] = `--require ${blocker}`;
    try {
      const failure = await verifyWorkerTlsTrust({
        daemonUrl: 'https://127.0.0.1:1',
        caCertPath: path.join(tmpDir, 'ca.pem'),
        timeoutMs: 250,
      });
      expect(failure?.code).toBe('WORKER_TLS_VERIFY_FAILED');
    } finally {
      if (previousNodeOptions === undefined) {
        delete process.env['NODE_OPTIONS'];
      } else {
        process.env['NODE_OPTIONS'] = previousNodeOptions;
      }
    }
  });

  it('boots TLS channels and logs once when loader inspection cannot run', async () => {
    // R22-1: on Node 22.0-22.14 (and on any oracle infrastructure failure)
    // the loader inspection throws instead of answering. Before the guard the
    // throw escaped ensureChannelWorkerManager and turned TLS + channels into
    // a runtime-startup failure — the exact outage this PR exists to fix. The
    // guard keeps the daemon booting: one log line, and the live probe and
    // the workers still run.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-inspect-')),
    );
    const certPath = path.join(tmpDir, 'cert.pem');
    const keyPath = path.join(tmpDir, 'key.pem');
    fs.writeFileSync(certPath, TEST_TLS_CERT);
    fs.writeFileSync(keyPath, TEST_TLS_KEY);
    const logBaseDir = path.join(tmpDir, 'debug');
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const factory = makeReadyWorkerFactory(worker);
    const workerTlsTrustVerifier = vi.fn().mockResolvedValue(undefined);
    const inspection = vi
      .spyOn(pemCertificateBlocks, 'loadableCertificates')
      .mockImplementation(() => {
        throw new pemCertificateBlocks.ExtraCaInspectionError(
          'Inspecting NODE_EXTRA_CA_CERTS requires Node.js 22.15.0 or newer.',
        );
      });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        tlsCert: certPath,
        tlsKey: keyPath,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: factory,
        channelServicePidfile: makePidfileDeps(),
        daemonLogBaseDir: logBaseDir,
        workerTlsTrustVerifier,
      },
    );
    try {
      await handle.runtimeReady;
      expect(workerTlsTrustVerifier).toHaveBeenCalledTimes(1);
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      inspection.mockRestore();
      await handle.close();
    }
    // The daemon log flushes on close, so read it last, the way
    // bootTlsDaemonForTrustGapLog does.
    const log = fs.readFileSync(
      path.join(logBaseDir, 'daemon', 'daemon.log'),
      'utf8',
    );
    expect(log).toContain('trust-gap inspection could not run');
    expect(log).toContain('Node.js 22.15.0 or newer');
    // One inspection failure is one log line, not one per re-entry.
    expect(log.split('trust-gap inspection could not run').length).toBe(2);
  });

  it('does not start channel workers after close begins during TLS verification', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-tls-close-')),
    );
    const certPath = path.join(tmpDir, 'cert.pem');
    const keyPath = path.join(tmpDir, 'key.pem');
    fs.writeFileSync(certPath, TEST_TLS_CERT);
    fs.writeFileSync(keyPath, TEST_TLS_KEY);
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const factory = makeReadyWorkerFactory(worker);
    let finishVerification!: () => void;
    const verification = new Promise<undefined>((resolve) => {
      finishVerification = () => resolve(undefined);
    });
    const workerTlsTrustVerifier = vi.fn(() => verification);
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        tlsCert: certPath,
        tlsKey: keyPath,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: factory,
        channelServicePidfile: makePidfileDeps(),
        resolveOnListen: true,
        workerTlsTrustVerifier,
      },
    );

    const runtimeReady = handle.runtimeReady.catch(() => undefined);
    try {
      await vi.waitFor(() => {
        expect(workerTlsTrustVerifier).toHaveBeenCalledTimes(1);
      });
      const closing = handle.close();
      finishVerification();
      await closing;
      await runtimeReady;

      expect(factory).not.toHaveBeenCalled();
      expect(worker.start).not.toHaveBeenCalled();
    } finally {
      finishVerification();
      await handle.close();
    }
  });

  it('starts a TLS channel worker after the daemon runtime is ready', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-tls-lazy-')),
    );
    fs.mkdirSync(path.join(tmpDir, '.qwen'));
    fs.writeFileSync(
      path.join(tmpDir, '.qwen', 'settings.json'),
      JSON.stringify({ channels: { telegram: { type: 'telegram' } } }),
    );
    const certPath = path.join(tmpDir, 'cert.pem');
    const keyPath = path.join(tmpDir, 'key.pem');
    fs.writeFileSync(certPath, TEST_TLS_CERT);
    fs.writeFileSync(keyPath, TEST_TLS_KEY);
    let capturedDeps:
      | Parameters<typeof serverModule.createServeApp>[2]
      | undefined;
    const originalCreateServeApp = serverModule.createServeApp;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      capturedDeps = args[2];
      return originalCreateServeApp(...args);
    });
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    const factory = makeReadyWorkerFactory(worker);
    const workerTlsTrustVerifier = vi.fn().mockResolvedValue(undefined);
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        tlsCert: certPath,
        tlsKey: keyPath,
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: factory,
        channelServicePidfile: makePidfileDeps(),
        workerTlsTrustVerifier,
      },
    );

    try {
      await handle.runtimeReady;
      await expect(
        capturedDeps!.setChannelWorkerSelection!({
          mode: 'names',
          names: ['telegram'],
        }),
      ).resolves.toMatchObject({ changed: true });
      await expect(
        capturedDeps!.setChannelWorkerSelection!({
          mode: 'names',
          names: ['telegram'],
        }),
      ).resolves.toMatchObject({ changed: false });
      expect(workerTlsTrustVerifier).toHaveBeenCalledTimes(1);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(worker.start).toHaveBeenCalledTimes(1);
    } finally {
      await handle.close();
    }
  });

  const issuedLeafServing = {
    cert: TEST_TLS_CERT_ISSUED_LEAF,
    key: TEST_TLS_KEY_ISSUED_LEAF,
  };

  it('names the anchor gap for a CA-issued cert with no operator CA set', async () => {
    // The control for the two wiring tests below: with NODE_EXTRA_CA_CERTS
    // unset this serving cert really is unanchored, so a quiet log in the
    // next test can only come from the operator CA being read.
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '');
    try {
      const log = await bootTlsDaemonForTrustGapLog(
        '127.0.0.1',
        issuedLeafServing,
      );
      expect(log).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  loaderOracleTest(
    'reads NODE_EXTRA_CA_CERTS from the environment when judging the gap',
    async () => {
      // R3-7: nothing drove the wiring that reads the env, resolves it and
      // hands the contents to describeWorkerTlsTrustGaps — replacing that read
      // with `undefined` shipped green. Then an operator whose CA genuinely
      // anchors the chain gets a false UNABLE_TO_VERIFY_LEAF_SIGNATURE warning
      // on every startup, and the content-based fix becomes dead code.
      const caDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qws-operator-ca-')),
      );
      const operatorCaPath = path.join(caDir, 'rootCA.pem');
      fs.writeFileSync(operatorCaPath, TEST_TLS_CERT_ISSUING_ROOT);
      vi.stubEnv('NODE_EXTRA_CA_CERTS', operatorCaPath);
      try {
        const log = await bootTlsDaemonForTrustGapLog(
          '127.0.0.1',
          issuedLeafServing,
        );
        expect(log).not.toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
      } finally {
        vi.unstubAllEnvs();
        fs.rmSync(caDir, { recursive: true, force: true });
      }
    },
  );

  loaderOracleTest(
    'still boots and still names the gap when NODE_EXTRA_CA_CERTS is unreadable',
    async () => {
      // R3-7(b): the try/catch around the read is what lets a typo'd path
      // degrade to "it anchors nothing". Without it the throw lands inside the
      // channel-manager starting closure and channel startup fails on exactly
      // the case the code says must degrade.
      vi.stubEnv(
        'NODE_EXTRA_CA_CERTS',
        path.join(os.tmpdir(), 'qws-no-such-ca-file.pem'),
      );
      try {
        const log = await bootTlsDaemonForTrustGapLog(
          '127.0.0.1',
          issuedLeafServing,
        );
        expect(log).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
        expect(log).toContain('qws-no-such-ca-file.pem');
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it('forwards webhook tasks through the channel worker group', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-webhook-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    worker.enqueueWebhookTask.mockResolvedValueOnce({ accepted: true });
    worker.deliverChannelMessage.mockResolvedValueOnce({ delivered: true });
    const originalCreateServeApp = serverModule.createServeApp;
    let capturedDeps:
      | Parameters<typeof serverModule.createServeApp>[2]
      | undefined;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      capturedDeps = args[2];
      return originalCreateServeApp(...args);
    });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: makeReadyWorkerFactory(worker),
        channelServicePidfile: makePidfileDeps(),
      },
    );
    const task = {
      channelName: 'telegram',
      source: 'github-ci',
      eventType: 'check_failed',
      targetRef: 'default',
      title: 'CI failed',
      payload: { runId: 123 },
    };

    try {
      await handle.runtimeReady;
      expect(capturedDeps?.enqueueChannelWebhookTask).toEqual(
        expect.any(Function),
      );
      await expect(
        capturedDeps!.enqueueChannelWebhookTask!(task),
      ).resolves.toEqual({ accepted: true });
      expect(worker.enqueueWebhookTask).toHaveBeenCalledWith(task);
      const delivery = {
        deliveryId: 'delivery-1',
        channelName: 'telegram',
        target: { type: 'user' as const, id: 'user-1' },
        text: 'CI failed',
      };
      await expect(
        capturedDeps!.deliverChannelMessage!(tmpDir, delivery),
      ).resolves.toEqual({ delivered: true });
      expect(worker.deliverChannelMessage).toHaveBeenCalledWith(delivery);
    } finally {
      await handle.close();
    }
  });

  it('keeps webhook enqueue available when no worker is selected', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-webhook-disabled-')),
    );
    const originalCreateServeApp = serverModule.createServeApp;
    let capturedDeps:
      | Parameters<typeof serverModule.createServeApp>[2]
      | undefined;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      capturedDeps = args[2];
      return originalCreateServeApp(...args);
    });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
      },
      { bridge: makeFakeBridge() },
    );

    try {
      await handle.runtimeReady;
      expect(capturedDeps?.enqueueChannelWebhookTask).toEqual(
        expect.any(Function),
      );
      await expect(
        capturedDeps!.enqueueChannelWebhookTask!({
          channelName: 'telegram',
          source: 'github-ci',
          eventType: 'check_failed',
          targetRef: 'default',
          title: 'CI failed',
          payload: { runId: 123 },
        }),
      ).rejects.toMatchObject({ code: 'channel_worker_unavailable' });
      await expect(
        capturedDeps!.deliverChannelMessage!(tmpDir, {
          deliveryId: 'delivery-1',
          channelName: 'telegram',
          target: { type: 'user', id: 'user-1' },
          text: 'CI failed',
        }),
      ).rejects.toMatchObject({ code: 'channel_worker_unavailable' });
    } finally {
      await handle.close();
    }
  });

  it('enables, queries, idempotently reapplies, and stops channels after boot', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-runtime-control-')),
    );
    fs.mkdirSync(path.join(tmpDir, '.qwen'));
    fs.writeFileSync(
      path.join(tmpDir, '.qwen', 'settings.json'),
      JSON.stringify({ channels: { telegram: { type: 'telegram' } } }),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    const workerFactory = makeReadyWorkerFactory(worker);
    const pidfile = makePidfileDeps();
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        token: 'secret',
        serveWebShell: false,
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: workerFactory,
        channelServicePidfile: pidfile,
      },
    );
    const headers = {
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    };

    try {
      expect(workerFactory).not.toHaveBeenCalled();
      expect(pidfile.reserveServeServiceInfo).not.toHaveBeenCalled();

      const beforeCaps = await fetch(`${handle.url}/capabilities`, { headers });
      expect(await beforeCaps.json()).toMatchObject({
        features: expect.arrayContaining([
          'channel_control',
          'channel_management',
        ]),
      });
      const channels = await fetch(`${handle.url}/workspace/channels`, {
        headers,
      });
      expect(channels.status).toBe(200);
      expect(await channels.json()).toMatchObject({
        instances: {
          telegram: {
            name: 'telegram',
            config: { type: 'telegram' },
            secrets: {},
            startsWithServe: false,
            runtime: { state: 'stopped' },
          },
        },
      });

      const enable = await fetch(`${handle.url}/workspace/channel`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          selection: { mode: 'names', names: ['telegram'] },
        }),
      });
      expect(enable.status).toBe(201);
      expect(await enable.json()).toMatchObject({
        changed: true,
        replaced: false,
        state: {
          enabled: true,
          selection: { mode: 'names', names: ['telegram'] },
          transition: 'idle',
        },
      });
      expect(workerFactory).toHaveBeenCalledTimes(1);
      expect(pidfile.reserveServeServiceInfo).toHaveBeenCalledWith({
        channels: ['telegram'],
        servePid: process.pid,
      });

      const afterCaps = await fetch(`${handle.url}/capabilities`, { headers });
      expect(await afterCaps.json()).toMatchObject({
        features: expect.arrayContaining([
          'channel_control',
          'channel_management',
          'channel_reload',
        ]),
      });

      worker.start.mockClear();
      const same = await fetch(`${handle.url}/workspace/channel`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          selection: { mode: 'names', names: ['telegram'] },
        }),
      });
      expect(same.status).toBe(200);
      expect(await same.json()).toMatchObject({ changed: false });
      expect(worker.start).not.toHaveBeenCalled();
      expect(workerFactory).toHaveBeenCalledTimes(1);

      const stop = await fetch(`${handle.url}/workspace/channel`, {
        method: 'DELETE',
        headers,
      });
      expect(stop.status).toBe(200);
      expect(await stop.json()).toMatchObject({
        changed: true,
        state: { enabled: false, selection: null, workers: [] },
      });
      expect(worker.stop).toHaveBeenCalledTimes(1);
      expect(pidfile.removeServeServiceInfo).toHaveBeenCalledWith(process.pid);

      const stoppedCaps = await fetch(`${handle.url}/capabilities`, {
        headers,
      });
      const stoppedFeatures = (await stoppedCaps.json()) as {
        features: string[];
      };
      expect(stoppedFeatures.features).toContain('channel_control');
      expect(stoppedFeatures.features).toContain('channel_management');
      expect(stoppedFeatures.features).not.toContain('channel_reload');
    } finally {
      await handle.close();
    }
  });

  it('single-flights concurrent first PUTs through one manager and worker', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-runtime-race-')),
    );
    fs.mkdirSync(path.join(tmpDir, '.qwen'));
    fs.writeFileSync(
      path.join(tmpDir, '.qwen', 'settings.json'),
      JSON.stringify({ channels: { telegram: { type: 'telegram' } } }),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    const workerFactory = makeReadyWorkerFactory(worker);
    const pidfile = makePidfileDeps();
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        token: 'secret',
        serveWebShell: false,
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: workerFactory,
        channelServicePidfile: pidfile,
      },
    );
    const requestOptions = {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        selection: { mode: 'names', names: ['telegram'] },
      }),
    };

    try {
      const responses = await Promise.all([
        fetch(`${handle.url}/workspace/channel`, requestOptions),
        fetch(`${handle.url}/workspace/channel`, requestOptions),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 201,
      ]);
      expect(workerFactory).toHaveBeenCalledTimes(1);
      expect(worker.start).toHaveBeenCalledTimes(1);
      expect(pidfile.reserveServeServiceInfo).toHaveBeenCalledTimes(1);
    } finally {
      await handle.close();
    }
  });

  it('orders DELETE behind a first PUT that is still creating the manager', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-runtime-fifo-')),
    );
    fs.mkdirSync(path.join(tmpDir, '.qwen'));
    fs.writeFileSync(
      path.join(tmpDir, '.qwen', 'settings.json'),
      JSON.stringify({ channels: { telegram: { type: 'telegram' } } }),
    );
    let capturedDeps:
      | Parameters<typeof serverModule.createServeApp>[2]
      | undefined;
    const originalCreateServeApp = serverModule.createServeApp;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      capturedDeps = args[2];
      return originalCreateServeApp(...args);
    });
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        token: 'secret',
        serveWebShell: false,
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: makeReadyWorkerFactory(worker),
        channelServicePidfile: makePidfileDeps(),
      },
    );

    try {
      const setting = capturedDeps!.setChannelWorkerSelection!({
        mode: 'names',
        names: ['telegram'],
      });
      const stopping = capturedDeps!.stopChannelWorker!();

      await expect(setting).resolves.toMatchObject({ changed: true });
      await expect(stopping).resolves.toMatchObject({
        changed: true,
        state: { enabled: false },
      });
      expect(worker.start).toHaveBeenCalledTimes(1);
      expect(worker.stop).toHaveBeenCalledTimes(1);
      expect(capturedDeps!.getChannelWorkerControl!()).toMatchObject({
        enabled: false,
        selection: null,
        workers: [],
      });
    } finally {
      await handle.close();
    }
  });

  it('rejects channel mutations once shutdown starts before manager creation', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-runtime-drain-')),
    );
    let capturedDeps:
      | Parameters<typeof serverModule.createServeApp>[2]
      | undefined;
    const originalCreateServeApp = serverModule.createServeApp;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      capturedDeps = args[2];
      return originalCreateServeApp(...args);
    });
    const workerFactory = vi.fn(() =>
      makeWorker({
        enabled: true,
        state: 'running',
        channels: ['telegram'],
      }),
    );
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        token: 'secret',
        serveWebShell: false,
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: workerFactory,
        channelServicePidfile: makePidfileDeps(),
      },
    );

    const closing = handle.close();
    await expect(
      capturedDeps!.setChannelWorkerSelection!({ mode: 'all' }),
    ).rejects.toMatchObject({ code: 'daemon_draining' });
    await expect(capturedDeps!.stopChannelWorker!()).rejects.toMatchObject({
      code: 'daemon_draining',
    });
    await expect(capturedDeps!.reloadChannelWorker!()).rejects.toMatchObject({
      code: 'daemon_draining',
    });
    await closing;
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it('rejects an unknown runtime selection before reserving or starting', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-runtime-unknown-')),
    );
    const workerFactory = vi.fn(() =>
      makeWorker({
        enabled: true,
        state: 'running',
        channels: ['missing'],
      }),
    );
    const pidfile = makePidfileDeps();
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        token: 'secret',
        serveWebShell: false,
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: workerFactory,
        channelServicePidfile: pidfile,
      },
    );

    try {
      const response = await fetch(`${handle.url}/workspace/channel`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          selection: { mode: 'names', names: ['missing'] },
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'channel_workspace_mismatch',
      });
      expect(pidfile.reserveServeServiceInfo).not.toHaveBeenCalled();
      expect(workerFactory).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('reports a standalone service conflict on the first runtime PUT', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-runtime-conflict-')),
    );
    fs.mkdirSync(path.join(tmpDir, '.qwen'));
    fs.writeFileSync(
      path.join(tmpDir, '.qwen', 'settings.json'),
      JSON.stringify({ channels: { telegram: { type: 'telegram' } } }),
    );
    const workerFactory = vi.fn(() =>
      makeWorker({
        enabled: true,
        state: 'running',
        channels: ['telegram'],
      }),
    );
    const pidfile = makePidfileDeps();
    pidfile.readServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 9988,
      startedAt: new Date().toISOString(),
      channels: ['telegram'],
    });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        token: 'secret',
        serveWebShell: false,
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: workerFactory,
        channelServicePidfile: pidfile,
      },
    );

    try {
      const response = await fetch(`${handle.url}/workspace/channel`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          selection: { mode: 'names', names: ['telegram'] },
        }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'channel_service_conflict',
        owner: 'channel',
        pid: 9988,
      });
      expect(workerFactory).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('reports a typed conflict when a concurrent runtime lease stays busy', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-runtime-race-')),
    );
    fs.mkdirSync(path.join(tmpDir, '.qwen'));
    fs.writeFileSync(
      path.join(tmpDir, '.qwen', 'settings.json'),
      JSON.stringify({ channels: { telegram: { type: 'telegram' } } }),
    );
    const workerFactory = vi.fn(() =>
      makeWorker({
        enabled: true,
        state: 'running',
        channels: ['telegram'],
      }),
    );
    const pidfile = makePidfileDeps();
    const eexist = new Error('EEXIST') as NodeJS.ErrnoException;
    eexist.code = 'EEXIST';
    pidfile.reserveServeServiceInfo.mockImplementation(() => {
      throw eexist;
    });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        token: 'secret',
        serveWebShell: false,
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: workerFactory,
        channelServicePidfile: pidfile,
      },
    );

    try {
      const response = await fetch(`${handle.url}/workspace/channel`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          selection: { mode: 'names', names: ['telegram'] },
        }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'channel_service_conflict',
      });
      expect(pidfile.reserveServeServiceInfo).toHaveBeenCalledTimes(2);
      expect(workerFactory).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('closes the listener when worker startup fails after resolveOnListen', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-fail-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'failed',
      channels: ['telegram'],
      error: 'worker boom',
    });
    const startupOrder: string[] = [];
    worker.start.mockImplementationOnce(async () => {
      startupOrder.push('worker');
      throw new Error('worker boom');
    });
    const attachServer = vi.fn(() => startupOrder.push('runtime'));
    const originalCreateServeApp = serverModule.createServeApp;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      const app = originalCreateServeApp(...args);
      const acpHandle = app.locals['acpHandle'] as
        | { attachServer?: (server: unknown) => void }
        | undefined;
      if (acpHandle) acpHandle.attachServer = attachServer;
      return app;
    });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: makePidfileDeps(),
        resolveOnListen: true,
      },
    );

    try {
      await expect(handle.runtimeReady).rejects.toThrow('worker boom');
      expect(handle.server.listening).toBe(false);
      expect(attachServer).toHaveBeenCalledTimes(1);
      expect(startupOrder).toEqual(['runtime', 'worker']);
    } finally {
      await handle.close();
    }
  });

  it('reloads through a forced settings reconcile', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-reload-')),
    );
    fs.mkdirSync(path.join(tmpDir, '.qwen'));
    fs.writeFileSync(
      path.join(tmpDir, '.qwen', 'settings.json'),
      JSON.stringify({ channels: { telegram: { type: 'telegram' } } }),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        token: 'secret',
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: makeReadyWorkerFactory(worker),
        channelServicePidfile: makePidfileDeps(),
      },
    );

    try {
      worker.start.mockClear();
      worker.stop.mockClear();
      const response = await fetch(`${handle.url}/workspace/channel/reload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
      });
      expect(response.status).toBe(200);
      expect(worker.restart).not.toHaveBeenCalled();
      expect(worker.start).toHaveBeenCalledTimes(1);
      expect(worker.stop).toHaveBeenCalledTimes(1);
    } finally {
      await handle.close();
    }
  });

  it('rejects ambiguous multi-workspace channel ownership before exposing a handle', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-plan-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: { channels: { telegram: { type: 'telegram' } } },
    } as unknown as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() =>
      makeFakeBridge(),
    );
    const supervisorFactory = vi.fn(() =>
      makeWorker({
        enabled: true,
        state: 'running',
        channels: ['telegram'],
      }),
    );

    const outcome = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, secondary],
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        resolveOnListen: true,
        bootSettings: {},
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        channelWorkerSupervisorFactory: supervisorFactory,
        channelServicePidfile: makePidfileDeps(),
      },
    ).then(
      (handle) => ({ handle }),
      (error: unknown) => ({ error }),
    );

    if ('handle' in outcome) {
      await outcome.handle.runtimeReady.catch(() => {});
      await outcome.handle.close();
    }
    expect(outcome).toMatchObject({
      error: {
        code: 'ambiguous_channel_workspace',
      },
    });
    expect(supervisorFactory).not.toHaveBeenCalled();
  });

  it('records a secondary-only worker added to a primary-only daemon', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-dynamic-worker-pidfile-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const primaryCwd = canonicalizeWorkspace(primary);
    const secondaryCwd = canonicalizeWorkspace(secondary);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockImplementation(
      (workspace) =>
        ({
          merged: {
            channels:
              canonicalizeWorkspace(String(workspace)) === secondaryCwd
                ? { feishu: { type: 'feishu' } }
                : { telegram: { type: 'telegram' } },
          },
        }) as unknown as ReturnType<typeof settingsRuntime.loadSettings>,
    );
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() =>
      makeFakeBridge(),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 5678,
      channels: ['feishu'],
    });
    const workerFactory = makeReadyWorkerFactory(worker);
    const pidfile = makePidfileDeps();
    const store = {
      read: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        primaryWorkspace: primaryCwd,
        workspaces: [],
      }),
      add: vi.fn().mockResolvedValue(true),
    } as unknown as WorkspaceRegistrationStore;
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: primary,
        token: 'dynamic-worker-token',
        serveWebShell: false,
      },
      {
        preheatBridge: false,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        channelWorkerSupervisorFactory: workerFactory,
        channelServicePidfile: pidfile,
        workspaceRegistrationStore: store,
      },
    );
    const headers = {
      Authorization: 'Bearer dynamic-worker-token',
      'Content-Type': 'application/json',
    };

    try {
      await handle.runtimeReady;
      const added = await fetch(`${handle.url}/workspaces`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ cwd: secondary }),
      });
      expect(added.status).toBe(201);

      const enabled = await fetch(`${handle.url}/workspace/channel`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          selection: { mode: 'names', names: ['feishu'] },
        }),
      });
      expect(enabled.status).toBe(201);
      expect(workerFactory).toHaveBeenCalledOnce();
      expect(workerFactory).toHaveBeenCalledWith(
        expect.objectContaining({ workspace: secondaryCwd }),
      );
      expect(pidfile.writeServeServiceInfo).toHaveBeenLastCalledWith({
        channels: ['feishu'],
        servePid: process.pid,
        workers: [
          expect.objectContaining({
            workspaceCwd: secondaryCwd,
            channels: ['feishu'],
            workerPid: 5678,
          }),
        ],
      });
    } finally {
      await handle.close();
    }
  });

  it('orchestrates, persists, and hot-removes distinct workspace workers', async () => {
    const previousSharedSecret = process.env['QWEN_SHARED_WEBHOOK_SECRET'];
    process.env['QWEN_SHARED_WEBHOOK_SECRET'] = 'primary-secret';
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-groups-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const primaryCwd = canonicalizeWorkspace(primary);
    const secondaryCwd = canonicalizeWorkspace(secondary);
    const secondaryChannelConfig = {
      type: 'feishu',
      webhooks: {
        sources: {
          'github-ci': {
            secretEnv: 'QWEN_SHARED_WEBHOOK_SECRET',
            targets: {
              default: {
                chatId: 'group-1',
                senderId: 'webhook:github-ci',
              },
            },
          },
        },
      },
    };
    fs.mkdirSync(path.join(secondary, '.qwen'));
    fs.writeFileSync(
      path.join(secondary, '.qwen', 'settings.json'),
      JSON.stringify({ channels: { feishu: secondaryChannelConfig } }),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockImplementation(
      (workspace) => {
        const workspaceCwd =
          typeof workspace === 'string' ? canonicalizeWorkspace(workspace) : '';
        return {
          merged: {
            channels:
              workspaceCwd === secondaryCwd
                ? { feishu: secondaryChannelConfig }
                : { telegram: { type: 'telegram' } },
          },
        } as unknown as ReturnType<typeof settingsRuntime.loadSettings>;
      },
    );
    vi.spyOn(environmentRuntime, 'buildRuntimeEnvironment').mockImplementation(
      (_settings, workspace, baseEnv) => ({
        effectiveEnv: Object.freeze({
          ...baseEnv,
          QWEN_SHARED_WEBHOOK_SECRET:
            canonicalizeWorkspace(workspace ?? process.cwd()) === secondaryCwd
              ? 'secondary-secret'
              : 'primary-secret',
        }),
        overlayKeys: Object.freeze(['QWEN_SHARED_WEBHOOK_SECRET']),
        envFilePaths: Object.freeze([]),
        envFileReadFailed: false,
        envFileReadFailures: Object.freeze([]),
      }),
    );
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => makeFakeBridge());

    const snapshots = new Map<string, ChannelWorkerSnapshot>();
    const workerOptions = new Map<
      string,
      CreateChannelWorkerSupervisorOptions
    >();
    const workerSupervisors = new Map<string, ReturnType<typeof makeWorker>>();
    const webhookEnqueues = new Map<string, ReturnType<typeof vi.fn>>();
    const supervisorFactory = vi.fn(
      (options: CreateChannelWorkerSupervisorOptions) => {
        const pid = options.workspace === primaryCwd ? 1234 : 5678;
        const channels =
          options.selection.mode === 'names' ? options.selection.names : [];
        snapshots.set(options.workspace, {
          enabled: true,
          state: 'running',
          pid,
          channels: [...channels],
        });
        workerOptions.set(options.workspace, options);
        const enqueueWebhookTask = vi.fn(async () => ({
          accepted: true as const,
        }));
        webhookEnqueues.set(options.workspace, enqueueWebhookTask);
        const supervisor = {
          start: vi.fn(async () => {
            const capabilitiesResponse = await fetch(
              `${options.daemonUrl}/capabilities`,
              {
                headers: { Authorization: 'Bearer worker-remove-token' },
              },
            );
            expect(capabilitiesResponse.status).toBe(200);
            expect(await capabilitiesResponse.json()).toMatchObject({
              workspaces: expect.arrayContaining([
                expect.objectContaining({
                  cwd: primaryCwd,
                  trusted: true,
                }),
                expect.objectContaining({
                  cwd: secondaryCwd,
                  trusted: true,
                }),
              ]),
            });
            options.onReady?.(snapshots.get(options.workspace)!);
          }),
          stop: vi.fn().mockResolvedValue(undefined),
          restart: vi.fn(async () => snapshots.get(options.workspace)!),
          killAllSync: vi.fn(),
          snapshot: vi.fn(() => snapshots.get(options.workspace)!),
          enqueueWebhookTask,
        };
        workerSupervisors.set(
          options.workspace,
          supervisor as ReturnType<typeof makeWorker>,
        );
        return supervisor;
      },
    );
    const pidfile = makePidfileDeps();
    const removeByIds = vi.fn().mockResolvedValue(1);
    const workspaceRegistrationStore = {
      read: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        primaryWorkspace: primaryCwd,
        workspaces: [secondaryCwd],
      }),
      removeByIds,
    } as unknown as WorkspaceRegistrationStore;

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: primary,
        token: 'worker-remove-token',
        serveWebShell: false,
        channelSelection: {
          mode: 'names',
          names: ['telegram', 'feishu'],
        },
      },
      {
        resolveOnListen: true,
        bootSettings: {},
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        channelWorkerSupervisorFactory: supervisorFactory,
        channelServicePidfile: pidfile,
        workspaceRegistrationStore,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      const crossWorkspaceSecretResponse = await fetch(
        `${handle.url}/channels/feishu/webhooks/github-ci`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-qwen-webhook-secret': 'primary-secret',
          },
          body: JSON.stringify({ eventType: 'check_failed' }),
        },
      );
      expect(crossWorkspaceSecretResponse.status).toBe(401);

      const webhookResponse = await fetch(
        `${handle.url}/channels/feishu/webhooks/github-ci`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer worker-remove-token',
            'content-type': 'application/json',
            'x-qwen-webhook-secret': 'secondary-secret',
          },
          body: JSON.stringify({
            eventType: 'check_failed',
            targetRef: 'default',
            title: 'CI failed',
          }),
        },
      );
      expect(webhookResponse.status).toBe(202);
      expect(await webhookResponse.json()).toEqual({ accepted: true });
      await handle.runtimeReady;
      expect(supervisorFactory).toHaveBeenCalledTimes(2);
      expect(workerOptions.get(primaryCwd)).toMatchObject({
        workspace: primaryCwd,
        selection: { mode: 'names', names: ['telegram'] },
      });
      expect(workerOptions.get(secondaryCwd)).toMatchObject({
        workspace: secondaryCwd,
        selection: { mode: 'names', names: ['feishu'] },
      });
      expect(webhookEnqueues.get(primaryCwd)).not.toHaveBeenCalled();
      expect(webhookEnqueues.get(secondaryCwd)).toHaveBeenCalledWith({
        channelName: 'feishu',
        source: 'github-ci',
        eventType: 'check_failed',
        targetRef: 'default',
        title: 'CI failed',
        payload: {},
      });
      expect(pidfile.writeServeServiceInfo).toHaveBeenLastCalledWith({
        channels: ['telegram', 'feishu'],
        servePid: process.pid,
        workerPid: 1234,
        workers: [
          expect.objectContaining({
            workspaceCwd: primaryCwd,
            channels: ['telegram'],
            workerPid: 1234,
          }),
          expect.objectContaining({
            workspaceCwd: secondaryCwd,
            channels: ['feishu'],
            workerPid: 5678,
          }),
        ],
      });

      const capabilities = (await (
        await fetch(`${handle.url}/capabilities`, {
          headers: { Authorization: 'Bearer worker-remove-token' },
        })
      ).json()) as {
        workspaces: Array<{ id: string; cwd: string; removable?: boolean }>;
      };
      const secondaryRuntime = capabilities.workspaces.find(
        (workspace) => workspace.cwd === secondaryCwd,
      );
      expect(secondaryRuntime).toMatchObject({ removable: true });
      const removalUrl = `${handle.url}/workspaces/${encodeURIComponent(
        secondaryRuntime!.id,
      )}`;
      const busyRemoval = await fetch(removalUrl, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer worker-remove-token' },
      });
      expect(busyRemoval.status).toBe(409);
      await expect(busyRemoval.json()).resolves.toMatchObject({
        code: 'workspace_busy',
        activity: { channelWorkers: 1 },
      });
      expect(workerSupervisors.get(secondaryCwd)!.stop).not.toHaveBeenCalled();

      const forcedRemoval = await fetch(removalUrl, {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer worker-remove-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ force: true }),
      });
      expect(forcedRemoval.status).toBe(200);
      await expect(forcedRemoval.json()).resolves.toMatchObject({
        removed: true,
        activity: { channelWorkers: 1 },
      });
      expect(removeByIds).toHaveBeenCalledWith([
        workspaceRegistrationId(secondaryCwd),
      ]);
      const removedSupervisor = workerSupervisors.get(secondaryCwd)!;
      const removedWorkerOptions = workerOptions.get(secondaryCwd)!;
      expect(removedSupervisor.stop).toHaveBeenCalledOnce();
      expect(workerSupervisors.get(primaryCwd)!.stop).not.toHaveBeenCalled();
      expect(pidfile.writeServeServiceInfo).toHaveBeenLastCalledWith({
        channels: ['telegram'],
        servePid: process.pid,
        workerPid: 1234,
        workers: [
          expect.objectContaining({
            workspaceCwd: primaryCwd,
            channels: ['telegram'],
            workerPid: 1234,
          }),
        ],
      });

      const removedWebhook = await fetch(
        `${handle.url}/channels/feishu/webhooks/github-ci`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer worker-remove-token',
            'content-type': 'application/json',
            'x-qwen-webhook-secret': 'secondary-secret',
          },
          body: JSON.stringify({ eventType: 'check_failed' }),
        },
      );
      expect(removedWebhook.status).not.toBe(202);

      const failedSecondary: ChannelWorkerSnapshot = {
        enabled: true,
        state: 'failed',
        channels: ['feishu'],
        error: 'worker stopped',
      };
      snapshots.set(secondaryCwd, failedSecondary);
      removedWorkerOptions.onExit?.(failedSecondary);
      expect(pidfile.writeServeServiceInfo).toHaveBeenLastCalledWith(
        expect.objectContaining({
          workerPid: 1234,
          workers: [
            expect.objectContaining({
              workspaceCwd: primaryCwd,
              channels: ['telegram'],
            }),
          ],
        }),
      );
      expect(
        pidfile.writeServeServiceInfo.mock.calls
          .at(-1)?.[0]
          .workers?.find(
            (worker: ServiceInfoWorker) => worker.workspaceCwd === secondaryCwd,
          ),
      ).toBeUndefined();

      snapshots.set(secondaryCwd, {
        enabled: true,
        state: 'running',
        pid: 6789,
        channels: ['feishu'],
      });
      const readded = await fetch(`${handle.url}/workspaces`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer worker-remove-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ cwd: secondaryCwd }),
      });
      expect(readded.status).toBe(201);
      expect(supervisorFactory).toHaveBeenCalledTimes(3);
      expect(createBridge).toHaveBeenCalledTimes(3);
      const replacementSupervisor = workerSupervisors.get(secondaryCwd)!;
      expect(replacementSupervisor).not.toBe(removedSupervisor);
      expect(replacementSupervisor.start).toHaveBeenCalledOnce();

      const readdedWebhook = await fetch(
        `${handle.url}/channels/feishu/webhooks/github-ci`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer worker-remove-token',
            'content-type': 'application/json',
            'x-qwen-webhook-secret': 'secondary-secret',
          },
          body: JSON.stringify({
            eventType: 'check_failed',
            targetRef: 'default',
            title: 'CI failed again',
          }),
        },
      );
      expect(readdedWebhook.status).toBe(202);
      expect(webhookEnqueues.get(secondaryCwd)).toHaveBeenCalledWith(
        expect.objectContaining({
          channelName: 'feishu',
          title: 'CI failed again',
        }),
      );

      snapshots.set(secondaryCwd, failedSecondary);
      workerOptions.get(secondaryCwd)!.onExit?.(failedSecondary);
      const failedWorkerPidfile =
        pidfile.writeServeServiceInfo.mock.calls.at(-1)?.[0];
      expect(
        failedWorkerPidfile?.workers?.find(
          (worker: ServiceInfoWorker) => worker.workspaceCwd === secondaryCwd,
        ),
      ).toMatchObject({
        workspaceCwd: secondaryCwd,
        channels: ['feishu'],
      });
      expect(
        failedWorkerPidfile?.workers?.find(
          (worker: ServiceInfoWorker) => worker.workspaceCwd === secondaryCwd,
        )?.workerPid,
      ).toBeUndefined();

      const removeReplacement = await fetch(removalUrl, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer worker-remove-token' },
      });
      expect(removeReplacement.status).toBe(200);
      expect(replacementSupervisor.stop).toHaveBeenCalledOnce();
    } finally {
      await handle.close();
      if (previousSharedSecret === undefined) {
        delete process.env['QWEN_SHARED_WEBHOOK_SECRET'];
      } else {
        process.env['QWEN_SHARED_WEBHOOK_SECRET'] = previousSharedSecret;
      }
    }
  });

  it('starts the channel worker after runtime mount and stops it before bridge shutdown', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-')),
    );
    const order: string[] = [];
    const bridge = makeFakeBridge(() => order.push('bridge'));
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const startupOrder: string[] = [];
    const originalCreateServeApp = serverModule.createServeApp;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      const app = originalCreateServeApp(...args);
      const acpHandle = app.locals['acpHandle'] as
        | { attachServer?: (server: unknown) => void }
        | undefined;
      if (acpHandle) {
        acpHandle.attachServer = vi.fn(() => startupOrder.push('runtime'));
      }
      return app;
    });
    worker.stop.mockImplementation(async () => {
      order.push('worker');
    });
    const pidfile = makePidfileDeps();

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge,
        channelWorkerSupervisorFactory: vi.fn((opts) => {
          worker.start.mockImplementation(async () => {
            startupOrder.push('worker');
            opts.onReady?.(worker.snapshot());
          });
          return worker;
        }),
        channelServicePidfile: pidfile,
      },
    );
    startupOrder.push('runtime-ready');

    expect(worker.start).toHaveBeenCalledTimes(1);
    expect(startupOrder).toEqual(['runtime', 'worker', 'runtime-ready']);
    expect(pidfile.reserveServeServiceInfo).toHaveBeenCalledWith({
      channels: ['telegram'],
      servePid: process.pid,
    });
    expect(pidfile.writeServeServiceInfo).toHaveBeenCalledWith({
      channels: ['telegram'],
      servePid: process.pid,
      workerPid: 1234,
    });
    const processRegistry = mockCreateSpawnChannelFactoryOptions.at(-1)?.[
      'processRegistry'
    ] as { shutdown: () => Promise<void> };
    const shutdownProcessRegistry =
      processRegistry.shutdown.bind(processRegistry);
    vi.spyOn(processRegistry, 'shutdown').mockImplementation(() => {
      order.push('registry');
      return shutdownProcessRegistry();
    });

    await handle.close();

    expect(order).toEqual(['registry', 'worker', 'bridge']);
    expect(pidfile.removeServeServiceInfo).toHaveBeenCalledWith(process.pid);
  });

  it('force-kills channel worker, bridge, and pidfile on a second shutdown signal', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-force-')),
    );
    let finishBridgeShutdown!: () => void;
    const bridge = makeFakeBridge();
    vi.mocked(bridge.shutdown).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishBridgeShutdown = resolve;
        }),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const pidfile = makePidfileDeps();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const existingSigtermListeners = new Set(process.rawListeners('SIGTERM'));
    const existingSighupListeners = new Set(process.rawListeners('SIGHUP'));

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge,
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: pidfile,
      },
    );

    try {
      const signalListener = process
        .rawListeners('SIGTERM')
        .find(
          (listener) =>
            !existingSigtermListeners.has(listener) &&
            listener.name === 'onSignal',
        ) as ((signal: NodeJS.Signals) => Promise<void>) | undefined;
      const sighupListener = process
        .rawListeners('SIGHUP')
        .find(
          (listener) =>
            !existingSighupListeners.has(listener) &&
            listener.name === 'onSignal',
        ) as ((signal: NodeJS.Signals) => Promise<void>) | undefined;
      expect(signalListener).toBeDefined();
      expect(sighupListener).toBe(signalListener);

      const firstSignal = signalListener!('SIGTERM');
      await Promise.resolve();
      const secondSignal = sighupListener!('SIGHUP');
      await secondSignal;

      expect(worker.killAllSync).toHaveBeenCalled();
      expect(bridge.killAllSync).toHaveBeenCalled();
      expect(pidfile.removeServeServiceInfo).toHaveBeenCalledWith(process.pid);
      expect(exitSpy).toHaveBeenCalledWith(1);

      finishBridgeShutdown();
      await firstSignal;
    } finally {
      finishBridgeShutdown?.();
      await handle.close();
      exitSpy.mockRestore();
    }
  });

  it('routes SIGHUP through graceful shutdown and removes its listener', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-sighup-shutdown-')),
    );
    const bridge = makeFakeBridge();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const existingSighupListeners = new Set(process.rawListeners('SIGHUP'));
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
      },
      { bridge },
    );
    const processRegistry = mockCreateSpawnChannelFactoryOptions.at(-1)?.[
      'processRegistry'
    ] as { shutdown: () => Promise<void> };
    const shutdownSpy = vi.spyOn(processRegistry, 'shutdown');

    try {
      const signalListener = process
        .rawListeners('SIGHUP')
        .find(
          (listener) =>
            !existingSighupListeners.has(listener) &&
            listener.name === 'onSignal',
        ) as ((signal: NodeJS.Signals) => Promise<void>) | undefined;
      expect(signalListener).toBeDefined();

      await signalListener!('SIGHUP');

      expect(shutdownSpy).toHaveBeenCalledOnce();
      expect(bridge.shutdown).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(
        process
          .rawListeners('SIGHUP')
          .some((listener) => !existingSighupListeners.has(listener)),
      ).toBe(false);
    } finally {
      await handle.close();
      exitSpy.mockRestore();
    }
  });

  it('retries graceful shutdown after an unconfirmed channel worker exit', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-stuck-')),
    );
    const bridge = makeFakeBridge();
    const worker = makeWorker({
      enabled: true,
      state: 'failed',
      pid: 1234,
      channels: ['telegram'],
      error: 'Channel worker did not exit after SIGKILL.',
    });
    worker.stop
      .mockRejectedValueOnce(
        new Error('Channel worker did not exit after SIGKILL.'),
      )
      .mockResolvedValueOnce(undefined);
    const pidfile = makePidfileDeps();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const existingSigintListeners = new Set(process.rawListeners('SIGINT'));
    const existingSigtermListeners = new Set(process.rawListeners('SIGTERM'));
    const existingSighupListeners = new Set(process.rawListeners('SIGHUP'));

    await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge,
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: pidfile,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );

    const signalListener = process
      .rawListeners('SIGTERM')
      .find(
        (listener) =>
          !existingSigtermListeners.has(listener) &&
          listener.name === 'onSignal',
      ) as ((signal: NodeJS.Signals) => Promise<void>) | undefined;
    try {
      expect(signalListener).toBeDefined();
      await signalListener!('SIGTERM');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(worker.killAllSync).not.toHaveBeenCalled();
      expect(pidfile.removeServeServiceInfo).not.toHaveBeenCalled();
      const logPath = path.join(tmpDir, 'debug', 'daemon', 'daemon.log');
      expect(fs.readFileSync(logPath, 'utf8')).not.toContain('daemon stopped');

      await signalListener!('SIGTERM');
      expect(worker.stop).toHaveBeenCalledTimes(2);
      expect(worker.killAllSync).not.toHaveBeenCalled();
      expect(bridge.killAllSync).not.toHaveBeenCalled();
      expect(pidfile.removeServeServiceInfo).toHaveBeenCalledWith(process.pid);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(fs.readFileSync(logPath, 'utf8')).toContain('daemon stopped');
    } finally {
      for (const listener of process.rawListeners('SIGINT')) {
        if (!existingSigintListeners.has(listener)) {
          process.removeListener('SIGINT', listener as never);
        }
      }
      for (const listener of process.rawListeners('SIGTERM')) {
        if (!existingSigtermListeners.has(listener)) {
          process.removeListener('SIGTERM', listener as never);
        }
      }
      for (const listener of process.rawListeners('SIGHUP')) {
        if (!existingSighupListeners.has(listener)) {
          process.removeListener('SIGHUP', listener as never);
        }
      }
      exitSpy.mockRestore();
    }
  });

  it('exits on the first signal when only ACP process shutdown fails', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-acp-error-')),
    );
    const bridge = makeFakeBridge();
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const existingSigintListeners = new Set(process.rawListeners('SIGINT'));
    const existingSigtermListeners = new Set(process.rawListeners('SIGTERM'));
    const existingSighupListeners = new Set(process.rawListeners('SIGHUP'));

    await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge,
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: makePidfileDeps(),
      },
    );

    const processRegistry = mockCreateSpawnChannelFactoryOptions.at(-1)?.[
      'processRegistry'
    ] as { shutdown: () => Promise<void> };
    vi.spyOn(processRegistry, 'shutdown').mockRejectedValue(
      new Error('ACP process shutdown failed'),
    );
    mockChannelWorkerEnabledState.value = true;
    const signalListener = process
      .rawListeners('SIGTERM')
      .find(
        (listener) =>
          !existingSigtermListeners.has(listener) &&
          listener.name === 'onSignal',
      ) as ((signal: NodeJS.Signals) => Promise<void>) | undefined;
    try {
      expect(signalListener).toBeDefined();
      await signalListener!('SIGTERM');

      expect(worker.stop).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      for (const listener of process.rawListeners('SIGINT')) {
        if (!existingSigintListeners.has(listener)) {
          process.removeListener('SIGINT', listener as never);
        }
      }
      for (const listener of process.rawListeners('SIGTERM')) {
        if (!existingSigtermListeners.has(listener)) {
          process.removeListener('SIGTERM', listener as never);
        }
      }
      for (const listener of process.rawListeners('SIGHUP')) {
        if (!existingSighupListeners.has(listener)) {
          process.removeListener('SIGHUP', listener as never);
        }
      }
      exitSpy.mockRestore();
    }
  });

  it('retries only the channel worker error when ACP process shutdown also fails', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-combined-error-')),
    );
    const bridge = makeFakeBridge();
    const worker = makeWorker({
      enabled: true,
      state: 'failed',
      pid: 1234,
      channels: ['telegram'],
      error: 'Channel worker did not exit after SIGKILL.',
    });
    worker.stop
      .mockRejectedValueOnce(
        new Error('Channel worker did not exit after SIGKILL.'),
      )
      .mockResolvedValueOnce(undefined);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const existingSigintListeners = new Set(process.rawListeners('SIGINT'));
    const existingSigtermListeners = new Set(process.rawListeners('SIGTERM'));
    const existingSighupListeners = new Set(process.rawListeners('SIGHUP'));

    await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge,
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: makePidfileDeps(),
      },
    );

    const processRegistry = mockCreateSpawnChannelFactoryOptions.at(-1)?.[
      'processRegistry'
    ] as { shutdown: () => Promise<void> };
    vi.spyOn(processRegistry, 'shutdown').mockRejectedValue(
      new Error('ACP process shutdown failed'),
    );
    mockChannelWorkerEnabledState.value = true;
    const signalListener = process
      .rawListeners('SIGTERM')
      .find(
        (listener) =>
          !existingSigtermListeners.has(listener) &&
          listener.name === 'onSignal',
      ) as ((signal: NodeJS.Signals) => Promise<void>) | undefined;
    try {
      expect(signalListener).toBeDefined();
      await signalListener!('SIGTERM');
      expect(exitSpy).not.toHaveBeenCalled();

      await signalListener!('SIGTERM');
      expect(worker.stop).toHaveBeenCalledTimes(2);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      for (const listener of process.rawListeners('SIGINT')) {
        if (!existingSigintListeners.has(listener)) {
          process.removeListener('SIGINT', listener as never);
        }
      }
      for (const listener of process.rawListeners('SIGTERM')) {
        if (!existingSigtermListeners.has(listener)) {
          process.removeListener('SIGTERM', listener as never);
        }
      }
      for (const listener of process.rawListeners('SIGHUP')) {
        if (!existingSighupListeners.has(listener)) {
          process.removeListener('SIGHUP', listener as never);
        }
      }
      exitSpy.mockRestore();
    }
  });

  it('keeps the channel lease when lifecycle aggregation wraps the retryable worker error', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-aggregate-error-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'failed',
      pid: 1234,
      channels: ['telegram'],
      error: 'Channel worker did not exit after SIGKILL.',
    });
    worker.stop
      .mockRejectedValueOnce(
        new Error('Channel worker did not exit after SIGKILL.'),
      )
      .mockResolvedValueOnce(undefined);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const existingSigintListeners = new Set(process.rawListeners('SIGINT'));
    const existingSigtermListeners = new Set(process.rawListeners('SIGTERM'));
    const existingSighupListeners = new Set(process.rawListeners('SIGHUP'));

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: makePidfileDeps(),
      },
    );

    mockChannelWorkerEnabledState.value = true;
    const signalListener = process
      .rawListeners('SIGTERM')
      .find(
        (listener) =>
          !existingSigtermListeners.has(listener) &&
          listener.name === 'onSignal',
      ) as ((signal: NodeJS.Signals) => Promise<void>) | undefined;
    const originalServerClose = handle.server.close;
    handle.server.close = vi.fn((callback) => {
      setImmediate(() => callback?.(new Error('listener close failed')));
      return handle.server;
    }) as typeof handle.server.close;
    try {
      expect(signalListener).toBeDefined();
      await signalListener!('SIGTERM');

      expect(worker.stop).toHaveBeenCalledOnce();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      handle.server.close = originalServerClose;
      await handle.close().catch(() => undefined);
      for (const listener of process.rawListeners('SIGINT')) {
        if (!existingSigintListeners.has(listener)) {
          process.removeListener('SIGINT', listener as never);
        }
      }
      for (const listener of process.rawListeners('SIGTERM')) {
        if (!existingSigtermListeners.has(listener)) {
          process.removeListener('SIGTERM', listener as never);
        }
      }
      for (const listener of process.rawListeners('SIGHUP')) {
        if (!existingSighupListeners.has(listener)) {
          process.removeListener('SIGHUP', listener as never);
        }
      }
      exitSpy.mockRestore();
    }
  });

  it('bounds the logger flush before allowing a retryable close to reject', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-log-stuck-')),
    );
    const bridge = makeFakeBridge();
    const worker = makeWorker({
      enabled: true,
      state: 'failed',
      pid: 1234,
      channels: ['telegram'],
      error: 'Channel worker did not exit after SIGKILL.',
    });
    worker.stop
      .mockRejectedValueOnce(
        new Error('Channel worker did not exit after SIGKILL.'),
      )
      .mockResolvedValueOnce(undefined);
    const pidfile = makePidfileDeps();
    const logPath = path.join(tmpDir, 'debug', 'daemon', 'daemon.log');
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge,
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: pidfile,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );

    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const originalAppendFile = fs.promises.appendFile.bind(fs.promises);
    const appendSpy = vi
      .spyOn(fs.promises, 'appendFile')
      .mockImplementation(async (...args) => {
        if (String(args[0]) === logPath) await appendGate;
        return originalAppendFile(...args);
      });
    let closeOutcome:
      | Promise<{ kind: 'resolved' } | { kind: 'rejected'; error: unknown }>
      | undefined;

    try {
      const response = await fetch(`${handle.url}/blocked-access-log`);
      await response.text();
      closeOutcome = handle.close().then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );
      let timeout: NodeJS.Timeout | undefined;
      const firstOutcome = await Promise.race([
        closeOutcome,
        new Promise<{ kind: 'timeout' }>((resolve) => {
          timeout = setTimeout(() => resolve({ kind: 'timeout' }), 1_500);
        }),
      ]);
      if (timeout) clearTimeout(timeout);

      expect(firstOutcome.kind).toBe('rejected');
      if (firstOutcome.kind === 'rejected') {
        expect(firstOutcome.error).toEqual(
          expect.objectContaining({
            message: 'Channel worker did not exit after SIGKILL.',
          }),
        );
      }
    } finally {
      releaseAppend();
      appendSpy.mockRestore();
      await closeOutcome;
      await handle.close();
    }

    expect(worker.stop).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('daemon stopped');
  });

  it('force-stops the bridge while retrying a failed channel teardown', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-bridge-stuck-')),
    );
    const bridge = makeFakeBridge();
    vi.mocked(bridge.shutdown)
      .mockRejectedValueOnce(new Error('bridge still draining'))
      .mockResolvedValueOnce(undefined);
    const worker = makeWorker({
      enabled: true,
      state: 'failed',
      pid: 1234,
      channels: ['telegram'],
      error: 'Channel worker did not exit after SIGKILL.',
    });
    worker.stop
      .mockRejectedValueOnce(
        new Error('Channel worker did not exit after SIGKILL.'),
      )
      .mockResolvedValueOnce(undefined);
    const pidfile = makePidfileDeps();

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge,
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: pidfile,
      },
    );

    await expect(handle.close()).rejects.toThrow(
      'Channel worker did not exit after SIGKILL.',
    );
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(bridge.shutdown).toHaveBeenCalledTimes(1);
    expect(bridge.killAllSync).toHaveBeenCalledTimes(1);
    expect(pidfile.removeServeServiceInfo).not.toHaveBeenCalled();

    await expect(handle.close()).resolves.toBeUndefined();
    expect(worker.stop).toHaveBeenCalledTimes(2);
    expect(bridge.shutdown).toHaveBeenCalledTimes(1);
    expect(bridge.killAllSync).toHaveBeenCalledTimes(1);
    expect(pidfile.removeServeServiceInfo).toHaveBeenCalledWith(process.pid);
  });

  it('removes serve-owned pidfile through the legacy fallback cleanup path', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-fallback-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const pidfile = makePidfileDeps();
    delete (pidfile as Partial<typeof pidfile>).removeServeServiceInfo;
    pidfile.readServiceInfo.mockReturnValueOnce(null).mockReturnValue({
      owner: 'serve',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      channels: ['telegram'],
      servePid: process.pid,
    });
    pidfile.removeServiceInfo.mockImplementation(() => {
      pidfile.readServiceInfo.mockReturnValue(null);
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: makeReadyWorkerFactory(worker),
        channelServicePidfile: pidfile,
      },
    );

    await handle.close();

    expect(pidfile.removeServiceInfo).toHaveBeenCalledTimes(1);
  });

  it('keeps non-serve-owned pidfiles in the legacy fallback cleanup path', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-fallback-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const pidfile = makePidfileDeps();
    delete (pidfile as Partial<typeof pidfile>).removeServeServiceInfo;
    pidfile.readServiceInfo.mockReturnValueOnce(null).mockReturnValue({
      owner: 'channel',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      channels: ['telegram'],
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: makeReadyWorkerFactory(worker),
        channelServicePidfile: pidfile,
      },
    );

    await handle.close();

    expect(pidfile.removeServiceInfo).not.toHaveBeenCalled();
  });

  it('keeps serve running when worker pidfile metadata cannot be written', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-pidfile-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const pidfile = makePidfileDeps();
    pidfile.writeServeServiceInfo.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: makeReadyWorkerFactory(worker),
        channelServicePidfile: pidfile,
      },
    );

    try {
      await handle.runtimeReady;
      expect(worker.start).toHaveBeenCalled();
      expect(pidfile.writeServeServiceInfo).toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('updates the serve-owned pidfile when a restarted worker becomes ready', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-ready-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 5678,
      channels: ['telegram'],
    });
    let onReady: CreateChannelWorkerSupervisorOptions['onReady'];
    const pidfile = makePidfileDeps();
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: vi.fn((opts) => {
          onReady = opts.onReady;
          return worker;
        }),
        channelServicePidfile: pidfile,
      },
    );

    try {
      pidfile.writeServeServiceInfo.mockClear();
      onReady?.({
        enabled: true,
        state: 'running',
        pid: 5678,
        channels: ['telegram'],
        requestedChannels: ['telegram'],
        restartCount: 1,
      });

      expect(pidfile.writeServeServiceInfo).toHaveBeenCalledWith({
        channels: ['telegram'],
        servePid: process.pid,
        workerPid: 5678,
      });
    } finally {
      await handle.close();
    }
  });

  it('forwards channel worker log and exit details into the daemon log', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-log-')),
    );
    const originalRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    let onLog: CreateChannelWorkerSupervisorOptions['onLog'];
    let onExit: CreateChannelWorkerSupervisorOptions['onExit'];

    try {
      const handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          serveWebShell: false,
          channelSelection: { mode: 'names', names: ['telegram'] },
        },
        {
          bridge: makeFakeBridge(),
          channelWorkerSupervisorFactory: vi.fn((opts) => {
            onLog = opts.onLog;
            onExit = opts.onExit;
            return worker;
          }),
          channelServicePidfile: makePidfileDeps(),
        },
      );

      try {
        onLog?.({ stream: 'stderr', line: 'adapter failed with <redacted>' });
        onExit?.({
          enabled: true,
          state: 'exited',
          pid: 1234,
          channels: ['telegram'],
          exitCode: 1,
          signal: null,
          error: 'ipc failed',
          restartCount: 2,
          nextRestartAt: '2026-07-01T01:00:05.000Z',
          staleHeartbeatAt: '2026-07-01T01:00:00.000Z',
        });
      } finally {
        await handle.close();
      }

      const daemonDir = path.join(tmpDir, 'debug', 'daemon');
      const logContent = fs
        .readdirSync(daemonDir)
        .filter((file) => file.endsWith('.log'))
        .map((file) => fs.readFileSync(path.join(daemonDir, file), 'utf8'))
        .join('\n');

      expect(logContent).toContain(
        'channel worker stderr: adapter failed with <redacted>',
      );
      expect(logContent).toContain(
        'channel worker exited (state=exited, pid=1234, code=1, signal=null, error=ipc failed, restartCount=2, nextRestartAt=2026-07-01T01:00:05.000Z, staleHeartbeatAt=2026-07-01T01:00:00.000Z)',
      );
      expect(logContent).not.toContain('secret-token');
    } finally {
      if (originalRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = originalRuntimeDir;
      }
    }
  });

  it('passes a loopback daemon URL to workers when serve binds a wildcard host', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-loopback-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    let workerOptions: CreateChannelWorkerSupervisorOptions | undefined;
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '0.0.0.0',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        token: 'test-token',
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: vi.fn((opts) => {
          workerOptions = opts;
          return worker;
        }),
        channelServicePidfile: makePidfileDeps(),
      },
    );

    try {
      const port = new URL(handle.url).port;
      expect(workerOptions?.daemonUrl).toBe(`http://127.0.0.1:${port}`);
    } finally {
      await handle.close();
    }
  });

  it('does not write a worker pidfile after runtime startup already timed out', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-timeout-')),
    );
    let releaseStart!: () => void;
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const pidfile = makePidfileDeps();
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: vi.fn((opts) => {
          worker.start.mockImplementation(
            () =>
              new Promise<void>((resolve) => {
                releaseStart = () => {
                  opts.onReady?.(worker.snapshot());
                  resolve();
                };
              }),
          );
          return worker;
        }),
        channelServicePidfile: pidfile,
        resolveOnListen: true,
        runtimeStartupTimeoutMs: 1,
      },
    );

    try {
      await expect(
        Promise.race([
          handle.runtimeReady,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('runtimeReady did not settle')),
              1000,
            ),
          ),
        ]),
      ).rejects.toThrow('Daemon runtime startup timed out after 1ms.');
      await vi.waitFor(() => {
        expect(handle.server.listening).toBe(false);
      });
      releaseStart();
      await new Promise((resolve) => setImmediate(resolve));
      expect(pidfile.writeServeServiceInfo).not.toHaveBeenCalled();
    } finally {
      releaseStart?.();
      await handle.close();
    }
  });

  it('reports a warning when the ready channel worker exits', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-status-')),
    );
    const snapshot: ChannelWorkerSnapshot = {
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    };
    const worker = makeWorker(snapshot);
    let onExit: CreateChannelWorkerSupervisorOptions['onExit'];
    const channelWorkerSupervisorFactory = vi.fn(
      (opts: CreateChannelWorkerSupervisorOptions) => {
        onExit = opts.onExit;
        return worker;
      },
    );
    const pidfile = makePidfileDeps();
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory,
        channelServicePidfile: pidfile,
      },
    );

    try {
      Object.assign(snapshot, {
        state: 'exited',
        exitCode: 1,
        signal: null,
        error: 'ipc failed',
      });
      onExit?.(snapshot);
      const res = await fetch(`${handle.url}/daemon/status`);
      const body = await res.json();

      expect(pidfile.removeServeServiceInfo).not.toHaveBeenCalledWith(
        process.pid,
      );
      const lastPidfileWrite =
        pidfile.writeServeServiceInfo.mock.calls.at(-1)?.[0];
      expect(lastPidfileWrite).toMatchObject({
        channels: ['telegram'],
        servePid: process.pid,
      });
      expect(lastPidfileWrite?.workerPid).toBeUndefined();
      expect(body).toMatchObject({
        status: 'warning',
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'channel_worker_exited',
            severity: 'warning',
            message: 'Channel worker is exited (pid=1234, code=1): ipc failed.',
          }),
        ]),
        runtime: {
          channelWorker: {
            enabled: true,
            state: 'exited',
            pid: 1234,
            channels: ['telegram'],
            exitCode: 1,
            error: 'ipc failed',
          },
        },
      });
    } finally {
      await handle.close();
    }
  });

  it('fails serve startup when the worker exits before ready', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-fail-')),
    );
    const bridge = makeFakeBridge();
    const worker = makeWorker({
      enabled: true,
      state: 'failed',
      channels: ['telegram'],
      exitCode: 1,
    });
    worker.start.mockRejectedValueOnce(new Error('worker failed before ready'));

    const pidfile = makePidfileDeps();
    await expect(
      runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          serveWebShell: false,
          channelSelection: { mode: 'names', names: ['telegram'] },
        },
        {
          bridge,
          channelWorkerSupervisorFactory: vi.fn(() => worker),
          channelServicePidfile: pidfile,
        },
      ),
    ).rejects.toThrow('worker failed before ready');

    expect(worker.stop).toHaveBeenCalled();
    expect(bridge.shutdown).toHaveBeenCalled();
    expect(pidfile.removeServeServiceInfo).toHaveBeenCalledWith(process.pid);
  });

  it('drains the runtime when channel grouping rejects startup after listen', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-untrusted-')),
    );
    const bridge = makeFakeBridge();
    const pidfile = makePidfileDeps();

    await expect(
      runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          serveWebShell: false,
          channelSelection: { mode: 'names', names: ['telegram'] },
        },
        {
          bridge,
          trustedWorkspace: false,
          channelServicePidfile: pidfile,
        },
      ),
    ).rejects.toThrow('not trusted; cannot host channels');

    expect(bridge.shutdown).toHaveBeenCalledTimes(1);
    expect(pidfile.removeServeServiceInfo).toHaveBeenCalledWith(process.pid);
  });

  it('preserves the startup reason when channel cleanup also fails', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-startup-cleanup-')),
    );
    const cleanupError = new Error('session maintenance drain failed');
    const bridge = makeFakeBridge();
    const originalCreateServeApp = serverModule.createServeApp;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      const app = originalCreateServeApp(...args);
      app.locals['sessionArchiveCoordinator'] = {
        sealMaintenanceAndWait: vi.fn().mockRejectedValue(cleanupError),
      };
      return app;
    });

    try {
      await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          serveWebShell: false,
          channelSelection: { mode: 'names', names: ['telegram'] },
        },
        {
          bridge,
          trustedWorkspace: false,
          channelServicePidfile: makePidfileDeps(),
        },
      );
      expect.fail('Expected serve startup to reject.');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).message).toContain(
        'is not trusted; cannot host channels',
      );
      expect((error as AggregateError).errors).toContain(cleanupError);
    }
  });

  it('keeps the serve owner alive when failed startup cannot confirm worker exit', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-retained-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'failed',
      pid: 1234,
      channels: ['telegram'],
    });
    worker.start.mockRejectedValue(new Error('worker failed before ready'));
    worker.stop.mockRejectedValue(
      new Error('Channel worker did not exit after SIGKILL.'),
    );
    const pidfile = makePidfileDeps();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const existingSigintListeners = new Set(process.rawListeners('SIGINT'));
    const existingSigtermListeners = new Set(process.rawListeners('SIGTERM'));
    const existingSighupListeners = new Set(process.rawListeners('SIGHUP'));
    let settled = false;

    const running = runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: pidfile,
      },
    );
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    try {
      await vi.waitFor(() => expect(worker.stop).toHaveBeenCalledTimes(4), {
        timeout: 5_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(settled).toBe(false);
      expect(pidfile.removeServeServiceInfo).not.toHaveBeenCalled();

      const signalListener = process
        .rawListeners('SIGTERM')
        .find(
          (listener) =>
            !existingSigtermListeners.has(listener) &&
            listener.name === 'onSignal',
        ) as ((signal: NodeJS.Signals) => Promise<void>) | undefined;
      expect(signalListener).toBeDefined();
      worker.stop.mockResolvedValue(undefined);
      await signalListener!('SIGTERM');

      expect(worker.stop).toHaveBeenCalledTimes(5);
      expect(worker.killAllSync).not.toHaveBeenCalled();
      expect(pidfile.removeServeServiceInfo).toHaveBeenCalledWith(process.pid);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      for (const listener of process.rawListeners('SIGINT')) {
        if (!existingSigintListeners.has(listener)) {
          process.removeListener('SIGINT', listener as never);
        }
      }
      for (const listener of process.rawListeners('SIGTERM')) {
        if (!existingSigtermListeners.has(listener)) {
          process.removeListener('SIGTERM', listener as never);
        }
      }
      for (const listener of process.rawListeners('SIGHUP')) {
        if (!existingSighupListeners.has(listener)) {
          process.removeListener('SIGHUP', listener as never);
        }
      }
      exitSpy.mockRestore();
    }
  });

  it('refuses to start when another channel service is already running', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-busy-')),
    );
    const workerFactory = vi.fn(() =>
      makeWorker({
        enabled: true,
        state: 'running',
        pid: 1234,
        channels: ['telegram'],
      }),
    );
    const pidfile = makePidfileDeps();
    pidfile.readServiceInfo.mockReturnValueOnce({
      owner: 'serve',
      pid: 9999,
      startedAt: new Date().toISOString(),
      channels: ['telegram'],
      servePid: 9999,
    });

    await expect(
      runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          serveWebShell: false,
          channelSelection: { mode: 'names', names: ['telegram'] },
        },
        {
          bridge: makeFakeBridge(),
          channelWorkerSupervisorFactory: workerFactory,
          channelServicePidfile: pidfile,
        },
      ),
    ).rejects.toThrow('Channel service is already running under qwen serve');

    expect(workerFactory).not.toHaveBeenCalled();
    expect(pidfile.reserveServeServiceInfo).not.toHaveBeenCalled();
  });

  it('retries channel pidfile reservation after an EEXIST stale file cleanup', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-stale-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const pidfile = makePidfileDeps();
    const eexist = new Error('EEXIST') as NodeJS.ErrnoException;
    eexist.code = 'EEXIST';
    pidfile.reserveServeServiceInfo
      .mockImplementationOnce(() => {
        throw eexist;
      })
      .mockImplementationOnce(() => undefined);
    pidfile.readServiceInfo.mockReturnValueOnce(null).mockReturnValueOnce(null);

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: makeReadyWorkerFactory(worker),
        channelServicePidfile: pidfile,
      },
    );

    await handle.close();

    expect(pidfile.reserveServeServiceInfo).toHaveBeenCalledTimes(2);
    expect(pidfile.writeServeServiceInfo).toHaveBeenCalledWith({
      channels: ['telegram'],
      servePid: process.pid,
      workerPid: 1234,
    });
  });

  it('removes the channel pidfile reservation when listener startup fails', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-listen-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const pidfile = makePidfileDeps();

    await expect(
      runQwenServe(
        {
          port: -1,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          serveWebShell: false,
          channelSelection: { mode: 'names', names: ['telegram'] },
        },
        {
          bridge: makeFakeBridge(),
          channelWorkerSupervisorFactory: vi.fn(() => worker),
          channelServicePidfile: pidfile,
        },
      ),
    ).rejects.toMatchObject({ code: 'ERR_SOCKET_BAD_PORT' });

    expect(pidfile.reserveServeServiceInfo).toHaveBeenCalledWith({
      channels: ['telegram'],
      servePid: process.pid,
    });
    expect(pidfile.removeServeServiceInfo).toHaveBeenCalledWith(process.pid);
  });

  it('retries the next port on EADDRINUSE and succeeds', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-port-retry-')),
    );
    const portsAttempted: number[] = [];
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });
    vi.spyOn(serverModule, 'createServeApp').mockReturnValue({
      locals: {},
    } as unknown as express.Application);
    const testServer = createServer();
    const nativeListen = testServer.listen.bind(testServer);
    testServer.listen = vi.fn((port: number) => {
      portsAttempted.push(port);
      if (portsAttempted.length === 1) {
        const err = new Error('address in use') as NodeJS.ErrnoException;
        err.code = 'EADDRINUSE';
        setImmediate(() => testServer.emit('error', err));
      } else {
        nativeListen(0, '127.0.0.1');
      }
      return testServer;
    }) as unknown as typeof testServer.listen;

    const handle = await runQwenServe(
      {
        port: 4170,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
      },
      {
        bridge: makeFakeBridge(),
        httpServerFactory: () => testServer,
        resolveOnListen: true,
      },
    );

    try {
      stderrSpy.mockRestore();
      expect(portsAttempted).toEqual([4170, 4171]);
      expect(handle.server.listening).toBe(true);
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(handle.url).not.toContain(':4170');
      expect(new URL(handle.url).port).toBe(
        String((handle.server.address() as AddressInfo).port),
      );
      expect(
        stderrWrites.some((w) =>
          w.includes('port 4170 is in use, trying 4171'),
        ),
      ).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('does not retry on non-EADDRINUSE listen errors', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-port-no-retry-')),
    );
    const portsAttempted: number[] = [];
    const listenError = new Error('permission denied') as NodeJS.ErrnoException;
    listenError.code = 'EACCES';
    vi.spyOn(serverModule, 'createServeApp').mockReturnValue({
      locals: {},
    } as unknown as express.Application);
    const testServer = createServer();
    testServer.listen = vi.fn((port: number) => {
      portsAttempted.push(port);
      setImmediate(() => testServer.emit('error', listenError));
      return testServer;
    }) as unknown as typeof testServer.listen;

    await expect(
      runQwenServe(
        {
          port: 4170,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          serveWebShell: false,
        },
        {
          bridge: makeFakeBridge(),
          httpServerFactory: () => testServer,
        },
      ),
    ).rejects.toBe(listenError);

    expect(portsAttempted).toEqual([4170]);
  });

  it('rejects after exhausting all port retry attempts', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-port-exhaust-')),
    );
    const portsAttempted: number[] = [];
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });
    const listenError = new Error('address in use') as NodeJS.ErrnoException;
    listenError.code = 'EADDRINUSE';
    vi.spyOn(serverModule, 'createServeApp').mockReturnValue({
      locals: {},
    } as unknown as express.Application);
    const testServer = createServer();
    testServer.listen = vi.fn((port: number) => {
      portsAttempted.push(port);
      setImmediate(() => testServer.emit('error', listenError));
      return testServer;
    }) as unknown as typeof testServer.listen;

    await expect(
      runQwenServe(
        {
          port: 4170,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          serveWebShell: false,
        },
        {
          bridge: makeFakeBridge(),
          httpServerFactory: () => testServer,
        },
      ),
    ).rejects.toBe(listenError);

    stderrSpy.mockRestore();
    expect(portsAttempted).toEqual(
      Array.from({ length: 10 }, (_, i) => 4170 + i),
    );
    expect(
      stderrWrites.some((w) => w.includes('all ports 4170–4179 are in use')),
    ).toBe(true);
  });

  it('does not retry EADDRINUSE when port is 0 (ephemeral)', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-port0-no-retry-')),
    );
    const portsAttempted: number[] = [];
    const listenError = new Error('address in use') as NodeJS.ErrnoException;
    listenError.code = 'EADDRINUSE';
    vi.spyOn(serverModule, 'createServeApp').mockReturnValue({
      locals: {},
    } as unknown as express.Application);
    const testServer = createServer();
    testServer.listen = vi.fn((port: number) => {
      portsAttempted.push(port);
      setImmediate(() => testServer.emit('error', listenError));
      return testServer;
    }) as unknown as typeof testServer.listen;

    await expect(
      runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          serveWebShell: false,
        },
        {
          bridge: makeFakeBridge(),
          httpServerFactory: () => testServer,
        },
      ),
    ).rejects.toBe(listenError);

    expect(portsAttempted).toEqual([0]);
  });

  it('does not remove the channel pidfile reservation for handled uncaught exceptions', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-crash-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const pidfile = makePidfileDeps();
    const existingMonitorListeners = new Set(
      process.rawListeners('uncaughtExceptionMonitor'),
    );
    const uncaughtExceptionHandler = () => {};
    process.on('uncaughtException', uncaughtExceptionHandler);

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: pidfile,
      },
    );

    try {
      expect(pidfile.reserveServeServiceInfo).toHaveBeenCalledWith({
        channels: ['telegram'],
        servePid: process.pid,
      });
      const monitorListeners = process.rawListeners(
        'uncaughtExceptionMonitor',
      ) as Array<(error: Error, origin: 'uncaughtException') => void>;
      const newMonitorListeners = monitorListeners.filter(
        (listener) => !existingMonitorListeners.has(listener),
      );
      expect(newMonitorListeners).toHaveLength(1);
      for (const listener of newMonitorListeners) {
        listener(new Error('boom'), 'uncaughtException');
      }

      expect(pidfile.removeServeServiceInfo).not.toHaveBeenCalledWith(
        process.pid,
      );
    } finally {
      process.removeListener('uncaughtException', uncaughtExceptionHandler);
      await handle.close();
    }
  });

  it('preserves the channel pidfile reservation until an unhandled-exit worker is confirmed gone', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-unhandled-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const pidfile = makePidfileDeps();
    const existingMonitorListeners = new Set(
      process.rawListeners('uncaughtExceptionMonitor'),
    );
    const originalListenerCount = process.listenerCount.bind(process);
    const listenerCountSpy = vi
      .spyOn(process, 'listenerCount')
      .mockImplementation(
        (...args: Parameters<typeof process.listenerCount>) => {
          const [eventName] = args;
          if (eventName === 'uncaughtException') {
            return 0;
          }
          return originalListenerCount(...args);
        },
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: pidfile,
      },
    );

    try {
      const monitorListeners = process.rawListeners(
        'uncaughtExceptionMonitor',
      ) as Array<(error: Error, origin: 'uncaughtException') => void>;
      const newMonitorListeners = monitorListeners.filter(
        (listener) => !existingMonitorListeners.has(listener),
      );
      expect(newMonitorListeners).toHaveLength(1);
      for (const listener of newMonitorListeners) {
        listener(new Error('boom'), 'uncaughtException');
      }

      expect(pidfile.removeServeServiceInfo).not.toHaveBeenCalledWith(
        process.pid,
      );
    } finally {
      listenerCountSpy.mockRestore();
      await handle.close();
    }
  });
});

describe('runQwenServe startup observability', () => {
  it("names every pre-auth surface in the --allow-origin '*' warning", async () => {
    // This warning is the operator's only notice of what a wildcard origin
    // exposes without a token, so it must enumerate the actual pre-auth
    // surface: the Web Shell static assets (mounted before bearerAuth in
    // every mode) and, on loopback without --require-auth, /health. If the
    // pre-auth set drifts again, this assertion is what catches the stale
    // message.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-allow-origin-')),
    );
    const stderrWrites: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        token: 'secret',
        allowOrigins: ['*'],
      },
      { resolveOnListen: true },
    );
    try {
      await handle.runtimeReady;
      const warning = stderrWrites
        .join('')
        .split('\n')
        .find((line) => line.includes('--allow-origin:'));
      expect(warning).toBeDefined();
      expect(warning).toContain('Web Shell static assets');
      expect(warning).toContain('--no-web');
      expect(warning).toContain('/health');
      expect(warning).toContain('--require-auth');
      // The retired debug page must not resurface in the enumeration.
      expect(warning).not.toContain('/demo');
    } finally {
      spy.mockRestore();
      await handle.close();
    }
  });

  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeFakeBridge(): HttpAcpBridge {
    return {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
      getSession: vi.fn(),
      getAllSessions: vi.fn().mockReturnValue([]),
      publishWorkspaceEvent: vi.fn(),
      getEventRing: vi.fn().mockReturnValue({ getAll: () => [] }),
      resume: vi.fn(),
      preheat: vi.fn().mockResolvedValue(undefined),
      getDaemonStatusSnapshot: vi.fn().mockReturnValue(BASE_BRIDGE_SNAPSHOT),
      isChannelLive: vi.fn().mockReturnValue(true),
    } as unknown as HttpAcpBridge;
  }

  async function readStartup(handle: Pick<RunHandle, 'url' | 'resolvedToken'>) {
    const res = await fetch(`${handle.url}/daemon/status`, {
      headers: handle.resolvedToken
        ? { Authorization: `Bearer ${handle.resolvedToken}` }
        : undefined,
    });
    const body = (await res.json()) as {
      daemon?: {
        startup?: {
          processStartedAt?: string;
          listenerReadyAt?: string;
          processToListenMs?: number;
          runQwenServeToListenMs?: number;
          preheat?: {
            status?: string;
            durationMs?: number;
            error?: string;
          };
        };
      };
    };
    return body.daemon?.startup;
  }

  async function waitForPreheatStatus(
    handle: Pick<RunHandle, 'url' | 'runtimeReady'>,
    status: string,
  ) {
    await handle.runtimeReady;
    for (let i = 0; i < 20; i++) {
      const startup = await readStartup(handle);
      if (startup?.preheat?.status === status) return startup.preheat;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`preheat status did not become ${status}`);
  }

  function installInternalBridge(preheat: () => Promise<void>): HttpAcpBridge {
    const bridge = makeFakeBridge();
    vi.mocked(bridge.preheat).mockImplementation(preheat);
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    return bridge;
  }

  it('keeps the stdout listening contract and exposes startup timing on stderr and status', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-startup-')),
    );
    const stderrWrites: string[] = [];
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        allowOrigins: ['chrome-extension://qwen-test-extension'],
      },
      { bridge: makeFakeBridge() },
    );

    try {
      expect(stdoutWrites).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^qwen serve listening on http:\/\/127\.0\.0\.1:\d+ \(mode=http-bridge, workspace=/,
          ),
        ]),
      );
      expect(stderrWrites.join('')).toMatch(
        /qwen serve: startup timing: processToListenMs=\d+ runQwenServeToListenMs=\d+/,
      );
      expect(stderrWrites.join('')).not.toContain(
        'qwen serve: client-hosted MCP tools are accepted over the WebSocket without auth.',
      );

      expect(await readStartup(handle)).toMatchObject({
        processStartedAt: expect.any(String),
        listenerReadyAt: expect.any(String),
        processToListenMs: expect.any(Number),
        runQwenServeToListenMs: expect.any(Number),
        preheat: { status: 'external_bridge' },
      });
    } finally {
      await handle.close();
    }
  });

  it('uses boot runtimeOutputDir for daemon logs', async () => {
    const originalRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    delete process.env['QWEN_RUNTIME_DIR'];
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-startup-runtime-dir-')),
    );
    const boundWorkspace = canonicalizeWorkspace(tmpDir);
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    let handle: RunHandle | undefined;
    try {
      handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          maxSessions: 1,
          serveWebShell: false,
        },
        {
          bridge: makeFakeBridge(),
          bootSettings: {
            advanced: { runtimeOutputDir: '.qwen-runtime' },
          },
        },
      );
      const expectedDaemonDir = path.join(
        boundWorkspace,
        '.qwen-runtime',
        'debug',
        'daemon',
      );
      expect(stderrWrites.join('')).toContain(
        `qwen serve: daemon log → ${expectedDaemonDir}`,
      );
      expect(fs.existsSync(expectedDaemonDir)).toBe(true);
    } finally {
      await handle?.close();
      if (originalRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = originalRuntimeDir;
      }
    }
  });

  it('uses explicit daemonLogBaseDir when provided by an embedder', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-startup-log-dep-')),
    );
    const logBaseDir = path.join(tmpDir, 'explicit-debug');
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge: makeFakeBridge(),
        daemonLogBaseDir: logBaseDir,
      },
    );

    try {
      const expectedDaemonDir = path.join(logBaseDir, 'daemon');
      expect(stderrWrites.join('')).toContain(
        `qwen serve: daemon log → ${expectedDaemonDir}`,
      );
      expect(fs.existsSync(expectedDaemonDir)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('preserves Storage runtime base dir for default exported callers', async () => {
    const originalRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    delete process.env['QWEN_RUNTIME_DIR'];
    qwenCore.Storage.setRuntimeBaseDir(null);
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-startup-storage-dir-')),
    );
    fs.mkdirSync(path.join(tmpDir, '.qwen'));
    fs.writeFileSync(
      path.join(tmpDir, '.qwen', 'settings.json'),
      JSON.stringify({
        advanced: { runtimeOutputDir: '.settings-runtime' },
      }),
    );
    const runtimeBaseDir = path.join(tmpDir, 'storage-runtime');
    qwenCore.Storage.setRuntimeBaseDir(runtimeBaseDir);
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    let handle: RunHandle | undefined;
    try {
      handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          maxSessions: 1,
          serveWebShell: false,
        },
        { bridge: makeFakeBridge() },
      );
      const expectedDaemonDir = path.join(runtimeBaseDir, 'debug', 'daemon');
      expect(stderrWrites.join('')).toContain(
        `qwen serve: daemon log → ${expectedDaemonDir}`,
      );
      expect(fs.existsSync(expectedDaemonDir)).toBe(true);
    } finally {
      await handle?.close();
      qwenCore.Storage.setRuntimeBaseDir(null);
      if (originalRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = originalRuntimeDir;
      }
    }
  });

  it('tracks preheat running and succeeded states for an internally-created bridge', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-startup-preheat-')),
    );
    let resolvePreheat!: () => void;
    const preheatPromise = new Promise<void>((resolve) => {
      resolvePreheat = resolve;
    });
    const bridge = installInternalBridge(() => preheatPromise);

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { preheatBridge: true },
    );

    try {
      await waitForPreheatStatus(handle, 'running');
      expect(bridge.preheat).toHaveBeenCalledTimes(1);
      expect((await readStartup(handle))?.preheat).toMatchObject({
        status: 'running',
      });

      resolvePreheat();
      expect(await waitForPreheatStatus(handle, 'succeeded')).toMatchObject({
        status: 'succeeded',
        durationMs: expect.any(Number),
      });
    } finally {
      await handle.close();
    }
  });

  it('tracks preheat failed state and error message for an internally-created bridge', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-startup-preheat-')),
    );
    const bridge = installInternalBridge(() =>
      Promise.reject(new Error('preheat boom')),
    );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { preheatBridge: true },
    );

    try {
      await waitForPreheatStatus(handle, 'failed');
      expect(bridge.preheat).toHaveBeenCalledTimes(1);
      expect(await waitForPreheatStatus(handle, 'failed')).toMatchObject({
        status: 'failed',
        durationMs: expect.any(Number),
        error: 'preheat boom',
      });
    } finally {
      await handle.close();
    }
  });
});
