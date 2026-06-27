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
      expect(result.outcome).toBe('success');
      expect(result.output?.decision).toBe('allow');
      expect(mockCallback).toHaveBeenCalledWith(input, undefined);
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
        { signal: controller.signal },
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
        undefined,
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

    it('should reject invalid callback', async () => {
      const config = createMockConfig(
        'not a function' as unknown as FunctionHookConfig['callback'],
      );
      const input = createMockInput();

      const result = await functionRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Invalid callback');
    });

    it('should handle abort signal during execution', async () => {
      const controller = new AbortController();
      const mockCallback = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            // Abort after a short delay
            setTimeout(() => {
              controller.abort();
            }, 10);
            // Resolve after a longer delay
            setTimeout(() => resolve({ continue: true }), 100);
          }),
      );

      const config = createMockConfig(mockCallback, { timeout: 5000 });
      const input = createMockInput();

      const result = await functionRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
        { signal: controller.signal },
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('aborted');
    });

    it('should properly clean up resources on success', async () => {
      const mockCallback = vi.fn().mockResolvedValue({ continue: true });

      const config = createMockConfig(mockCallback, { timeout: 5000 });
      const input = createMockInput();

      const result = await functionRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      // No timeout should fire after success
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(result.success).toBe(true);
    });

    it('should support boolean semantics (true=success)', async () => {
      const mockCallback = vi.fn().mockResolvedValue(true);
      const config = createMockConfig(mockCallback);
      const input = createMockInput();

      const result = await functionRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('success');
      expect(result.output).toEqual({ continue: true });
    });

    it('should support boolean semantics (false=blocking)', async () => {
      const mockCallback = vi.fn().mockResolvedValue(false);
      const config = createMockConfig(mockCallback, {
        errorMessage: 'Validation failed',
      });
      const input = createMockInput();

      const result = await functionRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('blocking');
      expect(result.output?.continue).toBe(false);
      expect(result.output?.decision).toBe('block');
      expect(result.output?.reason).toBe('Validation failed');
    });

    it('should pass context to callback', async () => {
      const mockCallback = vi.fn().mockResolvedValue(true);
      const config = createMockConfig(mockCallback);
      const input = createMockInput();
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ];

      await functionRunner.execute(config, HookEventName.PreToolUse, input, {
        messages,
        toolUseID: 'tool-123',
      });

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          session_id: 'test-session',
          cwd: '/test',
        }),
        {
          messages,
          toolUseID: 'tool-123',
          signal: undefined,
        },
      );
    });

    it('should call onHookSuccess callback on success', async () => {
      const mockCallback = vi.fn().mockResolvedValue(true);
      const onSuccess = vi.fn();
      const config = createMockConfig(mockCallback, {
        onHookSuccess: onSuccess,
      });
      const input = createMockInput();

      const result = await functionRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(onSuccess).toHaveBeenCalledWith(result);
    });

    it('should not call onHookSuccess on failure', async () => {
      const mockCallback = vi.fn().mockRejectedValue(new Error('Test error'));
      const onSuccess = vi.fn();
      const config = createMockConfig(mockCallback, {
        errorMessage: 'Hook failed',
        onHookSuccess: onSuccess,
      });
      const input = createMockInput();

      await functionRunner.execute(config, HookEventName.PreToolUse, input);

      expect(onSuccess).not.toHaveBeenCalled();
    });

    it('should handle onHookSuccess error gracefully', async () => {
      const mockCallback = vi.fn().mockResolvedValue(true);
      const onSuccess = vi.fn().mockImplementation(() => {
        throw new Error('Success callback error');
      });
      const config = createMockConfig(mockCallback, {
        onHookSuccess: onSuccess,
      });
      const input = createMockInput();

      const result = await functionRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(onSuccess).toHaveBeenCalled();
    });

    it('should determine outcome from HookOutput decision', async () => {
      const mockCallback = vi.fn().mockResolvedValue({
        decision: 'block',
        reason: 'Security violation',
      });
      const config = createMockConfig(mockCallback);
      const input = createMockInput();

      const result = await functionRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('blocking');
      expect(result.output?.decision).toBe('block');
    });

    it('should determine outcome from HookOutput continue=false', async () => {
      const mockCallback = vi.fn().mockResolvedValue({
        continue: false,
        stopReason: 'Please stop',
      });
      const config = createMockConfig(mockCallback);
      const input = createMockInput();

      const result = await functionRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('blocking');
      expect(result.output?.continue).toBe(false);
    });

    it('should treat undefined return as success', async () => {
      const mockCallback = vi.fn().mockResolvedValue(undefined);
      const config = createMockConfig(mockCallback);
      const input = createMockInput();

      const result = await functionRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('success');
      expect(result.output).toEqual({ continue: true });
    });

    it('should handle async callback with context', async () => {
      const mockCallback = vi
        .fn()
        .mockImplementation(async (_input, context) => {
          expect(context).toBeDefined();
          expect(context?.messages).toEqual([{ role: 'user' }]);
          return true;
        });

      const config = createMockConfig(mockCallback);
      const input = createMockInput();

      const result = await functionRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
        { messages: [{ role: 'user' }] },
      );

      expect(result.success).toBe(true);
      expect(mockCallback).toHaveBeenCalledTimes(1);
    });
  });
});
