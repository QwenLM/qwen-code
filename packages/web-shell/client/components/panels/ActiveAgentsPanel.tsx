import {
  forwardRef,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from 'react';
import type { ACPToolCall } from '../../adapters/types';
import { useI18n } from '../../i18n';
import { formatElapsed } from '../messages/tools/toolDisplay';
import styles from './ActiveAgentsPanel.module.css';

interface ActiveAgentsPanelProps {
  agents: ACPToolCall[];
  onFocusTaskPill?: () => boolean;
  onReturnToInput?: (text?: string) => void;
}

const MAX_VISIBLE = 10;

interface TaskExecution {
  type: 'task_execution';
  subagentName?: string;
  taskDescription?: string;
  taskPrompt?: string;
  executionSummary?: {
    totalToolCalls?: number;
    totalDurationMs?: number;
    totalTokens?: number;
  };
}

function isTaskExecution(raw: unknown): raw is TaskExecution {
  return (
    !!raw &&
    typeof raw === 'object' &&
    (raw as Record<string, unknown>).type === 'task_execution'
  );
}

function getAgentDescription(agent: ACPToolCall): string {
  if (isTaskExecution(agent.rawOutput) && agent.rawOutput.taskDescription) {
    return agent.rawOutput.taskDescription;
  }
  const description = agent.args?.description;
  if (typeof description === 'string' && description.trim()) {
    return description.trim();
  }
  if (agent.title) {
    const colonIdx = agent.title.indexOf(': ');
    return colonIdx > 0 ? agent.title.slice(colonIdx + 2) : agent.title;
  }
  const prompt = agent.args?.prompt;
  if (typeof prompt === 'string' && prompt.trim()) {
    return prompt.trim().split('\n')[0] ?? '';
  }
  return agent.toolName;
}

function getAgentType(agent: ACPToolCall): string {
  if (isTaskExecution(agent.rawOutput) && agent.rawOutput.subagentName) {
    return agent.rawOutput.subagentName;
  }
  const subagentType = agent.args?.subagent_type;
  if (typeof subagentType === 'string' && subagentType.trim()) {
    return subagentType.trim();
  }
  return agent.toolName === 'task' ? 'task' : 'general-purpose';
}

function getAgentPrompt(agent: ACPToolCall): string {
  if (isTaskExecution(agent.rawOutput) && agent.rawOutput.taskPrompt) {
    return agent.rawOutput.taskPrompt;
  }
  const prompt = agent.args?.prompt;
  return typeof prompt === 'string' ? prompt : '';
}

function getToolCount(agent: ACPToolCall): number {
  if (agent.subTools?.length) return agent.subTools.length;
  if (isTaskExecution(agent.rawOutput)) {
    return agent.rawOutput.executionSummary?.totalToolCalls ?? 0;
  }
  return 0;
}

function formatTokens(tokens?: number): string {
  if (!tokens || tokens <= 0) return '';
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M tokens`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k tokens`;
  return `${tokens} tokens`;
}

function getTokenText(agent: ACPToolCall): string {
  if (!isTaskExecution(agent.rawOutput)) return '';
  return formatTokens(agent.rawOutput.executionSummary?.totalTokens);
}

function getAgentStatusIcon(status: ACPToolCall['status']): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'failed':
      return '✗';
    case 'in_progress':
      return '▮';
    case 'pending':
      return '○';
  }
}

export const ActiveAgentsPanel = forwardRef<
  HTMLDivElement,
  ActiveAgentsPanelProps
>(function ActiveAgentsPanel(
  { agents, onFocusTaskPill, onReturnToInput },
  ref,
) {
  const { t } = useI18n();
  const [, setTick] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(() =>
    Math.max(0, agents.length - 1),
  );

  useEffect(() => {
    if (agents.length === 0) return undefined;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [agents.length]);

  useEffect(() => {
    setSelectedIndex((index) =>
      Math.min(Math.max(0, index), Math.max(0, agents.length - 1)),
    );
  }, [agents.length]);

  const visibleAgents = useMemo(
    () => agents.slice(Math.max(0, agents.length - MAX_VISIBLE)),
    [agents],
  );
  const hiddenCount = Math.max(0, agents.length - visibleAgents.length);
  const selectedAgent = agents[selectedIndex] ?? agents.at(-1);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (agents.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      if (selectedIndex >= agents.length - 1 && onFocusTaskPill?.()) {
        return;
      }
      setSelectedIndex((index) => Math.min(index + 1, agents.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      if (selectedIndex > 0) {
        setSelectedIndex((index) => Math.max(index - 1, 0));
      } else {
        onReturnToInput?.();
      }
    } else if (event.key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      setSelectedIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      setSelectedIndex(agents.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      setExpanded((value) => !value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (expanded) {
        setExpanded(false);
      } else {
        onReturnToInput?.();
      }
    } else if (
      event.key.length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      onReturnToInput?.(event.key);
    }
  };

  if (agents.length === 0) return null;

  return (
    <div
      className={styles.panel}
      role="group"
      tabIndex={0}
      ref={ref}
      data-keyboard-scope="active-agents"
      onKeyDown={handleKeyDown}
    >
      <div
        className={styles.header}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={styles.title}>
          {t('activeAgents.title', {
            visible: visibleAgents.length,
            total: agents.length,
          })}
        </span>
        <span className={styles.hint}>
          {expanded
            ? t('activeAgents.collapseHint')
            : t('activeAgents.openHint')}
        </span>
      </div>
      <div className={styles.list}>
        {hiddenCount > 0 && (
          <div className={styles.more}>
            {t('activeAgents.moreAbove', { count: hiddenCount })}
          </div>
        )}
        {visibleAgents.map((agent) => (
          <div
            key={agent.callId}
            className={`${styles.item} ${
              agent.callId === selectedAgent?.callId ? styles.selected : ''
            }`}
            onClick={() => {
              setSelectedIndex(
                agents.findIndex((a) => a.callId === agent.callId),
              );
              setExpanded(true);
            }}
          >
            <span className={styles.icon}>
              {getAgentStatusIcon(agent.status)}
            </span>
            <span className={styles.name}>{getAgentDescription(agent)}</span>
            <span className={styles.chevron}>▶</span>
            {formatElapsed(agent.startTime) && (
              <span className={styles.elapsed}>
                {formatElapsed(agent.startTime)}
              </span>
            )}
          </div>
        ))}
      </div>
      {expanded && selectedAgent && (
        <div className={styles.detail}>
          <div className={styles.detailTitle}>
            <span className={styles.detailType}>
              {getAgentType(selectedAgent)}
            </span>
            <span className={styles.detailDescription}>
              {getAgentDescription(selectedAgent)}
            </span>
          </div>
          <div className={styles.detailMeta}>
            <span>{selectedAgent.status}</span>
            {formatElapsed(selectedAgent.startTime) && (
              <span>{formatElapsed(selectedAgent.startTime)}</span>
            )}
            {getToolCount(selectedAgent) > 0 && (
              <span>
                {t('activeAgents.tools', {
                  count: getToolCount(selectedAgent),
                })}
              </span>
            )}
            {getTokenText(selectedAgent) && (
              <span>{getTokenText(selectedAgent)}</span>
            )}
          </div>
          {getAgentPrompt(selectedAgent) && (
            <pre className={styles.prompt}>{getAgentPrompt(selectedAgent)}</pre>
          )}
          <div className={styles.footer}>{t('activeAgents.footer')}</div>
        </div>
      )}
    </div>
  );
});
