/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as acpBridge from '@qwen-code/acp-bridge/bridge';
import type {
  BridgeDaemonStatusSnapshot,
  HttpAcpBridge,
} from '@qwen-code/acp-bridge/bridgeTypes';
import { runQwenServe, type RunHandle } from './run-qwen-serve.js';
import * as refreshModule from './server/session-pr-refresh.js';

// The sibling run-qwen-serve.test.ts mocks the refresh chunk to throw for its
// degradation cases, so the ordered-stop wiring is pinned here instead.

const SNAPSHOT: BridgeDaemonStatusSnapshot = {
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

function bridge(): HttpAcpBridge {
  return {
    mandatoryLeaseAttested: true,
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
    getDaemonStatusSnapshot: vi.fn().mockReturnValue(SNAPSHOT),
    isChannelLive: vi.fn().mockReturnValue(true),
  } as unknown as HttpAcpBridge;
}

describe('runQwenServe PR-watch shutdown wiring', () => {
  let tmpDir: string;
  let handle: RunHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stops the watch through the lifecycle drain when the daemon closes', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-pr-watch-stop-')),
    );
    const workspace = path.join(tmpDir, 'project');
    fs.mkdirSync(workspace);
    const stopWatch = vi.fn(async () => {});
    const dispose = vi.fn();
    const start = vi
      .spyOn(refreshModule, 'startSessionPrRefreshTimer')
      .mockReturnValue({ dispose, stopWatch });
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(
      () => bridge() as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace,
        maxSessions: 1,
        token: 'secret-token',
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );
    // The first health schedules the runtime build, which starts the timer.
    await fetch(`${handle.url}/health`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    await expect(handle.runtimeReady).resolves.toBeUndefined();
    // The refresh chunk loads asynchronously inside the runtime build, so it
    // can land after runtimeReady; vi.waitFor's default 1s budget is independent
    // of testTimeout and too tight for a cold module graph on a loaded runner.
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1), {
      timeout: 15_000,
    });
    expect(stopWatch).not.toHaveBeenCalled();
    await handle.close();
    // The event-loop-monitor cleanup disposes and clears the timer handle
    // before the lifecycle close runs its drains, so the drain has to reach
    // the stop through its own reference.
    expect(stopWatch).toHaveBeenCalledTimes(1);
  });
});
