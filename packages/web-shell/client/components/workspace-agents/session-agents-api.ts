/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SessionAgentEventFrame,
  SessionAgentRunFrame,
  SessionAgentRunStatus,
} from '@qwen-code/sdk/daemon';
import { subscribeAgentStream, type AgentStreamState } from './agent-events';

/** 202 body of `POST sessions/:sessionId/mentions`. */
export interface SessionMentionResult {
  recordId: string;
  deferred?: boolean;
  runs: Array<{
    runId: string;
    agentId: string;
    status: SessionAgentRunStatus;
  }>;
  /** Why some mentioned squads were not started (the others were). */
  squadError?: string;
}

/**
 * The session-scoped collaboration routes: agents answering @-mentions inside
 * an ordinary chat session.
 */
export interface SessionAgentsApi {
  listRuns(sessionId: string): Promise<{ frames: SessionAgentRunFrame[] }>;
  mention(
    sessionId: string,
    input: { text: string; clientMessageId: string },
  ): Promise<SessionMentionResult>;
  cancelRun(sessionId: string, runId: string): Promise<unknown>;
  /** Runs a failed run marked `retryable` again. */
  retryRun(sessionId: string, runId: string): Promise<unknown>;
  stopAll(sessionId: string): Promise<unknown>;
  respondToPermission(
    sessionId: string,
    runId: string,
    requestId: string,
    optionId: string,
  ): Promise<unknown>;
  subscribe(
    sessionId: string,
    onEvent: (event: SessionAgentEventFrame) => void,
    onState: (state: AgentStreamState) => void,
  ): () => void;
}

export function createSessionAgentsHttpApi(
  baseUrl: string,
  token: string | undefined,
  workspaceCwd: string,
): SessionAgentsApi {
  const root = `${baseUrl.replace(/\/+$/, '')}/workspaces/${encodeURIComponent(
    workspaceCwd,
  )}/agent`;
  const session = (sessionId: string) =>
    `/sessions/${encodeURIComponent(sessionId)}`;
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${root}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    // A proxy or a route mounted after startup can answer with HTML.
    const body = (await response.json().catch(() => ({}))) as T & {
      error?: string;
      message?: string;
    };
    if (!response.ok) {
      throw new Error(
        body.message ||
          body.error ||
          `Agent request failed (${response.status})`,
      );
    }
    return body;
  };
  const post = <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) });

  return {
    listRuns: (sessionId) => request(`${session(sessionId)}/runs`),
    mention: (sessionId, input) =>
      post(`${session(sessionId)}/mentions`, input),
    cancelRun: (sessionId, runId) =>
      post(
        `${session(sessionId)}/runs/${encodeURIComponent(runId)}/cancel`,
        {},
      ),
    retryRun: (sessionId, runId) =>
      post(`${session(sessionId)}/runs/${encodeURIComponent(runId)}/retry`, {}),
    stopAll: (sessionId) => post(`${session(sessionId)}/stop`, {}),
    respondToPermission: (sessionId, runId, requestId, optionId) =>
      post(
        `${session(sessionId)}/runs/${encodeURIComponent(
          runId,
        )}/permission/${encodeURIComponent(requestId)}`,
        { optionId },
      ),
    subscribe: (sessionId, onEvent, onState) =>
      subscribeAgentStream<SessionAgentEventFrame>(
        `${root}/session-events?sessionId=${encodeURIComponent(sessionId)}`,
        token,
        onEvent,
        onState,
      ),
  };
}
