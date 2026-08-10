/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * send_message tool - send a message to a teammate or a background task.
 *
 * Three routing modes, tried in this order:
 * - Background-task mode: `task_id` matches an entry in the background task
 *   registry. Running tasks receive the message at the next tool-round
 *   boundary; paused recovered tasks are resumed first and take the message as
 *   their first continuation instruction.
 * - Team mode: `to` matches a teammate name. Messages route through
 *   TeamManager. Supports structured messages like `shutdown_request`.
 * - Peer mode: `to` matches another Qwen Code session on this machine
 *   (see `ipc/peer-send.ts`). Plain text only — a structured control message
 *   is a same-process protocol and must not cross a session boundary.
 *
 * In-process wins: a name that is both a teammate and a peer session routes
 * to the teammate, because that is this session's own work.
 */

import type { Config } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import { ToolErrorType } from './tool-error.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { getAgentName, isTeammate } from '../agents/team/identity.js';
import { findMemberByName } from '../agents/team/teamHelpers.js';
import { LEADER_NAME } from '../agents/team/types.js';
import type { ApprovalMode } from '../config/approval-mode.js';
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
  /** Recipient teammate name, or a peer session name (optionally `name [ref]`). */
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

  /**
   * Try to deliver to another Qwen Code session on this machine.
   *
   * Returns null when this is not a peer send at all — the name did not
   * resolve and cross-session messaging is off — so the caller can fall
   * through to its own error. Every other outcome, including failures, is
   * a result: each one has a different next step for the model.
   */
  private async trySendToPeer(to: string): Promise<ToolResult | null> {
    // A structured control message is a same-process protocol between a
    // leader and its teammates. Shipping one across a session boundary
    // would let a peer request this session's shutdown.
    if (this.params.type) {
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
      case 'disabled':
        return null;

      case 'not-found': {
        if (outcome.suggestions.length === 0) return null;
        const msg =
          `No reachable session is named "${to}". Did you mean: ` +
          `${outcome.suggestions.join(', ')}? Use list_agents to see who is reachable.`;
        return {
          llmContent: msg,
          returnDisplay: 'No such session.',
          error: { message: msg, type: ToolErrorType.SEND_MESSAGE_NOT_FOUND },
        };
      }

      case 'ambiguous': {
        const msg =
          `"${to}" matches more than one live session:\n` +
          outcome.matches.map((line) => `  ${line}`).join('\n') +
          "\nRe-send with the full 'name [ref]' so it goes to the one you mean.";
        return {
          llmContent: msg,
          returnDisplay: 'Ambiguous recipient.',
          error: { message: msg, type: ToolErrorType.SEND_MESSAGE_NOT_FOUND },
        };
      }

      case 'empty': {
        const msg =
          `"${to}" is another Qwen Code session, and a message with no text ` +
          'has nothing for it to act on. Re-send with the message text.';
        return {
          llmContent: msg,
          returnDisplay: 'Empty message.',
          error: { message: msg, type: ToolErrorType.SEND_MESSAGE_NOT_RUNNING },
        };
      }

      case 'failed': {
        const msg = `Failed to send to ${outcome.address}: ${outcome.reason}`;
        return {
          llmContent: msg,
          returnDisplay: 'Send failed.',
          error: { message: msg, type: ToolErrorType.SEND_MESSAGE_NOT_RUNNING },
        };
      }

      case 'sent': {
        const preview = this.params.summary ?? this.params.message.slice(0, 50);
        return {
          llmContent:
            `Sent to ${outcome.address} — another Qwen Code session on this machine, ` +
            `working in ${outcome.peer.cwd}. It arrives as a marked cross-session message ` +
            'and may be held for its user to review before that session acts on it.',
          returnDisplay: `“${preview}” → ${outcome.address}`,
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

    // Broadcast is gone. It was linear in team size, it has no sensible
    // meaning once "everyone" could include sessions belonging to other
    // work, and a message worth sending to several recipients is worth
    // addressing to each of them.
    if (to === '*') {
      const msg =
        'Broadcast (to: "*") is no longer supported — send one message per recipient.';
      return {
        llmContent: msg,
        returnDisplay: 'Broadcast not supported.',
        error: { message: msg },
      };
    }

    // Route 2: teammate by name via TeamManager. In-process wins over a
    // same-named peer session: a teammate is part of this session's own
    // work, and silently routing off-process would be the more surprising
    // of the two.
    // `members` excludes the leader by definition, but TeamManager also
    // routes "leader" and the lead agent id, and the team prompt tells
    // teammates to report with `to: "leader"`. Leaving those out of the
    // gate would offer a team-internal address to peer resolution first,
    // so a peer named "leader-*" could swallow a teammate's report.
    const teamManager = this.config.getTeamManager();
    const teamAddressExists =
      !!teamManager &&
      (to.toLowerCase() === LEADER_NAME ||
        to === teamManager.getTeamFile().leadAgentId ||
        findMemberByName(teamManager.getTeamFile().members, to) !== undefined);

    if (!teamAddressExists) {
      // Route 3: another Qwen Code session on this machine.
      const peerResult = await this.trySendToPeer(to);
      if (peerResult) return peerResult;
    }

    if (!teamManager) {
      const msg =
        'No active team, no task_id, and no reachable session by that name. ' +
        'Create a team, pass `task_id` to message a background task, or use list_agents to see which sessions are reachable.';
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

      // A blank message has nothing for the recipient to act on. The peer
      // route rejects this in `sendToPeer`; the team route needs the same
      // guard or a whitespace-only message interrupts the teammate with
      // nothing to execute.
      if (this.params.message.trim().length === 0) {
        const msg =
          'A message with no text has nothing for the recipient to act on. ' +
          'Re-send with the message text.';
        return {
          llmContent: msg,
          returnDisplay: 'Empty message.',
          error: { message: msg },
        };
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
      // Keep "completed tasks are revived" inside the first 157 characters:
      // the deferred-tools reminder truncates this description at
      // MAX_DEFERRED_TOOL_DESC_LEN, and environmentContext.test.ts guards that
      // the revival clause survives that cut.
      'Send a message to a teammate or peer session (use "to"), or to a running, paused, or completed background task (use "task_id"); completed tasks are revived. ' +
        'Set "to" to a bare teammate name (no @), or to the name of another Qwen Code session on this machine as shown by list_agents — append its " [ref]" only when two sessions share a name. ' +
        'A message to another session arrives there marked as coming from another agent, and its user may hold it for review before that session acts. ' +
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
              'Recipient: a teammate name, or a session name from list_agents (append " [ref]" only when list_agents shows two rows with the same name).',
          },
          task_id: {
            type: 'string',
            description:
              'The ID of the background task (from the launch response, a recovered paused task, or a completed task to continue).',
          },
          message: {
            type: 'string',
            description: 'Message text to send.',
            // A peer session's wire format rejects empty content and drops
            // the frame without a receipt, so an empty send has no meaning
            // on any route. This only covers the literal empty string —
            // whitespace-only content passes here and is rejected before
            // delivery on both routes: by `sendToPeer` for peers ('empty'
            // guidance below) and by the team route in `execute`.
            minLength: 1,
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
