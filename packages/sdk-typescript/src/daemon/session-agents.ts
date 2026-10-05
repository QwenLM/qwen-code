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
}

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

/** Live run frame from `GET /workspaces/:ws/agent/events`. */
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
}

export interface SessionAgentChangedFrame {
  type: 'changed';
  scope: 'agents' | 'runtimes';
}

export type SessionAgentEventFrame =
  | SessionAgentRunFrame
  | SessionAgentChangedFrame;

const AGENT_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'offline']);

/** Narrow an unknown `_meta.qwenAgentMessage` value. */
export function parseQwenAgentMessageMeta(
  value: unknown,
): QwenAgentMessageMeta | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record['kind'] !== 'agent_message' && record['kind'] !== 'agent_mention') {
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
        const stepStatus =
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
  };
}
