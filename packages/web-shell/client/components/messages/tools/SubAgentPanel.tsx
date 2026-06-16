import {
  memo,
  useEffect,
  useRef,
  useState,
  useMemo,
  type ReactNode,
} from 'react';
import type { ACPToolCall } from '../../../adapters/types';
import { useWebShellCustomization } from '../../../customization';
// Circular import with ToolGroup (agents render tool rows; agent tool
// rows render SubAgentPanel). Safe only while both modules dereference
// each other's exports at render time — never in top-level code.
import { ToolLine } from '../ToolGroup';
import { Markdown } from '../Markdown';
import { formatTimestamp } from '../../MessageTimestamp';
import {
  formatDurationMs,
  formatElapsed,
  StatusIcon,
  truncateText,
} from './toolDisplay';
import {
  getAgentDisplayStatus,
  formatTokenCount,
  getAgentType,
  getAgentDescription,
} from '../toolFormatting';
import chromeStyles from './ToolChrome.module.css';
import styles from './SubAgentPanel.module.css';

interface SubAgentPanelProps {
  tool: ACPToolCall;
  defaultExpanded?: boolean;
  hideHeader?: boolean;
  inline?: boolean;
}

interface TaskExecution {
  type: 'task_execution';
  subagentName?: string;
  taskDescription?: string;
  taskPrompt?: string;
  status?: string;
  result?: string;
  tokenCount?: number;
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

/**
 * Reveals a single sub-tool's wall-clock start time on hover in its top-right
 * corner, mirroring how the main transcript surfaces each message's time —
 * but via a scoped class pair (not MessageTimestamp) so the nested tooltip
 * stays independent of the enclosing message's own time tooltip.
 */
function SubToolTime({
  timestamp,
  children,
}: {
  timestamp?: number;
  children: ReactNode;
}) {
  if (timestamp === undefined) return <>{children}</>;
  return (
    <div className={styles.toolTimeRow}>
      {children}
      <span className={styles.toolTimeTip} aria-hidden="true">
        {formatTimestamp(timestamp)}
      </span>
    </div>
  );
}

const SubToolLine = memo(function SubToolLine({ tool }: { tool: ACPToolCall }) {
  // Same row as the main transcript: one-line summary, expandable to
  // the full output / diff / file content where the tool has any.
  const body =
    tool.subTools || tool.subContent ? (
      <SubAgentPanel tool={tool} />
    ) : (
      <ToolLine tool={tool} />
    );
  return <SubToolTime timestamp={tool.startTime}>{body}</SubToolTime>;
});

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
    if (typeof raw.reason === 'string') return raw.reason;
    if (
      typeof raw.terminateReason === 'string' &&
      raw.terminateReason !== 'GOAL'
    ) {
      return raw.terminateReason;
    }
    if (typeof raw.error === 'string') return raw.error;
    if (typeof raw.text === 'string') return raw.text;
  }
  return '';
}

type SubAgentTab = 'result' | 'tools';

/**
 * Live sub-agent stream (thinking + output) shown while the agent runs.
 * With compactThinking enabled it collapses to a 5-line window pinned to
 * the newest content, with a toggle to the full scrollable view.
 */
function SubAgentStream({ text }: { text: string }) {
  const { compactThinking } = useWebShellCustomization();
  const [streamExpanded, setStreamExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const streamRef = useRef<HTMLPreElement>(null);

  const collapsed = compactThinking && !streamExpanded;

  useEffect(() => {
    const el = streamRef.current;
    if (!el || !collapsed) return;
    setOverflowing(el.scrollHeight > el.clientHeight);
    // Pin the newest line into view while the stream grows.
    el.scrollTop = el.scrollHeight;
  }, [collapsed, text]);

  useEffect(() => {
    const el = streamRef.current;
    if (!el || !collapsed) return;
    const check = () => setOverflowing(el.scrollHeight > el.clientHeight);
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [collapsed]);

  return (
    <div>
      <pre
        ref={streamRef}
        className={
          collapsed
            ? `${styles.stream} ${styles.streamCollapsed}`
            : styles.stream
        }
      >
        {text}
      </pre>
      {compactThinking && (overflowing || streamExpanded) && (
        <button
          className={styles.expandToggle}
          onClick={() => setStreamExpanded((v) => !v)}
          aria-expanded={streamExpanded}
          aria-label="Toggle agent stream details"
        >
          {streamExpanded ? '▲' : '▼'}
        </button>
      )}
    </div>
  );
}

/**
 * Final agent result. The result is only on screen after the user
 * explicitly opened the enclosing agent (tool row, accordion entry or
 * panel header), so it renders in full straight away — capped to the
 * same scrollable window as the live stream with compactThinking
 * enabled, which keeps the opener within reach to collapse it again.
 */
function SubAgentResult({ content }: { content: string }) {
  const { compactThinking } = useWebShellCustomization();
  return (
    <div className={compactThinking ? styles.scrollWindow : undefined}>
      <Markdown content={content} />
    </div>
  );
}

/**
 * Sub-tool list, capped to the same scrollable window as the result
 * with compactThinking enabled. While the agent is still running the
 * window follows the newest call; once it completes it snaps back to
 * the top for reading.
 */
function SubAgentTools({
  pinTail,
  itemCount,
  children,
}: {
  pinTail: boolean;
  itemCount: number;
  children: ReactNode;
}) {
  const { compactThinking } = useWebShellCustomization();
  const windowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = windowRef.current;
    if (!el || !compactThinking) return;
    el.scrollTop = pinTail ? el.scrollHeight : 0;
  }, [compactThinking, pinTail, itemCount]);

  return (
    <div
      ref={windowRef}
      className={
        compactThinking
          ? `${styles.tools} ${styles.scrollWindow}`
          : styles.tools
      }
    >
      {children}
    </div>
  );
}

export function SubAgentPanel({
  tool,
  defaultExpanded,
  hideHeader,
  inline,
}: SubAgentPanelProps) {
  const isComplete = tool.status === 'completed' || tool.status === 'failed';
  const displayStatus = getAgentDisplayStatus(tool);
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const [activeTab, setActiveTab] = useState<SubAgentTab>('result');

  const taskExec = isTaskExecution(tool.rawOutput) ? tool.rawOutput : null;

  const subToolCount =
    tool.subTools?.length || taskExec?.toolCalls?.length || 0;
  const description = getAgentDescription(tool);
  const agentType = getAgentType(tool);
  const elapsed =
    formatElapsed(tool.startTime, tool.endTime) ||
    formatDurationMs(taskExec?.executionSummary?.totalDurationMs);
  const tokenCount =
    taskExec?.tokenCount && taskExec.tokenCount > 0
      ? taskExec.tokenCount
      : taskExec?.executionSummary?.totalTokens;
  const tokens = tokenCount ? formatTokenCount(tokenCount) : '';
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
    <div className={inline ? undefined : styles.panel}>
      {!hideHeader && (
        <div className={styles.header} onClick={() => setExpanded(!expanded)}>
          <StatusIcon status={displayStatus} />
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
      )}

      {(expanded || hideHeader) && (
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
                <SubAgentResult content={tool.subContent || resultText} />
              ) : (
                tool.subContent && <SubAgentStream text={tool.subContent} />
              )}
            </div>
          )}

          {(!showTabs || activeTab === 'tools') && (
            <>
              {tool.subTools && tool.subTools.length > 0 && (
                <SubAgentTools
                  pinTail={!isComplete}
                  itemCount={tool.subTools.length}
                >
                  {tool.subTools.map((sub) => (
                    <SubToolLine key={sub.callId} tool={sub} />
                  ))}
                </SubAgentTools>
              )}
              {taskToolCalls && taskToolCalls.length > 0 && (
                <SubAgentTools
                  pinTail={!isComplete}
                  itemCount={taskToolCalls.length}
                >
                  {taskToolCalls.map((tc) => (
                    <TaskToolCallLine key={tc.callId} tc={tc} />
                  ))}
                </SubAgentTools>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
