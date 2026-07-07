/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HookRunner } from './hookRunner.js';
import { HookEventName, HookType, PermissionMode } from './types.js';
import type {
  HookDefinition,
  PromptHookConfig,
  PreToolUseInput,
} from './types.js';
import type { Config } from '../config/config.js';

/**
 * Integration tests for Prompt Hook functionality
 * These tests verify the full hook execution pipeline with prompt hooks
 */
describe('Prompt Hook Integration', () => {
  let hookRunner: HookRunner;
  let mockConfig: Config;
  let mockGenerateContent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock generateContent function
    mockGenerateContent = vi.fn();

    // Create mock config with content generator
    mockConfig = {
      getFastModel: vi.fn().mockReturnValue('qwen-turbo'),
      getModel: vi.fn().mockReturnValue('qwen-plus'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        model: 'qwen-plus',
      }),
      getContentGenerator: vi.fn().mockReturnValue({
        generateContent: mockGenerateContent,
        generateContentStream: vi.fn(),
        countTokens: vi.fn(),
        embedContent: vi.fn(),
        useSummarizedThinking: vi.fn().mockReturnValue(false),
      }),
      getProjectRoot: vi.fn().mockReturnValue('/test/project'),
      getAllowedHttpHookUrls: vi.fn().mockReturnValue([]),
      getHooks: vi.fn().mockReturnValue({}),
    } as unknown as Config;

    hookRunner = new HookRunner(undefined, mockConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createPreToolUseInput = (
    toolName: string,
    toolInput: Record<string, unknown>,
  ): PreToolUseInput => ({
    session_id: 'test-session-123',
    transcript_path: '/test/transcript.json',
    cwd: '/test/project',
    hook_event_name: HookEventName.PreToolUse,
    timestamp: new Date().toISOString(),
    permission_mode: PermissionMode.Default,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'tool-use-123',
  });

  const createPromptHookConfig = (
    prompt: string,
    overrides: Partial<PromptHookConfig> = {},
  ): PromptHookConfig => ({
    type: HookType.Prompt,
    prompt,
    timeout: 30,
    ...overrides,
  });

  describe('HookRunner with Prompt Hook', () => {
    it('should execute prompt hook for PreToolUse event', async () => {
      // Mock LLM response - allow the operation
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [{ text: '{"ok": true}' }],
              role: 'assistant',
            },
          },
        ],
      });

      const hookConfig = createPromptHookConfig(
        'Evaluate this tool use: $ARGUMENTS. Allow if safe.',
      );
      const input = createPreToolUseInput('Read', {
        file_path: '/test/file.txt',
      });

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('success');
      expect(result.output?.decision).toBe('allow');
    });

    it('should block dangerous Bash command via prompt hook', async () => {
      // Mock LLM response - block the operation
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '{"ok": false, "reason": "rm -rf is a dangerous command"}',
                },
              ],
              role: 'assistant',
            },
          },
        ],
      });

      const hookConfig = createPromptHookConfig(
        'Analyze this Bash command for safety risks: $ARGUMENTS. Block dangerous commands like rm -rf.',
        { name: 'bash-security-check' },
      );
      const input = createPreToolUseInput('Bash', {
        command: 'rm -rf /important-data',
      });

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('blocking');
      expect(result.output?.reason).toBe('rm -rf is a dangerous command');
    });

    it('should use custom model when specified', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [{ text: '{"ok": true}' }],
              role: 'assistant',
            },
          },
        ],
      });

      const hookConfig = createPromptHookConfig('Check: $ARGUMENTS', {
        model: 'qwen-max',
      });
      const input = createPreToolUseInput('Write', {
        file_path: '/test/file.txt',
        content: 'test',
      });

      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);

      // Verify the custom model was used
      const callArg = mockGenerateContent.mock.calls[0][0];
      expect(callArg.model).toBe('qwen-max');
    });

    it('should fail-open when LLM returns invalid response', async () => {
      // Mock invalid LLM response
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [{ text: 'This is not valid JSON' }],
              role: 'assistant',
            },
          },
        ],
      });

      const hookConfig = createPromptHookConfig('Check: $ARGUMENTS');
      const input = createPreToolUseInput('Edit', {
        file_path: '/test/file.txt',
      });

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      // Fail-open: invalid response defaults to allow
      expect(result.success).toBe(true);
      expect(result.output?.decision).toBe('allow');
    });

    it('should handle LLM API errors gracefully', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API rate limit'));

      const hookConfig = createPromptHookConfig('Check: $ARGUMENTS');
      const input = createPreToolUseInput('Bash', { command: 'ls' });

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      // Errors are non-blocking (fail-open)
      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.output?.continue).toBe(true);
    });
  });

  describe('HookSystem with Prompt Hooks', () => {
    it('should process hook definitions with prompt hooks', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '{"ok": true, "additionalContext": "Verified safe"}',
                },
              ],
              role: 'assistant',
            },
          },
        ],
      });

      const hookDefinition: HookDefinition = {
        matcher: 'Bash',
        hooks: [createPromptHookConfig('Security check: $ARGUMENTS')],
      };

      const input = createPreToolUseInput('Bash', { command: 'npm test' });

      // Test that hook runner can handle prompt hook definitions directly
      const result = await hookRunner.executeHook(
        hookDefinition.hooks[0] as PromptHookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });
  });

  describe('Hook Configuration Validation', () => {
    it('should return error result when Config not provided for prompt hooks', async () => {
      // Create HookRunner without Config
      const runnerWithoutConfig = new HookRunner();

      const hookConfig = createPromptHookConfig('Check: $ARGUMENTS');
      const input = createPreToolUseInput('Bash', { command: 'ls' });

      const result = await runnerWithoutConfig.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      // Should return error result instead of throwing
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Prompt hook requires Config');
    });
  });

  describe('$ARGUMENTS Placeholder', () => {
    it('should properly substitute tool input in prompt', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [{ text: '{"ok": true}' }],
              role: 'assistant',
            },
          },
        ],
      });

      const hookConfig = createPromptHookConfig(
        'Tool: $ARGUMENTS. Analyze the tool_name and tool_input fields.',
      );
      const input = createPreToolUseInput('Bash', {
        command: 'git status',
        description: 'Check git status',
      });

      await hookRunner.executeHook(hookConfig, HookEventName.PreToolUse, input);

      const callArg = mockGenerateContent.mock.calls[0][0];
      const promptText = callArg.contents?.[0]?.parts?.[0]?.text as string;

      // Verify tool info was injected into prompt
      expect(promptText).toContain('Bash');
      expect(promptText).toContain('git status');
      expect(promptText).toContain('tool_name');
      expect(promptText).not.toContain('$ARGUMENTS');
    });
  });

  describe('Timeout Handling', () => {
    it('should timeout and cancel when LLM is slow', async () => {
      mockGenerateContent.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  candidates: [
                    {
                      content: { parts: [{ text: '{"ok": true}' }] },
                    },
                  ],
                }),
              5000,
            );
          }),
      );

      const hookConfig = createPromptHookConfig('Check: $ARGUMENTS', {
        timeout: 0.1, // 100ms timeout
      });
      const input = createPreToolUseInput('Bash', { command: 'ls' });

      const result = await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('cancelled');
    }, 10000);
  });
});
