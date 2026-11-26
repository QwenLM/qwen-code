/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import * as path from 'node:path';
import { isSlowTestHost } from '../test-utils/slow-test-host.js';
import { comparableBridgeOptions } from '../test-utils/bridge-options.js';
import {
  SessionNotFoundError,
  type AcpSessionBridge,
  type BridgeFreshSessionAdmission,
  type BridgeOptions,
  type BridgeSessionSummary,
} from './acp-session-bridge.js';
import type { WorkspaceRegistry } from './workspace-registry.js';
import type { WorkspaceFileSystemFactory } from './fs/workspace-file-system.js';
import { Storage } from '@qwen-code/qwen-code-core';
import { MAX_SESSION_RESTORE_TIMEOUT_MS } from '@qwen-code/acp-bridge/sessionRestoreTimeout';
import { ProcessRegistry } from '@qwen-code/acp-bridge/processRegistry';
import { createChildHeapPolicy } from '@qwen-code/acp-bridge/childHeapPolicy';
import { resolveDaemonMemoryBudget } from '@qwen-code/acp-bridge/daemonMemoryBudget';
import type { StartScheduledTaskKeepaliveOptions } from './scheduled-task-keepalive.js';

const WS_BOUND = path.resolve('/work/bound');

function makeBridge(
  sessionCount = 0,
  liveSessionIds?: ReadonlySet<string>,
): AcpSessionBridge {
  const getSessionSummary = (sessionId: string): BridgeSessionSummary => {
    if (liveSessionIds && !liveSessionIds.has(sessionId)) {
      throw new SessionNotFoundError(sessionId);
    }
    return {
      sessionId,
      workspaceCwd: WS_BOUND,
      createdAt: '2026-05-17T12:00:00.000Z',
      clientCount: 1,
      hasActivePrompt: false,
    };
  };

  return {
    get sessionCount() {
      return sessionCount;
    },
    getSessionSummary,
    getDaemonStatusSnapshot: () => ({
      limits: {
        maxSessions: 20,
        maxPendingPromptsPerSession: 5,
        eventRingSize: 8_000,
        eventRingMaxBytes: 8 * 1024 * 1024,
        compactedReplayMaxBytes: 4 * 1024 * 1024,
        maxJournalEvents: 10_000,
        maxJournalBytes: 8 * 1024 * 1024,
        journalGrowth: null,
        channelIdleTimeoutMs: 0,
        sessionIdleTimeoutMs: 1_800_000,
        sessionPromptSettledCloseGraceMs: 0,
      },
      sessionCount,
      pendingPermissionCount: 0,
      channelLive: true,
      permissionPolicy: 'first-responder',
      sessions: [],
    }),
    activePromptCount: 0,
    lastActivityAt: null,
    isChannelLive: () => true,
    spawnOrAttach: vi.fn(),
    async shutdown() {},
    killAllSync() {},
  } as unknown as AcpSessionBridge;
}

// The ecs-qwen pool runs several jobs at once; under that contention these
// tests pass alone in milliseconds but blow the 15s ceiling without any
// real hang. Give that pool the raised budget its other suites already use.
const timeoutMs = isSlowTestHost() ? 60_000 : 30_000;
vi.setConfig({ testTimeout: timeoutMs, hookTimeout: timeoutMs });

describe('createServeApp default bridge wiring', () => {
  afterEach(() => {
    vi.doUnmock('./acp-session-bridge.js');
    vi.doUnmock('./scheduled-task-keepalive.js');
    vi.doUnmock('./server/session-restore.js');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('wires the internally-created bridge lifecycle into the workspace registry', async () => {
    let sessionLifecycle: BridgeOptions['sessionLifecycle'];
    let bridgeOptions: BridgeOptions | undefined;
    const liveSessionIds = new Set<string>();
    const bridge = makeBridge(0, liveSessionIds);
    vi.doMock('./acp-session-bridge.js', async () => {
      const actual = await vi.importActual<
        typeof import('./acp-session-bridge.js')
      >('./acp-session-bridge.js');
      return {
        ...actual,
        createAcpSessionBridge: vi.fn((opts: BridgeOptions) => {
          bridgeOptions = opts;
          sessionLifecycle = opts.sessionLifecycle;
          return bridge;
        }),
      };
    });

    const { createServeApp } = await import('./server.js');
    const app = createServeApp(
      {
        port: 0,
        hostname: '127.0.0.1',
        workspace: WS_BOUND,
      } as Parameters<typeof createServeApp>[0],
      () => 0,
    );
    const locals = app.locals as { workspaceRegistry?: WorkspaceRegistry };

    expect(sessionLifecycle).toBeDefined();
    expect(bridgeOptions).toMatchObject({
      delegateReadTextFileToClient: false,
      artifactSnapshotRuntimeBaseDir: Storage.getRuntimeBaseDir(),
    });
    await expect(
      bridgeOptions!.fileSystem!.writeText({
        path: '/var/tmp/qwen-default-embed-external.txt',
        content: 'must-not-write',
        sessionId: 'session-default-embed',
        _meta: {
          'qwen-code/tool-write-origin': {
            version: 1,
            source: 'write_file',
          },
        },
      }),
    ).rejects.toMatchObject({ kind: 'untrusted_workspace' });
    liveSessionIds.add('session-indexed');
    sessionLifecycle!({
      type: 'registered',
      sessionId: 'session-indexed',
      workspaceCwd: WS_BOUND,
      reason: 'spawn',
    });
    expect(
      locals.workspaceRegistry!.resolveLiveSessionOwner('session-indexed'),
    ).toEqual({
      kind: 'found',
      runtime: locals.workspaceRegistry!.primary,
    });
    liveSessionIds.delete('session-indexed');
    sessionLifecycle!({
      type: 'removed',
      sessionId: 'session-indexed',
      workspaceCwd: WS_BOUND,
      reason: 'client_close',
    });
    expect(
      locals.workspaceRegistry!.resolveLiveSessionOwner('session-indexed'),
    ).toEqual({
      kind: 'not_found',
    });
  });

  it('keeps the same-host write route disabled for an injected filesystem factory', async () => {
    let bridgeOptions: BridgeOptions | undefined;
    const bridge = makeBridge();
    vi.doMock('./acp-session-bridge.js', async () => {
      const actual = await vi.importActual<
        typeof import('./acp-session-bridge.js')
      >('./acp-session-bridge.js');
      return {
        ...actual,
        createAcpSessionBridge: vi.fn((opts: BridgeOptions) => {
          bridgeOptions = opts;
          return bridge;
        }),
      };
    });
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

    const { createServeApp } = await import('./server.js');
    createServeApp(
      {
        port: 0,
        hostname: '127.0.0.1',
        workspace: WS_BOUND,
      } as Parameters<typeof createServeApp>[0],
      () => 0,
      { fsFactory },
    );

    await expect(
      bridgeOptions!.fileSystem!.writeText({
        path: '/var/tmp/qwen-injected-factory-external.txt',
        content: 'must-not-write',
        sessionId: 'session-injected-factory',
        _meta: {
          'qwen-code/tool-write-origin': {
            version: 1,
            source: 'write_file',
          },
        },
      }),
    ).rejects.toBe(boundaryError);
    expect(writeSameHostToolText).not.toHaveBeenCalled();
  });

  it('pairs the default Bridge only when opted in, keeping its factory and other options', async () => {
    const bridgeOptions: BridgeOptions[] = [];
    const spawnFactories: Array<{ extraArgs?: string[]; factory: unknown }> =
      [];
    vi.doMock('./acp-session-bridge.js', async () => {
      const actual = await vi.importActual<
        typeof import('./acp-session-bridge.js')
      >('./acp-session-bridge.js');
      return {
        ...actual,
        createSpawnChannelFactory: vi.fn(
          (options: Parameters<typeof actual.createSpawnChannelFactory>[0]) => {
            const factory = actual.createSpawnChannelFactory(options);
            spawnFactories.push({ extraArgs: options?.extraArgs, factory });
            return factory;
          },
        ),
        createAcpSessionBridge: vi.fn((opts: BridgeOptions) => {
          bridgeOptions.push(opts);
          return makeBridge();
        }),
      };
    });
    const { createServeApp } = await import('./server.js');
    const { defaultSpawnChannelFactory } = await import(
      './acp-session-bridge.js'
    );
    const managed = {
      factory: vi.fn(),
      evaluate: vi.fn(() => ({ status: 'compatible' as const })),
    };
    // The spawn factories each build created.
    const spawnedBy = new Map<BridgeOptions, unknown[]>();
    const build = (
      extra: Record<string, unknown>,
      deps: Parameters<typeof createServeApp>[2] = {},
    ): BridgeOptions => {
      const before = bridgeOptions.length;
      const spawnedBefore = spawnFactories.length;
      createServeApp(
        {
          port: 0,
          hostname: '127.0.0.1',
          workspace: WS_BOUND,
          ...extra,
        } as Parameters<typeof createServeApp>[0],
        () => 0,
        deps,
      );
      expect(bridgeOptions).toHaveLength(before + 1);
      const built = bridgeOptions[before]!;
      spawnedBy.set(
        built,
        spawnFactories.slice(spawnedBefore).map((created) => created.factory),
      );
      return built;
    };
    const managedChildProcesses = {
      registry: new ProcessRegistry(),
      policy: createChildHeapPolicy({
        budget: resolveDaemonMemoryBudget({ availableMemoryMb: 2048 }),
        mode: 'admit',
      }),
    };
    const plain = build({});
    const plainWithArgs = build({ experimentalLsp: true });
    const engineOnly = build({}, { managedExecutionEngine: managed });
    const paired = build({ experimentalPairedEngines: true });
    const pairedWithArgs = build({
      experimentalPairedEngines: true,
      experimentalLsp: true,
    });
    const pairedWithEngine = build(
      { experimentalPairedEngines: true },
      { managedExecutionEngine: managed },
    );
    const plainWithChildren = build({}, { managedChildProcesses });
    const pairedWithChildren = build(
      { experimentalPairedEngines: true },
      { managedChildProcesses },
    );
    // Options that are off or unset by default, so a paired Bridge that reset
    // one would differ.
    const enabled = {
      token: 'secret',
      enableSessionShell: true,
      restoreAskUserQuestion: true,
      maxSessions: 7,
      maxPendingPromptsPerSession: 8,
      eventRingSize: 1234,
      eventRingMaxBytes: 1_234_567,
      compactedReplayMaxBytes: 2_345_678,
      maxJournalEvents: 3456,
      maxJournalBytes: 4_567_890,
      initializeTimeoutMs: 12_345,
      permissionResponseTimeoutMs: 56_789,
    };
    const plainEnabled = build(enabled);
    const pairedEnabled = build({
      ...enabled,
      experimentalPairedEngines: true,
    });
    expect(plain.eventRingMaxBytes).toBeUndefined();
    expect(plainEnabled).toMatchObject({
      eventRingMaxBytes: 1_234_567,
      sessionShellCommandEnabled: true,
      initializeTimeoutMs: 12_345,
      permissionResponseTimeoutMs: 56_789,
    });
    const withArgs = spawnFactories.filter((created) =>
      created.extraArgs?.includes('--experimental-lsp'),
    );
    expect(withArgs).toHaveLength(2);
    for (const options of [plainWithChildren, pairedWithChildren]) {
      expect(spawnedBy.get(options)).toHaveLength(1);
    }

    // Without the opt-in the Bridge is built as before, even with an engine.
    for (const options of [
      plain,
      plainWithArgs,
      engineOnly,
      plainWithChildren,
    ]) {
      expect(options.executionEngines).toBeUndefined();
    }
    expect(plain.channelFactory).toBeUndefined();
    expect(engineOnly.channelFactory).toBeUndefined();
    expect(plainWithArgs.channelFactory).toBe(withArgs[0]!.factory);
    expect(plainWithChildren.channelFactory).toBe(
      spawnedBy.get(plainWithChildren)![0],
    );
    expect(managed.evaluate).not.toHaveBeenCalled();

    // With it, only the channel factory is replaced by the pair.
    expect(comparableBridgeOptions([paired])).toEqual(
      comparableBridgeOptions([plain]),
    );
    expect(comparableBridgeOptions([pairedWithArgs])).toEqual(
      comparableBridgeOptions([plainWithArgs]),
    );
    expect(comparableBridgeOptions([pairedWithEngine])).toEqual(
      comparableBridgeOptions([engineOnly]),
    );
    expect(comparableBridgeOptions([pairedWithChildren])).toEqual(
      comparableBridgeOptions([plainWithChildren]),
    );
    expect(comparableBridgeOptions([pairedEnabled])).toEqual(
      comparableBridgeOptions([plainEnabled]),
    );
    for (const options of [
      paired,
      pairedWithArgs,
      pairedWithEngine,
      pairedWithChildren,
      pairedEnabled,
    ]) {
      expect(options.channelFactory).toBeUndefined();
    }
    expect(paired.executionEngines!.legacy).toBe(defaultSpawnChannelFactory);
    expect(pairedWithArgs.executionEngines!.legacy).toBe(withArgs[1]!.factory);
    expect(pairedWithChildren.executionEngines!.legacy).toBe(
      spawnedBy.get(pairedWithChildren)![0],
    );
    await expect(paired.executionEngines!.managed(WS_BOUND)).rejects.toThrow(
      'No Managed execution engine is available in this host.',
    );
    const spawn = {
      operation: 'spawn' as const,
      request: { workspaceCwd: WS_BOUND },
      daemonOwnedStandalone: false,
    };
    await expect(paired.executionEngines!.select(spawn)).resolves.toBe(
      'legacy',
    );
    expect(pairedWithEngine.executionEngines!.managed).toBe(managed.factory);
    await expect(
      pairedWithEngine.executionEngines!.select(spawn),
    ).resolves.toBe('managed');
    expect(managed.evaluate).toHaveBeenCalledTimes(1);
  });

  it('wires total admission into the internally-created bridge', async () => {
    let freshSessionAdmission: BridgeFreshSessionAdmission | undefined;
    vi.doMock('./acp-session-bridge.js', async () => {
      const actual = await vi.importActual<
        typeof import('./acp-session-bridge.js')
      >('./acp-session-bridge.js');
      return {
        ...actual,
        createAcpSessionBridge: vi.fn((opts: BridgeOptions) => {
          freshSessionAdmission = opts.freshSessionAdmission;
          return makeBridge(1);
        }),
      };
    });

    const { createServeApp } = await import('./server.js');
    createServeApp(
      {
        port: 0,
        hostname: '127.0.0.1',
        workspace: WS_BOUND,
        maxTotalSessions: 1,
      } as Parameters<typeof createServeApp>[0],
      () => 0,
    );

    expect(freshSessionAdmission).toBeDefined();
    let rejection: unknown;
    try {
      freshSessionAdmission!({
        operation: 'spawn',
        workspaceCwd: WS_BOUND,
      });
    } catch (err) {
      rejection = err;
    }
    expect(rejection).toMatchObject({
      name: 'TotalSessionLimitExceededError',
      limit: 1,
      scope: 'total',
      operation: 'spawn',
      workspaceCwd: WS_BOUND,
    });
  });

  it('reports disabled load admission on the default-bridge path when opted out', async () => {
    vi.doMock('./acp-session-bridge.js', async () => {
      const actual = await vi.importActual<
        typeof import('./acp-session-bridge.js')
      >('./acp-session-bridge.js');
      return {
        ...actual,
        createAcpSessionBridge: vi.fn(() => makeBridge()),
      };
    });

    const { createServeApp } = await import('./server.js');
    const { DISABLED_LOAD_ADMISSION_SNAPSHOT } = await import(
      './load-admission.js'
    );
    const app = createServeApp(
      {
        port: 0,
        hostname: '127.0.0.1',
        workspace: WS_BOUND,
        loadAdmission: false,
      } as Parameters<typeof createServeApp>[0],
      () => 0,
    );
    const res = await request(app)
      .get('/daemon/status')
      .set('Host', '127.0.0.1:0');
    expect(res.status).toBe(200);
    expect(res.body.runtime.loadAdmission).toEqual(
      DISABLED_LOAD_ADMISSION_SNAPSHOT,
    );
  });

  it('enables load admission by default on the default-bridge path', async () => {
    vi.doMock('./acp-session-bridge.js', async () => {
      const actual = await vi.importActual<
        typeof import('./acp-session-bridge.js')
      >('./acp-session-bridge.js');
      return {
        ...actual,
        createAcpSessionBridge: vi.fn(() => makeBridge()),
      };
    });

    const { createServeApp } = await import('./server.js');
    const app = createServeApp(
      {
        port: 0,
        hostname: '127.0.0.1',
        workspace: WS_BOUND,
      } as Parameters<typeof createServeApp>[0],
      () => 0,
    );
    const res = await request(app)
      .get('/daemon/status')
      .set('Host', '127.0.0.1:0');
    expect(res.status).toBe(200);
    expect(res.body.runtime.loadAdmission).toMatchObject({
      enabled: true,
      overloaded: false,
    });
  });

  it('wires the effective restore timeout into the direct bridge', async () => {
    const bridgeOptions: BridgeOptions[] = [];
    vi.doMock('./acp-session-bridge.js', async () => {
      const actual = await vi.importActual<
        typeof import('./acp-session-bridge.js')
      >('./acp-session-bridge.js');
      return {
        ...actual,
        createAcpSessionBridge: vi.fn((opts: BridgeOptions) => {
          bridgeOptions.push(opts);
          return makeBridge();
        }),
      };
    });

    const { createServeApp } = await import('./server.js');
    createServeApp({
      port: 0,
      hostname: '127.0.0.1',
      mode: 'http-bridge',
      workspace: WS_BOUND,
      initializeTimeoutMs: 90_000,
    });

    expect(bridgeOptions).toHaveLength(1);
    expect(bridgeOptions[0]).toMatchObject({
      initializeTimeoutMs: 90_000,
      sessionRestoreTimeoutMs: 90_000,
    });
  });

  it('does not let a short initialize timeout lower the restore budget', async () => {
    const bridgeOptions: BridgeOptions[] = [];
    vi.doMock('./acp-session-bridge.js', async () => {
      const actual = await vi.importActual<
        typeof import('./acp-session-bridge.js')
      >('./acp-session-bridge.js');
      return {
        ...actual,
        createAcpSessionBridge: vi.fn((opts: BridgeOptions) => {
          bridgeOptions.push(opts);
          return makeBridge();
        }),
      };
    });

    const { createServeApp } = await import('./server.js');
    createServeApp({
      port: 0,
      hostname: '127.0.0.1',
      mode: 'http-bridge',
      workspace: WS_BOUND,
      initializeTimeoutMs: 10_000,
    });

    expect(bridgeOptions).toHaveLength(1);
    expect(bridgeOptions[0]).toMatchObject({
      initializeTimeoutMs: 10_000,
      sessionRestoreTimeoutMs: 60_000,
    });
  });

  it.each([
    {
      label: 'derives the scheduled-task budget from the restore budget',
      sessionRestoreTimeoutMs: 90_000,
      expected: 100_000,
    },
    {
      label: 'passes the disable sentinel when the derived value overflows',
      sessionRestoreTimeoutMs: MAX_SESSION_RESTORE_TIMEOUT_MS,
      expected: MAX_SESSION_RESTORE_TIMEOUT_MS + 1,
    },
  ])('$label', async ({ sessionRestoreTimeoutMs, expected }) => {
    // Without this, deleting the `loadTimeoutMs` / `reviveTimeoutMs` arguments
    // ships green and both helpers silently fall back to their own 70s
    // defaults — so boot rehydrate and keepalive revive would preempt a
    // longer in-flight restore while the non-abortable bridge restore keeps
    // running.
    type RestoreSession = StartScheduledTaskKeepaliveOptions['restoreSession'];
    let rehydrateOpts:
      | { loadTimeoutMs?: number; restoreSession?: RestoreSession }
      | undefined;
    let keepaliveOpts:
      | { reviveTimeoutMs?: number; restoreSession?: RestoreSession }
      | undefined;
    const restoredSession = { sessionId: 'task-session' };
    const restoreSessionCore = vi
      .fn()
      .mockResolvedValue({ kind: 'restored', session: restoredSession });
    vi.doMock('./server/session-restore.js', async () => ({
      ...(await vi.importActual<typeof import('./server/session-restore.js')>(
        './server/session-restore.js',
      )),
      restoreSessionCore,
    }));
    vi.doMock('./scheduled-task-keepalive.js', async () => {
      const actual = await vi.importActual<
        typeof import('./scheduled-task-keepalive.js')
      >('./scheduled-task-keepalive.js');
      return {
        ...actual,
        rehydrateScheduledTaskSessions: vi.fn(
          async (opts: NonNullable<typeof rehydrateOpts>) => {
            rehydrateOpts = opts;
            return { attempted: 0, restored: 0, failed: 0 };
          },
        ),
        startScheduledTaskKeepalive: vi.fn(
          (opts: NonNullable<typeof keepaliveOpts>) => {
            keepaliveOpts = opts;
            return { stop: () => {} };
          },
        ),
      };
    });
    vi.doMock('./acp-session-bridge.js', async () => {
      const actual = await vi.importActual<
        typeof import('./acp-session-bridge.js')
      >('./acp-session-bridge.js');
      return {
        ...actual,
        createAcpSessionBridge: vi.fn(() => makeBridge()),
      };
    });

    const { createServeApp } = await import('./server.js');
    const app = createServeApp(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: WS_BOUND,
        sessionRestoreTimeoutMs,
      },
      undefined,
      // Keepalive and rehydrate only run when the daemon manages task sessions
      // and the workspace is trusted.
      { manageScheduledTaskSessions: true, primaryWorkspaceTrusted: true },
    );
    await vi.waitFor(() => expect(rehydrateOpts).toBeDefined());

    expect(rehydrateOpts?.loadTimeoutMs).toBe(expected);
    expect(keepaliveOpts?.reviveTimeoutMs).toBe(expected);
    const registry = (app.locals as { workspaceRegistry: WorkspaceRegistry })
      .workspaceRegistry;
    const runtime = registry.primary;
    for (const callback of [
      rehydrateOpts?.restoreSession,
      keepaliveOpts?.restoreSession,
    ]) {
      expect(callback).toBeTypeOf('function');
      await expect(
        callback!({
          sessionId: 'task-session',
          workspaceCwd: WS_BOUND,
          sourceType: 'scheduled_task',
          sourceId: 'task-1',
        }),
      ).resolves.toBe(restoredSession);
      expect(restoreSessionCore).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'resume',
          runtime,
          workspaceCwd: WS_BOUND,
          sessionId: 'task-session',
          restoreSource: { sourceType: 'scheduled_task', sourceId: 'task-1' },
          assertRuntimeGenerationOpen: expect.any(Function),
        }),
      );
    }
    registry.primaryEntry.current!.guard.close();
    await expect(
      keepaliveOpts!.restoreSession!({
        sessionId: 'task-session',
        workspaceCwd: WS_BOUND,
      }),
    ).rejects.toMatchObject({ code: 'workspace_generation_closed' });
    expect(restoreSessionCore).toHaveBeenCalledTimes(2);
  });
});

describe('createServeApp load admission factory injection', () => {
  it('uses the injected monitor factory and wires its verdict into admission', async () => {
    const factory = vi.fn(() => ({
      snapshot: () => ({
        enabled: true,
        overloaded: true,
        reason: 'cpu_load' as const,
        loadRatio: 3,
        eventLoopLagP99Ms: 1,
        sampledAtMs: 1,
      }),
      dispose: vi.fn(),
    }));
    let captured: Record<string, unknown> | undefined;
    vi.doMock('./acp-session-bridge.js', async () => {
      const actual = await vi.importActual<
        typeof import('./acp-session-bridge.js')
      >('./acp-session-bridge.js');
      return {
        ...actual,
        createAcpSessionBridge: vi.fn((opts: Record<string, unknown>) => {
          captured = opts;
          return makeBridge();
        }),
      };
    });

    const { createServeApp } = await import('./server.js');
    const app = createServeApp(
      {
        port: 0,
        hostname: '127.0.0.1',
        workspace: WS_BOUND,
      } as Parameters<typeof createServeApp>[0],
      () => 0,
      { createLoadAdmissionMonitor: factory },
    );
    expect(factory).toHaveBeenCalledTimes(1);

    const admission = captured?.['freshSessionAdmission'] as
      | ((ctx: { operation: string; workspaceCwd: string }) => unknown)
      | undefined;
    expect(admission).toBeTypeOf('function');
    expect(() =>
      admission!({ operation: 'spawn', workspaceCwd: WS_BOUND }),
    ).toThrow('System overloaded');

    // The fake bridge does not enforce admission internally, so the HTTP
    // refusal is pinned by the real-bridge E2E rig; here the status verdict
    // proves the injected monitor reaches the app's status projection.
    const res = await request(app)
      .get('/daemon/status')
      .set('Host', '127.0.0.1:0');
    expect(res.status).toBe(200);
    expect(res.body.runtime.loadAdmission).toMatchObject({
      enabled: true,
      overloaded: true,
      reason: 'cpu_load',
    });
  });
});

describe('createServeApp load admission with injected workspace registry', () => {
  it('never builds a monitor and reports disabled when a registry is injected', async () => {
    const factory = vi.fn(() => ({
      snapshot: () => ({
        enabled: true,
        overloaded: true,
        reason: 'cpu_load' as const,
        loadRatio: 3,
        eventLoopLagP99Ms: 1,
        sampledAtMs: 1,
      }),
      dispose: vi.fn(),
    }));
    vi.doMock('./acp-session-bridge.js', async () => {
      const actual = await vi.importActual<
        typeof import('./acp-session-bridge.js')
      >('./acp-session-bridge.js');
      return {
        ...actual,
        createAcpSessionBridge: vi.fn(() => makeBridge()),
      };
    });

    const { createServeApp } = await import('./server.js');
    const { createWorkspaceRegistry } = await import('./workspace-registry.js');
    const { ClientMcpSenderRegistry } = await import(
      './acp-http/client-mcp-sender-registry.js'
    );
    const { DISABLED_LOAD_ADMISSION_SNAPSHOT } = await import(
      './load-admission.js'
    );
    const registry = createWorkspaceRegistry([
      {
        workspaceId: 'primary',
        workspaceCwd: WS_BOUND,
        sessionRuntimeBaseDir: '/tmp/wiring-registry-runtime',
        primary: true,
        trusted: true,
        env: { mode: 'parent-process', overlayKeys: [] },
        bridge: makeBridge(),
        workspaceService: {} as never,
        routeFileSystemFactory: {} as never,
        clientMcpSenderRegistry: new ClientMcpSenderRegistry(),
      } as never,
    ]);
    const app = createServeApp(
      {
        port: 0,
        hostname: '127.0.0.1',
        workspace: WS_BOUND,
      } as Parameters<typeof createServeApp>[0],
      () => 0,
      { createLoadAdmissionMonitor: factory, workspaceRegistry: registry },
    );
    expect(factory).not.toHaveBeenCalled();
    const res = await request(app)
      .get('/daemon/status')
      .set('Host', '127.0.0.1:0');
    expect(res.status).toBe(200);
    expect(res.body.runtime.loadAdmission).toEqual(
      DISABLED_LOAD_ADMISSION_SNAPSHOT,
    );
  });
});
