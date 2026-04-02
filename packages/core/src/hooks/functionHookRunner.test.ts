/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FunctionHookRunner } from './functionHookRunner.js';
import { HookEventName, HookType } from './types.js';
import type { FunctionHookConfig, HookInput, HookOutput } from './types.js';

describe('FunctionHookRunner', () => {
  let functionRunner: FunctionHookRunner;

  beforeEach(() => {
    functionRunner = new FunctionHookRunner();
    vi.clearAllMocks();
  });

  const createMockInput = (overrides: Partial<HookInput> = {}): HookInput => ({
    session_id: 'test-session',
    transcript_path: '/test/transcript',
    cwd: '/test',
    hook_event_name: 'PreToolUse',
    timestamp: '2024-01-01T00:00:00Z',
    ...overrides,
  });

  const createMockConfig = (
    callback: FunctionHookConfig['callback'],
    overrides: Partial<FunctionHookConfig> = {},
  ): FunctionHookConfig => ({
    type: HookType.Function,
    callback,
    errorMessage: 'Hook failed',
    ...overrides,
  });

  describe('execute', () => {
    it('should execute callback successfully', async () => {
      const mockCallback = vi.fn().mockResolvedValue({
        decision: 'allow',
        reason: 'Approved',
      } as HookOutput);

      const config = createMockConfig(mockCallback);
      const input = createMockInput();

      const result = await functionRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(result.output?.decision).toBe('allow');
      expect(mockCallback).toHaveBeenCalledWith(input);
    });

    it('should handle callback returning undefined', async () => {
      const mockCallback = vi.fn().mockResolvedValue(undefined);

      const config = createMockConfig(mockCallback);
      const input = createMockInput();

      const result = await functionRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ continue: true });
    });

    it('should handle callback throwing error', async () => {
      const mockCallback = vi
        .fn()
        .mockRejectedValue(new Error('Callback error'));

      const config = createMockConfig(mockCallback, {
        errorMessage: 'Custom error message',
      });
      const input = createMockInput();

      const result = await functionRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Custom error message');
      expect(result.error?.message).toContain('Callback error');
    });

    it('should handle timeout', async () => {
      const mockCallback = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ continue: true }), 1000);
          }),
      );

      const config = createMockConfig(mockCallback, { timeout: 10 });
      const input = createMockInput();

      const result = await functionRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('timed out');
    });

    it('should handle abort signal', async () => {
      const controller = new AbortController();
      controller.abort();

      const mockCallback = vi.fn().mockResolvedValue({ continue: true });
      const config = createMockConfig(mockCallback);
      const input = createMockInput();

      const result = await functionRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
        controller.signal,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('cancelled');
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should pass correct input to callback', async () => {
      const mockCallback = vi.fn().mockResolvedValue({ continue: true });

      const config = createMockConfig(mockCallback);
      const input = createMockInput({
        session_id: 'custom-session',
        cwd: '/custom/path',
      });

      await functionRunner.execute(config, HookEventName.PreToolUse, input);

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          session_id: 'custom-session',
          cwd: '/custom/path',
        }),
      );
    });

    it('should include hook id in result', async () => {
      const mockCallback = vi.fn().mockResolvedValue({ continue: true });

      const config = createMockConfig(mockCallback, {
        id: 'my-hook-id',
        name: 'My Hook',
      });
      const input = createMockInput();

      const result = await functionRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(result.hookConfig).toEqual(config);
    });
  });
});
