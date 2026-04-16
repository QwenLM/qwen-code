/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromptHookRunner, isPromptHookConfig } from './execPromptHook.js';
import type { Config } from '../config/config.js';
import type { PromptHookConfig } from './types.js';
import { HookEventName } from './types.js';

// Mock types
interface MockConfig {
  getBaseLlmClient: ReturnType<typeof vi.fn>;
  getModel: ReturnType<typeof vi.fn>;
  getFastModel: ReturnType<typeof vi.fn>;
}

interface MockLlmClient {
  generateJson: ReturnType<typeof vi.fn>;
}

describe('PromptHookRunner', () => {
  let mockConfig: MockConfig;
  let mockLlmClient: MockLlmClient;
  let runner: PromptHookRunner;

  beforeEach(() => {
    mockLlmClient = {
      generateJson: vi.fn(),
    };

    mockConfig = {
      getBaseLlmClient: vi.fn().mockReturnValue(mockLlmClient),
      getModel: vi.fn().mockReturnValue('qwen-coder'),
      getFastModel: vi.fn().mockReturnValue('qwen-turbo'),
    };

    runner = new PromptHookRunner(mockConfig as unknown as Config);
  });

  describe('execute', () => {
    const baseHook: PromptHookConfig = {
      type: 'prompt',
      prompt: 'Is this safe? $ARGUMENTS',
      name: 'test-hook',
    };

    const baseInput = {
      session_id: 'test-session',
      cwd: '/test/path',
      tool_name: 'bash',
      command: 'ls',
    };

    it('should return success when LLM returns ok: true', async () => {
      mockLlmClient.generateJson.mockResolvedValue({ ok: true });

      const result = await runner.execute(
        baseHook,
        HookEventName.PreToolUse,
        baseInput,
        new AbortController().signal,
      );

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output?.decision).toBe('allow');
    });

    it('should return blocking error when LLM returns ok: false', async () => {
      mockLlmClient.generateJson.mockResolvedValue({
        ok: false,
        reason: 'Dangerous command detected',
      });

      const result = await runner.execute(
        baseHook,
        HookEventName.PreToolUse,
        baseInput,
        new AbortController().signal,
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(2);
      expect(result.output?.decision).toBe('deny');
      expect(result.output?.reason).toBe('Dangerous command detected');
    });

    it('should use hook-specific model when provided', async () => {
      mockLlmClient.generateJson.mockResolvedValue({ ok: true });

      const hookWithModel: PromptHookConfig = {
        ...baseHook,
        model: 'custom-model',
      };

      await runner.execute(
        hookWithModel,
        HookEventName.PreToolUse,
        baseInput,
        new AbortController().signal,
      );

      expect(mockLlmClient.generateJson).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'custom-model' }),
      );
    });

    it('should use fast model when hook model not specified', async () => {
      mockLlmClient.generateJson.mockResolvedValue({ ok: true });

      await runner.execute(
        baseHook,
        HookEventName.PreToolUse,
        baseInput,
        new AbortController().signal,
      );

      expect(mockLlmClient.generateJson).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'qwen-turbo' }),
      );
    });

    it('should substitute $ARGUMENTS placeholder in prompt', async () => {
      mockLlmClient.generateJson.mockResolvedValue({ ok: true });

      await runner.execute(
        baseHook,
        HookEventName.PreToolUse,
        baseInput,
        new AbortController().signal,
      );

      const callArgs = mockLlmClient.generateJson.mock.calls[0][0];
      const promptText = callArgs.contents[0].parts[0].text;
      expect(promptText).toContain('tool_name');
      expect(promptText).toContain('bash');
    });

    it('should handle aborted signal', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await runner.execute(
        baseHook,
        HookEventName.PreToolUse,
        baseInput,
        controller.signal,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('cancelled');
    });

    it('should handle LLM API errors', async () => {
      mockLlmClient.generateJson.mockRejectedValue(
        new Error('API error: rate limit'),
      );

      const result = await runner.execute(
        baseHook,
        HookEventName.PreToolUse,
        baseInput,
        new AbortController().signal,
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(2); // Blocking error
      expect(result.output?.decision).toBe('deny');
    });

    it('should handle timeout errors', async () => {
      mockLlmClient.generateJson.mockRejectedValue(
        new Error('timeout: request timed out'),
      );

      const result = await runner.execute(
        baseHook,
        HookEventName.PreToolUse,
        baseInput,
        new AbortController().signal,
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(2); // Blocking error for timeout
    });

    it('should include hook-specific output in result', async () => {
      mockLlmClient.generateJson.mockResolvedValue({
        ok: false,
        reason: 'Test reason',
      });

      const result = await runner.execute(
        baseHook,
        HookEventName.PreToolUse,
        baseInput,
        new AbortController().signal,
      );

      expect(result.output?.hookSpecificOutput).toEqual({
        hookEventName: 'PreToolUse',
        ok: false,
        reason: 'Test reason',
      });
    });

    it('should pass system instruction to LLM', async () => {
      mockLlmClient.generateJson.mockResolvedValue({ ok: true });

      await runner.execute(
        baseHook,
        HookEventName.PreToolUse,
        baseInput,
        new AbortController().signal,
      );

      const callArgs = mockLlmClient.generateJson.mock.calls[0][0];
      expect(callArgs.systemInstruction).toBeDefined();
      expect(callArgs.systemInstruction).toContain('Qwen Code');
    });

    it('should pass correct schema to LLM', async () => {
      mockLlmClient.generateJson.mockResolvedValue({ ok: true });

      await runner.execute(
        baseHook,
        HookEventName.PreToolUse,
        baseInput,
        new AbortController().signal,
      );

      const callArgs = mockLlmClient.generateJson.mock.calls[0][0];
      expect(callArgs.schema).toBeDefined();
      expect(callArgs.schema.properties.ok).toBeDefined();
    });
  });
});

describe('isPromptHookConfig', () => {
  it('should return true for prompt hook config', () => {
    const config = { type: 'prompt' as const, prompt: 'test' };
    expect(isPromptHookConfig(config)).toBe(true);
  });

  it('should return false for command hook config', () => {
    const config = { type: 'command' as const, command: 'test' };
    expect(isPromptHookConfig(config)).toBe(false);
  });

  it('should return false for config without type', () => {
    const config = { command: 'test' };
    expect(isPromptHookConfig(config)).toBe(false);
  });
});
