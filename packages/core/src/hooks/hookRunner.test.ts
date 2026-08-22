/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookRunner } from './hookRunner.js';
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

  // Forces the cmd→powershell fallback by making getShellConfiguration
  // return the Windows cmd.exe shape — required for tests that assert
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
    it('should expand GEMINI_PROJECT_DIR placeholder', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo $GEMINI_PROJECT_DIR',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: '/test/project' });

      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);

      // Verify spawn was called with expanded command
      const spawnCall = mockSpawn.mock.calls[0];
      const command = spawnCall[1][spawnCall[1].length - 1]; // Last arg is the command
      expect(command).toContain('/test/project');
    });

    it('should expand CLAUDE_PROJECT_DIR placeholder for compatibility', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'echo $CLAUDE_PROJECT_DIR',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: '/test/project' });

      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);

      const spawnCall = mockSpawn.mock.calls[0];
      const command = spawnCall[1][spawnCall[1].length - 1]; // Last arg is the command
      expect(command).toContain('/test/project');
    });

    // Chained-replace offset baseline: thread geminiExpanded into the
    // second callback so the scanner reads the post-first-replace string.
    // Mutation: revert both callbacks to close over `command` → bare cwd.
    it('expands both project-dir placeholders with correct region state (powershell)', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command: 'Write-Output $GEMINI_PROJECT_DIR"$CLAUDE_PROJECT_DIR',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: "/te'st/project" });

      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);

      const spawnCall = mockSpawn.mock.calls[0];
      // $CLAUDE in the post-GEMINI string sits in in-double → bare cwd.
      expect(spawnCall[1][2]).toBe(
        "Write-Output '/te''st/project'\"/te'st/project",
      );
    });

    // $() sub-expression opens a fresh region; inner " must not close
    // outer ". Mutation: drop the $( open / ) close branches → placeholder
    // lands in outside, single-quote-wrapped.
    it('keeps the outer state across a $(...) sub-expression with an inner quoted placeholder', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command: '& "Today: $(Get-Content "$CLAUDE_PROJECT_DIR/x.json")"',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: '/test/project' });

      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);

      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe(
        '& "Today: $(Get-Content "/test/project/x.json")"',
      );
    });

    // ) inside a quoted $() body is data; only unquoted ) pops.
    // Mutation: drop state==='outside' guard on ) → phantom in-double,
    // cwd renders bare with parse error on the '.
    it('does not pop the $() body on a quoted paren', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command: 'Get-ChildItem $(Join-Path "a)b")$CLAUDE_PROJECT_DIR',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: "/te'st/project" });

      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);

      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe(
        "Get-ChildItem $(Join-Path \"a)b\")'/te''st/project'",
      );
    });

    // Backtick is literal inside single quotes. Mutation: unconditional
    // ` ch === '\`' ` skip → closing `'` eaten, placeholder bare.
    it('keeps a single-quoted string ending in backtick closed', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command: "Write-Output 'a`'$CLAUDE_PROJECT_DIR",
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: "/te'st/project" });

      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);

      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe("Write-Output 'a`''/te''st/project'");
    });

    // $( inside single quotes is literal text. Mutation: drop the
    // state !== 'in-single' guard on the $( branch → placeholder wrapped.
    it('keeps $() literal inside a single-quoted string', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command: "Write-Output 'pre $($CLAUDE_PROJECT_DIR) post'",
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: "/te'st/project" });

      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);

      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe(
        "Write-Output 'pre $(/te''st/project) post'",
      );
    });

    // Nested $() must pop LIFO so the placeholder lands back in the
    // enclosing double-quoted string.
    it('restores the enclosing double-quote state across nested $()', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command: 'Write-Output "prefix $(Get-X $(Get-Y)) $CLAUDE_PROJECT_DIR"',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: '/test/project' });

      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);

      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe(
        'Write-Output "prefix $(Get-X $(Get-Y)) /test/project"',
      );
    });

    // Plain grouping parens inside a single $() body must not pop the
    // substitution — the inner ) decrements parenDepth, only the outer
    // ) pops the $().
    it('keeps the $() open across plain grouping parens', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);

      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command: '$(Get-ChildItem (Resolve-Path .))$CLAUDE_PROJECT_DIR',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: "/te'st/project" });

      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);

      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe(
        "$(Get-ChildItem (Resolve-Path .))'/te''st/project'",
      );
    });

    it('should not modify command without placeholders', async () => {
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
      const command = spawnCall[1][spawnCall[1].length - 1]; // Last arg is the command
      expect(command).toBe('echo hello');
    });

    // Pin the escapeShellArg-generated-quote path (unquoted placeholder
    // at command start). Mock getShellConfiguration to force the
    // powershell fallback on every platform — without it the assertion
    // is host-dependent (real powershell.exe only when ComSpec points at it).
    it('cmd-fallback: unquoted placeholder gets the call-operator prefix', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const fallbackSpy = vi
        .spyOn(shellUtils, 'getShellConfiguration')
        .mockReturnValue({
          executable: 'powershell',
          argsPrefix: ['-NoProfile', '-Command'],
          shell: 'powershell',
        });
      try {
        const hookConfig: HookConfig = {
          type: HookType.Command,
          command: '$CLAUDE_PROJECT_DIR/scripts/x.cmd',
          source: HooksConfigSource.Project,
        };
        const input = createMockInput({ cwd: '/test/project' });
        await hookRunner.executeHook(
          hookConfig,
          HookEventName.PreToolUse,
          input,
        );
        const spawnCall = mockSpawn.mock.calls[0];
        expect(spawnCall[1][0]).toBe('-NoProfile');
        expect(spawnCall[1][1]).toBe('-Command');
        // The bareword tail after the placeholder is absorbed into one
        // quoted token: PowerShell can't merge `'<cwd>'/tail`.
        expect(spawnCall[1][2]).toBe("& '/test/project/scripts/x.cmd'");
      } finally {
        fallbackSpy.mockRestore();
      }
    });

    // Author wrote an unquoted placeholder — the explicit-powershell
    // config error shouldn't fire (no quotes in the author's command).
    it('explicit powershell: author-unquoted placeholder runs with the call-operator prefix', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: '$CLAUDE_PROJECT_DIR/scripts/x.cmd',
        shell: 'powershell',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: '/test/project' });
      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );
      expect(result.success).toBe(true);
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe("& '/test/project/scripts/x.cmd'");
    });

    // Author wrote a bare-quoted path explicitly — quote chars in the
    // author's command (not the expanded form) trip the check.
    it('explicit powershell: author bare-quoted path raises the config error', async () => {
      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: '"$CLAUDE_PROJECT_DIR/scripts/x.cmd"',
        shell: 'powershell',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: '/test/project' });
      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/quoted path/i);
    });

    // Pin the powershell backtick-escape character class
    // `[$`"]` with cwds containing the special chars. (Probe-verified all
    // three special chars escape properly; this guards against a future edit
    // dropping `$` or backtick from the class.) The cmd-fallback path wraps
    // a leading-quote command as `& "..."` so the assertion accounts for it.
    describe.each([
      {
        cwd: '/test/pro$ject',
        expected: '& "prefix /test/pro`$ject/suffix"',
      },
      {
        cwd: '/test/pro`ject',
        // The regex replacement `` `$1 `` inserts a literal backtick before
        // every match — so the cwd backtick becomes `\`` (two backticks:
        // the inserted escape + the original).
        expected: '& "prefix /test/pro``ject/suffix"',
      },
      {
        cwd: '/test/pro"ject',
        expected: '& "prefix /test/pro`"ject/suffix"',
      },
    ])(
      'powershell backtick class escapes cwd special chars',
      ({ cwd, expected }) => {
        it(`mid-string $CLAUDE_PROJECT_DIR with cwd ${cwd}`, async () => {
          const mockProcess = createMockProcess(0, 'result');
          mockSpawn.mockImplementation(() => mockProcess);
          const fallbackSpy = mockCmdShellConfig();
          try {
            const hookConfig: HookConfig = {
              type: HookType.Command,
              command: '"prefix $CLAUDE_PROJECT_DIR/suffix"',
              source: HooksConfigSource.Project,
            };
            const input = createMockInput({ cwd });
            await hookRunner.executeHook(
              hookConfig,
              HookEventName.PreToolUse,
              input,
            );
            const spawnCall = mockSpawn.mock.calls[0];
            expect(spawnCall[1][2]).toBe(expected);
          } finally {
            fallbackSpy.mockRestore();
          }
        });
      },
    );

    // Pin the three quote-context branches (outside, in-double, in-single)
    // so the state-machine doesn't regress to a single-shape fix.
    it('outside: single-quote wrap (cmd-fallback)', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const fallbackSpy = mockCmdShellConfig();
      try {
        const hookConfig: HookConfig = {
          type: HookType.Command,
          command: 'echo $CLAUDE_PROJECT_DIR',
          source: HooksConfigSource.Project,
        };
        const input = createMockInput({ cwd: '/test/project' });
        await hookRunner.executeHook(
          hookConfig,
          HookEventName.PreToolUse,
          input,
        );
        const spawnCall = mockSpawn.mock.calls[0];
        expect(spawnCall[1][2]).toBe("echo '/test/project'");
      } finally {
        fallbackSpy.mockRestore();
      }
    });

    it('in-double-mid: backtick-escape, no wrapping (cmd-fallback)', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const fallbackSpy = mockCmdShellConfig();
      try {
        const hookConfig: HookConfig = {
          type: HookType.Command,
          command: '"prefix $CLAUDE_PROJECT_DIR/suffix"',
          source: HooksConfigSource.Project,
        };
        const input = createMockInput({ cwd: '/test/project' });
        await hookRunner.executeHook(
          hookConfig,
          HookEventName.PreToolUse,
          input,
        );
        const spawnCall = mockSpawn.mock.calls[0];
        expect(spawnCall[1][2]).toBe('& "prefix /test/project/suffix"');
      } finally {
        fallbackSpy.mockRestore();
      }
    });

    it('in-single-mid: doubles single quotes, no wrapping (cmd-fallback)', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const fallbackSpy = mockCmdShellConfig();
      try {
        const hookConfig: HookConfig = {
          type: HookType.Command,
          command: "'Get-Content $CLAUDE_PROJECT_DIR/x.json'",
          source: HooksConfigSource.Project,
        };
        const input = createMockInput({ cwd: "/te'st/project" });
        await hookRunner.executeHook(
          hookConfig,
          HookEventName.PreToolUse,
          input,
        );
        const spawnCall = mockSpawn.mock.calls[0];
        expect(spawnCall[1][2]).toBe("& 'Get-Content /te''st/project/x.json'");
      } finally {
        fallbackSpy.mockRestore();
      }
    });

    // Here-string body quotes must not toggle the outer region for a
    // placeholder after the closing delimiter.
    it('keeps the region state across a here-string body with embedded quotes', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const fallbackSpy = mockCmdShellConfig();
      try {
        const hookConfig: HookConfig = {
          type: HookType.Command,
          command:
            "$block = @'\nit's \"quoted\" text\n'@\nWrite-Output $CLAUDE_PROJECT_DIR",
          source: HooksConfigSource.Project,
        };
        const input = createMockInput({ cwd: '/test/project' });
        await hookRunner.executeHook(
          hookConfig,
          HookEventName.PreToolUse,
          input,
        );
        const spawnCall = mockSpawn.mock.calls[0];
        expect(spawnCall[1][2]).toBe(
          "$block = @'\nit's \"quoted\" text\n'@\nWrite-Output '/test/project'",
        );
      } finally {
        fallbackSpy.mockRestore();
      }
    });

    // Here-string close anchored to line start. The body has `''@`
    // (escape for literal `'`) on a non-line-start position; a bare
    // indexOf would close there prematurely. Mutation: revert to bare
    // indexOf → placeholder misclassified.
    it("anchors the here-string close to line start across a body with ''@ escape", async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const fallbackSpy = mockCmdShellConfig();
      try {
        const hookConfig: HookConfig = {
          type: HookType.Command,
          command:
            "$block = @'\ndata ''@token\n'@\nWrite-Output $CLAUDE_PROJECT_DIR",
          source: HooksConfigSource.Project,
        };
        const input = createMockInput({ cwd: '/test/project' });
        await hookRunner.executeHook(
          hookConfig,
          HookEventName.PreToolUse,
          input,
        );
        const spawnCall = mockSpawn.mock.calls[0];
        expect(spawnCall[1][2]).toBe(
          "$block = @'\ndata ''@token\n'@\nWrite-Output '/test/project'",
        );
      } finally {
        fallbackSpy.mockRestore();
      }
    });

    // # comment runs to end of line — quote chars inside must not toggle
    // the region for a placeholder on a later line.
    it('keeps the region state across a # comment with an embedded quote', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const fallbackSpy = mockCmdShellConfig();
      try {
        const hookConfig: HookConfig = {
          type: HookType.Command,
          command:
            'Write-Output "sync start" # don\'t remove\n$CLAUDE_PROJECT_DIR/x.cmd',
          source: HooksConfigSource.Project,
        };
        const input = createMockInput({ cwd: '/test/project' });
        await hookRunner.executeHook(
          hookConfig,
          HookEventName.PreToolUse,
          input,
        );
        const spawnCall = mockSpawn.mock.calls[0];
        // outside region on a fresh statement (line 2) → the placeholder and
        // its bareword tail become one quoted token, plus a per-statement
        // call operator so PowerShell executes it instead of echoing it.
        expect(spawnCall[1][2]).toBe(
          "Write-Output \"sync start\" # don't remove\n& '/test/project/x.cmd'",
        );
      } finally {
        fallbackSpy.mockRestore();
      }
    });

    // Backtick-escaped " inside the author's double-quoted string must
    // not toggle the region — leaves us OUTSIDE → single-quote wrap.
    it('escapes a placeholder after a backtick-escaped quote (cmd-fallback)', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const fallbackSpy = mockCmdShellConfig();
      try {
        const hookConfig: HookConfig = {
          type: HookType.Command,
          command: '"PREFIX`" END" $CLAUDE_PROJECT_DIR/suffix',
          source: HooksConfigSource.Project,
        };
        const input = createMockInput({ cwd: '/test/project' });
        await hookRunner.executeHook(
          hookConfig,
          HookEventName.PreToolUse,
          input,
        );
        const spawnCall = mockSpawn.mock.calls[0];
        // `PREFIX`" END"` carries no path shape → not bare-quoted (no `& `); the
        // region logic is what this pins — placeholder gets a single-quote wrap.
        expect(spawnCall[1][2]).toBe('"PREFIX`" END" \'/test/project/suffix\'');
      } finally {
        fallbackSpy.mockRestore();
      }
    });

    // @"…"@ is EXPANDABLE (variables substitute inside it, backtick-escaped);
    // @'…'@ is verbatim and covered by the sibling tests.
    it('expands a placeholder inside @"…"@ body as double-quoted context', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command:
          '$block = @"data ""$CLAUDE_PROJECT_DIR"" more\n"@\nWrite-Output $CLAUDE_PROJECT_DIR',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: '/test/project' });
      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe(
        '$block = @"data ""/test/project"" more\n"@\nWrite-Output \'/test/project\'',
      );
    });

    // #8649's real shape: shell-less hook, quoted path with spaces under the
    // cmd→powershell fallback — the whole path stays one executable argument.
    it('replays issue #8649 shape: quoted path with spaces under the cmd fallback', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const fallbackSpy = mockCmdShellConfig();
      try {
        const hookConfig: HookConfig = {
          type: HookType.Command,
          command: '"$CLAUDE_PROJECT_DIR/scripts/check.cmd"',
          source: HooksConfigSource.Project,
        };
        const input = createMockInput({ cwd: 'C:\\my prev' });
        await hookRunner.executeHook(
          hookConfig,
          HookEventName.PreToolUse,
          input,
        );
        const spawnCall = mockSpawn.mock.calls[0];
        expect(spawnCall[0]).toBe('powershell');
        expect(spawnCall[1][2]).toBe('& "C:\\my prev/scripts/check.cmd"');
      } finally {
        fallbackSpy.mockRestore();
      }
    });

    // A backtick right before the placeholder escapes it — literal variable
    // text, not a substitution (real pwsh prints `$CLAUDE_PROJECT_DIR`).
    it('keeps a backtick-escaped placeholder literal', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command: 'Write-Output `$CLAUDE_PROJECT_DIR',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: '/test/project' });
      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe('Write-Output `$CLAUDE_PROJECT_DIR');
    });

    // `;` is the same statement separator as `\n`; `>`/`|` need no
    // disqualification either — a bare-quoted path followed by them still
    // executes with the `& ` prefix.
    it.each([
      ['a semicolon', '"C:/tools/build.cmd"; echo done'],
      ['a redirect', '"C:/tools/build.cmd" > build.log'],
      ['a pipe', '"C:/tools/build.cmd" | Out-Null'],
    ])(
      'keeps the & prefix with a bare-quoted path before %s',
      async (_label, command) => {
        const mockProcess = createMockProcess(0, 'result');
        mockSpawn.mockImplementation(() => mockProcess);
        const fallbackSpy = mockCmdShellConfig();
        try {
          const hookConfig: HookConfig = {
            type: HookType.Command,
            command,
            source: HooksConfigSource.Project,
          };
          const input = createMockInput({ cwd: '/test/project' });
          await hookRunner.executeHook(
            hookConfig,
            HookEventName.PreToolUse,
            input,
          );
          const spawnCall = mockSpawn.mock.calls[0];
          expect(spawnCall[1][2]).toBe(`& ${command}`);
        } finally {
          fallbackSpy.mockRestore();
        }
      },
    );

    // Both placeholders substitute in ONE pass over the ORIGINAL command — the
    // second must not re-scan quotes the first substitution inserted.
    it('substitutes both placeholders without cross-contamination', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const fallbackSpy = mockCmdShellConfig();
      try {
        const hookConfig: HookConfig = {
          type: HookType.Command,
          command:
            '$GEMINI_PROJECT_DIR/gen.cmd "$CLAUDE_PROJECT_DIR/claude.cmd"',
          source: HooksConfigSource.Project,
        };
        const input = createMockInput({ cwd: '/test/project' });
        await hookRunner.executeHook(
          hookConfig,
          HookEventName.PreToolUse,
          input,
        );
        const spawnCall = mockSpawn.mock.calls[0];
        expect(spawnCall[1][2]).toBe(
          '& \'/test/project/gen.cmd\' "/test/project/claude.cmd"',
        );
      } finally {
        fallbackSpy.mockRestore();
      }
    });

    // Backtick also escapes the placeholder inside @"…"@ — the body is skipped
    // wholesale, so the escape is read at the jump point.
    it('keeps a backtick-escaped placeholder literal inside @"…"@ body', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command:
          '$block = @"path is `$CLAUDE_PROJECT_DIR now\n"@\nWrite-Output $block',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: '/test/project' });
      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe(
        '$block = @"path is `$CLAUDE_PROJECT_DIR now\n"@\nWrite-Output $block',
      );
    });

    // The single-pass tail class must not swallow a second adjacent placeholder:
    // `$` is excluded from the tail so $GEMINI_PROJECT_DIR/bin:$CLAUDE_…
    // re-enters the alternation.
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
        '$env:PATH = "/test/project/bin:/test/project/bin"',
      );
    });

    // A quoted lead with no path shape is a string-literal statement — no `& `
    // (which would fail: the term is not recognized), keep ordinary echo.
    it('does not call-operate a non-path quoted string statement (cmd fallback)', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const fallbackSpy = mockCmdShellConfig();
      try {
        const hookConfig: HookConfig = {
          type: HookType.Command,
          command: "'a string'; Write-Output hi",
          source: HooksConfigSource.Project,
        };
        const input = createMockInput({ cwd: '/test/project' });
        await hookRunner.executeHook(
          hookConfig,
          HookEventName.PreToolUse,
          input,
        );
        const spawnCall = mockSpawn.mock.calls[0];
        expect(spawnCall[1][2]).toBe("'a string'; Write-Output hi");
      } finally {
        fallbackSpy.mockRestore();
      }
    });

    // <#…#> content is opaque, placeholder inside body is literal.
    it('keeps <#…#> block-comment body opaque', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command:
          '<# comment with "quote" and $CLAUDE_PROJECT_DIR inside #>\nWrite-Output $CLAUDE_PROJECT_DIR',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: '/test/project' });
      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe(
        '<# comment with "quote" and $CLAUDE_PROJECT_DIR inside #>\nWrite-Output \'/test/project\'',
      );
    });

    // Bareword `#` (fix#123) must NOT start a comment. R8-17 covers
    // `#` at token boundary; this is the bareword case.
    it('does not treat # inside a bareword as a comment start', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command: 'git log --grep=fix#123 "$CLAUDE_PROJECT_DIR"',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: '/test/project' });
      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe('git log --grep=fix#123 "/test/project"');
    });

    // `#` after one of the widened token-boundary chars ({,},[,],=,,)
    // starts a comment. The comment skip eats the opening `"`, so a
    // placeholder later on the line is outside any quote region and gets
    // wrapped. Mutation: revert the class to ["'();|&>] → `#` is literal,
    // the `"` opens a string and the placeholder stays unwrapped — red.
    it('treats # after = as a comment start', async () => {
      const mockProcess = createMockProcess(0, 'result');
      mockSpawn.mockImplementation(() => mockProcess);
      const hookConfig: HookConfig = {
        type: HookType.Command,
        shell: 'powershell',
        command: 'x=#comment "echo $CLAUDE_PROJECT_DIR"',
        source: HooksConfigSource.Project,
      };
      const input = createMockInput({ cwd: '/test/project' });
      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1][2]).toBe(`x=#comment "echo '/test/project'"`);
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
      // An unquoted command needs no `&` call-operator prefix — only a
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
        // An unquoted command needs no `&` call-operator prefix — only a
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

    // The alternation's new match class — a leading quote embedding the
    // OTHER quote type — is only treated as a bare-quoted path when it
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

    // Apostrophe-containing cwd: expansion wraps in single quotes with
    // doubled inner `'` — the expanded form is still bare-quoted.
    it('still treats a bare-quoted command as bare when the cwd has apostrophes (cmd fallback)', async () => {
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
        // cwd + bareword tail form one quoted token; apostrophes double up
        // inside the single-quoted expansion.
        expect(spawnArgs[1][2]).toBe("& '/te''st/project/scripts/x.cmd'");
      } finally {
        spy.mockRestore();
      }
    });

    it('expands a quoted project-dir placeholder without injecting single quotes on the cmd fallback', async () => {
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
        // The quoted placeholder expands into the author's double quotes as one
        // valid PowerShell string, then the fallback prefixes the call operator.
        expect(spawnArgs[1][2]).toBe('& "/test/project/scripts/validate.cmd"');
      } finally {
        spy.mockRestore();
      }
    });

    it('expands a quoted project-dir placeholder for an explicit powershell shell', async () => {
      mockSpawn.mockImplementation(() => createMockProcess(0));
      await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: '& "$CLAUDE_PROJECT_DIR/scripts/validate.cmd"',
          source: HooksConfigSource.Project,
          shell: 'powershell',
        },
        HookEventName.PreToolUse,
        createMockInput({ cwd: '/test/project' }),
      );
      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[0]).toBe('powershell');
      expect(spawnArgs[1][2]).toBe('& "/test/project/scripts/validate.cmd"');
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
});
