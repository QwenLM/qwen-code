import { useState, useMemo } from 'react';
import type { ACPToolCall } from '../../../adapters/types';
import { Markdown } from '../Markdown';

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

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
    case 'success':
      return <span className="tool-icon tool-icon-done">✓</span>;
    case 'failed':
    case 'error':
      return <span className="tool-icon tool-icon-error">✗</span>;
    case 'in_progress':
      return <span className="tool-icon tool-icon-spin">⟳</span>;
    default:
      return <span className="tool-icon tool-icon-pending">○</span>;
  }
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
    <div className="tool-line">
      <div className="tool-line-main">
        <StatusIcon status={tool.status} />
        <span className="tool-line-name">{tool.toolName}</span>
        {summary && (
          <span className="tool-line-arg">{truncate(summary, 70)}</span>
        )}
      </div>
      {output && <div className="tool-line-output">{output}</div>}
    </div>
  );
}

function TaskToolCallLine({ tc }: { tc: TaskToolCall }) {
  const desc = tc.description || '';
  return (
    <div className="tool-line">
      <div className="tool-line-main">
        <StatusIcon status={tc.status} />
        <span className="tool-line-name">{tc.name}</span>
        {desc && <span className="tool-line-arg">{truncate(desc, 70)}</span>}
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

function formatElapsed(start?: number, end?: number): string {
  if (!start) return '';
  const ms = (end || Date.now()) - start;
  const s = Math.round(ms / 1000);
  if (s < 3) return '';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

function formatDurationMs(ms?: number): string {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

function formatTokens(summary?: TaskExecution['executionSummary']): string {
  if (!summary?.totalTokens) return '';
  const t = summary.totalTokens;
  if (t >= 1000000) return `${(t / 1000000).toFixed(1)}M tokens`;
  if (t >= 1000) return `${Math.round(t / 1000)}k tokens`;
  return `${t} tokens`;
}

export function SubAgentPanel({ tool }: SubAgentPanelProps) {
  const isComplete = tool.status === 'completed' || tool.status === 'failed';
  const [expanded, setExpanded] = useState(false);

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

  return (
    <div className="sub-agent-panel">
      <div className="sub-agent-header" onClick={() => setExpanded(!expanded)}>
        <StatusIcon status={tool.status} />
        <span className="tool-line-name">{agentType}:</span>
        {description && (
          <span className="sub-agent-desc">{truncate(description, 50)}</span>
        )}
        {isComplete && subToolCount > 0 && (
          <span className="sub-agent-meta">· {subToolCount} tools</span>
        )}
        {elapsed && <span className="sub-agent-meta">· {elapsed}</span>}
        {tokens && <span className="sub-agent-meta">· {tokens}</span>}
        {!isComplete && (
          <span className="sub-agent-toggle">{expanded ? '▼' : '▶'}</span>
        )}
      </div>

      {expanded && (
        <div className="sub-agent-body">
          {(tool.subContent || (!tool.subContent && resultText)) && (
            <div className="sub-agent-content">
              {isComplete ? (
                <Markdown content={tool.subContent || resultText} />
              ) : (
                tool.subContent && (
                  <pre className="sub-agent-stream">{tool.subContent}</pre>
                )
              )}
            </div>
          )}
          {tool.subTools && tool.subTools.length > 0 && (
            <div className="sub-agent-tools">
              {tool.subTools.map((sub) => (
                <SubToolLine key={sub.callId} tool={sub} />
              ))}
            </div>
          )}
          {taskToolCalls && taskToolCalls.length > 0 && (
            <div className="sub-agent-tools">
              {taskToolCalls.map((tc) => (
                <TaskToolCallLine key={tc.callId} tc={tc} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}
