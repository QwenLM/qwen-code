import { useState, useEffect, useCallback } from 'react';
import type { PermissionRequest } from '../../adapters/types';

interface ToolApprovalProps {
  request: PermissionRequest;
  onConfirm: (id: string, selectedOption: string) => void;
}

function parseTitle(title?: string): { toolName: string; description: string } {
  if (!title) return { toolName: '', description: '' };
  const colonIdx = title.indexOf(': ');
  if (colonIdx > 0) {
    return {
      toolName: title.slice(0, colonIdx),
      description: title.slice(colonIdx + 2),
    };
  }
  return { toolName: title, description: '' };
}

function extractContentText(request: PermissionRequest): string {
  const parts: string[] = [];
  for (const block of request.content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function isExecKind(request: PermissionRequest): boolean {
  return (
    request.kind === 'bash' ||
    request.kind === 'exec' ||
    request.kind === 'shell'
  );
}

function getCommandFromRawInput(request: PermissionRequest): string | null {
  if (!request.rawInput) return null;
  const raw = request.rawInput;
  if (typeof raw.command === 'string') return raw.command;
  if (typeof raw.input === 'string') return raw.input;
  return null;
}

export function ToolApproval({ request, onConfirm }: ToolApprovalProps) {
  const [selected, setSelected] = useState(0);

  const { toolName, description } = parseTitle(request.title);
  const contentText = extractContentText(request);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const optCount = request.options.length;
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setSelected((s) => (s - 1 + optCount) % optCount);
      } else if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setSelected((s) => (s + 1) % optCount);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm(request.id, request.options[selected].id);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        const reject = request.options.find(
          (o) => o.kind === 'reject_once' || o.kind === 'reject_always',
        );
        if (reject) onConfirm(request.id, reject.id);
      } else if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        if (idx < optCount) {
          e.preventDefault();
          onConfirm(request.id, request.options[idx].id);
        }
      }
    },
    [request, selected, onConfirm],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const isExec = isExecKind(request);
  const command = getCommandFromRawInput(request);

  return (
    <div className="tool-approval">
      <div className="tool-approval-header">
        <span className="tool-approval-icon">?</span>
        <span className="tool-approval-name">{toolName}</span>
        {description && (
          <span className="tool-approval-desc">{description}</span>
        )}
      </div>

      {isExec && command ? (
        <div className="tool-approval-code">
          <pre className="tool-approval-code-block">{command}</pre>
        </div>
      ) : contentText ? (
        <pre className="tool-approval-content">{contentText}</pre>
      ) : null}

      <div className="tool-approval-question">
        {isExec ? `Allow execution of: '${toolName}'?` : 'Apply this change?'}
      </div>

      <div className="tool-approval-options">
        {request.options.map((option, i) => {
          const isSelected = i === selected;
          return (
            <div
              key={option.id}
              className={`tool-approval-option ${isSelected ? 'tool-approval-option-active' : ''}`}
              onClick={() => onConfirm(request.id, option.id)}
              onMouseEnter={() => setSelected(i)}
            >
              <span className="tool-approval-option-pointer">
                {isSelected ? '›' : ' '}
              </span>
              <span className="tool-approval-option-num">{i + 1}.</span>
              <span className="tool-approval-option-label">{option.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
