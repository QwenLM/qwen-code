import { useEffect, useMemo, useRef } from 'react';
import type { DaemonSessionTaskStatus } from '@qwen-code/sdk/daemon';
import { ArrowLeftIcon, GitBranchIcon } from 'lucide-react';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
import { useI18n } from '../../i18n';
import { PlanExecutionView } from '../messages/PlanExecutionView';
import {
  buildSessionWorkflowProjection,
  getDefaultWorkflowTodoId,
} from './session-workflow-model';
import styles from './SessionWorkflowCockpit.module.css';

interface SessionWorkflowCockpitProps {
  sessionId: string;
  connected: boolean;
  sessionName?: string;
  workspaceCwd?: string;
  todos: readonly TodoItem[];
  tools: readonly ACPToolCall[];
  tasks: readonly DaemonSessionTaskStatus[];
  selectedTodoId?: string;
  onSelectedTodoIdChange: (todoId: string | undefined) => void;
  onBackToChat: () => void;
  onOpenSubagent: (tool: ACPToolCall) => void;
}

export function SessionWorkflowCockpit({
  sessionId,
  connected,
  sessionName,
  workspaceCwd,
  todos,
  tools,
  tasks,
  selectedTodoId,
  onSelectedTodoIdChange,
  onBackToChat,
  onOpenSubagent,
}: SessionWorkflowCockpitProps) {
  const { t } = useI18n();
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const projection = useMemo(
    () => buildSessionWorkflowProjection(todos, tools, tasks),
    [tasks, todos, tools],
  );
  const defaultTodoId = getDefaultWorkflowTodoId(todos, projection);

  useEffect(() => {
    if (!projection.todosById.has(selectedTodoId ?? '')) {
      onSelectedTodoIdChange(defaultTodoId);
    }
  }, [
    defaultTodoId,
    onSelectedTodoIdChange,
    projection.todosById,
    selectedTodoId,
  ]);

  useEffect(() => {
    backButtonRef.current?.focus();
  }, []);

  if (todos.length === 0) {
    return (
      <div className={styles.emptyCockpit} data-testid="cockpit-empty">
        <GitBranchIcon aria-hidden="true" />
        <h1>{t('workflow.empty.title')}</h1>
        <p>{t('workflow.empty.copy')}</p>
        <button onClick={onBackToChat} ref={backButtonRef} type="button">
          {t('workflow.empty.action')}
        </button>
      </div>
    );
  }

  return (
    <div className={styles.cockpit} data-testid="session-workflow-cockpit">
      <header className={styles.header}>
        <div className={styles.identity}>
          <button
            className={styles.backButton}
            data-testid="workflow-back-to-chat"
            onClick={onBackToChat}
            ref={backButtonRef}
            type="button"
          >
            <ArrowLeftIcon aria-hidden="true" />
            {t('workflow.chatTitle')}
          </button>
          <div>
            <span>{t('workflow.inspector.graphCanvas')}</span>
            <h1 title={sessionName}>
              {sessionName || t('workflow.session.defaultTitle')}
            </h1>
            <small>
              {sessionId.slice(0, 8)} ·{' '}
              {workspaceCwd?.split('/').at(-1) ||
                t('workflow.session.workspace')}
            </small>
          </div>
        </div>
        <div className={styles.headerStatus}>
          <span data-status={projection.taskStatusTone}>
            {t(projection.taskStatusI18nKey)}
          </span>
          <span data-connected={connected || undefined}>
            <span className={styles.connectionDot} />
            {t(
              connected
                ? 'workflow.connection.connected'
                : 'workflow.connection.reconnecting',
            )}
          </span>
        </div>
      </header>
      <main className={styles.canvas}>
        <PlanExecutionView
          hideTitle
          todos={todos}
          tools={tools}
          tasks={tasks}
          onOpenSubagent={onOpenSubagent}
          selection={{
            value: selectedTodoId,
            onChange: onSelectedTodoIdChange,
          }}
          showStepDetails={false}
        />
      </main>
    </div>
  );
}
