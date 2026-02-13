/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HookRunner, createHookRunner } from './runner.js';
import { HookType, HookEventName } from './types.js';
import type { HookInput, CommandHookConfig } from './types.js';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';

const mockSpawn = vi.mocked(spawn);

describe('HookRunner', () => {
  let runner: HookRunner;
  const mockInput: HookInput = {
    session_id: 'test-session',
    transcript_path: '/test/transcript',
    cwd: '/test',
    hook_event_name: 'PreToolUse',
    timestamp: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    runner = createHookRunner();
    mockSpawn.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('run', () => {
    it('should execute command hook successfully', async () => {
      const mockStdout = JSON.stringify({
        decision: 'allow',
        reason: 'Allowed by policy',
      });

      const mockChildProcess = {
        stdout: {
          on: vi.fn((event, cb) => {
            if (event === 'data') cb(Buffer.from(mockStdout));
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((event, cb) => {
          if (event === 'close') cb(0);
        }),
        stdin: { write: vi.fn(), end: vi.fn() },
      };

      mockSpawn.mockReturnValue(
        mockChildProcess as unknown as ReturnType<typeof spawn>,
      );

      const hookConfig: CommandHookConfig = {
        type: HookType.Command,
        command: 'echo test',
      };

      const result = await runner.run(
        hookConfig,
        mockInput,
        HookEventName.PreToolUse,
      );

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(mockStdout);
    });

    it('should handle command hook failure', async () => {
      const mockChildProcess = {
        stdout: { on: vi.fn() },
        stderr: {
          on: vi.fn((event, cb) => {
            if (event === 'data') cb(Buffer.from('Error occurred'));
          }),
        },
        on: vi.fn((event, cb) => {
          if (event === 'close') cb(1);
        }),
        stdin: { write: vi.fn(), end: vi.fn() },
      };

      mockSpawn.mockReturnValue(
        mockChildProcess as unknown as ReturnType<typeof spawn>,
      );

      const hookConfig: CommandHookConfig = {
        type: HookType.Command,
        command: 'exit 1',
      };

      const result = await runner.run(
        hookConfig,
        mockInput,
        HookEventName.PreToolUse,
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('Error occurred');
    });

    it('should parse JSON output from stdout', async () => {
      const hookOutput = {
        decision: 'block',
        reason: 'Blocked by policy',
        hookSpecificOutput: {
          permissionDecision: 'deny',
        },
      };

      const mockChildProcess = {
        stdout: {
          on: vi.fn((event, cb) => {
            if (event === 'data') cb(Buffer.from(JSON.stringify(hookOutput)));
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((event, cb) => {
          if (event === 'close') cb(0);
        }),
        stdin: { write: vi.fn(), end: vi.fn() },
      };

      mockSpawn.mockReturnValue(
        mockChildProcess as unknown as ReturnType<typeof spawn>,
      );

      const hookConfig: CommandHookConfig = {
        type: HookType.Command,
        command: 'cat',
      };

      const result = await runner.run(
        hookConfig,
        mockInput,
        HookEventName.PreToolUse,
      );

      expect(result.success).toBe(true);
      expect(result.output?.decision).toBe('block');
    });

    it('should handle non-JSON output as system message', async () => {
      const plainText = 'This is a plain text response';

      const mockChildProcess = {
        stdout: {
          on: vi.fn((event, cb) => {
            if (event === 'data') cb(Buffer.from(plainText));
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((event, cb) => {
          if (event === 'close') cb(0);
        }),
        stdin: { write: vi.fn(), end: vi.fn() },
      };

      mockSpawn.mockReturnValue(
        mockChildProcess as unknown as ReturnType<typeof spawn>,
      );

      const hookConfig: CommandHookConfig = {
        type: HookType.Command,
        command: 'echo hello',
      };

      const result = await runner.run(
        hookConfig,
        mockInput,
        HookEventName.PreToolUse,
      );

      expect(result.success).toBe(true);
      expect(result.output?.systemMessage).toBe(plainText);
    });

    it('should handle spawn errors', async () => {
      mockSpawn.mockImplementation(() => {
        throw new Error('Spawn failed');
      });

      const hookConfig: CommandHookConfig = {
        type: HookType.Command,
        command: 'invalid-command',
      };

      const result = await runner.run(
        hookConfig,
        mockInput,
        HookEventName.PreToolUse,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.stderr).toBe('Spawn failed');
    });

    it('should set environment variables correctly', async () => {
      const mockChildProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, cb) => {
          if (event === 'close') cb(0);
        }),
        stdin: { write: vi.fn(), end: vi.fn() },
      };

      mockSpawn.mockReturnValue(
        mockChildProcess as unknown as ReturnType<typeof spawn>,
      );

      const hookConfig: CommandHookConfig = {
        type: HookType.Command,
        command: 'env',
      };

      await runner.run(hookConfig, mockInput, HookEventName.PreToolUse);

      const spawnCall = mockSpawn.mock.calls[0];
      const env = spawnCall[2]?.env as Record<string, string>;

      expect(env['HOOK_SESSION_ID']).toBe('test-session');
      expect(env['HOOK_EVENT_NAME']).toBe('PreToolUse');
      expect(env['HOOK_CWD']).toBe('/test');
      expect(env['HOOK_INPUT']).toBeDefined();
      expect(JSON.parse(env['HOOK_INPUT'])).toEqual(mockInput);
    });

    it('should respect custom timeout', async () => {
      const mockChildProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, cb) => {
          if (event === 'close') cb(0);
        }),
        stdin: { write: vi.fn(), end: vi.fn() },
      };

      mockSpawn.mockReturnValue(
        mockChildProcess as unknown as ReturnType<typeof spawn>,
      );

      const customRunner = createHookRunner({ defaultTimeout: 5000 });
      const hookConfig: CommandHookConfig = {
        type: HookType.Command,
        command: 'sleep 1',
        timeout: 10000,
      };

      await customRunner.run(hookConfig, mockInput, HookEventName.PreToolUse);

      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[2]?.timeout).toBe(10000); // Hook config takes precedence
    });

    it('should throw error for unsupported hook types', async () => {
      const hookConfig = {
        type: 'unsupported' as const,
        command: 'test',
      };

      const result = await runner.run(
        hookConfig as unknown as CommandHookConfig,
        mockInput,
        HookEventName.PreToolUse,
      );

      expect(result.success).toBe(false);
      expect(result.stderr).toContain('Unsupported hook type');
    });
  });

  describe('updateConfig', () => {
    it('should update runner configuration', () => {
      runner.updateConfig({ defaultTimeout: 60000 });
      expect(runner.getConfig().defaultTimeout).toBe(60000);
    });

    it('should merge configuration updates', () => {
      runner.updateConfig({ cwd: '/custom' });
      const config = runner.getConfig();
      expect(config.cwd).toBe('/custom');
    });
  });

  describe('getConfig', () => {
    it('should return a copy of the configuration', () => {
      const config1 = runner.getConfig();
      const config2 = runner.getConfig();
      expect(config1).not.toBe(config2);
      expect(config1).toEqual(config2);
    });
  });
});

describe('createHookRunner', () => {
  it('should create a new HookRunner instance', () => {
    const runner = createHookRunner();
    expect(runner).toBeInstanceOf(HookRunner);
  });

  it('should pass config to runner', () => {
    const runner = createHookRunner({ defaultTimeout: 10000 });
    expect(runner.getConfig().defaultTimeout).toBe(10000);
  });
});
