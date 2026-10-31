/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { LlmEventType } from '@qwen-code/qwen-code-core/core/turn.js';
import { runNonInteractiveStreamJson } from './session.js';
import { StreamJsonInputReader } from './io/StreamJsonInputReader.js';
import type { CLIMessage } from './types.js';

vi.mock('./io/StreamJsonInputReader.js');
vi.mock('../services/review-worktree-lease.js', () => ({
  cleanupReviewWorktreeLeases: vi.fn(),
}));
vi.mock('../services/CommandService.js', () => ({
  CommandService: {
    create: async () => ({
      getCommands: () => [],
      getCommandsForMode: () => [],
    }),
  },
}));
vi.mock('../ui/hooks/atCommandProcessor.js', () => ({
  handleAtCommand: async ({ query }: { query: string }) => ({
    processedQuery: [{ text: query }],
    shouldProceed: true,
  }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

it('finishes within the EOF memory budget when a real runner is already draining after its result', async () => {
  vi.useFakeTimers();
  const memory = deferred<number>();
  const draining = deferred<void>();
  const closeInput = deferred<void>();
  const inputClosed = deferred<void>();
  let pending = [memory.promise];
  const frames: CLIMessage[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((frame) => {
    frames.push(JSON.parse(String(frame)) as CLIMessage);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const client = {
    sendMessageStream: vi.fn(async function* () {
      yield { type: LlmEventType.Content, value: 'Answer' };
      yield {
        type: LlmEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 1 } },
      };
    }),
    getPendingMemoryTaskPromises: vi.fn(() => {
      draining.resolve();
      return [...pending];
    }),
    removePendingMemoryTaskPromises: vi.fn(
      (settled: ReadonlyArray<Promise<number>>) => {
        pending = pending.filter((promise) => !settled.includes(promise));
      },
    ),
    getHistoryToolCallFingerprints: () => new Map(),
    stripOrphanedUserEntriesFromHistory: vi.fn(),
    getChat: () => ({}),
  };
  const backgroundTasks = {
    setNotificationCallback: vi.fn(),
    setRegisterCallback: vi.fn(),
    getAll: () => [],
    hasUnfinalizedTasks: () => false,
    abortAll: vi.fn(),
  };
  const monitors = {
    setNotificationCallback: vi.fn(),
    setRegisterCallback: vi.fn(),
    getRunning: () => [],
    abortAll: vi.fn(),
  };
  const config = {
    initialize: async () => {},
    waitForMcpReady: async () => {},
    getWarnings: () => [],
    getSessionId: () => 'memory-deadline-session',
    getModel: () => 'test-model',
    getApprovalMode: () => 'default',
    getOutputFormat: () => 'stream-json',
    getIncludePartialMessages: () => false,
    getDebugMode: () => false,
    getLlmClient: () => client,
    getToolRegistry: () => ({
      getAllToolNames: () => [],
      getFunctionDeclarations: () => [],
    }),
    getMaxSessionTurns: () => 10,
    getMaxWallTimeSeconds: () => -1,
    getMaxToolCalls: () => -1,
    getProjectRoot: () => '/test/project',
    getTargetDir: () => '/test/project',
    getMcpServers: () => undefined,
    getCliVersion: () => 'test-version',
    getIdeMode: () => false,
    getFullContext: () => false,
    getContentGeneratorConfig: () => ({}),
    getJsonSchema: () => undefined,
    getFolderTrustFeature: () => false,
    getFolderTrust: () => false,
    isTrustedFolder: () => true,
    getExperimentalZedIntegration: () => false,
    isInteractive: () => false,
    getHookSystem: () => undefined,
    isCronEnabled: () => false,
    getCronScheduler: () => null,
    getTeamManager: () => null,
    onTeamManagerChange: vi.fn(),
    setModelInvocableCommandsProvider: vi.fn(),
    setModelInvocableCommandsExecutor: vi.fn(),
    getAutoSkillEnabled: () => false,
    getDisabledSlashCommands: () => [],
    getGoalRuntimeReady: async () => ({
      subscribe: () => () => {},
      getSnapshot: () => ({ goal: null }),
    }),
    getBackgroundTaskRegistry: () => backgroundTasks,
    getMonitorRegistry: () => monitors,
    getBackgroundShellRegistry: () => ({ abortAll: vi.fn() }),
    getResumedSessionData: () => undefined,
    consumePendingStartupWorktreeNotice: () => null,
    consumePendingRecoveredAgentsNotice: () => null,
  } as unknown as Config;
  vi.mocked(StreamJsonInputReader).mockImplementation(
    () =>
      ({
        async *read() {
          yield {
            type: 'user',
            session_id: 'memory-deadline-session',
            message: { role: 'user', content: 'Answer now' },
            parent_tool_use_id: null,
          };
          await closeInput.promise;
          inputClosed.resolve();
        },
      }) as StreamJsonInputReader,
  );
  let finished = false;
  const run = runNonInteractiveStreamJson(config, '').then(() => {
    finished = true;
  });
  try {
    await draining.promise;
    expect(client.sendMessageStream).toHaveBeenCalledOnce();
    expect(frames.filter((frame) => frame.type === 'result')).toEqual([
      expect.objectContaining({ is_error: false }),
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(finished).toBe(false);
    closeInput.resolve();
    await inputClosed.promise;
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      finished,
      'Session must finish 5,000 ms after EOF without memory settlement',
    ).toBe(true);
    expect(pending).toEqual([memory.promise]);
    expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1);
    expect(stderr).not.toHaveBeenCalled();
  } finally {
    closeInput.resolve();
    memory.resolve(0);
    await run;
  }
});
