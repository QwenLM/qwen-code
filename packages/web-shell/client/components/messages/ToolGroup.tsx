import { memo, useState } from 'react';
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
import { formatElapsed, StatusIcon, truncateText } from './tools/toolDisplay';
import { useI18n } from '../../i18n';
import styles from './tools/ToolChrome.module.css';

interface ToolGroupProps {
  tools: ACPToolCall[];
  pendingApproval?: PermissionRequest | null;
  onConfirm?: (
    id: string,
    selectedOption: string,
    answers?: Record<string, string>,
  ) => void;
}

function getToolDescription(tool: ACPToolCall): string {
  // Use server-provided title (contains the full human-readable description from the CLI)
  if (tool.title) {
    // Title often starts with "ToolName: description", strip the tool name prefix
    const colonIdx = tool.title.indexOf(': ');
    const desc = colonIdx > 0 ? tool.title.slice(colonIdx + 2) : tool.title;
    return truncateText(desc, 80);
  }

  const args = tool.args || {};
  const name = tool.toolName.toLowerCase();

  if (args.command) {
    const cmd = args.command as string;
    return truncateText(cmd, 60);
  }
  if (args.file_path) {
    const fp = args.file_path as string;
    if (args.description) return args.description as string;
    return fp;
  }
  if (args.url) {
    const url = args.url as string;
    const prompt = args.prompt as string | undefined;
    const desc = prompt ? `${url} — "${truncateText(prompt, 40)}"` : url;
    return truncateText(desc, 80);
  }
  if (args.path) return args.path as string;
  if (args.query) {
    const q = args.query as string;
    return truncateText(q, 60);
  }
  if (name === 'list_directory' || name === 'listfiles') {
    return (args.path as string) || (args.directory as string) || '';
  }
  if (args.description) return args.description as string;
  return '';
}

function extractText(tool: ACPToolCall): string | null {
  if (!tool.content) {
    if (tool.rawOutput) {
      if (typeof tool.rawOutput === 'string') return tool.rawOutput;
      const raw = tool.rawOutput as Record<string, unknown>;
      if (typeof raw.output === 'string') return raw.output;
      if (typeof raw.stdout === 'string') return raw.stdout;
      if (typeof raw.content === 'string') return raw.content;
      if (typeof raw.text === 'string') return raw.text;
    }
    return null;
  }
  for (const b of tool.content) {
    if (b.type === 'content' && b.content?.text) return b.content.text;
  }
  if (tool.rawOutput) {
    if (typeof tool.rawOutput === 'string') return tool.rawOutput;
    const raw = tool.rawOutput as Record<string, unknown>;
    if (typeof raw.output === 'string') return raw.output;
    if (typeof raw.stdout === 'string') return raw.stdout;
    if (typeof raw.content === 'string') return raw.content;
    if (typeof raw.text === 'string') return raw.text;
  }
  return null;
}

function getToolResultSummary(tool: ACPToolCall): string {
  if (tool.status !== 'completed' && tool.status !== 'failed') return '';

  const text = extractText(tool);
  if (!text) return '';

  const name = tool.toolName.toLowerCase();
  const lines = text.split('\n');
  const lineCount = lines.length;

  if (name === 'read' || name === 'read_file' || name === 'readfile') {
    const filePath = (tool.args?.file_path || tool.args?.path || '') as string;
    const fileName = filePath.split('/').pop() || filePath;
    if (lineCount > 5) {
      return `Read ${lineCount} lines from ${fileName}`;
    }
    return '';
  }

  if (name === 'list_directory' || name === 'listfiles' || name === 'glob') {
    const itemCount = lines.filter((l) => l.trim()).length;
    return `${itemCount} item(s)`;
  }

  if (name === 'bash' || name === 'shell' || name === 'execute_command') {
    if (lineCount > 3) return `${lineCount} lines of output`;
    const firstLine = lines[0] || '';
    return truncateText(firstLine, 80);
  }

  if (name === 'grep' || name === 'search') {
    const matchCount = lines.filter((l) => l.trim()).length;
    return `${matchCount} result(s)`;
  }

  if (name === 'edit' || name === 'write' || name === 'editfile') {
    return '';
  }

  if (name === 'webfetch' || name === 'web_fetch' || name === 'fetch') {
    const firstLine = lines[0] || '';
    return truncateText(firstLine, 80);
  }

  if (name === 'websearch' || name === 'web_search') {
    const matchCount = lines.filter((l) => l.trim()).length;
    if (matchCount > 1) return `${matchCount} result(s)`;
    return lines[0] || '';
  }

  const firstLine = lines[0] || '';
  return truncateText(firstLine, 80);
}

function hasExpandableContent(tool: ACPToolCall): boolean {
  const name = tool.toolName.toLowerCase();
  // write_file shows content from args even before completion
  if (name === 'write_file' || name === 'writefile') {
    return !!getWriteContent(tool);
  }
  if (tool.status !== 'completed' && tool.status !== 'failed') return false;
  if (name === 'bash' || name === 'shell' || name === 'execute_command') {
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

const MAX_BASH_LINES = 20;
const MAX_READ_LINES = 25;

function ExpandedBashOutput({ tool }: { tool: ACPToolCall }) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const output = extractText(tool) || '';
  const lines = output.split('\n');
  const isLong = lines.length > MAX_BASH_LINES;
  const displayText =
    isLong && !showAll ? lines.slice(0, MAX_BASH_LINES).join('\n') : output;

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
}

function shouldAutoExpand(tool: ACPToolCall): boolean {
  const name = tool.toolName.toLowerCase();
  if (name === 'write_file' || name === 'writefile') return true;
  if (name === 'edit' || name === 'editfile') return true;
  return false;
}

const ToolLine = memo(function ToolLine({
  tool,
  approval,
  onConfirm,
}: ToolLineProps) {
  const [expanded, setExpanded] = useState(() => shouldAutoExpand(tool));
  if (isSubAgentToolCall(tool)) return <SubAgentPanel tool={tool} />;

  const description = getToolDescription(tool);
  const result = getToolResultSummary(tool);
  const elapsed = formatElapsed(tool.startTime, tool.endTime);
  const expandable = hasExpandableContent(tool);

  const name = tool.toolName.toLowerCase();
  const isTodo = name === 'todowrite';

  const hasApproval = approval && approval.toolCallId === tool.callId;

  return (
    <div className={styles.line}>
      <div
        className={`${styles.lineMain} ${expandable ? styles.lineExpandable : ''}`}
        onClick={expandable ? () => setExpanded(!expanded) : undefined}
      >
        <StatusIcon status={tool.status} />
        <span className={styles.lineName}>{tool.toolName}</span>
        {description && <span className={styles.lineArg}>{description}</span>}
        {elapsed && <span className={styles.lineElapsed}>{elapsed}</span>}
        {expandable && (
          <span className={styles.lineChevron}>{expanded ? '▼' : '▶'}</span>
        )}
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
          {(name === 'bash' ||
            name === 'shell' ||
            name === 'execute_command') && <ExpandedBashOutput tool={tool} />}
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
});

export const ToolGroup = memo(function ToolGroup({
  tools,
  pendingApproval,
  onConfirm,
}: ToolGroupProps) {
  return (
    <div className={styles.group}>
      {tools.map((tool) => (
        <ToolLine
          key={tool.callId}
          tool={tool}
          approval={pendingApproval}
          onConfirm={onConfirm}
        />
      ))}
    </div>
  );
});
