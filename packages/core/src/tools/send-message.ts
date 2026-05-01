/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview SendMessage tool — lets the model send a text message to
 * a background task. Running tasks receive the message at the next tool-round
 * boundary; paused recovered tasks are resumed first and take the message as
 * their first continuation instruction.
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
  /** The ID of the background task to send the message to. */
  task_id: string;
  /** The text message to deliver to the task. */
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
    return `Send message to task ${this.params.task_id}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const registry = this.config.getBackgroundTaskRegistry();
    const entry = registry.get(this.params.task_id);

    if (!entry) {
      return {
        llmContent: `Error: No background task found with ID "${this.params.task_id}".`,
        returnDisplay: 'Task not found.',
        error: {
          message: `Task not found: ${this.params.task_id}`,
          type: ToolErrorType.SEND_MESSAGE_NOT_FOUND,
        },
      };
    }

    if (entry.status === 'paused') {
      const resumed = await this.config.resumeBackgroundAgent(
        this.params.task_id,
        this.params.message,
      );
      if (!resumed) {
        return {
          llmContent: `Error: Background task "${this.params.task_id}" could not be resumed.`,
          returnDisplay: 'Task could not be resumed.',
          error: {
            message: `Task could not be resumed: ${this.params.task_id}`,
            type: ToolErrorType.SEND_MESSAGE_NOT_RUNNING,
          },
        };
      }

      return {
        llmContent: `Background task "${this.params.task_id}" resumed with your message as the first continuation instruction.`,
        returnDisplay: `Resumed ${entry.description}`,
      };
    }

    if (entry.status !== 'running') {
      return {
        llmContent: `Error: Background task "${this.params.task_id}" is not running (status: ${entry.status}). Cannot send messages to stopped tasks.`,
        returnDisplay: `Task not running (${entry.status}).`,
        error: {
          message: `Task is ${entry.status}: ${this.params.task_id}`,
          type: ToolErrorType.SEND_MESSAGE_NOT_RUNNING,
        },
      };
    }

    registry.queueMessage(this.params.task_id, this.params.message);

    return {
      llmContent: `Message queued for delivery to background task "${this.params.task_id}". The task will receive it at the next tool-round boundary.`,
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
      'Send a text message to a background task. Running tasks receive it at the next tool-round boundary. Paused recovered tasks are resumed first and use the message as their first continuation instruction.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description:
              'The ID of the background task (from the launch response or a recovered paused task).',
          },
          message: {
            type: 'string',
            description: 'The text message to send to the task.',
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
