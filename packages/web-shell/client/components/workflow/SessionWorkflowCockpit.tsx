import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

export interface SessionWorkflowCockpitProps {
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
  isDetailPanelVisible?: boolean;
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
  isDetailPanelVisible = true,
}: SessionWorkflowCockpitProps): React.JSX.Element {
  const { t } = useI18n();
  const backButtonRef = useRef<HTMLButtonElement>(null);

  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 768px)');
    const handleChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    setIsNarrow(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

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

  const showInlineStepDetails = !isDetailPanelVisible;

  const handleSelectedTodoChange = useCallback(
    (todoId: string | undefined) => {
      onSelectedTodoIdChange(todoId);
    },
    [onSelectedTodoIdChange],
  );

  const handleBackToChat = useCallback(() => {
    onBackToChat();
  }, [onBackToChat]);

  const handleOpenSubagent = useCallback(
    (tool: ACPToolCall) => {
      onOpenSubagent(tool);
    },
    [onOpenSubagent],
  );

  useEffect(() => {
    if (effectiveSelectedTodoId !== selectedTodoId) {
      onSelectedTodoIdChange(effectiveSelectedTodoId);
    }
  }, [effectiveSelectedTodoId, selectedTodoId, onSelectedTodoIdChange]);

  useEffect(() => {
    backButtonRef.current?.focus();
  }, []);

  if (todos.length === 0) {
    return (
      <div className={styles.emptyCockpit} data-testid="cockpit-empty">
        <GitBranchIcon aria-hidden="true" />
        <h1>{t('workflow.empty.title')}</h1>
        <p>{t('workflow.empty.copy')}</p>
        <button onClick={handleBackToChat} ref={backButtonRef} type="button">
          {t('workflow.empty.action')}
        </button>
      </div>
    );
  }

  const workspaceDisplayName =
    workspaceCwd?.split('/').at(-1) || t('workflow.session.workspace');

  return (
    <div className={styles.cockpit} data-testid="session-workflow-cockpit">
      <header className={styles.header}>
        <div className={styles.identity}>
          <button
            className={styles.backButton}
            data-testid="workflow-back-to-chat"
            onClick={handleBackToChat}
            ref={backButtonRef}
            type="button"
            aria-label={t('workflow.chatTitle')}
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
              {sessionId.slice(0, 8)} · {workspaceDisplayName}
            </small>
          </div>
        </div>
        <div className={styles.headerStatus} role="status" aria-live="polite">
          <span data-status={projection.taskStatusTone}>
            {t(projection.taskStatusI18nKey)}
          </span>
          <span data-connected={connected || undefined}>
            <span className={styles.connectionDot} aria-hidden="true" />
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
          onOpenSubagent={handleOpenSubagent}
          selection={{
            value: effectiveSelectedTodoId,
            onChange: handleSelectedTodoChange,
          }}
          showStepDetails={showInlineStepDetails}
          forceFlatLayout={isNarrow}
        />
      </main>
    </div>
  );
}
