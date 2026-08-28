/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session switch parity tests (useResumeCommand/useBranchCommand): the
 * core-before-UI swap order, the rollback on failure, and the transcript
 * replay seam. SessionService disk access is mocked at the prototype level;
 * no real session files are touched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionService } from '@qwen-code/qwen-code-core';
import type { Config, ResumedSessionData } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import {
  handleBranchSession,
  handleResumeSession,
  type SessionSwitchHost,
} from './session-switch.js';

function emptySession(): ResumedSessionData {
  return {
    conversation: {
      sessionId: 'target',
      projectHash: 'hash',
      startTime: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      messages: [],
    },
    historyGaps: [],
  } as unknown as ResumedSessionData;
}

interface FakeConfigCalls {
  startNewSession: Array<[string, unknown]>;
  rebuildTurnBoundaries: number;
  clientInitialize: number;
}

function createFakeConfig(options?: { failClientInitialize?: boolean }): {
  config: Config;
  calls: FakeConfigCalls;
} {
  const calls: FakeConfigCalls = {
    startNewSession: [],
    rebuildTurnBoundaries: 0,
    clientInitialize: 0,
  };
  // Stable registry objects so tests can flip their behavior live.
  const backgroundTaskRegistry = {
    hasRunningTasks: () => false,
    getAll: () => [],
    reset: () => {},
  };
  const registries = {
    getBackgroundTaskRegistry: () => backgroundTaskRegistry,
    getMonitorRegistry: () => ({ getRunning: () => [], reset: () => {} }),
    getBackgroundShellRegistry: () => ({
      hasRunningEntries: () => false,
      getAll: () => [],
      reset: () => {},
    }),
    getWorkflowRunRegistry: () => ({
      hasRunningEntries: () => false,
      list: () => [],
      abortAll: () => {},
      reset: () => {},
    }),
  };
  const config = {
    ...registries,
    getSessionId: () => 'old-session',
    getTargetDir: () => '/tmp/fake-target',
    getGoalRuntimeReady: async () => {},
    getChatRecordingService: () => ({
      rebuildTurnBoundaries: () => {
        calls.rebuildTurnBoundaries += 1;
      },
      finalize: () => {},
      flush: async () => {},
    }),
    getGeminiClient: () => ({
      initialize: async () => {
        calls.clientInitialize += 1;
        if (options?.failClientInitialize) {
          throw new Error('client init failed');
        }
      },
    }),
    loadPausedBackgroundAgents: async () => [],
    getBackgroundAgentResumeService: () => ({
      buildRecoveredBackgroundAgentsNotice: () => '',
    }),
    startNewSession: (sessionId: string, sessionData?: unknown) => {
      calls.startNewSession.push([sessionId, sessionData]);
    },
    getDebugLogger: () => ({ warn: () => {} }),
    getSessionService: () => ({
      loadSession: async () => emptySession(),
      forkSession: async () => {},
      renameSession: async () => true,
      removeSession: async () => true,
    }),
  } as unknown as Config;
  return { config, calls };
}

function createFakeHost(config: Config): SessionSwitchHost & {
  events: string[];
  transcriptResets: number;
  uiStarts: string[];
} {
  const host = {
    config,
    settings: { merged: {} } as unknown as LoadedSettings,
    addItem: vi.fn(() => 0),
    clearItems: vi.fn(),
    loadHistory: vi.fn(),
    startNewSession: vi.fn(),
    setSessionName: vi.fn(),
    clearPendingState: vi.fn(),
    resetTranscript: vi.fn(),
  };
  return Object.assign(host, {
    events: [],
    transcriptResets: 0,
    uiStarts: [],
  });
}

describe('handleResumeSession', () => {
  beforeEach(() => {
    vi.spyOn(SessionService.prototype, 'loadSession').mockResolvedValue(
      emptySession() as never,
    );
    vi.spyOn(SessionService.prototype, 'getSessionTitle').mockReturnValue(
      'Custom Title',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('swaps core before UI and replays the transcript', async () => {
    const { config, calls } = createFakeConfig();
    const host = createFakeHost(config);
    await handleResumeSession(host, 'target-session');

    // Core swap: startNewSession(target, data) + turn boundaries + client.
    expect(calls.startNewSession[0]).toEqual([
      'target-session',
      expect.objectContaining({ conversation: expect.anything() }),
    ]);
    expect(calls.rebuildTurnBoundaries).toBe(1);
    expect(calls.clientInitialize).toBe(1);
    // UI swap order: session reset → clear → ink history → transcript.
    expect(host.startNewSession).toHaveBeenCalledWith('target-session');
    expect(host.setSessionName).toHaveBeenCalledWith('Custom Title');
    expect(host.clearPendingState).toHaveBeenCalled();
    expect(host.clearItems).toHaveBeenCalled();
    expect(host.loadHistory).toHaveBeenCalled();
    expect(host.resetTranscript).toHaveBeenCalledTimes(1);
    const replay = (host.resetTranscript as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Array<{ type: string }>;
    // The replay always ends with the done event.
    expect(replay.at(-1)?.type).toBe('done');
  });

  it('rolls the core back to the old session when the swap fails', async () => {
    const { config, calls } = createFakeConfig({
      failClientInitialize: true,
    });
    const host = createFakeHost(config);
    await handleResumeSession(host, 'target-session');

    // Forward swap happened, then the rollback restored the old session.
    expect(calls.startNewSession.map(([id]) => id)).toEqual([
      'target-session',
      'old-session',
    ]);
    // UI never swapped.
    expect(host.loadHistory).not.toHaveBeenCalled();
    expect(host.resetTranscript).not.toHaveBeenCalled();
    // The failure is reported.
    expect(host.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringContaining('Failed to resume session'),
      }),
      expect.any(Number),
    );
  });

  it('blocks the switch while background work is running', async () => {
    const { config, calls } = createFakeConfig();
    const registry = config.getBackgroundTaskRegistry() as unknown as {
      hasRunningTasks: () => boolean;
    };
    registry.hasRunningTasks = () => true;
    const host = createFakeHost(config);
    await handleResumeSession(host, 'target-session');
    expect(calls.startNewSession).toHaveLength(0);
    expect(host.addItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
      expect.any(Number),
    );
  });
});

describe('handleBranchSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forks, persists a title, swaps core then UI, and announces', async () => {
    const { config, calls } = createFakeConfig();
    const forkSession = vi.fn(async () => {});
    const renameSession = vi.fn(async () => true);
    const sessionService = {
      loadSession: async () => emptySession(),
      forkSession,
      renameSession,
      removeSession: vi.fn(async () => true),
      findSessionTitlesByPrefix: async () => [],
    };
    (
      config as unknown as { getSessionService: () => unknown }
    ).getSessionService = () => sessionService;
    const host = createFakeHost(config);

    await handleBranchSession(host, 'my-branch');

    expect(forkSession).toHaveBeenCalledWith('old-session', expect.any(String));
    expect(renameSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('my-branch'),
      'manual',
    );
    // Core swap before UI swap; client initialized with the Branch source.
    expect(calls.clientInitialize).toBe(1);
    expect(calls.startNewSession.length).toBe(1);
    expect(host.loadHistory).toHaveBeenCalled();
    expect(host.resetTranscript).toHaveBeenCalledTimes(1);
    expect(host.setSessionName).toHaveBeenCalled();
    // The two-line announcement (branch + resume hint).
    const infos = (host.addItem as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0])
      .filter((item) => item.type === 'info');
    expect(infos.length).toBe(2);
    expect(infos[0].text).toContain('You are now in the branch');
    expect(infos[1].text).toContain('/resume old-session');
  });

  it('removes the fork and reports the failure when the title write fails', async () => {
    const { config, calls } = createFakeConfig();
    const removeSession = vi.fn(async () => true);
    const sessionService = {
      loadSession: async () => emptySession(),
      forkSession: vi.fn(async () => {}),
      renameSession: vi.fn(async () => false),
      removeSession,
      findSessionTitlesByPrefix: async () => [],
    };
    (
      config as unknown as { getSessionService: () => unknown }
    ).getSessionService = () => sessionService;
    const host = createFakeHost(config);

    await handleBranchSession(host);

    expect(removeSession).toHaveBeenCalled();
    expect(calls.startNewSession).toHaveLength(0);
    expect(host.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringContaining('Failed to branch conversation'),
      }),
      expect.any(Number),
    );
  });
});
