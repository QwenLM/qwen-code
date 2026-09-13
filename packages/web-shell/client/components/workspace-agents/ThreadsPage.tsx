/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
  initialCreateTask?: boolean;
  hideNavigation?: boolean;
  createError?: string;
  agents: readonly WorkspaceAgentSummaryView[];
  threads: readonly ThreadSummaryView[];
  runtime?: WorkspaceAgentRuntimeView;
  runtimes?: readonly WorkspaceAgentRuntimeView[];
  hostEnrollment?: AgentHostEnrollmentView;
  view: AgentWorkspaceView;
  onViewChange: (view: AgentWorkspaceView) => void;
  onOpenThread: (threadId: string) => void;
  onDeleteAgent: (agentId: string) => void;
  onSetAgentEnabled: (agentId: string, enabled: boolean) => void;
  onUpdateAgent?: (agentId: string, patch: AgentConfigPatch) => void;
  onOpenAgentBuilder?: () => void;
  onOpenDefinitions?: () => void;
  onCreateHostEnrollment?: (
    serverUrl: string,
    provider: 'qwen' | 'codex',
    allowHttp?: boolean,
  ) => void;
  hostServerUrl?: string;
  capabilities?: AgentCapabilitiesView;
  onCreateThread: (input: NewThread) => Promise<boolean> | void;
  workspaceCwd?: string;
  workspaces?: readonly { cwd: string }[];
  onWorkspaceChange?: (cwd: string) => void;
  onPreviewThread?: (assignee?: string) => void;
  createPreview?: readonly RoutingPreviewTarget[];
  pending?: boolean;
  loading?: boolean;
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

export interface AgentHostEnrollmentView {
  command: string;
  expiresAt: number;
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
  runtime,
  runtimes,
  hostEnrollment,
  view,
  onViewChange,
  hideNavigation = false,
  onOpenThread,
  onDeleteAgent,
  onSetAgentEnabled,
  onUpdateAgent,
  onOpenAgentBuilder,
  onOpenDefinitions,
  onCreateHostEnrollment,
  onConnectRemoteHost,
  hostServerUrl,
  capabilities,
  onCreateThread,
  workspaceCwd,
  workspaces,
  onWorkspaceChange,
  initialCreateTask,
  createError,
  onPreviewThread,
  createPreview,
  pending,
  loading,
}: ThreadsPageProps) {
  const groups = useMemo(() => groupThreads(threads), [threads]);
  const runtimeEntries = runtimes ?? (runtime ? [runtime] : []);
  const [creating, setCreating] = useState<'thread' | undefined>(
    initialCreateTask ? 'thread' : undefined,
  );
  const [configuring, setConfiguring] = useState<string>();
  const [openAgentId, setOpenAgentId] = useState<string>();
  const [addingHost, setAddingHost] = useState(false);
  const [hostMethod, setHostMethod] = useState<'existing' | 'command'>(
    'existing',
  );
  const [hostConnected, setHostConnected] = useState(false);
  const [hostLocation, setHostLocation] = useState('local');
  const [allowHostHttp, setAllowHostHttp] = useState(false);
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
          <nav className={styles.viewTabs} aria-label="协作管理">
            {(['agents', 'tasks', 'runtime'] as const).map((item) => (
              <Button
                key={item}
                variant={view === item ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={view === item}
                onClick={() => openView(item)}
              >
                {item === 'agents'
                  ? '智能体'
                  : item === 'tasks'
                    ? '任务'
                    : '执行主机'}
              </Button>
            ))}
          </nav>
        )}
        <div className={styles.headerActions}>
          {view === 'agents' && onOpenDefinitions ? (
            <Button variant="ghost" size="sm" onClick={onOpenDefinitions}>
              角色模板
            </Button>
          ) : null}
          {view === 'agents' && onOpenAgentBuilder ? (
            <Button variant="outline" size="sm" onClick={onOpenAgentBuilder}>
              <PlusIcon data-icon="inline-start" />
              新建智能体
            </Button>
          ) : null}
          {view === 'runtime' && onCreateHostEnrollment ? (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setAddingHost((value) => !value)}
            >
              <PlusIcon data-icon="inline-start" />
              接入主机
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
              新建任务
            </Button>
          ) : null}
        </div>
      </header>
      <div className={styles.pageBody}>
        <p className="mb-5 text-sm text-muted-foreground">
          {view === 'agents'
            ? '智能体是可重复使用的协作身份。设置职责和执行主机后，分配任务或在对话中 @它，即可开始工作。'
            : view === 'tasks'
              ? '任务承载具体工作。在共享对话中派单、交流进展、补充要求，最后由人验收。'
              : '执行主机负责实际运行 Qwen Code 或 Codex。一个主机可以承载多个智能体；接入主机后，还需把智能体分配到它。'}
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

        {loading && threads.length === 0 ? null : groups.length === 0 ? (
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

        {view === 'runtime' && addingHost && (
          <div className="flex flex-wrap gap-2" aria-label="接入方式">
            <Button
              variant={hostMethod === 'existing' ? 'secondary' : 'ghost'}
              onClick={() => setHostMethod('existing')}
            >
              连接已有 Qwen Serve
            </Button>
            <Button
              variant={hostMethod === 'command' ? 'secondary' : 'ghost'}
              onClick={() => setHostMethod('command')}
            >
              尚未启动服务？生成命令
            </Button>
          </div>
        )}
        {view === 'runtime' && addingHost && hostMethod === 'existing' && (
          <form
            className={styles.enrollmentCard}
            onSubmit={async (event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              setHostConnected(false);
              const connected = await onConnectRemoteHost?.({
                remoteUrl: String(data.get('remoteUrl')),
                remoteToken: String(data.get('remoteToken')),
                remoteCwd: String(data.get('remoteCwd')),
                serverUrl: String(data.get('callbackUrl')),
                provider: data.get('provider') === 'codex' ? 'codex' : 'qwen',
                allowHttp: allowHostHttp,
              });
              if (connected) {
                setHostConnected(true);
                const tokenInput = form.elements.namedItem('remoteToken');
                if (tokenInput instanceof HTMLInputElement)
                  tokenInput.value = '';
              }
            }}
          >
            <strong>连接已有服务 · 无需另开终端启动 Host</strong>
            <p className={styles.configNote}>
              复用已运行的 Qwen
              Serve，为当前项目接入执行机器。连接后，再把智能体分配到这台机器。
            </p>
            <label>
              远程服务地址
              <input
                className={styles.field}
                name="remoteUrl"
                type="url"
                required
                placeholder="http://远程机器:端口"
              />
            </label>
            <label>
              远程服务凭证
              <input
                className={styles.field}
                name="remoteToken"
                type="password"
                autoComplete="off"
                required
                placeholder="远程 Qwen Serve 的访问 token"
              />
            </label>
            <label>
              远程执行目录
              <input
                className={styles.field}
                name="remoteCwd"
                required
                placeholder="/home/user/project（已注册并授权的远程工作区）"
              />
            </label>
            <label>
              执行程序
              <select className={styles.field} name="provider">
                <option value="qwen">Qwen Code</option>
                <option value="codex">Codex CLI（远程需已安装并登录）</option>
              </select>
            </label>
            <label>
              当前协调端的回连地址
              <input
                className={styles.field}
                name="callbackUrl"
                type="url"
                required
                placeholder="http://本机局域网IP:4170"
              />
            </label>
            <p className={styles.configNote}>
              回连地址指当前项目所在的服务，不是上方远程服务。必须能从远程机器访问；远程机器上的
              127.0.0.1 不指向你的电脑。本地和远程的项目目录不会自动同步。
            </p>
            <label>
              <input
                type="checkbox"
                checked={allowHostHttp}
                onChange={(event) => setAllowHostHttp(event.target.checked)}
              />{' '}
              允许 HTTP（仅可信演示网络，凭证和任务将明文传输）
            </label>
            <p className={styles.configNote}>
              两端需支持在线主机接入并启用协作功能。当前连接随服务进程运行；重启后需重新连接。不会接管已打开的
              Codex App 窗口。
            </p>
            <Button type="submit" disabled={pending || !onConnectRemoteHost}>
              {pending ? '正在连接…' : '连接服务'}
            </Button>
            {hostConnected && (
              <p role="status">
                服务已确认连接。下方机器列表会显示状态；创建智能体时可在“在哪里运行”中选择它。
              </p>
            )}
          </form>
        )}
        {view === 'runtime' && addingHost && hostMethod === 'command' && (
          <form
            className={styles.enrollmentCard}
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              onCreateHostEnrollment?.(
                String(data.get('serverUrl')),
                data.get('provider') === 'codex' ? 'codex' : 'qwen',
                allowHostHttp,
              );
            }}
          >
            <strong>接入执行主机</strong>
            <label>
              在哪里运行？
              <select
                className={styles.field}
                value={hostLocation}
                onChange={(event) => setHostLocation(event.target.value)}
              >
                <option value="local">协调端所在的本机</option>
                <option value="remote">另一台机器</option>
              </select>
            </label>
            <label>
              执行程序
              <select name="provider" className={styles.field}>
                <option value="qwen">Qwen Code</option>
                <option value="codex">Codex CLI</option>
              </select>
            </label>
            <label>
              协调端地址
              <input
                key={hostLocation}
                name="serverUrl"
                type="url"
                required
                className={styles.field}
                defaultValue={hostLocation === 'local' ? hostServerUrl : ''}
                placeholder={
                  hostLocation === 'remote'
                    ? 'https://可从目标主机访问的协调端地址'
                    : 'http://127.0.0.1:端口'
                }
                pattern={
                  hostLocation === 'remote' && !allowHostHttp
                    ? 'https://.*'
                    : 'https?://.*'
                }
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={allowHostHttp}
                onChange={(event) => setAllowHostHttp(event.target.checked)}
              />{' '}
              允许 HTTP（仅演示）
            </label>
            {allowHostHttp && (
              <p role="status" className={styles.configNote}>
                HTTP
                不加密：注册凭据、任务内容和结果可能被网络中的其他人读取。仅在可信演示网络使用；此选项不会关闭
                HTTPS 证书校验。
              </p>
            )}
            <p className={styles.configNote}>
              {hostLocation === 'local'
                ? '127.0.0.1 仅指运行命令的这台机器。开发环境显示的地址可能经过前端代理，请确认代理持续运行，或填写实际后端地址。'
                : '这里填写当前协调端从目标机器可访问的地址，不是待接入主机的地址。推荐 HTTPS；可信演示网络可勾选允许 HTTP。远程机器不能直接使用你电脑的 localhost。'}
            </p>
            <p className={styles.configNote}>
              目标主机需要支持 Agent Host 的 Qwen Code；选择 Codex
              时还需安装并登录 Codex
              CLI。命令应在要执行任务的项目目录中运行，并保持进程在线。它不会接管已有的
              Codex App 对话。
            </p>
            <Button type="submit" disabled={pending}>
              生成接入命令
            </Button>
          </form>
        )}
        {view === 'runtime' &&
        addingHost &&
        hostMethod === 'command' &&
        hostEnrollment ? (
          <section className={styles.enrollmentCard}>
            <strong>在目标主机的项目目录中执行，并保持运行</strong>
            <code>{hostEnrollment.command}</code>
            <span>
              注册凭据有效期至{' '}
              {new Date(hostEnrollment.expiresAt).toLocaleTimeString()}.
            </span>
          </section>
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
                    ? '使用本机 Qwen Code 执行此工作区的智能体任务。'
                    : `使用 ${runtimeEntry.provider} 执行明确分配到此主机的智能体任务。接入不代表它在另一台物理机器上。`}
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
                  <dt>执行程序</dt>
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
            <p className={styles.emptyLead}>暂无可用执行主机。</p>
            <p>接入主机后，将智能体分配到主机，再创建任务开始协作。</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
