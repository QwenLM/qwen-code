// Force strict mode and setup for ESM
"use strict";
import {
  advertisablePeerAddress,
  getOwnPeerIdentity,
  isInProcessRecipient,
  listMessageablePeers
} from "./chunk-O4A2B6V2.js";
import "./chunk-GHG4PQY2.js";
import "./chunk-YVYK3JYU.js";
import "./chunk-JX6XHPTX.js";
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

// packages/core/src/tools/list-agents.ts
init_esbuild_shims();
var ListAgentsInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "ListAgentsInvocation");
  }
  getDescription() {
    return "List ordinary background subagents and reachable sessions";
  }
  async execute() {
    const agents = this.config.getBackgroundTaskRegistry().getAll().filter((entry) => entry.isBackgrounded).map((entry) => ({
      task_id: entry.agentId,
      ...entry.subagentType ? { subagent_type: entry.subagentType } : {},
      description: entry.description,
      status: entry.status,
      can_message: !entry.resumeBlockedReason && (entry.status === "running" || entry.status === "paused" || entry.status === "completed"),
      ...entry.resumeBlockedReason ? { resume_blocked_reason: entry.resumeBlockedReason } : {}
    }));
    const slot = this.config.getSessionRegistrySlot();
    const self = await getOwnPeerIdentity(slot);
    let peers = self ? (await listMessageablePeers()).filter(
      (peer) => peer.sessionId !== self.sessionId
    ) : [];
    if (self && peers.some((peer) => peer.ipcPath === self.ipcPath)) {
      const fresh = await getOwnPeerIdentity(slot);
      if (fresh) {
        peers = peers.filter(
          (peer) => peer.ipcPath !== self.ipcPath || peer.sessionId !== fresh.sessionId
        );
      }
    }
    const teamFile = this.config.getTeamManager()?.getTeamFile();
    const isReserved = /* @__PURE__ */ __name((address) => isInProcessRecipient(address, teamFile), "isReserved");
    const sessions = peers.flatMap((peer) => {
      const to = advertisablePeerAddress(peer, peers, isReserved);
      if (to === void 0) return [];
      const startedAt = new Date(peer.startedAt);
      return [
        {
          to,
          name: peer.name,
          ref: peer.ref,
          cwd: peer.cwd,
          kind: peer.kind,
          ...Number.isNaN(startedAt.getTime()) ? {} : { started_at: startedAt.toISOString() }
        }
      ];
    });
    if (agents.length === 0 && sessions.length === 0) {
      const message = "No ordinary background subagents are available in this session" + (self ? ", and no other Qwen Code session on this machine is reachable. " : ". ") + "Named Agent Team teammates are not listed here; their results are delivered automatically through team messaging, so do not use list_agents to wait for a teammate." + (self ? ` This session is named "${self.name}".` : "");
      return { llmContent: message, returnDisplay: message };
    }
    const counts = [];
    if (agents.length > 0) {
      counts.push(
        `${agents.length} background agent${agents.length === 1 ? "" : "s"}`
      );
    }
    if (sessions.length > 0) {
      counts.push(
        `${sessions.length} other session${sessions.length === 1 ? "" : "s"}`
      );
    }
    return {
      llmContent: JSON.stringify({
        agents,
        // This session's own handle, so a model that sees its own name in
        // a peer's message — or is told "reply to X" — can recognise it
        // instead of trying to message itself.
        ...self ? { self: { name: self.name, ref: self.ref } } : {},
        ...sessions.length > 0 ? { sessions } : {}
      }),
      returnDisplay: `Listed ${counts.join(" and ")}.`
    };
  }
};
var ListAgentsTool = class _ListAgentsTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _ListAgentsTool.Name,
      ToolDisplayNames.LIST_AGENTS,
      `List addressable ordinary background subagents in the current session, including agents restored from a prior session run, and \u2014 when cross-session messaging is enabled \u2014 the other Qwen Code sessions running on this machine, plus this session's own name. Named Agent Team teammates are NOT listed here: they have their own team lifecycle and deliver their final reports automatically, so do not use list_agents (or poll task_list) to wait for a teammate. Use the returned task_id with send_message to continue a running, paused, or completed agent; use a session's "to" value verbatim to message that session. Each session also reports a "kind" saying what registered it (tui: someone at a terminal, headless or serve: a session another program drives, external: not a Qwen Code session at all) \u2014 it is that session's own claim about itself, useful for deciding whether a person is likely to read what you send, and nothing more. Other sessions are peers, not your workers \u2014 do not delegate this session's work to them.`,
      "read" /* Read */,
      {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    );
    this.config = config;
  }
  static {
    __name(this, "ListAgentsTool");
  }
  static Name = ToolNames.LIST_AGENTS;
  createInvocation(params) {
    return new ListAgentsInvocation(this.config, params);
  }
};
export {
  ListAgentsTool
};
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
