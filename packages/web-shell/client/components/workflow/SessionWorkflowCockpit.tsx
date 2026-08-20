import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CircleAlert, LayoutDashboard } from 'lucide-react';
import type {
  DaemonSessionAgentTaskStatus,
  DaemonSessionArtifact,
  DaemonSessionTaskStatus,
} from '@qwen-code/sdk/daemon';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
import { useI18n } from '../../i18n';
import {
  getAttentionAgentTool,
  getPlanNodeState,
  nestedAgentToolsForTool,
  nestedTasksForTool,
  PlanExecutionView,
} from '../messages/PlanExecutionView';
import styles from './SessionWorkflowCockpit.module.css';

interface SessionWorkflowCockpitProps {
  sessionId: string;
  connected: boolean;
  sessionName?: string;
  workspaceCwd?: string;
  todos: readonly TodoItem[];
  tools: readonly ACPToolCall[];
  tasks: readonly DaemonSessionTaskStatus[];
  artifacts?: readonly DaemonSessionArtifact[];
  onBackToChat: () => void;
  onOpenSubagent: (tool: ACPToolCall) => void;
  onOpenArtifact?: (artifactId: string) => void;
}

type CockpitSection = 'overview' | 'attention';

function toolTodoId(tool: ACPToolCall): string | undefined {
  const value = tool.args?.todo_id;
  return typeof value === 'string' ? value : undefined;
}

function taskForTool(
  tool: ACPToolCall,
  tasks: readonly DaemonSessionTaskStatus[],
): DaemonSessionAgentTaskStatus | undefined {
  return tasks.find(
    (task): task is DaemonSessionAgentTaskStatus =>
      task.kind === 'agent' && task.toolUseId === tool.callId,
  );
}

function linkedAgentTasks(
  tools: readonly ACPToolCall[],
  tasks: readonly DaemonSessionTaskStatus[],
): DaemonSessionAgentTaskStatus[] {
  const linked = new Map<string, DaemonSessionAgentTaskStatus>();
  for (const tool of tools) {
    const root = taskForTool(tool, tasks);
    if (root) linked.set(root.id, root);
    for (const { task } of nestedTasksForTool(tool, tasks)) {
      linked.set(task.id, task);
    }
    for (const { tool: nestedTool, depth } of nestedAgentToolsForTool(tool)) {
      const task = taskForTool(nestedTool, tasks);
      if (task)
        linked.set(task.id, task.depth == null ? { ...task, depth } : task);
    }
  }
  return [...linked.values()];
}

function flattenTools(tools: readonly ACPToolCall[]): ACPToolCall[] {
  const result: ACPToolCall[] = [];
  const visit = (tool: ACPToolCall) => {
    result.push(tool);
    for (const child of tool.subTools ?? []) visit(child);
  };
  for (const tool of tools) visit(tool);
  return result;
}

function skillName(tool: ACPToolCall): string | undefined {
  if (tool.toolName !== 'skill') return undefined;
  const value = tool.args?.skill;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function agentSkills(tool: ACPToolCall): string[] {
  const raw =
    typeof tool.rawOutput === 'object' && tool.rawOutput !== null
      ? (tool.rawOutput as Record<string, unknown>)
      : undefined;
  return Array.isArray(raw?.['skills'])
    ? raw['skills'].filter(
        (skill): skill is string => typeof skill === 'string' && Boolean(skill),
      )
    : [];
}

function skillsForTool(tool: ACPToolCall): string[] {
  return [
    ...new Set([
      ...agentSkills(tool),
      ...flattenTools([tool])
        .map(skillName)
        .filter((name): name is string => Boolean(name)),
    ]),
  ];
}

function taskStatusKey(status: DaemonSessionAgentTaskStatus['status']) {
  switch (status) {
    case 'running':
      return 'workflow.status.running';
    case 'paused':
      return 'workflow.status.paused';
    case 'completed':
      return 'workflow.status.completed';
    case 'failed':
      return 'workflow.status.failed';
    default:
      return 'workflow.status.cancelled';
  }
}

function initials(value: string): string {
  const words = value
    .replace(/[^A-Za-z0-9\u4e00-\u9fff ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length > 1) {
    return words
      .slice(0, 2)
      .map((word) => word[0])
      .join('')
      .toUpperCase();
  }
  return (
    value
      .replace(/[^A-Za-z]/g, '')
      .slice(0, 3)
      .toUpperCase() || 'AG'
  );
}

function clock(timestamp?: number): string {
  if (!timestamp) return '--:--';
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SessionWorkflowCockpit({
  sessionId,
  connected,
  sessionName,
  workspaceCwd,
  todos,
  tools,
  tasks,
  artifacts = [],
  onBackToChat,
  onOpenSubagent,
  onOpenArtifact,
}: SessionWorkflowCockpitProps) {
  const { t } = useI18n();
  const [section, setSection] = useState<CockpitSection>('overview');
  const [selectedTodoId, setSelectedTodoId] = useState<string>();
  const entryActionRef = useRef<HTMLButtonElement>(null);
  const overviewTabRef = useRef<HTMLButtonElement>(null);
  const attentionTabRef = useRef<HTMLButtonElement>(null);
  const focusInitializedRef = useRef(false);
  const todosEmpty = todos.length === 0;
  const todosWereEmptyRef = useRef(todosEmpty);
  const allTools = useMemo(() => flattenTools(tools), [tools]);
  const toolsByCallId = useMemo(
    () => new Map(allTools.map((tool) => [tool.callId, tool])),
    [allTools],
  );
  const todosById = useMemo(
    () => new Map(todos.map((todo) => [todo.id, todo])),
    [todos],
  );
  const toolsByTodo = useMemo(() => {
    const result = new Map<string, ACPToolCall[]>();
    for (const tool of tools) {
      const todoId = toolTodoId(tool);
      if (!todoId) continue;
      const group = result.get(todoId) ?? [];
      group.push(tool);
      result.set(todoId, group);
    }
    return result;
  }, [tools]);
  const states = useMemo(
    () =>
      new Map(
        todos.map((todo) => [
          todo.id,
          getPlanNodeState(
            todo,
            todosById,
            toolsByTodo.get(todo.id) ?? [],
            tasks,
          ),
        ]),
      ),
    [tasks, todos, todosById, toolsByTodo],
  );
  const agents = useMemo(() => linkedAgentTasks(tools, tasks), [tasks, tools]);
  const attentionTodos = useMemo(
    () => todos.filter((todo) => states.get(todo.id)?.attention),
    [states, todos],
  );

  useEffect(() => {
    if (
      selectedTodoId &&
      attentionTodos.some(({ id }) => id === selectedTodoId)
    ) {
      return;
    }
    setSelectedTodoId(attentionTodos[0]?.id);
  }, [attentionTodos, selectedTodoId]);

  useEffect(() => {
    if (
      !focusInitializedRef.current ||
      todosEmpty !== todosWereEmptyRef.current
    ) {
      focusInitializedRef.current = true;
      todosWereEmptyRef.current = todosEmpty;
      entryActionRef.current?.focus();
      return;
    }
    (section === 'overview'
      ? overviewTabRef
      : attentionTabRef
    ).current?.focus();
  }, [section, todosEmpty]);

  if (todosEmpty) {
    return (
      <div className={styles.emptyCockpit} data-testid="cockpit-empty">
        <div aria-hidden="true" className={styles.emptyMark}>
          Q
        </div>
        <div className={styles.reviewEyebrow}>
          {t('workflow.empty.eyebrow')}
        </div>
        <h1>{t('workflow.empty.title')}</h1>
        <p>{t('workflow.empty.copy')}</p>
        <button
          className={styles.primaryButton}
          onClick={onBackToChat}
          ref={entryActionRef}
          type="button"
        >
          {t('workflow.empty.action')}
        </button>
      </div>
    );
  }

  const activeAgents = agents.filter(
    (task) => task.status === 'running' || task.status === 'paused',
  );
  const completedCount = todos.filter(
    (todo) => todo.status === 'completed',
  ).length;
  const attentionCount = attentionTodos.length;
  const hasActiveExecution =
    activeAgents.length > 0 ||
    todos.some((todo) => {
      const status = states.get(todo.id)?.status;
      return status === 'running' || status === 'in_progress';
    });
  const taskStatusI18nKey =
    attentionCount > 0
      ? 'workflow.task.attention'
      : completedCount === todos.length
        ? 'workflow.task.completed'
        : hasActiveExecution
          ? 'workflow.task.running'
          : 'workflow.task.waitingExecution';
  const taskStatusTone = attentionCount
    ? 'attention'
    : completedCount === todos.length
      ? 'completed'
      : hasActiveExecution
        ? 'running'
        : 'waiting';
  const attentionTodo =
    attentionTodos.find((todo) => todo.id === selectedTodoId) ??
    attentionTodos[0];
  const attentionTool = attentionTodo
    ? toolsByTodo
        .get(attentionTodo.id)
        ?.map((tool) => getAttentionAgentTool(tool, tasks))
        .find((tool): tool is ACPToolCall => Boolean(tool))
    : undefined;
  const activity = agents.slice().sort((a, b) => b.startTime - a.startTime);
  // A failure is only actionable if you know where it sits: which steps fed it,
  // and what is now stuck behind it.
  const attentionUpstream = (attentionTodo?.blockedBy ?? []).filter((id) =>
    todos.some((todo) => todo.id === id),
  );
  const attentionDownstream = attentionTodo
    ? todos
        .filter((todo) => todo.blockedBy?.includes(attentionTodo.id))
        .map((todo) => todo.id)
    : [];

  const headingActions = (
    <div className={styles.headingActions}>
      <button
        className={styles.backButton}
        data-testid="workflow-back-to-chat"
        onClick={onBackToChat}
        ref={entryActionRef}
        type="button"
      >
        <ArrowLeft aria-hidden="true" />
        <span>{t('workflow.chatTitle')}</span>
      </button>
      <nav aria-label={t('workflow.tabs.label')} className={styles.cockpitTabs}>
        <button
          aria-label={t('workflow.tabs.task')}
          aria-pressed={section === 'overview'}
          data-active={section === 'overview' || undefined}
          onClick={() => setSection('overview')}
          ref={overviewTabRef}
          type="button"
        >
          <LayoutDashboard aria-hidden="true" />
          <span>{t('workflow.tabs.task')}</span>
        </button>
        <button
          aria-label={t('workflow.tabs.attention')}
          aria-pressed={section === 'attention'}
          data-active={section === 'attention' || undefined}
          onClick={() => setSection('attention')}
          ref={attentionTabRef}
          type="button"
        >
          <CircleAlert aria-hidden="true" />
          <span>{t('workflow.tabs.attention')}</span>
          {attentionCount > 0 && <b>{attentionCount}</b>}
        </button>
      </nav>
      <span
        className={styles.environment}
        data-connected={connected || undefined}
      >
        <i />
        {t(
          connected
            ? 'workflow.connection.connected'
            : 'workflow.connection.reconnecting',
        )}
      </span>
    </div>
  );

  return (
    <div className={styles.cockpit} data-testid="session-workflow-cockpit">
      <main className={styles.main}>
        {section === 'attention' ? (
          <section className={styles.attentionPage}>
            <div className={styles.attentionHeading}>
              <div>
                <span className={styles.reviewEyebrow}>
                  {t('workflow.attention.eyebrow')}
                </span>
                <h1>{t('workflow.attention.title')}</h1>
                <p>{t('workflow.attention.copy')}</p>
              </div>
              {headingActions}
            </div>
            <div className={styles.attentionStats}>
              <div>
                <strong>{attentionCount}</strong>
                <span>{t('workflow.attention.count')}</span>
              </div>
              <div>
                <strong>
                  {agents.filter((task) => task.status === 'failed').length}
                </strong>
                <span>{t('workflow.attention.failed')}</span>
              </div>
              <div>
                <strong>
                  {agents.filter((task) => task.status === 'cancelled').length}
                </strong>
                <span>{t('workflow.attention.cancelled')}</span>
              </div>
              <div>
                <strong>{activeAgents.length}</strong>
                <span>{t('workflow.attention.running')}</span>
              </div>
            </div>
            {attentionCount > 0 ? (
              <div className={styles.attentionWorkspace}>
                <div className={styles.attentionList}>
                  <header>
                    <strong>{t('workflow.attention.queue')}</strong>
                    <span>{t('workflow.attention.queueOrder')}</span>
                  </header>
                  {attentionTodos.map((todo) => (
                    <button
                      aria-pressed={todo.id === attentionTodo?.id}
                      className={
                        todo.id === attentionTodo?.id
                          ? styles.attentionActive
                          : ''
                      }
                      key={todo.id}
                      onClick={() => setSelectedTodoId(todo.id)}
                      type="button"
                    >
                      <span>!</span>
                      <div>
                        <strong>{todo.content}</strong>
                        <small>{todo.id}</small>
                      </div>
                    </button>
                  ))}
                </div>
                <article className={styles.attentionDetail}>
                  <span className={styles.reviewEyebrow}>
                    {t('workflow.attention.detailEyebrow')}
                  </span>
                  <h2>{attentionTodo?.content}</h2>
                  {attentionTodo && (
                    <dl className={styles.attentionContext}>
                      <div>
                        <dt>{t('workflow.attention.stepId')}</dt>
                        <dd>
                          <code>{attentionTodo.id}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>{t('workflow.dependencies.upstream')}</dt>
                        <dd>
                          {attentionUpstream.length
                            ? attentionUpstream.join(', ')
                            : t('workflow.dependencies.none')}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('workflow.dependencies.unblocks')}</dt>
                        <dd>
                          {attentionDownstream.length
                            ? attentionDownstream.join(', ')
                            : t('workflow.dependencies.noDownstream')}
                        </dd>
                      </div>
                    </dl>
                  )}
                  <p>{t('workflow.attention.failureCopy')}</p>
                  {attentionTool && (
                    <button
                      className={styles.primaryButton}
                      onClick={() => onOpenSubagent(attentionTool)}
                      type="button"
                    >
                      {t('workflow.attention.openOutput')}
                    </button>
                  )}
                </article>
              </div>
            ) : (
              <div className={styles.attentionEmpty}>
                <span>✓</span>
                <h2>{t('workflow.attention.emptyTitle')}</h2>
                <p>{t('workflow.attention.emptyCopy')}</p>
              </div>
            )}
          </section>
        ) : (
          <div className={styles.content}>
            <section className={styles.taskHeading}>
              <div>
                <div className={styles.titleLine}>
                  <h1 title={sessionName}>
                    {sessionName || t('workflow.session.defaultTitle')}
                  </h1>
                  <span data-status={taskStatusTone}>
                    {t(taskStatusI18nKey)}
                  </span>
                </div>
                {/* Identity only. Step and agent counts live in the graph's
                    overview strip immediately below; carrying them here too
                    put two stat rows within ~100px of each other showing
                    overlapping numbers. */}
                <div className={styles.taskMeta}>
                  <code>{sessionId.slice(0, 8)}</code>
                  <span>
                    {workspaceCwd?.split('/').at(-1) ||
                      t('workflow.session.workspace')}
                  </span>
                </div>
              </div>
              {headingActions}
            </section>

            <div className={styles.workflowSurface}>
              <PlanExecutionView
                hideTitle
                todos={todos}
                tools={tools}
                tasks={tasks}
                onOpenSubagent={onOpenSubagent}
              />
            </div>

            <section className={styles.supportGrid}>
              <article className={styles.panel}>
                <header className={styles.panelHeader}>
                  <div>
                    <h2>{t('workflow.stage.activity')}</h2>
                    <span>{t('workflow.collaboration.subtitle')}</span>
                  </div>
                </header>
                <div className={styles.activityList}>
                  {activity.map((task) => {
                    const tool = task.toolUseId
                      ? toolsByCallId.get(task.toolUseId)
                      : undefined;
                    const skills = tool ? skillsForTool(tool) : [];
                    const content = (
                      <>
                        <time>{clock(task.endTime ?? task.startTime)}</time>
                        <span className={styles.activityIdentity}>
                          {initials(task.subagentType || task.label)}
                        </span>
                        <span className={styles.activityCopy}>
                          <strong>{task.label}</strong>
                          <small>
                            {task.recentActivities?.at(-1)?.description ||
                              task.description}
                          </small>
                          {skills.length > 0 && (
                            <small className={styles.skillList}>
                              {t('workflow.agent.skills', {
                                skills: skills.join(', '),
                              })}
                            </small>
                          )}
                        </span>
                        <em data-status={task.status}>
                          {t(taskStatusKey(task.status))}
                        </em>
                      </>
                    );
                    return tool ? (
                      <button
                        className={styles.activityRow}
                        key={task.id}
                        onClick={() => onOpenSubagent(tool)}
                        style={{
                          paddingLeft: `${16 + (task.depth ?? 0) * 14}px`,
                        }}
                        type="button"
                      >
                        {content}
                      </button>
                    ) : (
                      <div className={styles.activityRow} key={task.id}>
                        {content}
                      </div>
                    );
                  })}
                  {activity.length === 0 && (
                    <p className={styles.inlineEmpty}>
                      {t('workflow.activity.empty')}
                    </p>
                  )}
                </div>
              </article>

              <aside className={styles.panel}>
                <header className={styles.panelHeader}>
                  <div>
                    <h2>{t('workflow.deliverables.title')}</h2>
                    {artifacts.length > 0 && (
                      <span>
                        {t('workflow.deliverables.count', {
                          count: artifacts.length,
                        })}
                      </span>
                    )}
                  </div>
                </header>
                <div className={styles.deliverables}>
                  {artifacts.length ? (
                    artifacts.map((artifact) => (
                      <button
                        disabled={!onOpenArtifact}
                        key={artifact.id}
                        onClick={() => onOpenArtifact?.(artifact.id)}
                        type="button"
                      >
                        <strong>{artifact.title}</strong>
                        <small>
                          {artifact.kind} · {artifact.status}
                        </small>
                      </button>
                    ))
                  ) : (
                    <p>{t('workflow.deliverables.none')}</p>
                  )}
                </div>
              </aside>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
