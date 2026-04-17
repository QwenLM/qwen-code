/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

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
  AgentEventEmitter,
  AgentEventType,
} from '../../agents/runtime/agent-events.js';
import type {
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentFinishEvent,
  AgentErrorEvent,
  AgentApprovalRequestEvent,
} from '../../agents/runtime/agent-events.js';
import { BuiltinAgentRegistry } from '../../subagents/builtin-agents.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { PermissionMode } from '../../hooks/types.js';
import type { StopHookOutput } from '../../hooks/types.js';
import { ApprovalMode } from '../../config/config.js';

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

  /**
   * Invoked by the tool scheduler after `build` to link this invocation
   * back to the model's original tool-use request. Used so background
   * agents carry the tool-use id through to completion notifications.
   */
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

  /**
   * Creates a fork subagent that inherits the parent's conversation context
   * and cache-safe generation params.
   */
  private async createForkSubagent(agentConfig: Config): Promise<{
    subagent: AgentHeadless;
    taskPrompt: string;
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
      this.eventEmitter,
    );

    return { subagent, taskPrompt };
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
      const agentConfig =
        resolvedApprovalMode !== this.config.getApprovalMode()
          ? createApprovalModeOverride(this.config, resolvedApprovalMode)
          : this.config;

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

      const hookOpts = {
        agentId: `${subagentConfig.name}-${Date.now()}`,
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

        // Background agents can't show interactive permission prompts
        // (no UI). Instead of YOLO (which would auto-approve everything),
        // we set shouldAvoidPermissionPrompts so the tool scheduler
        // auto-denies 'ask' decisions — matching claw-code's approach.
        // PermissionRequest hooks still run and can override the denial.
        // Base on agentConfig so the resolved approval mode override (e.g.
        // subagent-level `approvalMode: auto-edit`) is preserved.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bgConfig = Object.create(agentConfig) as any;
        bgConfig.getShouldAvoidPermissionPrompts = () => true;

        // Rebuild the subagent against bgConfig. For forks, go through
        // createForkSubagent so the parent's rendered system prompt and
        // inherited history are carried over; otherwise the background fork
        // degrades to a plain FORK_AGENT without context.
        //
        // Register in the background task registry only AFTER init
        // succeeds. If construction throws (e.g. invalid agent config or
        // model setup), registering first would leave a phantom 'running'
        // entry that the non-interactive hold-back loop would wait on
        // forever.
        let bgSubagent: AgentHeadless;
        if (isFork) {
          const fork = await this.createForkSubagent(bgConfig as Config);
          bgSubagent = fork.subagent;
        } else {
          bgSubagent = await this.subagentManager.createAgentHeadless(
            subagentConfig,
            bgConfig as Config,
          );
        }

        const registry = this.config.getBackgroundTaskRegistry();
        registry.register({
          agentId: hookOpts.agentId,
          description: this.params.description,
          subagentType: subagentConfig.name,
          status: 'running',
          startTime: Date.now(),
          abortController: bgAbortController,
          toolUseId: this.callId,
        });

        const getCompletionStats = () => {
          const summary = bgSubagent.getExecutionSummary();
          return {
            totalTokens: summary.totalTokens,
            toolUses: summary.totalToolCalls,
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

            // Fire SubagentStop hook with blocking-decision loop (mirrors
            // foreground runSubagentWithHooks): if the hook blocks, feed the
            // reason back and re-execute up to maxIterations times.
            if (hookSystem && !bgAbortController.signal.aborted) {
              const transcriptPath = this.config.getTranscriptPath();
              let stopHookActive = false;
              let continueExecution = true;
              let iterationCount = 0;
              const maxIterations = 5;

              while (continueExecution) {
                iterationCount++;
                if (iterationCount >= maxIterations) {
                  debugLogger.warn(
                    `[Agent] Background SubagentStop hook reached maximum iterations (${maxIterations}), forcing stop`,
                  );
                  break;
                }

                try {
                  const stopHookOutput = await hookSystem.fireSubagentStopEvent(
                    hookOpts.agentId,
                    hookOpts.agentType,
                    transcriptPath,
                    bgSubagent.getFinalText(),
                    stopHookActive,
                    resolvedMode,
                    bgAbortController.signal,
                  );

                  const typedStopOutput = stopHookOutput as
                    | StopHookOutput
                    | undefined;

                  if (
                    typedStopOutput?.isBlockingDecision() ||
                    typedStopOutput?.shouldStopExecution()
                  ) {
                    const continueReason = typedStopOutput.getEffectiveReason();
                    stopHookActive = true;

                    const continueContext = new ContextState();
                    continueContext.set('task_prompt', continueReason);
                    await bgSubagent.execute(
                      continueContext,
                      bgAbortController.signal,
                    );

                    if (bgAbortController.signal.aborted) {
                      continueExecution = false;
                    }
                  } else {
                    continueExecution = false;
                  }
                } catch (hookError) {
                  debugLogger.warn(
                    `[Agent] Background SubagentStop hook failed, allowing stop: ${hookError}`,
                  );
                  continueExecution = false;
                }
              }
            }

            // Report terminate mode: only GOAL counts as success. ERROR,
            // MAX_TURNS, and TIMEOUT are surfaced as failures so the parent
            // model (and the UI) don't treat incomplete runs as completed.
            const terminateMode = bgSubagent.getTerminateMode();
            const finalText = bgSubagent.getFinalText();
            const completionStats = getCompletionStats();
            if (terminateMode === AgentTerminateMode.GOAL) {
              registry.complete(hookOpts.agentId, finalText, completionStats);
            } else {
              registry.fail(
                hookOpts.agentId,
                finalText || `Agent terminated with mode: ${terminateMode}`,
                completionStats,
              );
            }
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            debugLogger.error(`[Agent] Background agent failed: ${errorMsg}`);

            registry.fail(hookOpts.agentId, errorMsg, getCompletionStats());
          }
        };
        void (isFork ? runInForkContext(bgBody) : bgBody());

        this.updateDisplay({ status: 'background' as const }, updateOutput);
        return {
          llmContent: `Background agent launched: "${this.params.description}" (ID: ${hookOpts.agentId}). You will be notified when it completes.`,
          returnDisplay: this.currentDisplay!,
        };
      }

      if (isFork) {
        // Background fork execution. Run under an AsyncLocalStorage frame so
        // nested `agent` tool calls by the fork's model can be detected.
        void runInForkContext(() =>
          this.runSubagentWithHooks(subagent, contextState, hookOpts),
        );
        return {
          llmContent: [{ text: FORK_PLACEHOLDER_RESULT }],
          returnDisplay: this.currentDisplay!,
        };
      } else {
        await this.runSubagentWithHooks(subagent, contextState, hookOpts);
        const finalText = subagent.getFinalText();
        const terminateMode = subagent.getTerminateMode();
        if (terminateMode === AgentTerminateMode.ERROR) {
          return {
            llmContent: finalText || 'Subagent execution failed.',
            returnDisplay: this.currentDisplay!,
          };
        }
        return {
          llmContent: [{ text: finalText }],
          returnDisplay: this.currentDisplay!,
        };
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
