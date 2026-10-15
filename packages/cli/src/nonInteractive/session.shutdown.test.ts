/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { BackgroundTaskRegistry } from '@qwen-code/qwen-code-core/agents/background-tasks.js';
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
  it.each(['eof', 'sigterm', 'stream-error'] as const)(
    '%s pairs a real background cancellation once without another model turn',
    async (route) => {
      const registry = new BackgroundTaskRegistry();
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
        initialize: vi.fn(),
        waitForMcpReady: vi.fn().mockResolvedValue(undefined),
        getMonitorRegistry: () => monitor,
        getBackgroundShellRegistry: () => ({ abortAll: vi.fn() }),
        getBackgroundTaskRegistry: () => registry,
      } as unknown as Config;
      vi.mocked(StreamJsonOutputAdapter).mockImplementation(
        () => output as unknown as StreamJsonOutputAdapter,
      );
      turn.mockImplementationOnce(async () => {
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
          await vi.waitFor(() =>
            expect(output.emitSystemMessage).toHaveBeenCalledWith(
              'task_started',
              expect.objectContaining({ task_id: 'bg_shutdown' }),
            ),
          );
          if (route === 'sigterm') process.emit('SIGTERM', 'SIGTERM');
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
      const notifications = output.emitSystemMessage.mock.calls.filter(
        ([subtype, data]) =>
          subtype === 'task_notification' && data.task_id === 'bg_shutdown',
      );
      expect(registry.get('bg_shutdown')?.status).toBe('cancelled');
      expect(registry.hasUnfinalizedTasks()).toBe(false);
      expect(turn).toHaveBeenCalledTimes(1);
      expect(notifications).toHaveLength(1);
      expect(notifications[0][1].status).toBe('cancelled');
    },
  );
});
