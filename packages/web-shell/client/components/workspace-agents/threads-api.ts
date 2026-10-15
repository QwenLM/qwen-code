/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentConfigPatch,
  NewWorkspaceAgent,
  WorkspaceAgentRuntimeView,
  WorkspaceAgentSummaryView,
} from './ThreadsPage';
import type {
  ConnectExistingInput,
  JoinCoordinatorInput,
  JoinToken,
} from './add-runtime-dialog';
import type { AgentShare, AgentShareSummary } from './share-agent-dialog';
import type { SessionSquadView } from '@qwen-code/sdk/daemon';

/** Body of a squad create; on update, `null` clears a text field. */
export interface SquadInput {
  name: string;
  description: string | null;
  instructions: string | null;
  leaderAgentId: string;
  members: Array<{ agentId: string; role?: string }>;
}

/** Agent roster, runtimes, enrollment and sharing for one workspace. */
export interface ThreadsApi {
  connectRemoteHost?(input: ConnectExistingInput): Promise<unknown>;
  /** Makes this daemon a runtime of another coordinator. */
  joinCoordinator?(input: JoinCoordinatorInput): Promise<unknown>;
  listAgents(): Promise<{
    agents: WorkspaceAgentSummaryView[];
    runtime?: WorkspaceAgentRuntimeView;
    runtimes?: WorkspaceAgentRuntimeView[];
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
  /** Squads; absent on a daemon without them. */
  listSquads?(): Promise<{ squads: SessionSquadView[] }>;
  createSquad?(input: SquadInput): Promise<unknown>;
  updateSquad?(id: string, input: Partial<SquadInput>): Promise<unknown>;
  /** Retires the squad (it keeps its name and history). */
  retireSquad?(id: string): Promise<unknown>;
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
    // No `provider`: a v2 remote reports which programs it has, and the
    // coordinator adds an agent per program once it heartbeats.
    connectRemoteHost: (input) => post('/hosts/remote-connect', input),
    joinCoordinator: (input) => post('/hosts/connect', input),
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
    listSquads: () => request('/squads'),
    createSquad: (input) => post('/squads', input),
    updateSquad: (id, input) =>
      request(`/squads/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    retireSquad: (id) =>
      request(`/squads/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
}
