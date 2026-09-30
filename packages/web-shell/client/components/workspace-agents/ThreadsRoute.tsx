/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftIcon } from 'lucide-react';
import {
  useConnection,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';

import {
  ThreadsPage,
  type WorkspaceAgentSummaryView,
  type WorkspaceAgentRuntimeView,
  type AgentWorkspaceView,
  type AgentCapabilitiesView,
} from './ThreadsPage';
import type { ThreadDetailView } from './ThreadView';
import { ThreadChat } from './ThreadChat';
import { Button } from '../ui/button';
import { AgentCreatePage } from '../agents/AgentCreatePage';
import { useI18n } from '../../i18n';
import { isAgentCollaborationEnabledForWorkspace } from '../../utils/workspace';
import type {
  RoutingPreviewTarget,
  ThreadSummaryView,
} from './agents-view-logic';
import type { AgentRunProgressEvent } from './agent-events';
import { createThreadsHttpApi } from './threads-api';

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
        // The daemon stamps `receivedAt` with its own clock and `ThreadChat`
        // sorts it against daemon-written `post.at` / `run.startedAt`. Using the
        // browser clock here would order one transcript by two clocks, which a
        // remote daemon makes visible. `activityAt` is refreshed by the daemon
        // on exactly this frame, so it is the same instant on the same clock.
        receivedAt: event.activityAt,
        activityAt: event.activityAt,
        stage: event.stage,
        detail: event.detail,
        outputText: event.outputText,
        thoughtText: event.thoughtText,
        ...(event.permission ? { permission: event.permission } : {}),
        ...(event.steps ? { steps: event.steps } : {}),
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
  /** `new-agent` opens straight into the New agent page. */
  initialView?: AgentWorkspaceView | 'new-agent';
  initialThreadId?: string;
  workspaceCwd?: string;
  chat?: boolean;
  activityOnly?: boolean;
  onOpenActivity?: (threadId: string, workspaceCwd: string) => void;
  headerActionsContainer?: HTMLElement | null;
  onTitleChange?: (threadId: string, title: string) => void;
  onOpenThreadChat?: (threadId: string, workspaceCwd: string) => void;
  /** Switches the shell to an agent's own session. Absent when embedded
   * somewhere with no session view to switch to. */
  onOpenAgentSession?: (sessionId: string) => void;
  onOpenDefinitions?: () => void;
}

export function ThreadsRoute({
  initialView,
  initialThreadId,
  workspaceCwd: boundWorkspaceCwd,
  chat = false,
  activityOnly = false,
  onOpenActivity,
  headerActionsContainer,
  onTitleChange,
  onOpenThreadChat,
  onOpenAgentSession,
  onOpenDefinitions,
}: ThreadsRouteProps) {
  const workspace = useWorkspace();
  const connection = useConnection();
  const [selectedWorkspaceCwd, setSelectedWorkspaceCwd] = useState<string>();
  const collaborationWorkspaces = useMemo(
    () =>
      (workspace.capabilities?.workspaces ?? []).filter((entry) =>
        isAgentCollaborationEnabledForWorkspace(
          workspace.capabilities,
          entry.cwd,
        ),
      ),
    [workspace.capabilities],
  );
  const requestedWorkspaceCwd =
    boundWorkspaceCwd ??
    selectedWorkspaceCwd ??
    connection.workspaceCwd ??
    collaborationWorkspaces.find((entry) => entry.primary)?.cwd ??
    collaborationWorkspaces[0]?.cwd;
  const workspaceCwd = isAgentCollaborationEnabledForWorkspace(
    workspace.capabilities,
    requestedWorkspaceCwd,
  )
    ? requestedWorkspaceCwd
    : boundWorkspaceCwd
      ? undefined
      : (collaborationWorkspaces.find((entry) => entry.primary)?.cwd ??
        collaborationWorkspaces[0]?.cwd);
  const client = useMemo(
    () =>
      workspaceCwd
        ? createThreadsHttpApi(workspace.baseUrl, workspace.token, workspaceCwd)
        : undefined,
    [workspace.baseUrl, workspace.token, workspaceCwd],
  );
  const { t } = useI18n();
  const [agents, setAgents] = useState<WorkspaceAgentSummaryView[]>([]);
  const [runtimes, setRuntimes] = useState<WorkspaceAgentRuntimeView[]>([]);
  const [view, setView] = useState<AgentWorkspaceView>(
    initialView === undefined || initialView === 'new-agent'
      ? 'agents'
      : initialView,
  );
  const [capabilities, setCapabilities] = useState<AgentCapabilitiesView>();
  const [threads, setThreads] = useState<ThreadSummaryView[]>([]);
  const [openId, setOpenId] = useState<string | undefined>(initialThreadId);
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
  // Set while the New agent page is open; may name the runtime to preselect.
  const [creatingAgent, setCreatingAgent] = useState<
    { hostId?: string } | undefined
  >(initialView === 'new-agent' ? {} : undefined);
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
    if (initialView && initialView !== 'new-agent') setView(initialView);
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
            t('collab.error.dispatchAfterSave', {
              error: result.dispatchError,
            }),
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
    [refresh, t],
  );

  if (!client) {
    return <p role="alert">{t('collab.noWorkspace')}</p>;
  }

  if (creatingAgent) {
    return (
      <AgentCreatePage
        initialScope="workspace"
        workspaceCwd={workspaceCwd}
        executionHosts={runtimes.filter((entry) => entry.kind === 'external')}
        {...(creatingAgent.hostId
          ? { initialHostId: creatingAgent.hostId }
          : {})}
        onCancel={() => setCreatingAgent(undefined)}
        onCreated={() => setCreatingAgent(undefined)}
        onSaveWorkspaceAgent={async (input) => {
          await client.createAgent(input);
          await refresh();
        }}
      />
    );
  }

  if (openId && detail?.id !== openId) {
    return (
      <div className="flex flex-col items-start gap-2 p-4">
        {chat ? null : (
          <Button variant="ghost" size="sm" onClick={() => openThread()}>
            <ArrowLeftIcon data-icon="inline-start" />
            {t('collab.thread.back')}
          </Button>
        )}
        <p role="status" className="text-sm text-muted-foreground">
          {error ?? t('collab.thread.loading')}
        </p>
      </div>
    );
  }

  const { createShare, listShares, revokeShare, removeHost } = client;
  const shares =
    createShare && listShares && revokeShare
      ? {
          create: createShare,
          list: async (agentId: string) => (await listShares(agentId)).shares,
          revoke: revokeShare,
        }
      : undefined;

  // Outside the shell's chat column (an embedded Agents page with no chat to
  // switch to) the same conversation opens in place, with a way back.
  if (openId && detail) {
    return (
      <>
        {error && (
          <p role="alert" className="px-4 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <ThreadChat
          key={detail.id}
          activityOnly={activityOnly}
          headerActionsContainer={headerActionsContainer}
          {...(chat ? {} : { onBack: () => openThread() })}
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
          onAssign={(assignee) =>
            void mutate(() => client.assignThread(openId, assignee))
          }
          onOpenAgentSession={onOpenAgentSession}
          onCancelRun={(runId) =>
            void mutate(() => client.cancelRun(openId, runId))
          }
          onMarkDone={() => void mutate(() => client.markDone(openId))}
          {...(client.respondToPermission
            ? {
                onRespondPermission: (
                  sessionId: string,
                  requestId: string,
                  optionId: string,
                ) =>
                  mutate(() =>
                    client.respondToPermission!(sessionId, requestId, optionId),
                  ),
              }
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
        runtimes={runtimes}
        onConnectRemoteHost={
          client.connectRemoteHost
            ? (input) => mutate(() => client.connectRemoteHost!(input))
            : undefined
        }
        createPreview={createPreview}
        pending={pending}
        onOpenThread={(id) => {
          // A conversation has one form, the chat; the list only leads to it.
          if (workspaceCwd && onOpenThreadChat)
            onOpenThreadChat(id, workspaceCwd);
          else openThread(id);
        }}
        onDeleteAgent={(id) => void mutate(() => client.deleteAgent(id))}
        onSetAgentEnabled={(id, enabled) =>
          void mutate(() => client.setAgentEnabled(id, enabled))
        }
        onUpdateAgent={(id, patch) =>
          void mutate(() => client.updateAgent(id, patch))
        }
        onOpenAgentBuilder={(hostId) => setCreatingAgent({ hostId })}
        {...(client.createJoinToken
          ? { onCreateJoinToken: client.createJoinToken }
          : {})}
        {...(removeHost
          ? {
              onRemoveRuntime: (hostId: string) =>
                void mutate(() => removeHost(hostId)),
            }
          : {})}
        {...(shares ? { shares } : {})}
        {...(onOpenDefinitions ? { onOpenDefinitions } : {})}
        {...(capabilities ? { capabilities } : {})}
        workspaceCwd={workspaceCwd}
        hostServerUrl={workspace.baseUrl}
        workspaces={collaborationWorkspaces}
        onWorkspaceChange={(cwd) => {
          setSelectedWorkspaceCwd(cwd);
          setAgents([]);
          setCreatePreview(undefined);
          createAssigneeRef.current = undefined;
        }}
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
