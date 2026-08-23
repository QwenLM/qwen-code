/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';
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

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    spawn: mockSpawn,
  };
});

describe('HookRunner', () => {
  let hookRunner: HookRunner;

  beforeEach(() => {
    hookRunner = new HookRunner();
    vi.clearAllMocks();
    // Default: resolveCommandPath behaves as if only `powershell`
    // (Windows PowerShell 5.1) is installed — pwsh lookup returns null,
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
    };
    return mockProcess;
  };

  // Forces the cmd→抪owershell fallback by making getShellConfiguration
  // return the Windows cmd.exe shape 鈥?required for tests that assert
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

  describe('expandCommand', () => {
    // PowerShell uses `$env:VAR` form; the state machine tracks only the
    // contexts where PowerShell's expansion differs (single-quote, here-
    // string body, backtick escape). Command-position placeholders get
    // `& (…)` wrapping so PowerShell invokes the path.

    it('should not modify a command without placeholders', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo hello',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: '/test/project' });

      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);

      const spawnCall = mockSpawn.mock.calls[0];
      const command = spawnCall[1][spawnCall[1].length - 1];
      expect(command).toBe('echo hello');
    });

    it('expands $GEMINI_PROJECT_DIR to $env:GEMINI_PROJECT_DIR on powershell (outside)', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command: 'echo $GEMINI_PROJECT_DIR',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: '/test/project' });
      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe('echo $env:GEMINI_PROJECT_DIR');
    });

    it('expands $CLAUDE_PROJECT_DIR to $env:CLAUDE_PROJECT_DIR on powershell (outside)', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command: 'echo $CLAUDE_PROJECT_DIR',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: '/test/project' });
      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe('echo $env:CLAUDE_PROJECT_DIR');
    });

    it('uses $env:CLAUDE_PROJECT_DIR inside double quotes (in-double)', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command: 'Write-Output "prefix $CLAUDE_PROJECT_DIR/suffix"',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: '/test/project' });
      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe(
        'Write-Output "prefix $env:CLAUDE_PROJECT_DIR/suffix"',
      );
    });

    it('substitutes the path inside single quotes (in-single)', async () => {
      // $env:VAR doesn't expand inside single quotes in PowerShell, so we
      // substitute the path with the ' escape. Same rule bash always used.
      // The author wrapped a SINGLE-QUOTED substring (not the whole command)
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command: "Get-Content '$CLAUDE_PROJECT_DIR/x.json'",
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: "/te'st/project" });
      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe(
        "Get-Content '/te''st/project/x.json'",
      );
    });

    it('keeps the placeholder literal inside a here-string body', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command: "$block = @'\n$CLAUDE_PROJECT_DIR\n'@",
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: '/test/project' });
      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe("$block = @'\n$CLAUDE_PROJECT_DIR\n'@");
    });

    it('wraps a command-position placeholder with `& (env:VAR + tail)` so PowerShell invokes the path', async () => {
      // At start of command (or after statement separator), bare
      // `$env:VAR/tail` would be parsed as division or a string
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const fallbackSpy = mockCmdShellConfig();
      try {
        const hookConfig: HookConfig = {
          type: HookType.Command,
          command: '$CLAUDE_PROJECT_DIR/scripts/x.cmd',
          source: HooksConfigSource.Project,
        };
        const input = createMockInput({ cwd: '/test/project' });
        await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);
        const spawnCall = mockSpawn.mock.calls[0];
        expect(spawnCall[1][0]).toBe('-NoProfile');
        expect(spawnCall[1][1]).toBe('-Command');
        expect(spawnCall[1][2]).toBe(
          '& ($env:CLAUDE_PROJECT_DIR + "/scripts/x.cmd")',
        );
      } finally {
        fallbackSpy.mockRestore();
      }
    });

    it('wraps a placeholder after `&&` / `||` / `\n` (statement separator) with `& (env:VAR + tail)`', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const fallbackSpy = mockCmdShellConfig();
      try {
        for (const command of [
          'cmd1 && $CLAUDE_PROJECT_DIR/x.cmd',
          'cmd1 || $CLAUDE_PROJECT_DIR/x.cmd',
          'cmd1; $CLAUDE_PROJECT_DIR/x.cmd',
          'cmd1 | $CLAUDE_PROJECT_DIR/x.cmd',
          'cmd1\n$CLAUDE_PROJECT_DIR/x.cmd',
        ]) {
          mockSpawn.mockClear();
          const hookConfig: HookConfig = {
            type: HookType.Command,
            command,
            source: HooksConfigSource.Project,
          };
          const input = createMockInput({ cwd: '/test/project' });
          await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);
          const spawnCall = mockSpawn.mock.calls[0];
          // Build expected by prefix + wrapped form (the regex captures the
          // tail after `$CLAUDE_PROJECT_DIR` and the wrap string embeds it
          // as `+ tail` — there's no leftover `/x.cmd` after the wrap).
          const placeholderIdx = command.indexOf('$CLAUDE_PROJECT_DIR');
          const prefix = command.slice(0, placeholderIdx);
          expect(spawnCall[1][2]).toBe(
            `${prefix}& ($env:CLAUDE_PROJECT_DIR + "/x.cmd")`,
          );
        }
      } finally {
        fallbackSpy.mockRestore();
      }
    });

    it('does NOT wrap a placeholder inside `{ … }` or `$( … )` (subexpression)', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const fallbackSpy = mockCmdShellConfig();
      try {
        for (const command of [
          'if ($x) { $CLAUDE_PROJECT_DIR/x.cmd }',
          'function f { Write-Output done } $CLAUDE_PROJECT_DIR/x.cmd',
          'Get-ChildItem $(Join-Path $CLAUDE_PROJECT_DIR bin)',
        ]) {
          mockSpawn.mockClear();
          const hookConfig: HookConfig = {
            type: HookType.Command,
            command,
            source: HooksConfigSource.Project,
          };
          const input = createMockInput({ cwd: '/test/project' });
          await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);
          const spawnCall = mockSpawn.mock.calls[0];
          // No `& ` wrapping inside the subexpression / script block.
          expect(spawnCall[1][2]).not.toMatch(/& \(\$env/);
          // Env-var form is preserved.
          expect(spawnCall[1][2]).toContain('$env:CLAUDE_PROJECT_DIR');
        }
      } finally {
        fallbackSpy.mockRestore();
      }
    });

    it('preserves the literal `$VAR` when the placeholder is backtick-escaped', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const fallbackSpy = mockCmdShellConfig();
      try {
        const hookConfig: HookConfig = {
          type: HookType.Command,
          command: 'Write-Output `$CLAUDE_PROJECT_DIR',
          source: HooksConfigSource.Project,
        };
        const input = createMockInput({ cwd: '/test/project' });
        await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);
        const spawnCall = mockSpawn.mock.calls[0];
        expect(spawnCall[1][2]).toBe('Write-Output `$CLAUDE_PROJECT_DIR');
      } finally {
        fallbackSpy.mockRestore();
      }
    });

    it('expands a placeholder inside `@"…"` here-string body as env-var form', async () => {
      // `@"…"` here-strings interpolate `$env:VAR`. `@'…'` (verbatim)
      // does not — they keep the literal `$VAR`. We track both
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const fallbackSpy = mockCmdShellConfig();
      try {
        // Expandable here-string.
        const expandable: HookConfig = {
          type: HookType.Command,
          command: '$block = @"\ndata $CLAUDE_PROJECT_DIR\n"@',
          source: HooksConfigSource.Project,
        };
        await hookRunner.executeHook(
          expandable,
          HookEventName.PreToolUse,
          createMockInput({ cwd: '/test/project' }),
        );
        expect(mockSpawn.mock.calls[0][1][2]).toBe(
          '$block = @"\ndata $env:CLAUDE_PROJECT_DIR\n"@',
        );
        mockSpawn.mockClear();
        // Verbatim here-string.
        const verbatim: HookConfig = {
          type: HookType.Command,
          command: "$block = @'\ndata $CLAUDE_PROJECT_DIR\n'@",
          source: HooksConfigSource.Project,
        };
        await hookRunner.executeHook(
          verbatim,
          HookEventName.PreToolUse,
          createMockInput({ cwd: '/test/project' }),
        );
        expect(mockSpawn.mock.calls[0][1][2]).toBe(
          "$block = @'\ndata $CLAUDE_PROJECT_DIR\n'@",
        );
      } finally {
        fallbackSpy.mockRestore();
      }
    });

    it('does NOT close a here-string on a mid-body `@token` sequence', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const fallbackSpy = mockCmdShellConfig();
      try {
        const hookConfig: HookConfig = {
          type: HookType.Command,
          command: "$block = @'\nfoo '@bar\n$CLAUDE_PROJECT_DIR\n'@",
          source: HooksConfigSource.Project,
        };
        await hookRunner.executeHook(
          hookConfig,
          HookEventName.PreToolUse,
          createMockInput({ cwd: '/test/project' }),
        );
        const spawnCall = mockSpawn.mock.calls[0];
        // The mid-body `'@bar` did NOT pop the here-string, so the
        // placeholder stayed inside `@'…'@` (verbatim) and remains
        // literal.
        expect(spawnCall[1][2]).toBe(
          "$block = @'\nfoo '@bar\n$CLAUDE_PROJECT_DIR\n'@",
        );
      } finally {
        fallbackSpy.mockRestore();
      }
    });

    it('does NOT inject `& ` on a placeholder inside an unclosed $() (subexpression)', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const fallbackSpy = mockCmdShellConfig();
      try {
        const hookConfig: HookConfig = {
          type: HookType.Command,
          command: 'Get-ChildItem $(Join-Path $CLAUDE_PROJECT_DIR',
          source: HooksConfigSource.Project,
        };
        const input = createMockInput({ cwd: '/test/project' });
        await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);
        const spawnCall = mockSpawn.mock.calls[0];
        // No `& ` injected.
        expect(spawnCall[1][2]).toBe(
          'Get-ChildItem $(Join-Path $env:CLAUDE_PROJECT_DIR',
        );
      } finally {
        fallbackSpy.mockRestore();
      }
    });

    it('substitutes adjacent placeholders separated only by tail characters', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command:
          '$env:PATH = "$GEMINI_PROJECT_DIR/bin:$CLAUDE_PROJECT_DIR/bin"',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: '/test/project' });
      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe(
        '$env:PATH = "$env:GEMINI_PROJECT_DIR/bin:$env:CLAUDE_PROJECT_DIR/bin"',
      );
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
      // An unquoted command needs no `&` call-operator prefix 鈥?only a
      // bare-quoted path would be echoed instead of executed.
      expect(spawnArgs[1]).toEqual([
        '-NoProfile',
        '-Command',
        'Write-Output test',
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
        // An unquoted command needs no `&` call-operator prefix 鈥?only a
        // bare-quoted path would be echoed instead of executed.
        expect(spawnArgs[1]).toEqual(['-NoProfile', '-Command', 'echo test']);
      } finally {
        spy.mockRestore();
      }
    });

    it.each([
      ['double-quoted', '"', '"'],
      ['single-quoted', "'", "'"],
    ])(
      'prefixes a %s bare command with the call operator on the cmd fallback',
      async (_label, openQuote, closeQuote) => {
        const spy = mockCmdShellConfig();
        try {
          mockSpawn.mockImplementation(() => createMockProcess(0));
          await hookRunner.executeHook(
            {
              type: HookType.Command,
              command: `${openQuote}C:/Program Files/My App/setup.cmd${closeQuote}`,
              source: HooksConfigSource.Project,
            },
            HookEventName.PreToolUse,
            createMockInput(),
          );
          const spawnArgs = mockSpawn.mock.calls[0];
          expect(spawnArgs[0]).toBe('powershell');
          expect(spawnArgs[1][0]).toBe('-NoProfile');
          expect(spawnArgs[1][2]).toBe(
            `& ${openQuote}C:/Program Files/My App/setup.cmd${closeQuote}`,
          );
        } finally {
          spy.mockRestore();
        }
      },
    );

    // The alternation's new match class 鈥?a leading quote embedding the
    // OTHER quote type 鈥?is only treated as a bare-quoted path when it
    // carries path shape: a whole-command string literal stays literal,
    // an apostrophe-carrying path still gets the call-operator prefix.
    it.each([
      ['string literal', `'say "hi"'`, `'say "hi"'`],
      [
        'apostrophe path',
        `"C:/Users/O'Brien/setup.cmd"`,
        `& "C:/Users/O'Brien/setup.cmd"`,
      ],
    ])(
      'applies the bare-quoted path-shape gate to a %s (cmd fallback)',
      async (_label, command, expected) => {
        const spy = mockCmdShellConfig();
        try {
          mockSpawn.mockImplementation(() => createMockProcess(0));
          await hookRunner.executeHook(
            {
              type: HookType.Command,
              command,
              source: HooksConfigSource.Project,
            },
            HookEventName.PreToolUse,
            createMockInput(),
          );
          const spawnArgs = mockSpawn.mock.calls[0];
          expect(spawnArgs[1][2]).toBe(expected);
        } finally {
          spy.mockRestore();
        }
      },
    );

    it('does not treat a whole-command string literal as a bare-quoted path (explicit powershell)', async () => {
      mockSpawn.mockImplementation(() => createMockProcess(0));
      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: `'Write-Output "hi"'`,
          source: HooksConfigSource.Project,
          shell: 'powershell',
        },
        HookEventName.PreToolUse,
        createMockInput(),
      );
      expect(mockSpawn).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it.each([
      ['double-quoted', '"', '"'],
      ['single-quoted', "'", "'"],
    ])(
      'errors on a %s bare command with an explicit powershell shell',
      async (_label, openQuote, closeQuote) => {
        mockSpawn.mockImplementation(() => createMockProcess(0));
        const result = await hookRunner.executeHook(
          {
            type: HookType.Command,
            command: `${openQuote}C:/Program Files/App/x.cmd${closeQuote}`,
            source: HooksConfigSource.Project,
            shell: 'powershell',
          },
          HookEventName.PreToolUse,
          createMockInput(),
        );
        expect(mockSpawn).not.toHaveBeenCalled();
        expect(result.success).toBe(false);
        expect(result.error?.message).toContain('quoted path');
      },
    );

    // BARE_QUOTED trailer must treat operators in LATER quoted args as
    // non-disqualifying.
    it.each([
      ['|', '"C:/app/run.cmd" "a|b"'],
      [';', '"C:/app/run.cmd" "a;b"'],
      ['>', '"C:/app/run.cmd" --out "a>b"'],
      ['newline', '"C:/app/run.cmd" arg1\necho done'],
    ])(
      'treats %s inside a later quoted arg as NOT disqualifying the bare-quoted prefix',
      async (_op, command) => {
        const spy = mockCmdShellConfig();
        try {
          mockSpawn.mockImplementation(() => createMockProcess(0));
          await hookRunner.executeHook(
            {
              type: HookType.Command,
              command,
              source: HooksConfigSource.Project,
            },
            HookEventName.PreToolUse,
            createMockInput(),
          );
          const spawnArgs = mockSpawn.mock.calls[0];
          expect(spawnArgs[0]).toBe('powershell');
          expect(spawnArgs[1][2]).toBe(`& ${command}`);
        } finally {
          spy.mockRestore();
        }
      },
    );

    // Author used the $CLAUDE_PROJECT_DIR placeholder without surrounding
    // quotes; the env-var form is portable, no `& ` injection needed.
    it('uses the env-var form for an unquoted placeholder (cmd fallback)', async () => {
      const spy = mockCmdShellConfig();
      try {
        mockSpawn.mockImplementation(() => createMockProcess(0));
        await hookRunner.executeHook(
          {
            type: HookType.Command,
            command: '$CLAUDE_PROJECT_DIR/scripts/x.cmd',
            source: HooksConfigSource.Project,
          },
          HookEventName.PreToolUse,
          createMockInput({ cwd: "/te'st/project" }),
        );
        const spawnArgs = mockSpawn.mock.calls[0];
        expect(spawnArgs[0]).toBe('powershell');
        // Cwd with apostrophe is harmless; the env-var form is resolved
        // by PowerShell, not text-substituted. Command-position
        // placeholder gets the `& (…)` wrap so PowerShell invokes the
        // path.
        expect(spawnArgs[1][2]).toBe(
          '& ($env:CLAUDE_PROJECT_DIR + "/scripts/x.cmd")',
        );
      } finally {
        spy.mockRestore();
      }
    });

    // Author wrapped the placeholder in double quotes; the env-var form
    // is interpolated by PowerShell inside `"..."`. The cmd→powershell
    // fallback adds `& ` because the EXPANDED form starts with `"`.
    it('uses the env-var form for a quoted placeholder (cmd fallback)', async () => {
      const spy = mockCmdShellConfig();
      try {
        mockSpawn.mockImplementation(() => createMockProcess(0));
        await hookRunner.executeHook(
          {
            type: HookType.Command,
            command: '"$CLAUDE_PROJECT_DIR/scripts/validate.cmd"',
            source: HooksConfigSource.Project,
          },
          HookEventName.PreToolUse,
          createMockInput({ cwd: '/test/project' }),
        );
        const spawnArgs = mockSpawn.mock.calls[0];
        expect(spawnArgs[0]).toBe('powershell');
        expect(spawnArgs[1][2]).toBe(
          '& "$env:CLAUDE_PROJECT_DIR/scripts/validate.cmd"',
        );
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
      expect(spawnArgs[1][2]).toBe(
        '$env:CLAUDE_PROJECT_DIR/scripts/validate.cmd',
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
        // An unquoted command needs no `&` call-operator prefix on either
        // path — only a bare-quoted path would be echoed instead of executed.
        expect(explicitArgs[2]).toBe('Write-Output explicit');
        expect(fallbackArgs[2]).toBe('Write-Output fallback');
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('resolvePowerShellExecutable', () => {
    // Mutation verification: any of the 5 cases fails when the probe is
    // reverted / throw is dropped / cache is removed / pwsh priority is
    // dropped. Tests reset the module-level cache in beforeEach so each
    // case starts from a clean state.
    let execSpy: ReturnType<
      typeof vi.spyOn<typeof shellUtils.resolveCommandPath>
    >;
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
