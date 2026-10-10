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

/** An assistant reply from the LLM carrying `text` as its only part. */
const llmReply = (text: string) => ({
  candidates: [{ content: { parts: [{ text }], role: 'assistant' } }],
});

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

    mockGenerateContent = vi.fn();
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
        resolveForModel: vi.fn().mockResolvedValue({
          contentGenerator: {
            generateContent: mockGenerateContent,
          },
          contentGeneratorConfig: { model: 'qwen-max' },
          model: 'qwen-max',
        }),
      }),
      getProjectRoot: vi.fn().mockReturnValue('/test/project'),
      getAllowedHttpHookUrls: vi.fn().mockReturnValue([]),
      getAllowPrivateNetworkHooks: vi.fn().mockReturnValue(false),
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

  /** Runs `hookConfig` for a PreToolUse of `toolName` with `toolInput`. */
  const runPreToolUse = (
    hookConfig: PromptHookConfig,
    toolName: string,
    toolInput: Record<string, unknown>,
    runner = hookRunner,
  ) =>
    runner.executeHook(
      hookConfig,
      HookEventName.PreToolUse,
      createPreToolUseInput(toolName, toolInput),
    );

  describe('HookRunner with Prompt Hook', () => {
    it('should execute prompt hook for PreToolUse event', async () => {
      mockGenerateContent.mockResolvedValue(llmReply('{"ok": true}'));

      const result = await runPreToolUse(
        createPromptHookConfig(
          'Evaluate this tool use: $ARGUMENTS. Allow if safe.',
        ),
        'Read',
        { file_path: '/test/file.txt' },
      );

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('success');
      expect(result.output?.decision).toBe('allow');
    });

    it('should block dangerous Bash command via prompt hook', async () => {
      mockGenerateContent.mockResolvedValue(
        llmReply('{"ok": false, "reason": "rm -rf is a dangerous command"}'),
      );

      const result = await runPreToolUse(
        createPromptHookConfig(
          'Analyze this Bash command for safety risks: $ARGUMENTS. Block dangerous commands like rm -rf.',
          { name: 'bash-security-check' },
        ),
        'Bash',
        { command: 'rm -rf /important-data' },
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('blocking');
      expect(result.output?.reason).toBe('rm -rf is a dangerous command');
    });

    it('should use custom model when specified', async () => {
      mockGenerateContent.mockResolvedValue(llmReply('{"ok": true}'));

      await runPreToolUse(
        createPromptHookConfig('Check: $ARGUMENTS', { model: 'qwen-max' }),
        'Write',
        { file_path: '/test/file.txt', content: 'test' },
      );

      const callArg = mockGenerateContent.mock.calls[0][0];
      expect(callArg.model).toBe('qwen-max');
    });

    it('should fail-open when LLM returns invalid response', async () => {
      mockGenerateContent.mockResolvedValue(llmReply('This is not valid JSON'));

      const result = await runPreToolUse(
        createPromptHookConfig('Check: $ARGUMENTS'),
        'Edit',
        { file_path: '/test/file.txt' },
      );

      // Fail-open: invalid response defaults to allow
      expect(result.success).toBe(true);
      expect(result.output?.decision).toBe('allow');
    });

    it('should handle LLM API errors gracefully', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API rate limit'));

      const result = await runPreToolUse(
        createPromptHookConfig('Check: $ARGUMENTS'),
        'Bash',
        { command: 'ls' },
      );

      // Errors are non-blocking (fail-open)
      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.output?.continue).toBe(true);
    });
  });

  describe('HookSystem with Prompt Hooks', () => {
    it('should process hook definitions with prompt hooks', async () => {
      mockGenerateContent.mockResolvedValue(
        llmReply('{"ok": true, "additionalContext": "Verified safe"}'),
      );
      const hookDefinition: HookDefinition = {
        matcher: 'Bash',
        hooks: [createPromptHookConfig('Security check: $ARGUMENTS')],
      };

      // The hook runner handles prompt hook definitions directly.
      const result = await runPreToolUse(
        hookDefinition.hooks[0] as PromptHookConfig,
        'Bash',
        { command: 'npm test' },
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });
  });

  describe('Hook Configuration Validation', () => {
    it('should return error result when Config not provided for prompt hooks', async () => {
      const result = await runPreToolUse(
        createPromptHookConfig('Check: $ARGUMENTS'),
        'Bash',
        { command: 'ls' },
        new HookRunner(),
      );

      // Should return error result instead of throwing
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Prompt hook requires Config');
    });
  });

  describe('$ARGUMENTS Placeholder', () => {
    it('should properly substitute tool input in prompt', async () => {
      mockGenerateContent.mockResolvedValue(llmReply('{"ok": true}'));

      await runPreToolUse(
        createPromptHookConfig(
          'Tool: $ARGUMENTS. Analyze the tool_name and tool_input fields.',
        ),
        'Bash',
        { command: 'git status', description: 'Check git status' },
      );

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
    it('should report a timeout when LLM is slow', async () => {
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

      const result = await runPreToolUse(
        createPromptHookConfig('Check: $ARGUMENTS', {
          timeout: 0.1, // 100ms timeout
        }),
        'Bash',
        { command: 'ls' },
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('timeout');
    }, 10000);
  });
});
