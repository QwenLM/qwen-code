/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentHookRunner } from './agentHookRunner.js';
import { HookEventName, HookType } from './types.js';
import type { AgentHookConfig, HookInput } from './types.js';
import { AgentTerminateMode } from '../agents/runtime/agent-types.js';
import { VERDICT_TOOL_NAME } from './reportVerdictTool.js';

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

const createMockInput = (overrides: Partial<HookInput> = {}): HookInput => ({
  session_id: 'test-session',
  transcript_path: '/test/transcript',
  cwd: '/test',
  hook_event_name: 'Stop',
  timestamp: '2024-01-01T00:00:00Z',
  ...overrides,
});

const createAgentHookConfig = (
  overrides: Partial<AgentHookConfig> = {},
): AgentHookConfig => ({
  type: HookType.Agent,
  prompt: 'Verify the task was completed correctly. Context: $ARGUMENTS',
  ...overrides,
});

/* ------------------------------------------------------------------ */
/*  Mock factories                                                     */
/* ------------------------------------------------------------------ */

function createMockHeadless(
  terminateMode: AgentTerminateMode = AgentTerminateMode.GOAL,
  finalText: string = '',
) {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
    getTerminateMode: vi.fn().mockReturnValue(terminateMode),
    getFinalText: vi.fn().mockReturnValue(finalText),
  };
}

function createMockSubagentManager(
  headless = createMockHeadless(),
  subagentConfig: Record<string, unknown> | null = { name: 'verifier' },
) {
  return {
    loadSubagent: vi.fn().mockResolvedValue(subagentConfig),
    createAgentHeadless: vi.fn().mockResolvedValue(headless),
  };
}

function createMockConfig(subagentManager = createMockSubagentManager()) {
  return {
    getSubagentManager: vi.fn().mockReturnValue(subagentManager),
    getTranscriptPath: vi.fn().mockReturnValue('/test/transcript.jsonl'),
    getApprovalMode: vi.fn().mockReturnValue('default'),
  } as unknown as import('../config/config.js').Config;
}

describe('AgentHookRunner', () => {
  let runner: AgentHookRunner;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('execute — subagent not found', () => {
    it('should return non_blocking_error when subagent is not found', async () => {
      const subagentManager = createMockSubagentManager(
        createMockHeadless(),
        null, // subagent not found
      );
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      const result = await runner.execute(
        createAgentHookConfig(),
        HookEventName.Stop,
        createMockInput(),
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.error?.message).toContain('not found');
    });
  });

  describe('execute — verdict ok', () => {
    it('should return success when verdict is ok=true', async () => {
      const headless = createMockHeadless();
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      // Simulate the postToolUse hook capturing a verdict
      subagentManager.createAgentHeadless.mockImplementation(
        async (
          _cfg: unknown,
          _ctx: unknown,
          options: Record<string, unknown>,
        ) => {
          const hooks = options['hooks'] as {
            postToolUse?: (p: Record<string, unknown>) => void;
          };
          // Simulate calling report_verdict with ok=true
          hooks.postToolUse?.({
            success: true,
            toolName: VERDICT_TOOL_NAME,
            args: { ok: true },
          });
          return headless;
        },
      );

      const result = await runner.execute(
        createAgentHookConfig(),
        HookEventName.Stop,
        createMockInput(),
      );

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('success');
      expect(result.output?.continue).toBe(true);
    });
  });

  describe('execute — verdict not ok', () => {
    it('should return blocking when verdict is ok=false', async () => {
      const headless = createMockHeadless();
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      subagentManager.createAgentHeadless.mockImplementation(
        async (
          _cfg: unknown,
          _ctx: unknown,
          options: Record<string, unknown>,
        ) => {
          const hooks = options['hooks'] as {
            postToolUse?: (p: Record<string, unknown>) => void;
          };
          hooks.postToolUse?.({
            success: true,
            toolName: VERDICT_TOOL_NAME,
            args: { ok: false, reason: 'tests not passing' },
          });
          return headless;
        },
      );

      const result = await runner.execute(
        createAgentHookConfig(),
        HookEventName.Stop,
        createMockInput(),
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('blocking');
      expect(result.output?.continue).toBe(false);
      expect(result.output?.stopReason).toContain('tests not passing');
    });

    it('should return non_blocking_error when advisoryOnly is true', async () => {
      const headless = createMockHeadless();
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      subagentManager.createAgentHeadless.mockImplementation(
        async (
          _cfg: unknown,
          _ctx: unknown,
          options: Record<string, unknown>,
        ) => {
          const hooks = options['hooks'] as {
            postToolUse?: (p: Record<string, unknown>) => void;
          };
          hooks.postToolUse?.({
            success: true,
            toolName: VERDICT_TOOL_NAME,
            args: { ok: false, reason: 'advisory failure' },
          });
          return headless;
        },
      );

      const result = await runner.execute(
        createAgentHookConfig({ advisoryOnly: true }),
        HookEventName.Stop,
        createMockInput(),
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.output?.stopReason).toContain('advisory failure');
    });
  });

  describe('execute — no verdict', () => {
    it('should return cancelled when no verdict is reported', async () => {
      const headless = createMockHeadless(AgentTerminateMode.CANCELLED);
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      const result = await runner.execute(
        createAgentHookConfig(),
        HookEventName.Stop,
        createMockInput(),
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('cancelled');
    });

    it('should return cancelled when max turns reached without verdict', async () => {
      const headless = createMockHeadless(AgentTerminateMode.MAX_TURNS);
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      const result = await runner.execute(
        createAgentHookConfig(),
        HookEventName.Stop,
        createMockInput(),
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('cancelled');
    });
  });

  describe('execute — error handling', () => {
    it('should return non_blocking_error on execution error', async () => {
      const headless = createMockHeadless();
      headless.execute.mockRejectedValue(new Error('subagent crashed'));
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      const result = await runner.execute(
        createAgentHookConfig(),
        HookEventName.Stop,
        createMockInput(),
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.error?.message).toContain('subagent crashed');
    });
  });

  describe('execute — configuration forwarding', () => {
    it('should pass custom model to createAgentHeadless', async () => {
      const headless = createMockHeadless();
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      await runner.execute(
        createAgentHookConfig({ model: 'qwen-72b' }),
        HookEventName.Stop,
        createMockInput(),
      );

      const callArgs = subagentManager.createAgentHeadless.mock.calls[0];
      const options = callArgs[2] as Record<string, unknown>;
      const modelOverrides = options['modelConfigOverrides'] as Record<
        string,
        string
      >;
      expect(modelOverrides['model']).toBe('qwen-72b');
    });

    it('should pass custom maxTurns to createAgentHeadless', async () => {
      const headless = createMockHeadless();
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      await runner.execute(
        createAgentHookConfig({ maxTurns: 10 }),
        HookEventName.Stop,
        createMockInput(),
      );

      const callArgs = subagentManager.createAgentHeadless.mock.calls[0];
      const options = callArgs[2] as Record<string, unknown>;
      const runOverrides = options['runConfigOverrides'] as Record<
        string,
        number
      >;
      expect(runOverrides['max_turns']).toBe(10);
    });

    it('should inject report_verdict tool into toolConfigOverride', async () => {
      const headless = createMockHeadless();
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      await runner.execute(
        createAgentHookConfig(),
        HookEventName.Stop,
        createMockInput(),
      );

      const callArgs = subagentManager.createAgentHeadless.mock.calls[0];
      const options = callArgs[2] as Record<string, unknown>;
      const toolConfig = options['toolConfigOverride'] as {
        tools: unknown[];
        disallowedTools: string[];
      };
      // Should contain '*' wildcard and the verdict FunctionDeclaration
      expect(toolConfig.tools).toContain('*');
      const verdictDecl = toolConfig.tools.find(
        (t: unknown) =>
          typeof t === 'object' &&
          t !== null &&
          (t as Record<string, unknown>)['name'] === VERDICT_TOOL_NAME,
      );
      expect(verdictDecl).toBeDefined();
    });

    it('should include disallowed tools in toolConfigOverride', async () => {
      const headless = createMockHeadless();
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      await runner.execute(
        createAgentHookConfig(),
        HookEventName.Stop,
        createMockInput(),
      );

      const callArgs = subagentManager.createAgentHeadless.mock.calls[0];
      const options = callArgs[2] as Record<string, unknown>;
      const toolConfig = options['toolConfigOverride'] as {
        tools: unknown[];
        disallowedTools: string[];
      };
      expect(toolConfig.disallowedTools.length).toBeGreaterThan(0);
    });
  });

  describe('execute — prompt substitution', () => {
    it('should use default prompt when none is provided', async () => {
      const headless = createMockHeadless();
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      await runner.execute(
        createAgentHookConfig(),
        HookEventName.Stop,
        createMockInput(),
      );

      expect(subagentManager.createAgentHeadless).toHaveBeenCalled();
    });

    it('should substitute $ARGUMENTS in custom prompt', async () => {
      const headless = createMockHeadless();
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      // We can't directly assert the prompt content since it's set
      // on ContextState internally, but we verify no error occurs
      await runner.execute(
        createAgentHookConfig({ prompt: 'Verify: $ARGUMENTS' }),
        HookEventName.Stop,
        createMockInput(),
      );

      expect(subagentManager.createAgentHeadless).toHaveBeenCalled();
    });
  });

  describe('execute — duration tracking', () => {
    it('should include duration in the result', async () => {
      const headless = createMockHeadless();
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      const result = await runner.execute(
        createAgentHookConfig(),
        HookEventName.Stop,
        createMockInput(),
      );

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('agent field is optional, defaults to general-purpose', () => {
    it('should use general-purpose subagent when agent is omitted', async () => {
      const headless = createMockHeadless();
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      await runner.execute(
        createAgentHookConfig(), // no agent field
        HookEventName.Stop,
        createMockInput(),
      );

      expect(subagentManager.loadSubagent).toHaveBeenCalledWith(
        'general-purpose',
      );
    });

    it('should use custom agent when explicitly specified', async () => {
      const headless = createMockHeadless();
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      await runner.execute(
        createAgentHookConfig({ agent: 'custom-verifier' }),
        HookEventName.Stop,
        createMockInput(),
      );

      expect(subagentManager.loadSubagent).toHaveBeenCalledWith(
        'custom-verifier',
      );
    });
  });

  describe('transcript path injection', () => {
    it('should inject transcript path into system prompt override', async () => {
      const headless = createMockHeadless();
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      await runner.execute(
        createAgentHookConfig(),
        HookEventName.Stop,
        createMockInput(),
      );

      const callArgs = subagentManager.createAgentHeadless.mock.calls[0];
      const options = callArgs[2] as Record<string, unknown>;
      const promptOverrides = options['promptConfigOverrides'] as {
        renderedSystemPrompt?: string;
      };
      expect(promptOverrides.renderedSystemPrompt).toBeDefined();
      expect(promptOverrides.renderedSystemPrompt).toContain(
        '/test/transcript.jsonl',
      );
      expect(promptOverrides.renderedSystemPrompt).toContain(
        'conversation transcript',
      );
    });

    it('should handle empty transcript path gracefully', async () => {
      const headless = createMockHeadless();
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      (config as unknown as Record<string, unknown>)['getTranscriptPath'] = vi
        .fn()
        .mockReturnValue('');
      runner = new AgentHookRunner(config);

      await runner.execute(
        createAgentHookConfig(),
        HookEventName.Stop,
        createMockInput(),
      );

      const callArgs = subagentManager.createAgentHeadless.mock.calls[0];
      const options = callArgs[2] as Record<string, unknown>;
      const promptOverrides = options['promptConfigOverrides'] as {
        renderedSystemPrompt?: string;
      };
      // Should still have a system prompt, just without transcript mention
      expect(promptOverrides.renderedSystemPrompt).toBeDefined();
      expect(promptOverrides.renderedSystemPrompt).not.toContain(
        'transcript is available at',
      );
    });
  });

  describe('dontAsk permission mode (YOLO)', () => {
    it('should pass a Config override with YOLO approval mode to createAgentHeadless', async () => {
      const headless = createMockHeadless();
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      await runner.execute(
        createAgentHookConfig(),
        HookEventName.Stop,
        createMockInput(),
      );

      const callArgs = subagentManager.createAgentHeadless.mock.calls[0];
      // arg[1] = runtimeContext (the Config override)
      const runtimeContext = callArgs[1] as { getApprovalMode: () => string };
      expect(runtimeContext.getApprovalMode()).toBe('yolo');
    });

    it('should not mutate the original config approval mode', async () => {
      const headless = createMockHeadless();
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      await runner.execute(
        createAgentHookConfig(),
        HookEventName.Stop,
        createMockInput(),
      );

      // Original config should still return 'default'
      expect(config.getApprovalMode()).toBe('default');
    });
  });

  describe('execute — text fallback verdict (fail-safe)', () => {
    it('should default to ok=false when text does not match any pattern', async () => {
      const headless = createMockHeadless(
        AgentTerminateMode.GOAL,
        'I have reviewed the code and have no further comments.',
      );
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      const result = await runner.execute(
        createAgentHookConfig(),
        HookEventName.Stop,
        createMockInput(),
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('blocking');
      expect(result.output?.continue).toBe(false);
      expect(result.output?.stopReason).toContain(
        'Verdict could not be inferred from model output',
      );
    });

    it('should default to ok=true when defaultVerdict is true and text is ambiguous', async () => {
      const headless = createMockHeadless(
        AgentTerminateMode.GOAL,
        'I have reviewed the code and have no further comments.',
      );
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      const result = await runner.execute(
        createAgentHookConfig({ defaultVerdict: true }),
        HookEventName.Stop,
        createMockInput(),
      );

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('success');
      expect(result.output?.continue).toBe(true);
    });

    it('should infer ok=true from positive text patterns', async () => {
      const headless = createMockHeadless(
        AgentTerminateMode.GOAL,
        'All checks passed and the task was completed successfully.',
      );
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      const result = await runner.execute(
        createAgentHookConfig(),
        HookEventName.Stop,
        createMockInput(),
      );

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('success');
      expect(result.output?.continue).toBe(true);
    });

    it('should infer ok=false from negative text patterns', async () => {
      const headless = createMockHeadless(
        AgentTerminateMode.GOAL,
        'The condition was not met because tests failed.',
      );
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      const result = await runner.execute(
        createAgentHookConfig(),
        HookEventName.Stop,
        createMockInput(),
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('blocking');
      expect(result.output?.continue).toBe(false);
    });

    it('should block with ok=false even when defaultVerdict is true if negative pattern matches', async () => {
      const headless = createMockHeadless(
        AgentTerminateMode.GOAL,
        'The verification failed — tests are broken.',
      );
      const subagentManager = createMockSubagentManager(headless);
      const config = createMockConfig(subagentManager);
      runner = new AgentHookRunner(config);

      const result = await runner.execute(
        createAgentHookConfig({ defaultVerdict: true }),
        HookEventName.Stop,
        createMockInput(),
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('blocking');
      expect(result.output?.continue).toBe(false);
    });
  });
});
