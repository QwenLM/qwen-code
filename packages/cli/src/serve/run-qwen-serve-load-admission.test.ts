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

const loadMonitorSpy = vi.hoisted(() => ({ creations: 0, disposes: 0 }));

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
        snapshot: monitor.snapshot,
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

describe('runQwenServe load admission monitor lifecycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    loadMonitorSpy.creations = 0;
    loadMonitorSpy.disposes = 0;
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-load-admission-')),
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
});
