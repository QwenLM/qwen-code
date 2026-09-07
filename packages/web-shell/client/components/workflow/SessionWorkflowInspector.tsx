import { useEffect, useMemo } from 'react';
import type {
  DaemonSessionArtifact,
  DaemonSessionTaskStatus,
} from '@qwen-code/sdk/daemon';
import {
  AlertCircleIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  GitBranchIcon,
} from 'lucide-react';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
import { useI18n } from '../../i18n';
import { formatRuntime } from '../../utils/formatRuntime';
import {
  buildSessionWorkflowProjection,
  getDefaultWorkflowTodoId,
  workflowClock,
  workflowInitials,
  workflowTaskStatusKey,
} from './session-workflow-model';
import styles from './SessionWorkflowInspector.module.css';

export interface SessionWorkflowInspectorProps {
  todos: readonly TodoItem[];
  tools: readonly ACPToolCall[];
  tasks: readonly DaemonSessionTaskStatus[];
  artifacts: readonly DaemonSessionArtifact[];
  selectedTodoId?: string;
  onSelectedTodoIdChange: (todoId: string | undefined) => void;
  onExpandGraph: () => void;
  onOpenSubagent: (tool: ACPToolCall) => void;
  onOpenArtifact?: (artifactId: string) => void;
  canvasMode?: boolean;
}

export function SessionWorkflowInspector({
  todos,
  tools,
  tasks,
  artifacts,
  selectedTodoId,
  onSelectedTodoIdChange,
  onExpandGraph,
  onOpenSubagent,
  onOpenArtifact,
  canvasMode = false,
}: SessionWorkflowInspectorProps) {
  const { language, t } = useI18n();
  const projection = useMemo(
    () => buildSessionWorkflowProjection(todos, tools, tasks),
    [tasks, todos, tools],
  );
  const defaultTodoId = getDefaultWorkflowTodoId(todos, projection);
  const effectiveSelectedTodoId = projection.todosById.has(selectedTodoId ?? '')
    ? selectedTodoId
    : defaultTodoId;
  const selectedTodo = projection.todosById.get(effectiveSelectedTodoId ?? '');

  useEffect(() => {
    if (effectiveSelectedTodoId !== selectedTodoId) {
      onSelectedTodoIdChange(effectiveSelectedTodoId);
    }
  }, [effectiveSelectedTodoId, onSelectedTodoIdChange, selectedTodoId]);

  if (todos.length === 0) {
    return (
      <div className={styles.empty} data-testid="workflow-inspector-empty">
        <GitBranchIcon aria-hidden="true" />
        <strong>{t('workflow.empty.title')}</strong>
        <p>{t('workflow.empty.copy')}</p>
      </div>
    );
  }

  const selectedState = selectedTodo
    ? projection.states.get(selectedTodo.id)
    : undefined;
  const selectedTools = selectedTodo
    ? (projection.agentToolsByTodo.get(selectedTodo.id) ?? [])
    : [];
  const upstream = selectedTodo?.blockedBy?.filter((id) =>
    projection.todosById.has(id),
  );
  // The projection already derives this for the graph's edges; recomputing it
  // here rescanned every todo's `blockedBy` for the same answer. It also drops
  // a todo that lists itself in `blockedBy`, which the previous filter kept as
  // its own downstream step.
  const downstream = selectedTodo
    ? (projection.dependentsByTodo.get(selectedTodo.id) ?? [])
    : [];

  const detail = selectedTodo && selectedState && (
    <section className={styles.detail} data-testid="workflow-step-detail">
      <div className={styles.sectionHeading}>
        <div>
          <span>{t('workflow.inspector.selectedStep')}</span>
          <h2>{selectedTodo.content}</h2>
        </div>
        <span className={styles.status} data-status={selectedState.status}>
          {t(`planExecution.status.${selectedState.status}`)}
        </span>
      </div>
      <code className={styles.stepId}>{selectedTodo.id}</code>
      <dl className={styles.dependencies}>
        <div>
          <dt>{t('workflow.dependencies.upstream')}</dt>
          <dd>
            {upstream?.length
              ? upstream.join(', ')
              : t('workflow.dependencies.none')}
          </dd>
        </div>
        <div>
          <dt>{t('workflow.dependencies.unblocks')}</dt>
          <dd>
            {downstream.length
              ? downstream.map((todo) => todo.id).join(', ')
              : t('workflow.dependencies.noDownstream')}
          </dd>
        </div>
      </dl>
      <div className={styles.linkedAgents}>
        <h3>{t('planExecution.subagents')}</h3>
        {selectedTools.length ? (
          selectedTools.map((tool) => {
            const task = projection.tasksByTool.get(tool);
            const metrics = task
              ? [
                  task.startTime > 0 ? formatRuntime(task.runtimeMs) : '',
                  task.stats?.toolUses === undefined
                    ? ''
                    : t('planExecution.toolCalls', {
                        count: task.stats.toolUses,
                      }),
                  task.stats?.totalTokens === undefined
                    ? ''
                    : t('planExecution.tokens', {
                        count: task.stats.totalTokens.toLocaleString(),
                      }),
                ].filter(Boolean)
              : [];
            return (
              <button
                key={tool.callId}
                onClick={() => onOpenSubagent(tool)}
                type="button"
              >
                <span className={styles.itemText}>
                  <strong>
                    {tool.title || String(tool.args?.description ?? 'Agent')}
                  </strong>
                  {task && (
                    <small>
                      {task.recentActivities?.at(-1)?.description ||
                        task.description}
                    </small>
                  )}
                  {metrics.length > 0 && <small>{metrics.join(' · ')}</small>}
                </span>
                {task && (
                  <span className={styles.stateLabel} data-status={task.status}>
                    {t(workflowTaskStatusKey(task.status))}
                  </span>
                )}
                <ArrowUpRightIcon aria-hidden="true" />
              </button>
            );
          })
        ) : (
          <p>{t('planExecution.noSubagents')}</p>
        )}
      </div>
    </section>
  );

  if (canvasMode) {
    return (
      <div className={styles.inspector} data-testid="workflow-canvas-detail">
        <div className={styles.canvasHint}>
          <GitBranchIcon aria-hidden="true" />
          <span>{t('workflow.inspector.canvasHint')}</span>
        </div>
        {detail}
      </div>
    );
  }

  return (
    <div className={styles.inspector} data-testid="workflow-inspector">
      <section className={styles.summary}>
        <div className={styles.summaryHeading}>
          <div>
            <span>{t('workflow.inspector.summary')}</span>
            <strong>{t(projection.taskStatusI18nKey)}</strong>
          </div>
          <span
            className={styles.summaryCount}
            data-status={projection.taskStatusTone}
          >
            {projection.completedCount}/{todos.length}
          </span>
        </div>
        <div
          className={styles.progress}
          role="progressbar"
          aria-label={t('planExecution.overallProgress')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={projection.progressPercent}
        >
          <span style={{ width: `${projection.progressPercent}%` }} />
        </div>
        <div className={styles.summaryMeta}>
          <span>
            {t('workflow.inspector.activeAgents', {
              count: projection.activeAgents.length,
            })}
          </span>
          <span>
            {t('workflow.inspector.attentionCount', {
              count: projection.attentionTodos.length,
            })}
          </span>
        </div>
        <button
          className={styles.expandButton}
          onClick={onExpandGraph}
          type="button"
        >
          <GitBranchIcon aria-hidden="true" />
          {t('workflow.inspector.expandGraph')}
          <ChevronRightIcon aria-hidden="true" />
        </button>
      </section>

      {projection.attentionTodos.length > 0 && (
        <section className={styles.attention}>
          <div className={styles.compactHeading}>
            <h2>{t('workflow.tabs.attention')}</h2>
            <span>{projection.attentionTodos.length}</span>
          </div>
          {projection.attentionTodos.map((todo) => (
            <button
              aria-pressed={effectiveSelectedTodoId === todo.id}
              key={todo.id}
              onClick={() => onSelectedTodoIdChange(todo.id)}
              type="button"
            >
              <AlertCircleIcon
                aria-hidden="true"
                className={styles.attentionGlyph}
              />
              <span>{todo.content}</span>
              <ChevronRightIcon aria-hidden="true" />
            </button>
          ))}
        </section>
      )}

      <section className={styles.steps} data-testid="workflow-step-list">
        <div className={styles.compactHeading}>
          <h2>{t('workflow.inspector.allSteps')}</h2>
          <span>{todos.length}</span>
        </div>
        <div className={styles.stepList}>
          {todos.map((todo, index) => {
            const state = projection.states.get(todo.id);
            return (
              <button
                aria-pressed={effectiveSelectedTodoId === todo.id}
                key={todo.id}
                onClick={() => onSelectedTodoIdChange(todo.id)}
                type="button"
              >
                <span className={styles.stepIndex} data-status={state?.status}>
                  {index + 1}
                </span>
                <span className={styles.itemText}>
                  <strong>{todo.content}</strong>
                  <small>{todo.id}</small>
                </span>
                {state && (
                  <span
                    className={styles.stateLabel}
                    data-status={state.status}
                  >
                    {t(`planExecution.status.${state.status}`)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {detail}

      <details className={styles.collapsible} open>
        <summary>
          <span>{t('workflow.inspector.recentActivity')}</span>
          <small>{projection.activity.length}</small>
        </summary>
        <div className={styles.activityList}>
          {projection.activity.slice(0, 6).map((task) => {
            const tool = projection.toolsByTaskId.get(task.id);
            const at = task.endTime ?? task.startTime;
            const content = (
              <>
                <time dateTime={at ? new Date(at).toISOString() : undefined}>
                  {workflowClock(at, language)}
                </time>
                <span className={styles.activityAvatar}>
                  {workflowInitials(task.subagentType || task.label)}
                </span>
                <span className={styles.itemText}>
                  <strong>{task.label}</strong>
                  <small>
                    {task.recentActivities?.at(-1)?.description ||
                      task.description}
                  </small>
                </span>
                <span className={styles.stateLabel} data-status={task.status}>
                  {t(workflowTaskStatusKey(task.status))}
                </span>
              </>
            );
            return tool ? (
              <button
                key={task.id}
                onClick={() => onOpenSubagent(tool)}
                type="button"
              >
                {content}
              </button>
            ) : (
              <div key={task.id}>{content}</div>
            );
          })}
          {projection.activity.length === 0 && (
            <p>{t('workflow.activity.empty')}</p>
          )}
        </div>
      </details>

      <details className={styles.collapsible} open={artifacts.length > 0}>
        <summary>
          <span>{t('workflow.deliverables.title')}</span>
          <small>{artifacts.length}</small>
        </summary>
        <div className={styles.deliverables}>
          {artifacts.map((artifact) => (
            <button
              disabled={!onOpenArtifact}
              key={artifact.id}
              onClick={() => onOpenArtifact?.(artifact.id)}
              type="button"
            >
              <span className={styles.itemText}>
                <strong>{artifact.title}</strong>
                <small>
                  {artifact.kind} · {artifact.status}
                </small>
              </span>
              <ArrowUpRightIcon aria-hidden="true" />
            </button>
          ))}
          {artifacts.length === 0 && <p>{t('workflow.deliverables.none')}</p>}
        </div>
      </details>
    </div>
  );
}
