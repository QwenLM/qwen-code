import { useRef, useState, type SyntheticEvent } from 'react';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
import { useI18n } from '../../i18n';
import { usePlanExecutionHistory } from '../../planExecutionHistoryContext';
import { useSubagentDetails } from '../../subagentDetailsContext';
import { PlanExecutionView } from './PlanExecutionView';
import styles from './HistoricalPlanExecution.module.css';

export function HistoricalPlanExecution({
  todos,
  sourceMessageId,
  sourceTool,
}: {
  todos: readonly TodoItem[];
  sourceMessageId?: string;
  sourceTool?: ACPToolCall;
}) {
  const { t } = useI18n();
  const history = usePlanExecutionHistory();
  const subagentDetails = useSubagentDetails();
  const [agentTools, setAgentTools] = useState<ACPToolCall[]>();
  const [historyIncomplete, setHistoryIncomplete] = useState(false);
  const resolutionRequest = useRef(0);

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open) {
      resolutionRequest.current += 1;
      return;
    }
    const source = {
      messageId: sourceMessageId,
      toolCallId: sourceTool?.callId,
    };
    setHistoryIncomplete(false);
    const tools = history.resolveLoaded(source);
    setAgentTools(tools);
    const request = ++resolutionRequest.current;
    void history
      .resolveComplete(source)
      .then(async (completeTools) => {
        if (resolutionRequest.current !== request) return;
        const resolveTree = subagentDetails?.resolveTree;
        if (!resolveTree || completeTools.length === 0) {
          setAgentTools(completeTools);
          return;
        }
        const results = await Promise.allSettled(
          completeTools.map((tool) => resolveTree(tool)),
        );
        if (resolutionRequest.current !== request) return;
        setAgentTools(
          results.map((result, index) =>
            result.status === 'fulfilled' ? result.value : completeTools[index],
          ),
        );
      })
      .catch(() => {
        if (resolutionRequest.current === request) {
          setHistoryIncomplete(true);
        }
      });
  };

  return (
    <details className={styles.details} onToggle={handleToggle}>
      <summary className={styles.summary}>{t('planExecution.view')}</summary>
      {agentTools && (
        <div className={styles.content}>
          {historyIncomplete && (
            <div className={styles.historyNotice} role="status">
              {t('planExecution.historyIncomplete')}
            </div>
          )}
          <PlanExecutionView
            todos={todos}
            tools={agentTools}
            tasks={[]}
            onOpenSubagent={subagentDetails?.onOpen}
          />
        </div>
      )}
    </details>
  );
}
