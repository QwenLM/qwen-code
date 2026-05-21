import type { ToolCallStatus } from '../../../adapters/types';

interface ToolStatusProps {
  status: ToolCallStatus;
  toolName: string;
  elapsed?: number;
}

const STATUS_ICONS: Record<ToolCallStatus, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  failed: '✗',
};

const STATUS_CLASSES: Record<ToolCallStatus, string> = {
  pending: 'status-pending',
  in_progress: 'status-running',
  completed: 'status-done',
  failed: 'status-error',
};

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ToolStatus({ status, toolName, elapsed }: ToolStatusProps) {
  return (
    <div className={`tool-status ${STATUS_CLASSES[status]}`}>
      <span className="tool-status-icon">{STATUS_ICONS[status]}</span>
      <span className="tool-status-name">{toolName}</span>
      {elapsed !== undefined && status === 'completed' && (
        <span className="tool-status-elapsed">{formatElapsed(elapsed)}</span>
      )}
      {status === 'in_progress' && <span className="tool-status-spinner" />}
    </div>
  );
}
