import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { getSubagentDetailsUnavailableReason } from '../messages/toolFormatting';
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
}: SessionWorkflowInspectorProps): React.JSX.Element {
  const { language, t } = useI18n();
  const projection = useMemo(
    () => buildSessionWorkflowProjection(todos, tools, tasks),
    [todos, tools, tasks],
  );

  const defaultTodoId = useMemo(
    () => getDefaultWorkflowTodoId(todos, projection),
    [todos, projection],
  );

  const effectiveSelectedTodoId = useMemo(() => {
    if (selectedTodoId != null && projection.todosById.has(selectedTodoId)) {
      return selectedTodoId;
    }
    return defaultTodoId;
  }, [selectedTodoId, defaultTodoId, projection.todosById]);

  const selectedTodo = useMemo(
    () => projection.todosById.get(effectiveSelectedTodoId ?? ''),
    [effectiveSelectedTodoId, projection.todosById],
  );

  const selectedState = useMemo(
    () => (selectedTodo ? projection.states.get(selectedTodo.id) : undefined),
    [selectedTodo, projection.states],
  );

  const selectedTools = useMemo(
    () =>
      selectedTodo
        ? (projection.agentToolsByTodo.get(selectedTodo.id) ?? [])
        : [],
    [selectedTodo, projection.agentToolsByTodo],
  );

  // Filter upstream to only include todos that still exist in the projection.
  // Guards against stale blockedBy references after plan mutations.
  const upstreamIds = useMemo(
    () =>
      selectedTodo?.blockedBy?.filter((id) => projection.todosById.has(id)) ??
      [],
    [selectedTodo, projection.todosById],
  );

  // Downstream dependents are pre-derived by the projection. Falls back to
  // empty array when no dependents exist. Drops self-references automatically.
  const downstreamTodos = useMemo(
    () =>
      selectedTodo
        ? (projection.dependentsByTodo.get(selectedTodo.id) ?? [])
        : [],
    [selectedTodo, projection.dependentsByTodo],
  );

  const todoIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    todos.forEach((todo, index) => map.set(todo.id, index));
    return map;
  }, [todos]);

  const [showAllActivity, setShowAllActivity] = useState(false);

  const handleSelectedTodoChange = useCallback(
    (todoId: string | undefined) => {
      onSelectedTodoIdChange(todoId);
    },
    [onSelectedTodoIdChange],
  );

  const handleExpandGraph = useCallback(() => {
    onExpandGraph();
  }, [onExpandGraph]);

  const handleOpenSubagent = useCallback(
    (tool: ACPToolCall) => {
      if (!getSubagentDetailsUnavailableReason(tool)) {
        onOpenSubagent(tool);
      }
    },
    [onOpenSubagent],
  );

  const handleOpenArtifact = useCallback(
    (artifactId: string) => {
      onOpenArtifact?.(artifactId);
    },
    [onOpenArtifact],
  );

  const [activeUpIdx, setActiveUpIdx] = useState(0);
  const [activeDownIdx, setActiveDownIdx] = useState(0);
  useEffect(() => {
    setActiveUpIdx(0);
    setActiveDownIdx(0);
  }, [effectiveSelectedTodoId]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!effectiveSelectedTodoId || !selectedTodo) return;

      let nextId: string | undefined;
      switch (event.key) {
        case 'ArrowUp':
        case 'ArrowLeft': {
          if (upstreamIds.length > 0) {
            nextId = upstreamIds[activeUpIdx % upstreamIds.length];
            setActiveUpIdx((prev) => (prev + 1) % upstreamIds.length);
          }
          break;
        }
        case 'ArrowDown':
        case 'ArrowRight': {
          if (downstreamTodos.length > 0) {
            nextId =
              downstreamTodos[activeDownIdx % downstreamTodos.length]?.id;
            setActiveDownIdx((prev) => (prev + 1) % downstreamTodos.length);
          }
          break;
        }
        default:
          return;
      }

      if (nextId != null) {
        event.preventDefault();
        event.stopPropagation();
        onSelectedTodoIdChange(nextId);
      }
    },
    [
      effectiveSelectedTodoId,
      selectedTodo,
      upstreamIds,
      downstreamTodos,
      activeUpIdx,
      activeDownIdx,
      onSelectedTodoIdChange,
    ],
  );

  useEffect(() => {
    if (effectiveSelectedTodoId !== selectedTodoId) {
      onSelectedTodoIdChange(effectiveSelectedTodoId);
    }
  }, [effectiveSelectedTodoId, selectedTodoId, onSelectedTodoIdChange]);

  const renderDependencyLink = useCallback(
    (todoId: string, index: number) => {
      const todo = projection.todosById.get(todoId);
      if (!todo) return null;

      const stepNumber = todoIndexMap.get(todoId);
      const label =
        stepNumber != null
          ? `${stepNumber + 1}. ${todo.content}`
          : todo.content;

      return (
        <span key={todoId} className={styles.dependencyLinkWrapper}>
          {index > 0 && <span className={styles.dependencySeparator}>, </span>}
          <button
            className={styles.dependencyLink}
            onClick={() => handleSelectedTodoChange(todoId)}
            type="button"
            aria-label={t('workflow.dependencies.navigateTo', {
              step: label,
            })}
          >
            {label}
          </button>
        </span>
      );
    },
    [projection.todosById, todoIndexMap, handleSelectedTodoChange, t],
  );

  if (todos.length === 0) {
    return (
      <div className={styles.empty} data-testid="workflow-inspector-empty">
        <GitBranchIcon aria-hidden="true" />
        <strong>{t('workflow.empty.title')}</strong>
        <p>{t('workflow.empty.copy')}</p>
      </div>
    );
  }

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

      {/* Interactive dependency navigation */}
      <dl className={styles.dependencies}>
        <div>
          <dt>{t('workflow.dependencies.upstream')}</dt>
          <dd>
            {upstreamIds.length > 0
              ? upstreamIds.map((id, i) => renderDependencyLink(id, i))
              : t('workflow.dependencies.none')}
          </dd>
        </div>
        <div>
          <dt>{t('workflow.dependencies.unblocks')}</dt>
          <dd>
            {downstreamTodos.length > 0
              ? downstreamTodos.map((todo, i) =>
                  renderDependencyLink(todo.id, i, downstreamTodos.length),
                )
              : t('workflow.dependencies.noDownstream')}
          </dd>
        </div>
      </dl>

      <div className={styles.linkedAgents}>
        <h3>{t('planExecution.subagents')}</h3>
        {selectedTools.length > 0 ? (
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

            const unavailableReason = getSubagentDetailsUnavailableReason(tool);

            return (
              <button
                key={tool.callId}
                aria-disabled={!!unavailableReason || undefined}
                title={unavailableReason ?? t('planExecution.openDetails')}
                onClick={() => handleOpenSubagent(tool)}
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
      <div
        className={styles.inspector}
        data-testid="workflow-canvas-detail"
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="application"
        aria-label={t('workflow.inspector.keyboardNavLabel')}
      >
        <div className={styles.canvasHint}>
          <GitBranchIcon aria-hidden="true" />
          <span>{t('workflow.inspector.canvasHint')}</span>
        </div>
        {detail}
      </div>
    );
  }

  return (
    <div
      className={styles.inspector}
      data-testid="workflow-inspector"
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="application"
      aria-label={t('workflow.inspector.keyboardNavLabel')}
    >
      {/* Summary Section */}
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
          onClick={handleExpandGraph}
          type="button"
        >
          <GitBranchIcon aria-hidden="true" />
          {t('workflow.inspector.expandGraph')}
          <ChevronRightIcon aria-hidden="true" />
        </button>
      </section>

      {/* Attention-Requiring Steps */}
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
              onClick={() => handleSelectedTodoChange(todo.id)}
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

      {/* All Steps List */}
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
                onClick={() => handleSelectedTodoChange(todo.id)}
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

      {/* Selected Step Detail */}
      {detail}

      {/* Recent Activity */}
      <details className={styles.collapsible} open>
        <summary>
          <span>{t('workflow.inspector.recentActivity')}</span>
          <small>{projection.activity.length}</small>
        </summary>
        <div className={styles.activityList}>
          {(showAllActivity
            ? projection.activity
            : projection.activity.slice(0, 6)
          ).map((task) => {
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

            const unavailableReason = tool
              ? getSubagentDetailsUnavailableReason(tool)
              : undefined;

            return tool ? (
              <button
                key={task.id}
                aria-disabled={!!unavailableReason || undefined}
                title={unavailableReason ?? t('planExecution.openDetails')}
                onClick={() => handleOpenSubagent(tool)}
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

          {projection.activity.length > 6 && (
            <button
              type="button"
              className={styles.expandButton}
              onClick={() => setShowAllActivity(!showAllActivity)}
            >
              {t(
                showAllActivity
                  ? 'workflow.activity.showLess'
                  : 'workflow.activity.showAll',
                { count: projection.activity.length },
              )}
            </button>
          )}
        </div>
      </details>

      {/* Deliverables / Artifacts */}
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
              onClick={() => handleOpenArtifact(artifact.id)}
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
