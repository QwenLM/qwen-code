/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Unified Agent tool — single entry point for all subagent execution.
 *
 * Single Agent tool pattern:
 *   - Registers as a single "Agent" tool in the ToolRegistry
 *   - Dispatches to specific agent types via the `subagent_type` parameter
 *   - Agent type descriptions are embedded in the tool's description
 *
 * Merges the logic previously split across SubagentTool, SubagentToolWrapper,
 * and LocalSubagentInvocation into a single class.
 */

import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import {
  getBusinessInfoFromContext,
  snapshotCustomContext,
} from '../utils/sessionIdContext.js';
import {
  BaseDeclarativeTool,
  Kind,
  type ToolInvocation,
  type ToolResult,
  BaseToolInvocation,
  type ToolLiveOutput,
} from '../tools/tools.js';
import { type AgentLoopContext } from '../config/agent-loop-context.js';
import {
  PERMISSION_MODES,
  rulesForToolName,
  type PermissionMode,
} from '../permissions/manager/decision/index.js';
import {
  ENV_ENABLE_AGENT_SESSIONS,
  ENV_MAX_CONCURRENT_SUBAGENTS,
  ENV_MAX_SUBAGENT_SPAWN_DEPTH,
} from '../config/brand.js';
import { firstRule } from '../tools/tool-checkers/rule-precedence.js';
import { isAgentSessionsEnabled } from './agent-session-feature.js';
import type {
  AgentDefinition,
  AgentColor,
  AgentInputs,
  AgentTerminationDetails,
  LocalAgentDefinition,
  SubagentProgress,
} from './types.js';
import { AgentTerminateMode, formatMaxTurnsReachedNotice } from './types.js';


import { createAgentId } from '../utils/agentId.js';
import { sanitizeErrorMessage } from '../utils/agent-sanitization-utils.js';
import {
  resolveAgentModel,
  runAgent,
  toAgentResumeState,
  type AgentResumeState,
} from './run-agent.js';
import { ProgressTracker } from './progressTracker.js';
import { GENERAL_PURPOSE_AGENT_NAME } from './builtin/general-purpose-agent.js';
import type { AgentRegistry } from './registry/agentRegistry.js';
import type {
  AgentListingEntry,
  AgentPolicyView,
} from './agent-policy-view.js';
import {
  AGENT_TOOL_NAME,
  collectAgentNamesFromToolSpecs,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SHELL_TOOL_NAME,
} from '../tools/tool-names.js';
import {
  isForkSubagentEnabled,
  isInForkChild,
  FORK_AGENT,
  FORK_SUBAGENT_TYPE,
  FORK_QUERY_SOURCE,
  deriveForkName,
  truncateDirectiveLabel,
} from './fork-subagent.js';
import { getToolCallContext } from '../utils/toolCallContext.js';
import { ExecutionLifecycleService } from '../services/executionLifecycleService.js';
import { buildTaskNotificationXml } from '../services/taskNotification.js';
import { enqueuePendingNotification } from '../services/messageQueueManager.js';
import {
  deleteAgentTaskRecord,
  registerAgentTask,
} from './agent-task-runtime.js';
import {
  flushTaskOutput,
  initTaskOutputAsSymlink,
} from '../utils/task/diskOutput.js';
import {
  getSubagentTranscriptPath,
  getSubagentArtifactContext,
  readSubagentTranscript,
} from '../services/subagent-transcript.js';
import type { ToolUseContext } from '../tools/tool-types.js';
import type { BusinessInfo } from '../qoder/business-info.js';
import {
  buildAgentToolBackgroundLaunchResult,
  buildAgentToolCompletionResult,
  buildAgentToolTeammateSpawnedResult,
} from './agent-tool-result.js';
import {
  enqueueBackgroundTasksChangedFromRegistry,
  createTaskStartedEvent,
  createTaskUpdatedEvent,
  enqueueSubagentSdkEvent,
} from './subagent-sdk-events.js';
import type { AgentUnifiedTask } from '../tasks/unified-task.js';
import {
  canSpawnSubagentAtDepth,
  getMaxConcurrentSubagents,
  getMaxSubagentSpawnDepth,
} from './subagent-limits.js';
import {
  IN_PROCESS_TEAMMATE_TASK_TYPE,
  isInProcessTeammateFeatureEnabled,
} from './teams/agent-teams-feature.js';
import {
  AgentTeamReservationError,
  readTeamInbox,
  removeAgentTeamMember,
  reserveAgentTeamMember,
  TEAM_LEAD_MEMBER_NAME,
  updateAgentTeamMemberStatus,
} from './teams/agent-team-runtime.js';
import { formatTeammateMessage } from './teams/agent-team-peer-message.js';
import {
  buildClaimedTaskPrompt,
  claimNextAvailableTask,
  releaseClaimedTask,
} from './teams/agent-team-task-coordination.js';
import {
  registerTeammateController,
  waitForTeammateControllerSignal,
} from './teams/agent-team-controller.js';
import { formatTeamMailboxMessages } from './teams/agent-team-hook-coordinator.js';
import { resolvePromptBundleForModel } from '../prompts/bundle-resolver.js';
import type { PromptBundle } from '../prompts/types.js';
import {
  deriveTeammateIdleSummary,
  publishTeammateIdleNotification,
} from './teams/agent-team-main-delivery.js';
import { runLogger } from '../utils/runLogger.js';


// ---------------------------------------------------------------------------
// Unified Agent tool input schema
// ---------------------------------------------------------------------------

export interface AgentToolParams {
  description: string;
  prompt: string;
  subagent_type?: string;
  mode?: PermissionMode | 'plan' | 'yolo';
  cwd?: string;
  run_in_background?: boolean;
  name?: string;
  team_name?: string;
  isolation?: 'default' | 'worktree';
}

const AGENT_TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    description: {
      type: 'string' as const,
      description: 'A short (3-5 word) description of the task',
    },
    prompt: {
      type: 'string' as const,
      description: 'The task for the agent to perform',
    },
    subagent_type: {
      type: 'string' as const,
      description: 'The type of specialized agent to use for this task',
    },
    mode: {
      type: 'string' as const,
      enum: [...PERMISSION_MODES, 'plan', 'yolo'],
      description:
        'Optional permission mode override for this agent invocation. Use plan to require plan approval. bypassPermissions/yolo is honored only in a trusted workspace when policy allows it.',
    },
    cwd: {
      type: 'string' as const,
      description:
        'Optional working directory override. Mutually exclusive with worktree isolation. If provided, the agent uses this as its working directory context.',
    },
    run_in_background: {
      type: 'boolean' as const,
      description:
        'Set to true to run this agent in the background. Named teammates always run in the background.',
    },
    name: {
      type: 'string' as const,
      description:
        'Optional stable runtime name for this agent invocation. Use this when the task needs an explicit label beyond the short description.',
    },
    team_name: {
      type: 'string' as const,
      description:
        'Deprecated and ignored. Named teammates always use the current session team.',
    },
    isolation: {
      type: 'string' as const,
      enum: ['default', 'worktree'],
      description:
        'Optional isolation override for this invocation. Use worktree to force execution in an isolated git worktree; otherwise the agent follows its definition.',
    },
  },
  required: ['description', 'prompt'] as const,
};

function buildAgentToolInputSchema(teammateContext = false): unknown {
  const { cwd: _cwd, ...modelVisibleProperties } =
    AGENT_TOOL_INPUT_SCHEMA.properties;
  void _cwd;
  const teamAwareProperties = isInProcessTeammateFeatureEnabled()
    ? {
        ...modelVisibleProperties,
        name: {
          ...modelVisibleProperties.name,
          description:
            'Name for the spawned agent. Makes it addressable through SendMessage while it is part of the session team.',
        },
      }
    : modelVisibleProperties;
  const backgroundControlsUnavailable =
    teammateContext || !isAgentSessionsEnabled();
  const visibleProperties = backgroundControlsUnavailable
    ? Object.fromEntries(
        Object.entries(teamAwareProperties).filter(
          ([name]) => name !== 'name' && name !== 'run_in_background',
        ),
      )
    : teamAwareProperties;

  return {
    ...AGENT_TOOL_INPUT_SCHEMA,
    properties: visibleProperties,
  };
}

function resolveRequestedAgentType(input: AgentToolParams): string {
  return input.subagent_type ?? GENERAL_PURPOSE_AGENT_NAME;
}

/** Match Agent types the same way across exact dispatch and model variations. */
export function normalizeAgentTypeName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{White_Space}\p{Pd}_]+/gu, '');
}

/**
 * Canonical Agent-type names a requested spelling could mean. `[]` means the
 * type is unknown; more than one entry means the spelling is ambiguous.
 * Registry names are unique by construction, so no dedup is needed.
 */
function matchAgentTypeCandidates(
  requested: string,
  registry: AgentRegistry,
): string[] {
  const normalized = normalizeAgentTypeName(requested);
  // `fork` is synthetic — it never appears in the registry.
  if (normalized === normalizeAgentTypeName(FORK_SUBAGENT_TYPE)) {
    return [FORK_SUBAGENT_TYPE];
  }
  if (registry.getDefinition(requested) !== undefined) {
    return [requested];
  }
  return registry
    .getAllAgentNames()
    .filter((name) => normalizeAgentTypeName(name) === normalized);
}

function resolveCanonicalAgentType(
  requested: string,
  registry: AgentRegistry,
): string {
  const matches = matchAgentTypeCandidates(requested, registry);
  if (matches.length > 1) {
    throw new Error(
      `Agent type '${requested}' is ambiguous. Use one of: ${matches.join(', ')}`,
    );
  }
  // Fall back to the caller's spelling so the unknown-type error names it.
  return matches[0] ?? requested;
}

// ---------------------------------------------------------------------------
// AgentTool — the single unified tool registered in ToolRegistry
// ---------------------------------------------------------------------------

/**
 * Builds the stable Agent tool contract. Available agent types are announced
 * separately through `agent_listing_delta` system reminders so registry and
 * policy changes do not invalidate the earlier tool-schema cache prefix.
 */
function buildAgentToolDescription(
  agentRegistry: AgentRegistry,
  excludedTypes?: ReadonlySet<string>,
  teammateContext = false,
  toolRegistry?: AgentLoopContext['toolRegistry'],
  bundle: PromptBundle = 'full',
): string {
  const agentSessionsEnabled = isAgentSessionsEnabled();
  const allDefinitions = agentRegistry.getAllDefinitions();
  const hasFreshAgent = excludedTypes
    ? allDefinitions.some((definition) => !excludedTypes.has(definition.name))
    : allDefinitions.length > 0;
  const forkAvailable =
    isForkSubagentEnabled() && !excludedTypes?.has(FORK_SUBAGENT_TYPE);

  const baseDescription = `Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.

Available agent types are listed in <system-reminder> messages in the conversation.`;

  if (!hasFreshAgent && !forkAvailable) {
    return baseDescription;
  }

  const selectionGuidance = forkAvailable
    ? `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type to select an agent: \`"${FORK_SUBAGENT_TYPE}"\` forks yourself (the fork inherits your full conversation context and always runs on your model); any other type — or omitting it — starts a fresh agent (general-purpose by default).`
    : `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.`;

  const whenToUseSection = `## When to use

Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.`;

  if (bundle === 'lean') {
    const hasTool = (name: string) =>
      toolRegistry?.hasToolEnabled(name) ?? false;
    const usageNotes = [
      teammateContext
        ? "- The agent's final message is returned to you as the tool result; it is not shown to the user — relay what matters."
        : "- The agent's final report is not shown to the user — relay what matters.",
      ...(hasTool(SEND_MESSAGE_TOOL_NAME)
        ? [
            `- Use ${SEND_MESSAGE_TOOL_NAME} with the agent's ID or name to continue a previously spawned agent with its context intact; a new ${AGENT_TOOL_NAME} call starts fresh${forkAvailable ? ` (except subagent_type: "${FORK_SUBAGENT_TYPE}", which inherits your context)` : ''}.`,
          ]
        : []),
      "- Each agent type's model, reasoning effort, and tools come from its definition.",
      '- `isolation: "worktree"` gives the agent its own git worktree (auto-cleaned if unchanged).',
      ...(teammateContext || !agentSessionsEnabled
        ? [
            !agentSessionsEnabled
              ? `- Agent sessions are disabled by ${ENV_ENABLE_AGENT_SESSIONS}=0; only synchronous subagents can be launched.`
              : '- `run_in_background` and `name` are unavailable here — only synchronous subagents.',
          ]
        : [
            "- Background agents notify you when they complete. Never fabricate or predict a pending agent's results; if the user asks before it finishes, say it is still running.",
          ]),
    ];

    const forkNote = forkAvailable
      ? !agentSessionsEnabled
        ? `A fork runs synchronously while agent sessions are disabled. If you are the fork, execute directly — don't re-delegate.`
        : `A fork runs in the background and keeps its tool output out of your context. If you are the fork, execute directly — don't re-delegate.`
      : '';

    return [
      baseDescription,
      selectionGuidance,
      whenToUseSection,
      forkNote,
      usageNotes.join('\n'),
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  const hasTool = (name: string) => toolRegistry?.hasToolEnabled(name) ?? false;
  const directToolGuidance: string[] = [];
  if (hasTool(READ_FILE_TOOL_NAME)) {
    directToolGuidance.push(`${READ_FILE_TOOL_NAME} for a known path`);
  }
  if (hasTool(GREP_TOOL_NAME)) {
    directToolGuidance.push(
      `${GREP_TOOL_NAME} for a specific symbol or string`,
    );
  } else if (hasTool(SHELL_TOOL_NAME)) {
    directToolGuidance.push(`${SHELL_TOOL_NAME} for a direct text search`);
  }
  const whenNotToUseSection =
    forkAvailable || directToolGuidance.length === 0
      ? ''
      : `## When not to use

If the target is already known, use the direct tool: ${directToolGuidance.join(', ')}. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.`;

  const backgroundForkGuidance = !agentSessionsEnabled
    ? ''
    : `**Don't peek.** When running a fork in the background, the tool result includes an output_file path — do not Read or tail it unless the user explicitly asks for a progress check. Wait for the completion notification.

**Don't race.** After launching a background fork, you know nothing about what it found. Never fabricate or predict its results. If the user asks before the notification arrives, say that the fork is still running.`;

  const whenToForkSection = forkAvailable
    ? `## When to fork

When you need to delegate work that benefits from full conversation context (e.g., continuing a multi-file refactor where the child needs the same system prompt and history), use \`subagent_type: "${FORK_SUBAGENT_TYPE}"\`. For most tasks that do not need inherited context, prefer a fresh specialized agent.

${backgroundForkGuidance}

**Writing a fork prompt.** Since the fork inherits your context, the prompt is a directive — what to do, not what the situation is. Be specific about scope. Don't restate inherited context.`
    : '';

  const writingThePromptSection = `## Writing the prompt

${forkAvailable ? 'Any agent other than a fork starts with zero conversation context. ' : ''}Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why, what you've already learned or ruled out, and enough context for the agent to make judgment calls.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

${forkAvailable ? 'For fresh agents, terse' : 'Terse'} command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Write prompts that prove you understood: include file paths, line numbers, and what specifically to change.

The initial prompt defines the delegated task scope. If the user's request explicitly requires changing permission settings, AGENTS.md, or configuration, state that exact change in the initial prompt; later agent messages cannot convey approval for new sensitive changes.`;

  // Order is meaningful: the background/lifecycle notes stay grouped together,
  // ahead of the per-call configuration and prompting notes.
  const usageNotes = [
    '- Always include a short description summarizing what the agent will do.',
    '- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, send a text message back to the user with a concise summary of the result.',
    "- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting the work as done.",
    ...(teammateContext || !agentSessionsEnabled
      ? []
      : [
          '- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.',
          "- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed — e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel.",
          "- **Don't race**: after launching a background agent, you know nothing about its results. Never fabricate or predict them in any format. If the user asks before the completion notification arrives, say the agent is still running — give status, not a guess.",
        ]),
    ...(hasTool(SEND_MESSAGE_TOOL_NAME)
      ? [
          `- To continue a previously spawned agent, use ${SEND_MESSAGE_TOOL_NAME} with the agent's ID or name; that resumes it with full context. A new ${AGENT_TOOL_NAME} call starts a fresh agent with no memory of prior runs${forkAvailable ? ` (except subagent_type: "${FORK_SUBAGENT_TYPE}", which inherits your context)` : ''}, so the prompt must be self-contained.`,
        ]
      : []),
    "- Each agent type's model, reasoning effort, and tool access are set in its definition.",
    `- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.)${forkAvailable ? '.' : ", since it is not aware of the user's intent."}`,
    '- If the agent description mentions that it should be used proactively, then try your best to use it without the user having to ask for it first. Use your judgment.',
    '- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Agent tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.',
    '- You can optionally set `isolation: "worktree"` to run the agent in a temporary git worktree, giving it an isolated copy of the repository. The worktree is automatically cleaned up if the agent makes no changes; if changes are made, the worktree path and branch are returned in the result.',
  ];

  if (
    isInProcessTeammateFeatureEnabled() &&
    !teammateContext &&
    agentSessionsEnabled
  ) {
    usageNotes.push(
      '- To create a teammate, provide a stable `name`. Named teammates run in the background and can be reached with SendMessage.',
      '- A session has one implicit team. Do not create or pass a separate team name.',
      '- Teammates form a flat roster. A teammate may launch a synchronous subagent, but it cannot create another named teammate or a background subagent.',
    );
  }
  if (teammateContext) {
    usageNotes.push(
      '- The `name` and `run_in_background` parameters are unavailable in this context. Only synchronous subagents can be launched.',
    );
  } else if (!agentSessionsEnabled) {
    usageNotes.push(
      `- Agent sessions are disabled by ${ENV_ENABLE_AGENT_SESSIONS}=0; all agents run synchronously and \`name\` / \`run_in_background\` are unavailable.`,
    );
  }

  // Sections carry no surrounding blank lines of their own; the join owns all
  // separation so an omitted section cannot leave a double blank line behind.
  return [
    baseDescription,
    selectionGuidance,
    whenToUseSection,
    whenNotToUseSection,
    `Usage notes:\n${usageNotes.join('\n')}`,
    whenToForkSection,
    writingThePromptSection,
  ]
    .filter(Boolean)
    .join('\n\n');
}

interface LocalAgentRunOutcome {
  taskId: string;
  agentId: string;
  finalResult: string;
  terminateReason: AgentTerminateMode;
  terminationDetails?: AgentTerminationDetails;
  outputPath?: string;
  transcriptPath?: string;
  worktreePath?: string;
  totalTokens?: number;
  toolCalls?: number;
  durationMs?: number;
  teammateIdleSummary?: string;
  toolResult: ToolResult;
}

/**
 * AgentTool definition
 */
export class AgentTool
  extends BaseDeclarativeTool<AgentToolParams, ToolResult>
  implements AgentPolicyView
{
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  /** Agent types disabled via disallowedTools configuration. */
  private _disabledAgentTypes = new Set<string>();
  /**
   * When set, only these agent types may be invoked. Populated from
   * `Agent(name1, name2)` expressions in a parent's `toolConfig`.
   * Undefined means no restriction (all registered types are allowed).
   */
  private _allowedAgentTypes?: ReadonlySet<string>;
  /**
   * Query source tag for anti-recursion guard.
   * When set to FORK_QUERY_SOURCE, this Agent tool instance is inside a
   * fork child and must not allow fork invocations. This metadata survives
   * auto-compact unlike the message-scan fallback.
   * Set via `setQuerySource()` after cloning into a fork child's registry.
   */
  private _querySource?: string;
  private _teammateContext = false;
  /** undefined 表示待重新渲染（构造时、clone 后、以及每次策略变更后）。 */
  private _renderedDescription?: string;

  constructor(
    private readonly agentRegistry: AgentRegistry,
    private context: AgentLoopContext,
  ) {
    super(
      AGENT_TOOL_NAME,
      AGENT_TOOL_NAME,
      // Replaced below by a lazily-rendered accessor.
      '',
      Kind.Agent,
      buildAgentToolInputSchema(),
      /* isOutputMarkdown */ true,
      /* canUpdateOutput */ true,
    );
    this.installDescriptionAccessor();
  }

  /**
   * Renders `description` on first read after a policy change.
   *
   * Policy setters can fire repeatedly during registry assembly
   * (`applyDisallowedTools`) and child setup. Rendering is deferred until tool
   * declarations are serialized, after those setters have completed.
   *
   * The registry is read through `this.context` at render time rather than
   * snapshotted: the main-session tool is constructed inside
   * `Config.createToolRegistry()`, before `Config.toolRegistry` is assigned.
   */
  private installDescriptionAccessor(): void {
    // Non-enumerable so `clone()` does not copy a frozen string over the
    // accessor; the override below reinstalls it on the clone.
    Object.defineProperty(this, 'description', {
      get: (): string =>
        (this._renderedDescription ??= buildAgentToolDescription(
          this.agentRegistry,
          this.getUnavailableAgentTypes(),
          this._teammateContext,
          this.context.toolRegistry,
        )),
      enumerable: false,
      configurable: true,
    });
  }

  /**
   * AgentTool has mutable registry-scoped policy state. The base shallow clone
   * would share its Sets with the parent tool and let a child deny mutate the
   * parent's routing policy.
   */
  override clone(): this {
    const cloned = super.clone();
    cloned._disabledAgentTypes = new Set(this._disabledAgentTypes);
    cloned._allowedAgentTypes = this._allowedAgentTypes
      ? new Set(this._allowedAgentTypes)
      : undefined;
    cloned.installDescriptionAccessor();
    cloned._renderedDescription = undefined;
    return cloned;
  }

  /**
   * Agent tool delegates permission checks to its underlying tools,
   * so it is considered read-only at this level.
   */
  override get isReadOnly(): boolean {
    return true;
  }

  override getSchema(modelId?: string) {
    const bundle = resolvePromptBundleForModel(modelId);
    return {
      name: this.name,
      description:
        bundle === 'full'
          ? this.description
          : buildAgentToolDescription(
              this.agentRegistry,
              this.getUnavailableAgentTypes(),
              this._teammateContext,
              this.context.toolRegistry,
              bundle,
            ),
      parametersJsonSchema: this.parameterSchema,
    };
  }

  // Content-level `Agent(<subagent_type>)` rules are settled by the
  // registered tool checker (tools/tool-checkers/checkers/agent-checker.ts), which
  // mirrors the rule precedence this override used to implement: deny > ask >
  // allow > default allow, with case-insensitive agent-type matching.
  // Tool-level rules are settled by the permission pipeline before the
  // checker runs.

  /**
   * Provide classifier-relevant input for auto mode evaluation.
   * Agent spawns can execute arbitrary tool calls, so the classifier needs
   * to see the prompt and agent type to evaluate safety.
   */
  override toClassifierInput(input: AgentToolParams): unknown {
    return {
      subagent_type: resolveRequestedAgentType(input),
      prompt: input.prompt,
      mode: input.mode,
      cwd: input.cwd,
      isolation: input.isolation,
      run_in_background: input.run_in_background,
    };
  }

  /**
   * Agent tool is concurrency-safe: multiple subagents can run in parallel.
   * Each subagent has its own execution context and enforces its own
   * tool-level concurrency constraints internally.
   */
  override isConcurrencySafe(_input?: AgentToolParams): boolean {
    return true;
  }

  /**
   * Disables a specific agent type from being invoked.
   * Used by disallowedTools handling for `Agent(name)` expressions.
   */
  disableAgentType(name: string): void {
    this._disabledAgentTypes.add(name);
    this.refreshDescription();
  }

  /**
   * Clears all disabled agent types (used during hot-reload before re-applying).
   */
  clearDisabledAgentTypes(): void {
    this._disabledAgentTypes.clear();
    this.refreshDescription();
  }

  /**
   * Returns the set of disabled agent types (for testing/introspection).
   */
  get disabledAgentTypes(): ReadonlySet<string> {
    return this._disabledAgentTypes;
  }

  /**
   * Returns the model-visible fresh Agent types after this concrete tool
   * instance's allow/deny policy and built-in capability preflight are applied.
   * The attachment layer uses this as the single source for agent listings.
   */
  getAvailableAgentListing(modelId?: string): AgentListingEntry[] {
    const unavailableTypes = this.getUnavailableAgentTypes();
    const bundle = resolvePromptBundleForModel(
      modelId ?? this.context.config.getActiveModel(),
    );
    return this.agentRegistry
      .getAllDefinitions()
      .filter((definition) => !unavailableTypes.has(definition.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, description, descriptionLean }) => ({
        name,
        description:
          bundle === 'lean' && descriptionLean ? descriptionLean : description,
      }));
  }

  /** Resolves model-provided spelling to the canonical registered Agent type. */
  resolveAgentTypeName(name: string): string {
    return resolveCanonicalAgentType(name, this.agentRegistry);
  }

  /** Returns whether a concrete type can be dispatched in the current context. */
  isAgentTypeAvailable(name: string): boolean {
    const [resolvedName, ...ambiguous] = matchAgentTypeCandidates(
      name,
      this.agentRegistry,
    );
    if (!resolvedName || ambiguous.length > 0) return false;
    if (resolvedName === FORK_SUBAGENT_TYPE) {
      return (
        isForkSubagentEnabled() &&
        !this.getUnavailableAgentTypes().has(FORK_SUBAGENT_TYPE)
      );
    }
    return (
      this.agentRegistry.getDefinition(resolvedName) !== undefined &&
      !this.getUnavailableAgentTypes().has(resolvedName)
    );
  }

  /**
   * Sets the query source tag for anti-recursion detection.
   * Call with FORK_QUERY_SOURCE after cloning into a fork child's registry
   * to prevent the fork child from spawning further forks.
   */
  setQuerySource(source: string): void {
    this._querySource = source;
  }

  /**
   * Restricts which agent types this tool instance may dispatch to.
   * Used when a parent's `toolConfig` contains explicit `Agent(name)` expressions
   * (e.g. PlanAgent's `Agent(explore)`). Types not in the set are rejected.
   */
  setAllowedAgentTypes(types: ReadonlySet<string>): void {
    this._allowedAgentTypes = types;
    this.refreshDescription();
  }

  setTeammateContext(): void {
    this._teammateContext = true;
    Object.defineProperty(this, 'parameterSchema', {
      value: buildAgentToolInputSchema(true),
      writable: false,
      configurable: true,
    });
    this.refreshDescription();
  }

  /**
   * Binds a cloned AgentTool to the concrete child execution context, so the
   * dispatched agents and the model-visible direct-tool guidance both reflect
   * the child's registry rather than the caller's.
   */
  bindAgentLoopContext(context: AgentLoopContext): void {
    this.context = context;
    this.refreshDescription();
  }

  /**
   * Recomputes routing exclusions and invalidates policy-dependent guidance
   * after agent definitions or routing policy change.
   */
  refreshDescription(): void {
    this._renderedDescription = undefined;
  }

  /**
   * Builds the union of all agent types that should be excluded from dispatch
   * and the separate agent-listing reminder: disabled types + excludeTools
   * Agent(name) entries + types not in the allowlist (when set).
   */
  private _buildExcludedTypesSet(): ReadonlySet<string> {
    const excluded = new Set(this._disabledAgentTypes);

    const excludeTools = this.context.config.getExcludeTools();
    if (excludeTools) {
      for (const name of collectAgentNamesFromToolSpecs(excludeTools)) {
        excluded.add(name);
      }
    }

    if (this._allowedAgentTypes) {
      if (!this._allowedAgentTypes.has(FORK_SUBAGENT_TYPE)) {
        excluded.add(FORK_SUBAGENT_TYPE);
      }
      for (const def of this.agentRegistry.getAllDefinitions()) {
        if (!this._allowedAgentTypes.has(def.name)) {
          excluded.add(def.name);
        }
      }
    }

    return excluded;
  }

  /**
   * Resolves exclusions against the live bound permission module. Permission
   * rules can change after the tool is constructed, so this result must not be
   * cached in the AgentTool instance.
   */
  private getUnavailableAgentTypes(): ReadonlySet<string> {
    const unavailable = new Set(this._buildExcludedTypesSet());
    const permission = this.context.permission;

    if (permission) {
      // Same semantics as the former getDeniedAgentTypes: a tool-wide deny
      // (no content) blocks every agent type; a content deny blocks exactly
      // the named type.
      const rulesForAgent = rulesForToolName(permission.getRules(), this.name);
      const deniesAllTypes =
        firstRule(rulesForAgent.toolLevel.deny) !== undefined;
      const deniedContents = new Set<string>();
      for (const rules of Object.values(rulesForAgent.toolDetailLevel.deny)) {
        for (const rule of rules ?? []) {
          const content = rule.ruleValue.ruleContent;
          if (content) {
            deniedContents.add(content);
          }
        }
      }
      if (deniesAllTypes || deniedContents.size > 0) {
        for (const { name } of this.agentRegistry.getAllDefinitions()) {
          if (deniesAllTypes || deniedContents.has(name)) {
            unavailable.add(name);
          }
        }
        if (deniesAllTypes || deniedContents.has(FORK_SUBAGENT_TYPE)) {
          unavailable.add(FORK_SUBAGENT_TYPE);
        }
      }
    }

    for (const definition of this.agentRegistry.getAllDefinitions()) {
      if (this.getPreflightRefusal(definition)) {
        unavailable.add(definition.name);
      }
    }

    return unavailable;
  }

  /**
   * Why this definition cannot run against the bound child registry, or
   * undefined when it can. Definitions declare their own prerequisite via
   * `checkAvailability`, so this stays free of per-agent names.
   */
  private getPreflightRefusal(
    definition: Pick<AgentDefinition, 'checkAvailability'>,
  ): string | undefined {
    return definition.checkAvailability?.({
      toolRegistry: this.context.toolRegistry,
    });
  }

  protected createInvocation(
    params: AgentToolParams,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<AgentToolParams, ToolResult> {
    const currentDepth = this.context.agentDepth ?? 0;
    if (!canSpawnSubagentAtDepth(currentDepth)) {
      throw new Error(
        `Subagent nesting limit reached (depth ${currentDepth} of ${getMaxSubagentSpawnDepth()}). Complete this task directly using your tools instead of spawning another agent. If the user explicitly requested deeper nesting, ask them to raise ${ENV_MAX_SUBAGENT_SPAWN_DEPTH}.`,
      );
    }

    const effectiveType = this.resolveAgentTypeName(
      resolveRequestedAgentType(params),
    );
    const isForkPath =
      effectiveType === FORK_SUBAGENT_TYPE && isForkSubagentEnabled();
    const unavailableTypes = this.getUnavailableAgentTypes();

    let definition: AgentDefinition;

    if (effectiveType === FORK_SUBAGENT_TYPE && !isForkPath) {
      throw new Error(
        `Agent type '${FORK_SUBAGENT_TYPE}' is not available because fork agents are disabled.`,
      );
    }

    if (unavailableTypes.has(effectiveType)) {
      const unavailableDefinition =
        effectiveType === FORK_SUBAGENT_TYPE
          ? undefined
          : this.agentRegistry.getDefinition(effectiveType);
      const preflightRefusal =
        unavailableDefinition &&
        this.getPreflightRefusal(unavailableDefinition);
      if (preflightRefusal) {
        throw new Error(preflightRefusal);
      }
      const reason = this._disabledAgentTypes.has(effectiveType)
        ? 'disabled via disallowedTools configuration'
        : 'not allowed by current permission settings';
      throw new Error(`Agent type '${effectiveType}' is ${reason}.`);
    }

    if (isForkPath) {
      // Recursive fork prevention:
      // 1. querySource metadata check (survives auto-compact — primary guard)
      // 2. Message-scan fallback (detects fork boilerplate tag in history)
      const messages = this.context.getConversationMessages?.() ?? [];
      if (this._querySource === FORK_QUERY_SOURCE || isInForkChild(messages)) {
        throw new Error(
          'Fork is not available inside a forked worker. Execute your task directly using tools.',
        );
      }
      definition = FORK_AGENT;
    } else {
      const found = this.agentRegistry.getDefinition(effectiveType);
      if (!found) {
        const available = this.agentRegistry
          .getAllDefinitions()
          .map((d) => d.name)
          .join(', ');
        throw new Error(
          `Unknown agent type: '${effectiveType}'. Available types: ${available}`,
        );
      }
      definition = found;
    }

    return new AgentInvocation(
      params,
      definition,
      this.context,
      isForkPath,
      _toolName,
      _toolDisplayName,
      this._teammateContext,
    );
  }
}

// ---------------------------------------------------------------------------
// AgentInvocation — the single invocation class handling all paths
// ---------------------------------------------------------------------------

const INPUT_PREVIEW_MAX_LENGTH = 50;
const DESCRIPTION_MAX_LENGTH = 200;
class AgentInvocation extends BaseToolInvocation<AgentToolParams, ToolResult> {
  private readonly isForkPath: boolean;
  /** True when the Agent tool clone lives in a teammate's registry (registry-scoped, not ambient). */
  private readonly callerIsTeammate: boolean;
  /** Parent lifecycle context captured from ToolUseContext in executeWithContext(). */
  private _parentRequestSetId?: string;
  private _parentBusinessInfo?: Readonly<BusinessInfo>;
  private _customContext?: Readonly<Record<string, string>>;
  private _ownerAgentId?: string;
  private _parentModel?: string;

  private isInProcessTeammateInvocation(): boolean {
    return (
      isInProcessTeammateFeatureEnabled() &&
      !this.isForkPath &&
      this.definition.kind === 'local' &&
      typeof this.params.name === 'string' &&
      this.params.name.trim().length > 0
    );
  }

  private getRuntimeAgentName(): string {
    return this.isInProcessTeammateInvocation()
      ? this.params.name!.trim()
      : this.params.name?.trim() || this.definition.name;
  }

  constructor(
    params: AgentToolParams,
    private readonly definition: AgentDefinition,
    private context: AgentLoopContext,
    isForkPath: boolean = false,
    _toolName?: string,
    _toolDisplayName?: string,
    callerIsTeammate: boolean = false,
  ) {
    super(
      params,
      _toolName ?? AGENT_TOOL_NAME,
      _toolDisplayName ?? `Agent (${definition.name})`,
    );
    this.isForkPath = isForkPath;
    this.callerIsTeammate = callerIsTeammate;
  }

  /** Build the agent args from the unified params (prompt → query). */
  private get agentArgs(): AgentInputs {
    return { query: this.params.prompt };
  }

  getDescription(): string {
    const description = `${this.params.description ?? this.params.prompt.slice(0, INPUT_PREVIEW_MAX_LENGTH)}`;
    return description.slice(0, DESCRIPTION_MAX_LENGTH);
  }

  /**
   * Override to capture parent lifecycle context from ToolUseContext
   * before delegating to execute().
   */
  override async executeWithContext(ctx: ToolUseContext): Promise<ToolResult> {
    if (ctx.agentLoopContext) {
      this.context = ctx.agentLoopContext;
    }
    this._parentRequestSetId = ctx.parentRequestSetId;
    this._parentBusinessInfo =
      ctx.parentBusinessInfo ?? getBusinessInfoFromContext();
    this._customContext = ctx.customContext;
    this._ownerAgentId = ctx.agentId;
    this._parentModel = ctx.modelKey;
    return this.execute(ctx.signal, ctx.updateOutput, ctx.options);
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
    options?: { setExecutionIdCallback?: (executionId: number) => void },
  ): Promise<ToolResult> {
    this._parentBusinessInfo ??= getBusinessInfoFromContext();
    const agentArgs = this.agentArgs;

    return (async () => {


        const result = await this.executeLocal(
          agentArgs,
          signal,
          updateOutput,
          options,
        );


        return result;
      })();
  }

  // -------------------------------------------------------------------------
  // Local agent execution
  // -------------------------------------------------------------------------

  private createProgressTracker(
    updateOutput: (output: ToolLiveOutput) => void,
    executionId?: number,
    color?: AgentColor,
    agentId?: string,
  ): ProgressTracker {
    const definition = this.definition as LocalAgentDefinition;
    const parentToolRegistry = this.context.toolRegistry;
    return new ProgressTracker({
      agentName: definition.name,
      agentId,
      prompt: this.params.prompt,
      color: color ?? definition.color,
      targetDir: this.context.config.getTargetDir(),
      updateOutput,
      resolveToolDisplayName: (apiName: string) =>
        parentToolRegistry.getTool(apiName)?.displayName,
      publishActivity: (activity) => {
        if (executionId !== undefined) {
          this.appendBackgroundExecutionOutput(
            executionId,
            this.formatActivityForBackgroundOutput(activity),
          );
        }
      },
    });
  }

  private async executeLocal(
    agentArgs: AgentInputs,
    signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
    options?: { setExecutionIdCallback?: (executionId: number) => void },
  ): Promise<ToolResult> {
    const definition = this.definition as LocalAgentDefinition;
    const parentToolUseId = getToolCallContext()?.callId;
    let agentId = createAgentId(definition.name);
    const taskId = createAgentId();
    if (this.callerIsTeammate && this.params.name?.trim()) {
      throw new Error(
        'Teammates cannot spawn other teammates - the team roster is flat. To spawn a subagent instead, omit the `name` parameter.',
      );
    }
    if (this.callerIsTeammate && this.params.run_in_background === true) {
      throw new Error(
        'In-process teammates cannot spawn background agents. Use run_in_background=false for synchronous subagents.',
      );
    }
    const isInProcessTeammate = this.isInProcessTeammateInvocation();
    const agentSessionsEnabled = isAgentSessionsEnabled();
    if (!agentSessionsEnabled && isInProcessTeammate) {
      throw new Error(
        `Named teammates require agent sessions, which are disabled by ${ENV_ENABLE_AGENT_SESSIONS}=0.`,
      );
    }
    const concurrencyRegistry =
      this.context.taskRegistry ?? this.context.config.taskRegistry;
    // tryAcquireAgentSlot returns an already-idempotent release callback, so
    // both the catch below and the settlement handler can call it.
    let releaseConcurrencySlot = () => {};
    if (concurrencyRegistry) {
      const maxConcurrentSubagents = getMaxConcurrentSubagents();
      const release = concurrencyRegistry.tryAcquireAgentSlot(
        maxConcurrentSubagents,
      );
      if (!release) {
        if (
          this.context.config.isUltracodeActive(
            await this.context.config
              .getModelProviderManager()
              .getModel(this.context.config.getModel()),
          )
        ) {
          releaseConcurrencySlot = await concurrencyRegistry.acquireAgentSlot(
            maxConcurrentSubagents,
            signal,
          );
        } else {
          throw new Error(
            `Concurrent subagent limit reached. You can run ${maxConcurrentSubagents} subagents at once. Do not retry. If the user wants more concurrent subagents, ask them to increase ${ENV_MAX_CONCURRENT_SUBAGENTS}.`,
          );
        }
      } else {
        releaseConcurrencySlot = release;
      }
    }
    const taskType: AgentUnifiedTask['type'] = isInProcessTeammate
      ? IN_PROCESS_TEAMMATE_TASK_TYPE
      : 'local_agent';
    const launchInBackground =
      agentSessionsEnabled &&
      (isInProcessTeammate ||
        this.params.run_in_background === true ||
        definition.background === true);
    let teamName: string | undefined;
    let agentName = this.getRuntimeAgentName();
    let teammateReserved = false;
    let teammateLaunchCommitted = false;
    let claimedTaskId: string | undefined;
    let preparedExecutionId: number | undefined;
    let persistedAgentTask = false;
    let registeredUnifiedTaskId: string | undefined;
    try {
      const resolvedModel = await resolveAgentModel(
        this.context,
        definition,
        undefined,
        this._parentModel,
      );
      teamName = isInProcessTeammate
        ? await this.context.config.waitForAgentTeamSession()
        : undefined;
      let runtimeColor = definition.color;
      if (isInProcessTeammate && teamName) {

        const sessionId = this.context.config.getSessionId();
        const reservation = await reserveAgentTeamMember({
          teamName,
          leadSessionId: sessionId,
          member: {
            name: agentName,
            taskId,
            agentType: definition.name,
            resolvedModel,
            sessionId,
            status: 'running',
            description: this.params.description,
            prompt: this.params.prompt,
            cwd: this.params.cwd ?? this.context.config.getTargetDir(),
          },
        });
        teammateReserved = true;
        agentName = reservation.member.name;
        agentId = reservation.member.agentId;
        runtimeColor = reservation.member.color;
        claimedTaskId = (
          await claimNextAvailableTask(this.context.config, agentName)
        )?.id;
      }
      const executionAbortController = new AbortController();
      let executionSettlement: Promise<void> | undefined;
      const executionHandle = ExecutionLifecycleService.createExecution(
        '',
        async () => {
          executionAbortController.abort();
          await executionSettlement;
        },
        'none',
        undefined,
        this.buildBackgroundExecutionLabel(),
        'notify',
        {
          sessionId: this.context.config.getSessionId(),
          customContext: snapshotCustomContext(this._customContext),
        },
      );
      const executionId = executionHandle.pid;
      if (executionId === undefined) {
        throw new Error('Failed to allocate an execution ID for subagent task');
      }
      preparedExecutionId = executionId;
      const sessionPersistence = this.context.config.getSessionPersistence();
      const transcriptPath = sessionPersistence
        ? getSubagentTranscriptPath(
            getSubagentArtifactContext(this.context.config),
            this.context.config.getSessionId(),
            agentId,
          )
        : '';
      const outputPath = transcriptPath
        ? await initTaskOutputAsSymlink(taskId, transcriptPath)
        : '';
      ExecutionLifecycleService.setTaskMetadata(executionId, {
        taskId,
        sessionId: this.context.config.getSessionId(),
        ownerAgentId: this._ownerAgentId,
        toolUseId: parentToolUseId,
        backgroundControlType: 'local_agent',
        outputPath,
        customContext: snapshotCustomContext(this._customContext),
      });
      if (sessionPersistence) {
        await registerAgentTask({
          projectRoot: getSubagentArtifactContext(this.context.config),
          sessionId: this.context.config.getSessionId(),
          taskId,
          executionId,
          agentId,
          agentType: definition.name,
          resolvedModel,
          description: this.params.description,
          invocationName: agentName,
          teamName,
          parentToolUseId,
          outputPath,
          transcriptPath,
          completionBehavior: 'notify',
          summary: `Agent "${this.buildBackgroundExecutionLabel()}" started`,
        });
        persistedAgentTask = true;
      }
      // Register in unified TaskRegistry for the background task panel
      const taskRegistry = agentSessionsEnabled
        ? this.context.taskRegistry
        : undefined;
      if (taskRegistry) {
        const agentTask: AgentUnifiedTask = {
          id: `a-${agentId}`,
          publicId: taskId,
          sessionId: this.context.config.getSessionId(),
          ownerAgentId: this._ownerAgentId,
          type: taskType,
          status: 'running',
          description: this.params.description,
          startTime: Date.now(),
          notified: false,
          executionId,
          toolUseId: parentToolUseId,
          outputPath,
          completionBehavior: 'notify',
          agentId,
          agentName,
          agentType: definition.name,
          resolvedModel,
          teamName,
          prompt: this.params.prompt,
          color: runtimeColor,
          isBackgrounded: launchInBackground,
          taskId,
          abortController: executionAbortController,
        };
        taskRegistry.register(agentTask);
        registeredUnifiedTaskId = agentTask.id;
      }

      if (parentToolUseId) {
        enqueueSubagentSdkEvent(
          this.context.config.getSessionId(),
          createTaskStartedEvent({
            sessionId: this.context.config.getSessionId(),
            taskId,
            toolUseId: parentToolUseId,
            description: this.params.description,
            taskType,
            subagentType: definition.name,
            prompt: this.params.prompt,
          }),
        );
      }
      if (launchInBackground) {
        this.enqueueBackgroundTasksChanged();
      }

      // Wrap updateOutput to also sync progress to TaskRegistry
      const originalUpdateOutput = updateOutput ?? (() => {});
      let isBackgrounded = false;
      const wrappedUpdateOutput: typeof originalUpdateOutput = (output) => {
        let toForward = output;
        if (
          isBackgrounded &&
          typeof output === 'object' &&
          output !== null &&
          'isSubagentProgress' in output &&
          output.isSubagentProgress === true &&
          !output.backgrounded
        ) {
          toForward = { ...output, backgrounded: true };
        }
        originalUpdateOutput(toForward);
        if (
          taskRegistry &&
          typeof toForward === 'object' &&
          toForward !== null &&
          'isSubagentProgress' in toForward
        ) {
          taskRegistry.updateProgress(`a-${agentId}`, toForward);
        }
      };

      const tracker = this.createProgressTracker(
        wrappedUpdateOutput,
        executionId,
        runtimeColor,
        agentId,
      );
      this.appendBackgroundExecutionOutput(
        executionId,
        `Launching agent '${definition.name}'\n`,
      );

      let detachedFromParent = launchInBackground;
      const onParentAbort = () => {
        if (!detachedFromParent) {
          executionAbortController.abort();
        }
      };
      signal.addEventListener('abort', onParentAbort, { once: true });

      let offBackgroundListener = () => {};
      const waitForBackgroundSignal = () =>
        new Promise<void>((resolve) => {
          const listener = (info: { executionId: number }) => {
            if (info.executionId !== executionId) {
              return;
            }
            ExecutionLifecycleService.offBackground(listener);
            offBackgroundListener = () => {};
            detachedFromParent = true;
            isBackgrounded = true;
            wrappedUpdateOutput(tracker.makeProgress('running'));
            resolve();
          };
          offBackgroundListener = () =>
            ExecutionLifecycleService.offBackground(listener);
          ExecutionLifecycleService.onBackground(listener);
        });

      let backgroundSignal: Promise<void>;
      if (launchInBackground) {
        backgroundSignal = Promise.resolve(undefined);
      } else if (agentSessionsEnabled) {
        backgroundSignal = waitForBackgroundSignal();
      } else {
        backgroundSignal = new Promise<void>(() => {});
      }

      // Expose executionId to the UI AFTER the onBackground listener is
      // installed, so Ctrl+B cannot fire between setExecutionIdCallback
      // and listener registration (race window found in review).
      if (agentSessionsEnabled) {
        options?.setExecutionIdCallback?.(executionId);
      }

      const agentQuery = agentArgs['query'];
      const teammateAgentArgs = isInProcessTeammate
        ? {
            ...agentArgs,
            query: formatTeammateMessage({
              from: TEAM_LEAD_MEMBER_NAME,
              text:
                typeof agentQuery === 'string'
                  ? agentQuery
                  : this.params.prompt,
              summary: this.params.description,
            }),
          }
        : agentArgs;
      const coreRunParams = {
        agentArgs: teammateAgentArgs,
        signal: executionAbortController.signal,
        tracker,
        taskId,
        agentId,
        executionId,
        outputPath,
        parentToolUseId,
        updateOutput: wrappedUpdateOutput,
        emitSdkSideEvents: true,
        emitSdkTaskStarted: false,
        emitSdkTaskNotification: !launchInBackground,
        taskType,
        teamName,
        runtimeColor,
        resolvedModel,
        runInBackground: launchInBackground,
      };
      const runPromise =
        isInProcessTeammate && teamName
          ? this.runInProcessTeammateLoop({
              ...coreRunParams,
              teamName,
              memberName: agentName,
            })
          : this.runLocalAgentCore(coreRunParams);
      executionSettlement = runPromise
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(releaseConcurrencySlot);

      if (launchInBackground) {
        ExecutionLifecycleService.background(executionId, 'model');
        isBackgrounded = true;
        wrappedUpdateOutput(tracker.makeProgress('running'));
      }
      teammateLaunchCommitted = true;
      try {
        const raceResult = await Promise.race([
          runPromise.then((outcome) => ({
            type: 'completed' as const,
            outcome,
          })),
          backgroundSignal.then(() => ({ type: 'background' as const })),
        ]);

        offBackgroundListener();

        if (raceResult.type === 'background') {
          detachedFromParent = true;
          const detachedCompletion = runPromise
            .then((outcome) =>
              this.completeBackgroundAgentTask(
                executionId,
                outcome,
                parentToolUseId,
              ),
            )
            .catch((error) =>
              this.failBackgroundAgentTask(
                executionId,
                agentId,
                taskId,
                outputPath,
                definition.name,
                error,
                parentToolUseId,
                executionAbortController.signal.reason,
              ),
            )
            .finally(() => {
              signal.removeEventListener('abort', onParentAbort);
            });
          executionSettlement = detachedCompletion.catch((error) => {
            runLogger.warn(
              `[AgentTool] Background finalization failed for execution ${executionId}:`,
              error,
            );
          });
          void executionSettlement;

          return this.createBackgroundLaunchResult({
            agentName,
            agentType: definition.name,
            taskType,
            teamName,
            executionId,
            agentId,
            taskId,
            outputPath,
            resolvedModel,
            color: runtimeColor,
          });
        }

        signal.removeEventListener('abort', onParentAbort);
        const isGoal =
          raceResult.outcome.terminateReason === AgentTerminateMode.GOAL;
        // Update TaskRegistry for foreground agents (background agents
        // are updated via completeBackgroundAgentTask/failBackgroundAgentTask)
        taskRegistry?.update(`a-${agentId}`, {
          status: isGoal ? 'completed' : 'failed',
          endTime: Date.now(),
          notified: true,
          result: raceResult.outcome.finalResult,
        } as Partial<AgentUnifiedTask>);
        ExecutionLifecycleService.completeExecution(executionId, {
          exitCode: isGoal ? 0 : 1,
          error: isGoal ? null : new Error(raceResult.outcome.finalResult),
        });
        return raceResult.outcome.toolResult;
      } catch (error) {
        offBackgroundListener();
        signal.removeEventListener('abort', onParentAbort);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const isAbort =
          (error instanceof Error && error.name === 'AbortError') ||
          errorMessage.includes('Aborted');

        // Update TaskRegistry for foreground agents
        taskRegistry?.update(`a-${agentId}`, {
          status: isAbort ? 'killed' : 'failed',
          endTime: Date.now(),
          notified: true,
          error: errorMessage,
        } as Partial<AgentUnifiedTask>);
        ExecutionLifecycleService.completeExecution(executionId, {
          aborted: isAbort,
          exitCode: isAbort ? 130 : 1,
          error:
            error instanceof Error ? error : new Error(String(errorMessage)),
        });

        tracker.markRunningAs(isAbort ? 'cancelled' : 'error');
        if (!isAbort) {
          tracker.addErrorActivity(
            `Error: ${sanitizeErrorMessage(errorMessage)}`,
          );
        }

        const errorProgress = tracker.makeProgress(
          isAbort ? 'cancelled' : 'error',
        );
        wrappedUpdateOutput(errorProgress);
        this.appendBackgroundExecutionOutput(
          executionId,
          `${isAbort ? 'Cancelled' : 'Error'}: ${sanitizeErrorMessage(errorMessage)}\n`,
        );

        if (isAbort) {
          throw error;
        }

        const failureText = `Agent '${definition.name}' failed. Error: ${errorMessage}`;
        return {
          llmContent: failureText,
          returnDisplay: errorProgress ?? failureText,
          toolUseResult: buildAgentToolCompletionResult({
            agentType: definition.name,
            content: failureText,
            state: 'error',
          }),
        };
      }
    } catch (error) {
      releaseConcurrencySlot();
      const reservationError =
        error instanceof AgentTeamReservationError ? error : undefined;
      const rollbackAgentId =
        reservationError?.getReservedAgentIdForRollback() ?? agentId;
      const reservationMayHaveCommitted =
        reservationError?.commitState === 'written' ||
        reservationError?.commitState === 'unknown';
      const shouldRollback =
        !teammateLaunchCommitted &&
        teamName !== undefined &&
        (teammateReserved ||
          (reservationMayHaveCommitted &&
            reservationError?.getReservedAgentIdForRollback() !== undefined));
      if (shouldRollback && teamName) {
        const rollback = async (
          description: string,
          operation: () => Promise<unknown> | unknown,
        ) => {
          try {
            await operation();
          } catch (rollbackError) {
            runLogger.warn(
              `[AgentTool] Failed to ${description} while rolling back teammate "${agentName}":`,
              rollbackError,
            );
          }
        };

        if (claimedTaskId) {
          await rollback('release the claimed shared task', () =>
            releaseClaimedTask(this.context.config, claimedTaskId!, agentName),
          );
        }
        await rollback('remove the reserved team member', () =>
          removeAgentTeamMember({
            teamName: teamName!,
            agentId: rollbackAgentId,
          }),
        );
        if (persistedAgentTask) {
          await rollback('delete the persisted agent task', () =>
            deleteAgentTaskRecord(
              getSubagentArtifactContext(this.context.config),
              this.context.config.getSessionId(),
              taskId,
            ),
          );
        }
        if (preparedExecutionId !== undefined) {
          await rollback('complete the prepared execution', () =>
            ExecutionLifecycleService.completeExecution(preparedExecutionId!, {
              exitCode: 1,
              error: error instanceof Error ? error : new Error(String(error)),
            }),
          );
        }
        if (registeredUnifiedTaskId) {
          const unifiedTaskId = registeredUnifiedTaskId;
          await rollback('remove the unified task registration', () =>
            this.context.taskRegistry?.remove(unifiedTaskId),
          );
        }
      }
      throw error;
    }
  }

  private buildBackgroundExecutionLabel(): string {
    return (
      this.params.name?.trim() ||
      this.params.description?.trim() ||
      this.definition.name
    );
  }

  private createBackgroundLaunchResult({
    agentName,
    agentType,
    taskType,
    teamName,
    executionId,
    agentId,
    taskId,
    outputPath,
    resolvedModel,
    color,
  }: {
    agentName: string;
    agentType: string;
    taskType: AgentUnifiedTask['type'];
    teamName?: string;
    executionId: number;
    agentId: string;
    taskId: string;
    outputPath: string;
    resolvedModel: string;
    color?: AgentColor;
  }): ToolResult {
    if (taskType === IN_PROCESS_TEAMMATE_TASK_TYPE) {
      if (!teamName) {
        throw new Error('A teammate launch requires a session team.');
      }
      const launchResult = buildAgentToolTeammateSpawnedResult({
        status: 'teammate_spawned',
        prompt: this.params.prompt,
        teammate_id: agentId,
        agent_id: agentId,
        agent_type: agentType,
        model: resolvedModel,
        name: agentName,
        color,
        tmux_session_name: 'in-process',
        tmux_window_name: 'in-process',
        tmux_pane_id: 'in-process',
        team_name: teamName,
        is_splitpane: false,
        plan_mode_required: this.context.config.isPlanMode(),
      });
      return {
        llmContent: [
          'Spawned successfully.',
          `agent_id: ${agentId}`,
          `name: ${agentName}`,
          'The teammate is running in the background.',
        ].join('\n'),
        returnDisplay: launchResult,
        toolUseResult: launchResult,
        data: {
          taskId,
          pid: executionId,
          command: `Agent ${agentName}`,
          initialOutput: `Agent '${agentName}' spawned as a teammate.`,
          teamName,
        },
      };
    }

    const canReadOutputFile =
      this.context.toolRegistry.getTool(READ_FILE_TOOL_NAME) !== undefined ||
      this.context.toolRegistry.getTool(SHELL_TOOL_NAME) !== undefined;
    const launchLines = [
      'Async agent launched successfully.',
      `agentId: ${agentId} (internal ID - do not mention to user.)`,
      'The agent is working in the background. You will be notified automatically when it completes.',
    ];
    if (canReadOutputFile) {
      launchLines.push(
        "Do not duplicate this agent's work — avoid working with the same files or topics it is using.",
        `output_file: ${outputPath}`,
        'Do NOT read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you will get a completion notification.',
      );
    } else {
      launchLines.push(
        'Briefly tell the user what you launched. Agent results will arrive in a subsequent message.',
      );
    }
    const llmMessage = launchLines.join('\n');
    const launchResult = buildAgentToolBackgroundLaunchResult({
      agentId,
      description: this.params.description,
      resolvedModel,
      prompt: this.params.prompt,
      outputFile: outputPath,
      canReadOutputFile,
    });
    return {
      llmContent: llmMessage,
      returnDisplay: launchResult,
      toolUseResult: launchResult,
      data: {
        taskId,
        pid: executionId,
        command: `Agent ${agentName}`,
        initialOutput: `Agent '${agentName}' launched in the background.`,
      },
    };
  }

  private appendBackgroundExecutionOutput(
    executionId: number,
    chunk: string,
  ): void {
    if (chunk.length === 0) {
      return;
    }
    ExecutionLifecycleService.appendOutput(executionId, chunk);
  }

  private enqueueBackgroundTasksChanged(): void {
    const taskRegistry = this.context.taskRegistry;
    if (!taskRegistry) {
      return;
    }
    enqueueBackgroundTasksChangedFromRegistry(
      this.context.config.getSessionId(),
      taskRegistry,
    );
  }

  private formatActivityForBackgroundOutput(
    activity: SubagentProgress['recentActivity'][number],
  ): string {
    if (activity.type === 'thought') {
      return `${activity.content}\n`;
    }

    const toolLabel = activity.displayName ?? activity.content;
    const argsSuffix = activity.args ? ` ${activity.args}` : '';
    switch (activity.status) {
      case 'completed':
        return `Completed ${toolLabel}${argsSuffix}\n`;
      case 'error':
        return `Failed ${toolLabel}${argsSuffix}\n`;
      case 'cancelled':
        return `Cancelled ${toolLabel}${argsSuffix}\n`;
      default:
        return `Running ${toolLabel}${argsSuffix}\n`;
    }
  }

  private async completeBackgroundAgentTask(
    executionId: number,
    outcome: LocalAgentRunOutcome,
    parentToolUseId?: string,
  ): Promise<void> {
    const status =
      outcome.terminateReason === AgentTerminateMode.GOAL
        ? 'completed'
        : 'failed';
    const maxTurns = outcome.terminationDetails?.maxTurns;
    const summary =
      outcome.terminateReason === AgentTerminateMode.MAX_TURNS &&
      maxTurns !== undefined
        ? `Agent "${this.buildBackgroundExecutionLabel()}": ${formatMaxTurnsReachedNotice(maxTurns)}`
        : status === 'completed'
          ? `Agent "${this.buildBackgroundExecutionLabel()}" finished`
          : `Agent "${this.buildBackgroundExecutionLabel()}" failed: ${outcome.finalResult || 'Unknown error'}`;
    const endTime = Date.now();

    // Update unified TaskRegistry
    this.context.taskRegistry?.update(`a-${outcome.agentId}`, {
      status: status === 'completed' ? 'completed' : 'failed',
      endTime,
      notified: false,
      result: outcome.finalResult,
      worktreePath: outcome.worktreePath,
    } as Partial<AgentUnifiedTask>);
    this.enqueueBackgroundTasksChanged();

    enqueueSubagentSdkEvent(
      this.context.config.getSessionId(),
      createTaskUpdatedEvent({
        sessionId: this.context.config.getSessionId(),
        taskId: outcome.taskId,
        status: status === 'completed' ? 'completed' : 'failed',
        endTime,
      }),
    );

    await flushTaskOutput(outcome.taskId);

    ExecutionLifecycleService.markNotified(executionId);
    enqueuePendingNotification({
      prompt: buildTaskNotificationXml({
        taskId: outcome.taskId,
        outputPath: outcome.outputPath ?? '',
        status,
        summary,
        toolUseId: parentToolUseId,
        result: outcome.finalResult,
        usage: {
          totalTokens: outcome.totalTokens ?? 0,
          toolUses: outcome.toolCalls ?? 0,
          durationMs: outcome.durationMs ?? 0,
        },
      }),
      commandMode: 'task-notification',
      priority: 'next',
      sessionId: this.context.config.getSessionId(),
      targetAgentId: this._ownerAgentId,
      ...(this._customContext !== undefined
        ? { customContext: snapshotCustomContext(this._customContext) }
        : {}),
    });
    this.context.taskRegistry?.markNotified(`a-${outcome.agentId}`);

    ExecutionLifecycleService.completeExecution(executionId, {
      exitCode: status === 'completed' ? 0 : 1,
      error: status === 'completed' ? null : new Error(outcome.finalResult),
    });
  }

  private async failBackgroundAgentTask(
    executionId: number,
    agentId: string,
    taskId: string,
    outputPath: string,
    agentName: string,
    error: unknown,
    parentToolUseId?: string,
    abortReason?: unknown,
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isAbort =
      (error instanceof Error && error.name === 'AbortError') ||
      errorMessage.includes('Aborted');
    const isCooperativeShutdown =
      isAbort && abortReason === 'shutdown-approved';
    const registryTask = this.context.taskRegistry?.get(`a-${agentId}`);
    const alreadyStopped = registryTask?.status === 'killed';

    const label = this.buildBackgroundExecutionLabel();
    const summary = isAbort
      ? `Agent "${label}" was stopped`
      : `Agent "${label}" failed: ${errorMessage || 'Unknown error'}`;
    const endTime = Date.now();
    const terminalStatus = isAbort ? 'killed' : 'failed';

    if (!alreadyStopped) {
      this.context.taskRegistry?.update(`a-${agentId}`, {
        status: terminalStatus,
        endTime,
        notified: isCooperativeShutdown,
        ...(!isCooperativeShutdown ? { error: errorMessage } : {}),
      } as Partial<AgentUnifiedTask>);
      this.enqueueBackgroundTasksChanged();
      enqueueSubagentSdkEvent(
        this.context.config.getSessionId(),
        createTaskUpdatedEvent({
          sessionId: this.context.config.getSessionId(),
          taskId,
          status: terminalStatus,
          endTime,
        }),
      );
    }

    await flushTaskOutput(taskId);
    ExecutionLifecycleService.markNotified(executionId);
    if (!isAbort) {
      enqueuePendingNotification({
        prompt: buildTaskNotificationXml({
          taskId,
          outputPath,
          status: 'failed',
          summary,
          toolUseId: parentToolUseId,
          result: errorMessage,
        }),
        commandMode: 'task-notification',
        priority: 'next',
        sessionId: this.context.config.getSessionId(),
        targetAgentId: this._ownerAgentId,
        ...(this._customContext !== undefined
          ? { customContext: snapshotCustomContext(this._customContext) }
          : {}),
      });
    }
    this.context.taskRegistry?.markNotified(`a-${agentId}`);

    this.appendBackgroundExecutionOutput(
      executionId,
      isCooperativeShutdown
        ? `Agent '${agentName}' stopped\n`
        : `${isAbort ? 'Cancelled' : `Agent '${agentName}' failed`}: ${sanitizeErrorMessage(errorMessage)}\n`,
    );
    if (isAbort) {
      await flushTaskOutput(taskId);
    }
    ExecutionLifecycleService.completeExecution(executionId, {
      aborted: isAbort && !isCooperativeShutdown,
      exitCode: isCooperativeShutdown ? 0 : isAbort ? 130 : 1,
      error: isCooperativeShutdown
        ? null
        : error instanceof Error
          ? error
          : new Error(String(errorMessage)),
    });
  }

  private async runLocalAgentCore(params: {
    agentArgs: AgentInputs;
    signal: AbortSignal;
    tracker: ProgressTracker;
    taskId: string;
    agentId: string;
    executionId: number;
    outputPath: string;
    parentToolUseId?: string;
    updateOutput?: (output: ToolLiveOutput) => void;
    emitSdkSideEvents: boolean;
    emitSdkTaskStarted: boolean;
    emitSdkTaskNotification: boolean;
    taskType: AgentUnifiedTask['type'];
    teamName?: string;
    resumeState?: AgentResumeState;
    includeTeammateContext?: boolean;
    preserveTaskOnTeammateIdle?: boolean;
    runtimeColor?: AgentColor;
    resolvedModel: string;
    runInBackground: boolean;
  }): Promise<LocalAgentRunOutcome> {
    const {
      agentArgs,
      signal,
      tracker,
      taskId,
      agentId,
      executionId,
      outputPath,
      parentToolUseId,
      updateOutput,
      emitSdkSideEvents,
      emitSdkTaskStarted,
      emitSdkTaskNotification,
      taskType,
      teamName,
      resumeState,
      includeTeammateContext,
      preserveTaskOnTeammateIdle,
      runtimeColor,
      resolvedModel,
      runInBackground,
    } = params;
    const baseDefinition = this.definition as LocalAgentDefinition;
    const definition =
      (runtimeColor && runtimeColor !== baseDefinition.color) ||
      this.params.mode !== undefined
        ? {
            ...baseDefinition,
            ...(runtimeColor && runtimeColor !== baseDefinition.color
              ? { color: runtimeColor }
              : {}),
            ...(this.params.mode !== undefined
              ? {
                  permissionMode: this.params.mode,
                }
              : {}),
          }
        : baseDefinition;
    return runAgent({
      definition,
      context: this.context,
      agentArgs,
      tracker,
      signal,
      taskId,
      agentId,
      outputPath,
      description: this.params.description,
      invocationName: this.getRuntimeAgentName(),
      teamName,
      taskType,
      cwdOverride: this.params.cwd,
      isolationOverride: this.params.isolation,
      isForkPath: this.isForkPath,
      parentToolUseId,
      appendOutput: (chunk) =>
        this.appendBackgroundExecutionOutput(executionId, chunk),
      updateOutput,
      emitSdkSideEvents,
      emitSdkTaskStarted,
      emitSdkTaskNotification,
      resumeState,
      includeTeammateContext,
      preserveTaskOnTeammateIdle,
      parentRequestSetId: this._parentRequestSetId,
      parentModel: this._parentModel,
      resolvedModel,
      ownerAgentId: this._ownerAgentId,
      runInBackground,
      parentBusinessInfo: this._parentBusinessInfo,
      customContext: this._customContext,
    });
  }

  private async runInProcessTeammateLoop(
    params: Parameters<AgentInvocation['runLocalAgentCore']>[0] & {
      teamName: string;
      memberName: string;
    },
  ): Promise<LocalAgentRunOutcome> {
    const unregisterController = registerTeammateController(params.agentId);
    let agentArgs = params.agentArgs;
    let resumeState: AgentResumeState | undefined;
    let includeTeammateContext = true;

    try {
      while (!params.signal.aborted) {
        await updateAgentTeamMemberStatus({
          teamName: params.teamName,
          memberName: params.memberName,
          status: 'running',
        });
        this.context.taskRegistry?.update(`a-${params.agentId}`, {
          isIdle: false,
        } as Partial<AgentUnifiedTask>);

        const outcome: LocalAgentRunOutcome = await this.runLocalAgentCore({
          ...params,
          agentArgs,
          resumeState,
          includeTeammateContext,
          emitSdkTaskNotification: false,
          preserveTaskOnTeammateIdle: true,
        });
        includeTeammateContext = false;
        if (outcome.terminateReason !== AgentTerminateMode.GOAL) {

          return outcome;
        }



        const transcript = await readSubagentTranscript(
          getSubagentArtifactContext(this.context.config),
          this.context.config.getSessionId(),
          params.agentId,
        );
        resumeState = toAgentResumeState(transcript);

        await publishTeammateIdleNotification({
          config: this.context.config,
          teamName: params.teamName,
          memberName: params.memberName,
          agentId: params.agentId,
          taskId: params.taskId,
          idleReason: 'available',
          summary:
            outcome.teammateIdleSummary ??
            deriveTeammateIdleSummary(transcript?.messages ?? []),
        });
        this.context.taskRegistry?.update(`a-${params.agentId}`, {
          isIdle: true,
          result: outcome.finalResult,
        } as Partial<AgentUnifiedTask>);

        const nextInput = await this.waitForTeammateInput({
          teamName: params.teamName,
          memberName: params.memberName,
          agentId: params.agentId,
          signal: params.signal,
        });
        agentArgs = { query: nextInput.prompt };
        if (nextInput.businessInfo)
          this._parentBusinessInfo = nextInput.businessInfo;
      }
      throw new DOMException('Teammate stopped', 'AbortError');
    } finally {
      unregisterController();
      if (params.signal.aborted) {
        await updateAgentTeamMemberStatus({
          teamName: params.teamName,
          memberName: params.memberName,
          status: 'stopped',
        }).catch(() => {});

      }
    }
  }

  private async waitForTeammateInput(params: {
    teamName: string;
    memberName: string;
    agentId: string;
    signal: AbortSignal;
  }): Promise<{ prompt: string; businessInfo?: Readonly<BusinessInfo> }> {
    while (!params.signal.aborted) {
      const messages = await readTeamInbox({
        teamName: params.teamName,
        memberName: params.memberName,
        unreadOnly: true,
        markRead: true,
        oneBusinessBatch: true,
      });
      if (messages.length > 0) {
        return {
          prompt: formatTeamMailboxMessages(messages),
          businessInfo: messages[0]?.businessInfo,
        };
      }

      const task = await claimNextAvailableTask(
        this.context.config,
        params.memberName,
      );
      if (task) {
        return {
          prompt: buildClaimedTaskPrompt(task),
          businessInfo: task.businessInfo,
        };
      }

      await waitForTeammateControllerSignal(params.agentId, params.signal);
    }
    throw new DOMException('Teammate stopped', 'AbortError');
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------
}

// ---------------------------------------------------------------------------
// spawnForkSubtask — user-facing fork spawn for the /subtask command
// ---------------------------------------------------------------------------

export interface SpawnForkSubtaskResult {
  /** Derived runtime name (deriveForkName). */
  name: string;
  /** Background task agent id (empty string if the launch result omits it). */
  agentId: string;
}

/**
 * Assemble the Agent-tool params for a fork subtask. Extracted + exported so a
 * unit test can assert the label synthesis and the load-bearing
 * `run_in_background: true` link without mocking the whole `executeLocal`
 * surface. The Agent schema requires both `description` and `prompt`, so both
 * are synthesized from the free-form directive.
 */
export function buildForkSubtaskParams(directive: string): AgentToolParams {
  return {
    description: truncateDirectiveLabel(directive),
    prompt: directive,
    name: deriveForkName(directive),
    run_in_background: true,
  };
}

/**
 * Spawn an in-session async fork subagent from a user directive, bypassing the
 * model. Forces the fork path (`FORK_AGENT` + `isForkPath`) regardless of
 * `isForkSubagentEnabled()` — that env gate only governs the model's implicit
 * fork experiment, whereas `/subtask` is a first-class command.
 *
 * The child inherits the parent's full context (rendered system prompt, tool
 * schemas, conversation messages) via the same `AgentLoopContext` the model
 * path uses, runs in the background, and reports back through the existing
 * task-notification machinery.
 *
 * Callers (the `/subtask` command) surface user-facing guard messages; the
 * defensive backstop below throws for any other caller.
 */
export async function spawnForkSubtask(
  agentContext: AgentLoopContext,
  directive: string,
  opts?: { signal?: AbortSignal },
): Promise<SpawnForkSubtaskResult> {
  if (!isAgentSessionsEnabled()) {
    throw new Error(
      `/subtask requires agent sessions, which are disabled by ${ENV_ENABLE_AGENT_SESSIONS}=0.`,
    );
  }
  // Backstop: never fork from inside a forked worker (anti-recursion).
  const messages = agentContext.getConversationMessages?.() ?? [];
  if (isInForkChild(messages)) {
    throw new Error('Cannot start a subtask from inside a forked worker.');
  }

  const params = buildForkSubtaskParams(directive);
  const invocation = new AgentInvocation(
    params,
    FORK_AGENT,
    agentContext,
    /* isForkPath */ true,
  );

  // Call execute() directly (not executeWithContext): a user-initiated subtask
  // has no parent tool-use, so parent request-set / tool-use attribution is
  // intentionally left undefined. With run_in_background,
  // execute() resolves quickly via the background race while the run detaches.
  const result = await invocation.execute(
    opts?.signal ?? new AbortController().signal,
  );
  const agentId =
    (result.data as { taskId?: string } | undefined)?.taskId ?? '';
  return { name: params.name ?? deriveForkName(directive), agentId };
}
