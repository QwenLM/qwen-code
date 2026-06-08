/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * send_message tool - send a message to a teammate or a background task.
 *
 * Two routing modes:
 * - Team mode: `to` matches a teammate name (or "*" for broadcast). Messages
 *   route through TeamManager. Supports structured messages like
 *   `shutdown_request`.
 * - Background-task mode: `task_id` matches an entry in the background task
 *   registry. Running tasks receive the message at the next tool-round
 *   boundary; paused recovered tasks are resumed first and take the message as
 *   their first continuation instruction.
 */

import type { Config } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import { ToolErrorType } from './tool-error.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { getAgentName, isTeammate } from '../agents/team/identity.js';
import { LEADER_NAME } from '../agents/team/types.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';

export interface SendMessageParams {
  /** Recipient teammate name, or "*" for broadcast (team mode). */
  to?: string;
  /** Background-task ID, from the launch response (background mode). */
  task_id?: string;
  /** Message text to send. */
  message: string;
  /** Optional 5-10 word summary for UI display (team mode). */
  summary?: string;
  /** Structured control message type (team mode). */
  type?: 'shutdown_request';
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
    if (this.params.task_id) {
      return `Send message to task ${this.params.task_id}`;
    }
    const preview = this.params.summary ?? this.params.message.slice(0, 50);
    return `Send to ${this.params.to}: ${preview}`;
  }

  /**
   * Send-message routes free-form text into a running background task or a
   * teammate, which will then execute it as a new instruction with full
   * tool access. Treat it as a privileged sink — the L4 default must not be
   * 'allow', because that would let the scheduler auto-approve in
   * AUTO mode (where 'allow' short-circuits the classifier). 'ask' lets
   * AUTO route through the classifier so the destination and message text
   * can be inspected.
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    // Route 1: background task by task_id.
    if (this.params.task_id) {
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

    // Route 2: teammate by name via TeamManager.
    const teamManager = this.config.getTeamManager();
    if (!teamManager) {
      const msg =
        'No active team and no task_id provided. ' +
        'Either create a team first, or pass `task_id` to message a background task.';
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg },
      };
    }

    const to = this.params.to;
    if (!to) {
      const msg = 'Recipient "to" is required.';
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg },
      };
    }

    try {
      // Structured control messages route through mailbox.
      if (this.params.type === 'shutdown_request') {
        // Only the leader can request shutdowns. A teammate
        // calling this would be impersonating the leader, since
        // requestShutdown writes the mailbox entry with
        // `from: LEADER_NAME` and arms shutdown_approved tracking
        // for the target.
        if (isTeammate()) {
          const msg = 'Only the team leader can request shutdowns.';
          return {
            llmContent: msg,
            returnDisplay: msg,
            error: { message: msg },
          };
        }
        await teamManager.requestShutdown(to);
        const msg = `Shutdown requested for "${to}".`;
        return { llmContent: msg, returnDisplay: msg };
      }

      if (to === '*') {
        const sender = getAgentName() ?? LEADER_NAME;
        await teamManager.broadcast(this.params.message, sender);
        const msg = 'Message broadcast to all teammates.';
        return { llmContent: msg, returnDisplay: msg };
      }

      await teamManager.sendMessage(
        to,
        this.params.message,
        getAgentName() ?? LEADER_NAME,
      );
      const msg = `Message sent to "${to}".`;
      return { llmContent: msg, returnDisplay: msg };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Failed to send message: ${errMsg}`,
        returnDisplay: `Failed to send message: ${errMsg}`,
        error: { message: errMsg },
      };
    }
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
      'Send a message to a teammate (use "to") or to a running background task (use "task_id"). ' +
        'For teams, set "to" to a bare teammate name (no @) or "*" to broadcast. ' +
        'For background tasks, set "task_id" to the id from the launch response or a recovered paused task. ' +
        'Running tasks receive it at the next tool-round boundary; paused recovered tasks are resumed with the message as their first continuation instruction. ' +
        'Your text output is NOT visible to other agents — use this tool to communicate.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Recipient teammate name, or "*" for broadcast.',
          },
          task_id: {
            type: 'string',
            description:
              'The ID of the background task (from the launch response or a recovered paused task).',
          },
          message: {
            type: 'string',
            description: 'Message text to send.',
            // Cap message size so a teammate can't grow the
            // recipient's inbox file unboundedly with a single send.
            maxLength: 65536,
          },
          summary: {
            type: 'string',
            description: 'Optional 5-10 word summary for UI display.',
          },
          type: {
            type: 'string',
            enum: ['shutdown_request'],
            description:
              'Structured message type for control flow. ' +
              'When set, routes through the mailbox ' +
              'instead of plain text delivery.',
          },
        },
        required: ['message'],
        // Either a teammate recipient (`to`) or a background-task
        // (`task_id`) must be specified — they correspond to the
        // two routing modes. Letting the model send `{message}`
        // alone wastes a round-trip on the runtime "Recipient is
        // required" error.
        oneOf: [{ required: ['to'] }, { required: ['task_id'] }],
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer — sending messages is infrequent
      false, // alwaysLoad
      'send message task teammate team communicate notify',
    );
  }

  protected createInvocation(
    params: SendMessageParams,
  ): ToolInvocation<SendMessageParams, ToolResult> {
    return new SendMessageInvocation(this.config, params);
  }

  /**
   * Forward the routing fields and the message verbatim to the classifier —
   * `to`/`task_id` identify the privileged sink and the `message` itself is
   * the new instruction the recipient will execute, so the classifier needs
   * the full text to evaluate the action's safety. `type` surfaces control
   * messages (e.g. shutdown_request).
   */
  override toAutoClassifierInput(
    params: SendMessageParams,
  ): Record<string, unknown> {
    return {
      to: params.to,
      task_id: params.task_id,
      message: params.message,
      type: params.type,
    };
  }
}
