/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import type { Config } from '../config/config.js';
import { ExecutionLifecycleService } from '../services/executionLifecycleService.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import {
  _resetQueueForTest,
  getCommandQueueSnapshot,
} from '../services/messageQueueManager.js';
import { TaskRegistry } from '../tasks/task-registry.js';
import { ENV_REMOTE_WORKER } from '../config/brand.js';
import {
  applyMonitorRemoteTimeoutCap,
  MONITOR_DEFAULT_TIMEOUT_MS,
  MONITOR_REMOTE_MAX_TIMEOUT_MS,
  type MonitorToolParams,
  MonitorTool,
} from './monitor.js';

describe('MonitorTool', () => {
  let config: Config;
  let executeSpy: MockInstance<typeof ShellExecutionService.execute>;
  let backgroundSpy: MockInstance<typeof ShellExecutionService.background>;
  let killSpy: MockInstance<typeof ExecutionLifecycleService.kill>;
  let executionOptions: Record<string, unknown>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.unstubAllEnvs();
    _resetQueueForTest();
    ExecutionLifecycleService.resetForTest();
    config = {
      getShellExecutionConfig: vi.fn(() => ({})),
      getSessionId: vi.fn(() => 'session-1'),
      getTargetDir: vi.fn(() => '/tmp'),
      sanitizationConfig: {},
      taskRegistry: new TaskRegistry(),
    } as unknown as Config;

    executeSpy = vi
      .spyOn(ShellExecutionService, 'execute')
      .mockImplementation(async (_command, _cwd, _output, _signal, options) => {
        executionOptions = options as unknown as Record<string, unknown>;
        return {
          pid: 4242,
          result: new Promise(() => {}),
        };
      });
    backgroundSpy = vi
      .spyOn(ShellExecutionService, 'background')
      .mockImplementation(() => {});
    killSpy = vi
      .spyOn(ExecutionLifecycleService, 'kill')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    _resetQueueForTest();
  });

  it('starts a notification-backed monitor with the reference result shape', async () => {
    const tool = new MonitorTool(config);
    // @ts-expect-error createInvocation is protected by the declarative tool API.
    const invocation = tool.createInvocation({
      command: 'printf "ready\\n"',
      description: 'service readiness',
    });

    const customContext = Object.freeze({ tenant: 'alpha' });
    const result = await invocation.executeWithContext!({
      signal: new AbortController().signal,
      config,
      sessionId: 'session-1',
      callId: 'tool-1',
      agentId: 'agent-1',
      customContext,
    });

    expect(result.toolUseResult).toEqual({
      taskId: expect.stringMatching(/^b[a-z0-9]{8}$/),
      timeoutMs: MONITOR_DEFAULT_TIMEOUT_MS,
      persistent: false,
    });
    expect(executeSpy).toHaveBeenCalledWith(
      'printf "ready\\n"',
      expect.any(String),
      expect.any(Function),
      expect.any(AbortSignal),
      expect.objectContaining({
        taskKind: 'monitor',
        taskDescription: 'service readiness',
        ownerAgentId: 'agent-1',
        toolUseId: 'tool-1',
        customContext,
        persistOutputToFile: true,
        stdoutToFile: false,
      }),
    );
    expect(backgroundSpy).toHaveBeenCalledWith(
      4242,
      'session-1',
      'printf "ready\\n"',
      'model',
      expect.stringMatching(/^b[a-z0-9]{8}$/),
      true,
    );
    const onStdout = executionOptions['onStdout'] as (chunk: string) => void;
    onStdout('ready\n');
    await vi.advanceTimersByTimeAsync(200);
    const startResult = result.toolUseResult as {
      taskId: string;
      timeoutMs: number;
      persistent: boolean;
    };
    const queued = getCommandQueueSnapshot()[0];
    expect(queued?.prompt).toContain(
      `<task-id>${startResult.taskId}</task-id>`,
    );
    expect(getCommandQueueSnapshot()).toEqual([
      expect.objectContaining({
        commandMode: 'task-notification',
        priority: 'next',
        sessionId: 'session-1',
        targetAgentId: 'agent-1',
        customContext,
        prompt: expect.stringMatching(
          /<summary>Monitor event: "service readiness"<\/summary>\n<event>ready<\/event>/,
        ),
      }),
    ]);
  });

  it('keeps delivering events after the lifecycle handle resolves as backgrounded', async () => {
    const backgroundedResult = {
      rawOutput: Buffer.from(''),
      output: '',
      exitCode: null,
      signal: null,
      error: null,
      aborted: false,
      pid: 4242,
      executionMethod: 'child_process' as const,
      backgrounded: true,
      backgroundReason: 'model' as const,
    };
    executeSpy.mockImplementationOnce(
      async (_command, _cwd, _output, _signal, options) => {
        executionOptions = options as unknown as Record<string, unknown>;
        return {
          pid: 4242,
          result: Promise.resolve(backgroundedResult),
        };
      },
    );
    const tool = new MonitorTool(config);
    // @ts-expect-error createInvocation is protected by the declarative tool API.
    const invocation = tool.createInvocation({
      command: 'tail -F /tmp/app.log',
      description: 'log watch',
      persistent: true,
    });

    await invocation.execute(new AbortController().signal);
    // Let the backgrounded lifecycle result settle before events arrive.
    await Promise.resolve();
    await Promise.resolve();

    const onStdout = executionOptions['onStdout'] as (chunk: string) => void;
    onStdout('late event\n');
    await vi.advanceTimersByTimeAsync(200);

    expect(getCommandQueueSnapshot()).toEqual([
      expect.objectContaining({
        commandMode: 'task-notification',
        prompt: expect.stringContaining('<event>late event</event>'),
      }),
    ]);
  });

  it('keeps the finite-monitor deadline armed after backgrounding resolves the handle', async () => {
    executeSpy.mockImplementationOnce(async () => ({
      pid: 4242,
      result: Promise.resolve({
        rawOutput: Buffer.from(''),
        output: '',
        exitCode: null,
        signal: null,
        error: null,
        aborted: false,
        pid: 4242,
        executionMethod: 'child_process' as const,
        backgrounded: true,
      }),
    }));
    const tool = new MonitorTool(config);
    // @ts-expect-error createInvocation is protected by the declarative tool API.
    const invocation = tool.createInvocation({
      command: 'watch-command',
      description: 'watch test',
      timeout_ms: 1_000,
    });
    await invocation.execute(new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(killSpy).toHaveBeenCalledWith(4242);
    expect(getCommandQueueSnapshot().at(-1)?.prompt).toContain(
      '<event>[Monitor timed out — re-arm if needed.]</event>',
    );
  });

  it('closes the pipeline when the backgrounded process actually exits', async () => {
    const onExitSpy = vi.spyOn(ShellExecutionService, 'onExit');
    executeSpy.mockImplementationOnce(
      async (_command, _cwd, _output, _signal, options) => {
        executionOptions = options as unknown as Record<string, unknown>;
        return {
          pid: 4242,
          result: Promise.resolve({
            rawOutput: Buffer.from(''),
            output: '',
            exitCode: null,
            signal: null,
            error: null,
            aborted: false,
            pid: 4242,
            executionMethod: 'child_process' as const,
            backgrounded: true,
          }),
        };
      },
    );
    const tool = new MonitorTool(config);
    // @ts-expect-error createInvocation is protected by the declarative tool API.
    const invocation = tool.createInvocation({
      command: 'tail -F /tmp/app.log',
      description: 'log watch',
      persistent: true,
    });
    await invocation.execute(new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();

    expect(onExitSpy).toHaveBeenCalledWith(4242, expect.any(Function));
    const exitCallback = onExitSpy.mock.calls[0][1];
    const onStdout = executionOptions['onStdout'] as (chunk: string) => void;

    // Simulate the real process exiting: the final incomplete line flushes
    // and later chunks are dropped.
    onStdout('final line');
    exitCallback(0);
    expect(
      getCommandQueueSnapshot().at(-1)?.prompt,
    ).toContain('<event>final line</event>');

    _resetQueueForTest();
    onStdout('after exit\n');
    await vi.advanceTimersByTimeAsync(200);
    expect(getCommandQueueSnapshot()).toEqual([]);
  });

  it('emits the timeout event and stops a finite monitor', async () => {
    const tool = new MonitorTool(config);
    // @ts-expect-error createInvocation is protected by the declarative tool API.
    const invocation = tool.createInvocation({
      command: 'watch-command',
      description: 'watch test',
      timeout_ms: 1_000,
    });
    await invocation.execute(new AbortController().signal);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(killSpy).toHaveBeenCalledWith(4242);
    expect(getCommandQueueSnapshot().at(-1)?.prompt).toContain(
      '<event>[Monitor timed out — re-arm if needed.]</event>',
    );
  });

  it('clears the deadline when execution completed before cleanup was attached', async () => {
    executeSpy.mockResolvedValueOnce({
      pid: 4242,
      result: Promise.resolve({
        rawOutput: Buffer.from('done\n'),
        output: 'done\n',
        exitCode: 0,
        signal: null,
        error: null,
        aborted: false,
        pid: 4242,
        executionMethod: 'child_process',
      }),
    });
    const tool = new MonitorTool(config);
    // @ts-expect-error createInvocation is protected by the declarative tool API.
    const invocation = tool.createInvocation({
      command: 'printf "done\\n"',
      description: 'short monitor',
      timeout_ms: 1_000,
    });

    await invocation.execute(new AbortController().signal);
    await Promise.resolve();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(killSpy).not.toHaveBeenCalled();
    expect(getCommandQueueSnapshot()).toEqual([]);
  });

  it('disposes buffered events when shell execution throws during startup', async () => {
    executeSpy.mockImplementationOnce(
      async (_command, _cwd, _output, _signal, options) => {
        options.onStdout?.('stale event\n');
        throw new Error('shell startup failed');
      },
    );
    const tool = new MonitorTool(config);
    // @ts-expect-error createInvocation is protected by the declarative tool API.
    const invocation = tool.createInvocation({
      command: 'watch-command',
      description: 'failed monitor',
    });

    await expect(
      invocation.execute(new AbortController().signal),
    ).rejects.toThrow('shell startup failed');

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(getCommandQueueSnapshot()).toEqual([]);
  });

  it('runs persistent monitors without a deadline', async () => {
    const tool = new MonitorTool(config);
    // @ts-expect-error createInvocation is protected by the declarative tool API.
    const invocation = tool.createInvocation({
      command: 'watch-command',
      description: 'watch test',
      timeout_ms: 1_000,
      persistent: true,
    });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.toolUseResult).toEqual(
      expect.objectContaining({ timeoutMs: 0, persistent: true }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('forces the remote-worker deadline and disables persistence', () => {
    vi.stubEnv(ENV_REMOTE_WORKER, '1');

    expect(
      applyMonitorRemoteTimeoutCap({
        timeout_ms: 3_600_000,
        persistent: true,
      }),
    ).toEqual({
      timeout_ms: MONITOR_REMOTE_MAX_TIMEOUT_MS,
      persistent: false,
    });
  });

  it('applies the reference timeout and control-character validation', () => {
    const tool = new MonitorTool(config);
    const validate = (
      tool as unknown as {
        validateToolParamValues(params: MonitorToolParams): string | null;
      }
    ).validateToolParamValues.bind(tool);

    expect(
      validate({
        command: 'watch-command',
        description: '',
        timeout_ms: 3_600_001,
        persistent: true,
      }),
    ).toBeNull();
    expect(
      validate({
        command: 'watch-command',
        description: 'watch test',
        timeout_ms: 3_600_001,
      }),
    ).toBe('timeout_ms must be ≤ 3600000');
    expect(
      validate({
        command: 'printf "bad\rcommand"',
        description: 'watch test',
      }),
    ).toBe(
      'command contains control characters that would be hidden in the approval dialog',
    );
  });
});
