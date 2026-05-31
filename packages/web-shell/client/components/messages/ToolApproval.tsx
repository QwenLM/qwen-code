import { useState, useEffect, useCallback, useRef } from 'react';
import type { PermissionRequest } from '../../adapters/types';
import { useI18n } from '../../i18n';
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

function getSafeDefaultIndex(options: PermissionRequest['options']): number {
  if (
    options.length > 1 &&
    (options[0].kind === 'allow_always' || options[0].kind === 'reject_always')
  ) {
    const saferIdx = options.findIndex(
      (o) => o.kind === 'allow_once' || o.kind === 'reject_once',
    );
    return saferIdx >= 0 ? saferIdx : 1;
  }
  return 0;
}

function getOptionI18nKey(
  option: PermissionRequest['options'][number],
): string | undefined {
  if (option.kind === 'allow_once') return 'approval.option.allowOnce';
  if (option.kind === 'reject_once') return 'approval.option.rejectOnce';
  if (option.kind === 'allow_always') {
    if (option.id === 'proceed_always_project')
      return 'approval.option.allowAlwaysProject';
    if (option.id === 'proceed_always_user')
      return 'approval.option.allowAlwaysUser';
    if (option.id === 'proceed_always') return 'approval.option.allowAllEdits';
  }
  return undefined;
}

export function ToolApproval({ request, onConfirm }: ToolApprovalProps) {
  const { t } = useI18n();
  const [selected, setSelected] = useState(() =>
    getSafeDefaultIndex(request.options),
  );
  const requestRef = useRef(request);
  requestRef.current = request;
  const selectedRef = useRef(selected);
  const submittedRef = useRef(false);
  const interactedRef = useRef(false);

  useEffect(() => {
    const safeDefaultIndex = getSafeDefaultIndex(requestRef.current.options);
    submittedRef.current = false;
    interactedRef.current = false;
    selectedRef.current = safeDefaultIndex;
    setSelected(safeDefaultIndex);
  }, [request.id]);

  const { toolName, description } = parseTitle(request.title);
  const contentText = extractContentText(request);

  const confirm = useCallback(
    (optionId: string) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      onConfirm(requestRef.current.id, optionId);
    },
    [onConfirm],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableTarget(e.target)) return;
      const currentRequest = requestRef.current;
      const optCount = currentRequest.options.length;
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        interactedRef.current = true;
        setSelected((s) => {
          const next = (s - 1 + optCount) % optCount;
          selectedRef.current = next;
          return next;
        });
      } else if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        interactedRef.current = true;
        setSelected((s) => {
          const next = (s + 1) % optCount;
          selectedRef.current = next;
          return next;
        });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!interactedRef.current) {
          interactedRef.current = true;
          return;
        }
        const option = currentRequest.options[selectedRef.current];
        if (option) confirm(option.id);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        const reject = currentRequest.options.find(
          (o) => o.kind === 'reject_once' || o.kind === 'reject_always',
        );
        if (reject) confirm(reject.id);
      } else if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        if (idx < optCount) {
          e.preventDefault();
          interactedRef.current = true;
          confirm(currentRequest.options[idx].id);
        }
      }
    },
    [confirm],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      window.addEventListener('keydown', handleKeyDown);
    }, 250);
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
        {isExec
          ? t('approval.execQuestion', { tool: toolName })
          : t('approval.changeQuestion')}
      </div>

      <div className={styles.options}>
        {request.options.map((option, i) => {
          const isSelected = i === selected;
          const i18nKey = getOptionI18nKey(option);
          const label = i18nKey ? t(i18nKey) : option.label;
          return (
            <div
              key={option.id}
              className={`${styles.option} ${isSelected ? styles.optionActive : ''}`}
              onClick={() => confirm(option.id)}
            >
              <span className={styles.pointer}>{isSelected ? '›' : ' '}</span>
              <span className={styles.num}>{i + 1}.</span>
              <span className={styles.label}>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
