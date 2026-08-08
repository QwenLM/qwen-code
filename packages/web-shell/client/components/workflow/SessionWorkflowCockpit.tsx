import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, LayoutDashboard } from 'lucide-react';
import type {
  DaemonSessionAgentTaskStatus,
  DaemonSessionArtifact,
  DaemonSessionTaskStatus,
} from '@qwen-code/sdk/daemon';
import type {
  ACPToolCall,
  PermissionRequest,
  TodoItem,
} from '../../adapters/types';
import { useI18n } from '../../i18n';
import { formatRuntime } from '../../utils/formatRuntime';
import { ToolApproval } from '../messages/ToolApproval';
import {
  getPlanNodeState,
  nestedTasksForTool,
  PlanExecutionView,
  type PlanNodeStatus,
} from '../messages/PlanExecutionView';
import { getAgentDescription } from '../messages/toolFormatting';
import styles from './SessionWorkflowCockpit.module.css';

interface CockpitApproval {
  request: PermissionRequest;
  todos: readonly TodoItem[];
  onConfirm: (id: string, selectedOption: string) => void | Promise<void>;
}

interface CockpitDecision {
  request: PermissionRequest;
  onConfirm: (id: string, selectedOption: string) => void | Promise<void>;
}

interface SessionWorkflowCockpitProps {
  sessionId: string;
  connected: boolean;
  sessionName?: string;
  workspaceCwd?: string;
  goal?: string;
  todos: readonly TodoItem[];
  tools: readonly ACPToolCall[];
  tasks: readonly DaemonSessionTaskStatus[];
  artifacts?: readonly DaemonSessionArtifact[];
  approval?: CockpitApproval;
  decision?: CockpitDecision;
  onBackToChat: () => void;
  onOpenSubagent: (tool: ACPToolCall) => void;
  onOpenArtifact?: (artifactId: string) => void;
}

type CockpitSection = 'task' | 'attention';
type StageTab = 'work' | 'activity';

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

function agentToolStats(
  tool: ACPToolCall,
): { totalTokens: number; toolUses: number; durationMs: number } | undefined {
  const raw =
    typeof tool.rawOutput === 'object' && tool.rawOutput !== null
      ? (tool.rawOutput as Record<string, unknown>)
      : undefined;
  const summary =
    typeof raw?.['executionSummary'] === 'object' &&
    raw['executionSummary'] !== null
      ? (raw['executionSummary'] as Record<string, unknown>)
      : undefined;
  const totalTokens = summary?.['totalTokens'];
  const toolUses = summary?.['totalToolCalls'];
  const durationMs = summary?.['totalDurationMs'];
  return typeof totalTokens === 'number' &&
    Number.isFinite(totalTokens) &&
    typeof toolUses === 'number' &&
    Number.isFinite(toolUses) &&
    typeof durationMs === 'number' &&
    Number.isFinite(durationMs)
    ? { totalTokens, toolUses, durationMs }
    : undefined;
}

function statusKey(status: PlanNodeStatus): string {
  switch (status) {
    case 'running':
      return 'workflow.status.running';
    case 'paused':
      return 'workflow.status.paused';
    case 'completed':
      return 'workflow.status.completed';
    case 'blocked':
      return 'workflow.status.blocked';
    case 'in_progress':
      return 'workflow.status.inProgress';
    default:
      return 'workflow.status.ready';
  }
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

function PlanReview({
  sessionName,
  goal,
  approval,
  onBackToChat,
}: Pick<
  SessionWorkflowCockpitProps,
  'sessionName' | 'goal' | 'onBackToChat'
> & { approval: CockpitApproval }) {
  const { t } = useI18n();
  const completedContextSteps = 2;
  const dependencyCount = approval.todos.reduce(
    (total, todo) => total + (todo.blockedBy?.length ?? 0),
    0,
  );
  const handleConfirm = (
    id: string,
    selectedOption: string,
  ): void | Promise<void> => {
    const submission = approval.onConfirm(id, selectedOption);
    const option = approval.request.options.find(
      (candidate) => candidate.id === selectedOption,
    );
    if (option?.kind === 'reject_once' || option?.kind === 'reject_always') {
      if (submission) return submission.then(() => onBackToChat());
      onBackToChat();
    }
    return submission;
  };

  return (
    <div className={styles.reviewShell} data-testid="cockpit-plan-review">
      <div className={styles.reviewBody}>
        <main className={styles.reviewMain}>
          <section className={styles.reviewSteps}>
            <div className={styles.reviewStepsIntro}>
              <div className={styles.reviewEyebrow}>
                {t('workflow.planReview.title')}
              </div>
              <strong>{t('workflow.planReview.journeyTitle')}</strong>
              <span>{t('workflow.planReview.journeyHint')}</span>
            </div>
            <div className={styles.reviewStepList}>
              {[
                [
                  '01',
                  t('workflow.planReview.stepGoal'),
                  t('workflow.planReview.stepGoalCopy'),
                ],
                [
                  '02',
                  t('workflow.planReview.stepContext'),
                  t('workflow.planReview.stepContextCopy'),
                ],
                [
                  '03',
                  t('workflow.planReview.stepPreview'),
                  t('workflow.planReview.stepPreviewCopy'),
                ],
                [
                  '04',
                  t('workflow.planReview.stepAuthorize'),
                  t('workflow.planReview.stepAuthorizeCopy'),
                ],
              ].map(([number, title, copy], index) => (
                <div
                  className={`${styles.reviewStep} ${
                    index < completedContextSteps
                      ? styles.reviewStepDone
                      : index === completedContextSteps
                        ? styles.reviewStepActive
                        : ''
                  }`}
                  key={number}
                >
                  <span>{index < completedContextSteps ? '✓' : number}</span>
                  <div>
                    <strong>{title}</strong>
                    <small>{copy}</small>
                  </div>
                </div>
              ))}
            </div>
          </section>
          <div className={styles.reviewHeading}>
            <div>
              <span>{t('workflow.planReview.graphEyebrow')}</span>
              <h2 title={sessionName}>
                {sessionName || t('workflow.planReview.defaultTask')}
              </h2>
              <p>{goal || t('workflow.planReview.defaultGoal')}</p>
            </div>
            <div className={styles.planFacts}>
              <div>
                <strong>{approval.todos.length}</strong>
                <span>{t('workflow.planReview.executionSteps')}</span>
              </div>
              <div>
                <strong>{dependencyCount}</strong>
                <span>{t('workflow.planReview.dependencies')}</span>
              </div>
              <div>
                <strong>
                  {
                    approval.todos.filter((todo) => !todo.blockedBy?.length)
                      .length
                  }
                </strong>
                <span>{t('workflow.planReview.parallelStarts')}</span>
              </div>
            </div>
          </div>
          <div className={styles.reviewGrid}>
            <section className={styles.reviewGraphCard}>
              <PlanExecutionView todos={approval.todos} tools={[]} tasks={[]} />
            </section>
            <aside className={styles.permissionCard}>
              <div className={styles.permissionKicker}>
                {t('workflow.planReview.guardrailsEyebrow')}
              </div>
              <h3>{t('workflow.planReview.guardrailsTitle')}</h3>
              <p>{t('workflow.planReview.guardrailsCopy')}</p>
              <ToolApproval
                request={approval.request}
                onConfirm={handleConfirm}
                variant="inline"
                keyboardActive
                planTodos={approval.todos}
              />
            </aside>
          </div>
        </main>
      </div>
    </div>
  );
}

export function SessionWorkflowCockpit({
  sessionId,
  connected,
  sessionName,
  workspaceCwd,
  goal,
  todos,
  tools,
  tasks,
  artifacts = [],
  approval,
  decision,
  onBackToChat,
  onOpenSubagent,
  onOpenArtifact,
}: SessionWorkflowCockpitProps) {
  const { t } = useI18n();
  const [section, setSection] = useState<CockpitSection>('task');
  const [stageTab, setStageTab] = useState<StageTab>('work');
  const [selectedTodoId, setSelectedTodoId] = useState<string>();
  const [selectedDecision, setSelectedDecision] = useState(Boolean(decision));
  const stageRef = useRef<HTMLElement>(null);
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

  useEffect(() => {
    if (selectedTodoId && todosById.has(selectedTodoId)) return;
    const preferred =
      todos.find((todo) => states.get(todo.id)?.status === 'running') ??
      todos.find((todo) => todo.status === 'in_progress') ??
      todos.find((todo) => todo.status !== 'completed') ??
      todos[0];
    setSelectedTodoId(preferred?.id);
  }, [selectedTodoId, states, todos, todosById]);

  if (approval) {
    return (
      <PlanReview
        sessionName={sessionName}
        goal={goal}
        approval={approval}
        onBackToChat={onBackToChat}
      />
    );
  }

  const selectedTodo = todosById.get(selectedTodoId ?? '');
  const selectedTools = selectedTodo
    ? (toolsByTodo.get(selectedTodo.id) ?? [])
    : [];
  const selectedTool = selectedTools[0];
  const selectedTask = selectedTool
    ? taskForTool(selectedTool, tasks)
    : undefined;
  const selectedToolStats = selectedTool
    ? agentToolStats(selectedTool)
    : undefined;
  const selectedState = selectedTodo
    ? states.get(selectedTodo.id)?.status
    : undefined;
  const selectedDependents = selectedTodo
    ? todos
        .filter((todo) => todo.blockedBy?.includes(selectedTodo.id))
        .map((todo) => todo.id)
    : [];
  const latestActivity = selectedTask?.recentActivities?.at(-1);
  const completedCount = todos.filter(
    (todo) => todo.status === 'completed',
  ).length;
  const progress = todos.length
    ? Math.round((completedCount / todos.length) * 100)
    : 0;
  const activeAgents = agents.filter(
    (task) => task.status === 'running' || task.status === 'paused',
  );
  const attentionTodos = todos.filter((todo) => states.get(todo.id)?.attention);
  const attentionCount = attentionTodos.length + (decision ? 1 : 0);
  const attentionTodo =
    attentionTodos.find((todo) => todo.id === selectedTodoId) ??
    attentionTodos[0];
  const attentionTool = attentionTodo
    ? toolsByTodo.get(attentionTodo.id)?.[0]
    : undefined;
  const taskStatusI18nKey =
    progress === 100
      ? 'workflow.task.completed'
      : activeAgents.length > 0 ||
          todos.some((todo) => {
            const status = states.get(todo.id)?.status;
            return status === 'running' || status === 'in_progress';
          })
        ? 'workflow.task.running'
        : todos.length > 0
          ? 'workflow.task.waitingExecution'
          : 'workflow.task.waitingPlan';
  const taskStatus = t(taskStatusI18nKey);
  const activity = agents.slice().sort((a, b) => b.startTime - a.startTime);
  const replayableAgents = agents.filter(
    (task) => task.outputFile || task.toolUseId,
  );
  const selectedToolCallIds = new Set(
    selectedTools.flatMap((tool) =>
      flattenTools([tool]).map(({ callId }) => callId),
    ),
  );
  const selectedArtifacts = artifacts.filter(
    (artifact) =>
      artifact.metadata?.['todoId'] === selectedTodo?.id ||
      (artifact.toolCallId && selectedToolCallIds.has(artifact.toolCallId)),
  );
  const deliverables = selectedArtifacts.length ? selectedArtifacts : artifacts;
  const sessionStateKey = !connected
    ? 'workflow.sessionState.reconnecting'
    : activeAgents.length > 0
      ? 'workflow.sessionState.live'
      : progress === 100
        ? 'workflow.sessionState.history'
        : 'workflow.sessionState.ready';
  const agentStats = tools.map(
    (tool) => taskForTool(tool, tasks)?.stats ?? agentToolStats(tool),
  );
  const hasCompleteAgentStats =
    agentStats.length > 0 && agentStats.every(Boolean);
  const totalAgentToolUses = agentStats.reduce(
    (sum, stats) => sum + (stats?.toolUses ?? 0),
    0,
  );
  const totalAgentTokens = agentStats.reduce(
    (sum, stats) => sum + (stats?.totalTokens ?? 0),
    0,
  );

  if (todos.length === 0) {
    return (
      <div className={styles.emptyCockpit} data-testid="cockpit-empty">
        <div className={styles.emptyMark}>Q</div>
        <div className={styles.reviewEyebrow}>
          {t('workflow.empty.eyebrow')}
        </div>
        <h1>{t('workflow.empty.title')}</h1>
        <p>{t('workflow.empty.copy')}</p>
        <button
          className={styles.primaryButton}
          onClick={onBackToChat}
          type="button"
        >
          {t('workflow.empty.action')}
        </button>
      </div>
    );
  }

  return (
    <div className={styles.cockpit} data-testid="session-workflow-cockpit">
      <main className={styles.main}>
        <div className={styles.viewBar}>
          <nav
            aria-label={t('workflow.tabs.label')}
            className={styles.cockpitTabs}
          >
            <button
              aria-label={t('workflow.tabs.task')}
              data-active={section === 'task' || undefined}
              onClick={() => setSection('task')}
              type="button"
            >
              <LayoutDashboard aria-hidden="true" />
              <span>{t('workflow.tabs.task')}</span>
            </button>
            <button
              aria-label={t('workflow.tabs.attention')}
              data-active={section === 'attention' || undefined}
              onClick={() => setSection('attention')}
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
                      className={
                        todo.id === attentionTodo?.id
                          ? styles.attentionActive
                          : ''
                      }
                      key={todo.id}
                      onClick={() => {
                        setSelectedDecision(false);
                        setSelectedTodoId(todo.id);
                      }}
                      type="button"
                    >
                      <span>!</span>
                      <div>
                        <strong>{todo.content}</strong>
                        <small>{todo.id}</small>
                      </div>
                    </button>
                  ))}
                  {decision && (
                    <button
                      className={selectedDecision ? styles.attentionActive : ''}
                      onClick={() => setSelectedDecision(true)}
                      type="button"
                    >
                      <span>?</span>
                      <div>
                        <strong>{decision.request.title}</strong>
                        <small>{t('workflow.attention.waiting')}</small>
                      </div>
                    </button>
                  )}
                </div>
                <article className={styles.attentionDetail}>
                  <span className={styles.reviewEyebrow}>
                    {t('workflow.attention.detailEyebrow')}
                  </span>
                  {decision && (selectedDecision || !attentionTodo) ? (
                    <>
                      <h2>{decision.request.title}</h2>
                      <ToolApproval
                        request={decision.request}
                        onConfirm={decision.onConfirm}
                        variant="inline"
                        keyboardActive
                      />
                    </>
                  ) : (
                    <>
                      <h2>{attentionTodo?.content}</h2>
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
                    </>
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
                  <span data-status={taskStatus}>{taskStatus}</span>
                </div>
                <div className={styles.taskMeta}>
                  <code>{sessionId.slice(0, 8)}</code>
                  <span>
                    {workspaceCwd?.split('/').at(-1) ||
                      t('workflow.session.workspace')}
                  </span>
                  <span>
                    {t('workflow.session.steps', { count: todos.length })}
                  </span>
                  <span>
                    {t('workflow.session.agentCalls', { count: tools.length })}
                  </span>
                </div>
              </div>
            </section>

            <section
              className={`${styles.stats} ${
                progress === 100 ? styles.statsCompleted : ''
              }`}
              aria-label={t('workflow.overview.label')}
            >
              <div className={styles.progressStat}>
                <div>
                  <span>{t('workflow.overview.progress')}</span>
                  <strong>
                    {progress}% · {taskStatus}
                  </strong>
                </div>
                <div className={styles.progressTrack}>
                  <i style={{ width: `${progress}%` }} />
                </div>
              </div>
              {progress < 100 && (
                <div>
                  <strong>{activeAgents.length}</strong>
                  <span>{t('workflow.overview.activeAgents')}</span>
                </div>
              )}
              <div>
                <strong>
                  {completedCount} / {todos.length}
                </strong>
                <span>{t('workflow.overview.completedSteps')}</span>
              </div>
              <div>
                <strong>{agents.length}</strong>
                <span>{t('workflow.overview.agentRecords')}</span>
              </div>
              <div data-attention={attentionCount > 0 || undefined}>
                <strong>
                  {progress === 100 && attentionCount === 0
                    ? t('workflow.overview.noAttention')
                    : attentionCount}
                </strong>
                <span>{t('workflow.overview.attention')}</span>
              </div>
            </section>

            <section className={styles.workspace}>
              <aside className={styles.panel}>
                <header className={styles.panelHeader}>
                  <div>
                    <h2>{t('workflow.plan.title')}</h2>
                    <span>
                      {t('workflow.plan.subtitle', { count: todos.length })}
                    </span>
                  </div>
                </header>
                <div className={styles.phases}>
                  {todos.map((todo, index) => {
                    const status = states.get(todo.id)?.status ?? 'ready';
                    const todoTools = toolsByTodo.get(todo.id) ?? [];
                    return (
                      <button
                        className={`${styles.phase} ${todo.id === selectedTodoId ? styles.phaseActive : ''}`}
                        data-status={status}
                        key={todo.id}
                        onClick={() => {
                          setSelectedTodoId(todo.id);
                          setStageTab('work');
                        }}
                        type="button"
                      >
                        <i>
                          {status === 'completed'
                            ? '✓'
                            : String(index + 1).padStart(2, '0')}
                        </i>
                        <span>
                          <strong>{todo.content}</strong>
                          <small>
                            {todoTools.length
                              ? t('workflow.plan.agentCount', {
                                  count: todoTools.length,
                                })
                              : todo.id}
                          </small>
                        </span>
                        <em>{t(statusKey(status))}</em>
                      </button>
                    );
                  })}
                </div>
              </aside>

              <section
                className={`${styles.panel} ${styles.stage}`}
                ref={stageRef}
              >
                <div className={styles.stageTabs}>
                  {(
                    [
                      ['work', t('workflow.stage.work')],
                      ['activity', t('workflow.stage.activity')],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      className={
                        stageTab === value ? styles.stageTabActive : ''
                      }
                      key={value}
                      onClick={() => setStageTab(value)}
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                  <span>
                    <i />{' '}
                    {t('workflow.stage.session', {
                      state: t(sessionStateKey),
                    })}
                  </span>
                </div>
                {stageTab === 'activity' ? (
                  <div className={styles.activityStage}>
                    {activity.length > 0 ? (
                      activity.map((task) => {
                        const tool = task.toolUseId
                          ? toolsByCallId.get(task.toolUseId)
                          : undefined;
                        const content = (
                          <>
                            <time>{clock(task.endTime ?? task.startTime)}</time>
                            <span>
                              {initials(task.subagentType || task.label)}
                            </span>
                            <div>
                              <strong>{task.label}</strong>
                              <small>
                                {task.recentActivities?.at(-1)?.description ||
                                  task.description}
                              </small>
                            </div>
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
                      })
                    ) : (
                      <div className={styles.inlineEmpty}>
                        {t('workflow.activity.empty')}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className={styles.workStage}>
                    <div className={styles.executionRail}>
                      <div className={styles.railLine}>
                        <i style={{ width: `${progress}%` }} />
                      </div>
                      {todos.map((todo, index) => (
                        <button
                          className={
                            todo.id === selectedTodoId ? styles.railCurrent : ''
                          }
                          key={todo.id}
                          onClick={() => setSelectedTodoId(todo.id)}
                          style={{
                            left: `${todos.length === 1 ? 50 : 5 + (index / (todos.length - 1)) * 90}%`,
                          }}
                          type="button"
                        >
                          <i>
                            {states.get(todo.id)?.status === 'completed'
                              ? '✓'
                              : index + 1}
                          </i>
                        </button>
                      ))}
                    </div>
                    <div className={styles.workDetail}>
                      <div className={styles.workIdentity}>
                        <span>
                          {initials(
                            selectedTask?.subagentType ||
                              selectedTool?.title ||
                              'Agent',
                          )}
                        </span>
                        <div>
                          <small>{selectedTodo?.id}</small>
                          <h2>{selectedTodo?.content}</h2>
                          <p>
                            {selectedState
                              ? t(statusKey(selectedState))
                              : t('workflow.status.ready')}
                          </p>
                        </div>
                        <div className={styles.runtime}>
                          <strong>
                            {selectedToolStats
                              ? formatRuntime(selectedToolStats.durationMs)
                              : selectedTask?.startTime
                                ? formatRuntime(selectedTask.runtimeMs)
                                : '--'}
                          </strong>
                          <span>{t('workflow.runtime.duration')}</span>
                        </div>
                      </div>
                      <div className={styles.currentAction}>
                        <strong>{t('workflow.runtime.currentAction')}</strong>
                        <p>
                          {latestActivity?.description ||
                            selectedTask?.description ||
                            (selectedTool
                              ? getAgentDescription(selectedTool)
                              : selectedState === 'completed'
                                ? t('workflow.runtime.stepCompleted')
                                : selectedTodo?.blockedBy?.length
                                  ? t('workflow.runtime.waitUpstream')
                                  : t('workflow.runtime.waitStart'))}
                        </p>
                      </div>
                      <div className={styles.dependencyCards}>
                        <div>
                          <span>{t('workflow.dependencies.upstream')}</span>
                          <strong>
                            {selectedTodo?.blockedBy?.join(', ') ||
                              t('workflow.dependencies.none')}
                          </strong>
                        </div>
                        <div>
                          <span>{t('workflow.dependencies.unblocks')}</span>
                          <strong>
                            {selectedDependents.join(', ') ||
                              t('workflow.dependencies.noDownstream')}
                          </strong>
                        </div>
                      </div>
                      {selectedTools.length > 0 ? (
                        <div className={styles.agentCards}>
                          {selectedTools.map((tool) => {
                            const task = taskForTool(tool, tasks);
                            const stats = task?.stats ?? agentToolStats(tool);
                            const skills = [
                              ...new Set([
                                ...agentSkills(tool),
                                ...flattenTools([tool])
                                  .map(skillName)
                                  .filter((name): name is string =>
                                    Boolean(name),
                                  ),
                              ]),
                            ];
                            return (
                              <button
                                key={tool.callId}
                                onClick={() => onOpenSubagent(tool)}
                                type="button"
                              >
                                <span>
                                  {initials(
                                    task?.subagentType || tool.title || 'Agent',
                                  )}
                                </span>
                                <div>
                                  <strong>
                                    {tool.title || getAgentDescription(tool)}
                                  </strong>
                                  <small>
                                    {stats ? (
                                      <>
                                        {task
                                          ? t(taskStatusKey(task.status))
                                          : tool.status === 'failed'
                                            ? t('workflow.agent.failed')
                                            : t(
                                                'workflow.agent.completed',
                                              )}{' '}
                                        ·{' '}
                                        {t('workflow.agent.metrics', {
                                          tools: stats.toolUses,
                                          tokens:
                                            stats.totalTokens.toLocaleString(),
                                        })}
                                      </>
                                    ) : task ? (
                                      `${t(taskStatusKey(task.status))} · ${t(
                                        'workflow.agent.metricsMissing',
                                      )}`
                                    ) : (
                                      t('workflow.agent.openTranscript')
                                    )}
                                  </small>
                                  {skills.length > 0 && (
                                    <small>
                                      {t('workflow.agent.skills', {
                                        skills: skills.join(', '),
                                      })}
                                    </small>
                                  )}
                                </div>
                                <em>{t('workflow.agent.openDetails')}</em>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <div className={styles.inlineEmpty}>
                          {t(
                            selectedState === 'completed'
                              ? 'workflow.agent.mainCompleted'
                              : 'workflow.agent.notStarted',
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </section>

              <aside className={styles.panel}>
                <header className={styles.panelHeader}>
                  <div>
                    <h2>{t('workflow.review.title')}</h2>
                    <span>{t('workflow.review.subtitle')}</span>
                  </div>
                  <code>
                    {t(
                      attentionCount
                        ? 'workflow.review.attentionCode'
                        : 'workflow.review.readyCode',
                    )}
                  </code>
                </header>
                <div
                  className={styles.reviewBanner}
                  data-attention={attentionCount > 0 || undefined}
                >
                  <strong>
                    {t(
                      attentionCount
                        ? 'workflow.review.attentionTitle'
                        : 'workflow.review.normalTitle',
                    )}
                  </strong>
                  <p>
                    {attentionCount
                      ? t('workflow.review.attentionCopy', {
                          count: attentionCount,
                        })
                      : t('workflow.review.normalCopy')}
                  </p>
                </div>
                <div className={styles.checkList}>
                  <div>
                    <i>✓</i>
                    <span>
                      <strong>{t('workflow.review.structuredPlan')}</strong>
                      <small>
                        {t('workflow.review.stableIds', {
                          count: todos.length,
                        })}
                      </small>
                    </span>
                    <em>{t('workflow.review.readyCode')}</em>
                  </div>
                  <div>
                    <i>✓</i>
                    <span>
                      <strong>{t('workflow.review.dependencyTopology')}</strong>
                      <small>
                        {t('workflow.review.edgeCount', {
                          count: todos.reduce(
                            (count, todo) =>
                              count + (todo.blockedBy?.length ?? 0),
                            0,
                          ),
                        })}
                      </small>
                    </span>
                    <em>
                      {t(
                        todos.some((todo) => todo.blockedBy?.length)
                          ? 'workflow.review.edgesCode'
                          : 'workflow.review.readyCode',
                      )}
                    </em>
                  </div>
                  <div data-warning={attentionTodos.length > 0 || undefined}>
                    <i>{attentionTodos.length ? '!' : '✓'}</i>
                    <span>
                      <strong>{t('workflow.review.agentExecution')}</strong>
                      <small>
                        {t('workflow.review.agentRecords', {
                          count: agents.length,
                        })}
                      </small>
                    </span>
                    <em>
                      {t(
                        attentionTodos.length
                          ? 'workflow.review.checkCode'
                          : 'workflow.review.readyCode',
                      )}
                    </em>
                  </div>
                  <div
                    data-warning={
                      replayableAgents.length < agents.length || undefined
                    }
                  >
                    <i>
                      {replayableAgents.length === agents.length ? '✓' : '·'}
                    </i>
                    <span>
                      <strong>{t('workflow.review.history')}</strong>
                      <small>{t('workflow.review.historyCopy')}</small>
                    </span>
                    <em>
                      {t(
                        replayableAgents.length === agents.length
                          ? 'workflow.review.readyCode'
                          : 'workflow.review.partialCode',
                      )}
                    </em>
                  </div>
                </div>
                <div className={styles.evidenceGrid}>
                  <div>
                    <strong>
                      {hasCompleteAgentStats ? totalAgentToolUses : '--'}
                    </strong>
                    <span>{t('workflow.evidence.toolCalls')}</span>
                  </div>
                  <div>
                    <strong>
                      {hasCompleteAgentStats
                        ? totalAgentTokens.toLocaleString()
                        : '--'}
                    </strong>
                    <span>{t('workflow.evidence.tokens')}</span>
                  </div>
                  <div>
                    <strong>{completedCount}</strong>
                    <span>{t('workflow.evidence.completedNodes')}</span>
                  </div>
                  {artifacts.length > 0 && (
                    <div>
                      <strong>{artifacts.length}</strong>
                      <span>{t('workflow.evidence.artifacts')}</span>
                    </div>
                  )}
                </div>
                <div className={styles.reviewActions}>
                  {attentionCount > 0 && (
                    <button
                      className={styles.secondaryButton}
                      onClick={() => setSection('attention')}
                      type="button"
                    >
                      {t('workflow.actions.attention')}
                    </button>
                  )}
                  <button
                    className={styles.primaryButton}
                    onClick={onBackToChat}
                    type="button"
                  >
                    {t('workflow.actions.back')}
                  </button>
                </div>
              </aside>
            </section>

            <section className={`${styles.panel} ${styles.collaboration}`}>
              <header className={styles.panelHeader}>
                <div>
                  <h2>{t('workflow.collaboration.title')}</h2>
                  <span>{t('workflow.collaboration.subtitle')}</span>
                </div>
                <button
                  onClick={() => {
                    setStageTab('activity');
                    stageRef.current?.scrollIntoView({ behavior: 'smooth' });
                  }}
                  type="button"
                >
                  {t('workflow.collaboration.fullActivity')}
                </button>
              </header>
              <div className={styles.collaborationBody}>
                <div className={styles.logRows}>
                  {activity.slice(0, 3).map((task) => {
                    const tool = task.toolUseId
                      ? toolsByCallId.get(task.toolUseId)
                      : undefined;
                    return (
                      <button
                        disabled={!tool}
                        key={task.id}
                        onClick={() => tool && onOpenSubagent(tool)}
                        type="button"
                      >
                        <time>{clock(task.endTime ?? task.startTime)}</time>
                        <span>{initials(task.subagentType || task.label)}</span>
                        <p>
                          {task.recentActivities?.at(-1)?.description ||
                            task.description}
                        </p>
                        <em>{t(taskStatusKey(task.status))}</em>
                      </button>
                    );
                  })}
                  {activity.length === 0 && (
                    <div className={styles.inlineEmpty}>
                      {t(
                        progress === 100
                          ? 'workflow.collaboration.noSubagents'
                          : 'workflow.collaboration.waiting',
                      )}
                    </div>
                  )}
                </div>
                <div className={styles.deliverables}>
                  <div>
                    <strong>{t('workflow.deliverables.title')}</strong>
                    <span>
                      {deliverables.length > 0
                        ? t('workflow.deliverables.count', {
                            count: deliverables.length,
                          })
                        : t('workflow.deliverables.none')}
                    </span>
                  </div>
                  <section>
                    {deliverables.length ? (
                      deliverables.map((artifact) => (
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
                  </section>
                </div>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
