import { useState } from 'react';
import type { ACPToolCall, PermissionRequest } from '../../adapters/types';
import { SubAgentPanel } from './tools/SubAgentPanel';
import { DiffView } from './tools/DiffView';
import { ToolApproval } from './ToolApproval';
import { parseAnsi, hasAnsi } from '../../utils/ansi';

interface ToolGroupProps {
  tools: ACPToolCall[];
  pendingApproval?: PermissionRequest | null;
  onConfirm?: (
    id: string,
    selectedOption: string,
    answers?: Record<string, string>,
  ) => void;
}

const AGENT_NAMES = new Set(['Agent', 'agent', 'task']);

function isSubAgent(tool: ACPToolCall): boolean {
  if (AGENT_NAMES.has(tool.toolName)) return true;
  if (tool.subTools || tool.subContent) return true;
  if (tool.rawOutput && typeof tool.rawOutput === 'object') {
    const raw = tool.rawOutput as Record<string, unknown>;
    if (raw.type === 'task_execution') return true;
  }
  return false;
}

function getToolDescription(tool: ACPToolCall): string {
  // Use server-provided title (contains the full human-readable description from the CLI)
  if (tool.title) {
    // Title often starts with "ToolName: description", strip the tool name prefix
    const colonIdx = tool.title.indexOf(': ');
    const desc = colonIdx > 0 ? tool.title.slice(colonIdx + 2) : tool.title;
    return truncateStr(desc, 80);
  }

  const args = tool.args || {};
  const name = tool.toolName.toLowerCase();

  if (args.command) {
    const cmd = args.command as string;
    return cmd.length > 60 ? cmd.slice(0, 60) + '...' : cmd;
  }
  if (args.file_path) {
    const fp = args.file_path as string;
    if (args.description) return args.description as string;
    return fp;
  }
  if (args.url) {
    const url = args.url as string;
    const prompt = args.prompt as string | undefined;
    const desc = prompt ? `${url} — "${truncateStr(prompt, 40)}"` : url;
    return truncateStr(desc, 80);
  }
  if (args.path) return args.path as string;
  if (args.query) {
    const q = args.query as string;
    return q.length > 60 ? q.slice(0, 60) + '...' : q;
  }
  if (name === 'list_directory' || name === 'listfiles') {
    return (args.path as string) || (args.directory as string) || '';
  }
  if (args.description) return args.description as string;
  return '';
}

function truncateStr(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
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
    if (firstLine.length > 80) return firstLine.slice(0, 80) + '...';
    return firstLine;
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
    if (firstLine.length > 80) return firstLine.slice(0, 80) + '...';
    return firstLine;
  }

  if (name === 'websearch' || name === 'web_search') {
    const matchCount = lines.filter((l) => l.trim()).length;
    if (matchCount > 1) return `${matchCount} result(s)`;
    return lines[0] || '';
  }

  const firstLine = lines[0] || '';
  if (firstLine.length > 80) return firstLine.slice(0, 80) + '...';
  return firstLine;
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <span className="tool-icon tool-icon-done">✓</span>;
    case 'failed':
      return <span className="tool-icon tool-icon-error">✗</span>;
    case 'in_progress':
      return <span className="tool-icon tool-icon-spin">⟳</span>;
    default:
      return <span className="tool-icon tool-icon-pending">○</span>;
  }
}

function formatElapsed(startTime?: number, endTime?: number): string {
  if (!startTime) return '';
  const end = endTime || Date.now();
  const seconds = Math.round((end - startTime) / 1000);
  if (seconds < 3) return '';
  return `${seconds}s`;
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
    return !!extractDiff(tool);
  }
  if (name === 'read' || name === 'read_file' || name === 'readfile') {
    const text = extractText(tool);
    return !!text && text.split('\n').length > 3;
  }
  return false;
}

function extractDiff(tool: ACPToolCall): string {
  if (tool.content) {
    const diffBlock = tool.content.find((b) => b.type === 'diff');
    if (diffBlock && diffBlock.type === 'diff') {
      return buildUnifiedDiff(diffBlock.oldText || '', diffBlock.newText);
    }
  }
  if (tool.rawOutput && typeof tool.rawOutput === 'object') {
    const raw = tool.rawOutput as Record<string, unknown>;
    if (typeof raw.fileDiff === 'string') return raw.fileDiff;
  }
  return '';
}

function buildUnifiedDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: string[] = [];

  let i = 0,
    j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (
      i < oldLines.length &&
      j < newLines.length &&
      oldLines[i] === newLines[j]
    ) {
      result.push(` ${oldLines[i]}`);
      i++;
      j++;
    } else if (
      j < newLines.length &&
      (i >= oldLines.length || oldLines[i] !== newLines[j])
    ) {
      result.push(`+${newLines[j]}`);
      j++;
    } else {
      result.push(`-${oldLines[i]}`);
      i++;
    }
  }

  return result.join('\n');
}

const MAX_BASH_LINES = 20;
const MAX_READ_LINES = 25;

function ExpandedBashOutput({ tool }: { tool: ACPToolCall }) {
  const [showAll, setShowAll] = useState(false);
  const output = extractText(tool) || '';
  const lines = output.split('\n');
  const isLong = lines.length > MAX_BASH_LINES;
  const displayText =
    isLong && !showAll ? lines.slice(0, MAX_BASH_LINES).join('\n') : output;

  return (
    <div className="tool-expanded-bash">
      <pre className="tool-expanded-output">
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
          className="tool-expand-btn"
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? `▲ Show less` : `▼ ${lines.length} lines total`}
        </button>
      )}
    </div>
  );
}

function ExpandedReadContent({ tool }: { tool: ACPToolCall }) {
  const [showAll, setShowAll] = useState(false);
  const content = extractText(tool) || '';
  const lines = content.split('\n');
  const isLong = lines.length > MAX_READ_LINES;
  const displayText =
    isLong && !showAll ? lines.slice(0, MAX_READ_LINES).join('\n') : content;

  return (
    <div className="tool-expanded-read">
      <pre className="tool-expanded-output">{displayText}</pre>
      {isLong && (
        <button
          className="tool-expand-btn"
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? `▲ Show less` : `▼ ${lines.length} lines total`}
        </button>
      )}
    </div>
  );
}

function ExpandedEditDiff({ tool }: { tool: ACPToolCall }) {
  const diff = extractDiff(tool);
  if (!diff) return null;
  return (
    <div className="tool-expanded-edit">
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
  const [showAll, setShowAll] = useState(false);
  const content = getWriteContent(tool);
  const lines = content.split('\n');
  const isLong = lines.length > MAX_WRITE_LINES;
  const displayLines =
    isLong && !showAll ? lines.slice(0, MAX_WRITE_LINES) : lines;

  if (!content) return null;

  return (
    <div className="tool-expanded-write">
      <pre className="tool-expanded-output">
        {displayLines.map((line, i) => (
          <span key={i} className="diff-add">{`+${line}\n`}</span>
        ))}
      </pre>
      {isLong && (
        <button
          className="tool-expand-btn"
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? `▲ Show less` : `▼ ${lines.length} lines total`}
        </button>
      )}
    </div>
  );
}

function TodoWriteContent({ tool }: { tool: ACPToolCall }) {
  const text = extractText(tool) || '';
  const lines = text.split('\n').filter((l) => l.trim());
  return (
    <div className="tool-todo-list">
      {lines.map((line, i) => {
        const isCompleted = line.startsWith('●');
        const isInProgress = line.startsWith('◐');
        const cls = isCompleted
          ? 'tool-todo-done'
          : isInProgress
            ? 'tool-todo-active'
            : 'tool-todo-pending';
        return (
          <div key={i} className={`tool-todo-item ${cls}`}>
            {line}
          </div>
        );
      })}
    </div>
  );
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

function ToolLine({ tool, approval, onConfirm }: ToolLineProps) {
  const [expanded, setExpanded] = useState(() => shouldAutoExpand(tool));
  if (isSubAgent(tool)) return <SubAgentPanel tool={tool} />;

  const description = getToolDescription(tool);
  const result = getToolResultSummary(tool);
  const elapsed = formatElapsed(tool.startTime, tool.endTime);
  const expandable = hasExpandableContent(tool);

  const name = tool.toolName.toLowerCase();
  const isTodo = name === 'todowrite';

  const hasApproval = approval && approval.toolCallId === tool.callId;

  return (
    <div className="tool-line">
      <div
        className={`tool-line-main ${expandable ? 'tool-line-expandable' : ''}`}
        onClick={expandable ? () => setExpanded(!expanded) : undefined}
      >
        <StatusIcon status={tool.status} />
        <span className="tool-line-name">{tool.toolName}</span>
        {description && <span className="tool-line-arg">{description}</span>}
        {elapsed && <span className="tool-line-elapsed">{elapsed}</span>}
        {expandable && (
          <span className="tool-line-chevron">{expanded ? '▼' : '▶'}</span>
        )}
      </div>
      {hasApproval && onConfirm && (
        <ToolApproval request={approval} onConfirm={onConfirm} />
      )}
      {isTodo && <TodoWriteContent tool={tool} />}
      {!isTodo && !expanded && result && (
        <div className="tool-line-output">{result}</div>
      )}
      {!isTodo && expanded && (
        <div className="tool-line-detail">
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
}

export function ToolGroup({
  tools,
  pendingApproval,
  onConfirm,
}: ToolGroupProps) {
  return (
    <div className="tool-group">
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
}
