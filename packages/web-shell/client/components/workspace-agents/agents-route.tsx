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
  type AgentWorkspaceView,
  type WorkspaceAgentRuntimeView,
  type WorkspaceAgentSummaryView,
} from './ThreadsPage';
import { AgentCreatePage } from '../agents/AgentCreatePage';
import { useI18n } from '../../i18n';
import { isAgentCollaborationEnabledForWorkspace } from '../../utils/workspace';
import { createThreadsHttpApi, type SquadInput } from './threads-api';
import type { SessionSquadView } from '@qwen-code/sdk/daemon';

/**
 * Roster polling cadence. The roster has no live stream (the thread-era
 * workspace stream went with threads); live run progress is shown in the chat
 * session from `session-events`, so a couple of seconds is enough here and
 * still lets the Add runtime dialog notice a newly joined runtime promptly.
 */
const REFRESH_MS = 2_000;

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
 * fresh by polling.
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
  const [squads, setSquads] = useState<SessionSquadView[] | undefined>();
  const [view, setView] = useState<AgentWorkspaceView>(
    initialView === undefined || initialView === 'new-agent'
      ? 'agents'
      : initialView,
  );
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
      const [next, squadList] = await Promise.all([
        client.listAgents(),
        // An older daemon has no squad routes: the Squads view shows empty.
        // A failed poll is not "no squads": keep the list (and an open form)
        // already on screen until a poll succeeds.
        client.listSquads
          ? client.listSquads().then(
              (list) => ({ list }),
              () => ({ failed: true as const }),
            )
          : Promise.resolve(undefined),
      ]);
      if (activeClient.current !== client || sequence < appliedRefresh.current)
        return;
      appliedRefresh.current = sequence;
      setAgents(next.agents);
      setRuntimes(next.runtimes ?? (next.runtime ? [next.runtime] : []));
      if (!squadList) setSquads(undefined);
      else if ('list' in squadList) setSquads(squadList.list?.squads);
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
  useEffect(() => {
    if (!client) return;
    const poll = setInterval(() => void refreshRef.current(), REFRESH_MS);
    return () => clearInterval(poll);
  }, [client]);

  // A 2xx body can carry `dispatchError`: the record was saved but its runs
  // did not start. Surface it after the refetch, so the saved state shows.
  const reportDispatch = useCallback(
    (result: unknown) => {
      const dispatchError =
        result !== null && typeof result === 'object'
          ? (result as { dispatchError?: unknown }).dispatchError
          : undefined;
      if (typeof dispatchError === 'string') {
        setActionError(
          t('collab.error.dispatchAfterSave', { error: dispatchError }),
        );
      }
    },
    [t],
  );

  const mutate = useCallback(
    async (action: () => Promise<unknown>) => {
      setPending(true);
      setActionError(undefined);
      try {
        const result = await action();
        await refresh();
        reportDispatch(result);
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        setPending(false);
      }
      return true;
    },
    [refresh, reportDispatch],
  );

  if (!client) {
    return <p role="alert">{t('collab.noWorkspace')}</p>;
  }

  const localRuntimePrograms = runtimes.find(
    (entry) => entry.kind === 'local',
  )?.programs;

  if (creatingAgent) {
    return (
      <AgentCreatePage
        initialScope="workspace"
        workspaceCwd={workspaceCwd}
        executionHosts={runtimes.filter((entry) => entry.kind === 'external')}
        {...(localRuntimePrograms
          ? { localPrograms: localRuntimePrograms }
          : {})}
        {...(creatingAgent.hostId
          ? { initialHostId: creatingAgent.hostId }
          : {})}
        onCancel={() => setCreatingAgent(undefined)}
        onCreated={() => setCreatingAgent(undefined)}
        onSaveWorkspaceAgent={async (input) => {
          const result = await client.createAgent(input);
          await refresh();
          reportDispatch(result);
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
    createSquad,
    updateSquad,
    retireSquad,
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
        {...(squads && createSquad && updateSquad && retireSquad
          ? {
              squads: {
                squads,
                onCreate: (input: SquadInput) =>
                  mutate(() => createSquad(input)),
                onUpdate: (id: string, input: SquadInput) =>
                  mutate(() => updateSquad(id, input)),
                onRetire: (id: string) => void mutate(() => retireSquad(id)),
              },
            }
          : {})}
        {...(onOpenDefinitions ? { onOpenDefinitions } : {})}
        hostServerUrl={workspace.baseUrl}
      />
    </>
  );
}
