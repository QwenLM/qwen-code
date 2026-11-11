/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendSystemPromptText } from '../prompts/system-prompt.js';
import { cloneFileStateCache } from '../utils/fileStateCache.js';
import { createHash } from 'node:crypto';
import type {
  AnyDeclarativeTool,
  ToolLiveOutput,
  ToolResult,
} from '../tools/tools.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { AgentToolConstraints } from '../tools/agent-tool-constraints.js';
import {
  createUserAbortError,
  isFileAccessDeniedError,
  warnFileAccessDegraded,
} from '../utils/errors.js';
import { checkExhaustive } from '../utils/checks.js';
import type {
  AgentInputs,
  AgentTerminationDetails,
  LocalAgentDefinition,
  SubagentActivityItem,
} from './types.js';
import {
  AgentTerminateMode,
  DEFAULT_LOCAL_SUBAGENT_MAX_TURNS,
  DEFAULT_QUERY_STRING,
  formatMaxTurnsReachedNotice,
} from './types.js';
import { ENV_SUBAGENT_MODEL } from '../config/brand.js';
import {
  readAgentSelectionDefaults,
  resolveConfiguredAgentModel,
} from './agentModelConfig.js';
import { MODEL_ALIAS_AUTO } from '../config/models.js';
import {
  buildSubagentRegistries,
  buildSubagentSystemPrompt,
} from './agent-setup.js';
import {
  createAgentWorktree,
  removeAgentWorktree,
  cleanupStaleAgentWorktrees,
  hasWorktreeChanges,
  hasWorktreeCreateHook,
  hasWorktreeRemoveHook,
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
  findProjectRootForWorktree,
  MAX_WORKTREE_SLUG_LENGTH,
  type WorktreeInfo,
} from '../services/worktreeService.js';
import { readGitHead, resolveGitRepositoryLayout } from '../utils/gitUtils.js';
import { inspectWorktreeOwnership } from '../services/worktree-owner-state.js';
import { withWorktreeReservation } from '../services/worktree/creationReservation.js';
import {
  createSubagentTranscriptRecorder,
  getSubagentTranscriptDir,
  getSubagentTranscriptPath,
  getSubagentArtifactContext,
  writeSubagentMetadata,
  type LoadedSubagentTranscript,
  type SubagentMetadata,
} from '../services/subagent-transcript.js';
import {
  completeAgentTaskRecord,
  updateAgentTaskRecord,
} from './agent-task-runtime.js';
import {
  buildSkillPromptContent,
  prepareSkillBody,
  createSkillShellPermissionCheck,
  buildSkillMetadataTags,
} from '../skills/inlineSkillActivation.js';
import type { QueryEvent, Terminal } from '../core/query-event.js';
import type { Message } from '../protocol/transcript/message.js';
import type { ModelStreamUserContent } from '../provider/modelStreamRequest.js';
import { createUserMessage } from '../protocol/transcript/conversions.js';
import type { SidechainTranscriptRecorder } from '../services/transcript/writer-handle.js';
import { AGENT_TOOL_NAME } from '../tools/tool-names.js';
import type { InternalExecutionOwner } from '../tools/tool-types.js';
import {
  FORK_QUERY_SOURCE,
  buildForkDirectivePrompt,
  buildWorktreeNotice,
  wrapWithParentToolSchemas,
} from './fork-subagent.js';
import {
  buildForkContextMessages,
  completeForkContextMessages,
} from '../utils/forkContextUtils.js';
import { buildModelProjectionOptions } from '../utils/modelProjectionOptions.js';



import { runWithAgentContext } from '../utils/agentContext.js';
import { getCwd, runWithCwdOverride } from '../utils/Shell.js';
import {
  clearFrontmatterHooks,
  registerFrontmatterHooks,
} from '../hooks/sessionHooks.js';
import { runSubagent, type RunSubagentParams } from './run-subagent.js';
import { runForkedAgent } from '../core/forkedAgent.js';
import { createAttachmentContext } from '../attachments/get-attachments.js';
import { isContextAttachmentMessage } from '../attachments/context-messages.js';
import { HookEventName, truncateHookOutput } from '../hooks/types.js';
import type { BusinessInfo } from '../qoder/business-info.js';
import type { ProgressTracker } from './progressTracker.js';
import { CoreToolCallStatus } from '../tool-executor/types.js';
import {
  getToolUseDisplayMetadata,
  type ToolUseDisplayMetadataOptions,
} from '../tools/tool-use-display.js';
import { flushTaskOutput } from '../utils/task/diskOutput.js';
import { runLogger } from '../utils/runLogger.js';
import {
  customContextContext,
  snapshotCustomContext,
} from '../utils/sessionIdContext.js';


import { renderUserMemory } from '../prompts/snippets.js';
import {
  createTaskNotificationEvent,
  createTaskProgressEvent,
  createTaskStartedEvent,
  countUsageTotalTokens,
  enqueueSubagentSdkEvent,
} from './subagent-sdk-events.js';
import { buildAgentToolCompletionResult } from './agent-tool-result.js';
import { SubagentHookCoordinator } from '../hooks/coordinators.js';
import type { AgentUnifiedTask } from '../tasks/unified-task.js';
import { createAgentTeamTools } from './teams/agent-team-tools.js';
import { IN_PROCESS_TEAMMATE_TASK_TYPE } from './teams/agent-teams-feature.js';
import {
  updateAgentTeamMemberStatus,
  getAgentTeamConfigPath,
} from './teams/agent-team-runtime.js';
import { createAgentTeamHookCoordinator } from './teams/agent-team-hook-coordinator.js';
import { deriveTeammateIdleSummary } from './teams/agent-team-main-delivery.js';

/**
 * Extract text from the last assistant message that contains text blocks.
 *
 * Note: `splitAssistantMessage()` in agent-loop.ts splits a single API
 * response into N AssistantMessages (one per content block). So the last
 * message in the array is typically a single `tool_use` block. This function
 * walks backward to find the most recent assistant message that has text
 * content — this is the subagent's final answer, not intermediate reasoning.
 */
function extractLastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type !== 'assistant') continue;
    const textBlocks = m.message.content.filter(
      (block) => block.type === 'text',
    );
    if (textBlocks.length > 0) {
      return textBlocks.map((b) => b.text ?? '').join('');
    }
  }
  return '';
}

function updateInProgressToolUseIds(
  event: QueryEvent,
  unresolvedIds: Set<string>,
): void {
  if (event.type === 'assistant') {
    event.message.content.forEach((block) => {
      if (block.type === 'tool_use') unresolvedIds.add(block.id);
    });
  } else if (
    event.type === 'user' &&
    typeof event.message.content !== 'string'
  ) {
    for (const block of event.message.content) {
      if (block.type === 'tool_result') unresolvedIds.delete(block.tool_use_id);
    }
  }
}

function countToolUseBlocks(messages: Message[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    const content = message.message?.content;
    if (!Array.isArray(content)) continue;
    total += content.filter((block) => block.type === 'tool_use').length;
  }
  return total;
}

function mapCompletedToolCallStatus(
  status:
    | CoreToolCallStatus.Success
    | CoreToolCallStatus.Error
    | CoreToolCallStatus.Cancelled,
): Exclude<SubagentActivityItem['status'], 'running'> {
  switch (status) {
    case CoreToolCallStatus.Success:
      return 'completed';
    case CoreToolCallStatus.Error:
      return 'error';
    case CoreToolCallStatus.Cancelled:
      return 'cancelled';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function getCompletedToolDisplay(
  toolCall: {
    status:
      | CoreToolCallStatus.Success
      | CoreToolCallStatus.Error
      | CoreToolCallStatus.Cancelled;
    request: { name: string; args?: unknown };
    tool?: { displayName?: string };
    invocation?: { getDescription?: () => string };
  },
  options?: ToolUseDisplayMetadataOptions,
) {
  const args =
    typeof toolCall.request.args === 'object' && toolCall.request.args !== null
      ? (toolCall.request.args as Record<string, unknown>)
      : {};
  const metadata = getToolUseDisplayMetadata(
    toolCall.request.name,
    args,
    options,
  );
  const description =
    toolCall.invocation?.getDescription?.() ?? metadata.description;

  return {
    displayName: toolCall.tool?.displayName ?? metadata.displayName,
    description,
  };
}

export interface RunAgentParams {
  definition: LocalAgentDefinition;
  context: AgentLoopContext;
  agentArgs: AgentInputs;
  tracker: ProgressTracker;
  signal: AbortSignal;
  taskId: string;
  taskType?: AgentUnifiedTask['type'];
  agentId: string;
  outputPath: string;
  description: string;
  invocationName?: string;
  teamName?: string;
  cwdOverride?: string;
  isolationOverride?: string;
  modelOverride?: string;
  querySelection?: RunSubagentParams['querySelection'];
  /** Effective model of the parent request that initiated this invocation. */
  parentModel?: string;
  /** 已解析的模型，用于保证任务登记与实际执行一致。 */
  resolvedModel?: string;
  isForkPath: boolean;
  parentToolUseId?: string;
  appendOutput?: (chunk: string) => void;
  updateOutput?: (output: ToolLiveOutput) => void;
  onQueryEvent?: (event: QueryEvent) => void;
  emitSdkSideEvents?: boolean;
  /**
   * Whether runAgent should publish task_started itself. AgentInvocation
   * publishes it before an asynchronous launch returns so consumers observe
   * registration before the launch result; direct runAgent callers keep the
   * existing behavior by default.
   */
  emitSdkTaskStarted?: boolean;
  emitSdkTaskNotification?: boolean;
  /** Prior runtime history and durable sidechain leaf for a continued agent. */
  resumeState?: AgentResumeState;
  /** Inject the one-time team_context attachment for a teammate's first turn. */
  includeTeammateContext?: boolean;
  /** Keep the persisted task active when a teammate finishes one model turn. */
  preserveTaskOnTeammateIdle?: boolean;
  additionalTools?: AnyDeclarativeTool[];
  toolConstraints?: AgentToolConstraints;
  /**
   * Whether the subagent's isolated Scheduler should subscribe to global MCP
   * progress. High fan-out workflow agents do not surface per-MCP progress and
   * pass false to avoid transient listener bursts on coreEvents.
   */
  subscribeMcpProgress?: boolean;
  /**
   * Parent agent's requestSetId, passed from ToolUseContext.
   * Used for subagent request grouping without AsyncLocalStorage.
   */
  parentRequestSetId?: string;
  /** Opaque SDK context inherited from the parent query. */
  customContext?: Readonly<Record<string, string>>;
  /** Read-only owner correlation captured by the invocation boundary. */
  ownerAgentId?: string;
  /** Whether the invocation was launched asynchronously. */
  runInBackground?: boolean;
  /**
   * Parent agent's BusinessInfo (read-only), passed from ToolUseContext.
   * Used for subagent lifecycle inheritance without AsyncLocalStorage.
   */
  parentBusinessInfo?: Readonly<BusinessInfo>;
  /** Internal owner metadata for nested tool executions. */
  internalExecutionOwner?: InternalExecutionOwner;
}

export interface AgentResumeState {
  /** Runtime messages that must be supplied before the next agent prompt. */
  messages: Message[];
  /** Durable sidechain leaf that the next transcript record must extend. */
  transcriptLeafUuid?: string;
}

/** Derives resume state from a restored subagent transcript, if there is one. */
export function toAgentResumeState(
  transcript: LoadedSubagentTranscript | null | undefined,
): AgentResumeState | undefined {
  return transcript
    ? {
        messages: transcript.messages,
        transcriptLeafUuid: transcript.leafUuid,
      }
    : undefined;
}

export interface RunAgentResult {
  taskId: string;
  agentId: string;
  finalResult: string;
  terminateReason: AgentTerminateMode;
  terminationDetails?: AgentTerminationDetails;
  apiError?: string;
  outputPath?: string;
  transcriptPath?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  totalTokens?: number;
  toolCalls?: number;
  durationMs?: number;
  teammateIdleSummary?: string;
  toolResult: ToolResult;
}

function mapTerminalReasonToAgentTerminateMode(
  terminalReason: Terminal['reason'] | undefined,
  signal: AbortSignal,
  timeoutSignal?: AbortSignal,
): AgentTerminateMode | undefined {
  switch (terminalReason) {
    case 'abort':
    case 'repeated_tool_call_denied':
      return timeoutSignal?.aborted && !signal.aborted
        ? AgentTerminateMode.TIMEOUT
        : AgentTerminateMode.ABORTED;
    case 'error':
      return AgentTerminateMode.ERROR;
    case 'max_turns':
      return AgentTerminateMode.MAX_TURNS;
    case 'end_turn':
    case undefined:
      return undefined;
    default:
      return checkExhaustive(terminalReason);
  }
}

function getInvocationSummary(
  invocationName: string | undefined,
  description: string,
  definition: LocalAgentDefinition,
): string {
  return invocationName?.trim() || description.trim() || definition.name;
}

function resolveIsolation(
  definition: LocalAgentDefinition,
  isolationOverride?: string,
): string | undefined {
  if (isolationOverride === 'worktree') {
    return 'worktree';
  }
  if (isolationOverride === 'default') {
    return undefined;
  }
  return definition.isolation;
}

export function buildAgentWorktreeSlug(
  agentType: string,
  agentId: string,
): string {
  const suffix = agentWorktreeSuffix(agentId);
  const prefix = 'agent-';
  const maxNameLength =
    MAX_WORKTREE_SLUG_LENGTH - prefix.length - 1 - suffix.length;
  const safeAgentType = sanitizeWorktreeSlugPart(agentType);
  const trimmedAgentType =
    safeAgentType.length > maxNameLength
      ? safeAgentType.slice(0, maxNameLength).replace(/[._-]+$/g, '')
      : safeAgentType;
  const name = trimmedAgentType || 'agent';
  return `${prefix}${name}-${suffix}`;
}

function sanitizeWorktreeSlugPart(value: string): string {
  const slug = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  return slug && slug !== '.' && slug !== '..' ? slug : 'agent';
}

function agentWorktreeSuffix(agentId: string): string {
  const hexSuffix = agentId.match(/[0-9a-f]{8,}$/i)?.[0];
  if (hexSuffix) return hexSuffix.slice(-8).toLowerCase();
  return createHash('sha256').update(agentId).digest('hex').slice(0, 8);
}

export async function resolveAgentModel(
  context: AgentLoopContext,
  definition: LocalAgentDefinition,
  modelOverride?: string,
  parentModel?: string,
): Promise<string> {
  const manager = context.config.getModelProviderManager();
  const resolveParentModel = async (): Promise<string> => {
    const candidates = [
      parentModel,
      context.getCacheSafeQuerySnapshot?.()?.model,
      context.config.getActiveModel(),
      context.config.getModel(),
    ];
    for (const candidate of candidates) {
      const normalized = candidate?.trim();
      if (normalized && normalized !== 'inherit') return normalized;
    }
    return (
      (await manager.listModels()).find(
        (model) => model.isDefault === true && model.enabled !== false,
      )?.key ?? MODEL_ALIAS_AUTO
    );
  };

  // A fork is the same agent with inherited context, so it also inherits the
  // parent model. Ignore invocation, definition, and subagent-env overrides.
  if (definition.pinToParentModel) {
    return resolveParentModel();
  }

  const envSubagentModel = process.env[ENV_SUBAGENT_MODEL]?.trim();
  if (envSubagentModel && envSubagentModel !== 'inherit') {
    return (
      (await resolveConfiguredAgentModel(manager, envSubagentModel))?.key ??
      envSubagentModel
    );
  }
  const normalizedOverride = modelOverride?.trim();
  if (normalizedOverride) {
    return normalizedOverride === 'inherit'
      ? resolveParentModel()
      : ((await resolveConfiguredAgentModel(manager, normalizedOverride))
          ?.key ?? normalizedOverride);
  }

  const definitionModel = definition.modelConfig.model?.trim();
  if (!definitionModel || definitionModel === 'inherit') {
    return resolveParentModel();
  }

  // Resolve display names before execution. Unknown keys still reach provider
  // validation; an explicit model must never silently inherit the parent model.
  return (
    (await resolveConfiguredAgentModel(manager, definitionModel))?.key ??
    definitionModel
  );
}

interface TaskProgressState {
  lastToolName?: string;
  lastToolDescription?: string;
  totalTokens: number;
  toolUses: number;
  startedAt: number;
}

function getToolActivityDescription(
  toolRegistry: AgentLoopContext['toolRegistry'],
  toolName: string | undefined,
  toolInput: unknown,
): string | undefined {
  if (!toolName || !toolInput || typeof toolInput !== 'object') {
    return undefined;
  }

  try {
    return toolRegistry
      .getTool(toolName)
      ?.build(toolInput as Record<string, unknown>)
      .getDescription();
  } catch {
    return undefined;
  }
}

function updateTaskProgressState(
  progress: TaskProgressState,
  event: QueryEvent,
  toolRegistry: AgentLoopContext['toolRegistry'],
): boolean {
  if (event.type !== 'assistant') {
    return false;
  }

  const toolUseBlocks = event.message.content.filter(
    (block): block is Extract<typeof block, { type: 'tool_use' }> =>
      block.type === 'tool_use',
  );
  if (toolUseBlocks.length === 0) {
    return false;
  }

  progress.toolUses += toolUseBlocks.length;
  progress.totalTokens += countUsageTotalTokens(event.message.usage);

  const lastToolUse = toolUseBlocks.at(-1);
  progress.lastToolName = lastToolUse?.name;
  progress.lastToolDescription = getToolActivityDescription(
    toolRegistry,
    lastToolUse?.name,
    lastToolUse?.input,
  );

  return true;
}

interface SubagentRequest {
  /** Unmodified task supplied by the launching agent. */
  prompt: ModelStreamUserContent;
  /** Synthetic context kept separate from the launching agent's task. */
  contextMessages: Message[];
}

const TEAMMATE_SYSTEM_PROMPT_ADDENDUM = `
# Agent Teammate Communication

IMPORTANT: You are running as an agent in a team. To communicate with anyone on your team, use the SendMessage tool with \`to: "<name>"\` to send messages to specific teammates.

Just writing a response in text is not visible to others on your team - you MUST use the SendMessage tool.

The user interacts primarily with the team lead. Your work is coordinated through the task system and teammate messaging.
`;

function buildTeammateContextReminder(params: {
  teammateName: string;
  teamName: string;
  context: AgentLoopContext;
}): string {
  return `<system-reminder>
# Team Coordination

You are a teammate in this session's agent team.

**Your Identity:**
- Name: ${params.teammateName}

**Team Resources:**
- Team config: ${getAgentTeamConfigPath(params.teamName)}
- Task list: ${params.context.config.getTaskStore().taskListDir}

**Team Leader:** The team lead's name is "team-lead". Send updates and completion notifications to them.

Read the team config to discover your teammates' names. Check the task list periodically. Create new tasks when work should be divided. Mark tasks resolved when complete.

**IMPORTANT:** Always refer to active teammates by their NAME (e.g., "team-lead", "analyzer", "researcher"). Use an \`agentId\` (format \`a...-...\`, from the spawn result) only to resume a background agent that has already completed. When messaging, use the name directly:

\`\`\`json
{
  "to": "team-lead",
  "message": "Your message here",
  "summary": "Brief 5-10 word preview"
}
\`\`\`
</system-reminder>`;
}

async function buildSubagentRequest(params: {
  definition: LocalAgentDefinition;
  context: AgentLoopContext;
  skillContext: AgentLoopContext;
  agentArgs: AgentInputs;
  worktreeInfo?: WorktreeInfo;
  cwdOverride?: string;
}): Promise<SubagentRequest> {
  const {
    definition,
    context,
    skillContext,
    agentArgs,
    worktreeInfo,
    cwdOverride,
  } = params;
  const inputQuery: unknown = agentArgs['query'];
  const callerQuery =
    typeof inputQuery === 'string' ? inputQuery : DEFAULT_QUERY_STRING;
  const contextMessages: Message[] = [];
  // Every synthetic message is meta so it never counts as the delegated task.
  const pushMeta = (text: string) =>
    contextMessages.push(createUserMessage(text, { isMeta: true }));

  // Built-in read-only agents omit project/session instructions to keep their
  // narrow search and planning contexts small.
  if (!definition.omitAgentsMd) {
    const systemMemory = context.config.getSystemInstructionMemory();
    if (systemMemory) {
      pushMeta(
        `<system-reminder>\n${renderUserMemory(systemMemory)}\n</system-reminder>`,
      );
    }

    const sessionMemory = context.config.getSessionMemory();
    if (sessionMemory) {
      pushMeta(sessionMemory);
    }
  }

  if (worktreeInfo) {
    pushMeta(
      `<worktree_context>
You are running in an isolated git worktree at: ${worktreeInfo.path}
All file operations should use this directory as the working directory.
The worktree was created from commit ${worktreeInfo.baseSha}.
Changes made here will not affect the main working tree until explicitly merged.
</worktree_context>`,
    );
  } else if (cwdOverride) {
    pushMeta(`<working_directory>${cwdOverride}</working_directory>`);
  }

  if (definition.skills && definition.skills.length > 0) {
    const skillManager = context.config.getSkillManager();
    const skillEntries = definition.skills
      .map((skillName) => {
        const skill = skillManager.getSkill(skillName);
        return skill && !skill.disabled ? { skillName, skill } : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const skillBodyOptions = {
      toolNames: skillContext.toolRegistry.getAllToolNames(),
    };
    const skillBodies = await Promise.all(
      skillEntries.map(async ({ skill, skillName }) => {
        const skillDir = skill.skillRoot;
        const body = await prepareSkillBody(
          context.config,
          skill,
          skillName,
          skillDir,
          '',
          createSkillShellPermissionCheck(context.config, skill, skillContext),
          skillBodyOptions,
        );
        return buildSkillPromptContent(skill, body);
      }),
    );

    for (let index = 0; index < skillEntries.length; index++) {
      const name = skillEntries[index].skillName;
      pushMeta(`${buildSkillMetadataTags(name)}\n\n${skillBodies[index]}`);
    }
  }

  return { prompt: callerQuery, contextMessages };
}

export async function runAgent(
  params: RunAgentParams,
): Promise<RunAgentResult> {
  const {
    definition: originalDefinition,
    context,
    agentArgs,
    tracker,
    signal,
    taskId,
    taskType = 'local_agent',
    agentId,
    outputPath,
    description,
    invocationName,
    teamName,
    cwdOverride,
    isolationOverride,
    modelOverride,
    querySelection,
    parentModel,
    resolvedModel,
    isForkPath,
    parentToolUseId,
    appendOutput,
    updateOutput,
    onQueryEvent,
    emitSdkSideEvents = true,
    emitSdkTaskStarted = emitSdkSideEvents,
    emitSdkTaskNotification = emitSdkSideEvents,
    resumeState,
    includeTeammateContext = false,
    preserveTaskOnTeammateIdle = false,
    additionalTools,
    toolConstraints,
    subscribeMcpProgress,
    parentRequestSetId,
    customContext,
    runInBackground = false,
    parentBusinessInfo,
    internalExecutionOwner,
  } = params;
  const parentSnapshot = context.getCacheSafeQuerySnapshot?.();
  let definition = originalDefinition;
  const maxTurns = isForkPath
    ? 200
    : (definition.runConfig?.maxTurns ?? DEFAULT_LOCAL_SUBAGENT_MAX_TURNS);
  const startTime = Date.now();
  const rootSessionId = context.config.getSessionId();
  const sessionPersistence = context.config.getSessionPersistence();
  const artifactContext = getSubagentArtifactContext(context.config);
  const effectiveIsolation = resolveIsolation(definition, isolationOverride);
  const invocationSummary = getInvocationSummary(
    invocationName,
    description,
    definition,
  );
  const queryText = agentArgs['query'];
  let terminateReason: AgentTerminateMode = AgentTerminateMode.ERROR;
  let finalResult: string | null = null;
  let totalTokens = 0;
  let toolCalls = 0;
  let terminal: Terminal | undefined;
  let queryLoopStarted = false;
  let worktreeStartedAt: number | undefined;
  let worktreeDurationMs: number | undefined;
  let failureStage = 'runtime_setup';
  let apiError: string | undefined;
  let teammateIdleSummary: string | undefined;
  let worktreeInfo: WorktreeInfo | undefined;
  let worktreeCreateResult:
    | Awaited<ReturnType<typeof createAgentWorktree>>
    | undefined;
  let transcriptWriter: SidechainTranscriptRecorder | undefined;
  let transcriptPath: string | undefined;
  const branchController = new AbortController();
  let branchObservation: SubagentMetadata['gitBranchObservation'];
  let initialMetadata: SubagentMetadata | undefined;
  let branchObservationFrozen = false;
  const freezeBranchObservation = () => {
    branchObservationFrozen = true;
    branchController.abort();
  };
  const registryTaskId = `a-${agentId}`;
  const markTranscriptUnavailable = () => {
    transcriptPath = undefined;
    // `outputPath` is a symlink to the transcript. Once persistence degrades,
    // make the in-memory registry the lossless source for an expanded viewer.
    context.taskRegistry?.update(registryTaskId, { outputPath: undefined });
  };
  let registries:
    | Awaited<ReturnType<typeof buildSubagentRegistries>>
    | undefined;
  let teammateHookCoordinator:
    | ReturnType<typeof createAgentTeamHookCoordinator>
    | undefined;
  const taskProgress: TaskProgressState = {
    totalTokens: 0,
    toolUses: 0,
    startedAt: Date.now(),
  };
  let emittedTaskNotification = false;

  // Paired stage logs locate an unresolved startup await even when no
  // transcript exists yet. Never include prompt or hook output here.
  const runStartupStage = async <T>(
    stage: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = performance.now();
    const identity = `agentId=${agentId} taskId=${taskId} sessionId=${rootSessionId} stage=${stage}`;
    runLogger.log(`[SubagentRun] startup.start ${identity}`);
    try {
      const result = await operation();
      runLogger.log(
        `[SubagentRun] startup.finish ${identity} durationMs=${Math.round(performance.now() - startedAt)}`,
      );
      return result;
    } catch (error) {
      runLogger.warn(
        `[SubagentRun] startup.failed ${identity} durationMs=${Math.round(performance.now() - startedAt)}`,
      );
      throw error;
    }
  };

  const emitTaskNotification = (
    status: 'completed' | 'failed' | 'stopped',
  ): void => {
    if (
      !emitSdkSideEvents ||
      !emitSdkTaskNotification ||
      !parentToolUseId ||
      emittedTaskNotification
    ) {
      return;
    }
    enqueueSubagentSdkEvent(
      rootSessionId,
      createTaskNotificationEvent({
        sessionId: rootSessionId,
        taskId,
        toolUseId: parentToolUseId,
        status,
        outputFile: '',
        summary:
          terminateReason === AgentTerminateMode.MAX_TURNS
            ? `${description}: ${formatMaxTurnsReachedNotice(maxTurns)}`
            : description,
        usage: {
          total_tokens: totalTokens,
          tool_uses: toolCalls,
          duration_ms: Date.now() - startTime,
        },
      }),
    );
    emittedTaskNotification = true;
  };

  try {
    updateOutput?.(tracker.makeProgress('running'));

    runLogger.log(
      `[SubagentRun] start agentId=${agentId} taskId=${taskId} agentType=${definition.name} invocationName=${invocationName ?? ''} description=${description} sessionId=${context.config.getSessionId()} parentToolUseId=${parentToolUseId ?? ''} fork=${String(isForkPath)} isolation=${effectiveIsolation ?? 'default'} outputPath=${outputPath}`,
    );

    // task_started is emitted AFTER buildSubagentRegistries below so we can
    // include the subagent's effective tool list (post tool whitelist / MCP
    // discovery / disallowedTools blacklist) in SDKTaskStartedMessage.tools.
    // SDK clients use that field for deterministic verification of
    // AgentDefinition.tools / disallowedTools enforcement.

    if (effectiveIsolation === 'worktree') {
      runLogger.log(
        `[SubagentRun] startup.start agentId=${agentId} taskId=${taskId} sessionId=${rootSessionId} stage=worktree`,
      );
      failureStage = 'worktree_setup';
      worktreeStartedAt = Date.now();
      const configuredProjectRoot = context.config.getProjectRoot();
      const hookSystem = context.config.getHookSystem();

      // Hooks own their VCS/path semantics. Built-in Git worktrees must be
      // rooted at the canonical main checkout; otherwise spawning a child
      // while the parent is already inside a worktree creates a nested
      // `.qwen/worktrees` hierarchy under the linked checkout.
      const usesCreateHook = hookSystem
        ? hasWorktreeCreateHook({
            getRegistry: () => hookSystem.getRegistry(),
          })
        : false;
      const projectRoot = await resolveAgentWorktreeProjectRoot(
        configuredProjectRoot,
        usesCreateHook,
      );

      // Best-effort stale worktree cleanup before creating a new one
      try {
        await cleanupStaleAgentWorktrees(
          new Date(Date.now() - 24 * 60 * 60 * 1000),
          projectRoot,
        );
      } catch {
        // Stale cleanup is best-effort; don't block agent execution.
      }

      const agentSlug = buildAgentWorktreeSlug(definition.name, agentId);

      // Try hook-based creation first, fall back to git worktree
      const hookAdapter = hookSystem
        ? {
            hasWorktreeCreateHook: () => usesCreateHook,
            executeWorktreeCreateHook: (name: string) =>
              executeWorktreeCreateHook(hookSystem, name),
          }
        : undefined;

      if (hookAdapter?.hasWorktreeCreateHook()) {
        try {
          const hookResult =
            await hookAdapter.executeWorktreeCreateHook(agentSlug);
          // Hook 管理创建过程，但返回目录仍不能绕过会话 owner 和切换事务。
          await withWorktreeReservation(
            hookResult.worktreePath,
            async (reservation) => {
              const ownership = await inspectWorktreeOwnership(
                hookResult.worktreePath,
                rootSessionId,
                true,
                projectRoot,
              );
              if (ownership !== 'not-owned') {
                throw new Error(
                  `Cannot use agent worktree at ${hookResult.worktreePath}: ownership is present or cannot be verified.`,
                );
              }
              reservation.assertHeld();
            },
          );
          worktreeCreateResult = {
            worktreePath: hookResult.worktreePath,
            worktreeBranch: undefined,
            headCommit: '',
            gitRoot: projectRoot,
          };
          runLogger.debug(
            `Created hook-based agent worktree at: ${hookResult.worktreePath}`,
          );
        } catch (e: unknown) {
          throw new Error(
            `WorktreeCreate hook failed for agent "${agentSlug}": ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      } else {
        worktreeCreateResult = await createAgentWorktree(
          agentSlug,
          projectRoot,
          {
            ...context.config.getWorktreeCreationSettings(),
            // Keep the child directory rooted at the canonical repository, but
            // resolve `head` from the parent's active checkout. These are
            // separate concerns: a parent already inside a worktree may have a
            // different HEAD that the child is expected to inherit.
            fromCwd: getCwd(),
          },
        );
      }

      worktreeInfo = {
        name: agentSlug,
        path: worktreeCreateResult.worktreePath,
        baseSha: worktreeCreateResult.headCommit,
      };
      context.config.getWorkspaceContext().addDirectory(worktreeInfo.path);

      // Worktree-isolated agents automatically use 'acceptEdits' permission mode.
      // Since the agent operates in an isolated copy of the repo, file edits and
      // shell commands are safe — the main working tree is never touched.
      // This avoids per-tool permission prompts that defeat the purpose of parallel execution.
      if (
        !definition.permissionMode ||
        definition.permissionMode === 'default'
      ) {
        definition = { ...definition, permissionMode: 'acceptEdits' };
      }
      worktreeDurationMs = Date.now() - worktreeStartedAt;
      runLogger.log(
        `[SubagentRun] startup.finish agentId=${agentId} taskId=${taskId} sessionId=${rootSessionId} stage=worktree durationMs=${worktreeDurationMs}`,
      );
      failureStage = 'runtime_setup';
    }

    const effectiveWorkingDirectory =
      cwdOverride ?? worktreeInfo?.path ?? getCwd();
    const transcriptGitBranch = worktreeCreateResult?.worktreeBranch;
    if (!transcriptGitBranch && !signal.aborted) {
      const signalForBranch = AbortSignal.any([
        signal,
        branchController.signal,
      ]);
      const deadline = Date.now() + 2_000;
      void resolveGitRepositoryLayout(effectiveWorkingDirectory, {
        signal: signalForBranch,
        timeoutMs: 2_000,
      })
        .then((layout) =>
          layout && !signalForBranch.aborted
            ? readGitHead(layout, {
                signal: signalForBranch,
                timeoutMs: Math.max(0, deadline - Date.now()),
              })
            : null,
        )
        .then((head) => {
          if (branchObservationFrozen || signal.aborted) return;
          const branch = head?.branch;
          if (branch) {
            branchObservation = {
              branch,
              cwd: effectiveWorkingDirectory,
              observedAt: new Date().toISOString(),
            };
          }
        })
        .catch(() => {
          // Optional metadata must never fail startup or produce an unhandled rejection.
        });
    }
    const worktreeBranch = worktreeInfo ? transcriptGitBranch : undefined;
    const promptId = context.promptId;
    if (sessionPersistence) {
      try {
        transcriptWriter = await runStartupStage('transcript_writer', () =>
          createSubagentTranscriptRecorder(
            context.config,
            agentId,
            taskId,
            markTranscriptUnavailable,
            {
              cwd: effectiveWorkingDirectory,
              gitBranch: transcriptGitBranch,
            },
          ),
        );
        transcriptPath = getSubagentTranscriptPath(
          artifactContext,
          context.config.getSessionId(),
          agentId,
        );

        runLogger.log(
          `[SubagentRun] transcript agentId=${agentId} taskId=${taskId} sessionId=${context.config.getSessionId()} transcriptPath=${transcriptPath}`,
        );

        const metadata: SubagentMetadata = {
          agentType: definition.name,
          ...(parentToolUseId ? { toolUseId: parentToolUseId } : {}),
          description,
          invocationName,
          teamName,
          isolation: effectiveIsolation,
          worktreePath: worktreeInfo?.path,
          worktreeBranch,
          color: definition.color,
        };
        await runStartupStage('transcript_metadata', () =>
          writeSubagentMetadata(context.config, agentId, metadata),
        );
        initialMetadata = metadata;
      } catch (error) {
        if (!isFileAccessDeniedError(error)) {
          throw error;
        }
        warnFileAccessDegraded(
          'SubagentRun',
          'setup',
          getSubagentTranscriptDir(
            artifactContext,
            context.config.getSessionId(),
          ),
          error,
          `agentId=${agentId}`,
          `taskId=${taskId}`,
        );
        await transcriptWriter?.close();
        transcriptWriter = undefined;
        markTranscriptUnavailable();
      }

      await runStartupStage('task_record', () =>
        updateAgentTaskRecord(
          artifactContext,
          context.config.getSessionId(),
          taskId,
          {
            transcriptPath,
            worktreePath: worktreeInfo?.path,
          },
        ),
      );
    }

    const isTeammate =
      taskType === IN_PROCESS_TEAMMATE_TASK_TYPE && Boolean(teamName);
    const teammateName = invocationName?.trim() || definition.name;
    const effectiveAdditionalTools = isTeammate
      ? [
          ...(additionalTools ?? []),
          ...createAgentTeamTools({
            config: context.config,
            teamName,
            senderName: teammateName,
          }),
        ]
      : additionalTools;

    registries = await runStartupStage('registries', () =>
      buildSubagentRegistries(definition, context, promptId, {
        agentId,
        parentToolUseId,
        additionalTools: effectiveAdditionalTools,
        toolConstraints,
        isBackground: runInBackground,
        isTeammate,
        subscribeMcpProgress,
        internalExecutionOwner,
        onCompletedToolCall: (toolCall) => {
          const display = getCompletedToolDisplay(toolCall, {
            targetDir: context.config.getTargetDir(),
          });
          tracker.updateToolDisplay({
            toolUseId: toolCall.request.callId,
            status: mapCompletedToolCallStatus(toolCall.status),
            displayName: display.displayName,
            description: display.description,
          });
        },
      }),
    );

    if (emitSdkTaskStarted && parentToolUseId) {
      // Snapshot the effective tool list AFTER tools/disallowedTools/MCP
      // discovery have been applied. SDK consumers rely on this for
      // deterministic verification of AgentDefinition.tools / disallowedTools.
      const effectiveTools = registries.toolRegistry.getAllToolNames();
      enqueueSubagentSdkEvent(
        rootSessionId,
        createTaskStartedEvent({
          sessionId: rootSessionId,
          taskId,
          toolUseId: parentToolUseId,
          description,
          taskType,
          subagentType: definition.name,
          prompt: typeof queryText === 'string' ? queryText : undefined,
          tools: effectiveTools,
        }),
      );
    }

    if (isForkPath) {
      const childAgentTool = registries.toolRegistry.getTool(
        AGENT_TOOL_NAME,
      ) as { setQuerySource?: (source: string) => void } | undefined;
      childAgentTool?.setQuerySource?.(FORK_QUERY_SOURCE);
    }

    if (isTeammate) {
      const childAgentTool = registries.toolRegistry.getTool(
        AGENT_TOOL_NAME,
      ) as { setTeammateContext?: () => void } | undefined;
      childAgentTool?.setTeammateContext?.();
    }

    const model =
      resolvedModel ??
      (await resolveAgentModel(
        context,
        definition,
        modelOverride,
        parentModel,
      ));
    const parentSelection =
      parentSnapshot?.model === model
        ? parentSnapshot.modelResolution
        : undefined;
    const agentExecutionContext = {
      agentId,
      agentType: definition.name,
      agentName: invocationName?.trim() || definition.name,
      teamName,
    };
    const startupRegistries = registries;
    const baseSystemPrompt = await runStartupStage('system_prompt', () =>
      buildSubagentSystemPrompt(
        definition,
        startupRegistries.toolRegistry,
        context,
        model,
      ),
    );
    const systemPrompt = isTeammate
      ? appendSystemPromptText(
          baseSystemPrompt,
          TEAMMATE_SYSTEM_PROMPT_ADDENDUM,
          '\n',
        )
      : baseSystemPrompt;

    const subagentRequest = isForkPath
      ? undefined
      : await runStartupStage('request', () =>
          buildSubagentRequest({
            definition,
            context,
            skillContext: startupRegistries.schedulerContext,
            agentArgs,
            worktreeInfo,
            cwdOverride,
          }),
        );
    if (isTeammate && includeTeammateContext && subagentRequest) {
      subagentRequest.prompt = [
        ...(typeof subagentRequest.prompt === 'string'
          ? [{ type: 'text' as const, text: subagentRequest.prompt }]
          : subagentRequest.prompt),
        {
          type: 'text',
          text: buildTeammateContextReminder({
            teammateName,
            teamName: teamName!,
            context,
          }),
        },
      ];
    }

    const hookSystem = context.config.getHookSystem();
    const hookCustomContext = snapshotCustomContext(customContext);
    const startHookOutput = hookSystem
      ? await runStartupStage('start_hook', () => {
          const fireStartHook = () =>
            hookSystem.fireSubagentStartEvent(
              agentId,
              definition.name,
              undefined,
              model,
            );
          return hookCustomContext
            ? customContextContext.run(hookCustomContext, fireStartHook)
            : fireStartHook();
        })
      : undefined;

    // Every tool-enabled local agent needs an independent attachment channel.
    // This includes fork-backed Agent invocations and /subtask: they execute
    // through a child schema registry and therefore can produce hook
    // feedback that must reach their own next model request.
    const attachmentCtx = createAttachmentContext(
      effectiveWorkingDirectory,
      agentId,
      { isMainAgent: false, config: context.config },
    );

    const startHookContext = startHookOutput?.getAdditionalContext();
    if (startHookContext && attachmentCtx) {
      attachmentCtx.pendingHookOutputs.push({
        hookEventName: HookEventName.SubagentStart,
        output: truncateHookOutput(startHookContext),
        sourceType: 'additionalContext',
      });
    }
    // SubagentStart "cannot block" per docs — only consume additionalContext above.

    // Create a hook coordinator that fires SubagentStop (instead of Stop)
    // inside the query loop, enabling blocking semantics identical to the
    // main agent's Stop hook.
    const baseSubagentHookCoordinator = hookSystem
      ? new SubagentHookCoordinator(
          hookSystem,
          agentId,
          definition.name,
          () => transcriptPath,
          model,
        )
      : undefined;
    const subagentHookCoordinator = isTeammate
      ? (teammateHookCoordinator = createAgentTeamHookCoordinator(
          baseSubagentHookCoordinator,
          {
            teamName: teamName!,
            memberName: teammateName,
            businessInfo: parentBusinessInfo,
            hookSystem,
          },
        ))
      : baseSubagentHookCoordinator;

    if (definition.hooks && hookSystem) {
      registerFrontmatterHooks(hookSystem, agentId, definition.hooks, true);
    }



    const inProgressToolUseIds = new Set<string>();

    const onEvent = (event: QueryEvent) => {
      onQueryEvent?.(event);
      tracker.handleQueryEvent(event);

      if (
        event.type === 'assistant' ||
        event.type === 'user' ||
        event.type === 'system'
      ) {
        updateInProgressToolUseIds(event, inProgressToolUseIds);
        context.taskRegistry?.appendMessage(registryTaskId, event, [
          ...inProgressToolUseIds,
        ]);
      }

      if (emitSdkSideEvents && parentToolUseId) {
        if (
          !isTeammate &&
          (event.type === 'assistant' ||
            event.type === 'user' ||
            event.type === 'stream_event')
        ) {
          enqueueSubagentSdkEvent(rootSessionId, event);
        }

        if (
          updateTaskProgressState(taskProgress, event, context.toolRegistry)
        ) {
          enqueueSubagentSdkEvent(
            rootSessionId,
            createTaskProgressEvent({
              sessionId: rootSessionId,
              taskId,
              toolUseId: parentToolUseId,
              description: taskProgress.lastToolDescription ?? description,
              lastToolName: taskProgress.lastToolName,
              subagentType: definition.name,
              usage: {
                total_tokens: taskProgress.totalTokens,
                tool_uses: taskProgress.toolUses,
                duration_ms: Date.now() - taskProgress.startedAt,
              },
            }),
          );
        }
      }
    };
    const maxTimeMinutes = definition.runConfig?.maxTimeMinutes;

    const timeoutSignal =
      maxTimeMinutes != null
        ? AbortSignal.timeout(maxTimeMinutes * 60 * 1000)
        : undefined;
    const combinedSignal = timeoutSignal
      ? AbortSignal.any([signal, timeoutSignal])
      : signal;

    try {
      queryLoopStarted = finalResult === null;
      if (queryLoopStarted) {
        runLogger.log(
          `[SubagentRun] startup.ready agentId=${agentId} taskId=${taskId} sessionId=${rootSessionId} durationMs=${Date.now() - startTime}`,
        );
        failureStage = 'query_loop';
      }
      const result =
        finalResult !== null
          ? {
              textContent: finalResult,
              messages: [] as Message[],
              totalUsage: undefined,
            }
          : isForkPath
            ? await runWithCwdOverride(effectiveWorkingDirectory, () =>
                runWithAgentContext(agentExecutionContext, async () => {
                  const parentMessages =
                    context.getConversationMessages?.() ?? [];
                  const parentSystemPrompt =
                    parentSnapshot?.systemPrompt ??
                    context.getSystemPrompt?.() ??
                    systemPrompt;
                  const parentToolSchemas = parentSnapshot
                    ? parentSnapshot.toolSchemas
                    : context.getParentToolSchemas?.();
                  // 复用 parent 的模型解析结果（含 generation / contextWindow）
                  // 的前提就是本 agent 钉在 parent 模型上——这正是
                  // pinToParentModel 的定义，无需再拿 model 字符串去和
                  // getModel()/getActiveModel() 比一遍。
                  const useParentResolvedModel =
                    parentSnapshot != null &&
                    definition.pinToParentModel === true;
                  const forkModel = useParentResolvedModel
                    ? parentSnapshot.model
                    : model;
                  // A cache-safe snapshot can only be replayed verbatim to the
                  // model it was projected for. Rebuild cross-model forks from
                  // runtime history so provider-specific reasoning is removed.
                  const replaysParentSnapshot =
                    parentSnapshot?.model === forkModel;
                  const forkContextMsgs = replaysParentSnapshot
                    ? completeForkContextMessages(
                        parentSnapshot.forkContextMessages,
                      )
                    : buildForkContextMessages(
                        parentMessages,
                        context.config
                          .getMemoryContextManager?.()
                          ?.getUserContext(),
                        buildModelProjectionOptions(context.config, forkModel),
                      );
                  const forkSchemaRegistry = wrapWithParentToolSchemas(
                    parentToolSchemas,
                    context.config,
                    registries!.toolRegistry,
                  );

                  const inputQuery: unknown = agentArgs['query'];
                  const callerQuery =
                    typeof inputQuery === 'string'
                      ? inputQuery
                      : DEFAULT_QUERY_STRING;
                  let forkPrompt = buildForkDirectivePrompt(callerQuery);
                  if (worktreeInfo) {
                    const parentCwd = context.config.getProjectRoot();
                    const worktreeNotice = buildWorktreeNotice(
                      parentCwd,
                      worktreeInfo.path,
                    );
                    forkPrompt = `${forkPrompt}\n\n${worktreeNotice}`;
                  }

                  // A cache-safe prefix excludes tools completed after that request.
                  // Older/custom snapshots without a baseline must not inherit live state.
                  const inheritedReadState = parentSnapshot
                    ? parentSnapshot.fileReadState
                    : context.fileReadState;
                  if (inheritedReadState)
                    attachmentCtx.fileReadState =
                      cloneFileStateCache(inheritedReadState);
                  return runForkedAgent({
                    config: context.config,
                    parentSelection: useParentResolvedModel
                      ? parentSnapshot.modelResolution
                      : parentSelection,
                    prompt: forkPrompt,
                    sessionId: context.config.getSessionId(),
                    model:
                      !parentSnapshot &&
                      readAgentSelectionDefaults(
                        context.config,
                        { agentId, agentType: definition.name },
                        'fork',
                      )
                        ? undefined
                        : forkModel,
                    promptId,
                    systemPrompt: parentSystemPrompt,
                    forkContextMessages: forkContextMsgs,
                    contextAttachmentMessages: replaysParentSnapshot
                      ? parentSnapshot.contextAttachmentMessages
                      : parentMessages.filter(isContextAttachmentMessage),
                    forkLabel: 'agent-fork',
                    agentType: definition.name,
                    maxTurns,
                    signal: combinedSignal,
                    onEvent,
                    toolRegistry: forkSchemaRegistry,
                    toolExecutor: context.config.getToolExecutor(),
                    agentContext: registries!.schedulerContext,
                    attachmentCtx,
                    transcriptWriter,
                    transcriptAgentId: agentId,
                    parentToolUseId,
                    parentRequestSetId,
                    parentBusinessInfo,
                    customContext,
                    ...(useParentResolvedModel
                      ? {
                          generation: parentSnapshot.generation,
                          contextWindow: parentSnapshot.contextWindow,
                          maxOutputTokens: parentSnapshot.maxOutputTokens,
                          thinkingBudget: parentSnapshot.thinkingBudget,
                          reasoningEffort: parentSnapshot.reasoningEffort,
                        }
                      : {}),
                    workdirs: context.config
                      .getWorkspaceContext()
                      .getDirectories(),
                  });
                }),
              )
            : await runWithCwdOverride(effectiveWorkingDirectory, () =>
                runWithAgentContext(agentExecutionContext, () =>
                  runSubagent({
                    definition,
                    querySelection,
                    agentId,
                    prompt: subagentRequest!.prompt,
                    contextMessages: resumeState
                      ? [
                          ...resumeState.messages,
                          ...subagentRequest!.contextMessages,
                        ]
                      : subagentRequest!.contextMessages,
                    model,
                    parentSelection,
                    promptId,
                    systemPrompt,
                    context,
                    toolRegistry: registries!.toolRegistry,
                    toolExecutor: context.config.getToolExecutor(),
                    schedulerContext: registries!.schedulerContext,
                    forkContext: registries!.forkContext,
                    maxTurns,
                    signal: combinedSignal,
                    onEvent,
                    sessionId: context.config.getSessionId(),
                    parentToolUseId,
                    transcriptWriter,
                    resumeLeafUuid: resumeState?.transcriptLeafUuid,
                    parentRequestSetId,
                    parentBusinessInfo,
                    customContext,
                    attachmentCtx,
                    hookCoordinator: subagentHookCoordinator,
                  }),
                ),
              );

      context.taskRegistry?.flushMessages(registryTaskId);

      if (combinedSignal.aborted) {
        throw createUserAbortError();
      }

      terminal =
        'terminal' in result
          ? (result as { terminal?: Terminal }).terminal
          : undefined;
      if (isTeammate) {
        teammateIdleSummary = deriveTeammateIdleSummary(result.messages);
      }
      const terminalTerminateReason = mapTerminalReasonToAgentTerminateMode(
        terminal?.reason,
        signal,
        timeoutSignal,
      );
      finalResult =
        terminalTerminateReason === AgentTerminateMode.TIMEOUT
          ? 'Agent timed out.'
          : terminalTerminateReason === AgentTerminateMode.ABORTED
            ? 'Operation cancelled by user'
            : extractLastAssistantText(result.messages) ||
              'Agent execution completed.';
      terminateReason =
        terminalTerminateReason ??
        (result.totalUsage && result.messages.length > 0
          ? AgentTerminateMode.GOAL
          : AgentTerminateMode.ERROR);
      const usage = result.totalUsage;
      totalTokens = countUsageTotalTokens(usage);
      toolCalls = countToolUseBlocks(result.messages);
      if (
        finalResult === 'Agent execution completed.' &&
        result.messages.length === 0
      ) {
        terminateReason = AgentTerminateMode.ERROR;
      }
      if (
        terminal?.reason === 'error' &&
        result.messages.findLast((message) => message.type === 'assistant')
          ?.isApiErrorMessage === true
      ) {
        apiError = terminal.error?.message ?? finalResult;
      }

      runLogger.log(
        `[SubagentRun] finish agentId=${agentId} taskId=${taskId} sessionId=${context.config.getSessionId()} terminateReason=${terminateReason} transcriptPath=${transcriptPath ?? ''} worktreePath=${worktreeInfo?.path ?? ''}`,
      );
    } catch (error) {
      runLogger.error(
        `[SubagentRun] error agentId=${agentId} taskId=${taskId} sessionId=${context.config.getSessionId()} parentToolUseId=${parentToolUseId ?? ''}`,
        error,
      );
      if (
        error instanceof Error &&
        error.name === 'AbortError' &&
        timeoutSignal?.aborted &&
        !signal.aborted
      ) {
        terminateReason = AgentTerminateMode.TIMEOUT;
        finalResult = 'Agent timed out.';
      } else if (error instanceof Error && error.name === 'AbortError') {
        terminateReason = AgentTerminateMode.ABORTED;
      } else {
        throw error;
      }
    } finally {
      freezeBranchObservation();
      if (initialMetadata && branchObservation) {
        try {
          await writeSubagentMetadata(context.config, agentId, {
            ...initialMetadata,
            gitBranchObservation: branchObservation,
          });
        } catch {
          runLogger.warn(
            `[SubagentRun] could not persist branch observation agentId=${agentId}`,
          );
        }
      }
      failureStage = 'cleanup';
      // AbortSignal.timeout() is self-cleaning; no manual clearTimeout needed.
      teammateHookCoordinator?.dispose();

      // SubagentStop hook is now fired inside the query loop by
      // SubagentHookCoordinator (via hookCoordinator.fireAfter), which
      // enables proper blocking semantics (loop re-entry on block).
      // Only frontmatter cleanup is needed here.
      if (hookSystem) {
        clearFrontmatterHooks(hookSystem, agentId);
      }

      registries?.toolRegistry.dispose();

      if (worktreeInfo && worktreeCreateResult) {
        try {
          const hasChanges = await hasWorktreeChanges(
            worktreeInfo.path,
            worktreeInfo.baseSha,
          );
          if (!hasChanges) {
            const hookSystem = context.config.getHookSystem();
            // Try hook-based removal first, fall back to git
            const hookRemoveAdapter = hookSystem
              ? {
                  hasWorktreeRemoveHook: () =>
                    hasWorktreeRemoveHook({
                      getRegistry: () => hookSystem.getRegistry(),
                    }),
                  executeWorktreeRemoveHook: (wtPath: string) =>
                    executeWorktreeRemoveHook(hookSystem, wtPath),
                }
              : undefined;

            if (hookRemoveAdapter?.hasWorktreeRemoveHook()) {
              const { path: worktreePath, baseSha } = worktreeInfo;
              const gitRoot = worktreeCreateResult.gitRoot;
              const removed = await withWorktreeReservation(
                worktreeInfo.path,
                async (reservation) => {
                  const ownership = await inspectWorktreeOwnership(
                    worktreePath,
                    rootSessionId,
                    true,
                    gitRoot,
                  );
                  if (ownership !== 'not-owned') return false;
                  if (await hasWorktreeChanges(worktreePath, baseSha)) {
                    return false;
                  }
                  reservation.assertHeld();
                  return hookRemoveAdapter.executeWorktreeRemoveHook(
                    worktreePath,
                  );
                },
              );
              if (removed) {
                worktreeInfo = undefined;
              } else {
                // owner 不可验证或 Hook 未删除时，保留路径供调用方继续处理。
                runLogger.warn(
                  `Agent worktree cleanup was refused or its remove hook did not complete; preserving ${worktreeInfo.path}.`,
                );
              }
            } else {
              const removed = await removeAgentWorktree(
                worktreeCreateResult.worktreePath,
                worktreeCreateResult.worktreeBranch,
                worktreeCreateResult.gitRoot,
                { baseSha: worktreeInfo.baseSha },
              );
              if (removed) {
                worktreeInfo = undefined;
              } else {
                // Match the hook path: if removal failed, keep the resource in
                // the Agent result/task record so a caller can recover it.
                runLogger.warn(
                  `Failed to remove agent worktree ${worktreeInfo.path}; preserving it.`,
                );
              }
            }
          }
        } catch {
          // Keep best-effort cleanup semantics.
        }
      }

      await transcriptWriter?.close();
    }

    failureStage = 'delivery';
    if (terminateReason === AgentTerminateMode.ABORTED) {
      updateOutput?.(tracker.makeProgress('cancelled'));
      emitTaskNotification('stopped');
      throw createUserAbortError();
    }

    const terminationDetails: AgentTerminationDetails | undefined =
      terminateReason === AgentTerminateMode.MAX_TURNS
        ? { maxTurns }
        : undefined;
    const terminationNotice = terminationDetails?.maxTurns
      ? formatMaxTurnsReachedNotice(terminationDetails.maxTurns)
      : undefined;
    // A turn-limited partial result is still a normal tool delivery. Hard
    // failures preserve their content but enter the tool failure lifecycle.
    const isFailure =
      terminateReason === AgentTerminateMode.ERROR ||
      terminateReason === AgentTerminateMode.TIMEOUT ||
      terminateReason === AgentTerminateMode.ERROR_NO_COMPLETE_TASK_CALL;
    const progress = tracker.makeProgress(isFailure ? 'error' : 'completed', {
      result: finalResult ?? undefined,
      terminateReason,
      terminationDetails,
    });
    if (progress) {
      updateOutput?.(progress);
    }

    const resultContent = finalResult ?? 'No result.';
    let modelResultContent = resultContent;
    if (terminationNotice) {
      modelResultContent = `${terminationNotice}\n\nPartial result:\n${resultContent}`;
    } else if (isFailure) {
      const failureMessage = terminal?.error?.message;
      const parts = [`Agent did not complete its task (${terminateReason}).`];
      if (failureMessage && !resultContent.includes(failureMessage)) {
        parts.push(`Error: ${failureMessage}`);
      }
      if (resultContent) {
        parts.push(resultContent);
      }
      modelResultContent = parts.join('\n\n');
    }

    appendOutput?.(`Result: ${finalResult ?? 'No result.'}\n`);
    if (sessionPersistence) {
      const recordUpdate = {
        status:
          terminateReason === AgentTerminateMode.GOAL
            ? ('completed' as const)
            : ('failed' as const),
        summary: terminationNotice
          ? `Agent "${invocationSummary}" ${terminationNotice}`
          : `Agent "${invocationSummary}" finished`,
        result: finalResult ?? 'No result.',
        transcriptPath,
        outputPath,
        worktreePath: worktreeInfo?.path,
      };
      if (
        preserveTaskOnTeammateIdle &&
        terminateReason === AgentTerminateMode.GOAL
      ) {
        await updateAgentTaskRecord(
          artifactContext,
          context.config.getSessionId(),
          taskId,
          { ...recordUpdate, status: 'running' },
        );
      } else {
        await completeAgentTaskRecord(
          artifactContext,
          context.config.getSessionId(),
          taskId,
          recordUpdate,
        );
      }
    }
    if (isTeammate && teamName) {
      await updateAgentTeamMemberStatus({
        teamName,
        memberName: teammateName,
        status: 'idle',
      });
    }
    await flushTaskOutput(taskId);

    emitTaskNotification(
      terminateReason === AgentTerminateMode.GOAL ? 'completed' : 'failed',
    );

    return {
      taskId,
      agentId,
      finalResult: finalResult ?? 'No result.',
      terminateReason,
      terminationDetails,
      ...(apiError ? { apiError } : {}),
      outputPath,
      transcriptPath,
      worktreePath: worktreeInfo?.path,
      worktreeBranch,
      totalTokens,
      toolCalls,
      durationMs: Date.now() - startTime,
      ...(teammateIdleSummary ? { teammateIdleSummary } : {}),
      toolResult: {
        llmContent: [{ text: modelResultContent }],
        ...(isFailure ? { isError: true } : {}),
        returnDisplay: progress ?? resultContent,
        toolUseResult: buildAgentToolCompletionResult({
          agentId,
          agentType: definition.name,
          content: modelResultContent,
          state:
            terminateReason === AgentTerminateMode.GOAL ? 'completed' : 'error',
          ...(apiError ? { apiError } : {}),
          terminateReason,
          terminationDetails,
          outputPath,
          transcriptPath,
          worktreePath: worktreeInfo?.path,
          worktreeBranch,
        }),
        data: {
          taskId,
          agentId,
          outputPath,
          transcriptPath,
          worktreePath: worktreeInfo?.path,
          worktreeBranch,
        },
      },
    };
  } catch (error) {
    freezeBranchObservation();
    if (failureStage === 'worktree_setup') {
      runLogger.warn(
        `[SubagentRun] startup.failed agentId=${agentId} taskId=${taskId} sessionId=${rootSessionId} stage=worktree durationMs=${Date.now() - (worktreeStartedAt ?? startTime)}`,
      );
    }
    appendOutput?.(
      `Error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    if (sessionPersistence) {
      await completeAgentTaskRecord(
        artifactContext,
        context.config.getSessionId(),
        taskId,
        {
          status:
            error instanceof Error && error.name === 'AbortError'
              ? 'cancelled'
              : 'failed',
          summary:
            error instanceof Error && error.name === 'AbortError'
              ? `Agent "${invocationSummary}" cancelled`
              : `Agent "${invocationSummary}" failed`,
          result: error instanceof Error ? error.message : String(error),
          transcriptPath,
          outputPath,
          worktreePath: worktreeInfo?.path,
        },
      );
    }
    if (taskType === IN_PROCESS_TEAMMATE_TASK_TYPE && teamName) {
      await updateAgentTeamMemberStatus({
        teamName,
        memberName: invocationName?.trim() || definition.name,
        status: 'stopped',
      });
    }
    await flushTaskOutput(taskId);
    emitTaskNotification(
      error instanceof Error && error.name === 'AbortError'
        ? 'stopped'
        : 'failed',
    );
    throw error;
  }
}

export async function resolveAgentWorktreeProjectRoot(
  configuredProjectRoot: string,
  usesCreateHook: boolean,
): Promise<string> {
  if (usesCreateHook) {
    return configuredProjectRoot;
  }
  try {
    return (
      (await findProjectRootForWorktree(configuredProjectRoot)) ??
      configuredProjectRoot
    );
  } catch {
    return configuredProjectRoot;
  }
}
