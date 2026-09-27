/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useI18n } from '../../i18n';
import { useMemo, useState, type FormEvent } from 'react';
import { MoreHorizontalIcon, PlusIcon } from 'lucide-react';

import { Button } from '../ui/button';
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
      className={
        needsAttention(thread)
          ? `${styles.row} ${styles.attention}`
          : styles.row
      }
      onClick={() => onOpen(thread.id)}
    >
      <span className={styles.rowTitle}>{thread.title}</span>
      {/* The status sentence comes from the server's resolver. The UI only
          translates it one for one; it must not derive a second, shorter
          vocabulary, which would win because it is the one on screen. */}
      <span className={styles.rowReason}>
        {statusReasonLabel(thread.reason, t)}
      </span>
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
      {!collapsed &&
        group.threads.map((thread) => (
          <ThreadRow key={thread.id} thread={thread} onOpen={onOpenThread} />
        ))}
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

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <nav className={styles.viewTabs} aria-label={t('agents.title')}>
          {(['agents', 'tasks'] as const).map((item) => (
            <Button
              key={item}
              variant={view === item ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={view === item}
              onClick={() => openView(item)}
            >
              {t(`collab.tabs.${item}`)}
            </Button>
          ))}
        </nav>
        <div className={styles.headerActions}>
          {view === 'agents' && onOpenDefinitions ? (
            <Button variant="ghost" size="sm" onClick={onOpenDefinitions}>
              {t('collab.agent.roles')}
            </Button>
          ) : null}
          {view === 'agents' && onOpenAgentBuilder ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenAgentBuilder()}
            >
              <PlusIcon data-icon="inline-start" />
              {t('collab.agent.new')}
            </Button>
          ) : null}
          {view === 'tasks' ? (
            <Button
              size="sm"
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
      </header>
      <div className={styles.pageBody}>
        <p className="mb-5 text-sm text-muted-foreground">
          {t(`collab.tabs.${view}Hint`)}
        </p>
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
          <h2 className={styles.sectionTitle}>{t('collab.tabs.agents')}</h2>
          {agents.length === 0 ? (
            <p className={styles.emptyRoster}>{t('collab.agent.empty')}</p>
          ) : (
            agents.map((agent) => (
              <div
                key={agent.id}
                className={
                  agent.enabled && !agent.retiredAt
                    ? styles.agentRow
                    : `${styles.agentRow} ${styles.agentRowDisabled}`
                }
              >
                <span
                  className={
                    agent.enabled && !agent.retiredAt
                      ? styles.agentDot
                      : styles.agentDotDisabled
                  }
                  style={agent.color ? { color: agent.color } : undefined}
                  aria-hidden="true"
                />
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
                <span className={styles.agentDescription}>
                  {agent.description}
                </span>
                {agent.workingOn ? (
                  <button
                    type="button"
                    className={`${styles.agentActivity} ${styles.agentActivityLink}`}
                    onClick={() => onOpenThread(agent.workingOn!.id)}
                  >
                    {statusLabel(agent.workingOn.state)} ·{' '}
                    {agent.workingOn.title}
                  </button>
                ) : (
                  <span className={styles.agentActivity}>
                    {agent.retiredAt
                      ? t('collab.agentStatus.retired')
                      : !agent.enabled
                        ? t('collab.agentStatus.paused')
                        : statusLabel(agent.status)}
                  </span>
                )}
                <span className={styles.agentWaiting}>
                  {agent.waiting
                    ? t('collab.agent.waiting', { count: agent.waiting })
                    : '—'}
                </span>
                {agent.retiredAt ? null : (
                  <>
                    <button
                      type="button"
                      className={styles.agentAction}
                      disabled={!agent.enabled || pending}
                      onClick={() => {
                        openView('tasks');
                        setTaskAssignee(agent.name);
                        setCreating('thread');
                        onPreviewThread?.(agent.name);
                      }}
                    >
                      {t('collab.agent.mentionIt')}
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className={styles.agentAction}
                          aria-label={t('collab.agent.more', {
                            name: agent.name,
                          })}
                        >
                          <MoreHorizontalIcon size={16} aria-hidden="true" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-40">
                        {onUpdateAgent ? (
                          <DropdownMenuItem
                            onSelect={() => setConfiguring(agent.id)}
                          >
                            {t('collab.agent.configure')}
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
                  </>
                )}
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
              </div>
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
          <div className={styles.emptyState} hidden={view !== 'tasks'}>
            {/* An empty screen is an invitation, not a shrug. */}
            <p className={styles.emptyLead}>{t('collab.empty.lead')}</p>
            <p>{t('collab.empty.hint')}</p>
          </div>
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
    </div>
  );
}
