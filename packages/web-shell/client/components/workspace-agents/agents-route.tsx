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
  type AgentCapabilitiesView,
  type AgentWorkspaceView,
  type WorkspaceAgentRuntimeView,
  type WorkspaceAgentSummaryView,
} from './ThreadsPage';
import { AgentCreatePage } from '../agents/AgentCreatePage';
import { useI18n } from '../../i18n';
import { isAgentCollaborationEnabledForWorkspace } from '../../utils/workspace';
import { createThreadsHttpApi } from './threads-api';

/** Polling cadence while the live stream is down or unsupported. */
const REFRESH_MS = 1_000;
/** Bursts of store writes collapse into one refetch. */
const CHANGE_REFETCH_MS = 150;

export interface AgentsRouteProps {
  /** `new-agent` opens straight into the New agent page. */
  initialView?: AgentWorkspaceView | 'new-agent';
  workspaceCwd?: string;
  onOpenDefinitions?: () => void;
  /** Puts `@name ` into the chat composer; absent hides the card button. */
  onMentionAgent?: (name: string) => void;
}

/**
 * The Agents page with its data: the workspace's roster and runtimes, kept
 * fresh from the workspace agent stream.
 */
export function AgentsRoute({
  initialView,
  workspaceCwd: boundWorkspaceCwd,
  onOpenDefinitions,
  onMentionAgent,
}: AgentsRouteProps) {
  const workspace = useWorkspace();
  const connection = useConnection();
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
  const [pending, setPending] = useState(false);
  // Set while the New agent page is open; may name the runtime to preselect.
  const [creatingAgent, setCreatingAgent] = useState<
    { hostId?: string } | undefined
  >(initialView === 'new-agent' ? {} : undefined);
  const [refreshError, setRefreshError] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const error = actionError ?? refreshError;
  const activeClient = useRef(client);
  activeClient.current = client;
  const refreshSequence = useRef(0);
  const appliedRefresh = useRef(0);

  useEffect(() => {
    if (initialView && initialView !== 'new-agent') setView(initialView);
  }, [initialView]);

  const refresh = useCallback(async () => {
    if (!client) return;
    const sequence = ++refreshSequence.current;
    try {
      const next = await client.listAgents();
      if (activeClient.current !== client || sequence < appliedRefresh.current)
        return;
      appliedRefresh.current = sequence;
      setAgents(next.agents);
      setRuntimes(next.runtimes ?? (next.runtime ? [next.runtime] : []));
      if (next.capabilities) setCapabilities(next.capabilities);
      setRefreshError(undefined);
    } catch (cause) {
      if (activeClient.current !== client || sequence < appliedRefresh.current)
        return;
      appliedRefresh.current = sequence;
      setRefreshError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Refetch on `changed`; poll only while the stream is down.
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
        if (event.type !== 'changed') return;
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

  const mutate = useCallback(
    async (action: () => Promise<unknown>) => {
      setPending(true);
      setActionError(undefined);
      try {
        await action();
        await refresh();
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

  const {
    createShare,
    listShares,
    revokeShare,
    removeHost,
    connectRemoteHost,
    joinCoordinator,
  } = client;
  const shares =
    createShare && listShares && revokeShare
      ? {
          create: createShare,
          list: async (agentId: string) => (await listShares(agentId)).shares,
          revoke: revokeShare,
        }
      : undefined;

  return (
    <>
      {error ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <ThreadsPage
        agents={agents}
        view={view}
        onViewChange={setView}
        runtimes={runtimes}
        onConnectRemoteHost={
          connectRemoteHost
            ? (input) => mutate(() => connectRemoteHost(input))
            : undefined
        }
        onJoinCoordinator={
          joinCoordinator
            ? async (input) => {
                // Errors stay in the dialog, beside the link that caused them.
                await joinCoordinator(input);
                return true;
              }
            : undefined
        }
        onMentionAgent={onMentionAgent}
        pending={pending}
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
        hostServerUrl={workspace.baseUrl}
      />
    </>
  );
}
