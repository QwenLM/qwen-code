/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * send_message tool - send a message to a teammate, peer session, or
 * background task.
 *
 * Three routing modes:
 * - Background-task mode: `task_id` matches an entry in the background task
 *   registry. Running tasks receive the message at the next tool-round
 *   boundary; paused recovered tasks are resumed first and take the message as
 *   their first continuation instruction.
 * - Team mode: `to` matches a teammate name (or "*" for broadcast). Messages
 *   route through TeamManager as plain text. This tool carries content only;
 *   team control actions are separate tools (see `request-shutdown.ts`), so a
 *   teammate cannot express a control action at all — see #9276.
 * - Peer mode: `to` matches another Qwen Code session on this machine.
 *   Peer messages are plain text only.
 */

import type { Config } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import { ToolErrorType } from './tool-error.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { getAgentName } from '../agents/team/identity.js';
import { findMemberByName } from '../agents/team/teamHelpers.js';
import { LEADER_NAME } from '../agents/team/types.js';
import type { ApprovalMode } from '../config/approval-mode.js';
import { isExplicitPeerTarget } from '../ipc/peer-directory.js';
import { sendToPeer } from '../ipc/peer-send.js';
import {
  getPlanRequiredTeammatePreApprovalMessage,
  isPlanRequiredTeammateAwaitingApproval,
} from '../agents/runtime/subagent-plan-tool-policy.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';

export interface SendMessageParams {
  /** Recipient teammate, team broadcast, or peer-session address. */
  to?: string;
  /** Background-task ID, from the launch response (background mode). */
  task_id?: string;
  /** Message text to send. */
  message: string;
  /** Optional 5-10 word summary for UI display (team mode). */
  summary?: string;
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
   * Send-message routes free-form text into a running background task,
   * teammate, or peer session. The recipient can execute it as a new
   * instruction with full tool access. Treat it as a privileged sink — the
   * L4 default must not be
   * 'allow', because that would let the scheduler auto-approve in
   * AUTO mode (where 'allow' short-circuits the classifier). 'ask' lets
   * AUTO route through the classifier so the destination and message text
   * can be inspected.
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  private async trySendToPeer(
    to: string,
    explicit: boolean = false,
  ): Promise<ToolResult | null> {
    if (!this.config.isCrossSessionMessagingEnabled()) {
      if (explicit) {
        const msg =
          'Cross-session messaging is unavailable in this session. Enable the experimental agents.crossSessionMessaging setting and restart before using a peer address.';
        return {
          llmContent: msg,
          returnDisplay: 'Cross-session messaging unavailable.',
          error: { message: msg },
        };
      }
      return null;
    }

    let approvalMode: ApprovalMode | null;
    try {
      approvalMode = this.config.getApprovalMode();
    } catch {
      approvalMode = null;
    }
    const outcome = await sendToPeer({
      target: to,
      message: this.params.message,
      approvalMode,
    });

    switch (outcome.kind) {
      case 'disabled': {
        if (explicit) {
          const msg =
            'Cross-session messaging is unavailable in this session. Enable the experimental agents.crossSessionMessaging setting and restart before using a peer address.';
          return {
            llmContent: msg,
            returnDisplay: 'Cross-session messaging unavailable.',
            error: { message: msg },
          };
        }
        return null;
      }
      case 'not-found': {
        if (outcome.suggestions.length === 0 && !explicit) return null;
        const suggestion =
          outcome.suggestions.length > 0
            ? ` Did you mean: ${outcome.suggestions.join(', ')}?`
            : '';
        const msg =
          `No reachable session matches "${to}".${suggestion} ` +
          'Use list_agents to refresh the list.';
        return {
          llmContent: msg,
          returnDisplay: 'No such session.',
          error: { message: msg, type: ToolErrorType.SEND_MESSAGE_NOT_FOUND },
        };
      }
      case 'ambiguous': {
        const msg =
          `"${to}" matches more than one live session:\n` +
          outcome.matches.map((match) => `  ${match}`).join('\n') +
          '\nSend again with the exact "to" address shown by list_agents.';
        return {
          llmContent: msg,
          returnDisplay: 'Ambiguous recipient.',
          error: { message: msg, type: ToolErrorType.SEND_MESSAGE_NOT_FOUND },
        };
      }
      case 'empty': {
        const msg = 'A peer message cannot be empty.';
        return {
          llmContent: msg,
          returnDisplay: msg,
          error: { message: msg },
        };
      }
      case 'failed': {
        const msg = `Failed to send to ${outcome.address}: ${outcome.reason}`;
        return {
          llmContent: msg,
          returnDisplay: 'Send failed.',
          error: {
            message: msg,
            type: ToolErrorType.SEND_MESSAGE_NOT_RUNNING,
          },
        };
      }
      case 'sent': {
        const preview = this.params.summary ?? this.params.message.slice(0, 50);
        return {
          llmContent:
            `Sent to ${outcome.address}, another Qwen Code session working in ${outcome.peer.cwd}. ` +
            `Message id: ${outcome.msgId}. ` +
            'A later delivery receipt will use this id; the message may first be held for its user to review.',
          returnDisplay: `“${preview}” → ${outcome.address} [${outcome.msgId.slice(0, 8)}]`,
        };
      }
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    if (isPlanRequiredTeammateAwaitingApproval(this.config)) {
      const msg = getPlanRequiredTeammatePreApprovalMessage(
        ToolNames.SEND_MESSAGE,
      );
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg },
      };
    }

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

      if (entry.resumeBlockedReason) {
        return {
          llmContent: `Error: Background task "${this.params.task_id}" cannot be continued: ${entry.resumeBlockedReason}`,
          returnDisplay: 'Task cannot be continued.',
          error: {
            message: `Task cannot be continued: ${this.params.task_id}`,
            type: ToolErrorType.SEND_MESSAGE_NOT_RUNNING,
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

      // Prefer the same in-process runtime when the completed agent is still
      // resident. This preserves its live chat and prepared tool surface. A
      // compatible runtime is not retained across session restore, so the
      // persisted transcript remains the cold fallback for resumable agents.
      if (entry.status === 'completed') {
        const continued = registry.continueResidentAgent(
          this.params.task_id,
          this.params.message,
        );
        if (continued) {
          return {
            llmContent: `Background task "${this.params.task_id}" continued on its existing runtime with your message as the next instruction.`,
            returnDisplay: `Continued ${entry.description}`,
          };
        }

        const revived = await this.config.reviveCompletedBackgroundAgent(
          this.params.task_id,
          this.params.message,
        );
        if (!revived) {
          return {
            llmContent: `Error: Background task "${this.params.task_id}" could not be revived.`,
            returnDisplay: 'Task could not be revived.',
            error: {
              message: `Task could not be revived: ${this.params.task_id}`,
              type: ToolErrorType.SEND_MESSAGE_NOT_RUNNING,
            },
          };
        }

        return {
          llmContent: `Background task "${this.params.task_id}" had completed; revived it with your message as the next instruction.`,
          returnDisplay: `Revived ${entry.description}`,
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

      if (
        registry.isFinishing(this.params.task_id) ||
        !registry.queueMessage(this.params.task_id, this.params.message)
      ) {
        const settled = await registry.waitForFinishing(
          this.params.task_id,
          signal,
        );
        if (!settled) {
          const message = `Message delivery to background task "${this.params.task_id}" was cancelled.`;
          return {
            llmContent: `Error: ${message}`,
            returnDisplay: message,
            error: {
              message,
              type: ToolErrorType.SEND_MESSAGE_NOT_RUNNING,
            },
          };
        }
        return this.execute(signal);
      }

      return {
        llmContent: `Message queued for delivery to background task "${this.params.task_id}". The task will receive it at the next tool-round boundary.`,
        returnDisplay: `Message queued for ${entry.description}`,
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

    const teamManager = this.config.getTeamManager();

    if (to === '*') {
      if (!teamManager) {
        const msg =
          'No active team is available for broadcast. Cross-session broadcast is not supported.';
        return {
          llmContent: msg,
          returnDisplay: 'No active team for broadcast.',
          error: { message: msg },
        };
      }
      try {
        await teamManager.broadcast(
          this.params.message,
          getAgentName() ?? LEADER_NAME,
        );
        const msg = 'Message broadcast to all teammates.';
        return { llmContent: msg, returnDisplay: msg };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          llmContent: `Failed to broadcast message: ${errMsg}`,
          returnDisplay: `Failed to broadcast message: ${errMsg}`,
          error: { message: errMsg },
        };
      }
    }

    const explicitPeerTarget = isExplicitPeerTarget(to);
    if (explicitPeerTarget) {
      const peerResult = await this.trySendToPeer(to, true);
      if (peerResult) return peerResult;
    }

    // Route 2: an in-process teammate wins a bare-name collision with a peer.
    const teamFile = teamManager?.getTeamFile();
    const teamAddressExists =
      !!teamFile &&
      (to.toLowerCase() === LEADER_NAME ||
        to === teamFile.leadAgentId ||
        findMemberByName(teamFile.members, to) !== undefined);

    if (!explicitPeerTarget && !teamAddressExists) {
      // Route 3: another Qwen Code session on this machine.
      const peerResult = await this.trySendToPeer(to);
      if (peerResult) return peerResult;
    }

    if (!teamManager) {
      const msg =
        'No active team, no task_id, and no reachable session by that name. ' +
        'Use list_agents to see available recipients.';
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg },
      };
    }

    try {
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
        this.params.summary,
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
      'Send a message to a teammate or peer session (use "to"), or to a running, paused, or completed background task (use "task_id"); completed tasks are revived. ' +
        'Set "to" to a bare teammate name (no @), "*" to broadcast only within an active Agent Team, or use a session address returned by list_agents. ' +
        'Peer messages may be held for the other session user to review. ' +
        'For background tasks, set "task_id" to the id from the launch response or list_agents. ' +
        'Running tasks receive it at the next tool-round boundary; paused recovered tasks resume with the message as their first continuation instruction; completed tasks continue on their resident runtime when available and otherwise revive from their transcript and continue with your message. ' +
        'Your text output is NOT visible to other agents — use this tool to communicate.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description:
              'Recipient teammate name, "*" for Agent Team broadcast, or peer-session address from list_agents.',
          },
          task_id: {
            type: 'string',
            description:
              'The ID of the background task (from the launch response, a recovered paused task, or a completed task to continue).',
          },
          message: {
            type: 'string',
            description: 'Message text to send.',
            minLength: 1,
            // Cap message size so a teammate can't grow the
            // recipient's inbox file unboundedly with a single send.
            maxLength: 65536,
          },
          summary: {
            type: 'string',
            description: 'Optional 5-10 word summary for UI display.',
          },
        },
        required: ['message'],
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
   * the full text to evaluate the action's safety.
   */
  override toAutoClassifierInput(
    params: SendMessageParams,
  ): Record<string, unknown> {
    return {
      to: params.to,
      task_id: params.task_id,
      message: params.message,
    };
  }
}
