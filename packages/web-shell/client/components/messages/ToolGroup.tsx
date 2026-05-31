import { memo, useContext, useEffect, useState } from 'react';
import type {
  ACPToolCall,
  PermissionRequest,
  TodoItem,
} from '../../adapters/types';
import { isSubAgentToolCall } from '../../adapters/toolClassification';
import { SubAgentPanel } from './tools/SubAgentPanel';
import { DiffView } from './tools/DiffView';
import { ToolApproval } from './ToolApproval';
import { parseAnsi, hasAnsi } from '../../utils/ansi';
import { extractTodosFromToolCall } from '../../utils/todos';
import {
  formatDurationMs,
  formatElapsed,
  formatToolDisplayName,
  StatusIcon,
  truncateText,
} from './tools/toolDisplay';
import {
  extractText,
  getToolDescription,
  getToolResultSummary,
  isShellToolName,
} from './toolFormatting';
import { useI18n } from '../../i18n';
import { CompactModeContext } from '../../App';
import styles from './tools/ToolChrome.module.css';

interface ToolGroupProps {
  tools: ACPToolCall[];
  pendingApproval?: PermissionRequest | null;
  onConfirm?: (
    id: string,
    selectedOption: string,
    answers?: Record<string, string>,
  ) => void;
  workspaceCwd?: string;
}

function hasExpandableContent(tool: ACPToolCall): boolean {
  const name = tool.toolName.toLowerCase();
  // write_file shows content from args even before completion
  if (name === 'write_file' || name === 'writefile') {
    return !!getWriteContent(tool);
  }
  if (tool.status !== 'completed' && tool.status !== 'failed') return false;
  if (isShellToolName(name)) {
    const text = extractText(tool);
    return !!text && text.split('\n').length > 1;
  }
  if (name === 'edit' || name === 'write' || name === 'editfile') {
    return hasDiffContent(tool);
  }
  if (name === 'read' || name === 'read_file' || name === 'readfile') {
    const text = extractText(tool);
    return !!text && text.split('\n').length > 3;
  }
  return false;
}

function hasDiffContent(tool: ACPToolCall): boolean {
  if (tool.content?.some((b) => b.type === 'diff')) return true;
  if (tool.rawOutput && typeof tool.rawOutput === 'object') {
    const raw = tool.rawOutput as Record<string, unknown>;
    if (typeof raw.fileDiff === 'string' && raw.fileDiff) return true;
  }
  return false;
}

function extractDiff(tool: ACPToolCall): string {
  if (tool.content) {
    const diffBlock = tool.content.find((b) => b.type === 'diff');
    if (diffBlock && diffBlock.type === 'diff') {
      return buildUnifiedDiff(diffBlock.oldText || '', diffBlock.newText || '');
    }
  }
  if (tool.rawOutput && typeof tool.rawOutput === 'object') {
    const raw = tool.rawOutput as Record<string, unknown>;
    if (typeof raw.fileDiff === 'string') return raw.fileDiff;
  }
  return '';
}

const MAX_DIFF_PRODUCT = 250_000;

function buildUnifiedDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const n = oldLines.length;
  const m = newLines.length;

  if (n * m > MAX_DIFF_PRODUCT) {
    const removed = oldLines.map((l) => (l ? `-${l}` : '-'));
    const added = newLines.map((l) => (l ? `+${l}` : '+'));
    return [...removed, ...added].join('\n');
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const result: string[] = [];
  let i = n,
    j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push(` ${oldLines[i - 1]}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push(`+${newLines[j - 1]}`);
      j--;
    } else {
      result.push(`-${oldLines[i - 1]}`);
      i--;
    }
  }

  return result.reverse().join('\n');
}

const MAX_BASH_LINES = 5;
const MAX_READ_LINES = 25;

function ExpandedBashOutput({ tool }: { tool: ACPToolCall }) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const output = extractText(tool) || '';
  const lines = output.split('\n');
  const isUserShell = tool.toolName === 'shell';
  const isLong = lines.length > MAX_BASH_LINES;
  const hiddenLinesCount = Math.max(0, lines.length - MAX_BASH_LINES);
  const displayText =
    isLong && !showAll
      ? [
          `... first ${hiddenLinesCount} lines hidden ...`,
          ...lines.slice(-MAX_BASH_LINES),
        ].join('\n')
      : output;

  return (
    <div className={styles.expandedBash}>
      <pre className={styles.expandedOutput}>
        {hasAnsi(displayText)
          ? parseAnsi(displayText).map((seg, i) => (
              <span
                key={i}
                style={{
                  color: seg.color,
                  fontWeight: seg.bold ? 'bold' : undefined,
                  opacity: seg.dim ? 0.6 : undefined,
                }}
              >
                {seg.text}
              </span>
            ))
          : displayText}
      </pre>
      {isLong && isUserShell && (
        <button
          className={styles.expandBtn}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll
            ? t('tool.showLess')
            : t('tool.linesTotal', { count: lines.length })}
        </button>
      )}
    </div>
  );
}

function ExpandedReadContent({ tool }: { tool: ACPToolCall }) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const content = extractText(tool) || '';
  const lines = content.split('\n');
  const isLong = lines.length > MAX_READ_LINES;
  const displayText =
    isLong && !showAll ? lines.slice(0, MAX_READ_LINES).join('\n') : content;

  return (
    <div className={styles.expandedRead}>
      <pre className={styles.expandedOutput}>{displayText}</pre>
      {isLong && (
        <button
          className={styles.expandBtn}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll
            ? t('tool.showLess')
            : t('tool.linesTotal', { count: lines.length })}
        </button>
      )}
    </div>
  );
}

function ExpandedEditDiff({ tool }: { tool: ACPToolCall }) {
  const diff = extractDiff(tool);
  if (!diff) return null;
  return (
    <div className={styles.expandedEdit}>
      <DiffView diff={diff} />
    </div>
  );
}

const MAX_WRITE_LINES = 30;

function getWriteContent(tool: ACPToolCall): string {
  if (tool.args?.content) return tool.args.content as string;
  if (tool.args?.new_string) return tool.args.new_string as string;
  const text = extractText(tool);
  if (text) return text;
  if (tool.rawOutput && typeof tool.rawOutput === 'object') {
    const raw = tool.rawOutput as Record<string, unknown>;
    if (typeof raw.content === 'string') return raw.content;
    if (typeof raw.newContent === 'string') return raw.newContent;
  }
  return '';
}

function ExpandedWriteContent({ tool }: { tool: ACPToolCall }) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const content = getWriteContent(tool);
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const isLong = lines.length > MAX_WRITE_LINES;
  const displayLines =
    isLong && !showAll ? lines.slice(0, MAX_WRITE_LINES) : lines;

  if (!content) return null;

  return (
    <div className={styles.expandedWrite}>
      <pre className={styles.expandedOutput}>
        {displayLines.map((line, i) => (
          <span key={i} className={styles.writeAdd}>{`+ ${line}\n`}</span>
        ))}
      </pre>
      {isLong && (
        <button
          className={styles.expandBtn}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll
            ? t('tool.showLess')
            : t('tool.linesTotal', { count: lines.length })}
        </button>
      )}
    </div>
  );
}

function TodoWriteContent({ tool }: { tool: ACPToolCall }) {
  const todos = extractTodosFromToolCall(tool);
  if (todos) {
    return (
      <div className={styles.todoList}>
        {todos.map((todo, i) => (
          <div
            key={todo.id || i}
            className={`${styles.todoItem} ${getTodoClass(todo.status)}`}
          >
            {getTodoIcon(todo.status)} {todo.content}
          </div>
        ))}
      </div>
    );
  }

  const text = extractText(tool) || '';
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return null;

  return (
    <div className={styles.todoList}>
      {lines.map((line, i) => {
        const isCompleted = line.startsWith('●');
        const isInProgress = line.startsWith('◐');
        const cls = isCompleted
          ? styles.todoDone
          : isInProgress
            ? styles.todoActive
            : styles.todoPending;
        return (
          <div key={i} className={`${styles.todoItem} ${cls}`}>
            {line}
          </div>
        );
      })}
    </div>
  );
}

function getTodoClass(status: TodoItem['status']): string {
  switch (status) {
    case 'completed':
      return styles.todoDone;
    case 'in_progress':
      return styles.todoActive;
    case 'pending':
      return styles.todoPending;
  }
}

function getTodoIcon(status: TodoItem['status']): string {
  switch (status) {
    case 'completed':
      return '●';
    case 'in_progress':
      return '◐';
    case 'pending':
      return '○';
  }
}

interface ToolLineProps {
  tool: ACPToolCall;
  approval?: PermissionRequest | null;
  onConfirm?: (id: string, selectedOption: string) => void;
  workspaceCwd?: string;
}

function isTaskExecutionRaw(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  return record['type'] === 'task_execution' ? record : undefined;
}

function getStringField(
  record: Record<string, unknown> | undefined,
  field: string,
): string {
  const value = record?.[field];
  return typeof value === 'string' ? value : '';
}

function getAgentCancellationReason(tool: ACPToolCall): string {
  const raw = tool.rawOutput;
  if (typeof raw === 'string') return '';
  const record =
    raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : undefined;
  const terminateReason = getStringField(record, 'terminateReason');
  return (
    getStringField(record, 'reason') ||
    (terminateReason !== 'GOAL' ? terminateReason : '') ||
    getStringField(record, 'error')
  );
}

function isCancelledAgent(tool: ACPToolCall, reason: string): boolean {
  const raw = tool.rawOutput;
  const record =
    raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : undefined;
  const rawStatus = getStringField(record, 'status').toLowerCase();
  return (
    tool.status === 'failed' ||
    rawStatus === 'cancelled' ||
    rawStatus === 'canceled' ||
    reason.toLowerCase().includes('cancel')
  );
}

function getAgentDisplayInfo(tool: ACPToolCall): {
  agentType: string;
  description: string;
  subToolCount: number;
  elapsed: string;
  tokens: string;
  status: ACPToolCall['status'];
  reason: string;
} {
  const taskExec = isTaskExecutionRaw(tool.rawOutput);
  const reason = getAgentCancellationReason(tool);
  const status = isCancelledAgent(tool, reason) ? 'failed' : tool.status;

  const agentType =
    (taskExec &&
      typeof taskExec['subagentName'] === 'string' &&
      taskExec['subagentName']) ||
    (typeof tool.args?.subagent_type === 'string' && tool.args.subagent_type) ||
    (tool.toolName === 'task' ? 'task' : 'general-purpose');

  let description = '';
  if (tool.title) {
    const colonIdx = tool.title.indexOf(': ');
    if (colonIdx > 0) description = tool.title.slice(colonIdx + 2);
  }
  if (!description) {
    const desc = tool.args?.description;
    if (typeof desc === 'string' && desc.trim()) description = desc.trim();
  }
  if (!description && taskExec) {
    const td = taskExec['taskDescription'];
    if (typeof td === 'string' && td.trim()) description = td.trim();
  }

  const subToolCount =
    tool.subTools?.length ||
    (taskExec?.['toolCalls'] as unknown[] | undefined)?.length ||
    0;

  const stats = taskExec?.['executionSummary'] as
    | Record<string, unknown>
    | undefined;
  const elapsed =
    stats && typeof stats['totalDurationMs'] === 'number'
      ? formatDurationMs(stats['totalDurationMs'])
      : formatElapsed(tool.startTime, tool.endTime);

  const totalTokens =
    taskExec &&
    typeof taskExec['tokenCount'] === 'number' &&
    taskExec['tokenCount'] > 0
      ? (taskExec['tokenCount'] as number)
      : stats &&
          typeof stats['totalTokens'] === 'number' &&
          stats['totalTokens'] > 0
        ? (stats['totalTokens'] as number)
        : 0;
  let tokens = '';
  if (totalTokens > 0) {
    if (totalTokens >= 1000)
      tokens = (totalTokens / 1000).toFixed(1).replace(/\.0$/, '') + 'k tokens';
    else tokens = `${totalTokens} tokens`;
  }

  return {
    agentType,
    description,
    subToolCount,
    elapsed,
    tokens,
    status,
    reason,
  };
}

function toolHasApprovalInSubTools(
  tool: ACPToolCall,
  toolCallId: string,
): boolean {
  if (!tool.subTools) return false;
  return tool.subTools.some(
    (sub) =>
      sub.callId === toolCallId || toolHasApprovalInSubTools(sub, toolCallId),
  );
}

function shouldAutoExpand(tool: ACPToolCall): boolean {
  const name = tool.toolName.toLowerCase();
  if (name === 'write_file' || name === 'writefile') return true;
  if (name === 'edit' || name === 'editfile') return true;
  if (isShellToolName(name)) return true;
  return false;
}

function getActiveTool(tools: ACPToolCall[]): ACPToolCall {
  return (
    tools.find((t) => t.status === 'in_progress') ?? tools[tools.length - 1]
  );
}

function getCompactDisplayStatus(tool: ACPToolCall): ACPToolCall['status'] {
  if (tool.status !== 'completed') return tool.status;
  const raw = tool.rawOutput;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return tool.status;
  const record = raw as Record<string, unknown>;
  const rawStatus =
    typeof record.status === 'string' ? record.status.toLowerCase() : '';
  if (rawStatus === 'cancelled' || rawStatus === 'canceled') return 'failed';
  return tool.status;
}

function CompactToolGroup({
  tools,
  workspaceCwd,
}: {
  tools: ACPToolCall[];
  workspaceCwd?: string;
}) {
  const { t } = useI18n();
  const activeTool = getActiveTool(tools);
  const overallStatus = getCompactDisplayStatus(activeTool);
  const description = getToolDescription(activeTool, workspaceCwd);
  const elapsed = isShellToolName(activeTool.toolName)
    ? ''
    : formatElapsed(activeTool.startTime, activeTool.endTime);

  return (
    <div className={styles.compactGroup}>
      <div className={styles.compactHeader}>
        <StatusIcon status={overallStatus} />
        <span className={styles.lineName}>
          {formatToolDisplayName(activeTool.toolName)}
        </span>
        {tools.length > 1 && (
          <span className={styles.compactCount}>
            {'× '}
            {tools.length}
          </span>
        )}
        {description && <span className={styles.lineArg}>{description}</span>}
        {elapsed && <span className={styles.lineElapsed}>{elapsed}</span>}
      </div>
      <div className={styles.compactHint}>{t('compact.hint')}</div>
    </div>
  );
}

function areToolLinePropsEqual(
  prev: ToolLineProps,
  next: ToolLineProps,
): boolean {
  if (prev.approval?.id !== next.approval?.id) return false;
  if (prev.onConfirm !== next.onConfirm) return false;
  if (prev.workspaceCwd !== next.workspaceCwd) return false;
  const a = prev.tool;
  const b = next.tool;
  return (
    a.callId === b.callId &&
    a.toolName === b.toolName &&
    a.status === b.status &&
    a.startTime === b.startTime &&
    a.endTime === b.endTime &&
    a.subContent === b.subContent &&
    a.rawOutput === b.rawOutput &&
    a.title === b.title &&
    areSubToolsEqual(a.subTools, b.subTools)
  );
}

function areSubToolsEqual(
  prev: ACPToolCall[] | undefined,
  next: ACPToolCall[] | undefined,
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (
      a.callId !== b.callId ||
      a.status !== b.status ||
      a.endTime !== b.endTime ||
      a.rawOutput !== b.rawOutput
    ) {
      return false;
    }
  }
  return true;
}

const ToolLine = memo(function ToolLine({
  tool,
  approval,
  onConfirm,
  workspaceCwd,
}: ToolLineProps) {
  const compactMode = useContext(CompactModeContext);
  const [expanded, setExpanded] = useState(
    () => !compactMode && shouldAutoExpand(tool),
  );

  useEffect(
    () => {
      setExpanded(compactMode ? false : shouldAutoExpand(tool));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compactMode, tool.callId, tool.toolName],
  );
  const hasApproval = approval && approval.toolCallId === tool.callId;
  const hasSubToolApproval =
    !hasApproval &&
    approval?.toolCallId &&
    isSubAgentToolCall(tool) &&
    toolHasApprovalInSubTools(tool, approval.toolCallId);

  if (isSubAgentToolCall(tool)) {
    const info = getAgentDisplayInfo(tool);
    const isComplete = tool.status === 'completed' || tool.status === 'failed';
    const showExpanded = expanded || !!hasSubToolApproval;
    return (
      <div className={styles.line}>
        <div className={styles.lineMain}>
          <StatusIcon status={tool.status} />
          <span className={styles.lineName}>Agent</span>
          {info.description && (
            <span className={styles.lineArg}>
              {truncateText(info.description, 60)}
            </span>
          )}
        </div>
        {isComplete && (
          <div
            className={`${styles.agentSummary} ${styles.lineExpandable}`}
            onClick={() => setExpanded(!expanded)}
          >
            <StatusIcon status={info.status} />
            <span className={styles.lineName}>{info.agentType}:</span>
            <span className={styles.lineArg}>
              {truncateText(info.description, 50)}
            </span>
            {info.subToolCount > 0 && (
              <span className={styles.lineElapsed}>
                · {info.subToolCount} tools
              </span>
            )}
            {info.elapsed && (
              <span className={styles.lineElapsed}>· {info.elapsed}</span>
            )}
            {info.tokens && (
              <span className={styles.lineElapsed}>· {info.tokens}</span>
            )}
            {info.reason && (
              <span className={styles.lineElapsed}>
                · {truncateText(info.reason, 80)}
              </span>
            )}
          </div>
        )}
        {hasApproval && onConfirm && (
          <ToolApproval request={approval} onConfirm={onConfirm} />
        )}
        {hasSubToolApproval && onConfirm && (
          <ToolApproval request={approval!} onConfirm={onConfirm} />
        )}
        {showExpanded && (
          <div className={styles.lineDetail}>
            <SubAgentPanel tool={tool} hideHeader defaultExpanded inline />
          </div>
        )}
      </div>
    );
  }

  const description = getToolDescription(tool, workspaceCwd);
  const result = getToolResultSummary(tool);
  const elapsed = isShellToolName(tool.toolName)
    ? ''
    : formatElapsed(tool.startTime, tool.endTime);
  const expandable = hasExpandableContent(tool);

  const name = tool.toolName.toLowerCase();
  const isTodo = name === 'todowrite';

  return (
    <div className={styles.line}>
      <div
        className={`${styles.lineMain} ${expandable ? styles.lineExpandable : ''}`}
        onClick={expandable ? () => setExpanded(!expanded) : undefined}
      >
        <StatusIcon status={tool.status} />
        <span className={styles.lineName}>
          {formatToolDisplayName(tool.toolName)}
        </span>
        {description && <span className={styles.lineArg}>{description}</span>}
        {elapsed && <span className={styles.lineElapsed}>{elapsed}</span>}
      </div>
      {hasApproval && onConfirm && (
        <ToolApproval request={approval} onConfirm={onConfirm} />
      )}
      {isTodo && <TodoWriteContent tool={tool} />}
      {!isTodo && !expanded && result && (
        <div className={styles.lineOutput}>{result}</div>
      )}
      {!isTodo && expanded && (
        <div className={styles.lineDetail}>
          {isShellToolName(name) && <ExpandedBashOutput tool={tool} />}
          {(name === 'write_file' || name === 'writefile') && (
            <ExpandedWriteContent tool={tool} />
          )}
          {(name === 'edit' || name === 'write' || name === 'editfile') && (
            <ExpandedEditDiff tool={tool} />
          )}
          {(name === 'read' || name === 'read_file' || name === 'readfile') && (
            <ExpandedReadContent tool={tool} />
          )}
        </div>
      )}
    </div>
  );
}, areToolLinePropsEqual);

export const ToolGroup = memo(function ToolGroup({
  tools,
  pendingApproval,
  onConfirm,
  workspaceCwd,
}: ToolGroupProps) {
  const compactMode = useContext(CompactModeContext);
  const hasApprovalTool =
    pendingApproval?.toolCallId &&
    tools.some(
      (t) =>
        t.callId === pendingApproval.toolCallId ||
        toolHasApprovalInSubTools(t, pendingApproval.toolCallId!),
    );
  const showCompact = compactMode && !hasApprovalTool;

  if (showCompact) {
    return <CompactToolGroup tools={tools} workspaceCwd={workspaceCwd} />;
  }

  return (
    <div className={styles.group}>
      {tools.map((tool) => (
        <ToolLine
          key={tool.callId}
          tool={tool}
          approval={pendingApproval}
          onConfirm={onConfirm}
          workspaceCwd={workspaceCwd}
        />
      ))}
    </div>
  );
});
