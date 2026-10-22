/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useI18n } from '../../i18n';
import {
  AddRuntimeDialog,
  type ConnectExistingInput,
  type JoinCoordinatorInput,
  type JoinToken,
} from './add-runtime-dialog';
import {
  ShareAgentDialog,
  type AgentShare,
  type AgentShareSummary,
} from './share-agent-dialog';
import { useState, type FormEvent } from 'react';
import { MoreHorizontalIcon, PlusIcon, ServerIcon } from 'lucide-react';

import { AuthorAvatar } from '../messages/AuthorAvatar';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardDescription, CardTitle } from '../ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../ui/empty';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  programLabel,
  runtimePrograms,
  type AgentProgramView,
} from './agents-view-logic';
import {
  SquadsEmpty,
  SquadsSection,
  type SquadsSectionProps,
} from './squads-section';
import styles from './ThreadsPage.module.css';

/**
 * A change to one agent's configuration. Absent leaves a field alone; `null`
 * clears the override and returns the agent to what its definition says.
 */
export interface AgentConfigPatch {
  description?: string | null;
  color?: string | null;
  model?: string | null;
  instructions?: string | null;
  agentType?: string | null;
  maxConcurrentRuns?: number | null;
  execution?:
    | {
        mode: 'local';
        /** Program on this computer; Qwen Code when absent. */
        provider?: AgentProgramView;
      }
    | {
        mode: 'managed-host';
        hostIds: string[];
        provider?: AgentProgramView;
      };
}

export interface ThreadsPageProps {
  onConnectRemoteHost?: (input: ConnectExistingInput) => Promise<boolean>;
  /** Joins this daemon to another coordinator as one of its runtimes. */
  onJoinCoordinator?: (input: JoinCoordinatorInput) => Promise<boolean>;
  agents: readonly WorkspaceAgentSummaryView[];
  runtimes?: readonly WorkspaceAgentRuntimeView[];
  view: AgentWorkspaceView;
  onViewChange: (view: AgentWorkspaceView) => void;
  /**
   * Puts `@name ` into the chat composer. Absent hides the agent card's
   * mention button.
   */
  onMentionAgent?: (name: string) => void;
  onDeleteAgent: (agentId: string) => void;
  onSetAgentEnabled: (agentId: string, enabled: boolean) => void;
  onUpdateAgent?: (agentId: string, patch: AgentConfigPatch) => void;
  onOpenAgentBuilder?: (hostId?: string) => void;
  onOpenDefinitions?: () => void;
  /** Issues a single-use join token for the Add runtime dialog. */
  onCreateJoinToken?: (supersedesHostId?: string) => Promise<JoinToken>;
  onRemoveRuntime?: (hostId: string) => void;
  hostServerUrl?: string;
  /** A2A shares of one agent; absent hides Share. */
  shares?: {
    create: (agentId: string) => Promise<AgentShare>;
    list: (agentId: string) => Promise<AgentShareSummary[]>;
    revoke: (agentId: string, callerId: string) => Promise<unknown>;
  };
  /**
   * The workspace's squads and their actions. Absent (a daemon without squad
   * routes, or not loaded yet) shows the Squads view empty, with no New squad.
   */
  squads?: Pick<
    SquadsSectionProps,
    'squads' | 'onCreate' | 'onUpdate' | 'onRetire'
  >;
  pending?: boolean;
}

export interface WorkspaceAgentSummaryView {
  id: string;
  name: string;
  description?: string;
  color?: string;
  /** Definition supplying the persona. Absent uses the workspace default. */
  agentType?: string;
  model?: string;
  /** What this identity is told on top of its definition's prompt. */
  instructions?: string;
  maxConcurrentRuns?: number;
  execution?: AgentConfigPatch['execution'];
  enabled: boolean;
  status: 'offline' | 'idle' | 'working' | 'error';
  /** Absent from a daemon older than runtimes; that agent runs here. */
  runtime?: WorkspaceAgentRuntimeView;
  /** Set once the identity is retired: it keeps its posts and takes no work. */
  retiredAt?: number;
  /** Queued session-agent runs waiting for this agent. */
  waiting: number;
}

export interface WorkspaceAgentRuntimeView {
  id: string;
  kind: 'local' | 'external';
  label: string;
  provider: string;
  /**
   * Program ids (`qwen` | `claude` | `codex`) the runtime reported it can run,
   * the local daemon included (from its program probe). None means Qwen Code.
   */
  programs?: readonly string[];
  status: 'online' | 'offline';
  workspaceId?: string;
  workspaceCwd?: string;
  lastSeenAt?: number;
  agentCount?: number;
  sessionCount?: number;
  runningTaskCount?: number;
  queuedTaskCount?: number;
}

export type AgentWorkspaceView = 'agents' | 'squads' | 'runtime';

export interface NewWorkspaceAgent {
  name: string;
  description?: string;
  agentType?: string;
  model?: string;
  instructions?: string;
  maxConcurrentRuns?: number;
  execution?: AgentConfigPatch['execution'];
}

const AGENT_STATUSES = new Set([
  'online',
  'idle',
  'working',
  'offline',
  'error',
]);

/**
 * The Agents page: the workspace's agent roster, its squads, and the runtimes
 * agents run on.
 * Agents are addressed by @-mention in a chat session; this page only manages
 * who they are and where they run.
 */
export function ThreadsPage({
  agents,
  runtimes,
  view,
  onViewChange,
  onMentionAgent,
  onDeleteAgent,
  onSetAgentEnabled,
  onUpdateAgent,
  onOpenAgentBuilder,
  onOpenDefinitions,
  onCreateJoinToken,
  onRemoveRuntime,
  onConnectRemoteHost,
  onJoinCoordinator,
  hostServerUrl,
  shares,
  squads,
  pending,
}: ThreadsPageProps) {
  const runtimeEntries = runtimes ?? [];
  const [configuring, setConfiguring] = useState<{
    id: string;
    hostIds: string[];
  }>();
  const { t } = useI18n();
  const [addingRuntime, setAddingRuntime] = useState(false);
  const [replacingRuntime, setReplacingRuntime] =
    useState<WorkspaceAgentRuntimeView>();
  const [sharing, setSharing] = useState<{ id: string; name: string }>();
  const [creatingSquad, setCreatingSquad] = useState(false);
  const statusLabel = (status: string) =>
    AGENT_STATUSES.has(status) ? t(`collab.agentStatus.${status}`) : status;
  const hostLabel = (entry?: WorkspaceAgentRuntimeView) =>
    !entry || entry.kind === 'local'
      ? t('collab.agent.thisComputer')
      : entry.label;
  // "Program · Runtime": what the agent runs as, then where.
  const agentPlace = (agent: WorkspaceAgentSummaryView) =>
    `${programLabel(agent.execution?.provider)} · ${hostLabel(agent.runtime)}`;

  const submitConfig =
    (agentId: string) => (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!onUpdateAgent) return;
      const data = new FormData(event.currentTarget);
      const field = (name: string): string | null => {
        const value = String(data.get(name) ?? '').trim();
        // A field emptied on purpose clears the override rather than being
        // ignored, which is the difference between "no opinion" and "back to
        // the definition".
        return value === '' ? null : value;
      };
      const runs = String(data.get('maxConcurrentRuns') ?? '').trim();
      const hostIds = data
        .getAll('executionHostId')
        .map((value) => String(value));
      const current = agents.find((agent) => agent.id === agentId);
      const currentHostIds =
        current?.execution?.mode === 'managed-host'
          ? current.execution.hostIds
          : [];
      const placementChanged =
        hostIds.length !== currentHostIds.length ||
        hostIds.some((hostId) => !currentHostIds.includes(hostId));
      // Moving an agent keeps the program it is bound to, wherever the new
      // place offers it.
      const currentProgram = current?.execution?.provider;
      const localRuntime = runtimeEntries.find(
        (entry) => entry.kind === 'local',
      );
      onUpdateAgent(agentId, {
        description: field('description'),
        model: field('model'),
        agentType: field('agentType'),
        instructions: field('instructions'),
        maxConcurrentRuns: runs === '' ? null : Number(runs),
        ...(placementChanged
          ? {
              execution:
                hostIds.length > 0
                  ? ({
                      mode: 'managed-host',
                      hostIds,
                      ...(currentProgram ? { provider: currentProgram } : {}),
                    } as const)
                  : ({
                      mode: 'local',
                      ...(currentProgram &&
                      localRuntime &&
                      runtimePrograms(localRuntime).includes(currentProgram)
                        ? { provider: currentProgram }
                        : {}),
                    } as const),
            }
          : {}),
      });
      setConfiguring(undefined);
    };

  const openView = (next: AgentWorkspaceView) => {
    onViewChange(next);
    setConfiguring(undefined);
    setCreatingSquad(false);
  };

  // Laid out as the role templates view it swaps with: title and actions,
  // the view switch where that page has its filter, then the list.
  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-balance">
            {t('agents.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(`collab.tabs.${view}Hint`)}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {view === 'agents' && onOpenDefinitions ? (
            <Button variant="outline" onClick={onOpenDefinitions}>
              {t('collab.agent.roles')}
            </Button>
          ) : null}
          {view === 'agents' && onOpenAgentBuilder ? (
            <Button onClick={() => onOpenAgentBuilder()}>
              <PlusIcon data-icon="inline-start" />
              {t('collab.agent.new')}
            </Button>
          ) : null}
          {view === 'squads' && squads ? (
            <Button disabled={pending} onClick={() => setCreatingSquad(true)}>
              <PlusIcon data-icon="inline-start" />
              {t('collab.squad.new')}
            </Button>
          ) : null}
          {view === 'runtime' && onCreateJoinToken ? (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                setReplacingRuntime(undefined);
                setAddingRuntime(true);
              }}
            >
              <PlusIcon data-icon="inline-start" />
              {t('collab.runtime.addTitle')}
            </Button>
          ) : null}
        </div>
      </div>
      <ToggleGroup
        type="single"
        value={view}
        onValueChange={(value) => {
          if (value) openView(value as AgentWorkspaceView);
        }}
        variant="outline"
        size="sm"
        aria-label={t('agents.title')}
      >
        {(['agents', 'squads', 'runtime'] as const).map((item) => (
          <ToggleGroupItem key={item} value={item}>
            {t(`collab.tabs.${item}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div className="contents">
        <section className={styles.roster} hidden={view !== 'agents'}>
          {agents.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PlusIcon />
                </EmptyMedia>
                <EmptyTitle>{t('collab.agent.empty')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            agents.map((agent) => (
              <Card
                key={agent.id}
                size="sm"
                className={
                  agent.enabled && !agent.retiredAt
                    ? styles.agentCard
                    : `${styles.agentCard} ${styles.agentRowDisabled}`
                }
              >
                <div className={styles.agentRow}>
                  <AuthorAvatar
                    name={agent.name}
                    color={agent.color}
                    size="md"
                  />
                  <div className={styles.agentMain}>
                    <div className={styles.agentTitleLine}>
                      <CardTitle className="min-w-0 truncate">
                        {agent.name}
                      </CardTitle>
                      <Badge
                        variant="secondary"
                        className={styles.statusBadge}
                        data-status={
                          agent.retiredAt || !agent.enabled
                            ? 'off'
                            : agent.status
                        }
                      >
                        {agent.retiredAt
                          ? t('collab.agentStatus.retired')
                          : !agent.enabled
                            ? t('collab.agentStatus.paused')
                            : statusLabel(agent.status)}
                      </Badge>
                      {agent.waiting ? (
                        <Badge variant="outline" className="text-[10px]">
                          {t('collab.agent.waiting', { count: agent.waiting })}
                        </Badge>
                      ) : null}
                    </div>
                    <CardDescription className="truncate text-xs">
                      {agent.description || '—'}
                    </CardDescription>
                    <span className="truncate text-xs text-muted-foreground">
                      {agentPlace(agent)}
                    </span>
                  </div>
                  {agent.retiredAt ? null : (
                    <div className={styles.agentActions}>
                      {onMentionAgent ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!agent.enabled || pending}
                          onClick={() => onMentionAgent(agent.name)}
                        >
                          {t('collab.agent.mentionIt')}
                        </Button>
                      ) : null}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('collab.agent.more', {
                              name: agent.name,
                            })}
                          >
                            <MoreHorizontalIcon aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-40">
                          {onUpdateAgent ? (
                            <DropdownMenuItem
                              onSelect={() =>
                                setConfiguring({
                                  id: agent.id,
                                  hostIds:
                                    agent.execution?.mode === 'managed-host'
                                      ? [...agent.execution.hostIds]
                                      : [],
                                })
                              }
                            >
                              {t('collab.agent.configure')}
                            </DropdownMenuItem>
                          ) : null}
                          {shares ? (
                            <DropdownMenuItem
                              onSelect={() =>
                                setSharing({ id: agent.id, name: agent.name })
                              }
                            >
                              {t('collab.agent.share')}
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem
                            disabled={pending}
                            onSelect={() =>
                              onSetAgentEnabled(agent.id, !agent.enabled)
                            }
                          >
                            {agent.enabled
                              ? t('collab.agent.pause')
                              : t('collab.agent.resume')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={
                              agent.status === 'working' || agent.waiting > 0
                            }
                            onSelect={() => {
                              if (
                                window.confirm(
                                  t('collab.agent.retireConfirm', {
                                    name: agent.name,
                                  }),
                                )
                              ) {
                                onDeleteAgent(agent.id);
                              }
                            }}
                          >
                            {t('collab.agent.retire')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )}
                </div>
                {configuring?.id === agent.id && onUpdateAgent ? (
                  <form
                    className={styles.agentConfig}
                    onSubmit={submitConfig(agent.id)}
                  >
                    <label className={styles.configLabel}>
                      {t('collab.config.description')}
                      <input
                        className={styles.field}
                        name="description"
                        defaultValue={agent.description ?? ''}
                        placeholder={t('collab.config.descriptionHint')}
                      />
                    </label>
                    <label className={styles.configLabel}>
                      {t('collab.config.instructions')}
                      <textarea
                        className={styles.field}
                        name="instructions"
                        rows={4}
                        defaultValue={agent.instructions ?? ''}
                        placeholder={t('collab.config.instructionsHint')}
                      />
                    </label>
                    <label className={styles.configLabel}>
                      {t('collab.config.agentType')}
                      <input
                        className={styles.field}
                        name="agentType"
                        disabled={configuring.hostIds.length > 0}
                        defaultValue={agent.agentType ?? ''}
                        placeholder={t('collab.config.workspaceDefault')}
                      />
                    </label>
                    <label className={styles.configLabel}>
                      {t('collab.config.model')}
                      <input
                        className={styles.field}
                        name="model"
                        disabled={configuring.hostIds.length > 0}
                        defaultValue={agent.model ?? ''}
                        placeholder={t('collab.config.workspaceDefault')}
                      />
                    </label>
                    <label className={styles.configLabel}>
                      {t('collab.config.maxRuns')}
                      <input
                        className={styles.field}
                        name="maxConcurrentRuns"
                        type="number"
                        min={1}
                        max={8}
                        defaultValue={agent.maxConcurrentRuns ?? 1}
                      />
                    </label>
                    {runtimeEntries.some(
                      (entry) => entry.kind === 'external',
                    ) ? (
                      <fieldset className={styles.configLabel}>
                        <legend>{t('collab.config.runtimes')}</legend>
                        {runtimeEntries
                          .filter((entry) => entry.kind === 'external')
                          .map((entry) => (
                            <label key={entry.id}>
                              <input
                                name="executionHostId"
                                type="checkbox"
                                value={entry.id}
                                checked={configuring.hostIds.includes(entry.id)}
                                disabled={
                                  !configuring.hostIds.includes(entry.id) &&
                                  !runtimePrograms(entry).includes(
                                    agent.execution?.provider ?? 'qwen',
                                  )
                                }
                                onChange={(event) => {
                                  const hostIds = event.target.checked
                                    ? [...configuring.hostIds, entry.id]
                                    : configuring.hostIds.filter(
                                        (id) => id !== entry.id,
                                      );
                                  setConfiguring({ id: agent.id, hostIds });
                                }}
                              />{' '}
                              {hostLabel(entry)} ·{' '}
                              {runtimePrograms(entry)
                                .map(programLabel)
                                .join(', ')}{' '}
                              · {statusLabel(entry.status)}
                            </label>
                          ))}
                        <span className={styles.configNote}>
                          {t(
                            configuring.hostIds.length > 0
                              ? 'collab.agent.hostPersona'
                              : 'collab.config.runtimesHint',
                          )}
                        </span>
                      </fieldset>
                    ) : null}
                    <p className={styles.configNote}>
                      {t('collab.config.note')}
                    </p>
                    <div className={styles.formActions}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfiguring(undefined)}
                      >
                        {t('collab.form.cancel')}
                      </Button>
                      <Button type="submit" size="sm" disabled={pending}>
                        {t('collab.config.save')}
                      </Button>
                    </div>
                  </form>
                ) : null}
              </Card>
            ))
          )}
        </section>

        {view === 'squads' ? (
          squads ? (
            <SquadsSection
              {...squads}
              agents={agents}
              pending={pending}
              creating={creatingSquad}
              onCreatingChange={setCreatingSquad}
              {...(onMentionAgent ? { onMention: onMentionAgent } : {})}
            />
          ) : (
            <SquadsEmpty />
          )
        ) : null}

        {view === 'runtime' && runtimeEntries.length > 0 ? (
          runtimeEntries.map((runtimeEntry) => (
            <section className={styles.runtimeCard} key={runtimeEntry.id}>
              <div className={styles.runtimeHeader}>
                <h2 className={styles.runtimeTitle}>
                  {hostLabel(runtimeEntry)}
                </h2>
                <p className={styles.configNote}>
                  {runtimeEntry.kind === 'local'
                    ? t('collab.runtime.localNote')
                    : t('collab.runtime.remoteNote')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <strong
                  className={styles.runtimeStatus}
                  data-runtime-status={runtimeEntry.status}
                >
                  {statusLabel(runtimeEntry.status)}
                </strong>
                {runtimeEntry.kind === 'external' &&
                (onRemoveRuntime || onCreateJoinToken) ? (
                  <>
                    {onCreateJoinToken ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => {
                          setReplacingRuntime(runtimeEntry);
                          setAddingRuntime(true);
                        }}
                      >
                        {t('collab.runtime.replace')}
                      </Button>
                    ) : null}
                    {onRemoveRuntime ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => {
                          if (
                            window.confirm(
                              t('collab.runtime.removeConfirm', {
                                name: runtimeEntry.label,
                              }),
                            )
                          ) {
                            onRemoveRuntime(runtimeEntry.id);
                          }
                        }}
                      >
                        {t('collab.runtime.remove')}
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </div>
              <dl className={styles.runtimeFacts}>
                <div>
                  <dt>{t('collab.runtime.programs')}</dt>
                  <dd>
                    {runtimePrograms(runtimeEntry).map(programLabel).join(', ')}
                  </dd>
                </div>
                {runtimeEntry.workspaceCwd ? (
                  <div>
                    <dt>{t('collab.runtime.folder')}</dt>
                    <dd>
                      <code>{runtimeEntry.workspaceCwd}</code>
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>{t('collab.runtime.agents')}</dt>
                  <dd>{runtimeEntry.agentCount ?? 0}</dd>
                </div>
                <div>
                  <dt>{t('collab.runtime.running')}</dt>
                  <dd>{runtimeEntry.runningTaskCount ?? 0}</dd>
                </div>
                <div>
                  <dt>{t('collab.runtime.queued')}</dt>
                  <dd>{runtimeEntry.queuedTaskCount ?? 0}</dd>
                </div>
              </dl>
              <details className="mt-4 text-xs text-muted-foreground">
                <summary className="cursor-pointer">
                  {t('collab.runtime.technical')}
                </summary>
                <p>{t('collab.runtime.id', { id: runtimeEntry.id })}</p>
                <p>
                  {t('collab.runtime.sessions', {
                    count: runtimeEntry.sessionCount ?? 0,
                  })}
                </p>
                {runtimeEntry.lastSeenAt && (
                  <p>
                    {t('collab.runtime.lastSeen', {
                      time: new Date(
                        runtimeEntry.lastSeenAt,
                      ).toLocaleTimeString(),
                    })}
                  </p>
                )}
              </details>
            </section>
          ))
        ) : view === 'runtime' ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ServerIcon />
              </EmptyMedia>
              <EmptyTitle>{t('collab.runtime.empty')}</EmptyTitle>
              <EmptyDescription>
                {t('collab.runtime.emptyHint')}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </div>
      {onCreateJoinToken && (
        <AddRuntimeDialog
          key={replacingRuntime?.id ?? 'add-host'}
          open={addingRuntime}
          onOpenChange={(open) => {
            setAddingRuntime(open);
            if (!open) setReplacingRuntime(undefined);
          }}
          serverUrl={hostServerUrl ?? ''}
          runtimes={runtimeEntries}
          onCreateJoinToken={onCreateJoinToken}
          replacementTarget={replacingRuntime}
          {...(onConnectRemoteHost
            ? { onConnectExisting: onConnectRemoteHost }
            : {})}
          {...(onJoinCoordinator ? { onJoinCoordinator } : {})}
          {...(onOpenAgentBuilder
            ? {
                onCreateAgentOn: (runtimeId: string) => {
                  setAddingRuntime(false);
                  onOpenAgentBuilder(runtimeId);
                },
              }
            : {})}
        />
      )}
      {shares && sharing && (
        <ShareAgentDialog
          agentName={sharing.name}
          open
          onOpenChange={(open) => {
            if (!open) setSharing(undefined);
          }}
          onCreate={() => shares.create(sharing.id)}
          onList={() => shares.list(sharing.id)}
          onRevoke={(callerId) => shares.revoke(sharing.id, callerId)}
        />
      )}
    </div>
  );
}
