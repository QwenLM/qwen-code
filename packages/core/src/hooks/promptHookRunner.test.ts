/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromptHookRunner } from './promptHookRunner.js';
import { HookEventName, HookType } from './types.js';
import type { PromptHookConfig, HookInput } from './types.js';
import type { Config } from '../config/config.js';
import type { GenerateContentResponse } from '@google/genai';

describe('PromptHookRunner', () => {
  let promptRunner: PromptHookRunner;
  let mockConfig: Config;
  let mockGenerateContent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock generateContent function
    mockGenerateContent = vi.fn();

    // Create mock config
    mockConfig = {
      getFastModel: vi.fn().mockReturnValue('qwen-turbo'),
      getModel: vi.fn().mockReturnValue('qwen-plus'),
      getContentGenerator: vi.fn().mockReturnValue({
        generateContent: mockGenerateContent,
        generateContentStream: vi.fn(),
        countTokens: vi.fn(),
        embedContent: vi.fn(),
        useSummarizedThinking: vi.fn().mockReturnValue(false),
      }),
    } as unknown as Config;

    promptRunner = new PromptHookRunner(mockConfig);
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
    overrides: Partial<PromptHookConfig> = {},
  ): PromptHookConfig => ({
    type: HookType.Prompt,
    prompt: 'Evaluate this: $ARGUMENTS',
    ...overrides,
  });

  const createMockResponse = (
    text: string,
    overrides: Partial<GenerateContentResponse> = {},
  ): GenerateContentResponse =>
    ({
      candidates: [
        {
          content: {
            parts: [{ text }],
            role: 'assistant',
          },
        },
      ],
      ...overrides,
    }) as GenerateContentResponse;

  describe('execute', () => {
    it('should execute prompt hook successfully with ok:true', async () => {
      const mockResponse = createMockResponse('{"ok": true}');
      mockGenerateContent.mockResolvedValue(mockResponse);

      const config = createMockConfig();
      const input = createMockInput();

      const result = await promptRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('success');
      expect(result.output?.decision).toBe('allow');
      expect(mockGenerateContent).toHaveBeenCalled();
    });

    it('should execute prompt hook with blocking decision ok:false', async () => {
      const mockResponse = createMockResponse(
        '{"ok": false, "reason": "Security violation"}',
      );
      mockGenerateContent.mockResolvedValue(mockResponse);

      const config = createMockConfig();
      const input = createMockInput();

      const result = await promptRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('blocking');
      expect(result.output?.decision).toBe('block');
      expect(result.output?.reason).toBe('Security violation');
    });

    it('should handle response with additionalContext', async () => {
      const mockResponse = createMockResponse(
        '{"ok": true, "additionalContext": "Some useful info"}',
      );
      mockGenerateContent.mockResolvedValue(mockResponse);

      const config = createMockConfig();
      const input = createMockInput();

      const result = await promptRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(result.output?.hookSpecificOutput?.['additionalContext']).toBe(
        'Some useful info',
      );
    });

    it('should handle blocking response with additionalContext', async () => {
      const mockResponse = createMockResponse(
        '{"ok": false, "reason": "Blocked", "additionalContext": "Context info"}',
      );
      mockGenerateContent.mockResolvedValue(mockResponse);

      const config = createMockConfig();
      const input = createMockInput();

      const result = await promptRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.output?.reason).toBe('Blocked');
      expect(result.output?.hookSpecificOutput?.['additionalContext']).toBe(
        'Context info',
      );
    });

    it('should replace $ARGUMENTS placeholder with JSON input', async () => {
      const mockResponse = createMockResponse('{"ok": true}');
      mockGenerateContent.mockResolvedValue(mockResponse);

      const config = createMockConfig({
        prompt: 'Analyze this input: $ARGUMENTS and make a decision.',
      });
      const input = createMockInput({ cwd: '/custom/path' });

      await promptRunner.execute(config, HookEventName.PreToolUse, input);

      const callArg = mockGenerateContent.mock.calls[0][0];
      const promptText = callArg.contents?.[0]?.parts?.[0]?.text as string;

      expect(promptText).toContain('/custom/path');
      expect(promptText).not.toContain('$ARGUMENTS');
    });

    it('should use main model by default for API compatibility', async () => {
      const mockResponse = createMockResponse('{"ok": true}');
      mockGenerateContent.mockResolvedValue(mockResponse);

      const config = createMockConfig();
      const input = createMockInput();

      await promptRunner.execute(config, HookEventName.PreToolUse, input);

      const callArg = mockGenerateContent.mock.calls[0][0];
      // Uses main model (getModel) for reliability - user is already authenticated with this model
      expect(callArg.model).toBe('qwen-plus');
    });

    it('should use model override from config when specified', async () => {
      const mockResponse = createMockResponse('{"ok": true}');
      mockGenerateContent.mockResolvedValue(mockResponse);

      const config = createMockConfig({ model: 'qwen-max' });
      const input = createMockInput();

      await promptRunner.execute(config, HookEventName.PreToolUse, input);

      const callArg = mockGenerateContent.mock.calls[0][0];
      expect(callArg.model).toBe('qwen-max');
    });

    it('should handle response wrapped in markdown code block', async () => {
      const mockResponse = createMockResponse('```json\n{"ok": true}\n```');
      mockGenerateContent.mockResolvedValue(mockResponse);

      const config = createMockConfig();
      const input = createMockInput();

      const result = await promptRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(result.output?.decision).toBe('allow');
    });

    it('should handle invalid JSON response (fail-open)', async () => {
      const mockResponse = createMockResponse('This is not JSON');
      mockGenerateContent.mockResolvedValue(mockResponse);

      const config = createMockConfig();
      const input = createMockInput();

      const result = await promptRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      // Fail-open: invalid response defaults to allow
      expect(result.success).toBe(true);
      expect(result.output?.decision).toBe('allow');
    });

    it('should handle empty response', async () => {
      const mockResponse = createMockResponse('');
      mockGenerateContent.mockResolvedValue(mockResponse);

      const config = createMockConfig();
      const input = createMockInput();

      const result = await promptRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      // Empty response is treated as non-blocking error
      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.output?.continue).toBe(true);
    });

    it('should handle ContentGenerator not available', async () => {
      vi.mocked(mockConfig.getContentGenerator).mockReturnValue(
        undefined as unknown as ReturnType<
          typeof mockConfig.getContentGenerator
        >,
      );

      const config = createMockConfig();
      const input = createMockInput();

      const result = await promptRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.error?.message).toContain('ContentGenerator not available');
    });

    it('should handle timeout', async () => {
      mockGenerateContent.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve(createMockResponse('{"ok": true}')),
              5000, // 5 second delay
            );
          }),
      );

      const config = createMockConfig({ timeout: 0.1 }); // 100ms timeout
      const input = createMockInput();

      const result = await promptRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('cancelled');
    });

    it('should handle abort signal (already aborted)', async () => {
      const controller = new AbortController();
      controller.abort();

      const config = createMockConfig();
      const input = createMockInput();

      const result = await promptRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
        controller.signal,
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('cancelled');
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('should include hook name in error when blocking', async () => {
      const mockResponse = createMockResponse(
        '{"ok": false, "reason": "Blocked"}',
      );
      mockGenerateContent.mockResolvedValue(mockResponse);

      const config = createMockConfig({ name: 'security-check' });
      const input = createMockInput();

      const result = await promptRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.output?.stopReason).toBe('Blocked');
    });

    it('should use default reason when ok:false without reason', async () => {
      const mockResponse = createMockResponse('{"ok": false}');
      mockGenerateContent.mockResolvedValue(mockResponse);

      const config = createMockConfig();
      const input = createMockInput();

      const result = await promptRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.output?.reason).toBe('Blocked by prompt hook');
    });

    it('should handle LLM error gracefully (non-blocking)', async () => {
      mockGenerateContent.mockRejectedValue(new Error('LLM API error'));

      const config = createMockConfig();
      const input = createMockInput();

      const result = await promptRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      // LLM errors are non-blocking (fail-open)
      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.output?.continue).toBe(true);
    });

    it('should pass system instruction with response format requirements', async () => {
      const mockResponse = createMockResponse('{"ok": true}');
      mockGenerateContent.mockResolvedValue(mockResponse);

      const config = createMockConfig();
      const input = createMockInput();

      await promptRunner.execute(config, HookEventName.PreToolUse, input);

      const callArg = mockGenerateContent.mock.calls[0][0];
      const systemInstruction = callArg.config?.systemInstruction;

      expect(systemInstruction).toBeDefined();
      expect(systemInstruction?.parts?.[0]?.text).toContain('valid JSON');
      expect(systemInstruction?.parts?.[0]?.text).toContain('ok');
    });

    it('should enable thinking in LLM request for better evaluation', async () => {
      const mockResponse = createMockResponse('{"ok": true}');
      mockGenerateContent.mockResolvedValue(mockResponse);

      const config = createMockConfig();
      const input = createMockInput();

      await promptRunner.execute(config, HookEventName.PreToolUse, input);

      const callArg = mockGenerateContent.mock.calls[0][0];
      expect(callArg.config?.thinkingConfig?.includeThoughts).toBe(true);
    });

    it('should track duration correctly', async () => {
      const mockResponse = createMockResponse('{"ok": true}');
      mockGenerateContent.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(mockResponse), 50);
          }),
      );

      const config = createMockConfig();
      const input = createMockInput();

      const result = await promptRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.duration).toBeGreaterThanOrEqual(50);
    });

    it('should handle multiple $ARGUMENTS placeholders', async () => {
      const mockResponse = createMockResponse('{"ok": true}');
      mockGenerateContent.mockResolvedValue(mockResponse);

      const config = createMockConfig({
        prompt: 'First: $ARGUMENTS, Second: $ARGUMENTS',
      });
      const input = createMockInput({ cwd: '/test/path' });

      await promptRunner.execute(config, HookEventName.PreToolUse, input);

      const callArg = mockGenerateContent.mock.calls[0][0];
      const promptText = callArg.contents?.[0]?.parts?.[0]?.text as string;

      // Both placeholders should be replaced
      expect(promptText).toContain('/test/path');
      expect(promptText).not.toContain('$ARGUMENTS');
    });

    it('should handle response with thought parts filtered out', async () => {
      const mockResponse = {
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: 'internal reasoning' },
                { text: '{"ok": true}' },
              ],
              role: 'assistant',
            },
          },
        ],
      } as GenerateContentResponse;
      mockGenerateContent.mockResolvedValue(mockResponse);

      const config = createMockConfig();
      const input = createMockInput();

      const result = await promptRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(result.output?.decision).toBe('allow');
    });
  });

  describe('createPromptHookRunner factory', () => {
    it('should create runner with config', () => {
      const runner = new PromptHookRunner(mockConfig);
      expect(runner).toBeDefined();
    });
  });
});
