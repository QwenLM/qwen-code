/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookRunner } from './hookRunner.js';
import {
  HookEventName,
  HookType,
  HooksConfigSource,
  PermissionMode,
} from './types.js';
import type { HookConfig, HookInput } from './types.js';

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
    permission_mode: PermissionMode.Default,
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
});
