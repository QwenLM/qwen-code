/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useI18n } from '../../i18n';
import {
  ShareAgentDialog,
  type AgentShare,
  type AgentShareSummary,
} from './share-agent-dialog';
import { useMemo, useState, type FormEvent } from 'react';
import {
  ChevronRightIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from 'lucide-react';

import { AuthorAvatar } from '../messages/author-avatar';
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import {
  explainSkip,
  groupThreads,
  needsAttention,
  statusReasonLabel,
  summarizePreview,
  type RoutingPreviewTarget,
  type ThreadGroup,
  type ThreadSummaryView,
} from './agents-view-logic';
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
}

/** What every agent in this workspace may do. A property of the subsystem. */
export interface AgentCapabilitiesView {
  readOnly: boolean;
  allowed: readonly string[];
  threadTools: readonly string[];
}

export interface ThreadsPageProps {
  createError?: string;
  agents: readonly WorkspaceAgentSummaryView[];
  threads: readonly ThreadSummaryView[];
  view: AgentWorkspaceView;
  onViewChange: (view: AgentWorkspaceView) => void;
  onOpenThread: (threadId: string) => void;
  onDeleteAgent: (agentId: string) => void;
  onSetAgentEnabled: (agentId: string, enabled: boolean) => void;
  onUpdateAgent?: (agentId: string, patch: AgentConfigPatch) => void;
  onOpenAgentBuilder?: () => void;
  onOpenDefinitions?: () => void;
  /** A2A shares of one agent; absent hides Share. */
  shares?: {
    create: (agentId: string) => Promise<AgentShare>;
    list: (agentId: string) => Promise<AgentShareSummary[]>;
    revoke: (agentId: string, callerId: string) => Promise<unknown>;
  };
  capabilities?: AgentCapabilitiesView;
  onCreateThread: (input: NewThread) => Promise<boolean> | void;
  workspaceCwd?: string;
  workspaces?: readonly { cwd: string }[];
  onWorkspaceChange?: (cwd: string) => void;
  onPreviewThread?: (assignee?: string) => void;
  createPreview?: readonly RoutingPreviewTarget[];
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
  enabled: boolean;
  status: 'offline' | 'idle' | 'working' | 'blocked' | 'error';
  /** Set once the identity is retired: it keeps its posts and takes no work. */
  retiredAt?: number;
  workingOn?: {
    id: string;
    title: string;
    state: 'working' | 'finishing' | 'stopping';
  };
  waiting: number;
}

export type AgentWorkspaceView = 'agents' | 'tasks';

export interface NewWorkspaceAgent {
  name: string;
  description?: string;
  agentType?: string;
  model?: string;
  instructions?: string;
  maxConcurrentRuns?: number;
}

export type ThreadPriorityChoice = 'urgent' | 'high' | 'normal' | 'low';

export interface NewThread {
  title: string;
  body: string;
  /** What "done" means. Sent only when written, so a blank stays absent. */
  acceptanceCriteria?: string;
  priority?: ThreadPriorityChoice;
  assignee?: string;
  /** The first post; the assignee starts from it. */
  message?: string;
}

const AGENT_STATUSES = new Set([
  'idle',
  'working',
  'blocked',
  'offline',
  'error',
  'finishing',
  'stopping',
]);

function ThreadRow({
  thread,
  onOpen,
}: {
  thread: ThreadSummaryView;
  onOpen: (threadId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={styles.row}
      data-attention={needsAttention(thread) || undefined}
      onClick={() => onOpen(thread.id)}
    >
      <span className={styles.rowText}>
        <span className={styles.rowTitle}>{thread.title}</span>
        {/* The status sentence comes from the server's resolver. The UI only
            translates it one for one; it must not derive a second, shorter
            vocabulary, which would win because it is the one on screen. */}
        <span className={styles.rowReason}>
          {statusReasonLabel(thread.reason, t)}
        </span>
      </span>
      <ChevronRightIcon aria-hidden="true" className={styles.rowChevron} />
    </button>
  );
}

function Group({
  group,
  onOpenThread,
  hidden,
}: {
  group: ThreadGroup;
  onOpenThread: (threadId: string) => void;
  hidden?: boolean;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(group.collapsedByDefault);
  const collapsible = group.collapsedByDefault;
  return (
    <section className={styles.group} hidden={hidden}>
      <button
        type="button"
        className={
          collapsible
            ? `${styles.groupHeading} ${styles.groupHeadingToggle}`
            : styles.groupHeading
        }
        onClick={collapsible ? () => setCollapsed((open) => !open) : undefined}
        aria-expanded={collapsible ? !collapsed : undefined}
        disabled={!collapsible}
      >
        {t(`collab.group.${group.key}`)}
        <span className={styles.groupCount}>{group.threads.length}</span>
      </button>
      {!collapsed && (
        <div className={styles.list}>
          {group.threads.map((thread) => (
            <ThreadRow key={thread.id} thread={thread} onOpen={onOpenThread} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The thread list, grouped by what each thread needs.
 *
 * Recency sorting is the obvious default and it buries the two threads that
 * need a person under twenty that do not. Grouping answers the question
 * someone actually opens this page with.
 */
export function ThreadsPage({
  agents,
  threads,
  view,
  onViewChange,
  onOpenThread,
  onDeleteAgent,
  onSetAgentEnabled,
  onUpdateAgent,
  onOpenAgentBuilder,
  onOpenDefinitions,
  shares,
  capabilities,
  onCreateThread,
  workspaceCwd,
  workspaces,
  onWorkspaceChange,
  createError,
  onPreviewThread,
  createPreview,
  pending,
}: ThreadsPageProps) {
  const groups = useMemo(() => groupThreads(threads), [threads]);
  const [creating, setCreating] = useState<'thread'>();
  const [configuring, setConfiguring] = useState<string>();
  const [openAgentId, setOpenAgentId] = useState<string>();
  const { t } = useI18n();
  const [sharing, setSharing] = useState<{ id: string; name: string }>();
  const [taskAssignee, setTaskAssignee] = useState('');
  const statusLabel = (status: string) =>
    AGENT_STATUSES.has(status) ? t(`collab.agentStatus.${status}`) : status;

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
      onUpdateAgent(agentId, {
        description: field('description'),
        model: field('model'),
        agentType: field('agentType'),
        instructions: field('instructions'),
        maxConcurrentRuns: runs === '' ? null : Number(runs),
      });
      setConfiguring(undefined);
    };

  const submitThread = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const assignee = String(data.get('assignee') ?? '');
    const acceptanceCriteria = String(
      data.get('acceptanceCriteria') ?? '',
    ).trim();
    const priority = String(data.get('priority') ?? '');
    const created = await onCreateThread({
      title: String(data.get('title') ?? '').trim(),
      body: String(data.get('body') ?? '').trim(),
      // Left out when blank or ordinary, so the thread records a decision
      // only where one was made.
      ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
      ...(priority && priority !== 'normal'
        ? { priority: priority as ThreadPriorityChoice }
        : {}),
      ...(assignee ? { assignee } : {}),
    });
    if (created === false) return;
    onPreviewThread?.(undefined);
    setCreating(undefined);
  };

  const openView = (next: AgentWorkspaceView) => {
    onViewChange(next);
    setCreating(undefined);
    setConfiguring(undefined);
    setOpenAgentId(undefined);
    onPreviewThread?.(undefined);
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
          {view === 'tasks' ? (
            <Button
              onClick={() => {
                setCreating('thread');
                setTaskAssignee('');
                onPreviewThread?.(undefined);
              }}
            >
              <PlusIcon data-icon="inline-start" />
              {t('collab.thread.new')}
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
        {(['agents', 'tasks'] as const).map((item) => (
          <ToggleGroupItem key={item} value={item}>
            {t(`collab.tabs.${item}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div className="contents">
        <Dialog
          open={view === 'tasks' && creating === 'thread'}
          onOpenChange={(open) => {
            if (!open && !pending) setCreating(undefined);
          }}
        >
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t('collab.thread.new')}</DialogTitle>
              <DialogDescription>
                {t('collab.thread.newHint')}
              </DialogDescription>
            </DialogHeader>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => void submitThread(event)}
            >
              {createError && (
                <p role="alert" className="text-sm text-destructive">
                  {createError}
                </p>
              )}
              <label className="text-xs text-muted-foreground">
                {t('collab.form.project')}
                <select
                  className={styles.field}
                  value={workspaceCwd ?? ''}
                  disabled={pending}
                  onChange={(event) => {
                    setTaskAssignee('');
                    onWorkspaceChange?.(event.target.value);
                  }}
                >
                  {workspaceCwd &&
                    !workspaces?.some(
                      (entry) => entry.cwd === workspaceCwd,
                    ) && (
                      <option value={workspaceCwd}>
                        {workspaceCwd.split(/[\\/]/).filter(Boolean).at(-1)}
                      </option>
                    )}
                  {workspaces?.map((entry) => (
                    <option key={entry.cwd} value={entry.cwd}>
                      {entry.cwd.split(/[\\/]/).filter(Boolean).at(-1)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs text-muted-foreground">
                <span className="block break-all">{workspaceCwd}</span>
                {t('collab.form.projectHint')}
              </p>
              <input
                className="w-full border-0 bg-transparent text-xl font-medium outline-none"
                name="title"
                aria-label={t('collab.form.titleLabel')}
                placeholder={t('collab.form.title')}
                required
              />
              <textarea
                className={styles.field}
                name="body"
                aria-label={t('collab.form.bodyLabel')}
                rows={6}
                placeholder={t('collab.form.body')}
                required
              />
              <textarea
                className={styles.field}
                name="acceptanceCriteria"
                aria-label={t('collab.form.criteriaLabel')}
                placeholder={t('collab.form.criteria')}
              />
              <select
                className={styles.field}
                name="priority"
                aria-label={t('collab.form.priority')}
                defaultValue="normal"
              >
                {(['urgent', 'high', 'normal', 'low'] as const).map((level) => (
                  <option key={level} value={level}>
                    {t(`collab.priority.${level}`)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {t('collab.form.priorityHint')}
              </p>
              <select
                className={styles.field}
                name="assignee"
                key={workspaceCwd}
                aria-label={t('collab.form.assignee')}
                defaultValue={taskAssignee}
                onChange={(event) => {
                  setTaskAssignee(event.target.value);
                  onPreviewThread?.(event.target.value || undefined);
                }}
              >
                <option value="">{t('collab.form.noAssignee')}</option>
                {agents
                  .filter((agent) => agent.enabled && !agent.retiredAt)
                  .map((agent) => (
                    <option key={agent.id} value={agent.name}>
                      {agent.name}
                    </option>
                  ))}
              </select>
              {!taskAssignee && (
                <p className="text-xs text-muted-foreground">
                  {t('collab.form.noAssigneeHint')}
                </p>
              )}
              {createPreview ? (
                <div
                  role="status"
                  className="space-y-1 text-xs text-muted-foreground"
                >
                  <strong>
                    {taskAssignee
                      ? summarizePreview(createPreview, t)
                      : t('collab.form.saveOnly')}
                  </strong>
                  {createPreview
                    .filter((target) => !target.willWake)
                    .map((target) => {
                      const explained = explainSkip(
                        target.reason ?? '',
                        target.agentName,
                        t,
                      );
                      return (
                        <p
                          key={`${target.agentName}:${target.reason ?? 'unknown'}`}
                        >
                          {explained}
                        </p>
                      );
                    })}
                </div>
              ) : null}
              <div className={styles.formActions}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setCreating(undefined);
                    onPreviewThread?.(undefined);
                  }}
                >
                  {t('collab.form.cancel')}
                </Button>
                <Button type="submit" size="sm" disabled={pending}>
                  {pending
                    ? t('collab.form.creating')
                    : t('collab.form.create')}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

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
                        <button
                          type="button"
                          className={styles.agentName}
                          aria-expanded={openAgentId === agent.id}
                          onClick={() =>
                            setOpenAgentId(
                              openAgentId === agent.id ? undefined : agent.id,
                            )
                          }
                        >
                          {agent.name}
                        </button>
                      </CardTitle>
                      <Badge
                        variant="secondary"
                        className={styles.statusBadge}
                        data-status={
                          agent.retiredAt || !agent.enabled
                            ? 'off'
                            : agent.workingOn
                              ? 'working'
                              : agent.status
                        }
                      >
                        {agent.retiredAt
                          ? t('collab.agentStatus.retired')
                          : !agent.enabled
                            ? t('collab.agentStatus.paused')
                            : agent.workingOn
                              ? statusLabel(agent.workingOn.state)
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
                    {agent.workingOn ? (
                      <button
                        type="button"
                        className={styles.agentActivityLink}
                        onClick={() => onOpenThread(agent.workingOn!.id)}
                      >
                        {t('collab.agent.workingOn', {
                          title: agent.workingOn.title,
                        })}
                      </button>
                    ) : null}
                  </div>
                  {agent.retiredAt ? null : (
                    <div className={styles.agentActions}>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!agent.enabled || pending}
                        onClick={() => {
                          openView('tasks');
                          setTaskAssignee(agent.name);
                          setCreating('thread');
                          onPreviewThread?.(agent.name);
                        }}
                      >
                        {t('collab.agent.mentionIt')}
                      </Button>
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
                              onSelect={() => setConfiguring(agent.id)}
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
                            disabled={Boolean(agent.workingOn || agent.waiting)}
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
                {configuring === agent.id && onUpdateAgent ? (
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
                        defaultValue={agent.agentType ?? ''}
                        placeholder={t('collab.config.workspaceDefault')}
                      />
                    </label>
                    <label className={styles.configLabel}>
                      {t('collab.config.model')}
                      <input
                        className={styles.field}
                        name="model"
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
                {openAgentId === agent.id ? (
                  <section className={styles.agentWorkspace}>
                    <div className={styles.agentWorkspaceHeader}>
                      <strong>{t('collab.agent.assigned')}</strong>
                      <span>{statusLabel(agent.status)}</span>
                    </div>
                    {threads.some(
                      (thread) => thread.assigneeName === agent.name,
                    ) ? (
                      threads
                        .filter((thread) => thread.assigneeName === agent.name)
                        .sort((a, b) => b.updatedAt - a.updatedAt)
                        .map((thread) => (
                          <ThreadRow
                            key={thread.id}
                            thread={thread}
                            onOpen={onOpenThread}
                          />
                        ))
                    ) : (
                      <p className={styles.emptyRoster}>
                        {t('collab.agent.noneAssigned')}
                      </p>
                    )}
                  </section>
                ) : null}
              </Card>
            ))
          )}
          {capabilities ? (
            <div className={styles.ceiling}>
              <h3 className={styles.ceilingTitle}>
                {t('collab.ceiling.title')}
              </h3>
              <p className={styles.ceilingText}>
                {capabilities.readOnly
                  ? t('collab.ceiling.readOnly')
                  : t('collab.ceiling.open')}
              </p>
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  {t('collab.ceiling.tools')}
                </summary>
                <p className={styles.ceilingTools}>
                  {capabilities.allowed.join(', ')}
                </p>
              </details>
            </div>
          ) : null}
        </section>

        {groups.length === 0 ? (
          <Empty className="border" hidden={view !== 'tasks'}>
            {/* An empty screen is an invitation, not a shrug. */}
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessagesSquareIcon />
              </EmptyMedia>
              <EmptyTitle>{t('collab.empty.lead')}</EmptyTitle>
              <EmptyDescription>{t('collab.empty.hint')}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          groups.map((group) => (
            <Group
              key={group.key}
              group={group}
              onOpenThread={onOpenThread}
              hidden={view !== 'tasks'}
            />
          ))
        )}
      </div>
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
