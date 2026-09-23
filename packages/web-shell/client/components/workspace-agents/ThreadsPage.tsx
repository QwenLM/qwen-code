/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useI18n } from '../../i18n';
import { AddRuntimeDialog, type JoinToken } from './add-runtime-dialog';
import { useMemo, useState, type FormEvent } from 'react';
import { PlusIcon } from 'lucide-react';

import { Button } from '../ui/button';
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
  execution?: { mode: 'local' } | { mode: 'managed-host'; hostIds: string[] };
}

/** What every agent in this workspace may do. A property of the subsystem. */
export interface AgentCapabilitiesView {
  readOnly: boolean;
  allowed: readonly string[];
  threadTools: readonly string[];
}

export interface ThreadsPageProps {
  onConnectRemoteHost?: (input: {
    remoteUrl: string;
    remoteToken: string;
    remoteCwd: string;
    serverUrl: string;
    provider: 'qwen' | 'codex';
    allowHttp: boolean;
  }) => Promise<boolean>;
  hideNavigation?: boolean;
  createError?: string;
  agents: readonly WorkspaceAgentSummaryView[];
  threads: readonly ThreadSummaryView[];
  runtimes?: readonly WorkspaceAgentRuntimeView[];
  view: AgentWorkspaceView;
  onViewChange: (view: AgentWorkspaceView) => void;
  onOpenThread: (threadId: string) => void;
  onDeleteAgent: (agentId: string) => void;
  onSetAgentEnabled: (agentId: string, enabled: boolean) => void;
  onUpdateAgent?: (agentId: string, patch: AgentConfigPatch) => void;
  onOpenAgentBuilder?: () => void;
  onOpenDefinitions?: () => void;
  /** Issues a single-use join token for the Add runtime dialog. */
  onCreateJoinToken?: () => Promise<JoinToken>;
  hostServerUrl?: string;
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
  execution?: AgentConfigPatch['execution'];
  enabled: boolean;
  status: 'offline' | 'idle' | 'working' | 'blocked' | 'error';
  runtime: WorkspaceAgentRuntimeView;
  /** Set once the identity is retired: it keeps its posts and takes no work. */
  retiredAt?: number;
  workingOn?: {
    id: string;
    title: string;
    state: 'working' | 'finishing' | 'stopping';
  };
  waiting: number;
}

export interface WorkspaceAgentRuntimeView {
  id: string;
  kind: 'local' | 'external';
  label: string;
  provider: string;
  status: 'online' | 'offline';
  workspaceId?: string;
  workspaceCwd?: string;
  hostSessionId?: string;
  lastSeenAt?: number;
  agentCount?: number;
  sessionCount?: number;
  runningTaskCount?: number;
  queuedTaskCount?: number;
}

export type AgentWorkspaceView = 'agents' | 'tasks' | 'runtime';

export interface NewWorkspaceAgent {
  name: string;
  description?: string;
  agentType?: string;
  model?: string;
  instructions?: string;
  maxConcurrentRuns?: number;
  execution?: AgentConfigPatch['execution'];
}

export type ThreadPriorityChoice = 'urgent' | 'high' | 'normal' | 'low';

export interface NewThread {
  title: string;
  body: string;
  /** What "done" means. Sent only when written, so a blank stays absent. */
  acceptanceCriteria?: string;
  priority?: ThreadPriorityChoice;
  assignee?: string;
}

function ThreadRow({
  thread,
  onOpen,
}: {
  thread: ThreadSummaryView;
  onOpen: (threadId: string) => void;
}) {
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
      {/* The status sentence comes from the server's resolver. The UI must not
          derive a second, shorter vocabulary: the shorter one would win
          because it is the one on screen, and the two would drift. */}
      <span className={styles.rowReason}>{thread.reason}</span>
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
        {
          {
            needs_you: '待你处理',
            running: '执行中',
            idle: '待安排',
            done: '已结束',
          }[group.key]
        }
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
  runtimes,
  view,
  onViewChange,
  hideNavigation = false,
  onOpenThread,
  onDeleteAgent,
  onSetAgentEnabled,
  onUpdateAgent,
  onOpenAgentBuilder,
  onOpenDefinitions,
  onCreateJoinToken,
  onConnectRemoteHost,
  hostServerUrl,
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
  const runtimeEntries = runtimes ?? [];
  const [creating, setCreating] = useState<'thread'>();
  const [configuring, setConfiguring] = useState<string>();
  const [openAgentId, setOpenAgentId] = useState<string>();
  const { t } = useI18n();
  const [addingRuntime, setAddingRuntime] = useState(false);
  const [taskAssignee, setTaskAssignee] = useState('');
  const statusLabels: Record<string, string> = {
    online: '在线',
    offline: '离线',
    idle: '空闲',
    working: '执行中',
    blocked: '等待处理',
    error: '异常',
    finishing: '收尾中',
    stopping: '停止中',
  };
  const statusLabel = (status: string) => statusLabels[status] ?? status;
  const hostLabel = (entry: WorkspaceAgentRuntimeView) =>
    entry.kind === 'local' ? '本机 Qwen Code' : entry.label;

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
                  ? ({ mode: 'managed-host', hostIds } as const)
                  : ({ mode: 'local' } as const),
            }
          : {}),
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
        {!hideNavigation && (
          <nav className={styles.viewTabs} aria-label={t('agents.title')}>
            {(['agents', 'tasks', 'runtime'] as const).map((item) => (
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
        )}
        <div className={styles.headerActions}>
          {view === 'agents' && onOpenDefinitions ? (
            <Button variant="ghost" size="sm" onClick={onOpenDefinitions}>
              {t('collab.agent.roles')}
            </Button>
          ) : null}
          {view === 'agents' && onOpenAgentBuilder ? (
            <Button variant="outline" size="sm" onClick={onOpenAgentBuilder}>
              <PlusIcon data-icon="inline-start" />
              {t('collab.agent.new')}
            </Button>
          ) : null}
          {view === 'runtime' && onCreateJoinToken ? (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setAddingRuntime(true)}
            >
              <PlusIcon data-icon="inline-start" />
              {t('collab.runtime.addTitle')}
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
              <DialogTitle>新建协作任务</DialogTitle>
              <DialogDescription>
                描述任务并选择负责人，创建后在共享对话中协作。
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
                所属项目
                <select
                  aria-label="任务所属项目"
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
                与侧边栏的项目工作区相同，决定任务归属和可协作的智能体。默认当前项目；运行机器及执行目录由智能体的运行设置决定。
              </p>
              <input
                className="w-full border-0 bg-transparent text-xl font-medium outline-none"
                name="title"
                aria-label="任务标题"
                placeholder="需要完成什么？"
                required
              />
              <textarea
                className={styles.field}
                name="body"
                aria-label="任务描述"
                rows={6}
                placeholder="告诉团队任务背景、要求和限制"
                required
              />
              <textarea
                className={styles.field}
                name="acceptanceCriteria"
                aria-label="验收标准"
                placeholder="验收标准：满足哪些条件才算完成？"
              />
              <select
                className={styles.field}
                name="priority"
                aria-label="任务优先级"
                defaultValue="normal"
              >
                <option value="urgent">紧急</option>
                <option value="high">高优先级</option>
                <option value="normal">普通优先级</option>
                <option value="low">低优先级</option>
              </select>
              <p className="text-xs text-muted-foreground">
                优先级只影响排队取单顺序，不会中断正在执行的任务。
              </p>
              <select
                className={styles.field}
                name="assignee"
                key={workspaceCwd}
                aria-label="负责智能体"
                defaultValue={taskAssignee}
                onChange={(event) => {
                  setTaskAssignee(event.target.value);
                  onPreviewThread?.(event.target.value || undefined);
                }}
              >
                <option value="">暂不指定（只保存，不执行）</option>
                {agents
                  .filter((agent) => agent.enabled && !agent.retiredAt)
                  .map((agent) => (
                    <option key={agent.id} value={agent.name}>
                      {agent.name} · {hostLabel(agent.runtime)} ·{' '}
                      {agent.runtime.provider}
                    </option>
                  ))}
              </select>
              {!taskAssignee && (
                <p className="text-xs text-muted-foreground">
                  当前任务不会自动执行。创建后可指定智能体，或在共享对话中
                  @智能体 发起执行。
                </p>
              )}
              {createPreview ? (
                <div
                  role="status"
                  className="space-y-1 text-xs text-muted-foreground"
                >
                  <strong>
                    {taskAssignee
                      ? summarizePreview(createPreview)
                      : '只保存任务，暂不启动智能体。'}
                  </strong>
                  {createPreview
                    .filter((target) => !target.willWake)
                    .map((target) => {
                      const explained =
                        target.reason === 'no_target'
                          ? {
                              what: '尚未指定负责智能体',
                              fix: '选择负责人后才会安排执行',
                            }
                          : explainSkip(target.reason ?? '', target.agentName);
                      return (
                        <p
                          key={`${target.agentName}:${target.reason ?? 'unknown'}`}
                        >
                          {explained.what}. {explained.fix}
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
                  取消
                </Button>
                <Button type="submit" size="sm" disabled={pending}>
                  {pending ? '创建中…' : '创建任务'}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        <section className={styles.roster} hidden={view !== 'agents'}>
          <h2 className={styles.sectionTitle}>工作区智能体</h2>
          {agents.length === 0 ? (
            <p className={styles.emptyRoster}>
              还没有智能体。创建一个身份并为它分配任务，即可开始协作。
            </p>
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
                  {agent.description || '尚未填写职责'}
                  <span className="block text-xs text-muted-foreground">
                    {hostLabel(agent.runtime)} · {agent.runtime.provider}
                  </span>
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
                    {agent.retiredAt ? '已退役' : statusLabel(agent.status)}
                  </span>
                )}
                <span className={styles.agentWaiting}>
                  {agent.waiting ? `${agent.waiting} 项等待中` : '—'}
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
                      分配任务
                    </button>
                    {onUpdateAgent ? (
                      <button
                        type="button"
                        className={styles.agentAction}
                        onClick={() =>
                          setConfiguring(
                            configuring === agent.id ? undefined : agent.id,
                          )
                        }
                      >
                        {configuring === agent.id ? '收起' : '配置'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={styles.agentAction}
                      title={
                        agent.enabled
                          ? '暂停接收新任务，之后可重新启用'
                          : '恢复接收新任务'
                      }
                      disabled={pending}
                      onClick={() =>
                        onSetAgentEnabled(agent.id, !agent.enabled)
                      }
                    >
                      {agent.enabled ? '停用' : '启用'}
                    </button>
                    <button
                      type="button"
                      className={`${styles.agentAction} ${styles.agentRemove}`}
                      title="永久停止接单，保留身份名称和已有消息；不同于可恢复的停用"
                      disabled={Boolean(agent.workingOn || agent.waiting)}
                      onClick={() => {
                        if (
                          window.confirm(
                            `退役智能体「${agent.name}」？它将不再接单。已有消息保留，名称也会保留，避免其他身份冒用。`,
                          )
                        ) {
                          onDeleteAgent(agent.id);
                        }
                      }}
                    >
                      退役
                    </button>
                  </>
                )}
                {configuring === agent.id && onUpdateAgent ? (
                  <form
                    className={styles.agentConfig}
                    onSubmit={submitConfig(agent.id)}
                  >
                    <label className={styles.configLabel}>
                      职责描述
                      <input
                        className={styles.field}
                        name="description"
                        defaultValue={agent.description ?? ''}
                        placeholder="例如：检查代码并向负责人汇报问题"
                      />
                    </label>
                    <label className={styles.configLabel}>
                      工作指令
                      <textarea
                        className={styles.field}
                        name="instructions"
                        rows={4}
                        defaultValue={agent.instructions ?? ''}
                        placeholder="说明工作方式和输出要求；指令不能扩大工具权限"
                      />
                    </label>
                    <label className={styles.configLabel}>
                      角色模板
                      <input
                        className={styles.field}
                        name="agentType"
                        defaultValue={agent.agentType ?? ''}
                        placeholder="使用工作区默认配置"
                      />
                    </label>
                    <label className={styles.configLabel}>
                      模型
                      <input
                        className={styles.field}
                        name="model"
                        defaultValue={agent.model ?? ''}
                        placeholder="使用工作区默认配置"
                      />
                    </label>
                    <label className={styles.configLabel}>
                      同时执行的任务数
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
                        <legend>执行主机</legend>
                        {runtimeEntries
                          .filter((entry) => entry.kind === 'external')
                          .map((entry) => (
                            <label key={entry.id}>
                              <input
                                name="executionHostId"
                                type="checkbox"
                                value={entry.id}
                                defaultChecked={
                                  agent.execution?.mode === 'managed-host' &&
                                  agent.execution.hostIds.includes(entry.id)
                                }
                              />{' '}
                              {hostLabel(entry)} · {entry.provider} ·{' '}
                              {statusLabel(entry.status)}
                            </label>
                          ))}
                        <span className={styles.configNote}>
                          不选择外部主机时，由本机 Qwen Code 执行。
                        </span>
                      </fieldset>
                    ) : null}
                    <p className={styles.configNote}>
                      清空字段后使用角色模板的默认配置。
                    </p>
                    <div className={styles.formActions}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfiguring(undefined)}
                      >
                        取消
                      </Button>
                      <Button type="submit" size="sm" disabled={pending}>
                        保存配置
                      </Button>
                    </div>
                  </form>
                ) : null}
                {openAgentId === agent.id ? (
                  <section className={styles.agentWorkspace}>
                    <div className={styles.agentWorkspaceHeader}>
                      <strong>已分配任务</strong>
                      <span>
                        {hostLabel(agent.runtime)} · {statusLabel(agent.status)}
                      </span>
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
                        尚未分配任务。点击「分配任务」，或在共享对话中
                        @此智能体。
                      </p>
                    )}
                  </section>
                ) : null}
              </div>
            ))
          )}
          {capabilities ? (
            <div className={styles.ceiling}>
              <h3 className={styles.ceilingTitle}>当前协作权限</h3>
              <p className={styles.ceilingText}>
                {capabilities.readOnly
                  ? '当前 demo 以只读检查、派单和结果汇总为主，不开放修改文件的能力。职责指令不能提高工具权限；外部执行器还受自身权限设置约束。'
                  : '当前未启用只读限制。'}
              </p>
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  查看工具范围
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
            <p className={styles.emptyLead}>还没有任务。</p>
            <p>创建任务并指定智能体，系统会根据主机状态安排执行。</p>
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
              <strong
                className={styles.runtimeStatus}
                data-runtime-status={runtimeEntry.status}
              >
                {statusLabel(runtimeEntry.status)}
              </strong>
              <dl className={styles.runtimeFacts}>
                <div>
                  <dt>{t('collab.runtime.programs')}</dt>
                  <dd>{runtimeEntry.provider}</dd>
                </div>
                {runtimeEntry.workspaceCwd ? (
                  <div>
                    <dt>工作目录</dt>
                    <dd>
                      <code>{runtimeEntry.workspaceCwd}</code>
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>关联智能体</dt>
                  <dd>{runtimeEntry.agentCount ?? 0}</dd>
                </div>
                <div>
                  <dt>执行中任务</dt>
                  <dd>{runtimeEntry.runningTaskCount ?? 0}</dd>
                </div>
                <div>
                  <dt>排队任务</dt>
                  <dd>{runtimeEntry.queuedTaskCount ?? 0}</dd>
                </div>
              </dl>
              <details className="mt-4 text-xs text-muted-foreground">
                <summary className="cursor-pointer">技术详情</summary>
                <p>主机标识：{runtimeEntry.id}</p>
                {runtimeEntry.hostSessionId && (
                  <p>宿主会话：{runtimeEntry.hostSessionId}</p>
                )}
                <p>会话数：{runtimeEntry.sessionCount ?? 0}</p>
                {runtimeEntry.lastSeenAt && (
                  <p>
                    最近心跳：
                    {new Date(runtimeEntry.lastSeenAt).toLocaleTimeString()}
                  </p>
                )}
              </details>
            </section>
          ))
        ) : view === 'runtime' ? (
          <div className={styles.emptyState}>
            <p className={styles.emptyLead}>{t('collab.runtime.empty')}</p>
            <p>{t('collab.runtime.emptyHint')}</p>
          </div>
        ) : null}
      </div>
      {onCreateJoinToken && (
        <AddRuntimeDialog
          open={addingRuntime}
          onOpenChange={setAddingRuntime}
          serverUrl={hostServerUrl ?? ''}
          runtimes={runtimeEntries}
          onCreateJoinToken={onCreateJoinToken}
          {...(onConnectRemoteHost
            ? { onConnectExisting: onConnectRemoteHost }
            : {})}
          {...(onOpenAgentBuilder
            ? {
                onCreateAgentOn: () => {
                  setAddingRuntime(false);
                  onOpenAgentBuilder();
                },
              }
            : {})}
        />
      )}
    </div>
  );
}
