/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { BackgroundTaskRegistry } from '@qwen-code/qwen-code-core/agents/background-tasks.js';
import { WorkflowRunRegistry } from '@qwen-code/qwen-code-core/agents/workflow-run-registry.js';
import { runNonInteractiveStreamJson } from './session.js';
import { StreamJsonInputReader } from './io/StreamJsonInputReader.js';
import { StreamJsonOutputAdapter } from './io/StreamJsonOutputAdapter.js';
import type { CLIUserMessage, CLIControlRequest } from './types.js';

const turn = vi.hoisted(() => vi.fn());
vi.mock('../nonInteractiveCli.js', () => ({
  runNonInteractive: (...args: unknown[]) => turn(...args),
  TurnInterruptedError: class TurnInterruptedError extends Error {},
}));
vi.mock('./io/StreamJsonInputReader.js', () => ({
  StreamJsonInputReader: vi.fn(),
}));
vi.mock('./io/StreamJsonOutputAdapter.js', () => ({
  StreamJsonOutputAdapter: vi.fn(),
}));
vi.mock('./control/ControlDispatcher.js', () => ({
  ControlDispatcher: vi.fn(() => ({
    dispatch: vi.fn().mockResolvedValue(undefined),
    handleControlResponse: vi.fn(),
    handleCancel: vi.fn(),
    shutdown: vi.fn(),
    markInputClosed: vi.fn(),
    getPendingIncomingRequestCount: () => 0,
    waitForPendingIncomingRequests: vi.fn().mockResolvedValue(undefined),
    sdkMcpController: {
      createSendSdkMcpMessage: vi.fn().mockReturnValue(vi.fn()),
    },
  })),
}));
vi.mock('./control/ControlContext.js', () => ({
  ControlContext: vi.fn(() => ({})),
}));
vi.mock('./control/ControlService.js', () => ({
  ControlService: vi.fn(() => ({})),
}));

describe('Session shutdown background notifications', () => {
  beforeEach(() => {
    turn.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it.each([
    { route: 'eof', phase: 'after-turn', completed: false },
    { route: 'sigterm', phase: 'after-turn', completed: false },
    { route: 'stream-error', phase: 'after-turn', completed: false },
    { route: 'sigterm', phase: 'in-flight', completed: false },
    { route: 'sigterm', phase: 'in-flight', completed: true },
    { route: 'stream-error', phase: 'in-flight', completed: false },
    { route: 'stream-error', phase: 'in-flight', completed: true },
    { route: 'sigterm', phase: 'during-shutdown', completed: false },
    { route: 'stream-error', phase: 'during-shutdown', completed: false },
  ] as const)(
    '$route pairs a $phase background task (completed=$completed) without another model turn',
    async ({ route, phase, completed }) => {
      const registry = new BackgroundTaskRegistry();
      const workflows = new WorkflowRunRegistry();
      const output = {
        emitResult: vi.fn(),
        emitMessage: vi.fn(),
        emitUserMessage: vi.fn(),
        emitSystemMessage: vi.fn(),
      };
      const monitor = {
        setNotificationCallback: vi.fn(),
        setRegisterCallback: vi.fn(),
        get: vi.fn(),
        abortAll: vi.fn(),
      };
      const config = {
        getSessionId: () => 'shutdown-test',
        getModel: () => 'mock-model',
        getIncludePartialMessages: () => false,
        getDebugMode: () => false,
        getApprovalMode: () => 'auto',
        getOutputFormat: () => 'stream-json',
        getWarnings: () => [],
        getLlmClient: () => ({
          getPendingMemoryTaskPromises: () => [],
        }),
        initialize: vi.fn(),
        waitForMcpReady: vi.fn().mockResolvedValue(undefined),
        getMonitorRegistry: () => monitor,
        getBackgroundShellRegistry: () => ({ abortAll: vi.fn() }),
        getBackgroundTaskRegistry: () => registry,
        getWorkflowRunRegistry: () => workflows,
      } as unknown as Config;
      vi.mocked(StreamJsonOutputAdapter).mockImplementation(
        () => output as unknown as StreamJsonOutputAdapter,
      );
      let markTurnEntered!: () => void;
      const turnEntered = new Promise<void>((resolve) => {
        markTurnEntered = resolve;
      });
      turn.mockImplementationOnce(async (...args: unknown[]) => {
        const { abortController } = args[4] as {
          abortController: AbortController;
        };
        const aborted = new Promise<void>((resolve) => {
          abortController.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        markTurnEntered();
        if (phase === 'during-shutdown') await aborted;
        registry.register({
          agentId: 'bg_shutdown',
          toolUseId: 'tu_shutdown',
          description: 'cancellation pairing witness',
          subagentType: 'general-purpose',
          status: 'running',
          startTime: Date.now(),
          abortController: new AbortController(),
          isBackgrounded: true,
          outputFile: '',
        });
        if (completed) registry.complete('bg_shutdown', 'completed in turn');
        if (phase === 'in-flight') await aborted;
      });
      const reader = {
        async *read(): AsyncGenerator<CLIControlRequest | CLIUserMessage> {
          yield {
            type: 'control_request',
            request_id: 'initialize',
            request: { subtype: 'initialize' },
          };
          yield {
            type: 'user',
            session_id: 'shutdown-test',
            message: { role: 'user', content: 'start background task' },
            parent_tool_use_id: null,
          };
          if (phase === 'after-turn') {
            await vi.waitFor(() =>
              expect(output.emitSystemMessage).toHaveBeenCalledWith(
                'task_started',
                expect.objectContaining({ task_id: 'bg_shutdown' }),
              ),
            );
          } else {
            await turnEntered;
          }
          if (route === 'sigterm') {
            process.emit('SIGTERM', 'SIGTERM');
            yield {
              type: 'user',
              session_id: 'shutdown-test',
              message: { role: 'user', content: 'must not run after SIGTERM' },
              parent_tool_use_id: null,
            };
          }
          if (route === 'stream-error') throw new Error('input stream failed');
        },
      };
      vi.mocked(StreamJsonInputReader).mockImplementation(
        () => reader as unknown as StreamJsonInputReader,
      );
      const session = runNonInteractiveStreamJson(config, '');
      if (route === 'stream-error')
        await expect(session).rejects.toThrow('input stream failed');
      else await session;
      const frames = output.emitSystemMessage.mock.calls.filter(
        ([subtype, data]) =>
          ['task_started', 'task_notification'].includes(subtype) &&
          data.task_id === 'bg_shutdown',
      );
      const expectedStatus = completed ? 'completed' : 'cancelled';
      expect(registry.get('bg_shutdown')?.status).toBe(expectedStatus);
      expect(registry.hasUnfinalizedTasks()).toBe(false);
      expect(turn).toHaveBeenCalledTimes(1);
      expect(frames.map(([subtype]) => subtype)).toEqual([
        'task_started',
        'task_notification',
      ]);
      expect(frames[1][1].status).toBe(expectedStatus);
    },
  );
});
