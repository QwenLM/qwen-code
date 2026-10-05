/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentCapabilitiesView,
  AgentConfigPatch,
  NewWorkspaceAgent,
  WorkspaceAgentRuntimeView,
  WorkspaceAgentSummaryView,
} from './ThreadsPage';
import { subscribeAgentStream, type AgentStreamState } from './agent-events';
import type {
  ConnectExistingInput,
  JoinCoordinatorInput,
  JoinToken,
} from './add-runtime-dialog';
import type { AgentShare, AgentShareSummary } from './share-agent-dialog';

/**
 * The Host connection protocol still names its provider on the wire, and the
 * daemon accepts only this one (`routes/agent-host-connection.ts`). Which
 * programs a runtime can run is reported separately, per runtime.
 * TODO(multi-agent): drop once the connect routes stop requiring `provider`.
 */
const HOST_PROTOCOL_PROVIDER = 'qwen';

/** Agent roster, runtimes, enrollment and sharing for one workspace. */
export interface ThreadsApi {
  connectRemoteHost?(input: ConnectExistingInput): Promise<unknown>;
  /** Makes this daemon a runtime of another coordinator. */
  joinCoordinator?(input: JoinCoordinatorInput): Promise<unknown>;
  listAgents(): Promise<{
    agents: WorkspaceAgentSummaryView[];
    runtime?: WorkspaceAgentRuntimeView;
    runtimes?: WorkspaceAgentRuntimeView[];
    capabilities?: AgentCapabilitiesView;
  }>;
  /** A single-use token for `qwen serve --join` on another machine. */
  createJoinToken?(supersedesHostId?: string): Promise<JoinToken>;
  removeHost?(hostId: string): Promise<unknown>;
  createShare?(agentId: string): Promise<AgentShare>;
  listShares?(agentId: string): Promise<{ shares: AgentShareSummary[] }>;
  revokeShare?(agentId: string, callerId: string): Promise<unknown>;
  createAgent(input: NewWorkspaceAgent): Promise<unknown>;
  deleteAgent(id: string): Promise<unknown>;
  setAgentEnabled(id: string, enabled: boolean): Promise<unknown>;
  updateAgent(id: string, patch: AgentConfigPatch): Promise<unknown>;
  /**
   * Roster changes (`changed` frames) from the workspace's agent stream;
   * absent in tests and older daemons, which then poll.
   */
  subscribe?(
    onEvent: (event: { type: string }) => void,
    onState: (state: AgentStreamState) => void,
  ): () => void;
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
    connectRemoteHost: (input) =>
      post('/hosts/remote-connect', {
        ...input,
        provider: HOST_PROTOCOL_PROVIDER,
      }),
    joinCoordinator: (input) =>
      post('/hosts/connect', { ...input, provider: HOST_PROTOCOL_PROVIDER }),
    listAgents: () => request('/agents'),
    createJoinToken: (supersedesHostId) =>
      post('/hosts/enrollment', supersedesHostId ? { supersedesHostId } : {}),
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
    // TODO(multi-agent): `/events` is the thread-era workspace stream. If it is
    // removed with the thread subsystem, the stream reports `closed` and the
    // roster page falls back to polling; move to a roster-scoped stream then.
    subscribe: (onEvent, onState) =>
      subscribeAgentStream(`${root}/events`, token, onEvent, onState),
  };
}
