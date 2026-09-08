/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useConnection,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';

import {
  ThreadsPage,
  type WorkspaceAgentSummaryView,
  type NewWorkspaceAgent,
  type NewThread,
  type AgentConfigPatch,
  type AgentCapabilitiesView,
} from './ThreadsPage';
import { ThreadView, type ThreadDetailView } from './ThreadView';
import type {
  RoutingPreviewTarget,
  ThreadSummaryView,
} from './agents-view-logic';

interface CreateThreadResult {
  id: string;
}

export interface ThreadsApi {
  listAgents(): Promise<{
    agents: WorkspaceAgentSummaryView[];
    capabilities?: AgentCapabilitiesView;
  }>;
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
}

function createThreadsHttpApi(
  baseUrl: string,
  token: string | undefined,
  workspaceCwd: string,
): ThreadsApi {
  const root = `${baseUrl.replace(/\/+$/, '')}/workspaces/${encodeURIComponent(workspaceCwd)}/agent`;
  const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${root}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(
        body.error || `Agent request failed (${response.status})`,
      );
    }
    return body;
  };
  const post = <T,>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) });

  return {
    listAgents: () => request('/agents'),
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
  };
}

const PREVIEW_DEBOUNCE_MS = 250;
const REFRESH_MS = 1_000;

export interface ThreadsRouteProps {
  api?: ThreadsApi;
  /** Switches the shell to an agent's own session. Absent when embedded
   * somewhere with no session view to switch to. */
  onOpenAgentSession?: (sessionId: string) => void;
  agentDefinitions?: readonly string[];
  onCreateAgentDefinition?: () => void;
}

export function ThreadsRoute({
  api,
  onOpenAgentSession,
  agentDefinitions,
  onCreateAgentDefinition,
}: ThreadsRouteProps) {
  const workspace = useWorkspace();
  const connection = useConnection();
  const workspaceCwd =
    connection.workspaceCwd ??
    workspace.capabilities?.workspaces?.find((entry) => entry.primary)?.cwd;
  const client = useMemo(
    () =>
      api ??
      (workspaceCwd
        ? createThreadsHttpApi(workspace.baseUrl, workspace.token, workspaceCwd)
        : undefined),
    [api, workspace.baseUrl, workspace.token, workspaceCwd],
  );
  const [agents, setAgents] = useState<WorkspaceAgentSummaryView[]>([]);
  const [capabilities, setCapabilities] = useState<AgentCapabilitiesView>();
  const [threads, setThreads] = useState<ThreadSummaryView[]>([]);
  const [openId, setOpenId] = useState<string | undefined>();
  const [detail, setDetail] = useState<ThreadDetailView | undefined>();
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState<RoutingPreviewTarget[] | undefined>();
  const [createPreview, setCreatePreview] = useState<
    RoutingPreviewTarget[] | undefined
  >();
  const [pending, setPending] = useState(false);
  const [refreshError, setRefreshError] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const error = actionError ?? refreshError;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const createAssigneeRef = useRef<string | undefined>(undefined);
  const scope = useMemo(() => ({ client, openId }), [client, openId]);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const refreshSequence = useRef(0);
  const appliedRefresh = useRef(0);

  const openThread = (id?: string) => {
    setOpenId(id);
    setDetail(undefined);
    setDraft('');
    setPreview(undefined);
    setActionError(undefined);
  };

  const refresh = useCallback(async () => {
    if (!client) return;
    const sequence = ++refreshSequence.current;
    try {
      const [nextAgents, nextThreads, nextDetail] = await Promise.all([
        client.listAgents(),
        client.listThreads(),
        openId ? client.getThread(openId) : undefined,
      ]);
      if (activeScope.current !== scope || sequence < appliedRefresh.current) {
        return;
      }
      appliedRefresh.current = sequence;
      setAgents(nextAgents.agents);
      if (nextAgents.capabilities) setCapabilities(nextAgents.capabilities);
      setThreads(nextThreads.threads);
      setDetail(nextDetail);
      setRefreshError(undefined);
    } catch (cause) {
      if (activeScope.current !== scope || sequence < appliedRefresh.current) {
        return;
      }
      appliedRefresh.current = sequence;
      setRefreshError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client, openId, scope]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!client || !openId || !draft.trim()) {
      setPreview(undefined);
      return;
    }
    const asked = draft;
    let cancelled = false;
    const timer = setTimeout(() => {
      void client
        .previewReply(openId, asked)
        .then((result) => {
          if (!cancelled && draftRef.current === asked) {
            setPreview(result.targets);
          }
        })
        .catch(() => {
          if (!cancelled) setPreview(undefined);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, draft, openId]);

  const previewThread = useCallback(
    (assignee?: string) => {
      createAssigneeRef.current = assignee;
      setCreatePreview(undefined);
      if (!client) return;
      void client
        .previewThread(assignee)
        .then((result) => {
          if (createAssigneeRef.current === assignee) {
            setCreatePreview(result.targets);
          }
        })
        .catch(() => {
          if (createAssigneeRef.current === assignee) {
            setCreatePreview(undefined);
          }
        });
    },
    [client],
  );

  const mutate = useCallback(
    async (action: () => Promise<unknown>) => {
      setPending(true);
      setActionError(undefined);
      try {
        const result = await action();
        await refresh();
        if (
          result !== null &&
          typeof result === 'object' &&
          'dispatchError' in result &&
          typeof result.dispatchError === 'string'
        ) {
          setActionError(
            `The change was saved, but background processing failed: ${result.dispatchError}`,
          );
        }
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setPending(false);
      }
    },
    [refresh],
  );

  if (!client) {
    return <p role="alert">Open a workspace before using shared threads.</p>;
  }

  if (openId && detail?.id !== openId) {
    return (
      <div>
        <button type="button" onClick={() => openThread()}>
          Back to tasks
        </button>
        <p role="status">{error ?? 'Loading task…'}</p>
      </div>
    );
  }

  if (openId && detail) {
    return (
      <>
        {error ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <ThreadView
          key={openId}
          thread={detail}
          agents={agents}
          draft={draft}
          onDraftChange={setDraft}
          onReply={() =>
            void mutate(async () => {
              if (!draft.trim()) return;
              const result = await client.postReply(openId, draft);
              if (activeScope.current === scope && draftRef.current === draft) {
                setDraft('');
                setPreview(undefined);
              }
              return result;
            })
          }
          onBack={() => openThread()}
          onOpenThread={openThread}
          {...(onOpenAgentSession ? { onOpenAgentSession } : {})}
          onCancelRun={(runId) =>
            void mutate(() => client.cancelRun(openId, runId))
          }
          onMarkDone={() =>
            void mutate(async () => {
              const result = await client.markDone(openId);
              return result;
            })
          }
          onAssign={(assignee) =>
            void mutate(() => client.assignThread(openId, assignee))
          }
          replyPending={pending}
          {...(preview ? { preview } : {})}
        />
      </>
    );
  }

  return (
    <>
      {error ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <ThreadsPage
        agents={agents}
        threads={threads}
        createPreview={createPreview}
        pending={pending}
        onOpenThread={openThread}
        onCreateAgent={(input) => void mutate(() => client.createAgent(input))}
        onDeleteAgent={(id) => void mutate(() => client.deleteAgent(id))}
        onSetAgentEnabled={(id, enabled) =>
          void mutate(() => client.setAgentEnabled(id, enabled))
        }
        onUpdateAgent={(id, patch) =>
          void mutate(() => client.updateAgent(id, patch))
        }
        {...(onOpenAgentSession ? { onOpenAgentSession } : {})}
        {...(agentDefinitions ? { agentDefinitions } : {})}
        {...(onCreateAgentDefinition ? { onCreateAgentDefinition } : {})}
        {...(capabilities ? { capabilities } : {})}
        onCreateThread={(input) =>
          void mutate(async () => {
            const created = await client.createThread(input);
            setCreatePreview(undefined);
            openThread(created.id);
            return created;
          })
        }
        onPreviewThread={previewThread}
      />
    </>
  );
}
