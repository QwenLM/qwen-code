/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolResult,
  ToolResultDisplay,
  TaskResultDisplay,
} from './tools.js';
import { ToolConfirmationOutcome } from './tools.js';
import type {
  ToolCallConfirmationDetails,
  ToolConfirmationPayload,
} from './tools.js';
import { Config } from '../config/config.js';
import { SubagentManager } from '../subagents/subagent-manager.js';
import { SubagentConfig, SubagentTerminateMode } from '../subagents/types.js';
import { ContextState } from '../subagents/subagent.js';
import {
  SubAgentEventEmitter,
  SubAgentToolCallEvent,
  SubAgentToolResultEvent,
  SubAgentFinishEvent,
  SubAgentEventType,
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
  static readonly Name: string = 'task';

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

    // Initialize the tool asynchronously
    this.initializeAsync();
  }

  /**
   * Asynchronously initializes the tool by loading available subagents
   * and updating the description and schema.
   */
  private async initializeAsync(): Promise<void> {
    try {
      this.availableSubagents = await this.subagentManager.listSubagents();
      this.updateDescriptionAndSchema();
    } catch (error) {
      console.warn('Failed to load subagents for Task tool:', error);
      this.availableSubagents = [];
      this.updateDescriptionAndSchema();
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

## Available Agents
${subagentDescriptions}

## When to Use the Task Tool

Use the Task tool when you need to delegate complex, multi-step work that requires specialized knowledge or capabilities. The tool is particularly effective for:

- Research tasks that require exploring multiple files or codebases
- Code analysis and refactoring projects
- Multi-file editing or creation tasks
- Complex problem-solving that benefits from a structured approach

## When NOT to Use the Task Tool

Avoid using the Task tool for:
- Simple file operations - use Read, Write, or Glob tools directly
- Quick searches - use Grep or Glob tools for immediate results
- Single-step tasks - handle them directly without delegation
- Tasks requiring user interaction - these should be handled by the primary agent

## Task Delegation Guidelines

### Selecting the Right Agent
- Review the available agents and their descriptions above
- Match the agent's strengths to your task requirements
- When in doubt, the general-purpose agent is a good default choice

### Crafting Effective Task Prompts
When delegating tasks, ensure your prompt includes:
- Clear, specific objectives
- Expected outcomes and deliverables
- Any constraints or limitations
- Relevant context about the codebase or project

### Optimizing for Performance
- Launch multiple agents concurrently when possible to maximize performance
- Use a single message with multiple tool uses for related tasks
- Provide sufficient context upfront to minimize back-and-forth

## Agent Communication Guidelines

### Before Delegation
- Clearly define what you expect the agent to accomplish
- Specify the format and detail level of the expected response
- Include any relevant constraints or requirements

### During Execution
- Each agent invocation is stateless with no ability to communicate further
- The agent will return a single message with its final result
- You must explicitly request any specific information you need in the result

### After Completion
- The result returned by the agent is not visible to the user
- You should send a text message back to the user with a concise summary
- Include relevant details, code snippets, or findings as appropriate

## Quality Standards

- **Clarity**: Provide unambiguous task descriptions
- **Completeness**: Include all necessary context and requirements
- **Specificity**: Clearly define expected outcomes
- **Efficiency**: Match the task complexity to the right agent

## Example Usage Patterns

<example_agent_descriptions>
"code-reviewer": use this agent after you are done writing a significant piece of code
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
Since a significant piece of code was written and the task was completed, now use the general-purpose agent to review the code
</commentary>
assistant: Now let me use the general-purpose agent to review the code
assistant: Uses the Task tool to launch the general-purpose agent
</example>

<example>
user: "Hello"
<commentary>
Since the user is greeting, use the greeting-responder agent to respond with a friendly joke
</commentary>
assistant: "I'm going to use the Task tool to launch the greeting-responder agent"
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

  /**
   * Refreshes the available subagents and updates the tool description.
   * This can be called when subagents are added or removed.
   */
  async refreshSubagents(): Promise<void> {
    await this.initializeAsync();
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
