/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Config } from '../config/config.js';
import type { QueryEvent } from '../core/query-event.js';
import {
  AgentTool,
  type AgentToolParams,
} from '../agents/subagent-tool.js';
import {
  isAgentToolBackgroundLaunchResult,
  isAgentToolCompletionResult,
} from '../agents/agent-tool-result.js';
import { runLocalAgentInvocation } from '../agents/local-agent-runner.js';
import {
  isSubagentProgress,
  type LocalAgentDefinition,
  type SubagentActivityItem,
} from '../agents/types.js';
import type { ToolResult } from '../tools/tools.js';
import type {
  InternalExecutionOwner,
  ToolUseContext,
} from '../tools/tool-types.js';
import {
  AGENT_TOOL_NAME,
  RUN_WORKFLOW_TOOL_NAME,
  WORKFLOW_TOOL_NAME,
} from '../tools/tool-names.js';
import {
  WorkflowStructuredOutputResultHolder,
  WorkflowStructuredOutputTool,
  structuredOutputRetryCapMessage,
} from './workflow-structured-output-tool.js';
import { runLogger } from '../utils/runLogger.js';
import type {
  WorkflowAgentInvocation,
  WorkflowAgentLiveProgress,
  WorkflowAgentResult,
} from './workflow-types.js';
import { resolveAgentReasoning } from '../utils/frontmatterParsers.js';
import { normalizeWorkflowAgentEffort } from './workflow-runtime.js';

export async function invokeWorkflowAgent(params: {
  config: Config;
  ctx: ToolUseContext;
  invocation: WorkflowAgentInvocation;
  workflowRunId?: string;
  workflowExecutionId?: string;
  onProgress?: (progress?: WorkflowAgentLiveProgress) => void;
  onQueryEvent?: (event: QueryEvent) => void;
}): Promise<WorkflowAgentResult> {
  const toolParams = toAgentToolParams(params.invocation);
  const { updatedInput, definition, explicitlyRequestedAgentType } =
    await resolveWorkflowAgentDefinition(params.config, toolParams);

  const structuredOutput =
    params.invocation.schema === undefined
      ? undefined
      : createWorkflowStructuredOutput(params.invocation.schema);
  const baseDefinition = explicitlyRequestedAgentType
    ? withWorkflowAgentIsolation(definition)
    : createDefaultWorkflowSubagentDefinition();
  const runDefinition = withWorkflowAgentPrompt(baseDefinition, {
    structured: structuredOutput !== undefined,
    preserveBasePrompt: explicitlyRequestedAgentType,
  });
  const requestedReasoning = resolveAgentReasoning(
    normalizeWorkflowAgentEffort(params.invocation.effort),
    undefined,
  );

  const workflowPrompt = updatedInput.prompt;
  const internalExecutionOwner: InternalExecutionOwner = {
    kind: 'workflow-agent',
    ...(params.workflowRunId
      ? { workflowRunId: params.workflowRunId }
      : {}),
    ...(params.workflowExecutionId
      ? { workflowExecutionId: params.workflowExecutionId }
      : {}),
    workflowTaskId: params.ctx.callId,
    workflowAgentIndex: params.invocation.index,
    ...(params.invocation.phaseIndex !== undefined
      ? { workflowPhaseIndex: params.invocation.phaseIndex }
      : {}),
    workflowAttempt: params.invocation.attempt ?? 1,
    suppressMainSessionNotification: true,
    disableShellAutoBackground: true,
  };

  const result = await runLocalAgentInvocation({
    definition: runDefinition,
    context: params.config,
    agentArgs: { query: workflowPrompt },
    signal: params.ctx.signal,
    description: updatedInput.description,
    invocationName: updatedInput.name,
    teamName: params.invocation.teamName,
    cwdOverride: updatedInput.cwd,
    isolationOverride: updatedInput.isolation,
    modelOverride: params.invocation.model,
    querySelection: requestedReasoning
      ? { config: { reasoning: { effort: requestedReasoning.reasoningEffort } } }
      : undefined,
    parentModel: params.ctx.modelKey,
    parentToolUseId: params.ctx.callId,
    parentRequestSetId: params.ctx.parentRequestSetId,
    parentBusinessInfo: params.ctx.parentBusinessInfo,
    customContext: params.ctx.customContext,
    updateOutput: (output) => {
      params.onProgress?.(workflowAgentLiveProgress(output));
      params.ctx.updateOutput?.(output);
    },
    onQueryEvent: params.onQueryEvent,
    completionBehavior: 'silent',
    emitSdkSideEvents: true,
    emitSdkTaskNotification: false,
    registerTask: false,
    subscribeMcpProgress: false,
    internalExecutionOwner,
    additionalTools: structuredOutput ? [structuredOutput.tool] : undefined,
    toolConstraints: {
      disallowedTools: params.invocation.disallowedTools,
      bashCommandClamp: params.invocation.bashCommandClamp,
      requiredTools: structuredOutput ? ['StructuredOutput'] : undefined,
    },
  });
  const normalized = normalizeAgentResult(result.toolResult);
  normalized.tokens = result.totalTokens;
  normalized.toolCalls = result.toolCalls;
  if (normalized.apiError) {
    return normalized;
  }
  if (structuredOutput) {
    if (structuredOutput.holder.retryCapExceeded) {
      runLogger.warn(
        `${structuredOutputRetryCapMessage(structuredOutput.holder)}; ` +
          `last input: ${structuredOutputInputPreview(structuredOutput.holder.lastInput)}`,
      );
      throw new Error(structuredOutputRetryCapMessage(structuredOutput.holder));
    }
    if (structuredOutput.holder.result === undefined) {
      throw new Error(
        'agent({schema}): subagent completed without calling StructuredOutput',
      );
    }
    normalized.structured = structuredOutput.holder.result;
    normalized.content = JSON.stringify(structuredOutput.holder.result);
  }
  return normalized;
}

function structuredOutputInputPreview(input: unknown): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(input) ?? String(input);
  } catch {
    rendered = String(input);
  }
  return rendered.length > 300 ? `${rendered.slice(0, 300)}…` : rendered;
}

function workflowAgentLiveProgress(output: unknown): WorkflowAgentLiveProgress | undefined {
  if (!isSubagentProgress(output)) return undefined;
  const toolActivities = output.recentActivity.filter(
    (activity): activity is SubagentActivityItem & { type: 'tool_call' } =>
      activity.type === 'tool_call',
  );
  const lastTool = toolActivities.at(-1);
  const recentToolActivities = toolActivities
    .slice(-3)
    .map((activity) =>
      activity.description
        ? `${activity.displayName ?? activity.content}(${activity.description})`
        : `${activity.displayName ?? activity.content}()`,
    );
  return {
    lastToolName: lastTool?.displayName ?? lastTool?.content,
    lastToolSummary: lastTool?.description,
    recentToolActivities:
      recentToolActivities.length > 0 ? recentToolActivities : undefined,
    ...((output.toolUseCount ?? toolActivities.length) > 0
      ? { toolCalls: output.toolUseCount ?? toolActivities.length }
      : {}),
    lastProgressAt: Date.now(),
  };
}

async function resolveWorkflowAgentDefinition(
  config: Config,
  toolParams: AgentToolParams,
): Promise<{
  updatedInput: AgentToolParams;
  definition: LocalAgentDefinition;
  explicitlyRequestedAgentType: boolean;
}> {
  if (!toolParams.subagent_type) {
    return {
      updatedInput: toolParams,
      definition: createDefaultWorkflowSubagentDefinition(),
      explicitlyRequestedAgentType: false,
    };
  }

  // Judged through the shared object, exactly as a direct Agent call would be.
  // The old path built a throwaway AgentTool and asked it about itself, which
  // consulted neither the rules nor the mode nor the ask handler — a workflow
  // spawn was the one way to start an agent without being judged.
  if (!config.permission) {
    throw new Error(
      'No permission object is available, so this agent invocation cannot be authorized.',
    );
  }

  const decision = await config.permission.check({
    toolName: AGENT_TOOL_NAME,
    input: toolParams as unknown as Record<string, unknown>,
    toolUseId: `workflow-spawn-${randomUUID().slice(0, 8)}`,
  });
  if (decision.kind !== 'allow') {
    const denialReason = (
      decision.toolCheck.extra as { denialReason?: { message?: string } }
    )?.denialReason?.message;
    throw new Error(
      decision.reason?.message ?? denialReason ?? 'Agent invocation denied',
    );
  }

  const updatedInput = toolParams;
  const agentType = updatedInput.subagent_type;
  if (!agentType) {
    return {
      updatedInput,
      definition: createDefaultWorkflowSubagentDefinition(),
      explicitlyRequestedAgentType: false,
    };
  }

  // Still built once, purely to validate the parameters and normalize the
  // requested agent type (exact / case-insensitive / ambiguous matching).
  const validatorTool = new AgentTool(config.getAgentRegistry(), config);
  const resolvedAgentType = validatorTool.resolveAgentTypeName(agentType);
  validatorTool.build({ ...updatedInput, subagent_type: resolvedAgentType });
  const definition = config
    .getAgentRegistry()
    .getDefinition(resolvedAgentType);
  if (!definition) {
    const available = config.getAgentRegistry().getAllAgentNames().join(', ');
    throw new Error(
      `Unknown agent type: '${agentType}'. Available types: ${available}`,
    );
  }
  if (definition.kind !== 'local') {
    throw new Error(
      `Workflow agent '${agentType}' is remote. Workflow currently supports local agents only.`,
    );
  }

  return {
    updatedInput,
    definition,
    explicitlyRequestedAgentType: true,
  };
}

function toAgentToolParams(
  invocation: WorkflowAgentInvocation,
): AgentToolParams {
  const prompt = invocation.prompt?.trim();
  if (!prompt) {
    throw new Error('agent() requires a non-empty prompt');
  }
  return {
    prompt,
    description:
      invocation.description?.trim() ||
      invocation.name?.trim() ||
      prompt.slice(0, 80),
    subagent_type:
      invocation.agentType ?? invocation.type ?? invocation.subagent_type,
    name: invocation.name,
    cwd: invocation.cwd,
    isolation: invocation.isolation,
    run_in_background: false,
  };
}

function createWorkflowStructuredOutput(schema: unknown): {
  holder: WorkflowStructuredOutputResultHolder;
  tool: WorkflowStructuredOutputTool;
} {
  const holder = new WorkflowStructuredOutputResultHolder();
  return {
    holder,
    tool: new WorkflowStructuredOutputTool(holder, schema),
  };
}

const WORKFLOW_SUBAGENT_AGENT_TYPE = 'workflow-subagent';

const WORKFLOW_AGENT_DISALLOWED_TOOLS = [
  WORKFLOW_TOOL_NAME,
  RUN_WORKFLOW_TOOL_NAME,
  'SendUserMessage',
  AGENT_TOOL_NAME,
];

const WORKFLOW_TEXT_SUBAGENT_PROMPT = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: Your final text response is returned **verbatim** as a string to the calling script — it is your return value, not a message to a human.
- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."
- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.
- Do NOT use SendUserMessage to deliver your answer. Put your answer in your final text response.
- Be concise. The script will parse your output.`;

const WORKFLOW_STRUCTURED_SUBAGENT_PROMPT = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: You MUST call the StructuredOutput tool exactly once to return your final answer. The tool's input schema defines the required shape.
- Do your work (Read files, run commands, etc.), then call StructuredOutput with your answer.
- Do NOT put your answer in a text response. The script reads ONLY the StructuredOutput tool call.
- If the schema validation fails, read the error and call StructuredOutput again with a corrected shape.
- After calling StructuredOutput successfully, end your turn. No acknowledgment needed.`;

const WORKFLOW_TEXT_USER_NOTE =
  'NOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human. Output the literal result; do not output confirmations like "Done." Be concise — the script will parse your output.';

const WORKFLOW_STRUCTURED_USER_NOTE =
  'NOTE: You are running inside a workflow script. You MUST return your final answer by calling the StructuredOutput tool exactly once — the tool\'s input schema defines the required shape. Do your work, then call StructuredOutput; do NOT put your answer in a text response (the script reads ONLY the tool call). If validation fails, read the error and call StructuredOutput again with a corrected shape.';

function createDefaultWorkflowSubagentDefinition(): LocalAgentDefinition {
  return {
    kind: 'local',
    name: WORKFLOW_SUBAGENT_AGENT_TYPE,
    description: 'Internal subagent for workflow script orchestration.',
    modelConfig: {
      model: 'inherit',
    },
    toolConfig: {
      tools: ['*'],
    },
    disallowedTools: [...WORKFLOW_AGENT_DISALLOWED_TOOLS],
    promptConfig: {
      systemPrompt: '',
    },
  };
}

function withWorkflowAgentIsolation(
  definition: LocalAgentDefinition,
): LocalAgentDefinition {
  const disallowedTools = new Set([
    ...(definition.disallowedTools ?? []),
    ...WORKFLOW_AGENT_DISALLOWED_TOOLS,
  ]);
  return {
    ...definition,
    disallowedTools: [...disallowedTools],
  };
}

function withWorkflowAgentPrompt(
  definition: LocalAgentDefinition,
  options: { structured: boolean; preserveBasePrompt: boolean },
): LocalAgentDefinition {
  const workflowPrompt = options.structured
    ? WORKFLOW_STRUCTURED_SUBAGENT_PROMPT
    : WORKFLOW_TEXT_SUBAGENT_PROMPT;
  const basePrompt = definition.promptConfig.systemPrompt?.trim();
  const systemPrompt =
    options.preserveBasePrompt && basePrompt
      ? `${basePrompt}\n\n---\n\n${options.structured ? WORKFLOW_STRUCTURED_USER_NOTE : WORKFLOW_TEXT_USER_NOTE}`
      : workflowPrompt;
  return {
    ...definition,
    promptConfig: {
      ...definition.promptConfig,
      systemPrompt,
    },
  };
}

function normalizeAgentResult(result: ToolResult): WorkflowAgentResult {
  const structured = result.toolUseResult;
  if (isAgentToolCompletionResult(structured)) {
    if (structured.state === 'error') {
      if (structured.apiError) {
        return {
          content: structured.content,
          state: 'error',
          apiError: structured.apiError,
          agentId: structured.agentId,
          agentType: structured.agentType,
          outputPath: structured.outputPath,
          transcriptPath: structured.transcriptPath,
          rawResult: structured,
        };
      }
      throw new Error(structured.content);
    }
    return {
      content: structured.content,
      state: 'done',
      agentId: structured.agentId,
      agentType: structured.agentType,
      outputPath: structured.outputPath,
      transcriptPath: structured.transcriptPath,
      rawResult: structured,
    };
  }

  if (isAgentToolBackgroundLaunchResult(structured)) {
    return {
      content: `Agent '${structured.description}' is running in the background.`,
      state: 'backgrounded',
      agentId: structured.agentId,
      outputPath: structured.outputFile,
      rawResult: structured,
    };
  }

  if (result.error) {
    throw new Error(result.error.message);
  }

  return {
    content: toolResultText(result.llmContent),
    state: result.isError ? 'error' : 'done',
    rawResult: result.toolUseResult,
  };
}

function toolResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => toolResultText(item)).join('\n');
  }
  if (hasTextProperty(value)) {
    return value.text;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function hasTextProperty(value: unknown): value is { text: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { text?: unknown }).text === 'string'
  );
}
