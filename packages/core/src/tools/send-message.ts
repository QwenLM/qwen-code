/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * send_message tool — send a message to a teammate.
 *
 * Supports plain text messages and structured messages
 * (shutdown_request, shutdown_response) following the
 * kimi-code pattern.
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { getAgentName } from '../agents/team/identity.js';

export interface SendMessageParams {
  to: string;
  message: string;
  summary?: string;
  type?: 'shutdown_request';
}

class SendMessageInvocation extends BaseToolInvocation<
  SendMessageParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: SendMessageParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const preview = this.params.summary ?? this.params.message.slice(0, 50);
    return `Send to ${this.params.to}: ${preview}`;
  }

  async execute(): Promise<ToolResult> {
    const teamManager = this.config.getTeamManager();
    if (!teamManager) {
      const msg = 'No active team. Create a team first.';
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
        await teamManager.requestShutdown(to);
        const msg = `Shutdown requested for "${to}".`;
        return { llmContent: msg, returnDisplay: msg };
      }

      if (to === '*') {
        const sender = getAgentName() ?? 'leader';
        await teamManager.broadcast(this.params.message, sender);
        const msg = 'Message broadcast to all teammates.';
        return { llmContent: msg, returnDisplay: msg };
      }

      await teamManager.sendMessage(to, this.params.message, getAgentName());
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

  constructor(private config: Config) {
    super(
      SendMessageTool.Name,
      ToolDisplayNames.SEND_MESSAGE,
      'Send a message to a teammate. Use bare name (no @). ' +
        'Set to "*" to broadcast to all teammates. ' +
        'Your text output is NOT visible to other agents — ' +
        'use this tool to communicate.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Recipient teammate name, or "*" for broadcast.',
          },
          message: {
            type: 'string',
            description: 'Message text to send.',
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
        required: ['to', 'message'],
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
