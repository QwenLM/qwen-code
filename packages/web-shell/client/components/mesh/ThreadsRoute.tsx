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
  type MeshAgentSummaryView,
  type NewMeshAgent,
  type NewMeshThread,
} from './ThreadsPage';
import {
  ThreadView,
  type ThreadDetailView,
  type TranscriptSliceView,
} from './ThreadView';
import type {
  RoutingPreviewTarget,
  ThreadSummaryView,
} from './mesh-view-logic';

interface CreateThreadResult {
  id: string;
}

export interface ThreadsApi {
  listAgents(): Promise<{ agents: MeshAgentSummaryView[] }>;
  listThreads(): Promise<{ threads: ThreadSummaryView[] }>;
  getThread(id: string): Promise<ThreadDetailView>;
  createAgent(input: NewMeshAgent): Promise<unknown>;
  deleteAgent(id: string): Promise<unknown>;
  setAgentEnabled(id: string, enabled: boolean): Promise<unknown>;
  createThread(input: NewMeshThread): Promise<CreateThreadResult>;
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
  getRunTranscript(
    threadId: string,
    runId: string,
  ): Promise<TranscriptSliceView>;
}

function createThreadsHttpApi(
  baseUrl: string,
  token: string | undefined,
  workspaceCwd: string,
): ThreadsApi {
  const root = `${baseUrl.replace(/\/+$/, '')}/workspaces/${encodeURIComponent(workspaceCwd)}/mesh`;
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
      throw new Error(body.error || `Mesh request failed (${response.status})`);
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
    getRunTranscript: (threadId, runId) =>
      request(
        `/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/transcript`,
      ),
  };
}

const PREVIEW_DEBOUNCE_MS = 250;
const REFRESH_MS = 1_000;

export interface ThreadsRouteProps {
  api?: ThreadsApi;
  onOpenTranscript?: (runId: string) => void;
}

export function ThreadsRoute({ api, onOpenTranscript }: ThreadsRouteProps) {
  const workspace = useWorkspace();
  const connection = useConnection();
  const workspaceCwd =
    connection.workspaceCwd ??
    workspace.capabilities?.workspaces.find((entry) => entry.primary)?.cwd;
  const client = useMemo(
    () =>
      api ??
      (workspaceCwd
        ? createThreadsHttpApi(workspace.baseUrl, workspace.token, workspaceCwd)
        : undefined),
    [api, workspace.baseUrl, workspace.token, workspaceCwd],
  );
  const [agents, setAgents] = useState<MeshAgentSummaryView[]>([]);
  const [threads, setThreads] = useState<ThreadSummaryView[]>([]);
  const [openId, setOpenId] = useState<string | undefined>();
  const [detail, setDetail] = useState<ThreadDetailView | undefined>();
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState<RoutingPreviewTarget[] | undefined>();
  const [createPreview, setCreatePreview] = useState<
    RoutingPreviewTarget[] | undefined
  >();
  const [transcript, setTranscript] = useState<
    TranscriptSliceView | undefined
  >();
  const [pending, setPending] = useState(false);
  const [refreshError, setRefreshError] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const error = actionError ?? refreshError;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const createAssigneeRef = useRef<string | undefined>();

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      const [nextAgents, nextThreads, nextDetail] = await Promise.all([
        client.listAgents(),
        client.listThreads(),
        openId ? client.getThread(openId) : undefined,
      ]);
      setAgents(nextAgents.agents);
      setThreads(nextThreads.threads);
      setDetail(nextDetail);
      setRefreshError(undefined);
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client, openId]);

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
    const timer = setTimeout(() => {
      void client
        .previewReply(openId, asked)
        .then((result) => {
          if (draftRef.current === asked) setPreview(result.targets);
        })
        .catch(() => setPreview(undefined));
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
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

  if (openId && detail) {
    return (
      <>
        {error ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <ThreadView
          thread={detail}
          agents={agents}
          draft={draft}
          onDraftChange={setDraft}
          onReply={() =>
            void mutate(async () => {
              if (!draft.trim()) return;
              const result = await client.postReply(openId, draft);
              setDraft('');
              setPreview(undefined);
              return result;
            })
          }
          onBack={() => {
            setTranscript(undefined);
            setOpenId(undefined);
          }}
          onOpenThread={(threadId) => {
            setTranscript(undefined);
            setOpenId(threadId);
          }}
          onOpenTranscript={(runId) => {
            onOpenTranscript?.(runId);
            void client
              .getRunTranscript(openId, runId)
              .then(setTranscript)
              .catch((cause) =>
                setActionError(
                  cause instanceof Error ? cause.message : String(cause),
                ),
              );
          }}
          onCloseTranscript={() => setTranscript(undefined)}
          onCancelRun={(runId) =>
            void mutate(() => client.cancelRun(openId, runId))
          }
          onMarkDone={() =>
            void mutate(async () => {
              const result = await client.markDone(openId);
              setTranscript(undefined);
              return result;
            })
          }
          onAssign={(assignee) =>
            void mutate(() => client.assignThread(openId, assignee))
          }
          replyPending={pending}
          {...(preview ? { preview } : {})}
          {...(transcript ? { transcript } : {})}
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
        onOpenThread={setOpenId}
        onCreateAgent={(input) => void mutate(() => client.createAgent(input))}
        onDeleteAgent={(id) => void mutate(() => client.deleteAgent(id))}
        onSetAgentEnabled={(id, enabled) =>
          void mutate(() => client.setAgentEnabled(id, enabled))
        }
        onCreateThread={(input) =>
          void mutate(async () => {
            const created = await client.createThread(input);
            setCreatePreview(undefined);
            setOpenId(created.id);
            return created;
          })
        }
        onPreviewThread={previewThread}
      />
    </>
  );
}
