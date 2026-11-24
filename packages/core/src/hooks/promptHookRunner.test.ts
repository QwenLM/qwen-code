/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromptHookRunner } from './promptHookRunner.js';
import {
  DEFAULT_PROMPT_HOOK_TIMEOUT_SECONDS,
  describeHookTimeout,
} from './hook-timeout.js';
import { HookEventName, HookType } from './types.js';
import type { PromptHookConfig, HookInput } from './types.js';
import type { Config } from '../config/config.js';
import {
  FinishReason,
  type GenerateContentResponse,
  type Part,
} from '@google/genai';

describe('PromptHookRunner', () => {
  let promptRunner: PromptHookRunner;
  let mockConfig: Config;
  let mockGenerateContent: ReturnType<typeof vi.fn>;
  let mockResolveForModel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockGenerateContent = vi.fn();
    mockResolveForModel = vi.fn().mockResolvedValue({
      contentGenerator: {
        generateContent: mockGenerateContent,
      },
      contentGeneratorConfig: { model: 'qwen-max' },
      model: 'qwen-max',
    });

    mockConfig = {
      getFastModel: vi.fn().mockReturnValue('qwen-turbo'),
      getModel: vi.fn().mockReturnValue('qwen-plus'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        model: 'qwen-plus',
      }),
      getContentGenerator: vi.fn().mockReturnValue({
        generateContent: mockGenerateContent,
        generateContentStream: vi.fn(),
        embedContent: vi.fn(),
      }),
      getBaseLlmClient: vi.fn().mockReturnValue({
        resolveForModel: mockResolveForModel,
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

  /** One assistant candidate holding `text` (or the given parts). */
  const createMockResponse = (
    text: string | Part[],
    finishReason?: FinishReason,
  ): GenerateContentResponse =>
    ({
      candidates: [
        {
          content: {
            parts: typeof text === 'string' ? [{ text }] : text,
            role: 'assistant',
          },
          ...(finishReason && { finishReason }),
        },
      ],
    }) as GenerateContentResponse;

  /** Executes a PreToolUse prompt hook built from the given overrides. */
  const run = (
    config: Partial<PromptHookConfig> = {},
    input: Partial<HookInput> = {},
    signal?: AbortSignal,
  ) =>
    promptRunner.execute(
      createMockConfig(config),
      HookEventName.PreToolUse,
      createMockInput(input),
      signal,
    );

  /** Runs with the model answering `text`. */
  const runWith = (
    text: string | Part[],
    config?: Partial<PromptHookConfig>,
    input?: Partial<HookInput>,
  ) => {
    mockGenerateContent.mockResolvedValue(createMockResponse(text));
    return run(config, input);
  };

  /** The request sent to generateContent for an `ok: true` run. */
  const requestFor = async (
    config?: Partial<PromptHookConfig>,
    input?: Partial<HookInput>,
  ) => {
    await runWith('{"ok": true}', config, input);
    return mockGenerateContent.mock.calls[0][0];
  };

  const promptTextFor = async (
    config: Partial<PromptHookConfig>,
    input: Partial<HookInput>,
  ) =>
    (await requestFor(config, input)).contents?.[0]?.parts?.[0]?.text as string;

  const withFakeTimers = async <T>(fn: () => Promise<T>): Promise<T> => {
    vi.useFakeTimers();
    try {
      return await fn();
    } finally {
      vi.useRealTimers();
    }
  };

  describe('execute', () => {
    it('should execute prompt hook successfully with ok:true', async () => {
      const result = await runWith('{"ok": true}');

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('success');
      expect(result.output?.decision).toBe('allow');
      expect(mockGenerateContent).toHaveBeenCalled();
    });

    it('should execute prompt hook with blocking decision ok:false', async () => {
      const result = await runWith(
        '{"ok": false, "reason": "Security violation"}',
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('blocking');
      expect(result.output?.decision).toBe('block');
      expect(result.output?.reason).toBe('Security violation');
    });

    it('should handle response with additionalContext', async () => {
      const result = await runWith(
        '{"ok": true, "additionalContext": "Some useful info"}',
      );

      expect(result.success).toBe(true);
      expect(result.output?.hookSpecificOutput?.['additionalContext']).toBe(
        'Some useful info',
      );
    });

    it('should handle blocking response with additionalContext', async () => {
      const result = await runWith(
        '{"ok": false, "reason": "Blocked", "additionalContext": "Context info"}',
      );

      expect(result.success).toBe(false);
      expect(result.output?.reason).toBe('Blocked');
      expect(result.output?.hookSpecificOutput?.['additionalContext']).toBe(
        'Context info',
      );
    });

    it('should replace $ARGUMENTS placeholder with JSON input', async () => {
      const promptText = await promptTextFor(
        { prompt: 'Analyze this input: $ARGUMENTS and make a decision.' },
        { cwd: '/custom/path' },
      );

      expect(promptText).toContain('/custom/path');
      expect(promptText).not.toContain('$ARGUMENTS');
    });

    it('should use main model by default for API compatibility', async () => {
      // Main model (getModel) for reliability: the user is already authenticated with it.
      expect((await requestFor()).model).toBe('qwen-plus');
    });

    it('should use model override from config when specified', async () => {
      const callArg = await requestFor({ model: 'qwen-max' });

      expect(callArg.model).toBe('qwen-max');
      expect(mockResolveForModel).toHaveBeenCalledWith('qwen-max', {
        failClosed: true,
      });
    });

    it('should shape requests for the resolved override model', async () => {
      mockResolveForModel.mockResolvedValue({
        contentGenerator: { generateContent: mockGenerateContent },
        contentGeneratorConfig: {
          model: 'qwen-max',
          reasoning: { effort: 'high' },
        },
        model: 'qwen-max',
      });

      const callArg = await requestFor({ model: 'fast' });
      expect(callArg.model).toBe('qwen-max');
      expect(callArg.config?.temperature).toBeUndefined();
    });

    it('should handle response wrapped in markdown code block', async () => {
      const result = await runWith('```json\n{"ok": true}\n```');

      expect(result.success).toBe(true);
      expect(result.output?.decision).toBe('allow');
    });

    it('should handle invalid JSON response (fail-open)', async () => {
      const result = await runWith('This is not JSON');

      // Fail-open: invalid response defaults to allow
      expect(result.success).toBe(true);
      expect(result.output?.decision).toBe('allow');
    });

    it('should handle empty response', async () => {
      const result = await runWith('');

      // Empty response is treated as non-blocking error
      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.output?.continue).toBe(true);
    });

    it('should treat truncated MAX_TOKENS response as non-blocking error', async () => {
      mockGenerateContent.mockResolvedValue(
        createMockResponse(
          '{"ok": false, "reason": "Bloc',
          FinishReason.MAX_TOKENS,
        ),
      );

      const result = await run();

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.output?.continue).toBe(true);
      expect(result.error?.message).toContain(
        'Response truncated due to token limit',
      );
    });

    it('should handle ContentGenerator not available', async () => {
      vi.mocked(mockConfig.getContentGenerator).mockReturnValue(
        undefined as unknown as ReturnType<
          typeof mockConfig.getContentGenerator
        >,
      );

      const result = await run();

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.error?.message).toContain('ContentGenerator not available');
    });

    it('should handle timeout', async () => {
      // A 5 s response against a 100 ms timeout.
      mockGenerateContent.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(createMockResponse('{"ok": true}')), 5000);
          }),
      );

      const result = await run({ timeout: 0.1 });

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('timeout');
    });

    it('should time out while resolving an override model', async () => {
      await withFakeTimers(async () => {
        let finishResolution: (() => void) | undefined;
        mockResolveForModel.mockReturnValue(
          new Promise((resolve) => {
            finishResolution = () =>
              resolve({
                contentGenerator: { generateContent: mockGenerateContent },
                contentGeneratorConfig: { model: 'qwen-max' },
                model: 'qwen-max',
              });
          }),
        );

        const execution = run({ model: 'qwen-max', timeout: 0.1 });
        await vi.advanceTimersByTimeAsync(100);
        const result = await execution;

        expect(result.outcome).toBe('timeout');
        finishResolution?.();
        await Promise.resolve();
        expect(mockGenerateContent).not.toHaveBeenCalled();
      });
    });

    it('should handle abort signal (already aborted)', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await run({}, {}, controller.signal);

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('cancelled');
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('should include hook name in error when blocking', async () => {
      const result = await runWith('{"ok": false, "reason": "Blocked"}', {
        name: 'security-check',
      });

      expect(result.success).toBe(false);
      expect(result.output?.stopReason).toBe('Blocked');
    });

    it('should use default reason when ok:false without reason', async () => {
      const result = await runWith('{"ok": false}');

      expect(result.success).toBe(false);
      expect(result.output?.reason).toBe('Blocked by prompt hook');
    });

    it('should handle LLM error gracefully (non-blocking)', async () => {
      mockGenerateContent.mockRejectedValue(new Error('LLM API error'));

      const result = await run();

      // LLM errors are non-blocking (fail-open)
      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.output?.continue).toBe(true);
    });

    it('should pass system instruction with response format requirements', async () => {
      const systemInstruction = (await requestFor()).config?.systemInstruction;

      expect(systemInstruction).toBeDefined();
      expect(systemInstruction?.parts?.[0]?.text).toContain('valid JSON');
      expect(systemInstruction?.parts?.[0]?.text).toContain('ok');
    });

    it('should pass deterministic generation config for non-reasoning models', async () => {
      const callArg = await requestFor();

      // Deterministic, so allow/block gating is reliable across identical inputs.
      expect(callArg.config?.temperature).toBe(0);
      // The output is a tiny JSON object: cap tokens against runaway generations and cost.
      expect(callArg.config?.maxOutputTokens).toBe(500);
      // Prompt hooks must explicitly disable inherited reasoning.
      expect(callArg.config?.reasoning).toBe(false);
      // Thoughts are stripped post-hoc; don't pay to generate them.
      expect(callArg.config?.thinkingConfig).toEqual({
        includeThoughts: false,
      });
    });

    it('should omit temperature override for reasoning models', async () => {
      vi.mocked(mockConfig.getModel).mockReturnValue('o3');
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        model: 'o3',
        reasoning: { effort: 'high' },
      });

      const callArg = await requestFor();
      expect(callArg.config?.temperature).toBeUndefined();
      expect(callArg.config?.maxOutputTokens).toBe(500);
      expect(callArg.config?.reasoning).toBe(false);
      expect(callArg.config?.thinkingConfig).toEqual({
        includeThoughts: false,
      });
    });

    it('should track duration correctly', async () => {
      await withFakeTimers(async () => {
        vi.setSystemTime(0);
        const mockResponse = createMockResponse('{"ok": true}');
        mockGenerateContent.mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve(mockResponse), 50);
            }),
        );

        const execution = run();
        await vi.advanceTimersByTimeAsync(50);
        const result = await execution;

        expect(result.duration).toBe(50);
      });
    });

    it('should handle multiple $ARGUMENTS placeholders', async () => {
      const promptText = await promptTextFor(
        { prompt: 'First: $ARGUMENTS, Second: $ARGUMENTS' },
        { cwd: '/test/path' },
      );

      // Both placeholders should be replaced
      expect(promptText).toContain('/test/path');
      expect(promptText).not.toContain('$ARGUMENTS');
    });

    it('should handle special $ patterns in JSON without corruption', async () => {
      // cwd carries $ patterns that String.replace() would interpret; they must stay literal.
      const promptText = await promptTextFor(
        { prompt: 'Input: $ARGUMENTS' },
        { cwd: "/path/$& matched $` before $' after $$ dollar" },
      );

      expect(promptText).toContain('$&');
      expect(promptText).toContain('$`');
      expect(promptText).toContain("$'");
      expect(promptText).toContain('$$');
      expect(promptText).toContain('matched');
      expect(promptText).not.toContain('$ARGUMENTS');
    });

    it('should handle response with thought parts filtered out', async () => {
      const result = await runWith([
        { thought: true, text: 'internal reasoning' },
        { text: '{"ok": true}' },
      ]);

      expect(result.success).toBe(true);
      expect(result.output?.decision).toBe('allow');
    });
  });

  describe('outcome', () => {
    /** A generateContent that settles only when its request is aborted. */
    const rejectOnRequestAbort = (message: string) =>
      mockGenerateContent.mockImplementation(
        (request: { config: { abortSignal: AbortSignal } }) =>
          new Promise((_, reject) => {
            request.config.abortSignal.addEventListener('abort', () =>
              reject(new Error(message)),
            );
          }),
      );

    it('reports its own timeout as timeout', async () => {
      await withFakeTimers(async () => {
        mockGenerateContent.mockReturnValue(new Promise(() => {}));

        const execution = run({ timeout: 0.1 });
        await vi.advanceTimersByTimeAsync(100);
        const result = await execution;

        expect(result.outcome).toBe('timeout');
        expect(result.success).toBe(false);
        expect(result.error?.message).toBe('Prompt hook timed out after 100ms');
      });
    });

    it('reports a timeout as timeout even when the aborted request rejects first', async () => {
      await withFakeTimers(async () => {
        rejectOnRequestAbort('Request was aborted.');

        const execution = run({ timeout: 0.1 });
        await vi.advanceTimersByTimeAsync(100);
        const result = await execution;

        expect(result.outcome).toBe('timeout');
      });
    });

    it('reports a caller abort during the request as cancelled', async () => {
      rejectOnRequestAbort('Request was aborted.');
      const controller = new AbortController();

      const execution = run({ timeout: 60 }, {}, controller.signal);
      await vi.waitFor(() => expect(mockGenerateContent).toHaveBeenCalled());
      controller.abort();
      const result = await execution;

      expect(result.outcome).toBe('cancelled');
      expect(result.success).toBe(false);
    });

    it('reports a provider error that mentions an abort as a failure, not a cancel', async () => {
      mockGenerateContent.mockRejectedValue(
        new Error('Request aborted by server'),
      );

      const result = await run({}, {}, new AbortController().signal);

      expect(result.outcome).toBe('non_blocking_error');
    });

    it('reports a provider error that mentions a timeout as a failure, not a timeout', async () => {
      mockGenerateContent.mockRejectedValue(new Error('upstream timed out'));

      const result = await run();

      expect(result.outcome).toBe('non_blocking_error');
    });
  });

  describe('timeout matches describeHookTimeout', () => {
    /** Under fake timers: still pending after `pendingMs`, and the outcome 1 ms later. */
    const runUntil = (
      config: Partial<PromptHookConfig>,
      pendingMs: number,
    ): Promise<{ pendingAfter: boolean; outcome: string | undefined }> =>
      withFakeTimers(async () => {
        mockGenerateContent.mockReturnValue(new Promise(() => {}));
        let settled = false;
        const execution = run(config).then((result) => {
          settled = true;
          return result;
        });
        await vi.advanceTimersByTimeAsync(pendingMs);
        const pendingAfter = !settled;
        await vi.advanceTimersByTimeAsync(1);
        const result = await execution;
        return { pendingAfter, outcome: result.outcome };
      });

    it('times out a configured value in seconds at the described delay', async () => {
      expect(describeHookTimeout(HookType.Prompt, 1).timeoutMs).toBe(1000);
      expect(await runUntil({ timeout: 1 }, 999)).toEqual({
        pendingAfter: true,
        outcome: 'timeout',
      });
    });

    it('times out an unconfigured hook at the described default', async () => {
      const defaultMs = DEFAULT_PROMPT_HOOK_TIMEOUT_SECONDS * 1000;
      expect(describeHookTimeout(HookType.Prompt, undefined).timeoutMs).toBe(
        defaultMs,
      );
      expect(await runUntil({}, defaultMs - 1)).toEqual({
        pendingAfter: true,
        outcome: 'timeout',
      });
    });

    it('times out a negative timeout at once, as described', async () => {
      // Real timers: Node runs a negative delay after 1 ms.
      expect(describeHookTimeout(HookType.Prompt, -1)).toEqual({
        timeoutMs: 1,
        source: 'unusable',
        ignoredConfiguredValue: false,
      });
      mockGenerateContent.mockReturnValue(new Promise(() => {}));
      const started = Date.now();
      const result = await run({ timeout: -1 });
      expect(result.outcome).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });

  describe('createPromptHookRunner factory', () => {
    it('should create runner with config', () => {
      const runner = new PromptHookRunner(mockConfig);
      expect(runner).toBeDefined();
    });
  });
});
