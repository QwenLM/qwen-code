/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  SessionNotFoundError,
  type AcpSessionBridge,
  type BridgeFreshSessionAdmission,
  type BridgeOptions,
  type BridgeSessionSummary,
} from './acp-session-bridge.js';
import type { WorkspaceRegistry } from './workspace-registry.js';
import type { WorkspaceFileSystemFactory } from './fs/workspace-file-system.js';
import { MAX_SESSION_RESTORE_TIMEOUT_MS } from '@qwen-code/acp-bridge/sessionRestoreTimeout';

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
    async shutdown() {},
    killAllSync() {},
  } as unknown as AcpSessionBridge;
}

// The ecs-qwen pool runs several jobs at once; under that contention these
// tests pass alone in milliseconds but blow the 15s ceiling without any
// real hang. Give that pool the raised budget its other suites already use.
const timeoutMs = process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')
  ? 60_000
  : 15_000;
vi.setConfig({ testTimeout: timeoutMs, hookTimeout: timeoutMs });

describe('createServeApp default bridge wiring', () => {
  afterEach(() => {
    vi.doUnmock('./acp-session-bridge.js');
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
    let rehydrateOpts: { loadTimeoutMs?: number } | undefined;
    let keepaliveOpts: { reviveTimeoutMs?: number } | undefined;
    vi.doMock('./scheduled-task-keepalive.js', async () => {
      const actual = await vi.importActual<
        typeof import('./scheduled-task-keepalive.js')
      >('./scheduled-task-keepalive.js');
      return {
        ...actual,
        rehydrateScheduledTaskSessions: vi.fn(
          async (opts: { loadTimeoutMs?: number }) => {
            rehydrateOpts = opts;
            return { attempted: 0, restored: 0, failed: 0 };
          },
        ),
        startScheduledTaskKeepalive: vi.fn(
          (opts: { reviveTimeoutMs?: number }) => {
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
    createServeApp(
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
    vi.doUnmock('./scheduled-task-keepalive.js');
  });
});
