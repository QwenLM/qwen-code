/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Config } from '../config/config.js';
import { createPermissionManager, setTestSessionPermission } from '../test-utils/config.js';
import { AGENT_TOOL_NAME } from '../tools/tool-names.js';
import type { ToolUseContext } from '../tools/tool-types.js';
import {
  AgentTerminateMode,
  RESOLVED_AGENT_REASONING,
  type AgentDefinition,
  type LocalAgentDefinition,
} from '../agents/types.js';
import { runLocalAgentInvocation } from '../agents/local-agent-runner.js';
import baseline from './__fixtures__/cc-2.1.260-prompts.json' with { type: 'json' };
import { invokeWorkflowAgent } from './workflow-agent-adapter.js';

vi.mock('../agents/local-agent-runner.js', () => ({
  runLocalAgentInvocation: vi.fn(),
}));

const localAgent: LocalAgentDefinition = {
  kind: 'local',
  name: 'general-purpose',
  description: 'General purpose agent',
  promptConfig: { systemPrompt: 'You are a test agent.' },
  modelConfig: { model: 'inherit' },
};

/**
 * A real permission object, so the adapter is judged by the same checker table
 * the session uses. A workflow spawn has no user attached, hence the refusing
 * handler: an ask means the spawn cannot proceed.
 */
function permissionFor(rules: {
  deny?: string[];
  ask?: string[];
  allow?: string[];
}) {
  return createPermissionManager({
    cwd: '/repo',
    rules: {
      allow: { userSettings: rules.allow ?? [] },
      deny: { userSettings: rules.deny ?? [] },
      ask: { userSettings: rules.ask ?? [] },
    },
    askHandler: async () => ({ kind: 'rejected' }),
    checkerDeps: {
      skill: {
        isAllowedForMainSession: () => true,
        isDisabled: () => false,
        hasOnlySafeProperties: () => false,
      },
      mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
    },
  });
}

function createConfig(definitions: AgentDefinition[]): Config {
  const registry = {
    getAllDefinitions: vi.fn(() => definitions),
    getAllAgentNames: vi.fn(() =>
      definitions.map((definition) => definition.name),
    ),
    getDefinition: vi.fn((name: string) =>
      definitions.find((definition) => definition.name === name),
    ),
  };
  const config: Record<string, unknown> = {
    getAgentRegistry: vi.fn(() => registry),
    getExcludeTools: vi.fn(() => undefined),
    getConversationMessages: vi.fn(() => []),
    injectionService: {
      getLatestInjectionIndex: vi.fn(() => 0),
    },
    // A spawn is judged now, so every case needs an object to judge it —
    // mirroring the session, where the CLI always assembles one. This one allows
    // Agent so the cases that are not about permissions can get on with it.
    permission: permissionFor({ allow: [AGENT_TOOL_NAME] }),
  };
  config['config'] = config;
  return config as unknown as Config;
}

function createToolContext(): ToolUseContext {
  return {
    signal: new AbortController().signal,
    callId: 'workflow-tool-call',
    parentRequestSetId: 'parent-request-set',
    parentBusinessInfo: { userId: 'user-1' } as never,
    customContext: { tenant: 'workflow' },
    modelKey: 'auto',
  };
}

describe('invokeWorkflowAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runLocalAgentInvocation).mockResolvedValue({
      taskId: 'task-1',
      agentId: 'agent-1',
      finalResult: 'done',
      terminateReason: 'GOAL' as never,
      outputPath: '/tmp/out',
      transcriptPath: '/tmp/transcript.jsonl',
      totalTokens: 20,
      toolCalls: 3,
      toolResult: {
        llmContent: 'done',
        returnDisplay: 'done',
        toolUseResult: {
          kind: 'agent-result',
          agentId: 'agent-1',
          agentType: 'general-purpose',
          content: 'done',
          state: 'completed',
          outputPath: '/tmp/out',
          transcriptPath: '/tmp/transcript.jsonl',
        },
      },
    });
  });

  it.each([false, true])(
    'uses native default/custom prompts without a duplicate user note (schema=%s)',
    async (structured) => {
      const initialResult = await vi.mocked(runLocalAgentInvocation)(
        {} as never,
      );
      vi.mocked(runLocalAgentInvocation).mockClear();
      vi.mocked(runLocalAgentInvocation).mockImplementation(async (params) => {
        if (structured)
          await params
            .additionalTools![0].build({ value: 1 })
            .execute(new AbortController().signal);
        return initialResult;
      });
      for (const custom of [false, true]) {
        const config = createConfig([localAgent]);
        await invokeWorkflowAgent({
          config,
          ctx: createToolContext(),
          invocation: {
            index: 1,
            label: 'test',
            prompt: 'literal user task',
            agentType: custom ? 'general-purpose' : undefined,
            schema: structured
              ? { type: 'object', properties: { value: { type: 'number' } } }
              : undefined,
            disallowedTools: ['Write'],
            bashCommandClamp: ['Bash(git:*)'],
          },
        });
        const call = vi.mocked(runLocalAgentInvocation).mock.calls.at(-1)![0];
        expect(call.agentArgs['query']).toBe('literal user task');
        expect(call.definition.promptConfig.systemPrompt).toBe(
          custom
            ? `${localAgent.promptConfig.systemPrompt}${structured ? baseline.Qo : baseline.Xo}`
            : structured
              ? baseline.Zo
              : baseline.Yo,
        );
        expect(call.toolConstraints).toEqual({
          disallowedTools: ['Write'],
          bashCommandClamp: ['Bash(git:*)'],
          requiredTools: structured ? ['StructuredOutput'] : undefined,
        });
      }
    },
  );

  it('runs local agents through the shared local runner with silent notifications', async () => {
    const config = createConfig([localAgent]);
    const ctx = createToolContext();

    const result = await invokeWorkflowAgent({
      config,
      ctx,
      workflowRunId: 'wf_run',
      workflowExecutionId: 'wf-execution',
      invocation: {
        index: 1,
        label: 'review',
        attempt: 2,
        phaseIndex: 3,
        prompt: 'review the diff',
        type: 'general-purpose',
        description: 'Review diff',
      },
    });

    expect(result).toMatchObject({
      content: 'done',
      state: 'done',
      agentId: 'agent-1',
      agentType: 'general-purpose',
      tokens: 20,
      toolCalls: 3,
    });
    expect(runLocalAgentInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: expect.objectContaining({
          kind: 'local',
          name: 'general-purpose',
          disallowedTools: expect.arrayContaining([
            'Workflow',
            'RunWorkflow',
            'SendUserMessage',
            'Agent',
          ]),
          promptConfig: expect.objectContaining({
            systemPrompt: expect.stringContaining(
              'You are a test agent.\n\n---\n\nNOTE: You are running inside a workflow script.',
            ),
          }),
        }),
        agentArgs: { query: 'review the diff' },
        parentToolUseId: 'workflow-tool-call',
        parentRequestSetId: 'parent-request-set',
        customContext: { tenant: 'workflow' },
        completionBehavior: 'silent',
        emitSdkTaskNotification: false,
        registerTask: false,
        subscribeMcpProgress: false,
        modelOverride: undefined,
        parentModel: 'auto',
        internalExecutionOwner: {
          kind: 'workflow-agent',
          workflowRunId: 'wf_run',
          workflowExecutionId: 'wf-execution',
          workflowTaskId: 'workflow-tool-call',
          workflowAgentIndex: 1,
          workflowPhaseIndex: 3,
          workflowAttempt: 2,
          suppressMainSessionNotification: true,
          disableShellAutoBackground: true,
        },
      }),
    );
  });

  it('normalizes an explicitly requested workflow Agent type', async () => {
    await invokeWorkflowAgent({
      config: createConfig([localAgent]),
      ctx: createToolContext(),
      invocation: {
        index: 1,
        label: 'normalized',
        prompt: 'review the diff',
        type: ' GENERAL_PURPOSE ',
      },
    });

    expect(runLocalAgentInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: expect.objectContaining({ name: 'general-purpose' }),
      }),
    );
  });

  it('forwards raw query events without projecting them as UI progress', async () => {
    const onQueryEvent = vi.fn();
    const onProgress = vi.fn();

    await invokeWorkflowAgent({
      config: createConfig([localAgent]),
      ctx: createToolContext(),
      invocation: {
        index: 1,
        label: 'streaming',
        prompt: 'stream output',
      },
      onProgress,
      onQueryEvent,
    });

    const runnerParams = vi.mocked(runLocalAgentInvocation).mock.calls[0]?.[0];
    const event = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'stream output' },
      },
    } as const;
    runnerParams?.onQueryEvent?.(event);

    expect(onQueryEvent).toHaveBeenCalledExactlyOnceWith(event);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('injects StructuredOutput for workflow agent schema results', async () => {
    vi.mocked(runLocalAgentInvocation).mockImplementation(async (params) => {
      const structuredTool = params.additionalTools?.[0];
      expect(structuredTool?.name).toBe('StructuredOutput');
      const structuredResult = await structuredTool
        ?.build({ value: 42 })
        .execute(new AbortController().signal);
      expect(structuredResult?.endsTurn).toBe(true);
      return {
        taskId: 'task-1',
        agentId: 'agent-1',
        finalResult: '',
        terminateReason: 'GOAL' as never,
        outputPath: '/tmp/out',
        transcriptPath: '/tmp/transcript.jsonl',
        toolResult: {
          llmContent: '',
          returnDisplay: '',
          toolUseResult: {
            kind: 'agent-result',
            agentId: 'agent-1',
            agentType: 'general-purpose',
            content: '',
            state: 'completed',
            outputPath: '/tmp/out',
            transcriptPath: '/tmp/transcript.jsonl',
          },
        },
      };
    });
    const config = createConfig([localAgent]);

    const result = await invokeWorkflowAgent({
      config,
      ctx: createToolContext(),
      invocation: {
        index: 1,
        label: 'structured',
        prompt: 'return structured value',
        type: 'general-purpose',
        schema: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    });

    expect(result).toMatchObject({
      structured: { value: 42 },
      content: '{"value":42}',
      state: 'done',
    });
    expect(runLocalAgentInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalTools: [
          expect.objectContaining({
            name: 'StructuredOutput',
          }),
        ],
        definition: expect.objectContaining({
          promptConfig: expect.objectContaining({
            systemPrompt: expect.stringContaining(
              'If validation fails, read the error and call StructuredOutput again',
            ),
          }),
        }),
      }),
    );
  });

  it('returns agent API failures before requiring StructuredOutput', async () => {
    vi.mocked(runLocalAgentInvocation).mockResolvedValue({
      taskId: 'task-1',
      agentId: 'agent-1',
      finalResult: 'provider unavailable',
      terminateReason: AgentTerminateMode.ERROR,
      apiError: 'provider unavailable',
      toolResult: {
        llmContent: 'provider unavailable',
        returnDisplay: 'provider unavailable',
        toolUseResult: {
          kind: 'agent-result',
          agentId: 'agent-1',
          agentType: 'general-purpose',
          content: 'provider unavailable',
          state: 'error',
          apiError: 'provider unavailable',
          terminateReason: AgentTerminateMode.ERROR,
        },
      },
    });

    const result = await invokeWorkflowAgent({
      config: createConfig([localAgent]),
      ctx: createToolContext(),
      invocation: {
        index: 1,
        label: 'structured',
        prompt: 'return structured value',
        type: 'general-purpose',
        schema: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value'],
        },
      },
    });

    expect(result).toMatchObject({
      content: 'provider unavailable',
      state: 'error',
      apiError: 'provider unavailable',
    });
  });

  it('keeps unclassified agent failures hard', async () => {
    vi.mocked(runLocalAgentInvocation).mockResolvedValue({
      taskId: 'task-1',
      agentId: 'agent-1',
      finalResult: 'maximum turns reached',
      terminateReason: AgentTerminateMode.ERROR,
      toolResult: {
        llmContent: 'maximum turns reached',
        returnDisplay: 'maximum turns reached',
        toolUseResult: {
          kind: 'agent-result',
          agentId: 'agent-1',
          agentType: 'general-purpose',
          content: 'maximum turns reached',
          state: 'error',
          terminateReason: AgentTerminateMode.ERROR,
        },
      },
    });

    await expect(
      invokeWorkflowAgent({
        config: createConfig([localAgent]),
        ctx: createToolContext(),
        invocation: {
          index: 1,
          label: 'structured',
          prompt: 'return structured value',
          type: 'general-purpose',
          schema: { type: 'object' },
        },
      }),
    ).rejects.toThrow('maximum turns reached');
  });

  it('allows StructuredOutput validation failures before one successful call', async () => {
    vi.mocked(runLocalAgentInvocation).mockImplementation(async (params) => {
      const structuredTool = params.additionalTools?.[0];
      const failed = await structuredTool
        ?.build({ value: 'not-a-number' })
        .execute(new AbortController().signal);
      expect(failed?.error?.message).toContain(
        'Structured output validation failed',
      );
      const succeeded = await structuredTool
        ?.build({ value: 2 })
        .execute(new AbortController().signal);
      expect(succeeded?.endsTurn).toBe(true);
      return {
        taskId: 'task-1',
        agentId: 'agent-1',
        finalResult: '',
        terminateReason: 'GOAL' as never,
        outputPath: '/tmp/out',
        transcriptPath: '/tmp/transcript.jsonl',
        toolResult: {
          llmContent: '',
          returnDisplay: '',
          toolUseResult: {
            kind: 'agent-result',
            agentId: 'agent-1',
            agentType: 'general-purpose',
            content: '',
            state: 'completed',
            outputPath: '/tmp/out',
            transcriptPath: '/tmp/transcript.jsonl',
          },
        },
      };
    });

    const result = await invokeWorkflowAgent({
      config: createConfig([localAgent]),
      ctx: createToolContext(),
      invocation: {
        index: 1,
        label: 'structured',
        prompt: 'return structured value',
        type: 'general-purpose',
        schema: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    });

    expect(result.structured).toEqual({ value: 2 });
  });

  it('preserves a valid result when StructuredOutput succeeds multiple times in one batch', async () => {
    vi.mocked(runLocalAgentInvocation).mockImplementation(async (params) => {
      const structuredTool = params.additionalTools?.[0];
      await structuredTool
        ?.build({ value: 1 })
        .execute(new AbortController().signal);
      await structuredTool
        ?.build({ value: 2 })
        .execute(new AbortController().signal);
      return {
        taskId: 'task-1',
        agentId: 'agent-1',
        finalResult: '',
        terminateReason: 'GOAL' as never,
        outputPath: '/tmp/out',
        transcriptPath: '/tmp/transcript.jsonl',
        toolResult: {
          llmContent: '',
          returnDisplay: '',
          toolUseResult: {
            kind: 'agent-result',
            agentId: 'agent-1',
            agentType: 'general-purpose',
            content: '',
            state: 'completed',
            outputPath: '/tmp/out',
            transcriptPath: '/tmp/transcript.jsonl',
          },
        },
      };
    });

    const result = await invokeWorkflowAgent({
      config: createConfig([localAgent]),
      ctx: createToolContext(),
      invocation: {
        index: 1,
        label: 'structured',
        prompt: 'return structured value',
        type: 'general-purpose',
        schema: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    });

    expect(result.structured).toEqual({ value: 2 });
  });

  it('stops and reports an error after five StructuredOutput validation failures', async () => {
    vi.mocked(runLocalAgentInvocation).mockImplementation(async (params) => {
      const structuredTool = params.additionalTools?.[0];
      let lastResult;
      for (let attempt = 0; attempt < 5; attempt++) {
        lastResult = await structuredTool
          ?.build({ value: 'not-a-number' })
          .execute(new AbortController().signal);
      }
      expect(lastResult?.endsTurn).toBe(true);
      expect(lastResult?.error?.message).toContain(
        'StructuredOutput retry cap (5) exceeded',
      );
      return {
        taskId: 'task-1',
        agentId: 'agent-1',
        finalResult: '',
        terminateReason: 'GOAL' as never,
        outputPath: '/tmp/out',
        transcriptPath: '/tmp/transcript.jsonl',
        toolResult: {
          llmContent: '',
          returnDisplay: '',
          toolUseResult: {
            kind: 'agent-result',
            agentId: 'agent-1',
            agentType: 'general-purpose',
            content: '',
            state: 'completed',
          },
        },
      };
    });

    await expect(
      invokeWorkflowAgent({
        config: createConfig([localAgent]),
        ctx: createToolContext(),
        invocation: {
          index: 1,
          label: 'structured',
          prompt: 'return structured value',
          type: 'general-purpose',
          schema: {
            type: 'object',
            properties: { value: { type: 'number' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
      }),
    ).rejects.toThrow(
      'StructuredOutput retry cap (5) exceeded — 5 failed calls with no valid output',
    );
  });

  it('uses the internal workflow-subagent definition when no agent type is specified', async () => {
    await invokeWorkflowAgent({
      config: createConfig([localAgent]),
      ctx: createToolContext(),
      invocation: {
        index: 1,
        label: 'default',
        prompt: 'return raw data',
      },
    });

    expect(runLocalAgentInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: expect.objectContaining({
          name: 'workflow-subagent',
          description: 'Internal subagent for workflow script orchestration.',
          modelConfig: { model: 'inherit' },
          toolConfig: { tools: ['*'] },
          disallowedTools: expect.arrayContaining([
            'Workflow',
            'RunWorkflow',
            'SendUserMessage',
            'Agent',
          ]),
          promptConfig: expect.objectContaining({
            systemPrompt: expect.stringContaining(
              'Your final text response is returned **verbatim**',
            ),
          }),
        }),
      }),
    );
  });

  it('does not inherit mutable general-purpose settings for the default workflow-subagent', async () => {
    const restrictedGeneralPurpose: LocalAgentDefinition = {
      ...localAgent,
      toolConfig: { tools: ['Read'] },
      runConfig: { maxTurns: 1, maxTimeMinutes: 1 },
      mcpServers: ['restricted-server'],
      skills: ['restricted-skill'],
      disallowedTools: ['Bash'],
      promptConfig: { systemPrompt: 'Restricted general-purpose prompt.' },
    };

    await invokeWorkflowAgent({
      config: createConfig([restrictedGeneralPurpose]),
      ctx: createToolContext(),
      invocation: {
        index: 1,
        label: 'default',
        prompt: 'return raw data',
      },
    });

    const invocation = vi.mocked(runLocalAgentInvocation).mock.calls[0][0];
    expect(invocation.definition).toMatchObject({
      name: 'workflow-subagent',
      toolConfig: { tools: ['*'] },
    });
    expect(invocation.definition).not.toHaveProperty('runConfig');
    expect(invocation.definition).not.toHaveProperty('mcpServers');
    expect(invocation.definition).not.toHaveProperty('skills');
    expect(invocation.definition.disallowedTools).not.toContain('Bash');
    expect(invocation.definition.promptConfig.systemPrompt).not.toContain(
      'Restricted general-purpose prompt.',
    );
  });

  it('passes opts.model through as a subagent model override', async () => {
    await invokeWorkflowAgent({
      config: createConfig([localAgent]),
      ctx: createToolContext(),
      invocation: {
        index: 1,
        label: 'model',
        prompt: 'use requested model',
        type: 'general-purpose',
        model: 'qwen-model-large',
      },
    });

    expect(runLocalAgentInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOverride: 'qwen-model-large',
      }),
    );
  });

  it('uses agent({ effort }) for this workflow agent invocation', async () => {
    const definitionWithEffort: LocalAgentDefinition = {
      ...localAgent,
      [RESOLVED_AGENT_REASONING]: {
        thinkingBudget: 32000,
        reasoningEffort: 'xhigh',
      },
    };

    await invokeWorkflowAgent({
      config: createConfig([definitionWithEffort]),
      ctx: createToolContext(),
      invocation: {
        index: 1,
        label: 'effort',
        prompt: 'use requested effort',
        type: 'general-purpose',
        effort: 'high',
      },
    });

    const call = vi.mocked(runLocalAgentInvocation).mock.calls[0][0];
    expect(call.definition[RESOLVED_AGENT_REASONING]).toEqual(
      definitionWithEffort[RESOLVED_AGENT_REASONING],
    );
    expect(call.querySelection).toEqual({
      config: { reasoning: { effort: 'high' } },
    });
  });

  it('leaves effort unresolved so the shared runner inherits the session effort', async () => {
    const config = createConfig([localAgent]);

    await invokeWorkflowAgent({
      config,
      ctx: createToolContext(),
      invocation: {
        index: 1,
        label: 'inherited-effort',
        prompt: 'inherit the session effort',
        type: 'general-purpose',
      },
    });

    const invocation = vi.mocked(runLocalAgentInvocation).mock.calls[0][0];
    expect(invocation.definition[RESOLVED_AGENT_REASONING]).toBeUndefined();
    expect(invocation.context.config).toBe(config);
  });

  it('keeps the agent definition effort when the invocation effort is invalid', async () => {
    const definitionWithEffort: LocalAgentDefinition = {
      ...localAgent,
      [RESOLVED_AGENT_REASONING]: {
        thinkingBudget: 32000,
        reasoningEffort: 'xhigh',
      },
    };

    await invokeWorkflowAgent({
      config: createConfig([definitionWithEffort]),
      ctx: createToolContext(),
      invocation: {
        index: 1,
        label: 'invalid-effort',
        prompt: 'keep the configured effort',
        type: 'general-purpose',
        effort: 'turbo',
      } as never,
    });

    const definition = vi.mocked(runLocalAgentInvocation).mock.calls[0][0]
      .definition;
    expect(definition[RESOLVED_AGENT_REASONING]).toEqual({
      thinkingBudget: 32000,
      reasoningEffort: 'xhigh',
    });
  });

  it('reports live workflow tool activity from subagent progress', async () => {
    vi.mocked(runLocalAgentInvocation).mockImplementation(async (params) => {
      params.updateOutput?.({
        isSubagentProgress: true,
        agentName: 'workflow-subagent',
        state: 'running',
        recentActivity: [
          {
            id: 'tool-0',
            type: 'tool_call',
            content: 'Glob',
            displayName: 'Glob',
            description: '**/*.ts',
            status: 'completed',
          },
          {
            id: 'tool-1',
            type: 'tool_call',
            content: 'Read',
            displayName: 'Read',
            description: '/repo/file.ts',
            status: 'running',
          },
        ],
      });
      return {
        taskId: 'task-1',
        agentId: 'agent-1',
        finalResult: 'done',
        terminateReason: 'GOAL' as never,
        outputPath: '/tmp/out',
        transcriptPath: '/tmp/transcript.jsonl',
        totalTokens: 20,
        toolCalls: 1,
        toolResult: {
          llmContent: 'done',
          returnDisplay: 'done',
          toolUseResult: {
            kind: 'agent-result',
            agentId: 'agent-1',
            agentType: 'workflow-subagent',
            content: 'done',
            state: 'completed',
            outputPath: '/tmp/out',
            transcriptPath: '/tmp/transcript.jsonl',
          },
        },
      };
    });
    const onProgress = vi.fn();

    await invokeWorkflowAgent({
      config: createConfig([localAgent]),
      ctx: createToolContext(),
      invocation: {
        index: 1,
        label: 'live',
        prompt: 'read file',
      },
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        lastToolName: 'Read',
        lastToolSummary: '/repo/file.ts',
        recentToolActivities: ['Glob(**/*.ts)', 'Read(/repo/file.ts)'],
        toolCalls: 2,
        lastProgressAt: expect.any(Number),
      }),
    );
  });

  it('honors content-specific Agent deny rules before starting the runner', async () => {
    const config = createConfig([localAgent]);
    setTestSessionPermission(
      config,
      permissionFor({
        deny: ['Agent(general-purpose)'],
      }),
    );

    await expect(
      invokeWorkflowAgent({
        config,
        ctx: createToolContext(),
        invocation: {
          index: 1,
          label: 'blocked',
          prompt: 'do work',
          type: 'general-purpose',
        },
      }),
    ).rejects.toThrow('Agent');
    expect(runLocalAgentInvocation).not.toHaveBeenCalled();
  });
});
