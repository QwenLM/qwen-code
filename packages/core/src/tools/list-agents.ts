/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  listMessageablePeers,
  resolvePeerTarget,
} from '../ipc/peer-directory.js';
import { getOwnPeerIdentity } from '../ipc/peer-send.js';
import { sanitizeName } from '../agents/team/teamHelpers.js';
import { LEADER_NAME } from '../agents/team/types.js';
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
    return 'List ordinary background subagents and reachable sessions';
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
      ? (await listMessageablePeers()).filter(
          (peer) => peer.ipcPath !== self.ipcPath,
        )
      : [];

    // send_message routes a name to an in-process recipient first: a
    // teammate by sanitized name, plus the leader handle and the lead
    // agent id. Validate every candidate against both those routes and
    // the peer-address grammar before advertising it.
    const teamFile = this.config.getTeamManager()?.getTeamFile();
    const memberNames = new Set(
      (teamFile?.members ?? []).map((member) => member.name),
    );
    const intercepted = (address: string): boolean =>
      address.toLowerCase() === LEADER_NAME ||
      address === teamFile?.leadAgentId ||
      memberNames.has(sanitizeName(address));
    const addressFor = (peer: (typeof peers)[number]): string | undefined => {
      const candidates = [
        peer.name,
        `${peer.name} [${peer.ref}]`,
        `[${peer.ref}]`,
      ];
      return candidates.find((candidate) => {
        if (intercepted(candidate)) return false;
        const resolved = resolvePeerTarget(peers, candidate);
        return resolved.kind === 'one' && resolved.peer === peer;
      });
    };
    const sessions = peers.flatMap((peer) => {
      const to = addressFor(peer);
      // A ref collision plus adversarial literal names can leave no string
      // in the supported grammar that uniquely selects this peer. Do not
      // advertise a misleading address that would route elsewhere.
      if (to === undefined) return [];
      // A registry writer can record a finite-but-Date-invalid startedAt;
      // toISOString would throw and take the whole listing down with it.
      const startedAt = new Date(peer.startedAt);
      return [
        {
          to,
          name: peer.name,
          ref: peer.ref,
          cwd: peer.cwd,
          ...(Number.isNaN(startedAt.getTime())
            ? {}
            : { started_at: startedAt.toISOString() }),
        },
      ];
    });

    if (agents.length === 0 && sessions.length === 0) {
      const message =
        'No ordinary background subagents are available in this session' +
        (self
          ? ', and no other Qwen Code session on this machine is reachable. '
          : '. ') +
        'Named Agent Team teammates are not listed here; their results are ' +
        'delivered automatically through team messaging, so do not use ' +
        'list_agents to wait for a teammate.' +
        (self ? ` This session is named "${self.name}".` : '');
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
        // This session's own handle, so a model that sees its own name in
        // a peer's message — or is told "reply to X" — can recognise it
        // instead of trying to message itself.
        ...(self ? { self: { name: self.name, ref: self.ref } } : {}),
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
        'session, including agents restored from a prior session run, and — ' +
        'when cross-session messaging is enabled — the other Qwen Code ' +
        "sessions running on this machine, plus this session's own name. " +
        'Named Agent Team teammates are NOT listed here: they have their own ' +
        'team lifecycle and deliver their final reports automatically, so do ' +
        'not use list_agents (or poll task_list) to wait for a teammate. Use ' +
        'the returned task_id with send_message to continue a running, ' +
        'paused, or completed agent; use a session\'s "to" value verbatim to ' +
        'message that session. Other sessions are peers, not your workers — ' +
        "do not delegate this session's work to them.",
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
