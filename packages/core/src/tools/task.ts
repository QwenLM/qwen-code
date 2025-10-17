/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames } from './tool-names.js';
import type {
  ToolResult,
  ToolResultDisplay,
  TaskResultDisplay,
} from './tools.js';
import { ToolConfirmationOutcome } from './tools.js';
import type {
  ToolCallConfirmationDetails,
  ToolConfirmationPayload,
} from './tools.js';
import type { Config } from '../config/config.js';
import type { SubagentManager } from '../subagents/subagent-manager.js';
import {
  type SubagentConfig,
  SubagentTerminateMode,
} from '../subagents/types.js';
import { ContextState } from '../subagents/subagent.js';
import {
  SubAgentEventEmitter,
  SubAgentEventType,
} from '../subagents/subagent-events.js';
import type {
  SubAgentToolCallEvent,
  SubAgentToolResultEvent,
  SubAgentFinishEvent,
  SubAgentErrorEvent,
  SubAgentApprovalRequestEvent,
} from '../subagents/subagent-events.js';

export interface TaskParams {
  description: string;
  prompt: string;
  subagent_type: string;
}

/**
 * Task tool that enables primary agents to delegate tasks to specialized subagents.
 * The tool dynamically loads available subagents and includes them in its description
 * for the model to choose from.
 */
export class TaskTool extends BaseDeclarativeTool<TaskParams, ToolResult> {
  static readonly Name: string = ToolNames.TASK;

  private subagentManager: SubagentManager;
  private availableSubagents: SubagentConfig[] = [];

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
      TaskTool.Name,
      'Task',
      'Delegate tasks to specialized subagents. Loading available subagents...', // Initial description
      Kind.Other,
      initialSchema,
      true, // isOutputMarkdown
      true, // canUpdateOutput - Enable live output updates for real-time progress
    );

    this.subagentManager = config.getSubagentManager();
    this.subagentManager.addChangeListener(() => {
      void this.refreshSubagents();
    });

    // Initialize the tool asynchronously
    this.refreshSubagents();
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
      console.warn('Failed to load subagents for Task tool:', error);
      this.availableSubagents = [];
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

Available agent types and the tools they have access to:
${subagentDescriptions}

When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.

When NOT to use the Agent tool:
- If you want to read a specific file path, use the Read or Glob tool instead of the Agent tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Agent tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above

Usage notes:
1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
2. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
3. Each agent invocation is stateless. You will not be able to send additional messages to the agent, nor will the agent be able to communicate with you outside of its final report. Therefore, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.
4. The agent's outputs should generally be trusted
5. Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
6. If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.

Example usage:
<example_agent_descriptions>
"code-reviewer": use this agent after you are done writing a signficant piece of code
"greeting-responder": use this agent when to respond to user greetings with a friendly joke
</example_agent_description>

<example>
user: "Please write a function that checks if a number is prime"
assistant: Sure let me write a function that checks if a number is prime
assistant: First let me use the Write tool to write a function that checks if a number is prime
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
Since a signficant piece of code was written and the task was completed, now use the code-reviewer agent to review the code
</commentary>
assistant: Now let me use the code-reviewer agent to review the code
assistant: Uses the Task tool to launch the with the code-reviewer agent 
</example>

<example>
user: "Hello"
<commentary>
Since the user is greeting, use the greeting-responder agent to respond with a friendly joke
</commentary>
assistant: "I'm going to use the Task tool to launch the with the greeting-responder agent"
</example>
`;

    // Update description using object property assignment since it's readonly
    (this as { description: string }).description =
      baseDescription + subagentDescriptions;

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

  override validateToolParams(params: TaskParams): string | null {
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

    // Validate that the subagent exists
    const subagentExists = this.availableSubagents.some(
      (subagent) => subagent.name === params.subagent_type,
    );

    if (!subagentExists) {
      const availableNames = this.availableSubagents.map((s) => s.name);
      return `Subagent "${params.subagent_type}" not found. Available subagents: ${availableNames.join(', ')}`;
    }

    return null;
  }

  protected createInvocation(params: TaskParams) {
    return new TaskToolInvocation(this.config, this.subagentManager, params);
  }
}

class TaskToolInvocation extends BaseToolInvocation<TaskParams, ToolResult> {
  private readonly _eventEmitter: SubAgentEventEmitter;
  private currentDisplay: TaskResultDisplay | null = null;
  private currentToolCalls: TaskResultDisplay['toolCalls'] = [];

  constructor(
    private readonly config: Config,
    private readonly subagentManager: SubagentManager,
    params: TaskParams,
  ) {
    super(params);
    this._eventEmitter = new SubAgentEventEmitter();
  }

  get eventEmitter(): SubAgentEventEmitter {
    return this._eventEmitter;
  }

  /**
   * Updates the current display state and calls updateOutput if provided
   */
  private updateDisplay(
    updates: Partial<TaskResultDisplay>,
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
    this.eventEmitter.on(SubAgentEventType.START, () => {
      this.updateDisplay({ status: 'running' }, updateOutput);
    });

    this.eventEmitter.on(SubAgentEventType.TOOL_CALL, (...args: unknown[]) => {
      const event = args[0] as SubAgentToolCallEvent;
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

    this.eventEmitter.on(
      SubAgentEventType.TOOL_RESULT,
      (...args: unknown[]) => {
        const event = args[0] as SubAgentToolResultEvent;
        const toolCallIndex = this.currentToolCalls!.findIndex(
          (call) => call.callId === event.callId,
        );
        if (toolCallIndex >= 0) {
          this.currentToolCalls![toolCallIndex] = {
            ...this.currentToolCalls![toolCallIndex],
            status: event.success ? 'success' : 'failed',
            error: event.error,
            resultDisplay: event.resultDisplay,
          };

          this.updateDisplay(
            {
              toolCalls: [...this.currentToolCalls!],
            },
            updateOutput,
          );
        }
      },
    );

    this.eventEmitter.on(SubAgentEventType.FINISH, (...args: unknown[]) => {
      const event = args[0] as SubAgentFinishEvent;
      this.updateDisplay(
        {
          status: event.terminateReason === 'GOAL' ? 'completed' : 'failed',
          terminateReason: event.terminateReason,
        },
        updateOutput,
      );
    });

    this.eventEmitter.on(SubAgentEventType.ERROR, (...args: unknown[]) => {
      const event = args[0] as SubAgentErrorEvent;
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
      SubAgentEventType.TOOL_WAITING_APPROVAL,
      (...args: unknown[]) => {
        const event = args[0] as SubAgentApprovalRequestEvent;
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
            const proceedOutcomes = new Set<ToolConfirmationOutcome>([
              ToolConfirmationOutcome.ProceedOnce,
              ToolConfirmationOutcome.ProceedAlways,
              ToolConfirmationOutcome.ProceedAlwaysServer,
              ToolConfirmationOutcome.ProceedAlwaysTool,
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
    return `${this.params.subagent_type} subagent: "${this.params.description}"`;
  }

  override async shouldConfirmExecute(): Promise<false> {
    // Task delegation should execute automatically without user confirmation
    return false;
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
      const subagentScope = await this.subagentManager.createSubagentScope(
        subagentConfig,
        this.config,
        { eventEmitter: this.eventEmitter },
      );

      // Create context state with the task prompt
      const contextState = new ContextState();
      contextState.set('task_prompt', this.params.prompt);

      // Execute the subagent (blocking)
      await subagentScope.runNonInteractive(contextState, signal);

      // Get the results
      const finalText = subagentScope.getFinalText();
      const terminateMode = subagentScope.getTerminateMode();
      const success = terminateMode === SubagentTerminateMode.GOAL;
      const executionSummary = subagentScope.getExecutionSummary();

      if (signal?.aborted) {
        this.updateDisplay(
          {
            status: 'cancelled',
            terminateReason: 'Task was cancelled by user',
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
      console.error(`[TaskTool] Error running subagent: ${errorMessage}`);

      const errorDisplay: TaskResultDisplay = {
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
