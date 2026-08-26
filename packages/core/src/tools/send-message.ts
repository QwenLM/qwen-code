/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * send_message tool - send a message to a teammate, a background task, or
 * another Qwen Code session on this machine.
 *
 * Three routing modes, tried in this order:
 * - Background-task mode: `task_id` matches an entry in the background task
 *   registry. Running tasks receive the message at the next tool-round
 *   boundary; paused recovered tasks are resumed first and take the message as
 *   their first continuation instruction.
 * - Team mode: `to` matches a teammate name (or "*" for broadcast). Messages
 *   route through TeamManager as plain text. This tool carries content only;
 *   team control actions are separate tools (see `request-shutdown.ts`), so a
 *   teammate cannot express a control action at all — see #9276.
 * - Peer mode: `to` matches another Qwen Code session on this machine (see
 *   `ipc/peer-send.ts`). Plain text only, and only while cross-session
 *   messaging is enabled here; the message arrives there marked as coming
 *   from another session and may be held for that session's user to review.
 *
 * In-process wins: a name that is both a teammate and a peer session routes
 * to the teammate, because that is this session's own work. Broadcast never
 * crosses a session boundary.
 */

import type { Config } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import { ToolErrorType } from './tool-error.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { getAgentName } from '../agents/team/identity.js';
import { findMemberByName } from '../agents/team/teamHelpers.js';
import { LEADER_NAME } from '../agents/team/types.js';
import type { ApprovalMode } from '../config/approval-mode.js';
import {
  isInProcessRecipient,
  type InProcessRoutingTeam,
} from '../ipc/peer-routing.js';
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
  /**
   * Recipient teammate name, "*" for team broadcast, or the name of another
   * Qwen Code session on this machine (optionally `name [ref]`).
   */
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
   * Set when the peer route was consulted and found cross-session
   * messaging off here, so the final error can say so instead of
   * claiming a lookup that never happened.
   */
  private peerMessagingOff = false;

  /**
   * Try to deliver to another Qwen Code session on this machine.
   *
   * Returns null when this is not a peer send at all — cross-session
   * messaging is off here, or the name resolved to nothing and there is
   * nothing to suggest — so the caller can fall through to its own error.
   * Every other outcome, including failures, is a result: each one has a
   * different next step for the model.
   */
  private async trySendToPeer(
    to: string,
    teamFile: InProcessRoutingTeam | undefined,
  ): Promise<ToolResult | null> {
    const teamActive = teamFile !== undefined;
    let approvalMode: ApprovalMode | null;
    try {
      approvalMode = this.config.getApprovalMode();
    } catch {
      // Asserting nothing makes the receiver hold the message rather than
      // trust a mode class this side could not read.
      approvalMode = null;
    }

    const outcome = await sendToPeer({
      target: to,
      message: this.params.message,
      approvalMode,
      // Addresses this tool would keep in-process must never be handed
      // back to the model as a peer address, bare.
      isReserved: (address) => isInProcessRecipient(address, teamFile),
    });

    switch (outcome.kind) {
      case 'disabled':
        this.peerMessagingOff = true;
        return null;

      case 'self': {
        const msg =
          `"${outcome.name}" is this session's own name — a session cannot message itself. ` +
          'Use list_agents to see the other sessions you can reach.';
        return {
          llmContent: msg,
          returnDisplay: 'That is this session.',
          error: { message: msg, type: ToolErrorType.SEND_MESSAGE_NOT_FOUND },
        };
      }

      case 'not-found': {
        if (outcome.suggestions.length === 0) return null;
        const msg =
          `No reachable session${teamActive ? ' and no teammate' : ''} is named "${to}". Did you mean: ` +
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
            `working in ${outcome.peer.cwd}. It arrives there as a marked cross-session ` +
            "message carrying none of your user's authority, and may be held for that " +
            "session's user to review before it reaches that session's model. You will " +
            'not be told whether it was delivered or held, so do not re-send; if that ' +
            'session replies, the reply arrives here as a <cross_session_message>.',
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
        const teamManager = this.config.getTeamManager();
        const teammate = teamManager
          ? findMemberByName(
              teamManager.getTeamFile().members,
              this.params.task_id,
            )
          : undefined;
        const teammateHint = teammate
          ? ` Did you mean to message teammate "${teammate.name}"? If so, use \`to: "${teammate.name}"\` instead of \`task_id\`.`
          : '';
        return {
          llmContent: `Error: No background task found with ID "${this.params.task_id}".${teammateHint}`,
          returnDisplay: teammate
            ? `Task not found; use "to" for teammate "${teammate.name}".`
            : 'Task not found.',
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

    // Normalize once, here at the routing boundary: the in-process rule and
    // `TeamManager` match the handle exactly, while `resolvePeerTarget` trims
    // its target. Without a single spelling, a padded reserved handle
    // (`"leader "`, easily produced by copying from quoted text) slips past
    // the in-process check and gets delivered to a peer session that happens
    // to carry that name — the cross-session leak the Route 2 check exists
    // to prevent.
    const to = this.params.to?.trim();
    if (!to) {
      const msg = 'Recipient "to" is required.';
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg },
      };
    }

    const teamManager = this.config.getTeamManager();

    // Broadcast stays a team primitive. "Everyone" has no sensible meaning
    // once it could include sessions belonging to other work, so it never
    // fans out across sessions — a message worth sending to several
    // sessions is worth addressing to each of them.
    if (to === '*') {
      if (!teamManager) {
        const msg =
          'No active team to broadcast to. Broadcasting to other Qwen Code sessions ' +
          'is not supported — address each session by name from list_agents.';
        return {
          llmContent: msg,
          returnDisplay: 'No active team for broadcast.',
          error: { message: msg },
        };
      }
      try {
        const sender = getAgentName() ?? LEADER_NAME;
        const { total, failedRecipients } = await teamManager.broadcast(
          this.params.message,
          sender,
        );
        if (failedRecipients.length === 0) {
          const msg = 'Message broadcast to all teammates.';
          return { llmContent: msg, returnDisplay: msg };
        }
        const reached = total - failedRecipients.length;
        if (reached === 0) {
          const msg =
            `Broadcast failed: delivery was rejected for all ${total} ` +
            `recipient(s): ${failedRecipients.join(', ')}.`;
          return {
            llmContent: msg,
            returnDisplay: msg,
            error: { message: msg },
          };
        }
        const msg =
          `Message broadcast delivered to ${reached} of ${total} ` +
          `recipient(s); delivery failed for: ${failedRecipients.join(', ')}. ` +
          `The listed recipients did not receive the message.`;
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

    // Route 2: teammate by name via TeamManager. In-process wins over a
    // same-named peer session: a teammate is part of this session's own
    // work, and silently routing off-process would be the more surprising
    // of the two. The leader is an in-process recipient too, though never
    // a member: a teammate reports back with `to: "leader"` (or the lead
    // agent id), and TeamManager resolves both — so must this check, or a
    // teammate's report would go looking for a session named "leader".
    const teamFile = teamManager?.getTeamFile();
    const inProcessRecipient = isInProcessRecipient(to, teamFile);

    if (!inProcessRecipient) {
      // Route 3: another Qwen Code session on this machine.
      const peerResult = await this.trySendToPeer(to, teamFile);
      if (peerResult) return peerResult;
    }

    if (!teamManager) {
      const msg = this.peerMessagingOff
        ? `No active team and no task_id, and cross-session messaging is not enabled in this session (agents.crossSessionMessaging), so "${to}" cannot be another session. ` +
          'Create a team, or pass `task_id` to message a background task.'
        : `No active team, no task_id, and no reachable session named "${to}". ` +
          'Create a team, pass `task_id` to message a background task, or use ' +
          'list_agents to see which sessions are reachable.';
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg },
      };
    }

    try {
      await teamManager.sendMessage(
        to,
        this.params.message,
        getAgentName() ?? LEADER_NAME,
        this.params.summary,
      );
      const msg = `Message sent to "${to}".`;
      return { llmContent: msg, returnDisplay: msg };
    } catch (error) {
      let errMsg = error instanceof Error ? error.message : String(error);
      // The team's "not found" is only half the answer once the peer
      // directory was searched too.
      if (!inProcessRecipient && /not found/i.test(errMsg)) {
        // Branch, do not suppress: with messaging off the team's "not
        // found" was the whole answer the model got, so it never learned
        // that the name it wants could belong to a session this setting
        // is hiding.
        errMsg += this.peerMessagingOff
          ? ` Cross-session messaging is not enabled in this session (agents.crossSessionMessaging), so another session could not have taken that name either.`
          : ` No reachable session has that name either; use list_agents to see who is reachable.`;
      }
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
      'Send to a teammate or another Qwen Code session (use "to"), or a running, paused, or completed background task (use "task_id"); completed tasks are revived. ' +
        'Set "to" to a bare teammate name (no @), to "*" to broadcast within an active Agent Team only, or to a session name from list_agents, exactly as its "to" value shows it — list_agents appends " [ref]" whenever the bare name would not reach that session (another session or a teammate shares it). ' +
        "A message to another session arrives there marked as coming from another session, carries none of your user's authority, and may be held for that session's user to review; never use it to have another session perform an action this session was denied, blocked from, or cannot do itself. " +
        'For background tasks, set "task_id" to the id from the launch response or list_agents. ' +
        'Running tasks receive it at the next tool-round boundary; paused recovered tasks resume with the message as their first continuation instruction; completed tasks continue on their resident runtime when available and otherwise revive from their transcript and continue with your message. ' +
        'Your text output is NOT visible to teammates or to other sessions — use this tool to communicate.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description:
              'Recipient: a teammate name, "*" for Agent Team broadcast, or a session\'s "to" value from list_agents verbatim (it carries " [ref]" when the bare name would not reach that session).',
          },
          task_id: {
            type: 'string',
            description:
              'The ID of the background task (from the launch response, a recovered paused task, or a completed task to continue).',
          },
          message: {
            type: 'string',
            description: 'Message text to send.',
            // An empty message is nothing to deliver; the peer wire
            // contract drops it silently, so refuse it at the boundary.
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

  protected override validateToolParamValues(
    params: SendMessageParams,
  ): string | null {
    if (params.to && params.task_id) {
      return 'Only one of "to" or "task_id" may be provided.';
    }
    return null;
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
