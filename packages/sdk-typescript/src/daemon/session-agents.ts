/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser-facing wire shapes for session-centric multi-agent collaboration.
 *
 * Mirror of the shapes in
 * `packages/core/src/agents/session-agents/contract.ts` (web-shell cannot
 * import core). Keep both in sync; the core file is the source of truth.
 */

export type SessionAgentProgram = 'qwen' | 'claude' | 'codex';

export type SessionAgentRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'offline';

export type SessionAgentTerminalStatus = Extract<
  SessionAgentRunStatus,
  'completed' | 'failed' | 'cancelled' | 'offline'
>;

export interface SessionAgentStep {
  id: string;
  title: string;
  status: 'running' | 'completed' | 'failed';
}

export interface SessionAgentAuthor {
  agentId: string;
  name: string;
  color?: string;
  program?: SessionAgentProgram;
  runtimeId?: string;
  /** Set when the agent ran as the leader of this squad. */
  squadName?: string;
  /**
   * Set on a member's reply its squad's leader was waiting on: the squad it
   * answered for. Display only; leader logic keys on `squadName`.
   */
  memberSquadName?: string;
}

/** `no_action`: a squad leader's empty reply, rendered as a muted line. */
export type SessionSquadOutcome = 'no_action';

/** `_meta.qwenAgentMessage` on a transcript update (live or replayed). */
export interface QwenAgentMessageMeta {
  kind: 'agent_message' | 'agent_mention';
  author?: SessionAgentAuthor;
  runId?: string;
  status?: SessionAgentTerminalStatus;
  error?: string;
  steps?: SessionAgentStep[];
  totalTokens?: number;
  mentionedAgentIds?: string[];
  mentionedSquadIds?: string[];
  squadOutcome?: SessionSquadOutcome;
}

export const QWEN_AGENT_MESSAGE_META_KEY = 'qwenAgentMessage';

export interface SessionAgentPermissionPrompt {
  requestId: string;
  title: string;
  toolName?: string;
  inputPreview?: string;
  options: Array<{
    optionId: string;
    name: string;
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  }>;
}

/** Live run frame from `GET /workspaces/:ws/agent/session-events?sessionId=`. */
export interface SessionAgentRunFrame {
  type: 'run';
  sessionId: string;
  runId: string;
  author: SessionAgentAuthor;
  status: SessionAgentRunStatus;
  queuePosition?: number;
  outputText?: string;
  thoughtText?: string;
  steps?: SessionAgentStep[];
  permission?: SessionAgentPermissionPrompt;
  error?: string;
  totalTokens?: number;
  activityAt: number;
  /**
   * Record state of a terminal frame (never on a non-terminal one):
   * `true` the `agent_message` record is in the transcript, drop the card;
   * `false` the record is pending, or the run is `retryable`, keep the card;
   * absent no record will be written (cancelled while queued, dismissed,
   * retried), drop the card.
   */
  recorded?: boolean;
  recordId?: string;
  /**
   * A finished run with no record that can run again (interrupted by a
   * daemon restart, its runtime went offline, or its record was lost in a
   * restart): offer Retry (`POST …/runs/:runId/retry`) and Dismiss
   * (`POST …/runs/:runId/cancel`).
   */
  retryable?: boolean;
  /** Set on the final frame of a retried run: the run that replaces it. */
  retriedAsRunId?: string;
  /** The squad engagement this run belongs to (leader or delegated member). */
  squadId?: string;
  squadName?: string;
}

export interface SessionAgentChangedFrame {
  type: 'changed';
  scope: 'agents' | 'runtimes' | 'squads';
}

export type SessionAgentEventFrame =
  | SessionAgentRunFrame
  | SessionAgentChangedFrame;

export interface SessionSquadMember {
  agentId: string;
  role?: string;
}

export interface SessionSquad {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  leaderAgentId: string;
  members: SessionSquadMember[];
  createdAt: number;
  updatedAt: number;
  retiredAt?: number;
}

export type SessionSquadLeaderIssue = 'missing' | 'retired' | 'disabled';

/** `GET /workspaces/:ws/agent/squads` entry: names resolved on the daemon. */
export interface SessionSquadView extends SessionSquad {
  leaderName?: string;
  /** Set when the squad cannot be activated until its leader is fixed. */
  leaderIssue?: SessionSquadLeaderIssue;
  members: Array<SessionSquadMember & { name: string }>;
}

const AGENT_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'offline']);

/** Narrow an unknown `_meta.qwenAgentMessage` value. */
export function parseQwenAgentMessageMeta(
  value: unknown,
): QwenAgentMessageMeta | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record['kind'] !== 'agent_message' &&
    record['kind'] !== 'agent_mention'
  ) {
    return undefined;
  }
  const authorRaw = record['author'];
  let author: SessionAgentAuthor | undefined;
  if (authorRaw && typeof authorRaw === 'object' && !Array.isArray(authorRaw)) {
    const a = authorRaw as Record<string, unknown>;
    if (typeof a['agentId'] === 'string' && typeof a['name'] === 'string') {
      author = {
        agentId: a['agentId'],
        name: a['name'],
        ...(typeof a['color'] === 'string' ? { color: a['color'] } : {}),
        ...(a['program'] === 'qwen' ||
        a['program'] === 'claude' ||
        a['program'] === 'codex'
          ? { program: a['program'] }
          : {}),
        ...(typeof a['runtimeId'] === 'string'
          ? { runtimeId: a['runtimeId'] }
          : {}),
        ...(typeof a['squadName'] === 'string' && a['squadName']
          ? { squadName: a['squadName'] }
          : {}),
        ...(typeof a['memberSquadName'] === 'string' && a['memberSquadName']
          ? { memberSquadName: a['memberSquadName'] }
          : {}),
      };
    }
  }
  const status =
    typeof record['status'] === 'string' && AGENT_TERMINAL.has(record['status'])
      ? (record['status'] as SessionAgentTerminalStatus)
      : undefined;
  const steps = Array.isArray(record['steps'])
    ? (record['steps'] as unknown[]).flatMap((step) => {
        if (!step || typeof step !== 'object') return [];
        const s = step as Record<string, unknown>;
        if (typeof s['id'] !== 'string' || typeof s['title'] !== 'string') {
          return [];
        }
        const stepStatus: SessionAgentStep['status'] =
          s['status'] === 'running' ||
          s['status'] === 'completed' ||
          s['status'] === 'failed'
            ? s['status']
            : 'completed';
        return [{ id: s['id'], title: s['title'], status: stepStatus }];
      })
    : undefined;
  const mentioned = Array.isArray(record['mentionedAgentIds'])
    ? (record['mentionedAgentIds'] as unknown[]).filter(
        (id): id is string => typeof id === 'string',
      )
    : undefined;
  const mentionedSquads = Array.isArray(record['mentionedSquadIds'])
    ? (record['mentionedSquadIds'] as unknown[]).filter(
        (id): id is string => typeof id === 'string',
      )
    : undefined;
  return {
    kind: record['kind'],
    ...(author ? { author } : {}),
    ...(typeof record['runId'] === 'string' ? { runId: record['runId'] } : {}),
    ...(status ? { status } : {}),
    ...(typeof record['error'] === 'string' ? { error: record['error'] } : {}),
    ...(steps ? { steps } : {}),
    ...(typeof record['totalTokens'] === 'number'
      ? { totalTokens: record['totalTokens'] }
      : {}),
    ...(mentioned ? { mentionedAgentIds: mentioned } : {}),
    ...(mentionedSquads && mentionedSquads.length > 0
      ? { mentionedSquadIds: mentionedSquads }
      : {}),
    ...(record['squadOutcome'] === 'no_action'
      ? { squadOutcome: 'no_action' as const }
      : {}),
  };
}
