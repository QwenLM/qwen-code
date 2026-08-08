/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  formatPeerAddress,
  listMessageablePeers,
} from '../ipc/peer-directory.js';
import { getOwnPeerIdentity } from '../ipc/peer-send.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';

export type ListAgentsParams = Record<string, never>;

class ListAgentsInvocation extends BaseToolInvocation<
  ListAgentsParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: ListAgentsParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return 'List background agents';
  }

  async execute(): Promise<ToolResult> {
    const agents = this.config
      .getBackgroundTaskRegistry()
      .getAll()
      .filter((entry) => entry.isBackgrounded)
      .map((entry) => ({
        task_id: entry.agentId,
        ...(entry.subagentType ? { subagent_type: entry.subagentType } : {}),
        description: entry.description,
        status: entry.status,
        can_message:
          !entry.resumeBlockedReason &&
          (entry.status === 'running' ||
            entry.status === 'paused' ||
            entry.status === 'completed'),
        ...(entry.resumeBlockedReason
          ? { resume_blocked_reason: entry.resumeBlockedReason }
          : {}),
      }));

    // Peer sessions are only listed once this session has an inbox of its
    // own: without one a message could be sent but never answered, and
    // advertising a one-way address invites exactly that.
    const self = await getOwnPeerIdentity();
    const peers = self
      ? await listMessageablePeers().then((all) =>
          all.filter((peer) => peer.ipcPath !== self.ipcPath),
        )
      : [];

    const sessions = peers.map((peer) => ({
      // The name IS the address. The ref is only appended when it has to
      // be, so the common case stays a bare, typeable name.
      to: formatPeerAddress(peer, peers),
      name: peer.name,
      ref: peer.ref,
      cwd: peer.cwd,
      started_at: new Date(peer.startedAt).toISOString(),
    }));

    if (agents.length === 0 && sessions.length === 0) {
      const message =
        'No background agents in this session, and no other reachable Qwen Code sessions.';
      return { llmContent: message, returnDisplay: message };
    }

    const parts: string[] = [];
    if (agents.length > 0) {
      parts.push(
        `${agents.length} background agent${agents.length === 1 ? '' : 's'}`,
      );
    }
    if (sessions.length > 0) {
      parts.push(
        `${sessions.length} other session${sessions.length === 1 ? '' : 's'}`,
      );
    }

    return {
      llmContent: JSON.stringify({
        agents,
        ...(sessions.length > 0 ? { sessions } : {}),
      }),
      returnDisplay: `Listed ${parts.join(' and ')}.`,
    };
  }
}

export class ListAgentsTool extends BaseDeclarativeTool<
  ListAgentsParams,
  ToolResult
> {
  static readonly Name = ToolNames.LIST_AGENTS;

  constructor(private readonly config: Config) {
    super(
      ListAgentsTool.Name,
      ToolDisplayNames.LIST_AGENTS,
      'List everything you can message: background agents in this session ' +
        '(including ones restored from a prior run), and other Qwen Code ' +
        "sessions running on this machine. Use an agent's task_id with " +
        'send_message to continue it; use a session\'s "to" value verbatim ' +
        'to message that session. Other sessions are peers, not your ' +
        "workers — do not delegate this session's work to them.",
      Kind.Read,
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    );
  }

  protected createInvocation(
    params: ListAgentsParams,
  ): ToolInvocation<ListAgentsParams, ToolResult> {
    return new ListAgentsInvocation(this.config, params);
  }
}
