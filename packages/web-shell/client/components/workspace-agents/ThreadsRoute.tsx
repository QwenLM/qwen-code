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
  type WorkspaceAgentRuntimeView,
  type AgentHostEnrollmentView,
  type AgentWorkspaceView,
  type NewWorkspaceAgent,
  type NewThread,
  type AgentConfigPatch,
  type AgentCapabilitiesView,
} from './ThreadsPage';
import { ThreadView, type ThreadDetailView } from './ThreadView';
import { ThreadChat } from './ThreadChat';
import { AgentCreatePage } from '../agents/AgentCreatePage';
import type {
  RoutingPreviewTarget,
  ThreadSummaryView,
} from './agents-view-logic';
import {
  subscribeAgentStream,
  type AgentLiveEvent,
  type AgentRunProgressEvent,
  type AgentStreamState,
} from './agent-events';

interface CreateThreadResult {
  id: string;
}

export interface ThreadsApi {
  connectRemoteHost?(input: {
    remoteUrl: string;
    remoteToken: string;
    remoteCwd: string;
    serverUrl: string;
    provider: 'qwen' | 'codex';
    allowHttp: boolean;
  }): Promise<unknown>;
  listAgents(): Promise<{
    agents: WorkspaceAgentSummaryView[];
    runtime?: WorkspaceAgentRuntimeView;
    runtimes?: WorkspaceAgentRuntimeView[];
    capabilities?: AgentCapabilitiesView;
  }>;
  createHostEnrollment?(
    targetUrl: string,
    provider: 'qwen' | 'codex',
    allowHttp?: boolean,
  ): Promise<AgentHostEnrollmentView>;
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
    connectRemoteHost: (input) => post('/hosts/remote-connect', input),
    listAgents: () => request('/agents'),
    createHostEnrollment: async (targetUrl, provider, allowHttp = false) => {
      const target = new URL(targetUrl);
      if (
        target.username ||
        target.password ||
        target.search ||
        target.hash ||
        (target.protocol !== 'https:' &&
          !(
            target.protocol === 'http:' &&
            (allowHttp ||
              ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
          ))
      ) {
        throw new Error(
          '请使用 HTTPS，或显式开启「允许 HTTP（仅演示）」。地址不能携带账号、查询参数或片段。',
        );
      }
      const quote = (value: string) =>
        "'" + value.replaceAll("'", "'\\''") + "'";
      const result = await post<{
        token: string;
        workspaceId: string;
        expiresAt: number;
      }>('/hosts/enrollment', {});
      return {
        expiresAt: result.expiresAt,
        command:
          `QWEN_AGENT_HOST_ENROLLMENT_TOKEN=${quote(result.token)} ` +
          `qwen serve --no-web --port 0 ` +
          `--agent-host-server ${quote(target.toString().replace(/\/$/, ''))} ` +
          `--agent-host-provider ${provider} ` +
          (allowHttp && target.protocol === 'http:'
            ? '--agent-host-allow-http '
            : '') +
          `--agent-host-workspace-id ${quote(result.workspaceId)}`,
      };
    },
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
        throw new Error(`Approval failed (${response.status})`);
      }
    },
  };
}

/** Folds one streamed progress frame into the open thread, if it is that thread's. */
function applyProgress(
  detail: ThreadDetailView | undefined,
  event: AgentRunProgressEvent,
): ThreadDetailView | undefined {
  if (!detail || detail.id !== event.threadId) return detail;
  let changed = false;
  const runs = detail.runs.map((run) => {
    // A late frame from an earlier attempt of the same run is dropped.
    if (run.id !== event.runId || (run.progress?.attempt ?? 0) > event.attempt)
      return run;
    changed = true;
    return {
      ...run,
      status: run.status === 'queued' ? 'running' : run.status,
      progress: {
        attempt: event.attempt,
        receivedAt: Date.now(),
        activityAt: event.activityAt,
        stage: event.stage,
        detail: event.detail,
        outputText: event.outputText,
        thoughtText: event.thoughtText,
        ...(event.permission ? { permission: event.permission } : {}),
      },
    };
  });
  return changed ? { ...detail, runs } : detail;
}

const PREVIEW_DEBOUNCE_MS = 250;
/** Polling cadence while the live stream is down or unsupported. */
const REFRESH_MS = 1_000;
/** Bursts of store writes collapse into one refetch. */
const CHANGE_REFETCH_MS = 150;

export interface ThreadsRouteProps {
  initialCreateTask?: boolean;
  initialView?: AgentWorkspaceView;
  initialThreadId?: string;
  workspaceCwd?: string;
  chat?: boolean;
  activityOnly?: boolean;
  onOpenActivity?: (threadId: string, workspaceCwd: string) => void;
  headerActionsContainer?: HTMLElement | null;
  onTitleChange?: (threadId: string, title: string) => void;
  hideNavigation?: boolean;
  onOpenThreadChat?: (threadId: string, workspaceCwd: string) => void;
  api?: ThreadsApi;
  /** Switches the shell to an agent's own session. Absent when embedded
   * somewhere with no session view to switch to. */
  onOpenAgentSession?: (sessionId: string) => void;
  onOpenDefinitions?: () => void;
}

export function ThreadsRoute({
  initialCreateTask,
  initialView,
  initialThreadId,
  workspaceCwd: boundWorkspaceCwd,
  chat = false,
  activityOnly = false,
  onOpenActivity,
  headerActionsContainer,
  onTitleChange,
  hideNavigation = false,
  onOpenThreadChat,
  api,
  onOpenAgentSession,
  onOpenDefinitions,
}: ThreadsRouteProps) {
  const workspace = useWorkspace();
  const connection = useConnection();
  const [selectedWorkspaceCwd, setSelectedWorkspaceCwd] = useState<string>();
  const workspaceCwd =
    boundWorkspaceCwd ??
    selectedWorkspaceCwd ??
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
  const [runtime, setRuntime] = useState<WorkspaceAgentRuntimeView>();
  const [runtimes, setRuntimes] = useState<WorkspaceAgentRuntimeView[]>([]);
  const [hostEnrollment, setHostEnrollment] =
    useState<AgentHostEnrollmentView>();
  const [view, setView] = useState<AgentWorkspaceView>(
    initialView ?? (initialCreateTask ? 'tasks' : 'agents'),
  );
  const [capabilities, setCapabilities] = useState<AgentCapabilitiesView>();
  const [threads, setThreads] = useState<ThreadSummaryView[]>([]);
  const [openId, setOpenId] = useState<string | undefined>(initialThreadId);
  const [showDetails, setShowDetails] = useState(false);
  const [detail, setDetail] = useState<ThreadDetailView | undefined>();
  useEffect(() => {
    if (chat && !activityOnly && detail)
      onTitleChange?.(detail.id, detail.title);
  }, [chat, activityOnly, detail, onTitleChange]);
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState<RoutingPreviewTarget[] | undefined>();
  const [createPreview, setCreatePreview] = useState<
    RoutingPreviewTarget[] | undefined
  >();
  const [pending, setPending] = useState(false);
  const [creatingAgent, setCreatingAgent] = useState(false);
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

  useEffect(() => {
    if (initialView) setView(initialView);
  }, [initialView]);

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
      setRuntime(nextAgents.runtime);
      setRuntimes(
        nextAgents.runtimes ?? (nextAgents.runtime ? [nextAgents.runtime] : []),
      );
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

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Live updates: refetch on `changed`, fold `progress` straight into the open
  // thread so replies stream. Polls only while the stream is down.
  useEffect(() => {
    if (!client) return;
    let poll: ReturnType<typeof setInterval> | undefined;
    let pendingRefetch: ReturnType<typeof setTimeout> | undefined;
    const startPolling = () => {
      poll ??= setInterval(() => void refreshRef.current(), REFRESH_MS);
    };
    if (!client.subscribe) {
      startPolling();
      return () => clearInterval(poll);
    }
    const stop = client.subscribe(
      (event) => {
        if (event.type === 'progress') {
          setDetail((current) => applyProgress(current, event));
          return;
        }
        pendingRefetch ??= setTimeout(() => {
          pendingRefetch = undefined;
          void refreshRef.current();
        }, CHANGE_REFETCH_MS);
      },
      (state) => {
        if (state === 'closed') {
          startPolling();
          return;
        }
        clearInterval(poll);
        poll = undefined;
      },
    );
    return () => {
      stop();
      clearInterval(poll);
      clearTimeout(pendingRefetch);
    };
  }, [client]);

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
        return false;
      } finally {
        setPending(false);
      }
      return true;
    },
    [refresh],
  );

  if (!client) {
    return <p role="alert">Open a workspace before using shared threads.</p>;
  }

  if (creatingAgent) {
    return (
      <AgentCreatePage
        initialScope="workspace"
        workspaceCwd={workspaceCwd}
        executionHosts={runtimes.filter((entry) => entry.kind === 'external')}
        onCancel={() => setCreatingAgent(false)}
        onCreated={() => setCreatingAgent(false)}
        onSaveWorkspaceAgent={async (input) => {
          await client.createAgent(input);
          await refresh();
        }}
      />
    );
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
    if (chat && !showDetails) {
      return (
        <>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <ThreadChat
            key={detail.id}
            activityOnly={activityOnly}
            headerActionsContainer={headerActionsContainer}
            onOpenActivity={
              onOpenActivity && workspaceCwd
                ? () => onOpenActivity(detail.id, workspaceCwd)
                : undefined
            }
            thread={detail}
            agents={agents}
            preview={preview}
            pending={pending}
            onDraftChange={setDraft}
            onDetails={() => setShowDetails(true)}
            onOpenAgentSession={onOpenAgentSession}
            onCancelRun={(runId) =>
              void mutate(() => client.cancelRun(openId, runId))
            }
            onMarkDone={() => void mutate(() => client.markDone(openId))}
            {...(client.respondToPermission
              ? { onRespondPermission: client.respondToPermission }
              : {})}
            onOpenThread={(id) => {
              if (workspaceCwd && onOpenThreadChat)
                onOpenThreadChat(id, workspaceCwd);
              else openThread(id);
            }}
            onSend={(text) =>
              mutate(async () => {
                const result = await client.postReply(openId, text);
                setDraft('');
                setPreview(undefined);
                return result;
              })
            }
          />
        </>
      );
    }
    return (
      <>
        {(chat || onOpenThreadChat) && (
          <button
            type="button"
            onClick={() => {
              if (chat) setShowDetails(false);
              else if (workspaceCwd) onOpenThreadChat?.(openId, workspaceCwd);
            }}
          >
            Open conversation
          </button>
        )}
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
        view={view}
        onViewChange={setView}
        hideNavigation={hideNavigation}
        {...(runtime ? { runtime } : {})}
        runtimes={runtimes}
        onConnectRemoteHost={
          client.connectRemoteHost
            ? (input) => mutate(() => client.connectRemoteHost!(input))
            : undefined
        }
        {...(hostEnrollment ? { hostEnrollment } : {})}
        createPreview={createPreview}
        pending={pending}
        onOpenThread={openThread}
        onDeleteAgent={(id) => void mutate(() => client.deleteAgent(id))}
        onSetAgentEnabled={(id, enabled) =>
          void mutate(() => client.setAgentEnabled(id, enabled))
        }
        onUpdateAgent={(id, patch) =>
          void mutate(() => client.updateAgent(id, patch))
        }
        onOpenAgentBuilder={() => setCreatingAgent(true)}
        {...(client.createHostEnrollment
          ? {
              onCreateHostEnrollment: (
                targetUrl: string,
                provider: 'qwen' | 'codex',
                allowHttp?: boolean,
              ) =>
                void mutate(async () => {
                  setHostEnrollment(undefined);
                  const enrollment = await client.createHostEnrollment?.(
                    targetUrl,
                    provider,
                    allowHttp,
                  );
                  if (enrollment) setHostEnrollment(enrollment);
                  return enrollment;
                }),
            }
          : {})}
        {...(onOpenDefinitions ? { onOpenDefinitions } : {})}
        {...(capabilities ? { capabilities } : {})}
        workspaceCwd={workspaceCwd}
        hostServerUrl={workspace.baseUrl}
        workspaces={workspace.capabilities?.workspaces ?? []}
        onWorkspaceChange={(cwd) => {
          setSelectedWorkspaceCwd(cwd);
          setAgents([]);
          setCreatePreview(undefined);
          createAssigneeRef.current = undefined;
        }}
        initialCreateTask={initialCreateTask}
        createError={error}
        onCreateThread={(input) =>
          mutate(async () => {
            const created = await client.createThread(input);
            setCreatePreview(undefined);
            openThread(created.id);
            if (workspaceCwd) onOpenThreadChat?.(created.id, workspaceCwd);
            return created;
          })
        }
        onPreviewThread={previewThread}
      />
    </>
  );
}
