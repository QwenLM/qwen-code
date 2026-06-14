import { memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonSettingDescriptor } from '@qwen-code/webui/daemon-react-sdk';
import type {
  ACPToolCall,
  PermissionRequest,
  TodoItem,
} from '../../adapters/types';
import { isSubAgentToolCall } from '../../adapters/toolClassification';
// Circular import with SubAgentPanel (its SubToolLine renders ToolLine
// from this module). Safe only while both modules dereference each
// other's exports at render time — never in top-level code.
import { SubAgentPanel } from './tools/SubAgentPanel';
import { DiffView } from './tools/DiffView';
import { ToolApproval } from './ToolApproval';
import { parseAnsi, hasAnsi } from '../../utils/ansi';
import { extractTodosFromToolCall, getTodoStatusIcon } from '../../utils/todos';
import {
  formatDurationMs,
  formatElapsed,
  formatToolDisplayName,
  StatusIcon,
  truncateText,
} from './tools/toolDisplay';
import {
  extractText,
  formatTokenCount,
  getAgentCancellationReason,
  getAgentCurrentToolHint,
  getAgentDescription,
  getAgentDisplayStatus,
  getAgentType,
  getTaskExecutionRecord,
  getToolDescription,
  getToolResultSummary,
  isAskUserQuestionToolName,
  isShellToolName,
  toolContainsCallId,
} from './toolFormatting';
import { useI18n } from '../../i18n';
import { CompactModeContext } from '../../App';
import {
  type ToolHeaderExtraRenderInfo,
  type ToolHeaderKind,
  useWebShellCustomization,
} from '../../customization';
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
  shellOutputMaxLines?: number;
}

const DEFAULT_SHELL_OUTPUT_MAX_LINES = 5;

function hasExpandableContent(tool: ACPToolCall): boolean {
  const name = tool.toolName.toLowerCase();
  if (isAskUserQuestionToolName(tool.toolName)) return !!extractText(tool);
  // write_file shows content from args even before completion
  if (name === 'write_file' || name === 'writefile') {
    return !!getWriteContent(tool);
  }
  if (tool.status !== 'completed' && tool.status !== 'failed') return false;
  if (isShellToolName(name)) {
    const text = extractText(tool);
    return !!text && text.trim().length > 0 && text.split('\n').length > 1;
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

// Tools whose expanded row renders a kind-specific detail view (shell output /
// diff / file content / Q&A). Must stay in sync with the renderers in
// ToolLine's lineDetail block below. Tools NOT in this set have nothing extra
// to show when expanded, so they keep their one-line result summary instead of
// hiding it behind an empty detail area.
function hasDetailView(tool: ACPToolCall): boolean {
  const name = tool.toolName.toLowerCase();
  return (
    isShellToolName(name) ||
    name === 'write_file' ||
    name === 'writefile' ||
    name === 'edit' ||
    name === 'write' ||
    name === 'editfile' ||
    name === 'read' ||
    name === 'read_file' ||
    name === 'readfile' ||
    isAskUserQuestionToolName(tool.toolName)
  );
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

const MAX_BASH_LINE_CHARS = 150;
const MAX_READ_LINES = 25;

// A description longer than this is likely ellipsised on a normal-width row, so
// the row becomes expandable to re-flow the full text into a wrapped block.
const DESCRIPTION_EXPAND_THRESHOLD = 60;

export function resolveShellOutputMaxLines(
  settings: readonly DaemonSettingDescriptor[],
): number {
  const setting = settings.find((s) => s.key === 'ui.shellOutputMaxLines');
  const value = setting?.values.effective;
  const raw =
    typeof value === 'number' ? value : DEFAULT_SHELL_OUTPUT_MAX_LINES;
  return Math.max(0, Math.floor(raw || 0));
}

function truncateLine(line: string, max: number): string {
  if (line.length <= max) return line;
  return line.slice(0, max) + ' …';
}

function ExpandedBashOutput({
  tool,
  maxLines,
}: {
  tool: ACPToolCall;
  maxLines: number;
}) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const output = useMemo(() => extractText(tool) || '', [tool]);
  const lines = useMemo(() => output.split('\n'), [output]);
  const isLong = maxLines > 0 && lines.length > maxLines;
  const hiddenLinesCount = Math.max(0, lines.length - maxLines);
  const hasTruncatedLine = useMemo(
    () => lines.some((l) => l.length > MAX_BASH_LINE_CHARS),
    [lines],
  );
  const expandable = isLong || hasTruncatedLine;
  const displayText = useMemo(() => {
    if (showAll) return output;
    if (isLong) {
      return [
        `... first ${hiddenLinesCount} lines hidden ...`,
        ...lines
          .slice(-maxLines)
          .map((l) => truncateLine(l, MAX_BASH_LINE_CHARS)),
      ].join('\n');
    }
    return lines.map((l) => truncateLine(l, MAX_BASH_LINE_CHARS)).join('\n');
  }, [hiddenLinesCount, isLong, lines, maxLines, output, showAll]);
  const ansiSegments = useMemo(
    () => (hasAnsi(displayText) ? parseAnsi(displayText) : null),
    [displayText],
  );

  return (
    <div className={styles.expandedBash}>
      <pre className={styles.expandedOutput}>
        {ansiSegments
          ? ansiSegments.map((seg, i) => (
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
      {expandable && (
        <button
          className={styles.expandBtn}
          onClick={() => setShowAll(!showAll)}
          aria-expanded={showAll}
        >
          {showAll
            ? t('tool.showLess')
            : isLong
              ? t('tool.showAll', { count: lines.length })
              : t('tool.showFullLines')}
        </button>
      )}
    </div>
  );
}

function ExpandedReadContent({ tool }: { tool: ACPToolCall }) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const content = useMemo(() => extractText(tool) || '', [tool]);
  const lines = useMemo(() => content.split('\n'), [content]);
  const isLong = lines.length > MAX_READ_LINES;
  const displayText = useMemo(
    () =>
      isLong && !showAll ? lines.slice(0, MAX_READ_LINES).join('\n') : content,
    [content, isLong, lines, showAll],
  );

  return (
    <div className={styles.expandedRead}>
      <pre className={styles.expandedOutput}>{displayText}</pre>
      {isLong && (
        <button
          className={styles.expandBtn}
          onClick={() => setShowAll(!showAll)}
          aria-expanded={showAll}
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
  const diff = useMemo(() => extractDiff(tool), [tool]);
  if (!diff) return null;
  return (
    <div className={styles.expandedEdit}>
      <DiffView diff={diff} />
    </div>
  );
}

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
            {getTodoStatusIcon(todo.status)} {todo.content}
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

interface ToolLineProps {
  tool: ACPToolCall;
  approval?: PermissionRequest | null;
  onConfirm?: (id: string, selectedOption: string) => void;
  workspaceCwd?: string;
  shellOutputMaxLines?: number;
}

function getAgentDisplayInfo(
  tool: ACPToolCall,
  now?: number,
): {
  agentType: string;
  description: string;
  subToolCount: number;
  elapsed: string;
  tokens: string;
  status: ACPToolCall['status'];
  reason: string;
} {
  const taskExec = getTaskExecutionRecord(tool.rawOutput);
  const reason = getAgentCancellationReason(tool);
  const status = getAgentDisplayStatus(tool);
  const agentType = getAgentType(tool);
  const description = getAgentDescription(tool);

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
      : formatElapsed(
          tool.startTime,
          tool.endTime ??
            (tool.status === 'in_progress' && now ? now : undefined),
        );

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
  const tokens = totalTokens > 0 ? formatTokenCount(totalTokens) : '';

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

function shouldAutoExpand(tool: ACPToolCall): boolean {
  // Only the verbose tool kinds below (shell/edit/write/ask) auto-expand, and
  // only while pending/in-progress or after failing: a successful completion
  // collapses them to a one-line summary so the transcript stays scannable
  // (click to reopen), while a failure of those kinds stays expanded so its
  // error output is visible without a click. Every other tool kind is collapsed
  // by default regardless of status — its summary line already shows the
  // outcome and it stays click-to-expand.
  if (tool.status === 'completed') return false;
  const name = tool.toolName.toLowerCase();
  if (isAskUserQuestionToolName(tool.toolName)) return true;
  if (name === 'write_file' || name === 'writefile') return true;
  if (name === 'edit' || name === 'editfile') return true;
  if (isShellToolName(name)) return true;
  return false;
}

function ExpandedAskUserQuestionOutput({ tool }: { tool: ACPToolCall }) {
  const text = extractText(tool) || '';
  return <pre className={styles.expandedOutput}>{text}</pre>;
}

function getToolHeaderKind(tool: ACPToolCall): ToolHeaderKind {
  const name = tool.toolName.toLowerCase();
  if (isSubAgentToolCall(tool)) return 'agent';
  if (isShellToolName(name)) return 'shell';
  if (isWebFetchToolName(name)) return 'fetch';
  if (name === 'todowrite') return 'todo';
  if (name === 'read' || name === 'read_file' || name === 'readfile')
    return 'read';
  if (name === 'edit' || name === 'editfile') return 'edit';
  if (name === 'write' || name === 'write_file' || name === 'writefile')
    return 'write';
  return 'other';
}

function DefaultToolHeaderExtra({
  description,
  elapsed,
}: {
  description: string;
  elapsed: string;
}) {
  return (
    <>
      {description && <span className={styles.lineArg}>{description}</span>}
      {elapsed && <span className={styles.lineElapsed}>{elapsed}</span>}
    </>
  );
}

function ToolHeaderExtra({ info }: { info: ToolHeaderExtraRenderInfo }) {
  const { renderToolHeaderExtra } = useWebShellCustomization();
  const customExtra = renderToolHeaderExtra?.(info);
  if (customExtra) return <>{customExtra}</>;
  return (
    <DefaultToolHeaderExtra
      description={info.description}
      elapsed={info.elapsed}
    />
  );
}

function isDescriptionExpandable(description: string): boolean {
  return (
    description.length > DESCRIPTION_EXPAND_THRESHOLD ||
    description.includes('\n')
  );
}

function ToggleChevron({
  expandable,
  expanded,
}: {
  expandable: boolean;
  expanded: boolean;
}) {
  return (
    <span className={styles.lineToggle} aria-hidden="true">
      {expandable ? (expanded ? '▾' : '▸') : ''}
    </span>
  );
}

function getActiveTool(tools: ACPToolCall[]): ACPToolCall {
  return (
    tools.find((t) => t.status === 'in_progress') ?? tools[tools.length - 1]
  );
}

function isWebFetchToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === 'web_fetch' || name === 'webfetch' || name === 'fetch';
}

const getCompactDisplayStatus = getAgentDisplayStatus;

function CompactToolGroup({
  tools,
  workspaceCwd,
}: {
  tools: ACPToolCall[];
  workspaceCwd?: string;
}) {
  const { t } = useI18n();
  const activeTool = getActiveTool(tools);
  const displayName = formatToolDisplayName(activeTool.toolName);
  const overallStatus = getCompactDisplayStatus(activeTool);
  const description = getToolDescription(activeTool, workspaceCwd);
  const elapsed =
    isShellToolName(activeTool.toolName) ||
    isWebFetchToolName(activeTool.toolName)
      ? ''
      : formatElapsed(activeTool.startTime, activeTool.endTime);

  return (
    <div className={styles.compactGroup}>
      <div className={styles.compactHeader}>
        <StatusIcon status={overallStatus} />
        <span className={styles.lineName}>{displayName}</span>
        {tools.length > 1 && (
          <span className={styles.compactCount}>
            {'× '}
            {tools.length}
          </span>
        )}
        <ToolHeaderExtra
          info={{
            kind: getToolHeaderKind(activeTool),
            tool: activeTool,
            displayName,
            description,
            elapsed,
            workspaceCwd,
          }}
        />
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
  if (prev.shellOutputMaxLines !== next.shellOutputMaxLines) return false;
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
    a.args === b.args &&
    a.content === b.content &&
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
      a.toolName !== b.toolName ||
      a.status !== b.status ||
      a.endTime !== b.endTime ||
      a.rawOutput !== b.rawOutput ||
      a.args !== b.args ||
      a.subContent !== b.subContent ||
      a.title !== b.title
    ) {
      return false;
    }
  }
  return true;
}

export const ToolLine = memo(function ToolLine({
  tool,
  approval,
  onConfirm,
  workspaceCwd,
  shellOutputMaxLines = DEFAULT_SHELL_OUTPUT_MAX_LINES,
}: ToolLineProps) {
  const { t } = useI18n();
  const compactMode = useContext(CompactModeContext);
  const [expanded, setExpanded] = useState(
    () => !compactMode && shouldAutoExpand(tool),
  );
  // Set once the user explicitly toggles this row, so auto-collapse-on-
  // completion never silently overrides their choice.
  const userToggledRef = useRef(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(
    () => {
      setExpanded(compactMode ? false : shouldAutoExpand(tool));
      // A new tool identity (or compact-mode toggle) resets the manual latch.
      userToggledRef.current = false;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compactMode, tool.callId, tool.toolName],
  );
  const isAgent = isSubAgentToolCall(tool);
  const hasApproval = approval && approval.toolCallId === tool.callId;
  const hasSubToolApproval =
    !hasApproval &&
    approval?.toolCallId &&
    isAgent &&
    toolContainsCallId(tool, approval.toolCallId);
  const isRunningAgent = isAgent && tool.status === 'in_progress';

  useEffect(() => {
    if (!isRunningAgent) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunningAgent]);

  // Collapse a regular tool to its one-line summary once it completes
  // successfully — unless the user explicitly toggled this row, in which case
  // their choice wins. Agents are excluded (they keep whatever expand state the
  // user chose, driven from their own panel) and failures stay open so the
  // error output remains visible.
  useEffect(() => {
    if (!isAgent && tool.status === 'completed' && !userToggledRef.current) {
      setExpanded(false);
    }
  }, [isAgent, tool.status]);

  if (isAgent) {
    if (hasApproval && onConfirm) {
      return (
        <div className={styles.line}>
          <ToolApproval request={approval} onConfirm={onConfirm} />
        </div>
      );
    }

    const info = getAgentDisplayInfo(tool, now);
    const displayName = t('agent.label');
    const isComplete = tool.status === 'completed' || tool.status === 'failed';
    const toolHint = getAgentCurrentToolHint(tool);
    const progressLabel = tool.status === 'pending' ? 'pending' : 'running';
    const runningMeta = [toolHint, progressLabel, info.elapsed]
      .filter(Boolean)
      .join(' · ');
    const showExpanded = expanded || !!hasSubToolApproval;
    return (
      <div className={styles.line}>
        <div className={styles.lineMain}>
          <StatusIcon status={tool.status} />
          <span className={styles.lineName}>{displayName}</span>
          <ToolHeaderExtra
            info={{
              kind: 'agent',
              tool,
              displayName,
              description: info.description
                ? truncateText(info.description, 60)
                : '',
              elapsed: '',
              workspaceCwd,
            }}
          />
        </div>
        {!isComplete && (
          <div
            className={`${styles.agentSummary} ${styles.lineExpandable}`}
            onClick={() => setExpanded(!expanded)}
          >
            <StatusIcon status={tool.status} />
            <span className={styles.lineName}>{info.agentType}:</span>
            <span className={styles.lineArg}>
              {truncateText(info.description || info.agentType, 50)}
            </span>
            {runningMeta && (
              <span className={styles.lineElapsed}>· {runningMeta}</span>
            )}
          </div>
        )}
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
  const displayName = formatToolDisplayName(tool.toolName);
  const elapsed =
    isShellToolName(tool.toolName) || isWebFetchToolName(tool.toolName)
      ? ''
      : formatElapsed(tool.startTime, tool.endTime);

  const name = tool.toolName.toLowerCase();
  const isTodo = name === 'todowrite';
  // A row expands when it has detail output (bash/diff/read content) or when
  // its description is long enough to be ellipsised. When a long description is
  // expanded we move it out of the header into a wrapped block below, so the
  // header drops its single-line copy.
  const descExpandable = !isTodo && isDescriptionExpandable(description);
  const expandable = !isTodo && (hasExpandableContent(tool) || descExpandable);
  const relocateDescription = expanded && descExpandable;
  // Whether the expanded row renders a kind-specific detail view. When it does
  // not (e.g. grep/glob/web_fetch with a long description), keep the result
  // summary visible instead of replacing it with an empty detail area.
  const detailView = hasDetailView(tool);

  if (hasApproval && onConfirm) {
    return (
      <div className={styles.line}>
        <ToolApproval request={approval} onConfirm={onConfirm} />
      </div>
    );
  }

  return (
    <div className={styles.line}>
      <div
        className={`${styles.lineMain} ${expandable ? styles.lineExpandable : ''}`}
        onClick={
          expandable
            ? () => {
                userToggledRef.current = true;
                setExpanded((value) => !value);
              }
            : undefined
        }
      >
        <ToggleChevron expandable={expandable} expanded={expanded} />
        <StatusIcon status={tool.status} />
        <span className={styles.lineName}>{displayName}</span>
        <ToolHeaderExtra
          info={{
            kind: getToolHeaderKind(tool),
            tool,
            displayName,
            description: relocateDescription ? '' : description,
            elapsed,
            workspaceCwd,
          }}
        />
      </div>
      {isTodo && <TodoWriteContent tool={tool} />}
      {relocateDescription && (
        <div className={styles.lineFullArg}>{description}</div>
      )}
      {!isTodo && result && (!expanded || !detailView) && (
        <div className={styles.lineOutput}>{result}</div>
      )}
      {!isTodo && expanded && detailView && (
        <div className={styles.lineDetail}>
          {isShellToolName(name) && (
            <ExpandedBashOutput tool={tool} maxLines={shellOutputMaxLines} />
          )}
          {(name === 'write_file' || name === 'writefile') && (
            <ExpandedEditDiff tool={tool} />
          )}
          {(name === 'edit' || name === 'write' || name === 'editfile') && (
            <ExpandedEditDiff tool={tool} />
          )}
          {(name === 'read' || name === 'read_file' || name === 'readfile') && (
            <ExpandedReadContent tool={tool} />
          )}
          {isAskUserQuestionToolName(tool.toolName) && (
            <ExpandedAskUserQuestionOutput tool={tool} />
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
  shellOutputMaxLines,
}: ToolGroupProps) {
  const compactMode = useContext(CompactModeContext);
  const directApprovalTool =
    pendingApproval?.toolCallId &&
    tools.find((t) => t.callId === pendingApproval.toolCallId);
  const hasApprovalTool =
    pendingApproval?.toolCallId &&
    tools.some((t) => toolContainsCallId(t, pendingApproval.toolCallId!));
  const showCompact = compactMode && !hasApprovalTool;

  if (directApprovalTool && tools.length === 1 && onConfirm) {
    return <ToolApproval request={pendingApproval} onConfirm={onConfirm} />;
  }

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
          shellOutputMaxLines={shellOutputMaxLines}
        />
      ))}
    </div>
  );
});
