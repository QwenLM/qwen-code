import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, LayoutDashboard } from 'lucide-react';
import type {
  DaemonSessionAgentTaskStatus,
  DaemonSessionTaskStatus,
} from '@qwen-code/sdk/daemon';
import type {
  ACPToolCall,
  PermissionRequest,
  TodoItem,
} from '../../adapters/types';
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
  onConfirm: (id: string, selectedOption: string) => void;
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
  approval?: CockpitApproval;
  onBackToChat: () => void;
  onOpenSubagent: (tool: ACPToolCall) => void;
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

function statusLabel(status: PlanNodeStatus): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'paused':
      return '已暂停';
    case 'completed':
      return '已完成';
    case 'blocked':
      return '等待依赖';
    case 'in_progress':
      return '处理中';
    default:
      return '待执行';
  }
}

function taskStatusLabel(status: DaemonSessionAgentTaskStatus['status']) {
  switch (status) {
    case 'running':
      return '运行中';
    case 'paused':
      return '已暂停';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    default:
      return '已取消';
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
  const completedContextSteps = 2;
  const dependencyCount = approval.todos.reduce(
    (total, todo) => total + (todo.blockedBy?.length ?? 0),
    0,
  );
  const handleConfirm = (id: string, selectedOption: string) => {
    approval.onConfirm(id, selectedOption);
    const option = approval.request.options.find(
      (candidate) => candidate.id === selectedOption,
    );
    if (option?.kind === 'reject_once' || option?.kind === 'reject_always') {
      onBackToChat();
    }
  };

  return (
    <div className={styles.reviewShell} data-testid="cockpit-plan-review">
      <div className={styles.reviewBody}>
        <main className={styles.reviewMain}>
          <section className={styles.reviewSteps}>
            <div className={styles.reviewStepsIntro}>
              <div className={styles.reviewEyebrow}>PLAN &amp; REVIEW</div>
              <strong>从目标到执行</strong>
              <span>确认计划后才会退出 Plan Mode</span>
            </div>
            <div className={styles.reviewStepList}>
              {[
                ['01', '描述目标', '目标已进入当前 Session'],
                ['02', '确认理解', '模型已完成只读分析'],
                ['03', '预览计划', '检查节点、依赖与并行关系'],
                ['04', '授权并启动', '确认后才开始执行'],
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
              <span>STEP 03 · EXECUTION GRAPH</span>
              <h2>{sessionName || '当前协作任务'}</h2>
              <p>{goal || '模型已生成结构化执行计划，请确认后继续。'}</p>
            </div>
            <div className={styles.planFacts}>
              <div>
                <strong>{approval.todos.length}</strong>
                <span>执行步骤</span>
              </div>
              <div>
                <strong>{dependencyCount}</strong>
                <span>依赖关系</span>
              </div>
              <div>
                <strong>
                  {
                    approval.todos.filter((todo) => !todo.blockedBy?.length)
                      .length
                  }
                </strong>
                <span>可并行起点</span>
              </div>
            </div>
          </div>
          <div className={styles.reviewGrid}>
            <section className={styles.reviewGraphCard}>
              <PlanExecutionView todos={approval.todos} tools={[]} tasks={[]} />
            </section>
            <aside className={styles.permissionCard}>
              <div className={styles.permissionKicker}>
                STEP 04 · GUARDRAILS
              </div>
              <h3>确认边界并启动</h3>
              <p>批准后，Agent 才能按照这个 revision 继续执行。</p>
              <ToolApproval
                request={approval.request}
                onConfirm={handleConfirm}
                variant="inline"
                keyboardActive
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
  approval,
  onBackToChat,
  onOpenSubagent,
}: SessionWorkflowCockpitProps) {
  const [section, setSection] = useState<CockpitSection>('task');
  const [stageTab, setStageTab] = useState<StageTab>('work');
  const [selectedTodoId, setSelectedTodoId] = useState<string>();
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
  const attentionTodo =
    attentionTodos.find((todo) => todo.id === selectedTodoId) ??
    attentionTodos[0];
  const attentionTool = attentionTodo
    ? toolsByTodo.get(attentionTodo.id)?.[0]
    : undefined;
  const taskStatus =
    progress === 100
      ? '已完成'
      : activeAgents.length > 0 ||
          todos.some((todo) => {
            const status = states.get(todo.id)?.status;
            return status === 'running' || status === 'in_progress';
          })
        ? '协作运行中'
        : todos.length > 0
          ? '等待执行'
          : '等待计划';
  const activity = agents.slice().sort((a, b) => b.startTime - a.startTime);
  const outputFiles = agents
    .flatMap((task) => (task.outputFile ? [task.outputFile] : []))
    .slice(0, 3);
  const hasCompleteAgentStats = agents.every((task) => task.stats);
  const totalAgentToolUses = agents.reduce(
    (sum, task) => sum + (task.stats?.toolUses ?? 0),
    0,
  );
  const totalAgentTokens = agents.reduce(
    (sum, task) => sum + (task.stats?.totalTokens ?? 0),
    0,
  );

  if (todos.length === 0) {
    return (
      <div className={styles.emptyCockpit} data-testid="cockpit-empty">
        <div className={styles.emptyMark}>Q</div>
        <div className={styles.reviewEyebrow}>SESSION COCKPIT</div>
        <h1>这个 Session 还没有结构化 Workflow</h1>
        <p>
          返回 Chat，进入 Plan &amp; Review 并让模型先写入带 ID 和依赖的 Todo。
        </p>
        <button
          className={styles.primaryButton}
          onClick={onBackToChat}
          type="button"
        >
          返回 Chat 创建计划
        </button>
      </div>
    );
  }

  return (
    <div className={styles.cockpit} data-testid="session-workflow-cockpit">
      <main className={styles.main}>
        <div className={styles.viewBar}>
          <nav aria-label="驾驶舱视图" className={styles.cockpitTabs}>
            <button
              aria-label="协作任务"
              data-active={section === 'task' || undefined}
              onClick={() => setSection('task')}
              type="button"
            >
              <LayoutDashboard aria-hidden="true" />
              <span>协作任务</span>
            </button>
            <button
              aria-label="待我处理"
              data-active={section === 'attention' || undefined}
              onClick={() => setSection('attention')}
              type="button"
            >
              <CircleAlert aria-hidden="true" />
              <span>待我处理</span>
              {attentionTodos.length > 0 && <b>{attentionTodos.length}</b>}
            </button>
          </nav>
          <span
            className={styles.environment}
            data-connected={connected || undefined}
          >
            <i />
            daemon {connected ? 'connected' : 'reconnecting'}
          </span>
        </div>

        {section === 'attention' ? (
          <section className={styles.attentionPage}>
            <div className={styles.attentionHeading}>
              <div>
                <span className={styles.reviewEyebrow}>HUMAN IN THE LOOP</span>
                <h1>待我处理</h1>
                <p>这里只展示 Agent 无法自行处理、需要用户介入的节点。</p>
              </div>
            </div>
            <div className={styles.attentionStats}>
              <div>
                <strong>{attentionTodos.length}</strong>
                <span>需要处理</span>
              </div>
              <div>
                <strong>
                  {agents.filter((task) => task.status === 'failed').length}
                </strong>
                <span>Agent 失败</span>
              </div>
              <div>
                <strong>
                  {agents.filter((task) => task.status === 'cancelled').length}
                </strong>
                <span>已取消</span>
              </div>
              <div>
                <strong>{activeAgents.length}</strong>
                <span>仍在运行</span>
              </div>
            </div>
            {attentionTodos.length > 0 ? (
              <div className={styles.attentionWorkspace}>
                <div className={styles.attentionList}>
                  <header>
                    <strong>决策队列</strong>
                    <span>按 Workflow 顺序</span>
                  </header>
                  {attentionTodos.map((todo) => (
                    <button
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
                    WORKFLOW ATTENTION
                  </span>
                  <h2>{attentionTodo?.content}</h2>
                  <p>
                    该节点关联的 Agent 执行失败或取消。返回 Chat
                    补充信息，或打开 Agent transcript 查看完整证据。
                  </p>
                  {attentionTool && (
                    <button
                      className={styles.primaryButton}
                      onClick={() => onOpenSubagent(attentionTool)}
                      type="button"
                    >
                      查看 Agent 完整输出
                    </button>
                  )}
                </article>
              </div>
            ) : (
              <div className={styles.attentionEmpty}>
                <span>✓</span>
                <h2>当前没有需要人工处理的节点</h2>
                <p>
                  Plan 审批和 Agent
                  异常会自动进入这里；普通依赖等待不会制造噪音。
                </p>
              </div>
            )}
          </section>
        ) : (
          <div className={styles.content}>
            <section className={styles.taskHeading}>
              <div>
                <div className={styles.titleLine}>
                  <h1>{sessionName || '当前 Session Workflow'}</h1>
                  <span data-status={taskStatus}>{taskStatus}</span>
                </div>
                <div className={styles.taskMeta}>
                  <code>{sessionId.slice(0, 8)}</code>
                  <span>{workspaceCwd?.split('/').at(-1) || 'workspace'}</span>
                  <span>{todos.length} 个步骤</span>
                  <span>{tools.length} 个 Agent 调用</span>
                </div>
              </div>
            </section>

            <section className={styles.stats} aria-label="任务概况">
              <div className={styles.progressStat}>
                <div>
                  <span>整体进度</span>
                  <strong>
                    {progress}% · {taskStatus}
                  </strong>
                </div>
                <div className={styles.progressTrack}>
                  <i style={{ width: `${progress}%` }} />
                </div>
              </div>
              <div>
                <strong>{activeAgents.length}</strong>
                <span>Agent 正在工作</span>
              </div>
              <div>
                <strong>
                  {completedCount} / {todos.length}
                </strong>
                <span>步骤已完成</span>
              </div>
              <div>
                <strong>{agents.length}</strong>
                <span>Agent 执行记录</span>
              </div>
              <div data-attention={attentionTodos.length > 0 || undefined}>
                <strong>{attentionTodos.length}</strong>
                <span>需要人工处理</span>
              </div>
            </section>

            <section className={styles.workspace}>
              <aside className={styles.panel}>
                <header className={styles.panelHeader}>
                  <div>
                    <h2>执行计划</h2>
                    <span>{todos.length} 个节点 · 点击查看详情</span>
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
                              ? `${todoTools.length} 个 Agent`
                              : todo.id}
                          </small>
                        </span>
                        <em>{statusLabel(status)}</em>
                      </button>
                    );
                  })}
                </div>
              </aside>

              <section className={`${styles.panel} ${styles.stage}`}>
                <div className={styles.stageTabs}>
                  {(
                    [
                      ['work', '工作现场'],
                      ['activity', 'Agent 记录'],
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
                    <i /> LIVE SESSION
                  </span>
                </div>
                {stageTab === 'activity' ? (
                  <div className={styles.activityStage}>
                    {activity.length > 0 ? (
                      activity.map((task) => (
                        <div className={styles.activityRow} key={task.id}>
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
                            {taskStatusLabel(task.status)}
                          </em>
                        </div>
                      ))
                    ) : (
                      <div className={styles.inlineEmpty}>
                        还没有关联到 Todo 的 Agent 执行。
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
                              ? statusLabel(selectedState)
                              : '等待执行'}
                          </p>
                        </div>
                        <div className={styles.runtime}>
                          <strong>
                            {selectedTask
                              ? selectedTask.startTime > 0
                                ? formatRuntime(selectedTask.runtimeMs)
                                : '--'
                              : '--'}
                          </strong>
                          <span>执行耗时</span>
                        </div>
                      </div>
                      <div className={styles.currentAction}>
                        <strong>当前动作</strong>
                        <p>
                          {latestActivity?.description ||
                            selectedTask?.description ||
                            (selectedTool
                              ? getAgentDescription(selectedTool)
                              : '等待上游依赖完成后开始执行。')}
                        </p>
                      </div>
                      <div className={styles.dependencyCards}>
                        <div>
                          <span>上游依赖</span>
                          <strong>
                            {selectedTodo?.blockedBy?.join(', ') ||
                              '无，可直接开始'}
                          </strong>
                        </div>
                        <div>
                          <span>完成后解锁</span>
                          <strong>
                            {selectedDependents.join(', ') || '无下游节点'}
                          </strong>
                        </div>
                      </div>
                      {selectedTools.length > 0 ? (
                        <div className={styles.agentCards}>
                          {selectedTools.map((tool) => {
                            const task = taskForTool(tool, tasks);
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
                                    {task ? (
                                      <>
                                        {taskStatusLabel(task.status)} ·{' '}
                                        {task.stats
                                          ? `${task.stats.toolUses} 次工具调用 · ${task.stats.totalTokens.toLocaleString()} tokens`
                                          : '执行指标未记录'}
                                      </>
                                    ) : (
                                      '打开持久化 transcript 查看完整输出'
                                    )}
                                  </small>
                                </div>
                                <em>打开详情 →</em>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <div className={styles.inlineEmpty}>
                          这个步骤还没有启动 Subagent。
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </section>

              <aside className={styles.panel}>
                <header className={styles.panelHeader}>
                  <div>
                    <h2>检查与决策</h2>
                    <span>来自同一 Workflow 状态</span>
                  </div>
                  <code>{attentionTodos.length ? 'ATTN' : 'PASS'}</code>
                </header>
                <div
                  className={styles.reviewBanner}
                  data-attention={attentionTodos.length > 0 || undefined}
                >
                  <strong>
                    {attentionTodos.length
                      ? '⚠ 需要人工介入'
                      : '✓ 当前检查通过'}
                  </strong>
                  <p>
                    {attentionTodos.length
                      ? `${attentionTodos.length} 个节点的 Agent 执行需要处理。`
                      : '没有失败或取消的 Agent；依赖等待属于正常执行状态。'}
                  </p>
                </div>
                <div className={styles.checkList}>
                  <div>
                    <i>✓</i>
                    <span>
                      <strong>结构化计划</strong>
                      <small>{todos.length} 个 Todo 均有稳定 ID</small>
                    </span>
                    <em>PASS</em>
                  </div>
                  <div>
                    <i>✓</i>
                    <span>
                      <strong>依赖拓扑</strong>
                      <small>
                        {todos.reduce(
                          (count, todo) =>
                            count + (todo.blockedBy?.length ?? 0),
                          0,
                        )}{' '}
                        条 blockedBy 关系
                      </small>
                    </span>
                    <em>PASS</em>
                  </div>
                  <div data-warning={attentionTodos.length > 0 || undefined}>
                    <i>{attentionTodos.length ? '!' : '✓'}</i>
                    <span>
                      <strong>Agent 执行</strong>
                      <small>{agents.length} 条关联记录</small>
                    </span>
                    <em>{attentionTodos.length ? 'CHECK' : 'PASS'}</em>
                  </div>
                  <div>
                    <i>✓</i>
                    <span>
                      <strong>历史可回放</strong>
                      <small>完成后仍可打开 transcript</small>
                    </span>
                    <em>PASS</em>
                  </div>
                </div>
                <div className={styles.evidenceGrid}>
                  <div>
                    <strong>
                      {hasCompleteAgentStats ? totalAgentToolUses : '--'}
                    </strong>
                    <span>工具调用</span>
                  </div>
                  <div>
                    <strong>
                      {hasCompleteAgentStats
                        ? totalAgentTokens.toLocaleString()
                        : '--'}
                    </strong>
                    <span>Agent tokens</span>
                  </div>
                  <div>
                    <strong>{completedCount}</strong>
                    <span>完成节点</span>
                  </div>
                  <div>
                    <strong>{outputFiles.length}</strong>
                    <span>持久化输出</span>
                  </div>
                </div>
                <div className={styles.reviewActions}>
                  {attentionTodos.length > 0 && (
                    <button
                      className={styles.secondaryButton}
                      onClick={() => setSection('attention')}
                      type="button"
                    >
                      进入待我处理
                    </button>
                  )}
                  <button
                    className={styles.primaryButton}
                    onClick={onBackToChat}
                    type="button"
                  >
                    回到 Chat 继续协作
                  </button>
                </div>
              </aside>
            </section>

            <section className={`${styles.panel} ${styles.collaboration}`}>
              <header className={styles.panelHeader}>
                <div>
                  <h2>协作记录</h2>
                  <span>Agent 通过 Todo、工具调用和产物交接</span>
                </div>
                <button onClick={() => setStageTab('activity')} type="button">
                  查看完整记录
                </button>
              </header>
              <div className={styles.collaborationBody}>
                <div className={styles.logRows}>
                  {activity.slice(0, 3).map((task) => (
                    <div key={task.id}>
                      <time>{clock(task.endTime ?? task.startTime)}</time>
                      <span>{initials(task.subagentType || task.label)}</span>
                      <p>
                        {task.recentActivities?.at(-1)?.description ||
                          task.description}
                      </p>
                      <em>{taskStatusLabel(task.status)}</em>
                    </div>
                  ))}
                  {activity.length === 0 && (
                    <div className={styles.inlineEmpty}>
                      等待 Agent 开始执行。
                    </div>
                  )}
                </div>
                <div className={styles.deliverables}>
                  <div>
                    <strong>当前交付包</strong>
                    <span>{outputFiles.length} 个持久化输出</span>
                  </div>
                  <section>
                    {outputFiles.length ? (
                      outputFiles.map((file) => (
                        <span key={file}>
                          <strong>{file.split('/').at(-1)}</strong>
                          <small>Agent transcript</small>
                        </span>
                      ))
                    ) : (
                      <p>Agent 完成后，输出文件会出现在这里。</p>
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
