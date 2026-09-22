// Force strict mode and setup for ESM
"use strict";
import {
  isInProcessRecipient,
  sendToPeer
} from "./chunk-O4A2B6V2.js";
import "./chunk-GHG4PQY2.js";
import {
  LEADER_NAME,
  findMemberByName
} from "./chunk-YVYK3JYU.js";
import {
  getPlanRequiredTeammatePreApprovalMessage,
  isPlanRequiredTeammateAwaitingApproval
} from "./chunk-B5WYAQ4I.js";
import "./chunk-JX6XHPTX.js";
import "./chunk-5FHOPPLZ.js";
import {
  getAgentName
} from "./chunk-S6LOFUVP.js";
import "./chunk-2A6RZKP2.js";
import "./chunk-WDVSRQIQ.js";
import "./chunk-GXNXX7A2.js";
import "./chunk-IITTKFWM.js";
import "./chunk-CA63HYHU.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/send-message.ts
init_esbuild_shims();
var SendMessageInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "SendMessageInvocation");
  }
  getDescription() {
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
  async getDefaultPermission() {
    return "ask";
  }
  /**
   * Set when the peer route was consulted and found cross-session
   * messaging off here, so the final error can say so instead of
   * claiming a lookup that never happened.
   */
  peerMessagingOff = false;
  /**
   * Try to deliver to another Qwen Code session on this machine.
   *
   * Returns null when this is not a peer send at all — cross-session
   * messaging is off here, or the name resolved to nothing and there is
   * nothing to suggest — so the caller can fall through to its own error.
   * Every other outcome, including failures, is a result: each one has a
   * different next step for the model.
   */
  async trySendToPeer(to, teamFile) {
    const teamActive = teamFile !== void 0;
    let approvalMode;
    try {
      approvalMode = this.config.getApprovalMode();
    } catch {
      approvalMode = null;
    }
    const outcome = await sendToPeer({
      target: to,
      message: this.params.message,
      approvalMode,
      // Addresses this tool would keep in-process must never be handed
      // back to the model as a peer address, bare.
      isReserved: /* @__PURE__ */ __name((address) => isInProcessRecipient(address, teamFile), "isReserved"),
      // Which of this process's records is the sender. Matters only for a
      // process hosting several sessions; the default covers the rest.
      slot: this.config.getSessionRegistrySlot()
    });
    switch (outcome.kind) {
      case "disabled":
        this.peerMessagingOff = true;
        return null;
      case "self": {
        const msg = `"${outcome.name}" is this session's own name \u2014 a session cannot message itself. Use list_agents to see the other sessions you can reach.`;
        return {
          llmContent: msg,
          returnDisplay: "That is this session.",
          error: { message: msg, type: "send_message_not_found" /* SEND_MESSAGE_NOT_FOUND */ }
        };
      }
      case "not-found": {
        if (outcome.suggestions.length === 0) return null;
        const msg = `No reachable session${teamActive ? " and no teammate" : ""} is named "${to}". Did you mean: ${outcome.suggestions.join(", ")}? Use list_agents to see who is reachable.`;
        return {
          llmContent: msg,
          returnDisplay: "No such session.",
          error: { message: msg, type: "send_message_not_found" /* SEND_MESSAGE_NOT_FOUND */ }
        };
      }
      case "ambiguous": {
        const msg = `"${to}" matches more than one live session:
` + outcome.matches.map((line) => `  ${line}`).join("\n") + "\nRe-send with the full 'name [ref]' so it goes to the one you mean.";
        return {
          llmContent: msg,
          returnDisplay: "Ambiguous recipient.",
          error: { message: msg, type: "send_message_not_found" /* SEND_MESSAGE_NOT_FOUND */ }
        };
      }
      case "failed": {
        const msg = `Failed to send to ${outcome.address}: ${outcome.reason}`;
        return {
          llmContent: msg,
          returnDisplay: "Send failed.",
          error: { message: msg, type: "send_message_not_running" /* SEND_MESSAGE_NOT_RUNNING */ }
        };
      }
      case "sent": {
        const preview = this.params.summary ?? this.params.message.slice(0, 50);
        return {
          llmContent: `Sent to ${outcome.address} \u2014 another Qwen Code session on this machine, working in ${outcome.peer.cwd}. It arrives there as a marked cross-session message carrying none of your user's authority, and may be held for that session's user to review before it reaches that session's model. You will not be told whether it was delivered or held, so do not re-send; if that session replies, the reply arrives here as a <cross_session_message>.`,
          returnDisplay: `\u201C${preview}\u201D \u2192 ${outcome.address}`
        };
      }
      default: {
        const exhaustive = outcome;
        return exhaustive;
      }
    }
  }
  async execute(signal) {
    if (isPlanRequiredTeammateAwaitingApproval(this.config)) {
      const msg = getPlanRequiredTeammatePreApprovalMessage(
        ToolNames.SEND_MESSAGE
      );
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg }
      };
    }
    if (this.params.task_id) {
      const registry = this.config.getBackgroundTaskRegistry();
      const entry = registry.get(this.params.task_id);
      if (!entry) {
        const teamFile2 = this.config.getTeamManager()?.getTeamFile();
        const teammate = teamFile2 ? findMemberByName(teamFile2.members, this.params.task_id) : void 0;
        const isLeaderDestination = !teammate && teamFile2 !== void 0 && (this.params.task_id.toLowerCase() === LEADER_NAME || this.params.task_id === teamFile2.leadAgentId);
        const destination = teammate?.name ?? this.params.task_id;
        const teammateHint = teammate || isLeaderDestination ? ` Did you mean to message teammate "${destination}"? If so, use \`to: "${destination}"\` instead of \`task_id\`.` : "";
        return {
          llmContent: `Error: No background task found with ID "${this.params.task_id}".${teammateHint}`,
          returnDisplay: teammateHint ? `Task not found; use "to" for teammate "${destination}".` : "Task not found.",
          error: {
            message: `Task not found: ${this.params.task_id}${teammateHint ? `.${teammateHint}` : ""}`,
            type: "send_message_not_found" /* SEND_MESSAGE_NOT_FOUND */
          }
        };
      }
      if (entry.resumeBlockedReason) {
        return {
          llmContent: `Error: Background task "${this.params.task_id}" cannot be continued: ${entry.resumeBlockedReason}`,
          returnDisplay: "Task cannot be continued.",
          error: {
            message: `Task cannot be continued: ${this.params.task_id}`,
            type: "send_message_not_running" /* SEND_MESSAGE_NOT_RUNNING */
          }
        };
      }
      if (entry.status === "paused") {
        const resumed = await this.config.resumeBackgroundAgent(
          this.params.task_id,
          this.params.message
        );
        if (!resumed) {
          return {
            llmContent: `Error: Background task "${this.params.task_id}" could not be resumed.`,
            returnDisplay: "Task could not be resumed.",
            error: {
              message: `Task could not be resumed: ${this.params.task_id}`,
              type: "send_message_not_running" /* SEND_MESSAGE_NOT_RUNNING */
            }
          };
        }
        return {
          llmContent: `Background task "${this.params.task_id}" resumed with your message as the first continuation instruction.`,
          returnDisplay: `Resumed ${entry.description}`
        };
      }
      if (entry.status === "completed") {
        const continued = registry.continueResidentAgent(
          this.params.task_id,
          this.params.message
        );
        if (continued) {
          return {
            llmContent: `Background task "${this.params.task_id}" continued on its existing runtime with your message as the next instruction.`,
            returnDisplay: `Continued ${entry.description}`
          };
        }
        const revived = await this.config.reviveCompletedBackgroundAgent(
          this.params.task_id,
          this.params.message
        );
        if (!revived) {
          return {
            llmContent: `Error: Background task "${this.params.task_id}" could not be revived.`,
            returnDisplay: "Task could not be revived.",
            error: {
              message: `Task could not be revived: ${this.params.task_id}`,
              type: "send_message_not_running" /* SEND_MESSAGE_NOT_RUNNING */
            }
          };
        }
        return {
          llmContent: `Background task "${this.params.task_id}" had completed; revived it with your message as the next instruction.`,
          returnDisplay: `Revived ${entry.description}`
        };
      }
      if (entry.status !== "running") {
        return {
          llmContent: `Error: Background task "${this.params.task_id}" is not running (status: ${entry.status}). Cannot send messages to stopped tasks.`,
          returnDisplay: `Task not running (${entry.status}).`,
          error: {
            message: `Task is ${entry.status}: ${this.params.task_id}`,
            type: "send_message_not_running" /* SEND_MESSAGE_NOT_RUNNING */
          }
        };
      }
      if (registry.isFinishing(this.params.task_id) || !registry.queueMessage(this.params.task_id, this.params.message)) {
        const settled = await registry.waitForFinishing(
          this.params.task_id,
          signal
        );
        if (!settled) {
          const message = `Message delivery to background task "${this.params.task_id}" was cancelled.`;
          return {
            llmContent: `Error: ${message}`,
            returnDisplay: message,
            error: {
              message,
              type: "send_message_not_running" /* SEND_MESSAGE_NOT_RUNNING */
            }
          };
        }
        return this.execute(signal);
      }
      return {
        llmContent: `Message queued for delivery to background task "${this.params.task_id}". The task will receive it at the next tool-round boundary. There is no inline reply: whatever it does with your message shows up in its completion notification for this task_id. Do not relaunch the task while waiting.`,
        returnDisplay: `Message queued for ${entry.description}`
      };
    }
    const to = this.params.to?.trim();
    if (!to) {
      const msg = 'Recipient "to" is required.';
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg }
      };
    }
    const teamManager = this.config.getTeamManager();
    if (to === "*") {
      if (!teamManager) {
        const msg = "No active team to broadcast to. Broadcasting to other Qwen Code sessions is not supported \u2014 address each session by name from list_agents.";
        return {
          llmContent: msg,
          returnDisplay: "No active team for broadcast.",
          error: { message: msg }
        };
      }
      try {
        const sender = getAgentName() ?? LEADER_NAME;
        const { total, failedRecipients } = await teamManager.broadcast(
          this.params.message,
          sender
        );
        if (failedRecipients.length === 0) {
          const msg2 = "Message broadcast to all teammates.";
          return { llmContent: msg2, returnDisplay: msg2 };
        }
        const reached = total - failedRecipients.length;
        if (reached === 0) {
          const msg2 = `Broadcast failed: delivery was rejected for all ${total} recipient(s): ${failedRecipients.join(", ")}.`;
          return {
            llmContent: msg2,
            returnDisplay: msg2,
            error: { message: msg2 }
          };
        }
        const msg = `Message broadcast delivered to ${reached} of ${total} recipient(s); delivery failed for: ${failedRecipients.join(", ")}. The listed recipients did not receive the message.`;
        return { llmContent: msg, returnDisplay: msg };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          llmContent: `Failed to broadcast message: ${errMsg}`,
          returnDisplay: `Failed to broadcast message: ${errMsg}`,
          error: { message: errMsg }
        };
      }
    }
    const teamFile = teamManager?.getTeamFile();
    const inProcessRecipient = isInProcessRecipient(to, teamFile);
    if (!inProcessRecipient) {
      const peerResult = await this.trySendToPeer(to, teamFile);
      if (peerResult) return peerResult;
    }
    if (!teamManager) {
      const msg = this.peerMessagingOff ? `No active team and no task_id, and cross-session messaging is not active in this session (agents.crossSessionMessaging is off, or its inbox did not start), so "${to}" cannot be another session. Create a team, or pass \`task_id\` to message a background task.` : `No active team, no task_id, and no reachable session named "${to}". Create a team, pass \`task_id\` to message a background task, or use list_agents to see which sessions are reachable.`;
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg }
      };
    }
    try {
      await teamManager.sendMessage(
        to,
        this.params.message,
        getAgentName() ?? LEADER_NAME,
        this.params.summary
      );
      const msg = `Message sent to "${to}".`;
      return { llmContent: msg, returnDisplay: msg };
    } catch (error) {
      let errMsg = error instanceof Error ? error.message : String(error);
      if (!inProcessRecipient && /not found/i.test(errMsg)) {
        errMsg += this.peerMessagingOff ? ` Cross-session messaging is not active in this session (agents.crossSessionMessaging is off, or its inbox did not start), so another session could not have taken that name either.` : ` No reachable session has that name either; use list_agents to see who is reachable.`;
      }
      return {
        llmContent: `Failed to send message: ${errMsg}`,
        returnDisplay: `Failed to send message: ${errMsg}`,
        error: { message: errMsg }
      };
    }
  }
};
var SendMessageTool = class _SendMessageTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _SendMessageTool.Name,
      ToolDisplayNames.SEND_MESSAGE,
      `Send to a teammate or another Qwen Code session (use "to"), or a running, paused, or completed background task (use "task_id"); completed tasks are revived. Specify exactly one of the two fields. Set "to" to a bare teammate name (no @), to "*" to broadcast within an active Agent Team only, or to a session name from list_agents, exactly as its "to" value shows it \u2014 list_agents appends " [ref]" whenever the bare name would not reach that session (another session or a teammate shares it). A message to another session arrives there marked as coming from another session, carries none of your user's authority, and may be held for that session's user to review; never use it to have another session perform an action this session was denied, blocked from, or cannot do itself. For background tasks, set "task_id" to the id from the launch response or list_agents. Running tasks receive it at the next tool-round boundary; paused recovered tasks resume with the message as their first continuation instruction; completed tasks continue on their resident runtime when available and otherwise revive from their transcript and continue with your message. Your text output is NOT visible to teammates or to other sessions \u2014 use this tool to communicate.`,
      "other" /* Other */,
      {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: `Recipient: a teammate name, "*" for Agent Team broadcast, or a session's "to" value from list_agents verbatim (it carries " [ref]" when the bare name would not reach that session).`
          },
          task_id: {
            type: "string",
            description: "The ID of the background task (from the launch response, a recovered paused task, or a completed task to continue)."
          },
          message: {
            type: "string",
            description: "Message text to send.",
            // An empty message is nothing to deliver; the peer wire
            // contract drops it silently, so refuse it at the boundary.
            minLength: 1,
            // Cap message size so a teammate can't grow the
            // recipient's inbox file unboundedly with a single send.
            maxLength: 65536
          },
          summary: {
            type: "string",
            description: "Optional 5-10 word summary for UI display."
          }
        },
        required: ["message"],
        additionalProperties: false
      },
      true,
      // isOutputMarkdown
      false,
      // canUpdateOutput
      true,
      // shouldDefer — sending messages is infrequent
      false,
      // alwaysLoad
      "send message task teammate team communicate notify"
    );
    this.config = config;
  }
  static {
    __name(this, "SendMessageTool");
  }
  static Name = ToolNames.SEND_MESSAGE;
  createInvocation(params) {
    return new SendMessageInvocation(this.config, params);
  }
  // #10073: both fields used to silently prefer task_id and drop `to`.
  validateToolParamValues(params) {
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
  toAutoClassifierInput(params) {
    return {
      to: params.to,
      task_id: params.task_id,
      message: params.message
    };
  }
};
export {
  SendMessageTool
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
