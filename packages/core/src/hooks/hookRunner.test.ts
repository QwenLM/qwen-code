/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HookRunner,
  __resetPowerShellCacheForTests,
  resolvePowerShellExecutable,
} from './hookRunner.js';
import * as shellUtils from '../utils/shell-utils.js';
import { HookAggregator } from './hookAggregator.js';
import {
  createHookOutput,
  HookEventName,
  HookType,
  HooksConfigSource,
  MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH,
} from './types.js';
import type { PreToolUseHookOutput } from './types.js';
import type {
  HookConfig,
  HookInput,
  UserPromptExpansionInput,
  UserPromptSubmitInput,
} from './types.js';

// Hoisted mock
const mockSpawn = vi.hoisted(() => vi.fn());
const mockExecFile = vi.hoisted(() => vi.fn());
const mockDebugLogger = vi.hoisted(() => ({
  isEnabled: () => false,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    spawn: mockSpawn,
    execFile: mockExecFile,
  };
});

vi.mock('../utils/debugLogger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/debugLogger.js')>()),
  createDebugLogger: () => mockDebugLogger,
}));

describe('HookRunner', () => {
  let hookRunner: HookRunner;

  beforeEach(() => {
    hookRunner = new HookRunner();
    vi.clearAllMocks();
    // Default probe result: only `powershell` installed. Probe-priority
    // tests override this spy; cache reset makes the mock take effect.
    vi.spyOn(shellUtils, 'resolveCommandPath').mockImplementation(((
      name: string,
    ) => {
      if (name === 'powershell')
        return {
          path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        };
      return { path: null };
    }) as never);
    __resetPowerShellCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const createMockInput = (overrides: Partial<HookInput> = {}): HookInput => ({
    session_id: 'test-session',
    transcript_path: '/test/transcript',
    cwd: '/test',
    hook_event_name: 'test-event',
    timestamp: '2024-01-01T00:00:00Z',
    ...overrides,
  });

  const createMockProcess = (
    exitCode: number = 0,
    stdout: string = '',
    stderr: string = '',
  ) => {
    const mockProcess = {
      stdin: {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      },
      stdout: {
        on: vi.fn((event: string, callback: (data: Buffer) => void) => {
          if (event === 'data' && stdout) {
            setTimeout(() => callback(Buffer.from(stdout)), 0);
          }
        }),
      },
      stderr: {
        on: vi.fn((event: string, callback: (data: Buffer) => void) => {
          if (event === 'data' && stderr) {
            setTimeout(() => callback(Buffer.from(stderr)), 0);
          }
        }),
      },
      on: vi.fn((event: string, callback: (code: number) => void) => {
        if (event === 'close') {
          setTimeout(() => callback(exitCode), 0);
        }
      }),
      kill: vi.fn(),
      unref: vi.fn(),
    };
    return mockProcess;
  };

  // Forces the cmd->powershell fallback; needed for asserts on the
  // post-`-Command` arg position (bash hosts have no third spawn arg).
  // Caller must wrap in `try { ... } finally { spy.mockRestore(); }`.
  const mockCmdShellConfig = () =>
    vi.spyOn(shellUtils, 'getShellConfiguration').mockReturnValue({
      executable: 'cmd.exe',
      argsPrefix: ['/d', '/s', '/c'],
      shell: 'cmd',
    });

  const createControllableMockProcess = (pid = 4321) => {
    type Listener = (...args: unknown[]) => void;
    const listeners = new Map<string, Listener[]>();
    const addListener = (event: string, callback: Listener) => {
      const eventListeners = listeners.get(event) ?? [];
      eventListeners.push(callback);
      listeners.set(event, eventListeners);
    };
    const createStream = () => {
      const dataListeners: Listener[] = [];
      return {
        on: vi.fn((event: string, callback: Listener) => {
          if (event === 'data') {
            dataListeners.push(callback);
          }
        }),
        destroy: vi.fn(),
        emitData: (data: Buffer) => {
          for (const listener of dataListeners) {
            listener(data);
          }
        },
      };
    };
    const stdin = createStream();
    const stdout = createStream();
    const stderr = createStream();
    const mockProcess = {
      pid,
      stdin: {
        ...stdin,
        write: vi.fn(),
        end: vi.fn(),
      },
      stdout,
      stderr,
      killed: true,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      unref: vi.fn(),
      on: vi.fn((event: string, callback: Listener) => {
        addListener(event, callback);
        return mockProcess;
      }),
      emit: (event: string, ...args: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) {
          listener(...args);
        }
      },
    };
    return mockProcess;
  };

  describe('executeHook', () => {
    it('should return error when hook command is missing', async () => {
      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: '',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('Command hook missing command');
    });

    it('should execute hook and return success for exit code 0', async () => {
      const mockProcess = createMockProcess(0, 'hello');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo hello',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(result.stdout).toBe('hello');
      expect(mockSpawn).toHaveBeenCalled();
    });

    it('strips Qwen-internal daemon secrets from the hook child env (#6601)', async () => {
      const originalServerToken = process.env['QWEN_SERVER_TOKEN'];
      const originalDaemonToken = process.env['QWEN_DAEMON_TOKEN'];
      process.env['QWEN_SERVER_TOKEN'] = 'serve-secret';
      process.env['QWEN_DAEMON_TOKEN'] = 'daemon-secret';
      try {
        const mockProcess = createMockProcess(0, 'hello');
        mockSpawn.mockImplementation(() => mockProcess);

        const hookConfig: HookConfig = {
          type: HookType.Command,
          command: 'echo hello',
          source: HooksConfigSource.Project,
        };

        await hookRunner.executeHook(
          hookConfig,
          HookEventName.PreToolUse,
          createMockInput(),
        );

        const spawnOptions = mockSpawn.mock.calls[0][2];
        // A user-authored hook command is a child process launched on the
        // agent's behalf; internal daemon secrets must not leak into it.
        expect(spawnOptions.env['QWEN_SERVER_TOKEN']).toBeUndefined();
        expect(spawnOptions.env['QWEN_DAEMON_TOKEN']).toBeUndefined();
        // Benign inherited env and the hook's own vars are still present.
        expect(spawnOptions.env['PATH']).toBeDefined();
        expect(spawnOptions.env['QWEN_PROJECT_DIR']).toBe('/test');
      } finally {
        if (originalServerToken === undefined) {
          delete process.env['QWEN_SERVER_TOKEN'];
        } else {
          process.env['QWEN_SERVER_TOKEN'] = originalServerToken;
        }
        if (originalDaemonToken === undefined) {
          delete process.env['QWEN_DAEMON_TOKEN'];
        } else {
          process.env['QWEN_DAEMON_TOKEN'] = originalDaemonToken;
        }
      }
    });

    it('should return failure for non-zero exit code', async () => {
      const mockProcess = createMockProcess(1, '', 'error');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'exit 1',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('should parse JSON output from stdout', async () => {
      const output = JSON.stringify({
        decision: 'allow',
        systemMessage: 'test',
      });
      const mockProcess = createMockProcess(0, output);
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo json',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(result.output?.decision).toBe('allow');
      expect(result.output?.systemMessage).toBe('test');
    });

    it('should convert plain text to allow output on success', async () => {
      const mockProcess = createMockProcess(0, 'some text output');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo text',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(result.output?.decision).toBe('allow');
      expect(result.output?.systemMessage).toBe('some text output');
    });

    it('should convert plain text to deny output on exit code 2', async () => {
      const mockProcess = createMockProcess(2, '', 'error message');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo error && exit 2',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.output?.decision).toBe('deny');
      expect(result.output?.reason).toBe('error message');
    });

    it('should ignore stdout on exit code 2 and use stderr only', async () => {
      // Exit code 2 should ignore stdout and use stderr as the error message
      const mockProcess = createMockProcess(
        2,
        'stdout should be ignored',
        'stderr error message',
      );
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo stdout && echo stderr >&2 && exit 2',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.output?.decision).toBe('deny');
      expect(result.output?.reason).toBe('stderr error message');
    });

    it('should parse JSON from stderr on exit code 2 to preserve additionalContext', async () => {
      // Exit code 2 with JSON in stderr should parse structured output
      // to preserve hookSpecificOutput.additionalContext
      const jsonOutput = JSON.stringify({
        decision: 'deny',
        reason: 'blocked by policy',
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: '[Hook] Tool execution blocked with context',
        },
      });
      const mockProcess = createMockProcess(2, 'stdout ignored', jsonOutput);
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'exit 2',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.output?.decision).toBe('deny');
      expect(result.output?.reason).toBe('blocked by policy');
      expect(result.output?.hookSpecificOutput).toEqual({
        hookEventName: 'PostToolUse',
        additionalContext: '[Hook] Tool execution blocked with context',
      });
    });

    it('blocks when an exit code 2 hook fell back to its stdout payload', async () => {
      const mockProcess = createMockProcess(
        2,
        JSON.stringify({ decision: 'deny', reason: 'blocked by policy' }),
        '',
      );
      mockSpawn.mockImplementation(() => mockProcess);

      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'gate',
          source: HooksConfigSource.Project,
        },
        HookEventName.PreToolUse,
        createMockInput(),
      );

      expect(result.outcome).toBe('blocking');
      expect(result.output?.decision).toBe('deny');
      expect(result.output?.reason).toBe('blocked by policy');
    });

    it('blocks when an exit code 2 hook wrote no output at all', async () => {
      mockSpawn.mockImplementation(() => createMockProcess(2, '', ''));

      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'gate',
          source: HooksConfigSource.Project,
        },
        HookEventName.PreToolUse,
        createMockInput(),
      );

      expect(result.outcome).toBe('blocking');
      expect(result.output).toBeUndefined();

      const aggregated = new HookAggregator().aggregateResults(
        [result],
        HookEventName.PreToolUse,
      );
      const hookOutput = createHookOutput(
        HookEventName.PreToolUse,
        aggregated.finalOutput ?? {},
      ) as PreToolUseHookOutput;
      expect(hookOutput.isDenied()).toBe(true);
      expect(hookOutput.reason).toContain('blocking error');
    });

    it.each([
      ['an empty object', '{}'],
      ['an explicit allow', '{"decision":"allow"}'],
      ['an explicit ask', '{"decision":"ask"}'],
      ['only a system message', '{"systemMessage":"report"}'],
      [
        'a nested permission allow',
        '{"hookSpecificOutput":{"permissionDecision":"allow"}}',
      ],
    ])(
      'denies when exit code 2 carries %s on stdout',
      async (_label, payload) => {
        mockSpawn.mockImplementation(() => createMockProcess(2, payload, ''));
        const result = await hookRunner.executeHook(
          {
            type: HookType.Command,
            command: 'gate',
            source: HooksConfigSource.Project,
          },
          HookEventName.PreToolUse,
          createMockInput(),
        );
        expect(result.outcome).toBe('blocking');

        const aggregated = new HookAggregator().aggregateResults(
          [result],
          HookEventName.PreToolUse,
        );
        const output = createHookOutput(
          HookEventName.PreToolUse,
          aggregated.finalOutput ?? {},
        ) as PreToolUseHookOutput;
        expect(output.isDenied()).toBe(true);
        // A blocking hook's stdout is never promoted as model context.
        expect(output.getAdditionalContext()).toBeUndefined();
      },
    );

    it('should fall back to plain text when stderr JSON is invalid on exit code 2', async () => {
      const mockProcess = createMockProcess(2, '', 'plain blocking error');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'exit 2',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.output?.decision).toBe('deny');
      expect(result.output?.reason).toBe('plain blocking error');
      expect(result.output?.hookSpecificOutput).toBeUndefined();
    });

    it('should not parse JSON on exit code 2', async () => {
      // Exit code 2 should ignore JSON in stdout
      const mockProcess = createMockProcess(
        2,
        '{"decision":"allow"}',
        'blocking error',
      );
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo json && exit 2',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      // Should NOT parse JSON, should use stderr as reason
      expect(result.success).toBe(false);
      expect(result.output?.decision).toBe('deny');
      expect(result.output?.reason).toBe('blocking error');
    });

    it('should handle exit code 1 as non-blocking warning', async () => {
      const mockProcess = createMockProcess(1, '', 'warning');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'exit 1',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.output?.decision).toBe('allow');
      expect(result.output?.systemMessage).toBe('Warning: warning');
    });

    it('should include duration in result', async () => {
      const mockProcess = createMockProcess(0, 'test');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo test',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should handle process error', async () => {
      const mockProcess = {
        stdin: { on: vi.fn(), write: vi.fn(), end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, callback: (error: Error) => void) => {
          if (event === 'error') {
            callback(new Error('spawn error'));
          }
        }),
        kill: vi.fn(),
      };
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo test',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should throw error for prompt hook without config', async () => {
      // HookRunner without config cannot execute prompt hooks
      const runnerWithoutConfig = new HookRunner();

      const hookConfig: HookConfig = {
        type: HookType.Prompt,
        prompt: 'Test prompt: $ARGUMENTS',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await runnerWithoutConfig.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Prompt hook requires Config');
    });
  });

  describe('execution outcome', () => {
    const commandHook: HookConfig = {
      type: HookType.Command,
      command: 'run-hook',
      source: HooksConfigSource.Project,
    };

    it('reports success for exit code 0', async () => {
      mockSpawn.mockImplementation(() => createMockProcess(0, 'ok'));

      const result = await hookRunner.executeHook(
        commandHook,
        HookEventName.PreToolUse,
        createMockInput(),
      );

      expect(result.outcome).toBe('success');
    });

    it('reports a non-blocking error for exit code 1', async () => {
      mockSpawn.mockImplementation(() => createMockProcess(1, '', 'oops'));

      const result = await hookRunner.executeHook(
        commandHook,
        HookEventName.PreToolUse,
        createMockInput(),
      );

      expect(result.outcome).toBe('non_blocking_error');
    });

    it('reports blocking for exit code 2', async () => {
      mockSpawn.mockImplementation(() => createMockProcess(2, '', 'no'));

      const result = await hookRunner.executeHook(
        commandHook,
        HookEventName.PreToolUse,
        createMockInput(),
      );

      expect(result.outcome).toBe('blocking');
    });

    it('reports a missing command as a non-blocking error with its exit code', async () => {
      mockSpawn.mockImplementation(() =>
        createMockProcess(
          127,
          '',
          'bash: qwen-no-such-cmd-2f9a: command not found',
        ),
      );

      const result = await hookRunner.executeHook(
        { ...commandHook, command: 'qwen-no-such-cmd-2f9a' },
        HookEventName.PreToolUse,
        createMockInput(),
      );

      expect(result.exitCode).toBe(127);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.output?.systemMessage).toMatch(/^Warning: /);
    });

    it('reports a spawn error as a non-blocking error', async () => {
      const mockProcess = createControllableMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const resultPromise = hookRunner.executeHook(
        commandHook,
        HookEventName.PreToolUse,
        createMockInput(),
      );
      mockProcess.emit('error', new Error('spawn failed'));
      const result = await resultPromise;

      expect(result.outcome).toBe('non_blocking_error');
    });

    it('reports a signal it did not send as a non-blocking error', async () => {
      const mockProcess = createControllableMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const resultPromise = hookRunner.executeHook(
        commandHook,
        HookEventName.PreToolUse,
        createMockInput(),
      );
      mockProcess.emit('close', null);
      const result = await resultPromise;

      expect(result.error?.message).toBe('Hook killed by signal');
      expect(result.outcome).toBe('non_blocking_error');
    });
  });

  describe('executeHooksParallel', () => {
    it('ends an async hook whose hand-off throws instead of rejecting the batch', async () => {
      vi.spyOn(
        hookRunner.getAsyncRegistry(),
        'canAcceptMore',
      ).mockImplementation(() => {
        throw new Error('registry unavailable');
      });
      const hookConfigs: HookConfig[] = [
        {
          type: HookType.Command,
          command: 'echo background',
          async: true,
          source: HooksConfigSource.Project,
        },
      ];
      const onHookStart = vi.fn();
      const onHookEnd = vi.fn();

      const results = await hookRunner.executeHooksParallel(
        hookConfigs,
        HookEventName.PreToolUse,
        createMockInput(),
        onHookStart,
        onHookEnd,
      );

      expect(onHookStart).toHaveBeenCalledTimes(1);
      expect(onHookEnd).toHaveBeenCalledTimes(1);
      expect(onHookEnd).toHaveBeenCalledWith(
        hookConfigs[0],
        expect.objectContaining({ success: false }),
        0,
      );
      expect(results).toHaveLength(1);
      expect(results[0].error?.message).toContain('registry unavailable');
    });

    it('should execute multiple hooks in parallel', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfigs: HookConfig[] = [
        {
          type: HookType.Command,
          command: 'echo hook1',
          source: HooksConfigSource.Project,
        },
        {
          type: HookType.Command,
          command: 'echo hook2',
          source: HooksConfigSource.Project,
        },
      ];
      const input = createMockInput();

      const results = await hookRunner.executeHooksParallel(
        hookConfigs,
        HookEventName.PreToolUse,
        input,
      );

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });

    it('should call onHookStart and onHookEnd callbacks', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfigs: HookConfig[] = [
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ];
      const input = createMockInput();
      const onHookStart = vi.fn();
      const onHookEnd = vi.fn();

      await hookRunner.executeHooksParallel(
        hookConfigs,
        HookEventName.PreToolUse,
        input,
        onHookStart,
        onHookEnd,
      );

      expect(onHookStart).toHaveBeenCalledTimes(1);
      expect(onHookEnd).toHaveBeenCalledTimes(1);
      expect(onHookEnd).toHaveBeenCalledWith(
        hookConfigs[0],
        expect.objectContaining({ success: true }),
        0,
      );
    });

    it('should chain UserPromptExpansion additional context into the next hook input', async () => {
      const firstProcess = createMockProcess(
        0,
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptExpansion',
            additionalContext: 'Hook context',
          },
        }),
      );
      const secondProcess = createMockProcess(0, 'result');
      mockSpawn
        .mockImplementationOnce(() => firstProcess)
        .mockImplementationOnce(() => secondProcess);

      const hookConfigs: HookConfig[] = [
        {
          type: HookType.Command,
          command: 'echo first',
          source: HooksConfigSource.Project,
        },
        {
          type: HookType.Command,
          command: 'echo second',
          source: HooksConfigSource.Project,
        },
      ];
      const input: UserPromptExpansionInput = {
        ...createMockInput({
          hook_event_name: HookEventName.UserPromptExpansion,
        }),
        command_name: 'custom',
        command_args: 'with args',
        prompt: 'Base prompt',
      };

      await hookRunner.executeHooksSequential(
        hookConfigs,
        HookEventName.UserPromptExpansion,
        input,
      );

      const secondInputJson = secondProcess.stdin.write.mock.calls[0]?.[0];
      expect(typeof secondInputJson).toBe('string');
      const secondInput = JSON.parse(secondInputJson as string) as {
        prompt?: string;
      };
      expect(secondInput.prompt).toBe('Base prompt\n\nHook context');
    });

    it('should preserve submitted prompt while chaining UserPromptSubmit context', async () => {
      const firstProcess = createMockProcess(
        0,
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: '<xml><item>raw</item></xml>',
            submitted_prompt: 'forged prompt',
          },
          submitted_prompt: 'another forged prompt',
        }),
      );
      const secondProcess = createMockProcess(0, 'result');
      mockSpawn
        .mockImplementationOnce(() => firstProcess)
        .mockImplementationOnce(() => secondProcess);

      const hookConfigs: HookConfig[] = [
        {
          type: HookType.Command,
          command: 'echo first',
          source: HooksConfigSource.Project,
        },
        {
          type: HookType.Command,
          command: 'echo second',
          source: HooksConfigSource.Project,
        },
      ];
      const input: UserPromptSubmitInput = {
        ...createMockInput({
          hook_event_name: HookEventName.UserPromptSubmit,
        }),
        prompt: 'Base prompt',
        submitted_prompt: 'Submitted prompt',
      };

      await hookRunner.executeHooksSequential(
        hookConfigs,
        HookEventName.UserPromptSubmit,
        input,
      );

      const secondInputJson = secondProcess.stdin.write.mock.calls[0]?.[0];
      expect(typeof secondInputJson).toBe('string');
      const secondInput = JSON.parse(secondInputJson as string) as {
        prompt?: string;
        submitted_prompt?: string;
      };
      expect(secondInput.prompt).toBe(
        'Base prompt\n\n<xml><item>raw</item></xml>',
      );
      expect(secondInput.submitted_prompt).toBe('Submitted prompt');
    });

    it('should chain plain-text UserPromptSubmit stdout into the next hook input', async () => {
      const firstProcess = createMockProcess(0, 'Plain hook context\n');
      const secondProcess = createMockProcess(0, 'result');
      mockSpawn
        .mockImplementationOnce(() => firstProcess)
        .mockImplementationOnce(() => secondProcess);

      const hookConfigs: HookConfig[] = [
        {
          type: HookType.Command,
          command: 'echo first',
          source: HooksConfigSource.Project,
        },
        {
          type: HookType.Command,
          command: 'echo second',
          source: HooksConfigSource.Project,
        },
      ];
      const input: UserPromptSubmitInput = {
        ...createMockInput({
          hook_event_name: HookEventName.UserPromptSubmit,
        }),
        prompt: 'Base prompt',
      };

      await hookRunner.executeHooksSequential(
        hookConfigs,
        HookEventName.UserPromptSubmit,
        input,
      );

      const secondInputJson = secondProcess.stdin.write.mock.calls[0]?.[0];
      expect(typeof secondInputJson).toBe('string');
      const secondInput = JSON.parse(secondInputJson as string) as {
        prompt?: string;
      };
      expect(secondInput.prompt).toBe('Base prompt\n\nPlain hook context');
    });

    it('should not append empty UserPromptSubmit additional context', async () => {
      const firstProcess = createMockProcess(
        0,
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: '',
          },
        }),
      );
      const secondProcess = createMockProcess(0, 'result');
      mockSpawn
        .mockImplementationOnce(() => firstProcess)
        .mockImplementationOnce(() => secondProcess);

      const hookConfigs: HookConfig[] = [
        {
          type: HookType.Command,
          command: 'echo first',
          source: HooksConfigSource.Project,
        },
        {
          type: HookType.Command,
          command: 'echo second',
          source: HooksConfigSource.Project,
        },
      ];
      const input: UserPromptSubmitInput = {
        ...createMockInput({
          hook_event_name: HookEventName.UserPromptSubmit,
        }),
        prompt: 'Base prompt',
      };

      await hookRunner.executeHooksSequential(
        hookConfigs,
        HookEventName.UserPromptSubmit,
        input,
      );

      const secondInputJson = secondProcess.stdin.write.mock.calls[0]?.[0];
      expect(typeof secondInputJson).toBe('string');
      const secondInput = JSON.parse(secondInputJson as string) as {
        prompt?: string;
      };
      expect(secondInput.prompt).toBe('Base prompt');
    });

    it('should truncate UserPromptExpansion context before sanitizing it for chaining', async () => {
      const unsafeContext =
        '<tag>' +
        'x'.repeat(MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH);
      const firstProcess = createMockProcess(
        0,
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptExpansion',
            additionalContext: unsafeContext,
          },
        }),
      );
      const secondProcess = createMockProcess(0, 'result');
      mockSpawn
        .mockImplementationOnce(() => firstProcess)
        .mockImplementationOnce(() => secondProcess);

      const hookConfigs: HookConfig[] = [
        {
          type: HookType.Command,
          command: 'echo first',
          source: HooksConfigSource.Project,
        },
        {
          type: HookType.Command,
          command: 'echo second',
          source: HooksConfigSource.Project,
        },
      ];
      const input: UserPromptExpansionInput = {
        ...createMockInput({
          hook_event_name: HookEventName.UserPromptExpansion,
        }),
        command_name: 'custom',
        command_args: 'with args',
        prompt: 'Base prompt',
      };

      await hookRunner.executeHooksSequential(
        hookConfigs,
        HookEventName.UserPromptExpansion,
        input,
      );

      const secondInputJson = secondProcess.stdin.write.mock.calls[0]?.[0];
      expect(typeof secondInputJson).toBe('string');
      const secondInput = JSON.parse(secondInputJson as string) as {
        prompt?: string;
      };
      const chainedContext = secondInput.prompt?.replace('Base prompt\n\n', '');
      expect(chainedContext?.startsWith('&lt;tag&gt;')).toBe(true);
      expect(chainedContext).toContain('x'.repeat(9_989));
      expect(chainedContext).not.toContain('<tag>');
      expect(chainedContext).toHaveLength(
        MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH,
      );
    });
  });

  describe('executeHooksSequential', () => {
    it('should execute hooks sequentially', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfigs: HookConfig[] = [
        {
          type: HookType.Command,
          command: 'echo first',
          source: HooksConfigSource.Project,
        },
        {
          type: HookType.Command,
          command: 'echo second',
          source: HooksConfigSource.Project,
        },
      ];
      const input = createMockInput();

      const results = await hookRunner.executeHooksSequential(
        hookConfigs,
        HookEventName.PreToolUse,
        input,
      );

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });

    it('should call onHookStart and onHookEnd callbacks', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfigs: HookConfig[] = [
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ];
      const input = createMockInput();
      const onHookStart = vi.fn();
      const onHookEnd = vi.fn();

      await hookRunner.executeHooksSequential(
        hookConfigs,
        HookEventName.PreToolUse,
        input,
        onHookStart,
        onHookEnd,
      );

      expect(onHookStart).toHaveBeenCalledTimes(1);
      expect(onHookEnd).toHaveBeenCalledTimes(1);
      expect(onHookEnd).toHaveBeenCalledWith(
        hookConfigs[0],
        expect.objectContaining({ success: true }),
        0,
      );
    });
  });

  describe('output truncation', () => {
    it('should truncate stdout when exceeding MAX_OUTPUT_LENGTH', async () => {
      // Create a process that outputs more than 1MB of data
      const largeOutput = 'x'.repeat(2 * 1024 * 1024); // 2MB
      const mockProcess = createMockProcess(0, largeOutput);
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo large',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      // stdout should be truncated to MAX_OUTPUT_LENGTH (1MB)
      expect(result.stdout?.length).toBeLessThanOrEqual(1024 * 1024);
    });

    it('should truncate stderr when exceeding MAX_OUTPUT_LENGTH', async () => {
      const largeOutput = 'x'.repeat(2 * 1024 * 1024); // 2MB
      const mockProcess = createMockProcess(0, '', largeOutput);
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo large',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      // stderr should be truncated to MAX_OUTPUT_LENGTH (1MB)
      expect(result.stderr?.length).toBeLessThanOrEqual(1024 * 1024);
    });

    it('should handle partial truncation gracefully', async () => {
      // Output exactly at the limit
      const exactOutput = 'x'.repeat(1024 * 1024); // 1MB exactly
      const mockProcess = createMockProcess(0, exactOutput);
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo exact',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.stdout?.length).toBe(1024 * 1024);
    });
  });

  describe('convertPlainTextToHookOutput', () => {
    it('should convert plain text to allow output on success', async () => {
      const mockProcess = createMockProcess(0, 'plain text response');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo text',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(result.output?.decision).toBe('allow');
      expect(result.output?.systemMessage).toBe('plain text response');
    });

    it.each([
      HookEventName.SessionStart,
      HookEventName.UserPromptSubmit,
      HookEventName.UserPromptExpansion,
    ])(
      'should route plain-text stdout to additionalContext on %s',
      async (eventName) => {
        const mockProcess = createMockProcess(0, 'context from hook\n');
        mockSpawn.mockImplementation(() => mockProcess);

        const result = await hookRunner.executeHook(
          {
            type: HookType.Command,
            command: 'echo context',
            source: HooksConfigSource.Project,
          },
          eventName,
          createMockInput({ hook_event_name: eventName }),
        );

        expect(result.success).toBe(true);
        expect(result.output?.decision).toBe('allow');
        expect(result.output?.systemMessage).toBeUndefined();
        expect(result.output?.hookSpecificOutput).toEqual({
          hookEventName: eventName,
          additionalContext: 'context from hook',
        });
      },
    );

    it.each([
      HookEventName.PreToolUse,
      HookEventName.Stop,
      HookEventName.Notification,
    ])(
      'should keep plain-text stdout as a system message on %s',
      async (eventName) => {
        const mockProcess = createMockProcess(0, 'plain text response');
        mockSpawn.mockImplementation(() => mockProcess);

        const result = await hookRunner.executeHook(
          {
            type: HookType.Command,
            command: 'echo text',
            source: HooksConfigSource.Project,
          },
          eventName,
          createMockInput({ hook_event_name: eventName }),
        );

        expect(result.output?.systemMessage).toBe('plain text response');
        expect(result.output?.hookSpecificOutput).toBeUndefined();
      },
    );

    it.each(['42', 'true', 'null', '[1, 2]'])(
      'should treat bare JSON value %s as plain text on SessionStart',
      async (text) => {
        mockSpawn.mockImplementation(() => createMockProcess(0, text));

        const result = await hookRunner.executeHook(
          {
            type: HookType.Command,
            command: 'echo value',
            source: HooksConfigSource.Project,
          },
          HookEventName.SessionStart,
          createMockInput({ hook_event_name: HookEventName.SessionStart }),
        );

        expect(result.output?.hookSpecificOutput).toEqual({
          hookEventName: HookEventName.SessionStart,
          additionalContext: text,
        });
      },
    );

    it('should keep a bare JSON value as a system message on PreToolUse', async () => {
      mockSpawn.mockImplementation(() => createMockProcess(0, '42'));

      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'echo 42',
          source: HooksConfigSource.Project,
        },
        HookEventName.PreToolUse,
        createMockInput(),
      );

      expect(result.output?.systemMessage).toBe('42');
      expect(result.output?.hookSpecificOutput).toBeUndefined();
    });

    it('should still block on exit code 2 when stderr is a bare JSON value', async () => {
      mockSpawn.mockImplementation(() => createMockProcess(2, '', '1'));

      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'echo 1 >&2; exit 2',
          source: HooksConfigSource.Project,
        },
        HookEventName.PreToolUse,
        createMockInput(),
      );

      expect(result.output?.decision).toBe('deny');
      expect(result.output?.reason).toBe('1');
    });

    it('should not promote output shaped like a JSON object that fails to parse', async () => {
      const malformed = '{"decision": "deny",}';
      mockSpawn.mockImplementation(() => createMockProcess(0, malformed));

      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'echo malformed',
          source: HooksConfigSource.Project,
        },
        HookEventName.UserPromptSubmit,
        createMockInput({ hook_event_name: HookEventName.UserPromptSubmit }),
      );

      expect(result.output).toBeUndefined();
      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.error?.message).toBe('Hook output is not valid JSON');
    });

    it('should treat truncated JSON on stdout as an error, not context', async () => {
      mockSpawn.mockImplementation(() => createMockProcess(0, '{"decision": '));

      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'echo truncated',
          source: HooksConfigSource.Project,
        },
        HookEventName.UserPromptSubmit,
        createMockInput({ hook_event_name: HookEventName.UserPromptSubmit }),
      );

      expect(result.output).toBeUndefined();
      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.error?.message).toBe('Hook output is not valid JSON');
      expect(result.exitCode).toBe(0);
    });

    it('should still block on exit code 2 when stderr starts like broken JSON', async () => {
      mockSpawn.mockImplementation(() =>
        createMockProcess(2, '', '{"reason": '),
      );

      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'exit 2',
          source: HooksConfigSource.Project,
        },
        HookEventName.PreToolUse,
        createMockInput(),
      );

      expect(result.outcome).toBe('blocking');
      expect(result.output?.decision).toBe('deny');
      expect(result.output?.reason).toBe('{"reason":');
    });

    it('should strip terminal escapes from promoted context and keep newlines', async () => {
      mockSpawn.mockImplementation(() =>
        createMockProcess(0, '\u001b[31mred\u001b[0m context\nline two\n'),
      );

      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'npm test --color=always',
          source: HooksConfigSource.Project,
        },
        HookEventName.SessionStart,
        createMockInput({ hook_event_name: HookEventName.SessionStart }),
      );

      expect(result.output?.hookSpecificOutput).toEqual({
        hookEventName: HookEventName.SessionStart,
        additionalContext: 'red context\nline two',
      });
    });

    it('should not promote the stderr fallback into SessionStart context', async () => {
      const mockProcess = createMockProcess(0, '', 'diagnostic noise');
      mockSpawn.mockImplementation(() => mockProcess);

      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'echo noise >&2',
          source: HooksConfigSource.Project,
        },
        HookEventName.SessionStart,
        createMockInput({ hook_event_name: HookEventName.SessionStart }),
      );

      expect(result.output?.systemMessage).toBe('diagnostic noise');
      expect(result.output?.hookSpecificOutput).toBeUndefined();
    });

    it('should keep plain-text stdout of a failed SessionStart hook as a warning', async () => {
      const mockProcess = createMockProcess(1, 'partial output');
      mockSpawn.mockImplementation(() => mockProcess);

      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'echo partial && exit 1',
          source: HooksConfigSource.Project,
        },
        HookEventName.SessionStart,
        createMockInput({ hook_event_name: HookEventName.SessionStart }),
      );

      expect(result.success).toBe(false);
      expect(result.output?.systemMessage).toBe('Warning: partial output');
      expect(result.output?.hookSpecificOutput).toBeUndefined();
    });

    it('should treat non-blocking non-zero exit codes as non-blocking warnings', async () => {
      const mockProcess = createMockProcess(3, '', 'error message');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'exit 3',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.output?.decision).toBe('allow');
      expect(result.output?.systemMessage).toBe('Warning: error message');
    });

    it('should use stderr when stdout is empty on success', async () => {
      const mockProcess = createMockProcess(0, '', 'stderr output');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo test',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.output?.systemMessage).toBe('stderr output');
    });

    it('should handle empty output gracefully', async () => {
      const mockProcess = createMockProcess(0, '', '');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo test',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.output).toBeUndefined();
    });

    it('should parse nested JSON strings', async () => {
      const nestedJson = JSON.stringify(JSON.stringify({ decision: 'allow' }));
      const mockProcess = createMockProcess(0, nestedJson);
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo json',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput();

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.output?.decision).toBe('allow');
    });
  });

  describe('process tree cancellation', () => {
    const parentExitSurvivingEvents = [
      HookEventName.MessageDisplay,
      HookEventName.StopFailure,
      HookEventName.SessionDelete,
    ] as const;

    const hookConfig: HookConfig = {
      type: HookType.Command,
      command: 'long-running-command',
      source: HooksConfigSource.Project,
      timeout: 10_000,
    };

    const createNoSuchProcessError = () =>
      Object.assign(new Error('no such process'), { code: 'ESRCH' });

    it.each(parentExitSurvivingEvents)(
      'uses a detached parent-independent supervisor for synchronous and async %s hooks',
      async (eventName) => {
        mockSpawn.mockImplementation(() => createMockProcess());

        await hookRunner.executeHook(
          hookConfig,
          eventName,
          createMockInput({ hook_event_name: eventName }),
        );
        await hookRunner.executeHook(
          { ...hookConfig, async: true },
          eventName,
          createMockInput({ hook_event_name: eventName }),
        );

        expect(mockSpawn).toHaveBeenCalledTimes(2);
        for (const call of mockSpawn.mock.calls) {
          expect(call[0]).toBe(process.execPath);
          expect(call[1]).toContain('--eval');
          expect(call[2].stdio).toEqual(['ignore', 'ignore', 'ignore', 'pipe']);
          expect(call[2].detached).toBe(true);
        }
        for (const result of mockSpawn.mock.results) {
          expect(result.value.unref).toHaveBeenCalledOnce();
        }
      },
    );

    it('removes staged input when the supervisor spawn throws', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'qwen-hook-spawn-error-'));
      const originalTmpDir = process.env['TMPDIR'];
      process.env['TMPDIR'] = tempDir;
      mockSpawn.mockImplementation(() => {
        throw new Error('spawn failed');
      });

      try {
        const result = await hookRunner.executeHook(
          hookConfig,
          HookEventName.SessionDelete,
          createMockInput({ hook_event_name: HookEventName.SessionDelete }),
        );

        expect(result.error?.message).toBe('spawn failed');
        expect(await readdir(tempDir)).toEqual([]);
      } finally {
        if (originalTmpDir === undefined) {
          delete process.env['TMPDIR'];
        } else {
          process.env['TMPDIR'] = originalTmpDir;
        }
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('keeps output capture for process-scoped async hooks', async () => {
      mockSpawn.mockReturnValue(createMockProcess());

      await hookRunner.executeHook(
        { ...hookConfig, async: true },
        HookEventName.PreToolUse,
        createMockInput(),
      );

      expect(mockSpawn.mock.calls[0][2].stdio).toEqual([
        'pipe',
        'pipe',
        'pipe',
      ]);
    });

    it.each(parentExitSurvivingEvents)(
      'still cancels a parent-exit-surviving %s hook',
      async (eventName) => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
        const mockProcess = createControllableMockProcess();
        mockSpawn.mockReturnValue(mockProcess);
        const killSpy = vi
          .spyOn(process, 'kill')
          .mockImplementation((target, signal) => {
            if (target === -mockProcess.pid && signal === 0) {
              throw createNoSuchProcessError();
            }
            return true;
          });
        const controller = new AbortController();

        const resultPromise = hookRunner.executeHook(
          hookConfig,
          eventName,
          createMockInput({ hook_event_name: eventName }),
          controller.signal,
        );
        controller.abort();
        mockProcess.emit('close', null);
        const result = await resultPromise;

        expect(result.error?.message).toBe(
          'Hook execution cancelled (aborted)',
        );
        expect(killSpy).toHaveBeenCalledWith(-mockProcess.pid, 'SIGTERM');
      },
    );

    const startWindowsSurvivingHook = (
      eventName: (typeof parentExitSurvivingEvents)[number],
      survivingPid: number,
    ) => {
      const statusListeners: Array<(chunk: Buffer) => void> = [];
      const mockProcess = createControllableMockProcess();
      // The supervisor reports the pid of the shell it spawned over fd 3.
      (mockProcess as unknown as { stdio: unknown[] }).stdio = [
        null,
        null,
        null,
        {
          on: vi.fn((event: string, callback: (chunk: Buffer) => void) => {
            if (event === 'data') {
              statusListeners.push(callback);
            }
          }),
          unref: vi.fn(),
        },
      ];
      mockSpawn.mockReturnValue(mockProcess);
      const controller = new AbortController();
      const resultPromise = hookRunner.executeHook(
        hookConfig,
        eventName,
        createMockInput({ hook_event_name: eventName }),
        controller.signal,
      );
      for (const listener of statusListeners) {
        listener(Buffer.from(`pid:${survivingPid}\n`));
      }
      return { mockProcess, controller, resultPromise };
    };

    it.each(parentExitSurvivingEvents)(
      'tree-kills the surviving %s hook on Windows instead of leaving it behind',
      async (eventName) => {
        // terminateSurvivingHookProcessGroup used to return immediately on
        // win32, so nothing ever reaped the hook's cmd.exe tree: the
        // supervisor is detached and may already be gone, which puts the shell
        // outside the supervisor's own tree kill. See #11303.
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
        mockExecFile.mockImplementation(
          (
            _file: string,
            _args: string[],
            _options: object,
            callback: (error: Error | null) => void,
          ) => {
            callback(null);
          },
        );
        const survivingPid = 9911;
        const { mockProcess, controller, resultPromise } =
          startWindowsSurvivingHook(eventName, survivingPid);

        controller.abort();
        mockProcess.emit('close', null);
        await resultPromise;

        expect(mockExecFile).toHaveBeenCalledWith(
          expect.stringMatching(/\\System32\\taskkill\.exe$/i),
          ['/f', '/t', '/pid', String(survivingPid)],
          expect.objectContaining({ windowsHide: true }),
          expect.any(Function),
        );
        // A successful taskkill must not be followed by a pid-level SIGKILL:
        // the pid is dead and immediately recyclable, so the fallback would
        // land on an unrelated process (the #6067 collateral kill).
        expect(killSpy).not.toHaveBeenCalledWith(survivingPid, 'SIGKILL');
        // Nor may this branch fall through to the POSIX group path: that
        // signals -pid, and signalFallback then signals the positive pid
        // with no liveness re-probe at all.
        expect(killSpy).not.toHaveBeenCalledWith(
          -survivingPid,
          expect.anything(),
        );
      },
    );

    it('does not taskkill a surviving Windows hook whose pid already exited', async () => {
      // Windows has no process group to signal, so a taskkill against a pid
      // that has already exited could land on a recycled pid — the #6067
      // collateral-kill failure mode. The liveness probe is the guard.
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const survivingPid = 9912;
      vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
        if (target === survivingPid && signal === 0) {
          throw createNoSuchProcessError();
        }
        return true;
      });
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null) => void,
        ) => {
          callback(null);
        },
      );
      const { mockProcess, controller, resultPromise } =
        startWindowsSurvivingHook(HookEventName.StopFailure, survivingPid);

      controller.abort();
      mockProcess.emit('close', null);
      await resultPromise;

      expect(mockExecFile).not.toHaveBeenCalledWith(
        expect.anything(),
        ['/f', '/t', '/pid', String(survivingPid)],
        expect.anything(),
        expect.anything(),
      );
      // The proven-gone skip stays silent; only an unknown probe failure
      // warns.
      expect(mockDebugLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining(`surviving hook ${survivingPid}`),
      );
    });

    it('does not taskkill an exited Windows hook supervisor', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      vi.spyOn(process, 'kill').mockReturnValue(true);
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null) => void,
        ) => {
          callback(null);
        },
      );
      const { mockProcess, controller, resultPromise } =
        startWindowsSurvivingHook(HookEventName.StopFailure, 9913);
      (
        mockProcess as unknown as {
          exitCode: number | null;
        }
      ).exitCode = 0;

      controller.abort();
      mockProcess.emit('close', 0);
      await resultPromise;

      expect(mockExecFile).not.toHaveBeenCalledWith(
        expect.anything(),
        ['/f', '/t', '/pid', String(mockProcess.pid)],
        expect.anything(),
        expect.anything(),
      );
      // The surviving hook pid is still reaped even though the supervisor has
      // already exited: gating the reap on `survivingHookPid && child.exitCode
      // === null` would skip this, leaving the hook's cmd.exe tree running.
      expect(mockExecFile).toHaveBeenCalledWith(
        expect.stringMatching(/\\System32\\taskkill\.exe$/i),
        ['/f', '/t', '/pid', '9913'],
        expect.anything(),
        expect.any(Function),
      );
    });

    it('falls back to a direct SIGKILL when taskkill of a surviving Windows hook fails', async () => {
      // taskkillProcessTree resolves false when execFile reports an error
      // (ERROR_ACCESS_DENIED from an elevated or AV-intercepted System32) or
      // when it exceeds its own 2s timeout. The caller has to honour that
      // boolean, or the hook's cmd.exe tree keeps running with nothing left
      // to reap it.
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const survivingPid = 9913;
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null) => void,
        ) => {
          callback(new Error('ERROR_ACCESS_DENIED'));
        },
      );
      const { mockProcess, controller, resultPromise } =
        startWindowsSurvivingHook(HookEventName.StopFailure, survivingPid);

      controller.abort();
      mockProcess.emit('close', null);
      await resultPromise;

      // The liveness probe (signal 0) passed, so taskkill was attempted.
      expect(mockExecFile).toHaveBeenCalledWith(
        expect.stringMatching(/\\System32\\taskkill\.exe$/i),
        ['/f', '/t', '/pid', String(survivingPid)],
        expect.anything(),
        expect.any(Function),
      );
      expect(killSpy).toHaveBeenCalledWith(survivingPid, 'SIGKILL');
    });

    it('does not directly SIGKILL a surviving Windows hook pid that taskkill reported dead', async () => {
      // taskkillProcessTree also resolves false when the pid was already dead,
      // not just when it failed to kill. A pid-based fallback against a dead
      // pid can land on a recycled pid (the #6067 collateral-kill mode). The
      // liveness re-probe after taskkill must skip the fallback then.
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const survivingPid = 9914;
      let probes = 0;
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((target, signal) => {
          if (target === survivingPid && signal === 0) {
            probes += 1;
            if (probes === 1) {
              // The initial liveness probe passes: taskkill is attempted.
              return true;
            }
            // The re-probe after taskkill reports the pid as dead/recycled.
            throw createNoSuchProcessError();
          }
          return true;
        });
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null) => void,
        ) => {
          callback(new Error('ERROR_ACCESS_DENIED'));
        },
      );
      const { mockProcess, controller, resultPromise } =
        startWindowsSurvivingHook(HookEventName.StopFailure, survivingPid);

      controller.abort();
      mockProcess.emit('close', null);
      await resultPromise;

      expect(mockExecFile).toHaveBeenCalledWith(
        expect.stringMatching(/\\System32\\taskkill\.exe$/i),
        ['/f', '/t', '/pid', String(survivingPid)],
        expect.anything(),
        expect.any(Function),
      );
      expect(killSpy).not.toHaveBeenCalledWith(survivingPid, 'SIGKILL');
    });

    it('warns and skips the SIGKILL fallback when the liveness re-probe fails unexpectedly', async () => {
      // The re-probe shares the first probe's tri-state classification: an
      // unexpected errno establishes nothing about the pid, so the fallback
      // must be skipped (a pid-based kill against unknown state risks the
      // #6067 recycled-pid collateral kill) — but the skip must warn, or a
      // host-level probe failure leaves the hook's cmd.exe tree running with
      // no trace at all.
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const survivingPid = 9919;
      let probes = 0;
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((target, signal) => {
          if (target === survivingPid && signal === 0) {
            probes += 1;
            if (probes === 1) {
              // The initial liveness probe passes: taskkill is attempted.
              return true;
            }
            // The re-probe after taskkill fails unexpectedly: neither gone
            // (ESRCH) nor alive-but-denied (EPERM/EACCES).
            throw Object.assign(new Error('EINVAL: invalid argument, kill'), {
              code: 'EINVAL',
            });
          }
          return true;
        });
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null) => void,
        ) => {
          callback(new Error('ERROR_ACCESS_DENIED'));
        },
      );
      const { mockProcess, controller, resultPromise } =
        startWindowsSurvivingHook(HookEventName.StopFailure, survivingPid);

      controller.abort();
      mockProcess.emit('close', null);
      await resultPromise;

      expect(probes).toBe(2);
      expect(killSpy).not.toHaveBeenCalledWith(survivingPid, 'SIGKILL');
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`surviving hook ${survivingPid}`),
      );
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('EINVAL'),
      );
    });

    it('still reaps a surviving Windows hook whose liveness probe is denied', async () => {
      // An elevated or protected hook makes process.kill(pid, 0) fail with
      // EPERM on Windows, not ESRCH: the process exists but cannot be opened.
      // That answer is alive, not dead — treating it as dead would leave the
      // hook's cmd.exe tree running (#11303).
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const survivingPid = 9915;
      vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
        if (target === survivingPid && signal === 0) {
          throw Object.assign(new Error('operation not permitted'), {
            code: 'EPERM',
          });
        }
        return true;
      });
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null) => void,
        ) => {
          callback(null);
        },
      );
      const { mockProcess, controller, resultPromise } =
        startWindowsSurvivingHook(HookEventName.StopFailure, survivingPid);

      controller.abort();
      mockProcess.emit('close', null);
      await resultPromise;

      expect(mockExecFile).toHaveBeenCalledWith(
        expect.stringMatching(/\\System32\\taskkill\.exe$/i),
        ['/f', '/t', '/pid', String(survivingPid)],
        expect.anything(),
        expect.any(Function),
      );
    });

    it('does not taskkill a surviving Windows hook whose liveness probe fails unexpectedly', async () => {
      // A probe error that is neither "gone" (ESRCH) nor "exists but denied"
      // (EPERM/EACCES) establishes nothing about the pid. The reap still skips
      // it — taskkilling a pid of unknown state risks the #6067 recycled-pid
      // collateral kill — but the skip must warn, or a host-level probe
      // failure leaves the hook's cmd.exe tree running (#11303) with no
      // trace.
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const survivingPid = 9916;
      vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
        if (target === survivingPid && signal === 0) {
          throw Object.assign(new Error('EINVAL: invalid argument, kill'), {
            code: 'EINVAL',
          });
        }
        return true;
      });
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null) => void,
        ) => {
          callback(null);
        },
      );
      const { mockProcess, controller, resultPromise } =
        startWindowsSurvivingHook(HookEventName.StopFailure, survivingPid);

      controller.abort();
      mockProcess.emit('close', null);
      await resultPromise;

      expect(mockExecFile).not.toHaveBeenCalledWith(
        expect.anything(),
        ['/f', '/t', '/pid', String(survivingPid)],
        expect.anything(),
        expect.anything(),
      );
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`surviving hook ${survivingPid}`),
      );
      // The errno is the datum that tells EMFILE (our handle budget) apart
      // from ENOMEM (the host) or libuv's UV_UNKNOWN; the warn must carry it.
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('EINVAL'),
      );
    });

    it('warns when the SIGKILL fallback is refused for a surviving Windows hook', async () => {
      // An elevated or AV-protected hook refuses OpenProcess(PROCESS_TERMINATE)
      // the same way it refused the probe: EPERM. The re-probe just reported
      // the pid alive, so swallowing the refusal would leave a #11303-class
      // leak without a single log line.
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const survivingPid = 9917;
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((target, signal) => {
          if (target === survivingPid && signal === 'SIGKILL') {
            throw Object.assign(new Error('operation not permitted'), {
              code: 'EPERM',
            });
          }
          return true;
        });
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null) => void,
        ) => {
          callback(new Error('ERROR_ACCESS_DENIED'));
        },
      );
      const { mockProcess, controller, resultPromise } =
        startWindowsSurvivingHook(HookEventName.StopFailure, survivingPid);

      controller.abort();
      mockProcess.emit('close', null);
      await resultPromise;

      expect(killSpy).toHaveBeenCalledWith(survivingPid, 'SIGKILL');
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `SIGKILL fallback failed for surviving hook ${survivingPid}`,
        ),
      );
    });

    it('stays silent when the SIGKILL fallback finds the surviving Windows hook already gone', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const survivingPid = 9918;
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((target, signal) => {
          if (target === survivingPid && signal === 'SIGKILL') {
            throw createNoSuchProcessError();
          }
          return true;
        });
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null) => void,
        ) => {
          callback(new Error('ERROR_ACCESS_DENIED'));
        },
      );
      const { mockProcess, controller, resultPromise } =
        startWindowsSurvivingHook(HookEventName.StopFailure, survivingPid);

      controller.abort();
      mockProcess.emit('close', null);
      await resultPromise;

      expect(killSpy).toHaveBeenCalledWith(survivingPid, 'SIGKILL');
      expect(mockDebugLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('SIGKILL fallback failed'),
      );
    });

    it('owns a POSIX process group without signalling it on normal completion', async () => {
      const mockProcess = createMockProcess(0, 'done');
      mockSpawn.mockReturnValue(mockProcess);
      const killSpy = vi.spyOn(process, 'kill');

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        createMockInput(),
      );

      expect(result.success).toBe(true);
      expect(mockSpawn.mock.calls[0][2].detached).toBe(
        process.platform !== 'win32',
      );
      expect(killSpy).not.toHaveBeenCalled();
    });

    it('force-kills an active POSIX hook group when the parent exits', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      const exitListenersBefore = process.listeners('exit');
      const sighupListenersBefore = process.listeners('SIGHUP');
      const sigintListenersBefore = process.listeners('SIGINT');
      const sigquitListenersBefore = process.listeners('SIGQUIT');
      const sigtermListenersBefore = process.listeners('SIGTERM');
      const mockProcess = createControllableMockProcess();
      mockSpawn.mockReturnValue(mockProcess);
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

      const resultPromise = hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        createMockInput(),
      );
      const exitListener = process
        .listeners('exit')
        .find((listener) => !exitListenersBefore.includes(listener));

      expect(exitListener).toBeDefined();
      exitListener?.(0);
      expect(killSpy).toHaveBeenCalledWith(-mockProcess.pid, 'SIGKILL');

      mockProcess.emit('close', null);
      await resultPromise;
      expect(process.listeners('exit')).toEqual(exitListenersBefore);
      expect(process.listeners('SIGHUP')).toEqual(sighupListenersBefore);
      expect(process.listeners('SIGINT')).toEqual(sigintListenersBefore);
      expect(process.listeners('SIGQUIT')).toEqual(sigquitListenersBefore);
      expect(process.listeners('SIGTERM')).toEqual(sigtermListenersBefore);
    });

    it('kills active hooks while leaving parent signals to an application handler', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      const exitListenersBefore = process.listeners('exit');
      const listenersBefore = process.listeners('SIGTERM');
      const mockProcess = createControllableMockProcess();
      mockSpawn.mockReturnValue(mockProcess);
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
      const applicationHandler = vi.fn();
      process.on('SIGTERM', applicationHandler);

      try {
        const resultPromise = hookRunner.executeHook(
          hookConfig,
          HookEventName.PreToolUse,
          createMockInput(),
        );
        const hookSignalHandler = process
          .listeners('SIGTERM')
          .find(
            (listener) =>
              listener !== applicationHandler &&
              !listenersBefore.includes(listener),
          );
        const exitListener = process
          .listeners('exit')
          .find((listener) => !exitListenersBefore.includes(listener));

        expect(hookSignalHandler).toBeDefined();
        expect(exitListener).toBeDefined();
        hookSignalHandler?.('SIGTERM');
        expect(killSpy).toHaveBeenCalledWith(-mockProcess.pid, 'SIGKILL');
        expect(killSpy).not.toHaveBeenCalledWith(process.pid, 'SIGTERM');
        expect(process.listeners('exit')).toContain(exitListener);

        mockProcess.emit('close', 0);
        await resultPromise;
      } finally {
        process.removeListener('SIGTERM', applicationHandler);
      }
    });

    it.each(['SIGHUP', 'SIGINT', 'SIGQUIT'] as const)(
      'force-kills active hooks and re-raises %s when unhandled',
      async (signal) => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
        const listenersBefore = process.listeners(signal);
        const mockProcess = createControllableMockProcess();
        mockSpawn.mockReturnValue(mockProcess);
        const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

        const resultPromise = hookRunner.executeHook(
          hookConfig,
          HookEventName.PreToolUse,
          createMockInput(),
        );
        const hookSignalHandler = process
          .listeners(signal)
          .find((listener) => !listenersBefore.includes(listener));

        expect(hookSignalHandler).toBeDefined();
        hookSignalHandler?.(signal);
        expect(killSpy).toHaveBeenCalledWith(-mockProcess.pid, 'SIGKILL');
        expect(killSpy).toHaveBeenCalledWith(process.pid, signal);

        mockProcess.emit('close', null);
        await resultPromise;
      },
    );

    it('keeps parent cleanup registered while another hook is active', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      const exitListenersBefore = process.listeners('exit');
      const firstProcess = createControllableMockProcess(4321);
      const secondProcess = createControllableMockProcess(4322);
      mockSpawn
        .mockReturnValueOnce(firstProcess)
        .mockReturnValueOnce(secondProcess);
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

      const firstResult = hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        createMockInput(),
      );
      const secondResult = hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        createMockInput(),
      );
      firstProcess.emit('close', 0);
      await firstResult;
      const exitListener = process
        .listeners('exit')
        .find((listener) => !exitListenersBefore.includes(listener));

      expect(exitListener).toBeDefined();
      exitListener?.(0);
      expect(killSpy).toHaveBeenCalledWith(-secondProcess.pid, 'SIGKILL');

      secondProcess.emit('close', 0);
      await secondResult;
    });

    it('escalates to SIGKILL for the process group even after the root closes', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      vi.useFakeTimers();
      const mockProcess = createControllableMockProcess();
      mockSpawn.mockReturnValue(mockProcess);
      let groupAlive = true;
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((target, signal) => {
          if (target === -mockProcess.pid && signal === 0) {
            if (groupAlive) {
              return true;
            }
            throw createNoSuchProcessError();
          }
          if (target === -mockProcess.pid && signal === 'SIGKILL') {
            groupAlive = false;
          }
          return true;
        });
      const controller = new AbortController();

      const resultPromise = hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        createMockInput(),
        controller.signal,
      );
      controller.abort();
      mockProcess.emit('close', null);
      let resolved = false;
      void resultPromise.then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(1999);
      expect(resolved).toBe(false);
      expect(killSpy.mock.calls).not.toContainEqual([
        -mockProcess.pid,
        'SIGKILL',
      ]);
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result.error?.message).toBe('Hook execution cancelled (aborted)');
      expect(result.outcome).toBe('cancelled');
      expect(killSpy.mock.calls).toContainEqual([-mockProcess.pid, 'SIGTERM']);
      expect(killSpy.mock.calls).toContainEqual([-mockProcess.pid, 'SIGKILL']);
    });

    it('does not send SIGKILL when the process group exits after SIGTERM', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      const mockProcess = createControllableMockProcess();
      mockSpawn.mockReturnValue(mockProcess);
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((target, signal) => {
          if (target === -mockProcess.pid && signal === 0) {
            throw createNoSuchProcessError();
          }
          return true;
        });
      const controller = new AbortController();

      const resultPromise = hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        createMockInput(),
        controller.signal,
      );
      controller.abort();
      mockProcess.emit('close', null);
      const result = await resultPromise;

      expect(result.error?.message).toBe('Hook execution cancelled (aborted)');
      expect(killSpy.mock.calls).toContainEqual([-mockProcess.pid, 'SIGTERM']);
      expect(killSpy.mock.calls).not.toContainEqual([
        -mockProcess.pid,
        'SIGKILL',
      ]);
    });

    it('returns the timeout result after process group cleanup', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      vi.useFakeTimers();
      const mockProcess = createControllableMockProcess();
      mockSpawn.mockReturnValue(mockProcess);
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((target, signal) => {
          if (target === -mockProcess.pid && signal === 0) {
            throw createNoSuchProcessError();
          }
          return true;
        });

      const resultPromise = hookRunner.executeHook(
        { ...hookConfig, timeout: 0.1 },
        HookEventName.PreToolUse,
        createMockInput(),
      );
      await vi.advanceTimersByTimeAsync(100);
      mockProcess.emit('close', null);
      const result = await resultPromise;

      expect(result.error?.message).toBe('Hook timed out after 0.1s');
      expect(result.outcome).toBe('timeout');
      expect(killSpy.mock.calls).toContainEqual([-mockProcess.pid, 'SIGTERM']);
    });

    it('reads timeout in seconds with a 60 second default', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      vi.useFakeTimers();
      const mockProcess = createControllableMockProcess();
      mockSpawn.mockReturnValue(mockProcess);
      vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
        if (target === -mockProcess.pid && signal === 0) {
          throw createNoSuchProcessError();
        }
        return true;
      });
      const configWithoutTimeout: HookConfig = {
        type: HookType.Command,
        command: 'long-running-command',
        source: HooksConfigSource.Project,
      };

      let settled = false;
      const resultPromise = hookRunner
        .executeHook(
          configWithoutTimeout,
          HookEventName.PreToolUse,
          createMockInput(),
        )
        .finally(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      mockProcess.emit('close', null);
      const result = await resultPromise;

      expect(result.error?.message).toBe('Hook timed out after 60s');
    });

    it.each([
      [undefined, '60000'],
      [10, '10000'],
    ])(
      'hands the SessionDelete supervisor a millisecond deadline for timeout %s',
      async (timeout, expectedArg) => {
        mockSpawn.mockImplementation(() => createMockProcess());

        await hookRunner.executeHook(
          {
            type: HookType.Command,
            command: 'cleanup-session',
            source: HooksConfigSource.Project,
            ...(timeout === undefined ? {} : { timeout }),
          },
          HookEventName.SessionDelete,
          createMockInput({ hook_event_name: HookEventName.SessionDelete }),
        );

        const args = mockSpawn.mock.calls[0]?.[1] as string[];
        // --eval, supervisor source, input path, then the deadline.
        expect(args[args.indexOf('--eval') + 3]).toBe(expectedArg);
      },
    );

    it('registers async hooks with the resolved millisecond timeout', async () => {
      mockSpawn.mockImplementation(() => createMockProcess());
      const register = vi.spyOn(hookRunner['asyncRegistry'], 'register');

      await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'long-running-command',
          source: HooksConfigSource.Project,
          async: true,
          timeout: 30,
        },
        HookEventName.PostToolUse,
        createMockInput(),
      );

      expect(register).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it('reads a timeout of 1000 or more as legacy milliseconds', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      vi.useFakeTimers();
      const mockProcess = createControllableMockProcess();
      mockSpawn.mockReturnValue(mockProcess);
      vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
        if (target === -mockProcess.pid && signal === 0) {
          throw createNoSuchProcessError();
        }
        return true;
      });

      let settled = false;
      const resultPromise = hookRunner
        .executeHook(
          { ...hookConfig, timeout: 2000 },
          HookEventName.PreToolUse,
          createMockInput(),
        )
        .finally(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(1999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      mockProcess.emit('close', null);
      const result = await resultPromise;

      expect(result.error?.message).toBe('Hook timed out after 2s');
    });

    it('shares one termination when timeout and abort race, with abort taking precedence', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      vi.useFakeTimers();
      const mockProcess = createControllableMockProcess();
      mockSpawn.mockReturnValue(mockProcess);
      let groupAlive = true;
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((target, signal) => {
          if (target === -mockProcess.pid && signal === 0) {
            if (groupAlive) {
              return true;
            }
            throw createNoSuchProcessError();
          }
          if (target === -mockProcess.pid && signal === 'SIGKILL') {
            groupAlive = false;
          }
          return true;
        });
      const controller = new AbortController();

      const resultPromise = hookRunner.executeHook(
        { ...hookConfig, timeout: 0.1 },
        HookEventName.PreToolUse,
        createMockInput(),
        controller.signal,
      );
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      await vi.advanceTimersByTimeAsync(2000);
      mockProcess.emit('close', null);
      const result = await resultPromise;

      expect(result.error?.message).toBe('Hook execution cancelled (aborted)');
      expect(
        killSpy.mock.calls.filter(
          ([target, signal]) =>
            target === -mockProcess.pid && signal === 'SIGTERM',
        ),
      ).toHaveLength(1);
      expect(
        killSpy.mock.calls.filter(
          ([target, signal]) =>
            target === -mockProcess.pid && signal === 'SIGKILL',
        ),
      ).toHaveLength(1);
    });

    it('tree-kills through the absolute taskkill path on Windows', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      let taskkillCallback: ((error: Error | null) => void) | undefined;
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null) => void,
        ) => {
          taskkillCallback = callback;
        },
      );
      const mockProcess = createControllableMockProcess();
      mockSpawn.mockReturnValue(mockProcess);
      const controller = new AbortController();

      const resultPromise = hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        createMockInput(),
        controller.signal,
      );
      controller.abort();
      mockProcess.emit('close', null);
      let resolved = false;
      void resultPromise.then(() => {
        resolved = true;
      });
      await Promise.resolve();

      expect(resolved).toBe(false);
      taskkillCallback?.(null);
      const result = await resultPromise;

      expect(result.error?.message).toBe('Hook execution cancelled (aborted)');
      expect(mockSpawn.mock.calls[0][2].detached).toBe(false);
      expect(mockExecFile).toHaveBeenCalledWith(
        expect.stringMatching(/\\System32\\taskkill\.exe$/i),
        ['/f', '/t', '/pid', mockProcess.pid.toString()],
        {
          windowsHide: true,
          timeout: 2000,
        },
        expect.any(Function),
      );
      expect(mockProcess.kill).not.toHaveBeenCalled();
    });

    it('falls back to killing the direct child when taskkill fails', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null) => void,
        ) => {
          callback(new Error('taskkill failed'));
        },
      );
      const mockProcess = createControllableMockProcess();
      mockSpawn.mockReturnValue(mockProcess);
      const controller = new AbortController();

      const resultPromise = hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        createMockInput(),
        controller.signal,
      );
      controller.abort();
      mockProcess.emit('close', null);
      await resultPromise;

      expect(mockProcess.kill).toHaveBeenCalledOnce();
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('falls back to the direct child when POSIX group signals fail', async () => {
      vi.useFakeTimers();
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      const mockProcess = createControllableMockProcess();
      mockSpawn.mockReturnValue(mockProcess);
      const permissionError = Object.assign(new Error('not permitted'), {
        code: 'EPERM',
      });
      vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
        if (target === -mockProcess.pid && signal === 0) {
          return true;
        }
        if (target === -mockProcess.pid) {
          throw permissionError;
        }
        return true;
      });
      const controller = new AbortController();

      const resultPromise = hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        createMockInput(),
        controller.signal,
      );
      controller.abort();
      mockProcess.emit('close', null);
      await vi.advanceTimersByTimeAsync(2000);
      await resultPromise;

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('force-kills the direct child when cancellation has no pid', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      const mockProcess = {
        ...createControllableMockProcess(),
        pid: undefined,
      };
      mockSpawn.mockReturnValue(mockProcess);
      const controller = new AbortController();

      const resultPromise = hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        createMockInput(),
        controller.signal,
      );
      controller.abort();
      mockProcess.emit('close', null);
      await resultPromise;

      expect(mockProcess.kill).toHaveBeenCalledOnce();
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('falls back to the direct child when taskkill throws synchronously', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      mockExecFile.mockImplementation(() => {
        throw new Error('EMFILE');
      });
      const mockProcess = createControllableMockProcess();
      mockSpawn.mockReturnValue(mockProcess);
      const controller = new AbortController();

      const resultPromise = hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        createMockInput(),
        controller.signal,
      );
      controller.abort();
      mockProcess.emit('close', null);
      await resultPromise;

      expect(mockProcess.kill).toHaveBeenCalledOnce();
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('waits for close after a cancellation-time child error', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      vi.useFakeTimers();
      const mockProcess = createControllableMockProcess();
      mockSpawn.mockReturnValue(mockProcess);
      vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
        if (target === -mockProcess.pid && signal === 0) {
          throw createNoSuchProcessError();
        }
        return true;
      });
      const controller = new AbortController();

      const resultPromise = hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        createMockInput(),
        controller.signal,
      );
      controller.abort();
      mockProcess.emit('error', new Error('signal delivery failed'));
      mockProcess.stdout.emitData(Buffer.from('final stdout'));
      let resolved = false;
      void resultPromise.then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(resolved).toBe(false);
      mockProcess.emit('close', null);
      const result = await resultPromise;

      expect(result.stdout).toBe('final stdout');
    });

    it('drains final output before resolving cancellation', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      const mockProcess = createControllableMockProcess();
      mockSpawn.mockReturnValue(mockProcess);
      vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
        if (target === -mockProcess.pid && signal === 0) {
          throw createNoSuchProcessError();
        }
        return true;
      });
      const controller = new AbortController();

      const resultPromise = hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        createMockInput(),
        controller.signal,
      );
      controller.abort();
      mockProcess.stdout.emitData(Buffer.from('final stdout'));
      mockProcess.stderr.emitData(Buffer.from('final stderr'));
      let resolved = false;
      void resultPromise.then(() => {
        resolved = true;
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(resolved).toBe(false);
      mockProcess.emit('close', null);
      const result = await resultPromise;

      expect(result.stdout).toBe('final stdout');
      expect(result.stderr).toBe('final stderr');
      expect(mockProcess.stdout.destroy).not.toHaveBeenCalled();
      expect(mockProcess.stderr.destroy).not.toHaveBeenCalled();
    });

    it('bounds the output drain wait when close never arrives', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      vi.useFakeTimers();
      const mockProcess = createControllableMockProcess();
      mockSpawn.mockReturnValue(mockProcess);
      vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
        if (target === -mockProcess.pid && signal === 0) {
          throw createNoSuchProcessError();
        }
        return true;
      });
      const controller = new AbortController();

      const resultPromise = hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        createMockInput(),
        controller.signal,
      );
      controller.abort();
      let resolved = false;
      void resultPromise.then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result.error?.message).toBe('Hook execution cancelled (aborted)');
      expect(mockProcess.stdin.destroy).toHaveBeenCalledOnce();
      expect(mockProcess.stdout.destroy).toHaveBeenCalledOnce();
      expect(mockProcess.stderr.destroy).toHaveBeenCalledOnce();
    });

    it('removes cancellation handling after a spawn error', async () => {
      const mockProcess = createControllableMockProcess();
      mockSpawn.mockReturnValue(mockProcess);
      const killSpy = vi.spyOn(process, 'kill');
      const controller = new AbortController();

      const resultPromise = hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        createMockInput(),
        controller.signal,
      );
      mockProcess.emit('error', new Error('spawn failed'));
      const result = await resultPromise;
      controller.abort();

      expect(result.error?.message).toBe('spawn failed');
      expect(killSpy).not.toHaveBeenCalled();
    });
  });

  describe('shell configuration', () => {
    it('should use global shell configuration when hookConfig.shell is not specified', async () => {
      const mockProcess = createMockProcess(0, '{"continue": true}');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo test',
        source: HooksConfigSource.Project,
        // No shell specified - should use global config
      };
      const input = createMockInput();

      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);

      // Verify spawn was called with global shell config
      expect(mockSpawn).toHaveBeenCalled();
      const spawnArgs = mockSpawn.mock.calls[0];
      // Global config uses bash or cmd depending on platform
      expect(spawnArgs[2].shell).toBe(false);
    });

    it('should use bash shell when hookConfig.shell is bash', async () => {
      const mockProcess = createMockProcess(0, '{"continue": true}');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo test',
        source: HooksConfigSource.Project,
        shell: 'bash',
      };
      const input = createMockInput();

      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);

      // Verify spawn was called with bash configuration
      expect(mockSpawn).toHaveBeenCalled();
      const spawnArgs = mockSpawn.mock.calls[0];
      // Should use bash executable
      expect(spawnArgs[0]).toMatch(/bash/);
      expect(spawnArgs[1]).toContain('-c');
      expect(spawnArgs[2].shell).toBe(false);
    });

    it('should use powershell when hookConfig.shell is powershell', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const mockProcess = createMockProcess(0, '{"continue": true}');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'Write-Output test',
        source: HooksConfigSource.Project,
        shell: 'powershell',
      };
      const input = createMockInput();

      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);

      // Verify spawn was called with powershell configuration
      expect(mockSpawn).toHaveBeenCalled();
      const spawnArgs = mockSpawn.mock.calls[0];
      // Should use powershell executable with -NoProfile
      expect(spawnArgs[0]).toBe(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      );
      expect(spawnArgs[1]).toEqual([
        '-NoProfile',
        '-Command',
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = $null; Write-Output test\n\n$__s = $?\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE) -and $LASTEXITCODE -ne 0 -and -not $__s) { exit $LASTEXITCODE }",
      ]);
      expect(spawnArgs[2].shell).toBe(false);
    });

    it('omits the encoding statement for a powershell hook off Windows', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      mockSpawn.mockImplementation(() => createMockProcess(0));
      await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'Write-Output test',
          source: HooksConfigSource.Project,
          shell: 'powershell',
        },
        HookEventName.PreToolUse,
        createMockInput(),
      );
      const command = mockSpawn.mock.calls[0][1][2];
      expect(command).not.toContain('[Console]::OutputEncoding');
      expect(command).toContain(
        "Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = $null; Write-Output test",
      );
    });

    it('uses powershell when the global shell is cmd', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const spy = mockCmdShellConfig();
      try {
        mockSpawn.mockImplementation(() => createMockProcess(0));
        await hookRunner.executeHook(
          {
            type: HookType.Command,
            command: 'echo test',
            source: HooksConfigSource.Project,
          },
          HookEventName.PreToolUse,
          createMockInput(),
        );
        const spawnArgs = mockSpawn.mock.calls[0];
        expect(spawnArgs[0]).toBe(
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        );
        expect(spawnArgs[1]).toEqual([
          '-NoProfile',
          '-Command',
          "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = $null; echo test\n\n$__s = $?\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE) -and $LASTEXITCODE -ne 0 -and -not $__s) { exit $LASTEXITCODE }",
        ]);
        // #8649's literal repro shape: shell prefix + quoted path with a
        // space + argument. cmd.exe keeps the inner quotes, PowerShell does
        // not, so the command must reach powershell untouched.
        await hookRunner.executeHook(
          {
            type: HookType.Command,
            command: 'bash "C:/Program Files/app/script.sh" arg',
            source: HooksConfigSource.Project,
          },
          HookEventName.PreToolUse,
          createMockInput(),
        );
        expect(mockSpawn.mock.calls[1][0]).toBe(
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        );
        expect(mockSpawn.mock.calls[1][1]).toEqual([
          '-NoProfile',
          '-Command',
          `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = $null; bash "C:/Program Files/app/script.sh" arg\n\n$__s = $?\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE) -and $LASTEXITCODE -ne 0 -and -not $__s) { exit $LASTEXITCODE }`,
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    it('passes the env-var form through for an explicit powershell shell', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      mockSpawn.mockImplementation(() => createMockProcess(0));
      await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: '$env:CLAUDE_PROJECT_DIR/scripts/validate.cmd',
          source: HooksConfigSource.Project,
          shell: 'powershell',
        },
        HookEventName.PreToolUse,
        createMockInput({ cwd: '/test/project' }),
      );
      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[0]).toBe(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      );
      expect(spawnArgs[1][2]).toBe(
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = $null; $env:CLAUDE_PROJECT_DIR/scripts/validate.cmd\n\n$__s = $?\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE) -and $LASTEXITCODE -ne 0 -and -not $__s) { exit $LASTEXITCODE }",
      );
    });

    it('uses the same powershell config for explicit shell and cmd fallback', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const spy = mockCmdShellConfig();
      try {
        mockSpawn.mockImplementation(() => createMockProcess(0));
        await hookRunner.executeHook(
          {
            type: HookType.Command,
            command: 'Write-Output explicit',
            source: HooksConfigSource.Project,
            shell: 'powershell',
          },
          HookEventName.PreToolUse,
          createMockInput(),
        );
        const explicitArgs = mockSpawn.mock.calls[0][1];
        await hookRunner.executeHook(
          {
            type: HookType.Command,
            command: 'Write-Output fallback',
            source: HooksConfigSource.Project,
          },
          HookEventName.PreToolUse,
          createMockInput(),
        );
        const fallbackArgs = mockSpawn.mock.calls[1][1];
        // Same executable and argsPrefix; only the trailing command differs.
        expect(mockSpawn.mock.calls[1][0]).toBe(mockSpawn.mock.calls[0][0]);
        expect(fallbackArgs.slice(0, 2)).toEqual(explicitArgs.slice(0, 2));
        expect(explicitArgs[2]).toBe(
          "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = $null; Write-Output explicit\n\n$__s = $?\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE) -and $LASTEXITCODE -ne 0 -and -not $__s) { exit $LASTEXITCODE }",
        );
        expect(fallbackArgs[2]).toBe(
          "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = $null; Write-Output fallback\n\n$__s = $?\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE) -and $LASTEXITCODE -ne 0 -and -not $__s) { exit $LASTEXITCODE }",
        );
      } finally {
        spy.mockRestore();
      }
    });

    it.each([
      ['a continuation backtick at the end', 'Write-Output tail `'],
      [
        'a literal backtick inside a trailing comment',
        'Write-Output gate `gate.sh` # same as `gate.sh`',
      ],
      ['a backtick followed by spaces at the end', 'Write-Output tail `  '],
      ['two backticks at the end', 'Write-Output literal ``'],
    ])(
      'keeps the exit-code tail separated by a blank line for %s',
      async (_label, command) => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        mockSpawn.mockImplementation(() => createMockProcess(0));
        await hookRunner.executeHook(
          {
            type: HookType.Command,
            command,
            source: HooksConfigSource.Project,
            shell: 'powershell',
          },
          HookEventName.PreToolUse,
          createMockInput(),
        );
        // One newline gets escaped by that backtick and swallows the tail, so the
        // blank line is what keeps the blocking exit code propagating.
        const spawned: string = mockSpawn.mock.calls[0][1][2];
        expect(spawned).toContain(`${command}\n\n$__s = $?`);
      },
    );

    it('rejects a bare-quoted path on the cmd fallback lane', async () => {
      const spy = mockCmdShellConfig();
      try {
        const result = await hookRunner.executeHook(
          {
            type: HookType.Command,
            command: '"C:\\hooks\\check.cmd"',
            source: HooksConfigSource.Project,
          },
          HookEventName.PreToolUse,
          createMockInput(),
        );
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/call operator '& '/);
        // The refusal must not manufacture an output: any output here routes
        // the call into the success path of every tool-event consumer.
        expect(result.output).toBeUndefined();
        expect(mockSpawn).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it.each([
      [
        'bare-quoted .cmd path at start',
        '"C:\\Program Files\\My App\\hook.cmd"',
      ],
      [
        'bare-quoted .bat path with arguments',
        '"C:\\Scripts\\setup.bat" arg1 arg2',
      ],
      ['bare-quoted .exe path at start', '"C:\\Windows\\notepad.exe"'],
      ['single-quoted .exe', "'C:\\foo.exe'"],
      ['bare-quoted .ps1 path at start', '"C:\\foo.ps1"'],
      ['bare-quoted .ps1 with arguments', '"C:\\foo.ps1" arg1 arg2'],
      [
        'bare-quoted path carrying terminal escapes',
        '"C:\\foo\u001b[2Jbar.cmd"',
      ],
    ])('rejects a PowerShell command that is %s', async (_label, command) => {
      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command,
          source: HooksConfigSource.Project,
          shell: 'powershell',
        },
        HookEventName.PreToolUse,
        createMockInput(),
      );
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/prefix with the call operator/);
      expect(result.error?.message).not.toContain('\u001b');
      expect(result.output).toBeUndefined();
      const aggregated = new HookAggregator().aggregateResults(
        [result],
        HookEventName.PreToolUse,
      );
      // The reason still reaches the aggregator's error list, which is the
      // channel the failure is reported from.
      expect(aggregated.errors[0]?.message).toContain('call operator');
      expect(aggregated.finalOutput).toBeUndefined();
    });

    it.each([
      ['call-operator prefix on quoted .cmd', '& "C:\\hook.cmd"'],
      ['command with quoted arguments', 'Get-Process "name"'],
      ['write-output with quoted argument', 'Write-Output "hello"'],
      ['cmd-style invocation with quoted tail', 'cmd /c "echo hello"'],
      ['bare-quoted no-extension command', '"foo"'],
      [
        'multi-line array of paths with bare-quoted .cmd',
        '"C:\\path1.cmd"\n"C:\\path2.cmd"\n"C:\\path3.cmd"',
      ],
      [
        'statement after a bare-quoted .cmd on the next line',
        '"C:\\hooks\\check.cmd"\nWrite-Output done',
      ],
      ['bare-quoted .sh path', '"C:\\hooks\\gate.sh"'],
      [
        'backtick-continued quoted path as argument',
        'Get-Process "C:\\long `\n` path\\app.cmd"',
      ],
      [
        'bare-quoted path whose name merely contains .exe / .cmd',
        '"C:\\build\\app.exe.log" | Get-Content',
      ],
      [
        'bare-quoted path whose name merely contains .cmd',
        '"C:\\Scripts\\deploy.cmd.old" | Remove-Item',
      ],
      [
        'bare-quoted .cmd piped as pipeline input',
        '"C:\\Scripts\\deploy.cmd" | Remove-Item',
      ],
      [
        'bare-quoted .ps1 piped as pipeline input',
        '"C:\\hooks\\gate.ps1" | Get-Content',
      ],
    ])(
      'does not throw for a PowerShell command that is %s',
      async (_label, command) => {
        mockSpawn.mockImplementation(() => createMockProcess(0));
        const result = await hookRunner.executeHook(
          {
            type: HookType.Command,
            command,
            source: HooksConfigSource.Project,
            shell: 'powershell',
          },
          HookEventName.PreToolUse,
          createMockInput(),
        );
        expect(result.success).toBe(true);
        expect(mockSpawn).toHaveBeenCalled();
      },
    );

    it('does NOT wrap bash commands with Set-StrictMode', async () => {
      // bash keeps unset-$VAR behaviour; `set -u` would break existing hooks.
      mockSpawn.mockImplementation(() => createMockProcess(0));
      await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'echo $CLAUDE_PROJECT_DIR',
          source: HooksConfigSource.Project,
          shell: 'bash',
        },
        HookEventName.PreToolUse,
        createMockInput(),
      );
      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1][spawnArgs[1].length - 1]).toBe(
        'echo $CLAUDE_PROJECT_DIR',
      );
      // Migration premise: the project-dir vars reach the hook through the
      // spawn environment instead of the removed pre-launch substitution.
      expect(spawnArgs[2].env).toMatchObject({
        CLAUDE_PROJECT_DIR: '/test',
        GEMINI_PROJECT_DIR: '/test',
        QWEN_PROJECT_DIR: '/test',
      });
      // Single quotes blocked expansion under the old pre-substitution too
      // (the regex replaced anywhere in the text); they must pass untouched.
      await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: "echo '$CLAUDE_PROJECT_DIR'",
          source: HooksConfigSource.Project,
          shell: 'bash',
        },
        HookEventName.PreToolUse,
        createMockInput(),
      );
      const quotedArgs = mockSpawn.mock.calls[1][1];
      expect(quotedArgs[quotedArgs.length - 1]).toBe(
        "echo '$CLAUDE_PROJECT_DIR'",
      );
    });

    it('surfaces VariableIsUndefined as systemMessage when $VAR is undefined', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      mockSpawn.mockImplementation(() =>
        createMockProcess(
          1,
          '',
          "\u001b[31;1mThe variable '$CLAUDE_PROJECT_DIR' cannot be retrieved because it has not been set.\u001b[0m\n" +
            'At line:1 char:1\n' +
            '+ $CLAUDE_PROJECT_DIR\n' +
            '+ ~~~~~~~~~~~~~~~~~~~\n' +
            '    + CategoryInfo          : InvalidOperation: (CLAUDE_PROJECT_DIR:String) [], RuntimeException\n' +
            '    + FullyQualifiedErrorId : VariableIsUndefined\n',
        ),
      );
      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: '$CLAUDE_PROJECT_DIR',
          source: HooksConfigSource.Project,
          shell: 'powershell',
        },
        HookEventName.PreToolUse,
        createMockInput(),
      );
      const spawnArgs = mockSpawn.mock.calls[0];
      // Pin: dropping any prefix statement must fail here, not only the
      // wrapping tests.
      expect(spawnArgs[1][2]).toMatch(
        /^\[Console\]::OutputEncoding=\[System\.Text\.Encoding\]::UTF8;Set-StrictMode -Version 1;\s*\$ErrorActionPreference\s*=\s*'Stop';\s*\$global:LASTEXITCODE = \$null;\s*\$CLAUDE_PROJECT_DIR\n\n\$__s = \$\?\nif \(\(Test-Path -LiteralPath variable:\\LASTEXITCODE\) -and \$LASTEXITCODE -ne 0 -and -not \$__s\) \{ exit \$LASTEXITCODE \}$/,
      );
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      const output = result.output as {
        systemMessage?: string;
        reason?: string;
      };
      expect(output.systemMessage).toBeDefined();
      expect(output.systemMessage).toContain('CLAUDE_PROJECT_DIR');
      expect(output.systemMessage).toMatch(
        /cannot be retrieved|VariableIsUndefined/,
      );
      expect(output.systemMessage).not.toContain('\u001b');
      expect(output.reason).not.toContain('\u001b');
    });

    it('strips escapes from exit-0 messages and blocking deny reasons', async () => {
      mockSpawn.mockImplementation(() =>
        createMockProcess(0, '\u001b[31mred\u001b[0m ok', ''),
      );
      const okRes = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'Write-Output colored',
          source: HooksConfigSource.Project,
          shell: 'powershell',
        },
        HookEventName.PreToolUse,
        createMockInput(),
      );
      expect((okRes.output as { systemMessage?: string }).systemMessage).toBe(
        'red ok',
      );

      mockSpawn.mockImplementation(() =>
        createMockProcess(2, '', '\u001b[31mno\u001b[0m'),
      );
      const denyRes = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'gate',
          source: HooksConfigSource.Project,
          shell: 'powershell',
        },
        HookEventName.PreToolUse,
        createMockInput(),
      );
      expect((denyRes.output as { reason?: string }).reason).toBe('no');
    });

    it('strips escapes from promoted fields of parsed JSON output', async () => {
      mockSpawn.mockImplementation(() =>
        createMockProcess(
          2,
          '',
          '{"decision":"deny","reason":"\\u001b[31mno\\u001b[0m","systemMessage":"\\u001b[2Jmsg","stopReason":"\\u001b[31mstop\\u001b[0m","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecisionReason":"\\u001b[31mwhy\\u001b[0m","additionalContext":"\\u001b[2Jctx"},"terminalSequence":"\\u001b]0;t\\u0007"}',
        ),
      );
      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'npm test 2>&1 | Out-String | ConvertTo-Json',
          source: HooksConfigSource.Project,
          shell: 'powershell',
        },
        HookEventName.PreToolUse,
        createMockInput(),
      );
      const output = result.output as {
        reason?: string;
        systemMessage?: string;
        stopReason?: string;
        terminalSequence?: string;
        hookSpecificOutput?: Record<string, unknown>;
      };
      expect(output.reason).toBe('no');
      expect(output.systemMessage).toBe('msg');
      expect(output.stopReason).toBe('stop');
      expect(output.hookSpecificOutput?.['permissionDecisionReason']).toBe(
        'why',
      );
      expect(output.hookSpecificOutput?.['additionalContext']).toBe('ctx');
      // terminalSequence is an escape channel by contract; it survives.
      expect(output.terminalSequence).toBe('\u001b]0;t\u0007');
    });

    it('strips escapes from a PermissionRequest deny message', async () => {
      mockSpawn.mockImplementation(() =>
        createMockProcess(
          0,
          '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"\\u001b[31mdenied\\u001b[0m","updatedInput":{"note":"\\u001b[31mkeep\\u001b[0m"}}}}',
          '',
        ),
      );
      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'gate',
          source: HooksConfigSource.Project,
          shell: 'powershell',
        },
        HookEventName.PermissionRequest,
        createMockInput(),
      );
      const decision = (
        result.output?.hookSpecificOutput as {
          decision?: { message?: string; updatedInput?: { note?: string } };
        }
      )?.decision;
      expect(decision?.message).toBe('denied');
      // updatedInput is forwarded as tool input, not promoted text.
      expect(decision?.updatedInput).toEqual({
        note: '\u001b[31mkeep\u001b[0m',
      });
    });
  });

  describe('resolvePowerShellExecutable', () => {
    // Mutation-verified: each case fails if probe, throw, cache, or pwsh
    // priority is removed; beforeEach resets the cache for a clean probe.
    let execSpy: MockInstance<typeof shellUtils.resolveCommandPath>;
    beforeEach(() => {
      execSpy = vi.spyOn(shellUtils, 'resolveCommandPath');
    });

    it('resolves to "pwsh" when pwsh is on PATH', () => {
      execSpy.mockImplementation(((name: string) => {
        if (name === 'pwsh') return { path: '/usr/bin/pwsh' };
        return { path: null };
      }) as never);
      expect(resolvePowerShellExecutable()).toBe('/usr/bin/pwsh');
    });

    it('falls back to "powershell" when pwsh is missing', () => {
      execSpy.mockImplementation(((name: string) => {
        if (name === 'powershell') return { path: '/usr/bin/powershell' };
        return { path: null };
      }) as never);
      expect(resolvePowerShellExecutable()).toBe('/usr/bin/powershell');
    });

    it('throws a precise error when neither executable is on PATH', () => {
      execSpy.mockImplementation((() => ({ path: null })) as never);
      expect(() => resolvePowerShellExecutable()).toThrow(
        'Could not resolve a PowerShell executable (looked for pwsh, powershell)',
      );
    });

    it('probes only once across multiple calls (caches the resolved executable)', () => {
      execSpy.mockImplementation((() => ({ path: '/usr/bin/pwsh' })) as never);
      resolvePowerShellExecutable();
      resolvePowerShellExecutable();
      resolvePowerShellExecutable();
      expect(execSpy).toHaveBeenCalledTimes(1);
    });

    it('re-probes after a failed lookup instead of latching the failure', () => {
      execSpy.mockImplementation((() => ({ path: null })) as never);
      expect(() => resolvePowerShellExecutable()).toThrow(
        'Could not resolve a PowerShell executable (looked for pwsh, powershell)',
      );
      execSpy.mockImplementation(((name: string) =>
        name === 'pwsh' ? { path: '/usr/bin/pwsh' } : { path: null }) as never);
      expect(resolvePowerShellExecutable()).toBe('/usr/bin/pwsh');
      // Two failed candidates, then the next call re-probes and recovers.
      expect(execSpy).toHaveBeenCalledTimes(3);
    });

    it('resolves to the first match when the lookup lists several', () => {
      execSpy.mockImplementation((() => ({
        path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\nD:\\shims\\pwsh.exe',
      })) as never);
      expect(resolvePowerShellExecutable()).toBe(
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      );
    });

    it('names the lookup error when the probe failed rather than missed', () => {
      execSpy.mockImplementation((() => ({
        path: null,
        error: new Error('spawn where.exe EACCES'),
      })) as never);
      expect(() => resolvePowerShellExecutable()).toThrow(
        /Could not resolve a PowerShell executable.*EACCES/,
      );
    });

    it('probes from a neutral cwd so a workspace copy cannot answer', () => {
      execSpy.mockImplementation((() => ({ path: null })) as never);
      expect(() => resolvePowerShellExecutable()).toThrow();
      // `where` searches the current directory before PATH: probing from the
      // process cwd would return a workspace-planted pwsh.exe.
      expect(execSpy).toHaveBeenCalledWith('pwsh', { cwd: tmpdir() });
    });
  });

  describe('outcome of results produced outside the runners', () => {
    const asyncHook: HookConfig = {
      type: HookType.Command,
      command: 'background-job',
      source: HooksConfigSource.Project,
      async: true,
    };

    it('reports an unknown hook type as a non-blocking error', async () => {
      const result = await hookRunner.executeHook(
        { type: 'unknown' } as unknown as HookConfig,
        HookEventName.PreToolUse,
        createMockInput(),
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
    });

    it('reports an async hook refused by the concurrency limit as a non-blocking error', async () => {
      vi.spyOn(hookRunner['asyncRegistry'], 'canAcceptMore').mockReturnValue(
        false,
      );

      const result = await hookRunner.executeHook(
        asyncHook,
        HookEventName.PostToolUse,
        createMockInput(),
      );

      expect(result.outcome).toBe('non_blocking_error');
      expect(result.isAsync).toBe(true);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('reports an async hook whose registration loses the race as a non-blocking error', async () => {
      vi.spyOn(hookRunner['asyncRegistry'], 'register').mockReturnValue(null);

      const result = await hookRunner.executeHook(
        asyncHook,
        HookEventName.PostToolUse,
        createMockInput(),
      );

      expect(result.outcome).toBe('non_blocking_error');
      expect(result.isAsync).toBe(true);
    });

    it('reports an async hook handed to the background as success', async () => {
      mockSpawn.mockImplementation(() => createMockProcess());

      const result = await hookRunner.executeHook(
        asyncHook,
        HookEventName.PostToolUse,
        createMockInput(),
      );

      expect(result.outcome).toBe('success');
      expect(result.isAsync).toBe(true);
      expect(result.success).toBe(true);
    });
  });
});
