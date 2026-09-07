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
import { ThreadView, type ThreadDetailView } from './ThreadView';
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
  createThread(input: NewMeshThread): Promise<CreateThreadResult>;
  previewReply(
    id: string,
    text: string,
  ): Promise<{ targets: RoutingPreviewTarget[] }>;
  postReply(id: string, text: string): Promise<unknown>;
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
    createThread: (input) => post('/threads', input),
    previewReply: (id, text) =>
      post(`/threads/${encodeURIComponent(id)}/preview`, { text }),
    postReply: (id, text) =>
      post(`/threads/${encodeURIComponent(id)}/posts`, { text }),
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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const draftRef = useRef(draft);
  draftRef.current = draft;

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
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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

  const mutate = useCallback(
    async (action: () => Promise<unknown>) => {
      setPending(true);
      try {
        await action();
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
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
      <ThreadView
        thread={detail}
        draft={draft}
        onDraftChange={setDraft}
        onReply={() =>
          void mutate(async () => {
            if (!draft.trim()) return;
            await client.postReply(openId, draft);
            setDraft('');
            setPreview(undefined);
          })
        }
        onBack={() => setOpenId(undefined)}
        onOpenTranscript={onOpenTranscript ?? (() => {})}
        replyPending={pending}
        {...(preview ? { preview } : {})}
      />
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
        pending={pending}
        onOpenThread={setOpenId}
        onCreateAgent={(input) => void mutate(() => client.createAgent(input))}
        onCreateThread={(input) =>
          void mutate(async () => {
            const created = await client.createThread(input);
            setOpenId(created.id);
          })
        }
      />
    </>
  );
}
