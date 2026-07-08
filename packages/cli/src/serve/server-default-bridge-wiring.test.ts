/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AcpSessionBridge,
  BridgeFreshSessionAdmission,
  BridgeOptions,
  BridgeSessionSummary,
} from './acp-session-bridge.js';
import type { WorkspaceRegistry } from './workspace-registry.js';

const WS_BOUND = '/work/bound';

function makeBridge(sessionCount = 0): AcpSessionBridge {
  const getSessionSummary = (sessionId: string): BridgeSessionSummary => ({
    sessionId,
    workspaceCwd: WS_BOUND,
    createdAt: '2026-05-17T12:00:00.000Z',
    clientCount: 1,
    hasActivePrompt: false,
  });

  return {
    get sessionCount() {
      return sessionCount;
    },
    getSessionSummary,
    async shutdown() {},
    killAllSync() {},
  } as unknown as AcpSessionBridge;
}

describe('createServeApp default bridge wiring', () => {
  afterEach(() => {
    vi.doUnmock('./acp-session-bridge.js');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('wires the internally-created bridge lifecycle into the workspace registry', async () => {
    let sessionLifecycle: BridgeOptions['sessionLifecycle'];
    const bridge = makeBridge();
    vi.doMock('./acp-session-bridge.js', async () => {
      const actual = await vi.importActual<
        typeof import('./acp-session-bridge.js')
      >('./acp-session-bridge.js');
      return {
        ...actual,
        createAcpSessionBridge: vi.fn((opts: BridgeOptions) => {
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
  }, 15_000);

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
});
