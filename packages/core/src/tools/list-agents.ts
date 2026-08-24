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

function formatStartedAt(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString();
}

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
    return 'List addressable agents and peer sessions';
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

    // The inbox address is also the experimental send-side gate: without
    // one, this session cannot receive replies or delivery receipts.
    const self = await getOwnPeerIdentity();
    const peers = self
      ? (await listMessageablePeers()).filter(
          (peer) => peer.ipcPath !== self.ipcPath,
        )
      : [];
    const sessions = peers.map((peer) => ({
      to: formatPeerAddress(peer),
      name: peer.name,
      ref: peer.ref,
      cwd: peer.cwd,
      started_at: formatStartedAt(peer.startedAt),
    }));

    if (agents.length === 0 && sessions.length === 0) {
      if (self) {
        const message =
          'No ordinary background subagents are available in this session, and no other reachable Qwen Code sessions were found.';
        return { llmContent: message, returnDisplay: message };
      }
      const message =
        'No ordinary background subagents are available in this session. ' +
        'Named Agent Team teammates are not listed here; their results are ' +
        'delivered automatically through team messaging, so do not use ' +
        'list_agents to wait for a teammate.';
      return { llmContent: message, returnDisplay: message };
    }

    const counts: string[] = [];
    if (agents.length > 0) {
      counts.push(
        `${agents.length} background agent${agents.length === 1 ? '' : 's'}`,
      );
    }
    if (sessions.length > 0) {
      counts.push(
        `${sessions.length} other session${sessions.length === 1 ? '' : 's'}`,
      );
    }

    return {
      llmContent: JSON.stringify({
        agents,
        ...(sessions.length > 0 ? { sessions } : {}),
      }),
      returnDisplay: `Listed ${counts.join(' and ')}.`,
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
      'List addressable ordinary background subagents in the current ' +
        'session, including agents restored from a prior session run, plus ' +
        'other reachable Qwen Code sessions on this machine when experimental ' +
        'cross-session messaging is enabled. Use a session\'s "to" value ' +
        'verbatim with send_message. Named ' +
        'Agent Team teammates are NOT listed here: they have their own team ' +
        'lifecycle and deliver their final reports automatically, so do not ' +
        'use list_agents (or poll task_list) to wait for a teammate. Use the ' +
        'returned task_id with send_message to continue a running, paused, ' +
        'or completed agent.',
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
