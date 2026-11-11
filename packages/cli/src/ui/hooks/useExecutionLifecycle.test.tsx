/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_SHELL_PREFIX } from "@qwen-code/core";

import { act } from 'react';
import { render } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';

const mockShellExecutionService = vi.hoisted(() => vi.fn());
const mockShellKill = vi.hoisted(() => vi.fn());
const mockShellBackground = vi.hoisted(() => vi.fn());
const mockShellSubscribe = vi.hoisted(() =>
  vi.fn<
    (pid: number, listener: (event: ShellOutputEvent) => void) => () => void
  >(() => vi.fn()),
); // Returns unsubscribe
const mockShellOnExit = vi.hoisted(() =>
  vi.fn<
    (
      pid: number,
      callback: (exitCode: number, signal?: number) => void,
    ) => () => void
  >(() => vi.fn()),
);
const mockLifecycleSubscribe = vi.hoisted(() =>
  vi.fn<
    (pid: number, listener: (event: ShellOutputEvent) => void) => () => void
  >(() => vi.fn()),
);
const mockLifecycleOnExit = vi.hoisted(() =>
  vi.fn<
    (
      pid: number,
      callback: (exitCode: number, signal?: number) => void,
    ) => () => void
  >(() => vi.fn()),
);
const mockLifecycleKill = vi.hoisted(() => vi.fn());
const mockLifecycleBackground = vi.hoisted(() => vi.fn());
const mockLifecycleOnBackground = vi.hoisted(() => vi.fn());
const mockLifecycleOffBackground = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    getCwd: vi.fn(() => '/test/dir'),
    ShellExecutionService: {
      execute: mockShellExecutionService,
      kill: mockShellKill,
      background: mockShellBackground,
      subscribe: mockShellSubscribe,
      onExit: mockShellOnExit,
    },
    ExecutionLifecycleService: {
      subscribe: mockLifecycleSubscribe,
      onExit: mockLifecycleOnExit,
      kill: mockLifecycleKill,
      background: mockLifecycleBackground,
      onBackground: mockLifecycleOnBackground,
      offBackground: mockLifecycleOffBackground,
    },
    backgroundUserShellCommand: (
      executionId: number,
      sessionId: string,
      command: string,
    ) => mockShellBackground(executionId, sessionId, command, 'user'),
    runUserShellCommand: vi.fn(
      async (
        options: Parameters<typeof actual.runUserShellCommand>[0],
      ): ReturnType<typeof actual.runUserShellCommand> => {
        let latestProgress:
          | { totalLines?: number; totalBytes?: number }
          | undefined;
        const handle = await mockShellExecutionService(
          options.command,
          options.config.getTargetDir(),
          (event: ShellOutputEvent) => {
            if (event.type !== 'data') return;
            latestProgress = {
              ...(event.totalLines === undefined
                ? {}
                : { totalLines: event.totalLines }),
              ...(event.totalBytes === undefined
                ? {}
                : { totalBytes: event.totalBytes }),
            };
            options.onProgress?.({
              output: event.chunk,
              ...latestProgress,
            });
          },
          options.signal,
          {
            ...options.config.getShellExecutionConfig(),
            sessionId: options.config.getSessionId(),
            pager: 'cat',
            originalCommand: options.command,
          },
        );
        if (handle.pid) options.onExecutionId?.(handle.pid);
        const result: ShellExecutionResult = await handle.result;
        const normalizedOutput = result.output.startsWith('[Binary output:')
          ? '[Command produced binary output, which is not shown.]'
          : result.output.trim() || '(Command produced no output)';

        if (result.backgrounded && result.pid) {
          return {
            kind: 'backgrounded',
            command: options.command,
            pid: result.pid,
            displayOutput: `Command moved to background (PID: ${result.pid}). Output hidden. Use /tasks to view.`,
            modelOutput: { stdout: result.output, stderr: '' },
            ...(latestProgress ? { progress: latestProgress } : {}),
          };
        }
        if (result.aborted) {
          return {
            kind: 'cancelled',
            command: options.command,
            displayOutput: `Command was cancelled.\n${normalizedOutput}`,
            modelOutput: { stdout: normalizedOutput, stderr: '' },
            timedOut: result.timedOut ?? false,
            ...(latestProgress ? { progress: latestProgress } : {}),
          };
        }

        const errorMessage = result.error?.message;
        const status = errorMessage
          ? errorMessage
          : result.signal !== null
            ? `Command terminated by signal: ${result.signal}.`
            : result.exitCode !== null && result.exitCode !== 0
              ? `Command exited with code ${result.exitCode}.`
              : '';
        return {
          kind: 'completed',
          command: options.command,
          displayOutput: status
            ? `${status}\n${normalizedOutput}`
            : normalizedOutput,
          modelOutput: {
            stdout: normalizedOutput,
            stderr: status,
          },
          exitCode: result.exitCode,
          signal: result.signal,
          ...(errorMessage ? { errorMessage } : {}),
          ...(latestProgress ? { progress: latestProgress } : {}),
        };
      },
    ),
  };
});

import { useExecutionLifecycle } from './useExecutionLifecycle.js';
import {
  type Config,
  type ShellExecutionResult,
  type ShellOutputEvent,
  CoreToolCallStatus,
} from '@qwen-code/core';

describe('useExecutionLifecycle', () => {
  let addItemToHistoryMock: Mock;
  let setPendingHistoryItemMock: Mock;
  let onDebugMessageMock: Mock;
  let mockConfig: Config;

  let mockShellOutputCallback: (event: ShellOutputEvent) => void;
  let resolveExecutionPromise: (result: ShellExecutionResult) => void;

  let mockFocusMachine: { focusChat: Mock };

  beforeEach(() => {
    vi.clearAllMocks();

    addItemToHistoryMock = vi.fn();
    setPendingHistoryItemMock = vi.fn();
    onDebugMessageMock = vi.fn();
    mockFocusMachine = { focusChat: vi.fn() };
    mockConfig = {
      getTargetDir: () => '/test/dir',
      getSessionId: () => 'test-session',
      getShellExecutionConfig: () => ({
        terminalHeight: 20,
        terminalWidth: 80,
        sanitizationConfig: {
          allowedEnvironmentVariables: [],
          blockedEnvironmentVariables: [],
          enableEnvironmentVariableRedaction: false,
        },
      }),
    } as unknown as Config;

    mockShellExecutionService.mockImplementation((_cmd, _cwd, callback) => {
      mockShellOutputCallback = callback;
      return Promise.resolve({
        pid: 12345,
        result: new Promise((resolve) => {
          resolveExecutionPromise = resolve;
        }),
      });
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const renderProcessorHook = async (
    foregroundToolExecutionIds: readonly number[] = [],
  ) => {
    let hookResult: ReturnType<typeof useExecutionLifecycle>;
    let renderCount = 0;
    function TestComponent({
      isWaitingForConfirmation,
    }: {
      isWaitingForConfirmation?: boolean;
    }) {
      renderCount++;
      hookResult = useExecutionLifecycle(
        addItemToHistoryMock,
        setPendingHistoryItemMock,
        onDebugMessageMock,
        mockConfig,
        mockFocusMachine as unknown as Parameters<
          typeof useExecutionLifecycle
        >[4],
        undefined,
        undefined,
        foregroundToolExecutionIds,
        isWaitingForConfirmation,
      );
      return null;
    }
    const { rerender } = await render(<TestComponent />);
    return {
      result: {
        get current() {
          return hookResult;
        },
      },
      getRenderCount: () => renderCount,
      rerender: (isWaitingForConfirmation?: boolean) =>
        rerender(
          <TestComponent isWaitingForConfirmation={isWaitingForConfirmation} />,
        ),
    };
  };

  describe('backgroundForegroundExecutions', () => {
    it('returns zero when there are no foreground executions', async () => {
      const { result } = await renderProcessorHook();

      expect(result.current.backgroundForegroundExecutions()).toBe(0);
      expect(mockShellBackground).not.toHaveBeenCalled();
      expect(mockLifecycleBackground).not.toHaveBeenCalled();
    });

    it('backgrounds every unique foreground tool execution', async () => {
      mockLifecycleBackground.mockImplementation((executionId: number) =>
        executionId === 202 ? undefined : { executionId },
      );
      const { result } = await renderProcessorHook([101, 101, 202, 303]);

      expect(result.current.backgroundForegroundExecutions()).toBe(2);
      expect(mockLifecycleBackground.mock.calls).toEqual([
        [101, 'user'],
        [202, 'user'],
        [303, 'user'],
      ]);
    });

    it('backgrounds the user shell and all other tool executions', async () => {
      mockLifecycleBackground.mockImplementation((executionId: number) => ({
        executionId,
      }));
      const { result } = await renderProcessorHook([12345, 101, 202]);

      await act(async () => {
        void result.current.handleShellCommand(
          'sleep 30',
          new AbortController().signal,
        );
      });

      expect(result.current.activeShellId).toBe(12345);
      expect(result.current.backgroundForegroundExecutions()).toBe(3);
      expect(mockShellBackground).toHaveBeenCalledWith(
        12345,
        'test-session',
        'sleep 30',
        'user',
      );
      expect(mockLifecycleBackground.mock.calls).toEqual([
        [101, 'user'],
        [202, 'user'],
      ]);
    });
  });

  const createMockServiceResult = (
    overrides: Partial<ShellExecutionResult> = {},
  ): ShellExecutionResult => ({
    rawOutput: Buffer.from(overrides.output || ''),
    output: 'Success',
    exitCode: 0,
    signal: null,
    error: null,
    aborted: false,
    pid: 12345,
    executionMethod: 'child_process',
    ...overrides,
  });

  it('should initiate command execution and set pending state', async () => {
    const { result } = await renderProcessorHook();

    await act(async () => {
      void result.current.handleShellCommand(
        'ls -l',
        new AbortController().signal,
      );
    });

    expect(addItemToHistoryMock).toHaveBeenCalledWith(
      { type: 'user_shell', text: 'ls -l' },
      expect.any(Number),
    );
    expect(setPendingHistoryItemMock).toHaveBeenCalledWith({
      type: 'tool_group',
      tools: [
        expect.objectContaining({
          name: 'Shell Command',
          status: CoreToolCallStatus.Executing,
          startedAt: expect.any(Number),
        }),
      ],
    });
    expect(mockShellExecutionService).toHaveBeenCalledWith(
      'ls -l',
      '/test/dir',
      expect.any(Function),
      expect.any(Object),
      expect.objectContaining({
        sessionId: 'test-session',
        pager: 'cat',
        originalCommand: 'ls -l',
      }),
    );
  });

  it('keeps the user command unchanged when a shell prefix is configured', async () => {
    vi.stubEnv(ENV_SHELL_PREFIX, '/tmp/qwen-shell-wrapper');
    const { result } = await renderProcessorHook();

    await act(async () => {
      void result.current.handleShellCommand(
        'printf "raw command"',
        new AbortController().signal,
      );
    });

    expect(addItemToHistoryMock).toHaveBeenCalledWith(
      { type: 'user_shell', text: 'printf "raw command"' },
      expect.any(Number),
    );
    expect(setPendingHistoryItemMock).toHaveBeenCalledWith({
      type: 'tool_group',
      tools: [
        expect.objectContaining({
          description: 'printf "raw command"',
        }),
      ],
    });
    expect(mockShellExecutionService).toHaveBeenCalledWith(
      'printf "raw command"',
      '/test/dir',
      expect.any(Function),
      expect.any(Object),
      expect.objectContaining({
        originalCommand: 'printf "raw command"',
      }),
    );
  });

  it('should handle successful execution and update history correctly', async () => {
    const { result } = await renderProcessorHook();

    let execPromise!: ReturnType<typeof result.current.handleShellCommand>;
    act(() => {
      execPromise = result.current.handleShellCommand(
        'echo "ok"',
        new AbortController().signal,
      );
    });

    act(() => {
      resolveExecutionPromise(createMockServiceResult({ output: 'ok' }));
    });
    let outcome!: Awaited<typeof execPromise>;
    await act(async () => {
      outcome = await execPromise;
    });

    expect(setPendingHistoryItemMock).toHaveBeenCalledWith(null);
    expect(addItemToHistoryMock).toHaveBeenCalledTimes(2); // Initial + final
    expect(addItemToHistoryMock.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        tools: [
          expect.objectContaining({
            status: CoreToolCallStatus.Success,
            resultDisplay: 'ok',
          }),
        ],
      }),
    );
    expect(outcome).toEqual({
      kind: 'completed',
      command: 'echo "ok"',
      displayOutput: 'ok',
      modelOutput: { stdout: 'ok', stderr: '' },
      exitCode: 0,
      signal: null,
    });
    expect(mockFocusMachine.focusChat).toHaveBeenCalled();
  });

  it('should handle command failure and display error status', async () => {
    const { result } = await renderProcessorHook();

    let execPromise!: ReturnType<typeof result.current.handleShellCommand>;
    act(() => {
      execPromise = result.current.handleShellCommand(
        'bad-cmd',
        new AbortController().signal,
      );
    });

    act(() => {
      resolveExecutionPromise(
        createMockServiceResult({ exitCode: 127, output: 'not found' }),
      );
    });
    let outcome!: Awaited<typeof execPromise>;
    await act(async () => {
      outcome = await execPromise;
    });

    const finalHistoryItem = addItemToHistoryMock.mock.calls[1][0];
    expect(finalHistoryItem.tools[0].status).toBe(CoreToolCallStatus.Error);
    expect(finalHistoryItem.tools[0].resultDisplay).toContain(
      'Command exited with code 127',
    );
    expect(finalHistoryItem.tools[0].resultDisplay).toContain('not found');
    expect(outcome).toMatchObject({
      kind: 'completed',
      command: 'bad-cmd',
      exitCode: 127,
    });
    expect(mockFocusMachine.focusChat).toHaveBeenCalled();
  });

  describe('UI Streaming and Throttling', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('should update UI for text streams (non-interactive)', async () => {
      const { result } = await renderProcessorHook();
      await act(async () => {
        void result.current.handleShellCommand(
          'stream',
          new AbortController().signal,
        );
      });

      expect(mockShellExecutionService).toHaveBeenCalledWith(
        'stream',
        '/test/dir',
        expect.any(Function),
        expect.any(Object),
        expect.any(Object),
      );

      // Wait for the async PID update to happen.
      // Call 1: Initial, Call 2: PID update
      await waitFor(() => {
        expect(setPendingHistoryItemMock).toHaveBeenCalledTimes(2);
      });

      // Get the state after the PID update to feed into the stream updaters
      const pidUpdateFn = setPendingHistoryItemMock.mock.calls[1][0];
      const initialState = setPendingHistoryItemMock.mock.calls[0][0];
      const stateAfterPid = pidUpdateFn(initialState);

      // Simulate first output chunk
      act(() => {
        mockShellOutputCallback({
          type: 'data',
          chunk: 'hello',
        });
      });
      // A UI update should have occurred.
      expect(setPendingHistoryItemMock).toHaveBeenCalledTimes(3);

      const streamUpdateFn1 = setPendingHistoryItemMock.mock.calls[2][0];
      const stateAfterStream1 = streamUpdateFn1(stateAfterPid);
      expect(stateAfterStream1.tools[0].resultDisplay).toBe('hello');

      // Simulate second output chunk (full snapshot replaces previous)
      act(() => {
        mockShellOutputCallback({
          type: 'data',
          chunk: 'hello world',
        });
      });
      // Another UI update should have occurred.
      expect(setPendingHistoryItemMock).toHaveBeenCalledTimes(4);

      const streamUpdateFn2 = setPendingHistoryItemMock.mock.calls[3][0];
      const stateAfterStream2 = streamUpdateFn2(stateAfterStream1);
      expect(stateAfterStream2.tools[0].resultDisplay).toBe('hello world');
    });

    it('should show progress snapshot data events correctly', async () => {
      const { result } = await renderProcessorHook();
      await act(async () => {
        void result.current.handleShellCommand(
          'cat file',
          new AbortController().signal,
        );
      });

      // Wait for the async PID update
      await waitFor(() => {
        expect(setPendingHistoryItemMock).toHaveBeenCalledTimes(2);
      });

      // Get the state after the PID update
      const pidUpdateFn = setPendingHistoryItemMock.mock.calls[1][0];
      const initialState = setPendingHistoryItemMock.mock.calls[0][0];
      const stateAfterPid = pidUpdateFn(initialState);

      // Send a data event with progress snapshot
      act(() => {
        mockShellOutputCallback({ type: 'data', chunk: 'line1\n' });
      });

      expect(setPendingHistoryItemMock).toHaveBeenCalledTimes(3);
      const streamUpdateFn1 = setPendingHistoryItemMock.mock.calls[2][0];
      const stateAfterData = streamUpdateFn1(stateAfterPid);

      expect(stateAfterData).toEqual(
        expect.objectContaining({
          tools: [
            expect.objectContaining({
              resultDisplay: 'line1\n',
            }),
          ],
        }),
      );

      // Send a second data event (full snapshot replaces previous)
      act(() => {
        mockShellOutputCallback({
          type: 'data',
          chunk: 'line1\nline2\n',
        });
      });

      expect(setPendingHistoryItemMock).toHaveBeenCalledTimes(4);
      const streamUpdateFn2 = setPendingHistoryItemMock.mock.calls[3][0];
      const stateAfterSecondData = streamUpdateFn2(stateAfterData);
      expect(stateAfterSecondData).toEqual(
        expect.objectContaining({
          tools: [
            expect.objectContaining({
              resultDisplay: 'line1\nline2\n',
            }),
          ],
        }),
      );
    });
  });

  it('should handle command abort and display cancelled status', async () => {
    const { result } = await renderProcessorHook();
    const abortController = new AbortController();

    let execPromise!: ReturnType<typeof result.current.handleShellCommand>;
    act(() => {
      execPromise = result.current.handleShellCommand(
        'sleep 5',
        abortController.signal,
      );
    });

    act(() => {
      abortController.abort();
      resolveExecutionPromise(
        createMockServiceResult({ aborted: true, output: 'Canceled' }),
      );
    });
    let outcome!: Awaited<typeof execPromise>;
    await act(async () => {
      outcome = await execPromise;
    });

    // With the new logic, cancelled commands are not added to history by this hook
    // to avoid duplication/flickering, as they are handled by the run loop.
    expect(addItemToHistoryMock).toHaveBeenCalledTimes(1);
    expect(setPendingHistoryItemMock).toHaveBeenCalledWith(null);
    expect(outcome).toMatchObject({
      kind: 'cancelled',
      command: 'sleep 5',
    });
    expect(mockFocusMachine.focusChat).toHaveBeenCalled();
  });

  it('should return a backgrounded outcome without cancelling the task', async () => {
    const { result } = await renderProcessorHook();
    let execPromise!: ReturnType<typeof result.current.handleShellCommand>;

    act(() => {
      execPromise = result.current.handleShellCommand(
        'sleep 30',
        new AbortController().signal,
      );
    });
    act(() => {
      resolveExecutionPromise(
        createMockServiceResult({
          backgrounded: true,
          pid: 12345,
          output: '',
        }),
      );
    });

    let outcome!: Awaited<typeof execPromise>;
    await act(async () => {
      outcome = await execPromise;
    });

    expect(outcome).toMatchObject({
      kind: 'backgrounded',
      command: 'sleep 30',
      pid: 12345,
    });
    expect(addItemToHistoryMock.mock.calls[1][0]).toMatchObject({
      tools: [
        {
          status: CoreToolCallStatus.Success,
          resultDisplay: expect.stringContaining('moved to background'),
        },
      ],
    });
  });

  it('should handle binary output result correctly', async () => {
    const { result } = await renderProcessorHook();

    let execPromise!: ReturnType<typeof result.current.handleShellCommand>;
    act(() => {
      execPromise = result.current.handleShellCommand(
        'cat image.png',
        new AbortController().signal,
      );
    });

    act(() => {
      resolveExecutionPromise(
        createMockServiceResult({
          output: '[Binary output: 1024 bytes]',
        }),
      );
    });
    await act(async () => {
      await execPromise;
    });

    const finalHistoryItem = addItemToHistoryMock.mock.calls[1][0];
    expect(finalHistoryItem.tools[0].status).toBe(CoreToolCallStatus.Success);
    expect(finalHistoryItem.tools[0].resultDisplay).toBe(
      '[Command produced binary output, which is not shown.]',
    );
  });

  it('should prepend warnings to error output', async () => {
    const { result } = await renderProcessorHook();

    let execPromise!: ReturnType<typeof result.current.handleShellCommand>;
    act(() => {
      execPromise = result.current.handleShellCommand(
        'ls',
        new AbortController().signal,
      );
    });

    act(() => {
      resolveExecutionPromise(
        createMockServiceResult({
          exitCode: 1,
          output: 'ansi line 1',
        }),
      );
    });
    await act(async () => {
      await execPromise;
    });

    expect(setPendingHistoryItemMock).toHaveBeenCalledWith(null);
    expect(addItemToHistoryMock).toHaveBeenCalledTimes(2);

    const historyCall = addItemToHistoryMock.mock.calls[1][0];
    const display = historyCall.tools[0].resultDisplay;

    expect(display).toContain('Command exited with code 1');
    expect(display).toContain('ansi line 1');
  });

  it('should handle promise rejection and show an error', async () => {
    const { result } = await renderProcessorHook();
    const testError = new Error('Unexpected failure');
    mockShellExecutionService.mockImplementation(() => ({
      pid: 12345,
      result: Promise.reject(testError),
    }));

    let execPromise!: ReturnType<typeof result.current.handleShellCommand>;
    act(() => {
      execPromise = result.current.handleShellCommand(
        'a-command',
        new AbortController().signal,
      );
    });

    await act(async () => {
      await execPromise;
    });

    expect(setPendingHistoryItemMock).toHaveBeenCalledWith(null);
    expect(addItemToHistoryMock).toHaveBeenCalledTimes(2);
    expect(addItemToHistoryMock.mock.calls[1][0]).toEqual({
      type: 'error',
      text: 'An unexpected error occurred: Unexpected failure',
    });
    expect(mockFocusMachine.focusChat).toHaveBeenCalled();
  });

  it('should handle synchronous errors during execution and clean up resources', async () => {
    const testError = new Error('Synchronous spawn error');
    mockShellExecutionService.mockImplementation(() => {
      throw testError;
    });

    const { result } = await renderProcessorHook();

    let execPromise!: ReturnType<typeof result.current.handleShellCommand>;
    act(() => {
      execPromise = result.current.handleShellCommand(
        'a-command',
        new AbortController().signal,
      );
    });

    await act(async () => {
      await execPromise;
    });

    expect(setPendingHistoryItemMock).toHaveBeenCalledWith(null);
    expect(addItemToHistoryMock).toHaveBeenCalledTimes(2);
    expect(addItemToHistoryMock.mock.calls[1][0]).toEqual({
      type: 'error',
      text: 'An unexpected error occurred: Synchronous spawn error',
    });
    expect(mockFocusMachine.focusChat).toHaveBeenCalled();
  });

  describe('ActiveShellId management', () => {
    beforeEach(() => {
      // The real service returns a promise that resolves with the pid and result promise
      mockShellExecutionService.mockImplementation((_cmd, _cwd, callback) => {
        mockShellOutputCallback = callback;
        return Promise.resolve({
          pid: 12345,
          result: new Promise((resolve) => {
            resolveExecutionPromise = resolve;
          }),
        });
      });
    });

    it('should have activeShellId as null initially', async () => {
      const { result } = await renderProcessorHook();
      expect(result.current.activeShellId).toBeNull();
    });

    it('should set activeShellId when a command with a PID starts', async () => {
      const { result } = await renderProcessorHook();

      await act(async () => {
        void result.current.handleShellCommand(
          'ls',
          new AbortController().signal,
        );
      });

      expect(result.current.activeShellId).toBe(12345);
    });

    it('should update the pending history item with the executionId', async () => {
      const { result } = await renderProcessorHook();

      await act(async () => {
        void result.current.handleShellCommand(
          'ls',
          new AbortController().signal,
        );
      });

      await waitFor(() => {
        // Wait for the second call which is the functional update
        expect(setPendingHistoryItemMock).toHaveBeenCalledTimes(2);
      });

      // The state update is functional, so we test it by executing it.
      const updaterFn = setPendingHistoryItemMock.mock.lastCall?.[0];
      expect(typeof updaterFn).toBe('function');

      // The initial state is the first call to setPendingHistoryItem
      const initialState = setPendingHistoryItemMock.mock.calls[0][0];
      const stateAfterPid = updaterFn(initialState);

      expect(stateAfterPid.tools[0].executionId).toBe(12345);
    });

    it('should reset activeShellId to null after successful execution', async () => {
      const { result } = await renderProcessorHook();

      let execPromise!: ReturnType<typeof result.current.handleShellCommand>;
      await act(async () => {
        execPromise = result.current.handleShellCommand(
          'ls',
          new AbortController().signal,
        );
      });

      expect(result.current.activeShellId).toBe(12345);

      await act(async () => {
        resolveExecutionPromise(createMockServiceResult());
      });
      await act(async () => {
        await execPromise;
      });

      expect(result.current.activeShellId).toBeNull();
    });

    it('should reset activeShellId to null after failed execution', async () => {
      const { result } = await renderProcessorHook();

      let execPromise!: ReturnType<typeof result.current.handleShellCommand>;
      await act(async () => {
        execPromise = result.current.handleShellCommand(
          'bad-cmd',
          new AbortController().signal,
        );
      });

      expect(result.current.activeShellId).toBe(12345);

      await act(async () => {
        resolveExecutionPromise(createMockServiceResult({ exitCode: 1 }));
      });
      await act(async () => {
        await execPromise;
      });

      expect(result.current.activeShellId).toBeNull();
    });

    it('should reset activeShellId to null if execution promise rejects', async () => {
      let rejectResultPromise: (reason?: unknown) => void;
      mockShellExecutionService.mockImplementation(() =>
        Promise.resolve({
          pid: 12345,
          result: new Promise((_, reject) => {
            rejectResultPromise = reject;
          }),
        }),
      );
      const { result } = await renderProcessorHook();

      let execPromise!: ReturnType<typeof result.current.handleShellCommand>;
      await act(async () => {
        execPromise = result.current.handleShellCommand(
          'cmd',
          new AbortController().signal,
        );
      });

      expect(result.current.activeShellId).toBe(12345);

      await act(async () => {
        rejectResultPromise(new Error('Failure'));
      });

      await act(async () => {
        await execPromise;
      });

      expect(result.current.activeShellId).toBeNull();
    });

    it('should not set activeShellId on synchronous execution error and should remain null', async () => {
      mockShellExecutionService.mockImplementation(() => {
        throw new Error('Sync Error');
      });
      const { result } = await renderProcessorHook();

      expect(result.current.activeShellId).toBeNull(); // Pre-condition

      let execPromise!: ReturnType<typeof result.current.handleShellCommand>;
      act(() => {
        execPromise = result.current.handleShellCommand(
          'cmd',
          new AbortController().signal,
        );
      });

      // The hook's state should not have changed to a PID
      expect(result.current.activeShellId).toBeNull();

      await act(async () => {
        await execPromise;
      }); // Let the promise resolve

      // And it should still be null after everything is done
      expect(result.current.activeShellId).toBeNull();
    });

    it('should not set activeShellId if service does not return a PID', async () => {
      mockShellExecutionService.mockImplementation((_cmd, _cwd, callback) => {
        mockShellOutputCallback = callback;
        return Promise.resolve({
          pid: undefined, // No PID
          result: new Promise((resolve) => {
            resolveExecutionPromise = resolve;
          }),
        });
      });

      const { result } = await renderProcessorHook();

      act(() => {
        void result.current.handleShellCommand(
          'ls',
          new AbortController().signal,
        );
      });

      // Let microtasks run
      await act(async () => {});

      expect(result.current.activeShellId).toBeNull();
    });
  });
});
