import { useState, useMemo } from 'react';
import type { ACPToolCall } from '../../../adapters/types';
import { Markdown } from '../Markdown';
import {
  formatDurationMs,
  formatElapsed,
  StatusIcon,
  truncateText,
} from './toolDisplay';
import chromeStyles from './ToolChrome.module.css';
import styles from './SubAgentPanel.module.css';

interface SubAgentPanelProps {
  tool: ACPToolCall;
}

interface TaskExecution {
  type: 'task_execution';
  subagentName?: string;
  taskDescription?: string;
  taskPrompt?: string;
  status?: string;
  result?: string;
  toolCalls?: TaskToolCall[];
  executionSummary?: {
    totalToolCalls?: number;
    totalDurationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCost?: number;
  };
}

interface TaskToolCall {
  callId: string;
  name: string;
  status: string;
  args?: Record<string, unknown>;
  description?: string;
}

function isTaskExecution(raw: unknown): raw is TaskExecution {
  return (
    !!raw &&
    typeof raw === 'object' &&
    (raw as Record<string, unknown>).type === 'task_execution'
  );
}

function getToolSummary(tool: ACPToolCall): string {
  if (tool.title) {
    const colonIdx = tool.title.indexOf(': ');
    return colonIdx > 0 ? tool.title.slice(colonIdx + 2) : tool.title;
  }
  const args = tool.args || {};
  if (args.command) return args.command as string;
  if (args.file_path) return args.file_path as string;
  if (args.path) return args.path as string;
  if (args.query) return args.query as string;
  if (args.description) return args.description as string;
  return '';
}

function getToolOutput(tool: ACPToolCall): string {
  if (tool.status !== 'completed' && tool.status !== 'failed') return '';
  if (tool.content) {
    for (const b of tool.content) {
      if (b.type === 'content' && b.content?.text) {
        const text = b.content.text;
        const firstLine = text.split('\n')[0];
        if (firstLine.length > 80) return firstLine.slice(0, 80) + '...';
        return firstLine;
      }
    }
  }
  return '';
}

function SubToolLine({ tool }: { tool: ACPToolCall }) {
  if (tool.subTools || tool.subContent) return <SubAgentPanel tool={tool} />;

  const summary = getToolSummary(tool);
  const output = getToolOutput(tool);

  return (
    <div className={chromeStyles.line}>
      <div className={chromeStyles.lineMain}>
        <StatusIcon status={tool.status} />
        <span className={chromeStyles.lineName}>{tool.toolName}</span>
        {summary && (
          <span className={chromeStyles.lineArg}>
            {truncateText(summary, 70)}
          </span>
        )}
      </div>
      {output && <div className={chromeStyles.lineOutput}>{output}</div>}
    </div>
  );
}

function TaskToolCallLine({ tc }: { tc: TaskToolCall }) {
  const desc = tc.description || '';
  return (
    <div className={chromeStyles.line}>
      <div className={chromeStyles.lineMain}>
        <StatusIcon status={tc.status} />
        <span className={chromeStyles.lineName}>{tc.name}</span>
        {desc && (
          <span className={chromeStyles.lineArg}>{truncateText(desc, 70)}</span>
        )}
      </div>
    </div>
  );
}

function getAgentResultText(tool: ACPToolCall): string {
  if (tool.rawOutput && isTaskExecution(tool.rawOutput)) {
    if (tool.rawOutput.result) return tool.rawOutput.result;
  }
  if (tool.content) {
    for (const b of tool.content) {
      if (b.type === 'content' && b.content?.text) return b.content.text;
    }
  }
  if (tool.rawOutput) {
    if (typeof tool.rawOutput === 'string') return tool.rawOutput;
    const raw = tool.rawOutput as Record<string, unknown>;
    if (typeof raw.output === 'string') return raw.output;
    if (typeof raw.result === 'string') return raw.result;
    if (typeof raw.content === 'string') return raw.content;
    if (typeof raw.text === 'string') return raw.text;
  }
  return '';
}

function formatTokens(summary?: TaskExecution['executionSummary']): string {
  if (!summary?.totalTokens) return '';
  const t = summary.totalTokens;
  if (t >= 1000000) return `${(t / 1000000).toFixed(1)}M tokens`;
  if (t >= 1000) return `${Math.round(t / 1000)}k tokens`;
  return `${t} tokens`;
}

type SubAgentTab = 'result' | 'tools';

export function SubAgentPanel({ tool }: SubAgentPanelProps) {
  const isComplete = tool.status === 'completed' || tool.status === 'failed';
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<SubAgentTab>('result');

  const taskExec = isTaskExecution(tool.rawOutput) ? tool.rawOutput : null;

  const subToolCount =
    tool.subTools?.length || taskExec?.toolCalls?.length || 0;
  const description =
    taskExec?.taskDescription ||
    (tool.args?.description as string) ||
    (tool.args?.prompt as string) ||
    '';
  const agentType =
    taskExec?.subagentName ||
    (tool.args?.subagent_type as string) ||
    (tool.toolName === 'task' ? 'task' : 'general-purpose');
  const elapsed =
    formatElapsed(tool.startTime, tool.endTime) ||
    formatDurationMs(taskExec?.executionSummary?.totalDurationMs);
  const tokens = formatTokens(taskExec?.executionSummary);
  const resultText = isComplete ? getAgentResultText(tool) : '';

  const taskToolCalls = useMemo(() => {
    if (tool.subTools && tool.subTools.length > 0) return null;
    return taskExec?.toolCalls || null;
  }, [tool.subTools, taskExec]);

  const hasResult = !!(tool.subContent || resultText);
  const hasTools = !!(
    (tool.subTools && tool.subTools.length > 0) ||
    (taskToolCalls && taskToolCalls.length > 0)
  );
  const showTabs = hasResult && hasTools;

  return (
    <div className={styles.panel}>
      <div className={styles.header} onClick={() => setExpanded(!expanded)}>
        <StatusIcon status={tool.status} />
        <span className={chromeStyles.lineName}>{agentType}:</span>
        {description && (
          <span className={styles.desc}>{truncateText(description, 50)}</span>
        )}
        {isComplete && subToolCount > 0 && (
          <span className={styles.meta}>· {subToolCount} tools</span>
        )}
        {elapsed && <span className={styles.meta}>· {elapsed}</span>}
        {tokens && <span className={styles.meta}>· {tokens}</span>}
        {!isComplete && (
          <span className={styles.toggle}>{expanded ? '▼' : '▶'}</span>
        )}
      </div>

      {expanded && (
        <div className={styles.body}>
          {showTabs && (
            <div className={styles.tabBar}>
              <button
                className={`${styles.tab} ${activeTab === 'result' ? styles.tabActive : ''}`}
                onClick={() => setActiveTab('result')}
              >
                Result
              </button>
              <button
                className={`${styles.tab} ${activeTab === 'tools' ? styles.tabActive : ''}`}
                onClick={() => setActiveTab('tools')}
              >
                Tools ({subToolCount})
              </button>
            </div>
          )}

          {(!showTabs || activeTab === 'result') && hasResult && (
            <div className={styles.content}>
              {isComplete ? (
                <Markdown content={tool.subContent || resultText} />
              ) : (
                tool.subContent && (
                  <pre className={styles.stream}>{tool.subContent}</pre>
                )
              )}
            </div>
          )}

          {(!showTabs || activeTab === 'tools') && (
            <>
              {tool.subTools && tool.subTools.length > 0 && (
                <div className={styles.tools}>
                  {tool.subTools.map((sub) => (
                    <SubToolLine key={sub.callId} tool={sub} />
                  ))}
                </div>
              )}
              {taskToolCalls && taskToolCalls.length > 0 && (
                <div className={styles.tools}>
                  {taskToolCalls.map((tc) => (
                    <TaskToolCallLine key={tc.callId} tc={tc} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
