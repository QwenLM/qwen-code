/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview SendMessage tool — lets the model send a text message to
 * a running background agent. The message is injected into the agent's
 * reasoning loop at the next tool-round boundary.
 */

import type { Config } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';

export interface SendMessageParams {
  /** The ID of the background agent to send the message to. */
  task_id: string;
  /** The text message to deliver to the agent. */
  message: string;
}

class SendMessageInvocation extends BaseToolInvocation<
  SendMessageParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: SendMessageParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Send message to agent ${this.params.task_id}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const registry = this.config.getBackgroundTaskRegistry();
    const entry = registry.get(this.params.task_id);

    if (!entry) {
      return {
        llmContent: `Error: No background agent found with ID "${this.params.task_id}".`,
        returnDisplay: 'Agent not found.',
        error: {
          message: `Agent not found: ${this.params.task_id}`,
          type: ToolErrorType.SEND_MESSAGE_AGENT_NOT_FOUND,
        },
      };
    }

    if (entry.status !== 'running') {
      return {
        llmContent: `Error: Background agent "${this.params.task_id}" is not running (status: ${entry.status}). Cannot send messages to stopped agents.`,
        returnDisplay: `Agent not running (${entry.status}).`,
        error: {
          message: `Agent is ${entry.status}: ${this.params.task_id}`,
          type: ToolErrorType.SEND_MESSAGE_AGENT_NOT_RUNNING,
        },
      };
    }

    registry.queueMessage(this.params.task_id, this.params.message);

    return {
      llmContent: `Message queued for delivery to background agent "${this.params.task_id}". The agent will receive it at the next tool-round boundary.`,
      returnDisplay: `Message queued for ${entry.description}`,
    };
  }
}

export class SendMessageTool extends BaseDeclarativeTool<
  SendMessageParams,
  ToolResult
> {
  static readonly Name = ToolNames.SEND_MESSAGE;

  constructor(private readonly config: Config) {
    super(
      SendMessageTool.Name,
      ToolDisplayNames.SEND_MESSAGE,
      'Send a text message to a running background agent. The message is delivered at the next tool-round boundary. Use this to provide additional instructions or context to a background agent.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description:
              'The ID of the running background agent (from the launch response).',
          },
          message: {
            type: 'string',
            description: 'The text message to send to the agent.',
          },
        },
        required: ['task_id', 'message'],
        additionalProperties: false,
      },
    );
  }

  protected createInvocation(
    params: SendMessageParams,
  ): ToolInvocation<SendMessageParams, ToolResult> {
    return new SendMessageInvocation(this.config, params);
  }
}
