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
  __resetPowerShellCache,
  resolvePowerShellExecutable,
} from './hookRunner.js';
import * as shellUtils from '../utils/shell-utils.js';
import {
  HookEventName,
  HookType,
  HooksConfigSource,
  MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH,
} from './types.js';
import type {
  HookConfig,
  HookInput,
  UserPromptExpansionInput,
  UserPromptSubmitInput,
} from './types.js';

// Hoisted mock
const mockSpawn = vi.hoisted(() => vi.fn());
const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    spawn: mockSpawn,
    execFile: mockExecFile,
  };
});

describe('HookRunner', () => {
  let hookRunner: HookRunner;

  beforeEach(() => {
    hookRunner = new HookRunner();
    vi.clearAllMocks();
    // Default: resolveCommandPath behaves as if only `powershell`
    // (Windows PowerShell 5.1) is installed - pwsh lookup returns null,
    // powershell lookup returns a path. Existing tests assert
    // executable === 'powershell' and this matches that contract. Tests
    // that exercise the probe priority (pwsh vs powershell, both
    // missing, etc.) override the spy in their own setup.
    vi.spyOn(shellUtils, 'resolveCommandPath').mockImplementation(
      ((name: string) => {
        if (name === 'powershell') return { path: 'powershell' };
        return { path: null };
      }) as never,
    );
    // Reset the module-level probe cache so the default mock above
    // applies on the first probe call.
    __resetPowerShellCache();
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

  // Forces the cmd->powershell fallback by making getShellConfiguration
  // return the Windows cmd.exe shape - required for tests that assert
  // spawnCall[1][2] (the post-`-Command` arg position). Without this mock,
  // Linux/macOS hosts use bash (`argsPrefix: ['-c']`), so spawn args have
  // length 2 and `[1][2]` is undefined. Caller wraps the test in
  // `try { ... } finally { spy.mockRestore(); }`.
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

  describe('executeHooksParallel', () => {
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
        { ...hookConfig, timeout: 100 },
        HookEventName.PreToolUse,
        createMockInput(),
      );
      await vi.advanceTimersByTimeAsync(100);
      mockProcess.emit('close', null);
      const result = await resultPromise;

      expect(result.error?.message).toBe('Hook timed out after 100ms');
      expect(killSpy.mock.calls).toContainEqual([-mockProcess.pid, 'SIGTERM']);
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
        { ...hookConfig, timeout: 100 },
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
      expect(spawnArgs[0]).toBe('powershell');
      // Command is wrapped with Set-StrictMode -Version 1 + $ErrorActionPreference = 'Stop'
      // so undefined $VAR fails immediately (and any error terminates the
      // script rather than being silently shadowed by a later successful
      // statement resetting $? and exit code 0).
      expect(spawnArgs[1]).toEqual([
        '-NoProfile',
        '-Command',
        "Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; Write-Output test",
      ]);
      expect(spawnArgs[2].shell).toBe(false);
    });

    it('uses powershell when the global shell is cmd', async () => {
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
        expect(spawnArgs[0]).toBe('powershell');
        // Command is wrapped with Set-StrictMode -Version 1 + $ErrorActionPreference = 'Stop'
        // so undefined $VAR fails immediately (and any error terminates the script).
        expect(spawnArgs[1]).toEqual([
          '-NoProfile',
          '-Command',
          "Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; echo test",
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    it('passes the env-var form through for an explicit powershell shell', async () => {
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
      expect(spawnArgs[0]).toBe('powershell');
      // PowerShell command is wrapped with Set-StrictMode -Version 1 + $ErrorActionPreference = 'Stop'.
      expect(spawnArgs[1][2]).toBe(
        "Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; $env:CLAUDE_PROJECT_DIR/scripts/validate.cmd",
      );
    });

    it('uses the same powershell config for explicit shell and cmd fallback', async () => {
      const spy = mockCmdShellConfig();
      try {
        mockSpawn.mockImplementation(() => createMockProcess(0));
        // Explicit shell
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
        // cmd fallback
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
        // Both run the same executable with the same argsPrefix
        // (-NoProfile -Command), differing only in the trailing command string.
        expect(mockSpawn.mock.calls[1][0]).toBe(mockSpawn.mock.calls[0][0]);
        expect(fallbackArgs.slice(0, 2)).toEqual(explicitArgs.slice(0, 2));
        // Both PowerShell invocations are wrapped with Set-StrictMode -Version 1 + $ErrorActionPreference = 'Stop'.
        expect(explicitArgs[2]).toBe(
          "Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; Write-Output explicit",
        );
        expect(fallbackArgs[2]).toBe(
          "Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; Write-Output fallback",
        );
      } finally {
        spy.mockRestore();
      }
    });

    it.each([
      ['bare-quoted .cmd path at start', '"C:\\Program Files\\My App\\hook.cmd"'],
      [
        'bare-quoted .bat path with arguments',
        '"C:\\Scripts\\setup.bat" arg1 arg2',
      ],
      [
        'bare-quoted .exe path at start',
        '"C:\\Windows\\notepad.exe"',
      ],
      [
        'multi-statement with bare-quoted .cmd',
        'cmd1; "foo.cmd"',
      ],
      ['bare-quoted .bat after comment line', '# my hook\n"foo.bat"'],
      ['single-quoted .exe', "'C:\\foo.exe'"],
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
    });

    it.each([
      ['call-operator prefix on quoted .cmd', '& "C:\\hook.cmd"'],
      ['command with quoted arguments', 'Get-Process "name"'],
      ['write-output with quoted argument', 'Write-Output "hello"'],
      ['cmd-style invocation with quoted tail', 'cmd /c "echo hello"'],
      ['bare-quoted .ps1 not in cmd-regression class', '"C:\\foo.ps1"'],
      ['bare-quoted .ps1 with arguments', '"C:\\foo.ps1" arg1 arg2'],
      ['bare-quoted no-extension command', '"foo"'],
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
      // PowerShell-only wrapping. bash spawn uses `bash -c` (no -u flag);
      // adding `set -u` here would break existing hooks that rely on
      // empty-string expansion of unset $VAR (the previous bash behaviour).
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
      // bash command passes through verbatim - no Set-StrictMode prefix.
      expect(spawnArgs[1][spawnArgs[1].length - 1]).toBe('echo $CLAUDE_PROJECT_DIR');
    });

    it('surfaces VariableIsUndefined as systemMessage when $VAR is undefined', async () => {
      // Under Set-StrictMode -Version 1, PowerShell aborts with the exact
      // $VAR name in the error. The user sees this through HookExecutionResult.
      mockSpawn.mockImplementation(() =>
        createMockProcess(
          1,
          '',
          'The variable \'$CLAUDE_PROJECT_DIR\' cannot be retrieved because it has not been set.\n' +
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
      // Pin the Set-StrictMode + $ErrorActionPreference precondition so a
      // regression that drops either would fail this test (not just the other
      // wrapping tests).
      expect(spawnArgs[1][2]).toMatch(
        /^Set-StrictMode -Version 1;\s*\$ErrorActionPreference\s*=\s*'Stop';\s*\$CLAUDE_PROJECT_DIR$/,
      );
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      // The PowerShell error reaches the caller through systemMessage so the
      // user can see the exact $VAR that failed.
      const output = result.output as { systemMessage?: string; reason?: string };
      expect(output.systemMessage).toBeDefined();
      expect(output.systemMessage).toContain('CLAUDE_PROJECT_DIR');
      expect(output.systemMessage).toMatch(/cannot be retrieved|VariableIsUndefined/);
    });
  });

  describe('resolvePowerShellExecutable', () => {
    // Mutation verification: any of the 5 cases fails when the probe is
    // reverted / throw is dropped / cache is removed / pwsh priority is
    // dropped. Tests reset the module-level cache in beforeEach so each
    // case starts from a clean state.
    let execSpy: MockInstance<typeof shellUtils.resolveCommandPath>;
    beforeEach(() => {
      execSpy = vi.spyOn(shellUtils, 'resolveCommandPath');
    });

    it('resolves to "pwsh" when pwsh is on PATH', () => {
      execSpy.mockImplementation(((name: string) => {
        if (name === 'pwsh') return { path: '/usr/bin/pwsh' };
        return { path: null };
      }) as never);
      expect(resolvePowerShellExecutable()).toBe('pwsh');
    });

    it('falls back to "powershell" when pwsh is missing', () => {
      execSpy.mockImplementation(((name: string) => {
        if (name === 'powershell') return { path: '/usr/bin/powershell' };
        return { path: null };
      }) as never);
      expect(resolvePowerShellExecutable()).toBe('powershell');
    });

    it('throws a precise error when neither executable is on PATH', () => {
      execSpy.mockImplementation((() => ({ path: null })) as never);
      expect(() => resolvePowerShellExecutable()).toThrow(
        'No PowerShell executable found on PATH (looked for pwsh, powershell)',
      );
    });

    it('probes only once across multiple calls (caches the resolved executable)', () => {
      execSpy.mockImplementation((() => ({ path: '/usr/bin/pwsh' })) as never);
      resolvePowerShellExecutable();
      resolvePowerShellExecutable();
      resolvePowerShellExecutable();
      expect(execSpy).toHaveBeenCalledTimes(1);
    });

    it('fast-fails subsequent calls when neither executable is on PATH (negative cache)', () => {
      execSpy.mockImplementation((() => ({ path: null })) as never);
      expect(() => resolvePowerShellExecutable()).toThrow();
      expect(() => resolvePowerShellExecutable()).toThrow();
      // First call iterates both 'pwsh' and 'powershell'; the negative
      // cache short-circuits the second call to a single rethrow.
      expect(execSpy).toHaveBeenCalledTimes(2);
    });
  });
});
