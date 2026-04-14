/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type {
  ToolResult,
  ToolResultDisplay,
  AgentResultDisplay,
  AgentBatchResultDisplay,
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

export interface AgentTaskSpec {
  description: string;
  prompt: string;
  subagent_type: string;
}

/**
 * Parameters accepted by the Agent tool.
 *
 * Two shapes are supported:
 *   1. Legacy single-task: { description, prompt, subagent_type }
 *   2. Batch: { tasks: AgentTaskSpec[] } — runs tasks concurrently in a single
 *      tool call so parallelism does not depend on the model emitting multiple
 *      tool_use blocks in one turn.
 *
 * At validation time exactly one shape must be supplied.
 */
export interface AgentParams {
  description?: string;
  prompt?: string;
  subagent_type?: string;
  tasks?: AgentTaskSpec[];
}

/**
 * Normalizes AgentParams into an array of task specs. Legacy single-task
 * callers become a one-element array.
 */
function normalizeToTasks(params: AgentParams): AgentTaskSpec[] {
  if (params.tasks && params.tasks.length > 0) {
    return params.tasks;
  }
  return [
    {
      description: params.description!,
      prompt: params.prompt!,
      subagent_type: params.subagent_type!,
    },
  ];
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
    // Schema supports two shapes:
    //   A. Legacy single task: { description, prompt, subagent_type }
    //   B. Batch: { tasks: [{ description, prompt, subagent_type }, ...] }
    // Exactly one shape must be provided; this is enforced in
    // validateToolParams. We keep all top-level fields optional in the schema
    // so models that prefer either shape pass JSON-schema validation.
    const taskItemSchema = {
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
    };

    const initialSchema = {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description:
            'A short (3-5 word) description of the task. Use with prompt + subagent_type for a single task, or omit and use tasks[] for a batch.',
        },
        prompt: {
          type: 'string',
          description: 'The task for the agent to perform (single-task form).',
        },
        subagent_type: {
          type: 'string',
          description:
            'The type of specialized agent to use for this task (single-task form).',
        },
        tasks: {
          type: 'array',
          minItems: 1,
          items: taskItemSchema,
          description:
            'Batch form: an array of tasks to launch concurrently in a single tool call. Prefer this form when launching multiple agents so that parallelism is guaranteed by the runtime and does not depend on emitting multiple tool_use blocks in one turn.',
        },
      },
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

    // Update the parameter schema by modifying the existing object. Inject
    // the subagent enum into both the single-task field and the batch
    // tasks[].items.subagent_type field so either form is validated.
    const schema = this.parameterSchema as {
      properties?: {
        subagent_type?: { enum?: string[] };
        tasks?: {
          items?: {
            properties?: {
              subagent_type?: { enum?: string[] };
            };
          };
        };
      };
    };
    const setEnum = (target?: { enum?: string[] }) => {
      if (!target) return;
      if (subagentNames.length > 0) {
        target.enum = subagentNames;
      } else {
        delete target.enum;
      }
    };
    setEnum(schema.properties?.subagent_type);
    setEnum(schema.properties?.tasks?.items?.properties?.subagent_type);
  }

  override validateToolParams(params: AgentParams): string | null {
    const hasBatch = Array.isArray(params.tasks) && params.tasks.length > 0;
    const hasSingle =
      params.description !== undefined ||
      params.prompt !== undefined ||
      params.subagent_type !== undefined;

    if (hasBatch && hasSingle) {
      return 'Provide either tasks[] (batch form) or description+prompt+subagent_type (single-task form), not both.';
    }
    if (!hasBatch && !hasSingle) {
      return 'Parameters missing: provide tasks[] (batch form) or description+prompt+subagent_type (single-task form).';
    }

    const specs: AgentTaskSpec[] = hasBatch
      ? (params.tasks as AgentTaskSpec[])
      : [
          {
            description: params.description as string,
            prompt: params.prompt as string,
            subagent_type: params.subagent_type as string,
          },
        ];

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const loc = hasBatch ? ` in tasks[${i}]` : '';

      if (
        !spec ||
        !spec.description ||
        typeof spec.description !== 'string' ||
        spec.description.trim() === ''
      ) {
        return `Parameter "description"${loc} must be a non-empty string.`;
      }
      if (
        !spec.prompt ||
        typeof spec.prompt !== 'string' ||
        spec.prompt.trim() === ''
      ) {
        return `Parameter "prompt"${loc} must be a non-empty string.`;
      }
      if (
        !spec.subagent_type ||
        typeof spec.subagent_type !== 'string' ||
        spec.subagent_type.trim() === ''
      ) {
        return `Parameter "subagent_type"${loc} must be a non-empty string.`;
      }

      const lowerType = spec.subagent_type.toLowerCase();
      const subagentExists = this.availableSubagents.some(
        (subagent) => subagent.name.toLowerCase() === lowerType,
      );
      if (!subagentExists) {
        const availableNames = this.availableSubagents.map((s) => s.name);
        return `Subagent "${spec.subagent_type}"${loc} not found. Available subagents: ${availableNames.join(', ')}`;
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

/**
 * Per-task runtime state held by AgentToolInvocation in batch mode.
 * In legacy single-task mode there is exactly one slot.
 */
interface TaskSlot {
  spec: AgentTaskSpec;
  emitter: AgentEventEmitter;
  display: AgentResultDisplay;
  toolCalls: NonNullable<AgentResultDisplay['toolCalls']>;
}

/**
 * Maximum number of subagents run concurrently from a single batch AgentTool
 * call. Caps pressure on the model endpoint (rate limits) and on local tool
 * resources when a batch is larger than this limit. Any remainder runs in
 * subsequent waves as earlier slots finish.
 *
 * 8 is chosen to comfortably cover the /review use case (5 tasks) while
 * leaving headroom, and is small enough to stay below common per-minute
 * rate limits when multiple batches are issued in succession.
 */
export const AGENT_BATCH_MAX_CONCURRENCY = 8;

/**
 * Runs `runner` for each item of `items` with at most `limit` in flight.
 * Returns results in the same order as `items` (like Promise.allSettled).
 *
 * `limit` is floored to 1 so a misconfigured caller cannot accidentally
 * deadlock the batch by supplying 0 or a negative value (which would spawn
 * no workers and leave `results` permanently sparse).
 */
async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  runner: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  // Shared cursor is safe without a lock: JS is single-threaded, so
  // `cursor++` is atomic relative to cooperating async workers.
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        const value = await runner(items[i], i);
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };

  const workers: Array<Promise<void>> = [];
  const workerCount = Math.min(Math.max(1, limit), items.length);
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

function aggregateBatchStatus(
  slots: TaskSlot[],
): AgentBatchResultDisplay['status'] {
  let anyRunning = false;
  let anyFailed = false;
  let anyCancelled = false;
  for (const slot of slots) {
    switch (slot.display.status) {
      case 'running':
        anyRunning = true;
        break;
      case 'failed':
        anyFailed = true;
        break;
      case 'cancelled':
        anyCancelled = true;
        break;
      default:
        break;
    }
  }
  if (anyRunning) return 'running';
  if (anyCancelled) return 'cancelled';
  if (anyFailed) return 'failed';
  return 'completed';
}

class AgentToolInvocation extends BaseToolInvocation<AgentParams, ToolResult> {
  private readonly specs: AgentTaskSpec[];
  private readonly isBatch: boolean;
  private readonly slots: TaskSlot[];

  /**
   * Legacy single-emitter accessor. External consumers that were written
   * before batch support (e.g. older code paths) still read
   * `invocation.eventEmitter` and will only see events from the first slot.
   * New consumers should prefer `eventEmitters` to subscribe to every
   * concurrent slot in a batch call.
   */
  readonly eventEmitter: AgentEventEmitter;

  /**
   * Per-slot event emitters, in the same order as `slotSubagentTypes`.
   * In single-task mode this array contains exactly one entry equal to
   * `eventEmitter`.
   */
  readonly eventEmitters: AgentEventEmitter[];

  /**
   * Subagent type name for each slot, aligned with `eventEmitters`. Exposed
   * so observers (e.g. ACP SubAgentTracker) can attribute events to the
   * correct subagent label without needing to reach into slot internals.
   */
  readonly slotSubagentTypes: string[];

  constructor(
    private readonly config: Config,
    private readonly subagentManager: SubagentManager,
    params: AgentParams,
  ) {
    super(params);
    this.specs = normalizeToTasks(params);
    this.isBatch =
      Array.isArray(params.tasks) && (params.tasks?.length ?? 0) > 0;

    this.slots = this.specs.map((spec) => ({
      spec,
      emitter: new AgentEventEmitter(),
      display: {
        type: 'task_execution' as const,
        subagentName: spec.subagent_type,
        taskDescription: spec.description,
        taskPrompt: spec.prompt,
        status: 'running' as const,
      },
      toolCalls: [],
    }));

    this.eventEmitter = this.slots[0].emitter;
    this.eventEmitters = this.slots.map((s) => s.emitter);
    this.slotSubagentTypes = this.slots.map((s) => s.spec.subagent_type);
  }

  /**
   * Emits the current aggregated display via updateOutput. In batch mode
   * this rebuilds the AgentBatchResultDisplay from slot state; in single
   * mode it passes the lone slot's display unchanged.
   */
  private emitDisplay(
    updateOutput?: (output: ToolResultDisplay) => void,
  ): void {
    if (!updateOutput) return;
    if (this.isBatch) {
      updateOutput({
        type: 'task_execution_batch',
        tasks: this.slots.map((s) => s.display),
        status: aggregateBatchStatus(this.slots),
      });
    } else {
      updateOutput(this.slots[0].display);
    }
  }

  /**
   * Merges updates into the given slot's display and emits the aggregated
   * display.
   */
  private updateSlotDisplay(
    slot: TaskSlot,
    updates: Partial<AgentResultDisplay>,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): void {
    slot.display = { ...slot.display, ...updates };
    this.emitDisplay(updateOutput);
  }

  /**
   * Sets up event listeners for real-time subagent progress updates on a
   * single task slot.
   */
  private setupSlotListeners(
    slot: TaskSlot,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): void {
    let pendingConfirmationCallId: string | undefined;

    slot.emitter.on(AgentEventType.START, () => {
      this.updateSlotDisplay(slot, { status: 'running' }, updateOutput);
    });

    slot.emitter.on(AgentEventType.TOOL_CALL, (...args: unknown[]) => {
      const event = args[0] as AgentToolCallEvent;
      const newToolCall = {
        callId: event.callId,
        name: event.name,
        status: 'executing' as const,
        args: event.args,
        description: event.description,
      };
      slot.toolCalls.push(newToolCall);

      this.updateSlotDisplay(
        slot,
        { toolCalls: [...slot.toolCalls] },
        updateOutput,
      );
    });

    slot.emitter.on(AgentEventType.TOOL_RESULT, (...args: unknown[]) => {
      const event = args[0] as AgentToolResultEvent;
      const toolCallIndex = slot.toolCalls.findIndex(
        (call) => call.callId === event.callId,
      );
      if (toolCallIndex >= 0) {
        slot.toolCalls[toolCallIndex] = {
          ...slot.toolCalls[toolCallIndex],
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

        this.updateSlotDisplay(
          slot,
          {
            toolCalls: [...slot.toolCalls],
            ...clearPending,
          },
          updateOutput,
        );
      }
    });

    slot.emitter.on(AgentEventType.FINISH, (...args: unknown[]) => {
      const event = args[0] as AgentFinishEvent;
      this.updateSlotDisplay(
        slot,
        {
          status: event.terminateReason === 'GOAL' ? 'completed' : 'failed',
          terminateReason: event.terminateReason,
        },
        updateOutput,
      );
    });

    slot.emitter.on(AgentEventType.ERROR, (...args: unknown[]) => {
      const event = args[0] as AgentErrorEvent;
      this.updateSlotDisplay(
        slot,
        { status: 'failed', terminateReason: event.error },
        updateOutput,
      );
    });

    // Indicate when a tool call is waiting for approval
    slot.emitter.on(
      AgentEventType.TOOL_WAITING_APPROVAL,
      (...args: unknown[]) => {
        const event = args[0] as AgentApprovalRequestEvent;
        const idx = slot.toolCalls.findIndex((c) => c.callId === event.callId);
        if (idx >= 0) {
          slot.toolCalls[idx] = {
            ...slot.toolCalls[idx],
            status: 'awaiting_approval',
          };
        } else {
          slot.toolCalls.push({
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
              const idx2 = slot.toolCalls.findIndex(
                (c) => c.callId === event.callId,
              );
              if (idx2 >= 0) {
                slot.toolCalls[idx2] = {
                  ...slot.toolCalls[idx2],
                  status: 'executing',
                };
              }
              this.updateSlotDisplay(
                slot,
                {
                  toolCalls: [...slot.toolCalls],
                  pendingConfirmation: undefined,
                },
                updateOutput,
              );
            } else {
              this.updateSlotDisplay(
                slot,
                { pendingConfirmation: undefined },
                updateOutput,
              );
            }

            await event.respond(outcome, payload);
          },
        } as ToolCallConfirmationDetails;

        this.updateSlotDisplay(
          slot,
          {
            toolCalls: [...slot.toolCalls],
            pendingConfirmation: details,
          },
          updateOutput,
        );
      },
    );
  }

  getDescription(): string {
    if (this.isBatch) {
      return `${this.specs.length} tasks: ${this.specs
        .map((s) => s.description)
        .join(', ')}`;
    }
    return this.specs[0].description;
  }

  /**
   * Runs a single task slot end-to-end: loads the subagent config, sets up
   * event listeners, fires SubagentStart/Stop hooks, and executes. Mutates
   * slot.display to reflect terminal state. Returns the slot's final text
   * output (used to build llmContent).
   *
   * Errors are caught and translated into `failed` slot display state so
   * that Promise.allSettled in execute() only fails on truly exceptional
   * cases; we prefer each slot to report its own failure in the display.
   */
  private async runOneTask(
    slot: TaskSlot,
    signal: AbortSignal | undefined,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<string> {
    try {
      const subagentConfig = await this.subagentManager.loadSubagent(
        slot.spec.subagent_type,
      );

      if (!subagentConfig) {
        const msg = `Subagent "${slot.spec.subagent_type}" not found`;
        this.updateSlotDisplay(
          slot,
          { status: 'failed', terminateReason: msg },
          updateOutput,
        );
        return msg;
      }

      this.updateSlotDisplay(
        slot,
        {
          subagentName: subagentConfig.name,
          subagentColor: subagentConfig.color,
          status: 'running',
        },
        updateOutput,
      );

      this.setupSlotListeners(slot, updateOutput);

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

      const subagent = await this.subagentManager.createAgentHeadless(
        subagentConfig,
        agentConfig,
        { eventEmitter: slot.emitter },
      );

      const contextState = new ContextState();
      contextState.set('task_prompt', slot.spec.prompt);

      const hookSystem = this.config.getHookSystem();
      const agentId = `${subagentConfig.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const agentType = slot.spec.subagent_type;

      if (hookSystem) {
        try {
          const startHookOutput = await hookSystem.fireSubagentStartEvent(
            agentId,
            agentType,
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

      await subagent.execute(contextState, signal);

      if (hookSystem && !signal?.aborted) {
        const transcriptPath = this.config.getTranscriptPath();
        let stopHookActive = false;
        let continueExecution = true;
        let iterationCount = 0;
        const maxIterations = 5;

        while (continueExecution) {
          iterationCount++;
          if (iterationCount >= maxIterations) {
            debugLogger.warn(
              `[TaskTool] SubagentStop hook reached maximum iterations (${maxIterations}), forcing stop to prevent infinite loop`,
            );
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
              const continueReason = typedStopOutput.getEffectiveReason();
              stopHookActive = true;
              const continueContext = new ContextState();
              continueContext.set('task_prompt', continueReason);
              await subagent.execute(continueContext, signal);
              if (signal?.aborted) {
                continueExecution = false;
              }
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

      const finalText = subagent.getFinalText();
      const terminateMode = subagent.getTerminateMode();
      const success = terminateMode === AgentTerminateMode.GOAL;
      const executionSummary = subagent.getExecutionSummary();

      if (signal?.aborted) {
        this.updateSlotDisplay(
          slot,
          {
            status: 'cancelled',
            terminateReason: 'Agent was cancelled by user',
            executionSummary,
          },
          updateOutput,
        );
      } else {
        this.updateSlotDisplay(
          slot,
          {
            status: success ? 'completed' : 'failed',
            terminateReason: terminateMode,
            result: finalText,
            executionSummary,
          },
          updateOutput,
        );
      }

      return finalText;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      debugLogger.error(
        `[AgentTool] Error running subagent "${slot.spec.subagent_type}": ${errorMessage}`,
      );
      this.updateSlotDisplay(
        slot,
        {
          status: 'failed',
          terminateReason: `Failed to run subagent: ${errorMessage}`,
        },
        updateOutput,
      );
      return `Failed to run subagent "${slot.spec.subagent_type}": ${errorMessage}`;
    }
  }

  async execute(
    signal?: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    // Emit initial display so the UI sees all slots in 'running' state
    // before any subagent work begins.
    this.emitDisplay(updateOutput);

    // Fan out with a concurrency cap. runOneTask swallows its own errors
    // into slot.display, so the PromiseSettledResult shape here is
    // defensive — we should never see rejections in practice, but this
    // keeps one slot's unexpected throw from masking others.
    const results = await runWithConcurrencyLimit(
      this.slots,
      AGENT_BATCH_MAX_CONCURRENCY,
      (slot) => this.runOneTask(slot, signal, updateOutput),
    );

    const finalTexts: string[] = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      // Should not normally happen (runOneTask catches), but guard anyway.
      const msg =
        r.reason instanceof Error ? r.reason.message : String(r.reason);
      const slot = this.slots[i];
      if (slot.display.status === 'running') {
        slot.display = {
          ...slot.display,
          status: 'failed',
          terminateReason: `Unhandled error: ${msg}`,
        };
      }
      return `Failed: ${msg}`;
    });

    if (!this.isBatch) {
      const slot = this.slots[0];
      return {
        llmContent: [{ text: finalTexts[0] }],
        returnDisplay: slot.display,
      };
    }

    const batchDisplay: AgentBatchResultDisplay = {
      type: 'task_execution_batch',
      tasks: this.slots.map((s) => s.display),
      status: aggregateBatchStatus(this.slots),
    };

    // Build a structured llmContent summary so the parent agent receives
    // clearly-delimited results per task.
    const combined = this.slots
      .map((slot, i) => {
        const header = `## Task ${i + 1}: ${slot.spec.description} (${slot.spec.subagent_type})`;
        return `${header}\n\n${finalTexts[i]}`;
      })
      .join('\n\n---\n\n');

    return {
      llmContent: [{ text: combined }],
      returnDisplay: batchDisplay,
    };
  }
}
