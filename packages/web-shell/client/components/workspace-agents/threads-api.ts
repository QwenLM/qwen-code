/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentCapabilitiesView,
  AgentConfigPatch,
  NewThread,
  NewWorkspaceAgent,
  WorkspaceAgentRuntimeView,
  WorkspaceAgentSummaryView,
} from './ThreadsPage';
import type { ThreadDetailView } from './ThreadView';
import type {
  RoutingPreviewTarget,
  ThreadSummaryView,
} from './agents-view-logic';
import {
  subscribeAgentStream,
  type AgentLiveEvent,
  type AgentStreamState,
} from './agent-events';
import type { JoinToken } from './add-runtime-dialog';
import type { AgentShare, AgentShareSummary } from './share-agent-dialog';

interface CreateThreadResult {
  id: string;
}

export interface ThreadsApi {
  connectRemoteHost?(input: {
    remoteUrl: string;
    remoteToken: string;
    remoteCwd: string;
    serverUrl: string;
    provider: 'qwen';
    allowHttp: boolean;
  }): Promise<unknown>;
  listAgents(): Promise<{
    agents: WorkspaceAgentSummaryView[];
    runtime?: WorkspaceAgentRuntimeView;
    runtimes?: WorkspaceAgentRuntimeView[];
    capabilities?: AgentCapabilitiesView;
  }>;
  /** A single-use token for `qwen serve --join` on another machine. */
  createJoinToken?(): Promise<JoinToken>;
  removeHost?(hostId: string): Promise<unknown>;
  createShare?(agentId: string): Promise<AgentShare>;
  listShares?(agentId: string): Promise<{ shares: AgentShareSummary[] }>;
  revokeShare?(agentId: string, callerId: string): Promise<unknown>;
  listThreads(): Promise<{ threads: ThreadSummaryView[] }>;
  getThread(id: string): Promise<ThreadDetailView>;
  createAgent(input: NewWorkspaceAgent): Promise<unknown>;
  deleteAgent(id: string): Promise<unknown>;
  setAgentEnabled(id: string, enabled: boolean): Promise<unknown>;
  updateAgent(id: string, patch: AgentConfigPatch): Promise<unknown>;
  createThread(input: NewThread): Promise<CreateThreadResult>;
  previewThread(
    assignee?: string,
  ): Promise<{ targets: RoutingPreviewTarget[] }>;
  assignThread(id: string, assignee?: string): Promise<unknown>;
  previewReply(
    id: string,
    text: string,
  ): Promise<{ targets: RoutingPreviewTarget[] }>;
  postReply(id: string, text: string): Promise<unknown>;
  markDone(id: string): Promise<unknown>;
  cancelRun(threadId: string, runId: string): Promise<unknown>;
  /** Live events; absent in tests and older daemons, which then poll. */
  subscribe?(
    onEvent: (event: AgentLiveEvent) => void,
    onState: (state: AgentStreamState) => void,
  ): () => void;
  /** Answers a tool approval an agent is waiting on. */
  respondToPermission?(
    sessionId: string,
    requestId: string,
    optionId: string,
  ): Promise<unknown>;
}

export function createThreadsHttpApi(
  baseUrl: string,
  token: string | undefined,
  workspaceCwd: string,
): ThreadsApi {
  const serverUrl = baseUrl.replace(/\/+$/, '');
  const root = `${serverUrl}/workspaces/${encodeURIComponent(workspaceCwd)}/agent`;
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
    };
    if (!response.ok) {
      throw new Error(
        body.error || `Agent request failed (${response.status})`,
      );
    }
    return body;
  };
  const post = <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) });

  return {
    connectRemoteHost: (input) => post('/hosts/remote-connect', input),
    listAgents: () => request('/agents'),
    createJoinToken: () => post('/hosts/enrollment', {}),
    removeHost: (hostId) =>
      request(`/hosts/${encodeURIComponent(hostId)}`, { method: 'DELETE' }),
    createShare: (agentId) =>
      post(`/agents/${encodeURIComponent(agentId)}/shares`, {}),
    listShares: (agentId) =>
      request(`/agents/${encodeURIComponent(agentId)}/shares`),
    revokeShare: (agentId, callerId) =>
      request(
        `/agents/${encodeURIComponent(agentId)}/shares/${encodeURIComponent(callerId)}`,
        { method: 'DELETE' },
      ),
    listThreads: () => request('/threads'),
    getThread: (id) => request(`/threads/${encodeURIComponent(id)}`),
    createAgent: (input) => post('/agents', input),
    deleteAgent: (id) =>
      request(`/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    setAgentEnabled: (id, enabled) =>
      request(`/agents/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    updateAgent: (id, patch) =>
      request(`/agents/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    createThread: (input) => post('/threads', input),
    previewThread: (assignee) => post('/threads/preview', { assignee }),
    assignThread: (id, assignee) =>
      request(`/threads/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ assignee: assignee ?? null }),
      }),
    previewReply: (id, text) =>
      post(`/threads/${encodeURIComponent(id)}/preview`, { text }),
    postReply: (id, text) =>
      post(`/threads/${encodeURIComponent(id)}/posts`, { text }),
    markDone: (id) => post(`/threads/${encodeURIComponent(id)}/done`, {}),
    cancelRun: (threadId, runId) =>
      post(
        `/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/cancel`,
        {},
      ),
    subscribe: (onEvent, onState) =>
      subscribeAgentStream(`${root}/events`, token, onEvent, onState),
    respondToPermission: async (sessionId, requestId, optionId) => {
      const response = await fetch(
        `${serverUrl}/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ outcome: { outcome: 'selected', optionId } }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error || `Approval failed (${response.status})`);
      }
    },
  };
}
