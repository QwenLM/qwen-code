/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from '../tools.js';
import { ToolNames, ToolDisplayNames } from '../tool-names.js';
import type {
  ToolResult,
  ToolResultDisplay,
  AgentResultDisplay,
} from '../tools.js';
import { ToolConfirmationOutcome } from '../tools.js';
import type {
  ToolCallConfirmationDetails,
  ToolConfirmationPayload,
} from '../tools.js';
import type { Config } from '../../config/config.js';
import type { SubagentManager } from '../../subagents/subagent-manager.js';
import type { SubagentConfig } from '../../subagents/types.js';
import { AgentTerminateMode } from '../../agents/runtime/agent-types.js';
import type {
  PromptConfig,
  RunConfig,
  ToolConfig,
} from '../../agents/runtime/agent-types.js';
import {
  AgentHeadless,
  ContextState,
} from '../../agents/runtime/agent-headless.js';
import type { AgentExternalInput } from '../../agents/runtime/agent-types.js';
import type { Content, FunctionDeclaration } from '@google/genai';
import {
  FORK_AGENT,
  FORK_PLACEHOLDER_RESULT,
  buildForkedMessages,
  buildChildMessage,
  isInForkExecution,
  runInForkContext,
} from './fork-subagent.js';
import {
  getCurrentAgentId,
  runWithAgentContext,
} from '../../agents/runtime/agent-context.js';
import {
  AgentEventEmitter,
  AgentEventType,
} from '../../agents/runtime/agent-events.js';
import type {
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentFinishEvent,
  AgentErrorEvent,
  AgentApprovalRequestEvent,
  AgentUsageEvent,
} from '../../agents/runtime/agent-events.js';
import { BuiltinAgentRegistry } from '../../subagents/builtin-agents.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { PermissionMode } from '../../hooks/types.js';
import type { StopHookOutput } from '../../hooks/types.js';
import { ApprovalMode } from '../../config/config.js';
import {
  getAgentJsonlPath,
  getAgentMetaPath,
  attachJsonlTranscriptWriter,
  patchAgentMeta,
  writeAgentMeta,
} from '../../agents/agent-transcript.js';
import { getGitBranch } from '../../utils/gitUtils.js';

function persistBackgroundCancellation(
  metaPath: string,
  persistedStatus: 'running' | 'cancelled',
): void {
  patchAgentMeta(metaPath, {
    status: persistedStatus,
    lastUpdatedAt: new Date().toISOString(),
    lastError: undefined,
  });
}

function createLocalExternalInputQueue(): {
  enqueue: (input: AgentExternalInput) => boolean;
  drain: () => AgentExternalInput[];
  wait: (signal: AbortSignal) => Promise<AgentExternalInput[]>;
  wake: () => void;
} {
  const inputs: AgentExternalInput[] = [];
  const waiters = new Set<() => void>();

  const drain = () => inputs.splice(0);
  const wakeWaiters = () => {
    const pending = Array.from(waiters);
    for (const waiter of pending) {
      waiter();
    }
  };

  return {
    enqueue(input: AgentExternalInput): boolean {
      inputs.push(input);
      wakeWaiters();
      return true;
    },
    drain,
    wake(): void {
      wakeWaiters();
    },
    wait(signal: AbortSignal): Promise<AgentExternalInput[]> {
      const immediate = drain();
      if (immediate.length > 0 || signal.aborted) {
        return Promise.resolve(immediate);
      }

      return new Promise<AgentExternalInput[]>((resolve) => {
        const cleanup = () => {
          waiters.delete(onWake);
          signal.removeEventListener('abort', onAbort);
        };
        const onWake = () => {
          cleanup();
          resolve(drain());
        };
        const onAbort = () => {
          cleanup();
          resolve([]);
        };
        waiters.add(onWake);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
          cleanup();
          resolve([]);
          return;
        }
      });
    },
  };
}

export interface AgentParams {
  description: string;
  prompt: string;
  subagent_type?: string;
  run_in_background?: boolean;
}

const debugLogger = createDebugLogger('AGENT');

/**
 * Maps ApprovalMode to PermissionMode for hook events.
 */
function approvalModeToPermissionMode(mode: ApprovalMode): PermissionMode {
  switch (mode) {
    case ApprovalMode.YOLO:
      return PermissionMode.Yolo;
    case ApprovalMode.AUTO_EDIT:
      return PermissionMode.AutoEdit;
    case ApprovalMode.PLAN:
      return PermissionMode.Plan;
    case ApprovalMode.DEFAULT:
    default:
      return PermissionMode.Default;
  }
}

/**
 * Resolves the effective permission mode for a sub-agent.
 *
 * Rules (matching claw-code):
 * - Permissive parent modes (yolo, auto-edit) always win
 * - Otherwise, the agent definition's mode applies if set
 * - Default fallback is auto-edit (sub-agents need autonomy)
 */
export function resolveSubagentApprovalMode(
  parentApprovalMode: ApprovalMode,
  agentApprovalMode?: string,
  isTrustedFolder?: boolean,
): PermissionMode {
  // Permissive parent modes always win
  if (
    parentApprovalMode === ApprovalMode.YOLO ||
    parentApprovalMode === ApprovalMode.AUTO_EDIT
  ) {
    return approvalModeToPermissionMode(parentApprovalMode);
  }

  // Agent definition's mode applies if set
  if (agentApprovalMode) {
    const resolved = approvalModeToPermissionMode(
      agentApprovalMode as ApprovalMode,
    );
    // Privileged modes require trusted folder
    if (
      !isTrustedFolder &&
      (resolved === PermissionMode.Yolo || resolved === PermissionMode.AutoEdit)
    ) {
      return approvalModeToPermissionMode(parentApprovalMode);
    }
    return resolved;
  }

  // Default: match parent mode. In plan mode, stay in plan.
  // In default mode in trusted folders, auto-edit for autonomy.
  if (parentApprovalMode === ApprovalMode.PLAN) {
    return PermissionMode.Plan;
  }
  if (isTrustedFolder) {
    return PermissionMode.AutoEdit;
  }
  return approvalModeToPermissionMode(parentApprovalMode);
}

/**
 * Maps PermissionMode back to ApprovalMode.
 */
function permissionModeToApprovalMode(mode: PermissionMode): ApprovalMode {
  switch (mode) {
    case PermissionMode.Yolo:
      return ApprovalMode.YOLO;
    case PermissionMode.AutoEdit:
      return ApprovalMode.AUTO_EDIT;
    case PermissionMode.Plan:
      return ApprovalMode.PLAN;
    case PermissionMode.Default:
    default:
      return ApprovalMode.DEFAULT;
  }
}

/**
 * Marker that signals "this Config wrapper has rebuilt its own tool
 * registry so bound EditTool / WriteFileTool / ReadFileTool resolve to
 * the wrapper instead of the parent". Stored as a Symbol-keyed property
 * so that JavaScript's normal property lookup (which walks the
 * prototype chain) lets a downstream wrapper detect a rebuild that
 * happened on any ancestor without manually walking the chain.
 *
 * `Symbol.for` is used so the marker survives bundle-deduping; two
 * independent imports of this module observe the same Symbol identity.
 */
export const TOOL_REGISTRY_REBUILT: unique symbol = Symbol.for(
  'qwen-code:tool-registry-rebuilt',
);

/**
 * `true` if any Config in this wrapper's prototype chain has already
 * rebuilt its tool registry via {@link rebuildToolRegistryOnOverride}.
 *
 * Used by spawn sites that may be called with a wrapper-on-wrapper
 * argument (e.g. `subagent-manager.ts:buildSubagentContextOverride`
 * receiving `bgConfig = Object.create(agentConfig)` from the
 * background-agent path) to skip a redundant rebuild.
 */
export function hasRebuiltToolRegistry(config: Config): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (config as any)[TOOL_REGISTRY_REBUILT] === true;
}

/**
 * Rebuilds the tool registry on `override` so core tools resolve
 * `this.config` to `override` instead of `base`. Used by both
 * {@link createApprovalModeOverride} and
 * `subagent-manager.ts:buildSubagentContextOverride` to avoid
 * duplicated rebuild logic.
 *
 * - `override.createToolRegistry(...)` runs on the override (so the
 *   lazy factories close over `this = override`).
 * - Discovered tools (MCP / command-discovered) are copied from `base`
 *   rather than re-discovered, since discovery is expensive.
 * - The {@link TOOL_REGISTRY_REBUILT} marker is set so wrapper-of-wrapper
 *   layers downstream skip the rebuild via {@link hasRebuiltToolRegistry}.
 */
export async function rebuildToolRegistryOnOverride(
  override: Config,
  base: Config,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ov = override as any;
  const agentRegistry = await ov.createToolRegistry(undefined, {
    skipDiscovery: true,
  });
  agentRegistry.copyDiscoveredToolsFrom(base.getToolRegistry());
  ov.getToolRegistry = () => agentRegistry;
  ov[TOOL_REGISTRY_REBUILT] = true;
}

/**
 * Creates a Config override with a different approval mode.
 *
 * Uses prototype delegation (Object.create) to avoid mutating the parent
 * config, then delegates to {@link rebuildToolRegistryOnOverride} so the
 * override's tool registry has core tools bound to the override rather
 * than to the parent. Without that rebuild, the parent's cached tool
 * instances continue to resolve `this.config` to the parent, defeating
 * per-Config isolation of FileReadCache / approval mode for any code
 * path that goes through the bound tool.
 */
export async function createApprovalModeOverride(
  base: Config,
  mode: ApprovalMode,
): Promise<Config> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const override = Object.create(base) as any;
  override.getApprovalMode = (): ApprovalMode => mode;
  await rebuildToolRegistryOnOverride(override as Config, base);
  return override as Config;
}

/**
 * Agent tool that enables primary agents to delegate tasks to specialized agents.
 * The tool dynamically loads available agents and includes them in its description
 * for the model to choose from.
 */
export class AgentTool extends BaseDeclarativeTool<AgentParams, ToolResult> {
  static readonly Name: string = ToolNames.AGENT;

  private subagentManager: SubagentManager;
  private availableSubagents: SubagentConfig[] =
    BuiltinAgentRegistry.getBuiltinAgents();
  private readonly removeChangeListener: () => void;

  constructor(private readonly config: Config) {
    // Initialize with a basic schema first
    const initialSchema = {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of the task',
        },
        prompt: {
          type: 'string',
          description: 'The task for the agent to perform',
        },
        subagent_type: {
          type: 'string',
          description: 'The type of specialized agent to use for this task',
        },
        run_in_background: {
          type: 'boolean',
          description:
            'Set to true to run this agent in the background. You will be notified when it completes.',
        },
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    };

    super(
      AgentTool.Name,
      ToolDisplayNames.AGENT,
      'Launch a new agent to handle complex, multi-step tasks autonomously.\n\nThe Agent tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.\n\nAvailable agent types and the tools they have access to:\n',
      Kind.Other,
      initialSchema,
      true, // isOutputMarkdown
      true, // canUpdateOutput - Enable live output updates for real-time progress
    );

    this.subagentManager = config.getSubagentManager();
    this.removeChangeListener = this.subagentManager.addChangeListener(() => {
      void this.refreshSubagents();
    });

    // Initialize the tool asynchronously
    this.refreshSubagents();
  }

  dispose(): void {
    this.removeChangeListener();
  }

  /**
   * Asynchronously initializes the tool by loading available subagents
   * and updating the description and schema.
   */
  async refreshSubagents(): Promise<void> {
    try {
      this.availableSubagents = await this.subagentManager.listSubagents();
      this.updateDescriptionAndSchema();
    } catch (error) {
      debugLogger.warn('Failed to load agents for Agent tool:', error);
      this.availableSubagents = BuiltinAgentRegistry.getBuiltinAgents();
      this.updateDescriptionAndSchema();
    } finally {
      // Update the client with the new tools
      const geminiClient = this.config.getGeminiClient();
      if (geminiClient) {
        await geminiClient.setTools();
      }
    }
  }

  /**
   * Updates the tool's description and schema based on available subagents.
   */
  private updateDescriptionAndSchema(): void {
    let subagentDescriptions = '';
    if (this.availableSubagents.length === 0) {
      subagentDescriptions =
        'No subagents are currently configured. You can create subagents using the /agents command.';
    } else {
      subagentDescriptions = this.availableSubagents
        .map((subagent) => `- **${subagent.name}**: ${subagent.description}`)
        .join('\n');
    }

    const baseDescription = `Launch a new agent to handle complex, multi-step tasks autonomously.
The Agent tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${subagentDescriptions}

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

When NOT to use the Agent tool:
- If you want to read a specific file path, use the ${ToolNames.READ_FILE} tool or the ${ToolNames.GLOB} tool instead of the ${ToolNames.AGENT} tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the ${ToolNames.GREP} tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the ${ToolNames.READ_FILE} tool instead of the ${ToolNames.AGENT} tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above


Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- Provide clear, detailed prompts so the agent can work autonomously and return exactly the information you need.
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Agent tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.
- You can optionally set \`run_in_background: true\` to run the agent in the background. You will be notified when it completes. Use this when you have genuinely independent work to do in parallel and don't need the agent's results before you can proceed.

Example usage:

<example_agent_descriptions>
"test-runner": use this agent after you are done writing code to run tests
"greeting-responder": use this agent to respond to user greetings with a friendly joke
</example_agent_descriptions>

<example>
user: "Please write a function that checks if a number is prime"
assistant: I'm going to use the Write tool to write the following code:
<code>
function isPrime(n) {
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}
</code>
<commentary>
Since a significant piece of code was written and the task was completed, now use the test-runner agent to run the tests
</commentary>
assistant: Uses the ${ToolNames.AGENT} tool to launch the test-runner agent
</example>

<example>
user: "Hello"
<commentary>
Since the user is greeting, use the greeting-responder agent to respond with a friendly joke
</commentary>
assistant: "I'm going to use the ${ToolNames.AGENT} tool to launch the greeting-responder agent"
</example>
`;

    // Update description using object property assignment since it's readonly
    (this as { description: string }).description = baseDescription;

    // Generate dynamic schema with enum of available subagent names
    const subagentNames = this.availableSubagents.map((s) => s.name);

    // Update the parameter schema by modifying the existing object
    const schema = this.parameterSchema as {
      properties?: {
        subagent_type?: {
          enum?: string[];
        };
      };
    };
    if (schema.properties && schema.properties.subagent_type) {
      if (subagentNames.length > 0) {
        schema.properties.subagent_type.enum = subagentNames;
      } else {
        delete schema.properties.subagent_type.enum;
      }
    }
  }

  override validateToolParams(params: AgentParams): string | null {
    // Validate required fields
    if (
      !params.description ||
      typeof params.description !== 'string' ||
      params.description.trim() === ''
    ) {
      return 'Parameter "description" must be a non-empty string.';
    }

    if (
      !params.prompt ||
      typeof params.prompt !== 'string' ||
      params.prompt.trim() === ''
    ) {
      return 'Parameter "prompt" must be a non-empty string.';
    }

    if (params.subagent_type !== undefined) {
      if (
        typeof params.subagent_type !== 'string' ||
        params.subagent_type.trim() === ''
      ) {
        return 'Parameter "subagent_type" must be a non-empty string.';
      }
      // Validate that the subagent exists (case-insensitive)
      const lowerType = params.subagent_type.toLowerCase();
      const subagentExists = this.availableSubagents.some(
        (subagent) => subagent.name.toLowerCase() === lowerType,
      );

      if (!subagentExists) {
        const availableNames = this.availableSubagents.map((s) => s.name);
        return `Subagent "${params.subagent_type}" not found. Available subagents: ${availableNames.join(', ')}`;
      }
    }

    return null;
  }

  protected createInvocation(params: AgentParams) {
    return new AgentToolInvocation(this.config, this.subagentManager, params);
  }

  getAvailableSubagentNames(): string[] {
    return this.availableSubagents.map((subagent) => subagent.name);
  }
}

class AgentToolInvocation extends BaseToolInvocation<AgentParams, ToolResult> {
  readonly eventEmitter: AgentEventEmitter = new AgentEventEmitter();
  private currentDisplay: AgentResultDisplay | null = null;
  private currentToolCalls: AgentResultDisplay['toolCalls'] = [];
  private callId?: string;

  constructor(
    private readonly config: Config,
    private readonly subagentManager: SubagentManager,
    params: AgentParams,
  ) {
    super(params);
  }

  // Background agents carry the tool-use id through to completion notifications.
  setCallId(callId: string): void {
    this.callId = callId;
  }

  /**
   * Updates the current display state and calls updateOutput if provided
   */
  private updateDisplay(
    updates: Partial<AgentResultDisplay>,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): void {
    if (!this.currentDisplay) return;

    this.currentDisplay = {
      ...this.currentDisplay,
      ...updates,
    };

    if (updateOutput) {
      updateOutput(this.currentDisplay);
    }
  }

  private registerOwnedMonitorNotifications(
    agentId: string,
    enqueue: (input: AgentExternalInput) => boolean,
    wake: () => void,
  ): () => void {
    const monitorRegistry = this.config.getMonitorRegistry();
    monitorRegistry.setAgentNotificationCallback(
      agentId,
      (_displayText, modelText) =>
        void enqueue({ kind: 'notification', text: modelText }),
    );
    monitorRegistry.setAgentLifecycleCallback(agentId, wake);

    return () => {
      monitorRegistry.cancelRunningForOwner(agentId, { notify: false });
      monitorRegistry.setAgentNotificationCallback(agentId, undefined);
      monitorRegistry.setAgentLifecycleCallback(agentId, undefined);
    };
  }

  /**
   * Sets up event listeners for real-time subagent progress updates
   */
  private setupEventListeners(
    updateOutput?: (output: ToolResultDisplay) => void,
  ): void {
    let pendingConfirmationCallId: string | undefined;

    this.eventEmitter.on(AgentEventType.START, () => {
      this.updateDisplay({ status: 'running' }, updateOutput);
    });

    this.eventEmitter.on(AgentEventType.TOOL_CALL, (...args: unknown[]) => {
      const event = args[0] as AgentToolCallEvent;
      const newToolCall = {
        callId: event.callId,
        name: event.name,
        status: 'executing' as const,
        args: event.args,
        description: event.description,
      };
      this.currentToolCalls!.push(newToolCall);

      this.updateDisplay(
        {
          toolCalls: [...this.currentToolCalls!],
        },
        updateOutput,
      );
    });

    this.eventEmitter.on(AgentEventType.TOOL_RESULT, (...args: unknown[]) => {
      const event = args[0] as AgentToolResultEvent;
      const toolCallIndex = this.currentToolCalls!.findIndex(
        (call) => call.callId === event.callId,
      );
      if (toolCallIndex >= 0) {
        this.currentToolCalls![toolCallIndex] = {
          ...this.currentToolCalls![toolCallIndex],
          status: event.success ? 'success' : 'failed',
          error: event.error,
          responseParts: event.responseParts,
        };

        // When a tool result arrives for the tool that had a pending
        // confirmation, clear the stale prompt. This handles the case where
        // the IDE diff-tab accept resolved the tool via CoreToolScheduler's
        // IDE confirmation handler, which bypasses the UI's onConfirm wrapper.
        const clearPending =
          pendingConfirmationCallId === event.callId
            ? { pendingConfirmation: undefined }
            : {};
        if (pendingConfirmationCallId === event.callId) {
          pendingConfirmationCallId = undefined;
        }

        this.updateDisplay(
          {
            toolCalls: [...this.currentToolCalls!],
            ...clearPending,
          },
          updateOutput,
        );
      }
    });

    this.eventEmitter.on(AgentEventType.FINISH, (...args: unknown[]) => {
      const event = args[0] as AgentFinishEvent;
      this.updateDisplay(
        {
          status: event.terminateReason === 'GOAL' ? 'completed' : 'failed',
          terminateReason: event.terminateReason,
        },
        updateOutput,
      );
    });

    this.eventEmitter.on(AgentEventType.ERROR, (...args: unknown[]) => {
      const event = args[0] as AgentErrorEvent;
      this.updateDisplay(
        {
          status: 'failed',
          terminateReason: event.error,
        },
        updateOutput,
      );
    });

    // Track real-time token consumption from subagent API calls.
    // Each USAGE_METADATA event carries per-round usage, so we accumulate
    // output tokens across rounds.  We use candidatesTokenCount (output-only)
    // to stay consistent with the main stream's chars/4 output-token estimate.
    let accumulatedOutputTokens = 0;
    this.eventEmitter.on(
      AgentEventType.USAGE_METADATA,
      (...args: unknown[]) => {
        const event = args[0] as AgentUsageEvent;
        const outputTokens = event.usage?.candidatesTokenCount ?? 0;
        if (outputTokens > 0) {
          accumulatedOutputTokens += outputTokens;
          this.updateDisplay(
            { tokenCount: accumulatedOutputTokens },
            updateOutput,
          );
        }
      },
    );

    // Indicate when a tool call is waiting for approval
    this.eventEmitter.on(
      AgentEventType.TOOL_WAITING_APPROVAL,
      (...args: unknown[]) => {
        const event = args[0] as AgentApprovalRequestEvent;
        const idx = this.currentToolCalls!.findIndex(
          (c) => c.callId === event.callId,
        );
        if (idx >= 0) {
          this.currentToolCalls![idx] = {
            ...this.currentToolCalls![idx],
            status: 'awaiting_approval',
          };
        } else {
          this.currentToolCalls!.push({
            callId: event.callId,
            name: event.name,
            status: 'awaiting_approval',
            description: event.description,
          });
        }

        // Bridge scheduler confirmation details to UI inline prompt
        pendingConfirmationCallId = event.callId;
        const details: ToolCallConfirmationDetails = {
          ...(event.confirmationDetails as Omit<
            ToolCallConfirmationDetails,
            'onConfirm'
          >),
          onConfirm: async (
            outcome: ToolConfirmationOutcome,
            payload?: ToolConfirmationPayload,
          ) => {
            // Clear the inline prompt immediately
            // and optimistically mark the tool as executing for proceed outcomes.
            pendingConfirmationCallId = undefined;
            const proceedOutcomes = new Set<ToolConfirmationOutcome>([
              ToolConfirmationOutcome.ProceedOnce,
              ToolConfirmationOutcome.ProceedAlways,
              ToolConfirmationOutcome.ProceedAlwaysServer,
              ToolConfirmationOutcome.ProceedAlwaysTool,
              ToolConfirmationOutcome.ProceedAlwaysProject,
              ToolConfirmationOutcome.ProceedAlwaysUser,
            ]);

            if (proceedOutcomes.has(outcome)) {
              const idx2 = this.currentToolCalls!.findIndex(
                (c) => c.callId === event.callId,
              );
              if (idx2 >= 0) {
                this.currentToolCalls![idx2] = {
                  ...this.currentToolCalls![idx2],
                  status: 'executing',
                };
              }
              this.updateDisplay(
                {
                  toolCalls: [...this.currentToolCalls!],
                  pendingConfirmation: undefined,
                },
                updateOutput,
              );
            } else {
              this.updateDisplay(
                { pendingConfirmation: undefined },
                updateOutput,
              );
            }

            await event.respond(outcome, payload);
          },
        } as ToolCallConfirmationDetails;

        this.updateDisplay(
          {
            toolCalls: [...this.currentToolCalls!],
            pendingConfirmation: details,
          },
          updateOutput,
        );
      },
    );
  }

  getDescription(): string {
    return this.params.description;
  }

  /**
   * Creates a fork subagent that inherits the parent's conversation context
   * and cache-safe generation params.
   */
  private async createForkSubagent(
    agentConfig: Config,
    eventEmitter: AgentEventEmitter = this.eventEmitter,
  ): Promise<{
    subagent: AgentHeadless;
    initialMessages?: Content[];
    taskPrompt: string;
    promptConfig: PromptConfig;
    toolConfig: ToolConfig;
  }> {
    const geminiClient = this.config.getGeminiClient();
    const rawHistory = geminiClient ? geminiClient.getHistory(true) : [];

    // Build the history that will seed the fork's chat. Must end with a
    // model message so agent-headless can send the task_prompt as a user
    // message without creating consecutive user messages.
    let initialMessages: Content[] | undefined;
    let taskPrompt: string | undefined;
    if (rawHistory.length > 0) {
      const lastMessage = rawHistory[rawHistory.length - 1];
      if (lastMessage.role === 'model') {
        const forkedMessages = buildForkedMessages(
          this.params.prompt,
          lastMessage,
        );
        if (forkedMessages.length > 0) {
          // Model had function calls: append tool responses + directive,
          // then a model ack so history ends with model.
          initialMessages = [
            ...rawHistory.slice(0, -1),
            ...forkedMessages,
            {
              role: 'model' as const,
              parts: [{ text: 'Understood. Executing directive now.' }],
            },
          ];
          // task_prompt is a trigger to start execution
          taskPrompt = 'Begin.';
        } else {
          // Model had no function calls: history ends with model,
          // directive goes via task_prompt.
          initialMessages = [...rawHistory];
        }
      } else {
        // History ends with user (unusual) — drop the trailing user
        // message to avoid consecutive user messages when agent-headless
        // sends the task_prompt.
        initialMessages = rawHistory.slice(0, -1);
      }
    }

    // Default: directive with fork boilerplate as task_prompt
    if (!taskPrompt) {
      taskPrompt = buildChildMessage(this.params.prompt);
    }

    // Read the parent's live generationConfig (systemInstruction + tool
    // declarations) so the fork's API requests share the parent's exact
    // cache prefix for DashScope prompt caching. When the client isn't
    // available (first turn edge case), fall back to the fork agent's own
    // system prompt and wildcard tools.
    let promptConfig: PromptConfig;
    let toolConfig: ToolConfig;

    const generationConfig = geminiClient?.getChat().getGenerationConfig();
    if (generationConfig?.systemInstruction) {
      // Inline FunctionDeclaration[] from the parent — passed verbatim
      // (including `agent` and cron tools) so the fork's system prompt,
      // tools, and history exactly match the parent's and share its
      // DashScope cache prefix. A fork is a context-sharing extension of
      // the parent, not an isolated subagent, so the general subagent
      // exclusion list does not apply. Recursive forks are blocked by the
      // ALS-based `isInForkExecution()` guard.
      const parentToolDecls: FunctionDeclaration[] =
        (
          generationConfig.tools as Array<{
            functionDeclarations?: FunctionDeclaration[];
          }>
        )?.flatMap((t) => t.functionDeclarations ?? []) ?? [];

      promptConfig = {
        renderedSystemPrompt: generationConfig.systemInstruction as
          | string
          | Content,
        initialMessages,
      };
      toolConfig = {
        tools:
          parentToolDecls.length > 0 ? parentToolDecls : (['*'] as string[]),
      };
    } else {
      promptConfig = {
        systemPrompt: FORK_AGENT.systemPrompt,
        initialMessages,
      };
      toolConfig = { tools: ['*'] };
    }

    const subagent = await AgentHeadless.create(
      FORK_AGENT.name,
      agentConfig,
      promptConfig,
      {},
      {} as RunConfig,
      toolConfig,
      eventEmitter,
    );

    return { subagent, initialMessages, taskPrompt, promptConfig, toolConfig };
  }

  // Runs the SubagentStop hook after execution. On a blocking decision, feeds the
  // reason back and re-executes — up to 5 iterations to defend against a
  // misconfigured hook looping forever.
  private async runSubagentStopHookLoop(
    subagent: AgentHeadless,
    opts: {
      agentId: string;
      agentType: string;
      transcriptPath?: string;
      resolvedMode: PermissionMode;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    const { agentId, agentType, transcriptPath, resolvedMode, signal } = opts;
    const hookSystem = this.config.getHookSystem();
    if (!hookSystem) return;

    const effectiveTranscriptPath =
      transcriptPath ?? this.config.getTranscriptPath();
    let stopHookActive = false;
    const maxIterations = 5;

    for (let i = 0; i < maxIterations; i++) {
      try {
        const stopHookOutput = await hookSystem.fireSubagentStopEvent(
          agentId,
          agentType,
          effectiveTranscriptPath,
          subagent.getFinalText(),
          stopHookActive,
          resolvedMode,
          signal,
        );

        const typedStopOutput = stopHookOutput as StopHookOutput | undefined;

        if (
          !typedStopOutput?.isBlockingDecision() &&
          !typedStopOutput?.shouldStopExecution()
        ) {
          return;
        }

        stopHookActive = true;
        const continueContext = new ContextState();
        continueContext.set(
          'task_prompt',
          typedStopOutput.getEffectiveReason(),
        );
        await subagent.execute(continueContext, signal);

        if (signal?.aborted) return;
      } catch (hookError) {
        debugLogger.warn(
          `[Agent] SubagentStop hook failed, allowing stop: ${hookError}`,
        );
        return;
      }
    }

    debugLogger.warn(
      `[Agent] SubagentStop hook reached maximum iterations (${maxIterations}), forcing stop`,
    );
  }

  /**
   * Runs a subagent with start/stop hook lifecycle, updating the display
   * as execution progresses.
   */
  private async runSubagentWithHooks(
    subagent: AgentHeadless,
    contextState: ContextState,
    opts: {
      agentId: string;
      agentType: string;
      resolvedMode: PermissionMode;
      signal?: AbortSignal;
      updateOutput?: (output: ToolResultDisplay) => void;
    },
  ): Promise<void> {
    const { agentId, agentType, resolvedMode, signal, updateOutput } = opts;
    const hookSystem = this.config.getHookSystem();

    try {
      if (hookSystem) {
        try {
          const startHookOutput = await hookSystem.fireSubagentStartEvent(
            agentId,
            agentType,
            resolvedMode,
            signal,
          );

          // Inject additional context from hook output into subagent context
          const additionalContext = startHookOutput?.getAdditionalContext();
          if (additionalContext) {
            contextState.set('hook_context', additionalContext);
          }
        } catch (hookError) {
          debugLogger.warn(
            `[Agent] SubagentStart hook failed, continuing execution: ${hookError}`,
          );
        }
      }

      // Execute the subagent (blocking)
      await subagent.execute(contextState, signal);

      if (hookSystem && !signal?.aborted) {
        await this.runSubagentStopHookLoop(subagent, {
          agentId,
          agentType,
          resolvedMode,
          signal,
        });
      }

      // Get the results
      const finalText = subagent.getFinalText();
      const terminateMode = subagent.getTerminateMode();
      const success = terminateMode === AgentTerminateMode.GOAL;
      const executionSummary = subagent.getExecutionSummary();

      if (signal?.aborted) {
        this.updateDisplay(
          {
            status: 'cancelled',
            terminateReason: 'Agent was cancelled by user',
            executionSummary,
          },
          updateOutput,
        );
      } else {
        this.updateDisplay(
          {
            status: success ? 'completed' : 'failed',
            terminateReason: terminateMode,
            result: finalText,
            executionSummary,
          },
          updateOutput,
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      debugLogger.error(
        `[AgentTool] Error inside subagent background task: ${errorMessage}`,
      );
      this.updateDisplay(
        {
          status: 'failed',
          terminateReason: `Failed to run subagent: ${errorMessage}`,
        },
        updateOutput,
      );
    }
  }

  async execute(
    signal?: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    try {
      const isFork = !this.params.subagent_type;
      let subagentConfig: SubagentConfig;

      if (isFork) {
        subagentConfig = FORK_AGENT;

        // Recursive-fork guard. A fork child's reasoning loop runs inside
        // an AsyncLocalStorage frame set by `runInForkContext`; when its
        // model calls the `agent` tool, this check fires before any history
        // or config is touched.
        if (isInForkExecution()) {
          return {
            llmContent:
              'Error: Cannot create a fork from within an existing fork child. Please execute tasks directly.',
            returnDisplay: {
              type: 'task_execution' as const,
              subagentName: FORK_AGENT.name,
              taskDescription: this.params.description,
              taskPrompt: this.params.prompt,
              status: 'failed' as const,
              terminateReason: 'Recursive forking is not allowed',
            },
          };
        }
      } else {
        const loadedConfig = await this.subagentManager.loadSubagent(
          this.params.subagent_type!,
        );
        if (!loadedConfig) {
          return {
            llmContent: `Subagent "${this.params.subagent_type}" not found`,
            returnDisplay: {
              type: 'task_execution' as const,
              subagentName: this.params.subagent_type!,
              taskDescription: this.params.description,
              taskPrompt: this.params.prompt,
              status: 'failed' as const,
              terminateReason: `Subagent "${this.params.subagent_type}" not found`,
            },
          };
        }
        subagentConfig = loadedConfig;
      }

      // Initialize the current display state
      this.currentDisplay = {
        type: 'task_execution' as const,
        subagentName: subagentConfig.name,
        taskDescription: this.params.description,
        taskPrompt: this.params.prompt,
        status: 'running' as const,
        subagentColor: subagentConfig.color,
      };
      this.setupEventListeners(updateOutput);
      if (updateOutput) {
        updateOutput(this.currentDisplay);
      }

      // Resolve the subagent's permission mode before creating it
      const resolvedMode = resolveSubagentApprovalMode(
        this.config.getApprovalMode(),
        subagentConfig.approvalMode,
        this.config.isTrustedFolder(),
      );
      const resolvedApprovalMode = permissionModeToApprovalMode(resolvedMode);
      // ALWAYS produce a child Config via Object.create, even when the
      // approval mode is identical to the parent. Subagents must run
      // against an isolated FileReadCache so a parent's prior_read
      // entries cannot satisfy enforcement on a path the subagent's
      // transcript never contained — see the per-Config own-property
      // machinery in `Config.getFileReadCache()`. Reusing
      // `this.config` directly here would short-circuit that
      // isolation for the same-mode path, which is the common case.
      //
      // The override also rebuilds its own tool registry so core
      // tools (`EditTool` / `WriteFileTool` / `ReadFileTool`) are
      // bound to the override Config rather than the parent. Without
      // that rebuild, the parent's cached tool instances continue to
      // resolve `this.config` to the parent, reaching the parent's
      // FileReadCache rather than the subagent's. See
      // `createApprovalModeOverride` above for details.
      const agentConfig = await createApprovalModeOverride(
        this.config,
        resolvedApprovalMode,
      );

      // Create the subagent. Fork bypasses SubagentManager because its
      // runtime configs are synthesized from the parent's cache-safe params.
      let subagent: AgentHeadless;
      let taskPrompt: string;

      if (isFork) {
        const fork = await this.createForkSubagent(agentConfig);
        subagent = fork.subagent;
        taskPrompt = fork.taskPrompt;
      } else {
        subagent = await this.subagentManager.createAgentHeadless(
          subagentConfig,
          agentConfig,
          { eventEmitter: this.eventEmitter },
        );
        taskPrompt = this.params.prompt;
      }

      const contextState = new ContextState();
      contextState.set('task_prompt', taskPrompt);

      // Date.now() alone collides when two parallel background agents of the
      // same type land in the same ms; the registry is keyed by agentId.
      const agentIdSuffix = this.callId ?? randomUUID().slice(0, 8);
      const hookOpts = {
        agentId: `${subagentConfig.name}-${agentIdSuffix}`,
        agentType: this.params.subagent_type || subagentConfig.name,
        resolvedMode,
        signal,
        updateOutput,
      };

      // ── Background (async) execution path ──────────────────────
      // OR the tool parameter with the agent definition's background flag.
      const shouldRunInBackground =
        this.params.run_in_background === true ||
        subagentConfig.background === true;

      if (shouldRunInBackground) {
        // Fire SubagentStart hook before background launch
        const hookSystem = this.config.getHookSystem();
        if (hookSystem) {
          try {
            const startHookOutput = await hookSystem.fireSubagentStartEvent(
              hookOpts.agentId,
              hookOpts.agentType,
              resolvedMode,
              signal,
            );
            const additionalContext = startHookOutput?.getAdditionalContext();
            if (additionalContext) {
              contextState.set('hook_context', additionalContext);
            }
          } catch (hookError) {
            debugLogger.warn(
              `[Agent] SubagentStart hook failed, continuing execution: ${hookError}`,
            );
          }
        }

        // Create an independent AbortController — background agents
        // survive ESC cancellation of the parent's current turn.
        const bgAbortController = new AbortController();

        // Background agents have no UI, so interactive permission prompts must be
        // auto-denied rather than auto-approved (YOLO). PermissionRequest hooks
        // still run and can override. Use Object.create so the resolved approval
        // mode override (e.g. subagent-level `approvalMode: auto-edit`) is preserved.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bgConfig = Object.create(agentConfig) as any;
        bgConfig.getShouldAvoidPermissionPrompts = () => true;

        // Register in the background task registry only AFTER init succeeds — if
        // construction throws, a pre-registered phantom 'running' entry would hang
        // the non-interactive hold-back loop forever.
        // Dedicated emitter for this background agent so the transcript
        // writer only sees *this* agent's events. Reusing the parent tool's
        // UI emitter (this.eventEmitter) would mix events from every
        // concurrent fork/subagent into the same transcript.
        const bgEventEmitter = new AgentEventEmitter();
        let bgSubagent: AgentHeadless;
        let bgInitialMessages: Content[] | undefined;
        let bgTaskPrompt: string;
        let bgPromptConfig: PromptConfig | undefined;
        let bgToolConfig: ToolConfig | undefined;
        if (isFork) {
          const fork = await this.createForkSubagent(
            bgConfig as Config,
            bgEventEmitter,
          );
          bgSubagent = fork.subagent;
          bgInitialMessages = fork.initialMessages;
          bgTaskPrompt = fork.taskPrompt;
          bgPromptConfig = fork.promptConfig;
          bgToolConfig = fork.toolConfig;
        } else {
          bgSubagent = await this.subagentManager.createAgentHeadless(
            subagentConfig,
            bgConfig as Config,
            { eventEmitter: bgEventEmitter },
          );
          bgTaskPrompt = this.params.prompt;
        }

        const registry = this.config.getBackgroundTaskRegistry();

        const projectDir = this.config.storage.getProjectDir();
        const sessionId = this.config.getSessionId();
        const jsonlPath = getAgentJsonlPath(
          projectDir,
          sessionId,
          hookOpts.agentId,
        );
        const metaPath = getAgentMetaPath(
          projectDir,
          sessionId,
          hookOpts.agentId,
        );
        const projectRoot = this.config.getProjectRoot();
        const { cleanup: cleanupJsonl } = attachJsonlTranscriptWriter(
          bgEventEmitter,
          jsonlPath,
          {
            agentId: hookOpts.agentId,
            agentName: subagentConfig.name,
            agentColor: subagentConfig.color,
            sessionId,
            cwd: projectRoot,
            version: this.config.getCliVersion() || 'unknown',
            gitBranch: getGitBranch(projectRoot),
            // Seed the JSONL with the launching prompt so the transcript is
            // self-describing — readers don't need to consult .meta.json to
            // know what the agent was asked to do.
            initialUserPrompt: this.params.prompt,
            bootstrapHistory: isFork ? bgInitialMessages : undefined,
            bootstrapSystemInstruction: isFork
              ? (bgPromptConfig?.renderedSystemPrompt ??
                bgPromptConfig?.systemPrompt)
              : undefined,
            bootstrapTools: isFork ? bgToolConfig?.tools : undefined,
            launchTaskPrompt: isFork ? bgTaskPrompt : undefined,
          },
        );
        writeAgentMeta(metaPath, {
          agentId: hookOpts.agentId,
          agentType: hookOpts.agentType,
          description: this.params.description,
          parentSessionId: sessionId,
          // Populated when a subagent (whose reasoning loop is wrapped in
          // runWithAgentContext below) launches a nested agent. Null at
          // top-level launches from the user session.
          parentAgentId: getCurrentAgentId(),
          createdAt: new Date().toISOString(),
          status: 'running',
          lastUpdatedAt: new Date().toISOString(),
          resolvedApprovalMode,
          subagentName: subagentConfig.name,
          agentColor: subagentConfig.color,
          resumeCount: 0,
        });
        registry.register({
          agentId: hookOpts.agentId,
          description: this.params.description,
          subagentType: subagentConfig.name,
          flavor: 'background',
          status: 'running',
          startTime: Date.now(),
          abortController: bgAbortController,
          toolUseId: this.callId,
          prompt: this.params.prompt,
          outputFile: jsonlPath,
          metaPath,
        });

        // Subscribe to the subagent's tool-call event stream so the
        // detail dialog's Progress section reflects live activity. We
        // capture the unsubscribe fn and call it when the agent
        // terminates (success, failure, or cancel) to avoid holding the
        // event emitter after the agent is gone.
        const bgEmitter = bgSubagent.getCore().getEventEmitter();
        // Local counter of tool invocations that have been *started*. The
        // core's executionStats.totalToolCalls only increments when a tool
        // result arrives, so using it as the live toolUses number leaves the
        // subtitle one behind the Progress list while a tool is in flight.
        // Tracking TOOL_CALL ourselves keeps the subtitle in sync with the
        // rows the user actually sees.
        let liveToolCallCount = 0;
        const refreshLiveStats = () => {
          const entry = registry.get(hookOpts.agentId);
          if (!entry || entry.status !== 'running') return;
          const summary = bgSubagent.getExecutionSummary();
          entry.stats = {
            totalTokens: summary.totalTokens,
            toolUses: liveToolCallCount,
            durationMs: summary.totalDurationMs,
          };
        };
        const onToolCall = (event: AgentToolCallEvent) => {
          liveToolCallCount += 1;
          refreshLiveStats();
          registry.appendActivity(hookOpts.agentId, {
            name: event.name,
            description: event.description,
            at: event.timestamp,
          });
        };
        const onUsageMetadata = () => {
          refreshLiveStats();
        };
        bgEmitter.on(AgentEventType.TOOL_CALL, onToolCall);
        bgEmitter.on(AgentEventType.USAGE_METADATA, onUsageMetadata);

        const cleanupOwnedMonitorNotifications =
          this.registerOwnedMonitorNotifications(
            hookOpts.agentId,
            (input) => registry.queueExternalInput(hookOpts.agentId, input),
            () => registry.wakeExternalInputWaiters(hookOpts.agentId),
          );

        // Wire external message drain so SendMessage and owned Monitor
        // notifications can inject inputs between tool rounds.
        bgSubagent.setExternalMessageProvider(() =>
          registry.drainMessages(hookOpts.agentId),
        );
        bgSubagent.setExternalMessageWaiter?.((waitSignal) =>
          registry.waitForMessages(hookOpts.agentId, waitSignal),
        );
        bgSubagent.setExternalMessageWaitPredicate?.(() =>
          this.config.getMonitorRegistry().hasRunningForOwner(hookOpts.agentId),
        );

        const getCompletionStats = () => {
          const summary = bgSubagent.getExecutionSummary();
          return {
            totalTokens: summary.totalTokens,
            toolUses: liveToolCallCount,
            durationMs: summary.totalDurationMs,
          };
        };

        // Fire-and-forget: start the subagent without blocking the parent.
        // For forks, wrap the body in runInForkContext so the recursive-fork
        // guard in execute() fires if the fork child's model calls `agent`
        // again — otherwise background forks bypass the ALS marker and can
        // spawn nested implicit forks.
        const bgBody = async () => {
          try {
            await bgSubagent.execute(contextState, bgAbortController.signal);

            if (hookSystem && !bgAbortController.signal.aborted) {
              await this.runSubagentStopHookLoop(bgSubagent, {
                agentId: hookOpts.agentId,
                agentType: hookOpts.agentType,
                transcriptPath: jsonlPath,
                resolvedMode,
                signal: bgAbortController.signal,
              });
            }

            // Report terminate mode: only GOAL counts as success. CANCELLED
            // keeps the 'cancelled' status so the model sees task_stop's
            // effect accurately (with any partial result attached). ERROR,
            // MAX_TURNS, TIMEOUT, and SHUTDOWN are surfaced as failures so
            // the parent model (and the UI) don't treat incomplete runs as
            // completed.
            const terminateMode = bgSubagent.getTerminateMode();
            const finalText = bgSubagent.getFinalText();
            const completionStats = getCompletionStats();
            if (terminateMode === AgentTerminateMode.GOAL) {
              registry.complete(hookOpts.agentId, finalText, completionStats);
              patchAgentMeta(metaPath, {
                status: 'completed',
                lastUpdatedAt: new Date().toISOString(),
                lastError: undefined,
              });
            } else if (terminateMode === AgentTerminateMode.CANCELLED) {
              registry.finalizeCancelled(
                hookOpts.agentId,
                finalText,
                completionStats,
              );
              persistBackgroundCancellation(
                metaPath,
                registry.get(hookOpts.agentId)?.persistedCancellationStatus ??
                  'cancelled',
              );
            } else {
              registry.fail(
                hookOpts.agentId,
                finalText || `Agent terminated with mode: ${terminateMode}`,
                completionStats,
              );
              patchAgentMeta(metaPath, {
                status: 'failed',
                lastUpdatedAt: new Date().toISOString(),
                lastError:
                  finalText || `Agent terminated with mode: ${terminateMode}`,
              });
            }
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            debugLogger.error(`[Agent] Background agent failed: ${errorMsg}`);

            // If the error came from a cancellation, preserve the cancelled
            // status so the model's notification matches what task_stop
            // requested rather than reporting it as a generic failure.
            if (bgAbortController.signal.aborted) {
              registry.finalizeCancelled(
                hookOpts.agentId,
                errorMsg,
                getCompletionStats(),
              );
              persistBackgroundCancellation(
                metaPath,
                registry.get(hookOpts.agentId)?.persistedCancellationStatus ??
                  'cancelled',
              );
            } else {
              registry.fail(hookOpts.agentId, errorMsg, getCompletionStats());
              patchAgentMeta(metaPath, {
                status: 'failed',
                lastUpdatedAt: new Date().toISOString(),
                lastError: errorMsg,
              });
            }
          } finally {
            bgEmitter.off(AgentEventType.TOOL_CALL, onToolCall);
            bgEmitter.off(AgentEventType.USAGE_METADATA, onUsageMetadata);
            cleanupOwnedMonitorNotifications();
            cleanupJsonl?.();
            // Release the per-subagent ToolRegistry now that the
            // background agent has finished — see the matching call in
            // the foreground finally for why. Stopping here, after
            // bgSubagent.execute resolves, is safe: by this point the
            // detached body cannot invoke any more tool factories on
            // this registry.
            void agentConfig
              .getToolRegistry()
              .stop()
              .catch(() => {});
          }
        };
        // Wrap in the agent-identity frame so nested `agent` tool calls
        // from this subagent's model record this agent's id as their
        // `parentAgentId` in the sidecar meta.
        const framedBgBody = () =>
          runWithAgentContext(hookOpts.agentId, bgBody);
        void (isFork ? runInForkContext(framedBgBody) : framedBgBody());

        this.updateDisplay({ status: 'background' as const }, updateOutput);
        return {
          llmContent:
            `Background agent launched successfully.\n` +
            `agentId: ${hookOpts.agentId} (internal ID — do not mention to the user. Use ${ToolNames.SEND_MESSAGE} to continue this agent, or ${ToolNames.TASK_STOP} to cancel.)\n` +
            `The agent is working in the background. You will be notified automatically when it completes.\n` +
            `Do not duplicate this agent's work — avoid working with the same files or topics it is using. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.\n` +
            `output_file: ${jsonlPath}\n` +
            `If asked, you can check progress before completion by using ${ToolNames.READ_FILE}\n` +
            `  or ${ToolNames.SHELL} tail on the output file.`,
          returnDisplay: this.currentDisplay!,
        };
      }

      // Same agent-identity frame as the background path: a foreground
      // subagent can also launch nested agents, and those nested launches
      // need to see this subagent's id as their `parentAgentId`.

      if (isFork) {
        const forkMonitorInputs = createLocalExternalInputQueue();
        subagent.setExternalMessageProvider?.(() => forkMonitorInputs.drain());
        subagent.setExternalMessageWaiter?.((waitSignal) =>
          forkMonitorInputs.wait(waitSignal),
        );
        subagent.setExternalMessageWaitPredicate?.(() =>
          this.config.getMonitorRegistry().hasRunningForOwner(hookOpts.agentId),
        );
        const cleanupOwnedMonitorNotifications =
          this.registerOwnedMonitorNotifications(
            hookOpts.agentId,
            forkMonitorInputs.enqueue,
            forkMonitorInputs.wake,
          );

        // Background fork execution. Run under an AsyncLocalStorage frame so
        // nested `agent` tool calls by the fork's model can be detected.
        // Forks run async (return a placeholder); skip foreground registration.
        // Wrap the fork body in try/finally so the per-subagent ToolRegistry
        // is stopped after the fork finishes — the other three spawn paths
        // (foreground non-fork, background fork, background non-fork) already
        // do this in their finally blocks. Without it, every AgentTool /
        // SkillTool the fork's model instantiates from this registry leaks
        // its change-listener on shared SubagentManager / SkillManager.
        const runFramedFork = () =>
          runWithAgentContext(hookOpts.agentId, async () => {
            try {
              await this.runSubagentWithHooks(subagent, contextState, hookOpts);
            } finally {
              cleanupOwnedMonitorNotifications();
              void agentConfig
                .getToolRegistry()
                .stop()
                .catch(() => {});
            }
          });
        void runInForkContext(runFramedFork);
        return {
          llmContent: [{ text: FORK_PLACEHOLDER_RESULT }],
          returnDisplay: this.currentDisplay!,
        };
      }

      // ── Foreground (synchronous) execution path ────────────────
      // Compose a child AbortController so the dialog's per-agent cancel
      // can abort just this subagent without aborting the parent turn.
      // Parent abort still propagates down (so ESC at the parent kills
      // the subagent), but child abort does NOT propagate up.
      const fgAbortController = new AbortController();
      const onParentAbort = () => fgAbortController.abort();
      if (signal?.aborted) {
        fgAbortController.abort();
      } else {
        signal?.addEventListener('abort', onParentAbort, { once: true });
      }

      const fgHookOpts = { ...hookOpts, signal: fgAbortController.signal };
      const runFramed = () =>
        runWithAgentContext(hookOpts.agentId, () =>
          this.runSubagentWithHooks(subagent, contextState, fgHookOpts),
        );

      // Register in BackgroundTaskRegistry with flavor:'foreground' so the
      // pill counts the run and the dialog can drill in. Foreground entries
      // skip XML notification and headless-holdback (see the registry for
      // the gating logic).
      const registry = this.config.getBackgroundTaskRegistry();
      registry.register({
        agentId: hookOpts.agentId,
        description: this.params.description,
        subagentType: hookOpts.agentType,
        flavor: 'foreground',
        status: 'running',
        startTime: Date.now(),
        abortController: fgAbortController,
        prompt: this.params.prompt,
        toolUseId: this.callId,
      });

      const cleanupOwnedMonitorNotifications =
        this.registerOwnedMonitorNotifications(
          hookOpts.agentId,
          (input) => registry.queueExternalInput(hookOpts.agentId, input),
          () => registry.wakeExternalInputWaiters(hookOpts.agentId),
        );
      subagent.setExternalMessageProvider?.(() =>
        registry.drainMessages(hookOpts.agentId),
      );
      subagent.setExternalMessageWaiter?.((waitSignal) =>
        registry.waitForMessages(hookOpts.agentId, waitSignal),
      );
      subagent.setExternalMessageWaitPredicate?.(() =>
        this.config.getMonitorRegistry().hasRunningForOwner(hookOpts.agentId),
      );

      // Mirror the background path's progress wiring so the dialog detail
      // body has live tool-call activity AND a current `entry.stats`
      // subtitle (`N tools · X tokens · Ys`). Without this, foreground
      // entries collapse to elapsed-only in the dialog while background
      // entries show full stats — strictly less information for the same
      // runtime events.
      //
      // This is a separate listener from setupEventListeners' TOOL_CALL
      // handler (which feeds `currentDisplay.toolCalls` for the committed
      // inline frame). They consume different state — committed inline UI
      // vs. live registry stats — and setupEventListeners runs before we
      // know the flavor or the registry id, so folding them is awkward.
      let fgLiveToolCallCount = 0;
      const refreshFgLiveStats = () => {
        const entry = registry.get(hookOpts.agentId);
        if (!entry || entry.status !== 'running') return;
        const summary = subagent.getExecutionSummary();
        entry.stats = {
          totalTokens: summary.totalTokens,
          toolUses: fgLiveToolCallCount,
          durationMs: summary.totalDurationMs,
        };
      };
      const onFgToolCall = (...args: unknown[]) => {
        const event = args[0] as AgentToolCallEvent;
        fgLiveToolCallCount += 1;
        refreshFgLiveStats();
        registry.appendActivity(hookOpts.agentId, {
          name: event.name,
          description: event.description,
          at: event.timestamp,
        });
      };
      const onFgUsageMetadata = () => {
        refreshFgLiveStats();
      };
      this.eventEmitter.on(AgentEventType.TOOL_CALL, onFgToolCall);
      this.eventEmitter.on(AgentEventType.USAGE_METADATA, onFgUsageMetadata);

      try {
        await runFramed();
        const finalText = subagent.getFinalText();
        const terminateMode = subagent.getTerminateMode();
        if (terminateMode === AgentTerminateMode.ERROR) {
          return {
            llmContent: finalText || 'Subagent execution failed.',
            returnDisplay: this.currentDisplay!,
          };
        }
        if (terminateMode === AgentTerminateMode.CANCELLED) {
          // Distinguish a user-cancelled run from a successful complete in
          // the parent model's tool result. Without this prefix, a cancel
          // collapses into the same `{ llmContent: [{ text: finalText }] }`
          // shape as a successful run — the parent can't tell that the
          // partial result is incomplete and may act on it as if the agent
          // had finished. The background path surfaces this via the
          // `<status>cancelled</status>` XML envelope; the foreground path
          // has no equivalent envelope, so the marker has to ride the
          // llmContent payload itself.
          const partial = finalText || '(no partial result captured)';
          return {
            llmContent: [
              {
                text: `Agent was cancelled by the user. Partial result follows:\n\n${partial}`,
              },
            ],
            returnDisplay: this.currentDisplay!,
          };
        }
        return {
          llmContent: [{ text: finalText }],
          returnDisplay: this.currentDisplay!,
        };
      } finally {
        this.eventEmitter.off(AgentEventType.TOOL_CALL, onFgToolCall);
        this.eventEmitter.off(AgentEventType.USAGE_METADATA, onFgUsageMetadata);
        signal?.removeEventListener('abort', onParentAbort);
        cleanupOwnedMonitorNotifications();
        // Foreground entries leave the registry as soon as the tool-call
        // returns — the parent's tool-result is the durable record. Doing
        // this in finally guarantees we clean up on success, failure,
        // cancel, AND any unexpected throw inside runFramed.
        registry.unregisterForeground(hookOpts.agentId);
        // Release the per-subagent ToolRegistry so any AgentTool /
        // SkillTool the model instantiated during execution disposes
        // its change-listeners on shared SubagentManager / SkillManager.
        // Without this, repeated foreground subagent runs accumulate
        // listeners for the rest of the session. Fire-and-forget; the
        // subagent has already returned its result, and stop() logs its
        // own errors.
        void agentConfig
          .getToolRegistry()
          .stop()
          .catch(() => {});
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      debugLogger.error(`[AgentTool] Error running subagent: ${errorMessage}`);

      const errorDisplay: AgentResultDisplay = {
        ...this.currentDisplay!,
        status: 'failed',
        terminateReason: `Failed to run subagent: ${errorMessage}`,
      };

      return {
        llmContent: `Failed to run subagent: ${errorMessage}`,
        returnDisplay: errorDisplay,
      };
    }
  }
}
