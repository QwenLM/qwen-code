/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { BackgroundTaskRegistry } from '@qwen-code/qwen-code-core/agents/background-tasks.js';
import { WorkflowRunRegistry } from '@qwen-code/qwen-code-core/agents/workflow-run-registry.js';
import { MonitorRegistry } from '@qwen-code/qwen-code-core/services/monitorRegistry.js';
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

describe('Session unpublished monitor shutdown frames', () => {
  beforeEach(() => turn.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it.each([
    'late-init-eof',
    'late-init-eof-completed',
    'late-init-eof-failed',
    'late-init-eof-cancelled',
    'pre-eof-completed',
    'pre-eof-failed',
    'pre-eof-cancelled',
    'sigterm',
    'stream-error',
    'ordinary-eof',
  ] as const)(
    '%s preserves the monitor shutdown frame policy',
    async (route) => {
      const monitors = new MonitorRegistry();
      const backgroundTasks = new BackgroundTaskRegistry();
      const workflows = new WorkflowRunRegistry();
      const abortAll = vi.spyOn(monitors, 'abortAll');
      const output = {
        emitResult: vi.fn(),
        emitMessage: vi.fn(),
        emitUserMessage: vi.fn(),
        emitSystemMessage: vi.fn(),
      };
      let finishInitialization: (() => void) | undefined;
      const config = {
        getSessionId: () => 'monitor-shutdown-probe',
        getModel: () => 'mock-model',
        getIncludePartialMessages: () => false,
        getDebugMode: () => false,
        getApprovalMode: () => 'auto',
        getOutputFormat: () => 'stream-json',
        getWarnings: () => [],
        getLlmClient: () => ({ getPendingMemoryTaskPromises: () => [] }),
        initialize: vi.fn(() =>
          route.startsWith('late-init-eof')
            ? new Promise<void>((resolve) => {
                finishInitialization = resolve;
              })
            : Promise.resolve(),
        ),
        waitForMcpReady: vi.fn().mockResolvedValue(undefined),
        getMonitorRegistry: () => monitors,
        getBackgroundShellRegistry: () => ({ abortAll: vi.fn() }),
        getBackgroundTaskRegistry: () => backgroundTasks,
        getWorkflowRunRegistry: () => workflows,
      } as unknown as Config;
      vi.mocked(StreamJsonOutputAdapter).mockImplementation(
        () => output as unknown as StreamJsonOutputAdapter,
      );
      let markRegistered!: () => void;
      const registered = new Promise<void>((resolve) => {
        markRegistered = resolve;
      });
      let releaseForeground!: () => void;
      const foregroundRelease = new Promise<void>((resolve) => {
        releaseForeground = resolve;
      });
      turn.mockImplementationOnce(async (...args: unknown[]) => {
        const { abortController } = args[4] as {
          abortController: AbortController;
        };
        monitors.register({
          monitorId: 'mon-unpublished',
          command: 'record-only probe, no process is spawned',
          description: 'monitor queued inside the last turn',
          status: 'running',
          startTime: Date.now(),
          abortController: new AbortController(),
          eventCount: 0,
          lastEventTime: 0,
          maxEvents: 1000,
          idleTimeoutMs: 300_000,
          droppedLines: 0,
          outputFile: '',
        });
        if (route.endsWith('-completed')) {
          monitors.complete('mon-unpublished', 0);
        } else if (route.endsWith('-failed')) {
          monitors.fail('mon-unpublished', 'probe failure');
        } else if (route.endsWith('-cancelled')) {
          monitors.cancel('mon-unpublished');
        } else if (route !== 'ordinary-eof') {
          monitors.emitEvent('mon-unpublished', 'queued observation');
        }
        markRegistered();
        if (route.startsWith('pre-eof')) await foregroundRelease;
        if (route === 'sigterm' || route === 'stream-error') {
          await new Promise<void>((resolve) => {
            if (abortController.signal.aborted) resolve();
            else
              abortController.signal.addEventListener(
                'abort',
                () => resolve(),
                { once: true },
              );
          });
        }
      });
      const reader = {
        async *read(): AsyncGenerator<CLIControlRequest | CLIUserMessage> {
          yield {
            type: 'user',
            session_id: 'monitor-shutdown-probe',
            message: { role: 'user', content: 'register a monitor' },
            parent_tool_use_id: null,
          };
          if (route.startsWith('late-init-eof')) return;
          await registered;
          if (route.startsWith('pre-eof')) return;
          if (route === 'ordinary-eof') {
            await vi.waitFor(() =>
              expect(output.emitSystemMessage).toHaveBeenCalledWith(
                'task_started',
                expect.objectContaining({ task_id: 'mon-unpublished' }),
              ),
            );
            return;
          }
          if (route === 'sigterm') {
            process.emit('SIGTERM', 'SIGTERM');
            yield {
              type: 'user',
              session_id: 'monitor-shutdown-probe',
              message: { role: 'user', content: 'must not run after signal' },
              parent_tool_use_id: null,
            };
          } else {
            throw new Error('input stream failed');
          }
        },
      };
      vi.mocked(StreamJsonInputReader).mockImplementation(
        () => reader as unknown as StreamJsonInputReader,
      );
      const session = runNonInteractiveStreamJson(config, '');
      if (route.startsWith('late-init-eof')) {
        await vi.waitFor(() => {
          expect(finishInitialization).toBeDefined();
          expect(abortAll).toHaveBeenCalledTimes(1);
        });
        finishInitialization?.();
      }
      if (route.startsWith('pre-eof')) {
        await vi.waitFor(() => expect(abortAll).toHaveBeenCalledTimes(1));
        releaseForeground();
      }
      try {
        if (route === 'stream-error')
          await expect(session).rejects.toThrow('input stream failed');
        else await session;
        const frames = output.emitSystemMessage.mock.calls.filter(
          ([subtype, data]) =>
            ['task_started', 'task_notification'].includes(subtype) &&
            data.task_id === 'mon-unpublished',
        );
        const capturedTerminal = route.endsWith('-completed')
          ? 'completed'
          : route.endsWith('-failed')
            ? 'failed'
            : route.endsWith('-cancelled')
              ? 'cancelled'
              : undefined;
        expect(monitors.get('mon-unpublished')?.status).toBe(
          capturedTerminal ?? 'cancelled',
        );
        expect(turn).toHaveBeenCalledTimes(route.startsWith('pre-eof') ? 2 : 1);
        if (capturedTerminal) {
          expect(frames.map(([subtype]) => subtype)).toEqual([
            'task_started',
            'task_notification',
          ]);
          expect(frames[1][1].status).toBe(capturedTerminal);
        } else if (route === 'ordinary-eof') {
          expect(frames.map(([subtype]) => subtype)).toEqual(['task_started']);
          expect(frames[0][1]).not.toHaveProperty('monitorId');
        } else {
          expect(frames).toEqual([]);
        }
      } finally {
        releaseForeground();
        monitors.abortAll({ notify: false });
      }
    },
  );
});
