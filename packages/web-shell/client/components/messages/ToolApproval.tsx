import { useState, useEffect, useCallback, useRef } from 'react';
import type { PermissionRequest } from '../../adapters/types';
import { isEditableTarget } from '../../utils/dom';
import styles from './ToolApproval.module.css';

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
  const submittedRef = useRef(false);

  useEffect(() => {
    submittedRef.current = false;
    setSelected(0);
  }, [request.id]);

  const { toolName, description } = parseTitle(request.title);
  const contentText = extractContentText(request);

  const confirm = useCallback(
    (optionId: string) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      onConfirm(request.id, optionId);
    },
    [request.id, onConfirm],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableTarget(e.target)) return;
      const optCount = request.options.length;
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setSelected((s) => (s - 1 + optCount) % optCount);
      } else if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setSelected((s) => (s + 1) % optCount);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        confirm(request.options[selected].id);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        const reject = request.options.find(
          (o) => o.kind === 'reject_once' || o.kind === 'reject_always',
        );
        if (reject) confirm(reject.id);
      } else if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        if (idx < optCount) {
          e.preventDefault();
          confirm(request.options[idx].id);
        }
      }
    },
    [request, selected, confirm],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      window.addEventListener('keydown', handleKeyDown);
    }, 50);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  const isExec = isExecKind(request);
  const command = getCommandFromRawInput(request);

  return (
    <div className={styles.approval}>
      <div className={styles.header}>
        <span className={styles.icon}>?</span>
        <span className={styles.name}>{toolName}</span>
        {description && <span className={styles.desc}>{description}</span>}
      </div>

      {isExec && command ? (
        <div className={styles.code}>
          <pre className={styles.codeBlock}>{command}</pre>
        </div>
      ) : contentText ? (
        <pre className={styles.content}>{contentText}</pre>
      ) : null}

      <div className={styles.question}>
        {isExec ? `Allow execution of: '${toolName}'?` : 'Apply this change?'}
      </div>

      <div className={styles.options}>
        {request.options.map((option, i) => {
          const isSelected = i === selected;
          return (
            <div
              key={option.id}
              className={`${styles.option} ${isSelected ? styles.optionActive : ''}`}
              onClick={() => confirm(option.id)}
              onMouseEnter={() => setSelected(i)}
            >
              <span className={styles.pointer}>{isSelected ? '›' : ' '}</span>
              <span className={styles.num}>{i + 1}.</span>
              <span className={styles.label}>{option.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
