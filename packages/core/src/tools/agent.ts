/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { InvalidStreamError } from '../core/geminiChat.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type {
  ToolResult,
  ToolResultDisplay,
  AgentResultDisplay,
} from './tools.js';
import { ToolConfirmationOutcome } from './tools.js';
import type {
  ToolCallConfirmationDetails,
  ToolConfirmationPayload,
} from './tools.js';
import type { Config } from '../config/config.js';
import type { SubagentManager } from '../subagents/subagent-manager.js';
import type { SubagentConfig } from '../subagents/types.js';
import { AgentTerminateMode } from '../agents/runtime/agent-types.js';
import { ContextState } from '../agents/runtime/agent-headless.js';
import {
  AgentEventEmitter,
  AgentEventType,
} from '../agents/runtime/agent-events.js';
import type {
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentFinishEvent,
  AgentErrorEvent,
  AgentApprovalRequestEvent,
} from '../agents/runtime/agent-events.js';
import { BuiltinAgentRegistry } from '../subagents/builtin-agents.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { PermissionMode } from '../hooks/types.js';
import type { StopHookOutput } from '../hooks/types.js';
import { ApprovalMode } from '../config/config.js';

export interface AgentParams {
  description: string;
  prompt: string;
  subagent_type: string;
}

const debugLogger = createDebugLogger('AGENT');

// ---------------------------------------------------------------------------
// Subagent-level retry configuration for transient stream errors
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS:
// GeminiChat already retries InvalidStreamError up to 2 times internally
// (see INVALID_STREAM_RETRY_CONFIG in geminiChat.ts). However, commands like
// /review fan out many subagents concurrently against the same DashScope
// endpoint. Under high fan-out, the probability that at least one subagent
// exhausts all internal retries rises sharply (P(any fail) = 1 − (1−p)^N
// where p is the single-agent failure probability and N is the concurrency).
//
// This additional retry layer wraps the entire subagent execution so that a
// transient stream glitch — after GeminiChat's internal budget is spent —
// does not permanently fail the subagent and cascade into a partial /review
// result. Only InvalidStreamError (NO_FINISH_REASON, NO_RESPONSE_TEXT)
// triggers these retries; all other errors propagate immediately.
//
// Backoff: exponential with 0–25% additive jitter, inspired by claude-code's
// withRetry.ts pattern (prevents thundering-herd on shared endpoints).
// ---------------------------------------------------------------------------
const SUBAGENT_STREAM_RETRY_CONFIG = {
  /** Maximum number of retry attempts (on top of the initial attempt). */
  maxRetries: 3,
  /**
   * Base delay in milliseconds; doubles each retry.
   *
   * Set to 5 s (not 1 s) because production traces show DashScope
   * NO_FINISH_REASON storms lasting 2–3 minutes under high concurrency.
   * Short backoffs (1–2 s) just pile more requests onto an already degraded
   * endpoint. A 5 s base gives the provider meaningful breathing room while
   * each subagent still completes within ~40 s total retry budget.
   *
   * Progression: 5 s → 10 s → 20 s  (+ 0–25 % jitter each)
   */
  baseDelayMs: 5000,
  /** Ceiling for the exponential delay (before jitter is added). */
  maxDelayMs: 30000,
} as const;

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
 * Creates a Config override with a different approval mode.
 * Uses prototype delegation to avoid mutating the parent config.
 */
function createApprovalModeOverride(base: Config, mode: ApprovalMode): Config {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const override = Object.create(base) as any;
  override.getApprovalMode = (): ApprovalMode => mode;
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
      },
      required: ['description', 'prompt', 'subagent_type'],
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

    if (
      !params.subagent_type ||
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

  constructor(
    private readonly config: Config,
    private readonly subagentManager: SubagentManager,
    params: AgentParams,
  ) {
    super(params);
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

  async execute(
    signal?: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    try {
      // Load the subagent configuration
      const subagentConfig = await this.subagentManager.loadSubagent(
        this.params.subagent_type,
      );

      if (!subagentConfig) {
        const errorDisplay = {
          type: 'task_execution' as const,
          subagentName: this.params.subagent_type,
          taskDescription: this.params.description,
          taskPrompt: this.params.prompt,
          status: 'failed' as const,
          terminateReason: `Subagent "${this.params.subagent_type}" not found`,
        };

        return {
          llmContent: `Subagent "${this.params.subagent_type}" not found`,
          returnDisplay: errorDisplay,
        };
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

      // Set up event listeners for real-time updates
      this.setupEventListeners(updateOutput);

      // Send initial display
      if (updateOutput) {
        updateOutput(this.currentDisplay);
      }
      // Resolve the subagent's permission mode before creating it
      const resolvedMode = resolveSubagentApprovalMode(
        this.config.getApprovalMode(),
        subagentConfig.approvalMode,
        this.config.isTrustedFolder(),
      );

      // Create a config override with the resolved approval mode so the
      // subagent's tool scheduler uses the correct mode for permission checks.
      const resolvedApprovalMode = permissionModeToApprovalMode(resolvedMode);
      const agentConfig =
        resolvedApprovalMode !== this.config.getApprovalMode()
          ? createApprovalModeOverride(this.config, resolvedApprovalMode)
          : this.config;

      const subagent = await this.subagentManager.createAgentHeadless(
        subagentConfig,
        agentConfig,
        { eventEmitter: this.eventEmitter },
      );

      // Create context state with the task prompt
      const contextState = new ContextState();
      contextState.set('task_prompt', this.params.prompt);

      // Fire SubagentStart hook before execution
      const hookSystem = this.config.getHookSystem();
      const agentId = `${subagentConfig.name}-${Date.now()}`;
      const agentType = this.params.subagent_type;

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

      // Execute the subagent (blocking) with retry for transient stream errors.
      //
      // GeminiChat retries InvalidStreamError 2× internally, but under high
      // concurrency (/review spawns many subagents) the probability that ALL
      // internal retries fail rises. This outer retry provides an additional
      // safety net — it re-invokes subagent.execute(), which creates a fresh
      // chat session, while the event listeners on `this.eventEmitter` are
      // already wired up and will handle START/ERROR/FINISH events from each
      // attempt naturally (START resets display to 'running').
      await this.executeSubagentWithRetry(subagent, contextState, signal);

      // Fire SubagentStop hook after execution and handle block decisions
      if (hookSystem && !signal?.aborted) {
        const transcriptPath = this.config.getTranscriptPath();
        let stopHookActive = false;

        // Loop to handle "block" decisions (prevent subagent from stopping)
        let continueExecution = true;
        let iterationCount = 0;
        const maxIterations = 5; // Prevent infinite loops from hook misconfigurations

        while (continueExecution) {
          iterationCount++;

          // Safety check to prevent infinite loops
          if (iterationCount >= maxIterations) {
            debugLogger.warn(
              `[TaskTool] SubagentStop hook reached maximum iterations (${maxIterations}), forcing stop to prevent infinite loop`,
            );
            continueExecution = false;
            break;
          }

          try {
            const stopHookOutput = await hookSystem.fireSubagentStopEvent(
              agentId,
              agentType,
              transcriptPath,
              subagent.getFinalText(),
              stopHookActive,
              resolvedMode,
              signal,
            );

            const typedStopOutput = stopHookOutput as
              | StopHookOutput
              | undefined;

            if (
              typedStopOutput?.isBlockingDecision() ||
              typedStopOutput?.shouldStopExecution()
            ) {
              // Feed the reason back to the subagent and continue execution
              const continueReason = typedStopOutput.getEffectiveReason();
              stopHookActive = true;

              const continueContext = new ContextState();
              continueContext.set('task_prompt', continueReason);
              await subagent.execute(continueContext, signal);

              if (signal?.aborted) {
                continueExecution = false;
              }
              // Loop continues to re-check SubagentStop hook
            } else {
              continueExecution = false;
            }
          } catch (hookError) {
            debugLogger.warn(
              `[TaskTool] SubagentStop hook failed, allowing stop: ${hookError}`,
            );
            continueExecution = false;
          }
        }
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

      return {
        llmContent: [{ text: finalText }],
        returnDisplay: this.currentDisplay!,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Distinguish transient stream errors (retries exhausted) from other
      // failures so that debug logs clearly indicate whether the retry budget
      // was consumed. The actual retry count is attached by
      // executeSubagentWithRetry() for accurate reporting.
      const isStreamError = error instanceof InvalidStreamError;
      const actualRetries = isStreamError
        ? ((error as InvalidStreamError & { retriesAttempted?: number })
            .retriesAttempted ?? 0)
        : 0;
      const retryNote = isStreamError
        ? ` (after ${actualRetries} ${actualRetries === 1 ? 'retry' : 'retries'})`
        : '';
      debugLogger.error(
        `[AgentTool] Error running subagent${retryNote}: ${errorMessage}`,
      );

      const errorDisplay: AgentResultDisplay = {
        ...this.currentDisplay!,
        status: 'failed',
        terminateReason: `Failed to run subagent${retryNote}: ${errorMessage}`,
      };

      return {
        llmContent: `Failed to run subagent${retryNote}: ${errorMessage}`,
        returnDisplay: errorDisplay,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Subagent execution with retry for transient InvalidStreamError
  // ---------------------------------------------------------------------------

  /**
   * Wraps `subagent.execute()` with retry logic for transient stream errors.
   *
   * Only `InvalidStreamError` (NO_FINISH_REASON, NO_RESPONSE_TEXT) triggers a
   * retry. All other errors — configuration, abort, permission, etc. — are
   * immediately re-thrown.
   *
   * Each retry re-invokes `subagent.execute()`, which internally creates a
   * fresh chat session and abort controller. The event listeners already set
   * up on `this.eventEmitter` receive START/FINISH events from each attempt,
   * keeping the display in sync.
   *
   * Backoff: exponential with 0–25% additive jitter.
   *   delay = min(baseDelayMs × 2^(attempt−1), maxDelayMs) + random(0, 25%)
   *
   * @param subagent - The headless subagent instance to execute.
   * @param contextState - Task context passed to each execution attempt.
   * @param signal - Optional abort signal; checked before each retry.
   */
  private async executeSubagentWithRetry(
    subagent: {
      execute: (ctx: ContextState, sig?: AbortSignal) => Promise<void>;
    },
    contextState: ContextState,
    signal?: AbortSignal,
  ): Promise<void> {
    const { maxRetries, baseDelayMs, maxDelayMs } =
      SUBAGENT_STREAM_RETRY_CONFIG;

    let lastError: InvalidStreamError | undefined;
    let retriesAttempted = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // --- Pre-retry wait (skipped for the initial attempt) ----------------
      if (attempt > 0) {
        retriesAttempted = attempt;

        if (signal?.aborted) {
          throw lastError!;
        }

        // Exponential backoff capped at maxDelayMs
        const exponentialDelay = Math.min(
          baseDelayMs * Math.pow(2, attempt - 1),
          maxDelayMs,
        );
        // Additive jitter: 0–25% of the computed delay to prevent
        // thundering-herd when many subagents retry against the same endpoint
        const jitter = Math.random() * 0.25 * exponentialDelay;
        const totalDelayMs = Math.round(exponentialDelay + jitter);

        debugLogger.warn(
          `[AgentTool] Transient stream error (${lastError!.type}), ` +
            `retry ${attempt}/${maxRetries} in ${totalDelayMs}ms`,
        );

        // Clear stale tool-call records from the failed attempt so the UI
        // does not show zombie entries from the previous execution run.
        this.currentToolCalls = [];

        // Abort-aware sleep: resolves early if the signal fires during the
        // backoff window, so the user does not wait the full delay after
        // cancelling.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, totalDelayMs);
          if (signal) {
            const onAbort = () => {
              clearTimeout(timer);
              resolve();
            };
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });

        // Re-check abort after sleeping — the user may have cancelled while
        // we were waiting.
        if (signal?.aborted) {
          throw lastError!;
        }
      }

      // --- Execute attempt --------------------------------------------------
      try {
        await subagent.execute(contextState, signal);
        return; // Success — exit the retry loop
      } catch (error) {
        if (error instanceof InvalidStreamError) {
          // Transient stream error — eligible for retry
          lastError = error;
          continue;
        }
        // Non-transient error — propagate immediately without consuming
        // retry budget (e.g. abort, config error, permission denied).
        throw error;
      }
    }

    // All retry attempts exhausted — attach the actual attempt count so the
    // outer catch block can produce an accurate error message.
    (
      lastError as InvalidStreamError & { retriesAttempted?: number }
    ).retriesAttempted = retriesAttempted;
    throw lastError!;
  }
}
