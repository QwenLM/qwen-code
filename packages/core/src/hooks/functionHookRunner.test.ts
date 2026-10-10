/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FunctionHookRunner } from './functionHookRunner.js';
import {
  DEFAULT_FUNCTION_HOOK_TIMEOUT_MS,
  describeHookTimeout,
} from './hook-timeout.js';
import { HookEventName, HookType } from './types.js';
import type { FunctionHookConfig, HookInput, HookOutput } from './types.js';

const neverSettles = () => vi.fn(() => new Promise<never>(() => {}));

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

  /** Runs `callback` as a PreToolUse function hook on the default input. */
  const run = (
    callback: FunctionHookConfig['callback'],
    overrides: Partial<FunctionHookConfig> = {},
    context?: Parameters<FunctionHookRunner['execute']>[3],
  ) =>
    functionRunner.execute(
      createMockConfig(callback, overrides),
      HookEventName.PreToolUse,
      createMockInput(),
      context,
    );

  describe('execute', () => {
    it('should execute callback successfully', async () => {
      const mockCallback = vi.fn().mockResolvedValue({
        decision: 'allow',
        reason: 'Approved',
      } as HookOutput);

      const result = await run(mockCallback);

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('success');
      expect(result.output?.decision).toBe('allow');
      expect(mockCallback).toHaveBeenCalledWith(createMockInput(), undefined);
    });

    it('should handle callback returning undefined', async () => {
      const result = await run(vi.fn().mockResolvedValue(undefined));

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ continue: true });
    });

    it('should handle callback throwing error', async () => {
      const result = await run(
        vi.fn().mockRejectedValue(new Error('Callback error')),
        { errorMessage: 'Custom error message' },
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

      const result = await run(mockCallback, { timeout: 10 });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('timed out');
    });

    it('should handle abort signal', async () => {
      const controller = new AbortController();
      controller.abort();
      const mockCallback = vi.fn().mockResolvedValue({ continue: true });

      const result = await run(mockCallback, {}, { signal: controller.signal });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('cancelled');
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should pass correct input to callback', async () => {
      const mockCallback = vi.fn().mockResolvedValue({ continue: true });
      const input = createMockInput({
        session_id: 'custom-session',
        cwd: '/custom/path',
      });

      await functionRunner.execute(
        createMockConfig(mockCallback),
        HookEventName.PreToolUse,
        input,
      );

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

      const result = await functionRunner.execute(
        config,
        HookEventName.PreToolUse,
        createMockInput(),
      );

      expect(result.success).toBe(true);
      expect(result.hookConfig).toEqual(config);
    });

    it('should reject invalid callback', async () => {
      const result = await run(
        'not a function' as unknown as FunctionHookConfig['callback'],
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Invalid callback');
    });

    it('should handle abort signal during execution', async () => {
      const controller = new AbortController();
      // Aborts at 10ms, well before the callback would resolve at 100ms.
      const mockCallback = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => controller.abort(), 10);
            setTimeout(() => resolve({ continue: true }), 100);
          }),
      );

      const result = await run(
        mockCallback,
        { timeout: 5000 },
        { signal: controller.signal },
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('aborted');
    });

    it('should properly clean up resources on success', async () => {
      const result = await run(vi.fn().mockResolvedValue({ continue: true }), {
        timeout: 5000,
      });

      expect(result.success).toBe(true);
      // No timeout should fire after success
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(result.success).toBe(true);
    });

    it('should support boolean semantics (true=success)', async () => {
      const result = await run(vi.fn().mockResolvedValue(true));

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('success');
      expect(result.output).toEqual({ continue: true });
    });

    it('should support boolean semantics (false=blocking)', async () => {
      const result = await run(vi.fn().mockResolvedValue(false), {
        errorMessage: 'Validation failed',
      });

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('blocking');
      expect(result.output?.continue).toBe(false);
      expect(result.output?.decision).toBe('block');
      expect(result.output?.reason).toBe('Validation failed');
    });

    it('should pass context to callback', async () => {
      const mockCallback = vi.fn().mockResolvedValue(true);
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ];

      await run(mockCallback, {}, { messages, toolUseID: 'tool-123' });

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
      const onSuccess = vi.fn();

      const result = await run(vi.fn().mockResolvedValue(true), {
        onHookSuccess: onSuccess,
      });

      expect(result.success).toBe(true);
      expect(onSuccess).toHaveBeenCalledWith(result);
    });

    it('should not call onHookSuccess on failure', async () => {
      const onSuccess = vi.fn();

      await run(vi.fn().mockRejectedValue(new Error('Test error')), {
        errorMessage: 'Hook failed',
        onHookSuccess: onSuccess,
      });

      expect(onSuccess).not.toHaveBeenCalled();
    });

    it('should handle onHookSuccess error gracefully', async () => {
      const onSuccess = vi.fn().mockImplementation(() => {
        throw new Error('Success callback error');
      });

      const result = await run(vi.fn().mockResolvedValue(true), {
        onHookSuccess: onSuccess,
      });

      expect(result.success).toBe(true);
      expect(onSuccess).toHaveBeenCalled();
    });

    it('should determine outcome from HookOutput decision', async () => {
      const result = await run(
        vi.fn().mockResolvedValue({
          decision: 'block',
          reason: 'Security violation',
        }),
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('blocking');
      expect(result.output?.decision).toBe('block');
    });

    it('should determine outcome from HookOutput continue=false', async () => {
      const result = await run(
        vi
          .fn()
          .mockResolvedValue({ continue: false, stopReason: 'Please stop' }),
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('blocking');
      expect(result.output?.continue).toBe(false);
    });

    it('should treat undefined return as success', async () => {
      const result = await run(vi.fn().mockResolvedValue(undefined));

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

      const result = await run(
        mockCallback,
        {},
        { messages: [{ role: 'user' }] },
      );

      expect(result.success).toBe(true);
      expect(mockCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('outcome', () => {
    /** Runs a never-settling callback with a 50ms timeout on fake timers. */
    const timedOut = async (overrides: Partial<FunctionHookConfig> = {}) => {
      vi.useFakeTimers();
      try {
        const execution = run(neverSettles(), { timeout: 50, ...overrides });
        await vi.advanceTimersByTimeAsync(50);
        return await execution;
      } finally {
        vi.useRealTimers();
      }
    };

    it('reports its own timeout as timeout', async () => {
      const result = await timedOut();

      expect(result.outcome).toBe('timeout');
      expect(result.success).toBe(false);
    });

    it('reports a caller abort during the callback as cancelled', async () => {
      const controller = new AbortController();
      const callback = neverSettles();

      const execution = run(
        callback,
        { timeout: 60_000 },
        { signal: controller.signal },
      );
      await vi.waitFor(() => expect(callback).toHaveBeenCalled());
      controller.abort();
      const result = await execution;

      expect(result.outcome).toBe('cancelled');
      expect(result.success).toBe(false);
    });

    it('reports a callback that throws as a non-blocking error', async () => {
      const result = await run(
        vi.fn().mockRejectedValue(new Error('timed out')),
      );

      expect(result.outcome).toBe('non_blocking_error');
    });

    it('keeps the configured error message prefix on a timeout', async () => {
      const result = await timedOut({ errorMessage: 'Policy check failed' });

      expect(result.error?.message).toBe(
        'Policy check failed: Function hook timed out after 50ms',
      );
    });

    it('reports a caller abort before the callback as cancelled', async () => {
      const controller = new AbortController();
      controller.abort();
      const callback = vi.fn();

      const result = await run(callback, {}, { signal: controller.signal });

      expect(result.outcome).toBe('cancelled');
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('timeout matches describeHookTimeout', () => {
    /** On fake timers: still pending after `pendingMs`, and the outcome 1ms later. */
    const runUntil = async (
      overrides: Partial<FunctionHookConfig>,
      pendingMs: number,
    ): Promise<{ pendingAfter: boolean; outcome: string | undefined }> => {
      vi.useFakeTimers();
      try {
        let settled = false;
        const execution = run(neverSettles(), overrides).then((result) => {
          settled = true;
          return result;
        });
        await vi.advanceTimersByTimeAsync(pendingMs);
        const pendingAfter = !settled;
        await vi.advanceTimersByTimeAsync(1);
        const result = await execution;
        return { pendingAfter, outcome: result.outcome };
      } finally {
        vi.useRealTimers();
      }
    };

    it('times out a configured value in milliseconds at the described delay', async () => {
      const described = describeHookTimeout(HookType.Function, 60);
      expect(described.timeoutMs).toBe(60);
      expect(await runUntil({ timeout: 60 }, 59)).toEqual({
        pendingAfter: true,
        outcome: 'timeout',
      });
    });

    it('times out an unconfigured hook at the described default', async () => {
      const described = describeHookTimeout(HookType.Function, undefined);
      expect(described.timeoutMs).toBe(DEFAULT_FUNCTION_HOOK_TIMEOUT_MS);
      expect(await runUntil({}, DEFAULT_FUNCTION_HOOK_TIMEOUT_MS - 1)).toEqual({
        pendingAfter: true,
        outcome: 'timeout',
      });
    });

    it('times out a zero timeout at once, as described', async () => {
      // Real timers: Node runs a 0 ms timer after 1 ms, fake timers do not.
      expect(describeHookTimeout(HookType.Function, 0)).toEqual({
        timeoutMs: 1,
        source: 'unusable',
        ignoredConfiguredValue: false,
      });
      const started = Date.now();
      const result = await run(neverSettles(), { timeout: 0 });
      expect(result.outcome).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });
});
