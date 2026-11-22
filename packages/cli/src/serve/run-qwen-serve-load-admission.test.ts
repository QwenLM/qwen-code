/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runQwenServe } from './run-qwen-serve.js';
import * as acpBridge from '@qwen-code/acp-bridge/bridge';
import type {
  BridgeDaemonStatusSnapshot,
  HttpAcpBridge,
} from '@qwen-code/acp-bridge/bridgeTypes';
import type { BridgeOptions } from '@qwen-code/acp-bridge/bridgeOptions';

const loadMonitorSpy = vi.hoisted(() => ({
  creations: 0,
  disposes: 0,
  overloaded: false,
}));
const bridgeOptionsSpy = vi.hoisted(() => ({
  captured: undefined as Record<string, unknown> | undefined,
}));

vi.mock('./load-admission.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./load-admission.js')>();
  return {
    ...actual,
    createLoadAdmissionMonitor: (
      ...args: Parameters<typeof actual.createLoadAdmissionMonitor>
    ) => {
      loadMonitorSpy.creations += 1;
      const monitor = actual.createLoadAdmissionMonitor(...args);
      return {
        snapshot: () =>
          loadMonitorSpy.overloaded
            ? {
                enabled: true,
                overloaded: true,
                reason: 'cpu_load' as const,
                loadRatio: 3,
                eventLoopLagP99Ms: 1,
                sampledAtMs: 1,
              }
            : monitor.snapshot(),
        dispose: () => {
          loadMonitorSpy.disposes += 1;
          monitor.dispose();
        },
      };
    },
  };
});

// Same isolation as run-qwen-serve.test.ts: keep the SessionService chain
// out of this suite's runtime build.
vi.mock('./server/session-pr-refresh.js', () => {
  throw new Error('Cannot find module session-pr-refresh (test isolation)');
});

const BASE_BRIDGE_SNAPSHOT: BridgeDaemonStatusSnapshot = {
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
  sessionCount: 0,
  pendingPermissionCount: 0,
  channelLive: true,
  permissionPolicy: 'first-responder',
  sessions: [],
};

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
    isChannelLive: vi.fn().mockReturnValue(true),
    getDaemonStatusSnapshot: vi.fn().mockReturnValue(BASE_BRIDGE_SNAPSHOT),
  } as unknown as HttpAcpBridge;
}

describe('runQwenServe load admission monitor lifecycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    loadMonitorSpy.creations = 0;
    loadMonitorSpy.disposes = 0;
    loadMonitorSpy.overloaded = false;
    bridgeOptionsSpy.captured = undefined;
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-load-admission-')),
    );
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(
      (options: BridgeOptions) => {
        bridgeOptionsSpy.captured = options as unknown as Record<
          string,
          unknown
        >;
        return makeFakeBridge() as ReturnType<
          typeof acpBridge.createAcpSessionBridge
        >;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the monitor and disposes it exactly once on close', async () => {
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
    // resolveOnListen only waits for the listener; the runtime build (which
    // creates the monitor) finishes at runtimeReady.
    await handle.runtimeReady;
    expect(loadMonitorSpy.creations).toBe(1);
    expect(loadMonitorSpy.disposes).toBe(0);

    await handle.close();

    expect(loadMonitorSpy.disposes).toBe(1);
  });

  it('never creates the monitor when loadAdmission is false', async () => {
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        loadAdmission: false,
      },
      { resolveOnListen: true },
    );
    await handle.runtimeReady;
    expect(loadMonitorSpy.creations).toBe(0);

    await handle.close();

    expect(loadMonitorSpy.creations).toBe(0);
    expect(loadMonitorSpy.disposes).toBe(0);
  });

  it('never creates the monitor when a bridge is injected', async () => {
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true, bridge: makeFakeBridge() },
    );
    await handle.runtimeReady;
    expect(loadMonitorSpy.creations).toBe(0);

    const res = await fetch(new URL('daemon/status', handle.url));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runtime: { loadAdmission: unknown };
    };
    expect(body.runtime.loadAdmission).toEqual({
      enabled: false,
      overloaded: false,
      reason: null,
      loadRatio: 0,
      eventLoopLagP99Ms: 0,
      sampledAtMs: 0,
    });

    await handle.close();
  });

  it('wires the monitor into admission so fresh sessions get 503 under overload', async () => {
    loadMonitorSpy.overloaded = true;
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

    // The bridge factory must have received the admission hook, and the
    // hook must refuse while the monitor reports overload.
    const admission = bridgeOptionsSpy.captured?.['freshSessionAdmission'] as
      | ((ctx: { operation: string; workspaceCwd: string }) => unknown)
      | undefined;
    expect(admission).toBeTypeOf('function');
    expect(() =>
      admission!({ operation: 'spawn', workspaceCwd: tmpDir }),
    ).toThrow('System overloaded');

    // The fake bridge does not enforce admission internally; the HTTP 503
    // contract is pinned by the real-bridge E2E rig. Here the status verdict
    // proves the monitor reaches the daemon's status projection.
    const res = await fetch(new URL('daemon/status', handle.url));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      runtime: {
        loadAdmission: {
          enabled: true,
          overloaded: true,
          reason: 'cpu_load',
        },
      },
    });

    await handle.close();
  });
});
