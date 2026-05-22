import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type {
  DaemonContextFileScope,
  DaemonWorkspaceMemoryStatus,
  DaemonWriteMemoryRequest,
  DaemonWriteMemoryResult,
} from '@qwen-code/sdk/daemon';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import styles from './MemoryDialog.module.css';

export type MemoryDialogInitialMode =
  | 'menu'
  | 'show'
  | 'refresh'
  | 'add'
  | 'add-user'
  | 'add-project';

interface MemoryDialogProps {
  initialMode?: MemoryDialogInitialMode;
  loadStatus: () => Promise<DaemonWorkspaceMemoryStatus>;
  writeMemory: (
    req: DaemonWriteMemoryRequest,
  ) => Promise<DaemonWriteMemoryResult>;
  onClose: () => void;
}

type MemoryView = 'menu' | 'show' | 'scope' | 'edit';

interface MenuItem {
  label: string;
  description: string;
  onSelect?: () => void;
}

interface ScopeItem {
  label: string;
  description: string;
  scope: DaemonContextFileScope;
}

const SCOPES: ScopeItem[] = [
  {
    label: 'User memory',
    description: 'Saved to the global user memory file',
    scope: 'global',
  },
  {
    label: 'Project memory',
    description: 'Saved to this workspace memory file',
    scope: 'workspace',
  },
];

function initialView(mode: MemoryDialogInitialMode): MemoryView {
  if (mode === 'show' || mode === 'refresh') return 'show';
  if (mode === 'add-user' || mode === 'add-project') return 'edit';
  if (mode === 'add') return 'scope';
  return 'menu';
}

function initialScope(mode: MemoryDialogInitialMode): DaemonContextFileScope {
  if (mode === 'add-user') return 'global';
  return 'workspace';
}

function scopeLabel(scope: DaemonContextFileScope): string {
  return scope === 'global' ? 'User memory' : 'Project memory';
}

export function MemoryDialog({
  initialMode = 'menu',
  loadStatus,
  writeMemory,
  onClose,
}: MemoryDialogProps) {
  const [view, setView] = useState<MemoryView>(() => initialView(initialMode));
  const [status, setStatus] = useState<DaemonWorkspaceMemoryStatus | null>(
    null,
  );
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [scopeIdx, setScopeIdx] = useState(
    initialScope(initialMode) === 'global' ? 0 : 1,
  );
  const [scope, setScope] = useState<DaemonContextFileScope>(() =>
    initialScope(initialMode),
  );
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const directEditMode =
    initialMode === 'add-user' || initialMode === 'add-project';

  const reload = useCallback(
    (successMessage?: string) => {
      setLoading(true);
      loadStatus()
        .then((next) => {
          setStatus(next);
          setMessage(successMessage ?? null);
        })
        .catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setLoading(false));
    },
    [loadStatus],
  );

  useEffect(() => {
    reload(initialMode === 'refresh' ? 'Memory refreshed.' : undefined);
  }, [initialMode, reload]);

  useEffect(() => {
    if (view === 'edit') {
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [view]);

  const openScopePicker = useCallback(() => {
    setView('scope');
    setScopeIdx(scope === 'global' ? 0 : 1);
    setMessage(null);
  }, [scope]);

  const openShow = useCallback(() => {
    setView('show');
    setMessage(null);
  }, []);

  const refreshAndShow = useCallback(() => {
    setView('show');
    reload('Memory refreshed.');
  }, [reload]);

  const menuItems = useMemo<MenuItem[]>(
    () => [
      {
        label: 'Add',
        description: 'Write a durable memory',
        onSelect: openScopePicker,
      },
      {
        label: 'Show',
        description: 'Show configured memory files',
        onSelect: openShow,
      },
      {
        label: 'Refresh',
        description: 'Reload memory file information',
        onSelect: refreshAndShow,
      },
    ],
    [openScopePicker, openShow, refreshAndShow],
  );

  useEffect(() => {
    const activeIndex = view === 'scope' ? scopeIdx : selectedIdx;
    const el = listRef.current?.children[activeIndex] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [scopeIdx, selectedIdx, view]);

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editingText =
        target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT';
      if (e.key === 'Escape') {
        e.preventDefault();
        if (view === 'menu' || (view === 'edit' && directEditMode)) {
          onClose();
        } else {
          setView('menu');
          setMessage(null);
        }
        return;
      }
      if (editingText) return;
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        if (view === 'menu') {
          setSelectedIdx((idx) =>
            Math.min(idx + 1, Math.max(menuItems.length - 1, 0)),
          );
        } else if (view === 'scope') {
          setScopeIdx((idx) =>
            Math.min(idx + 1, Math.max(SCOPES.length - 1, 0)),
          );
        }
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        if (view === 'menu') setSelectedIdx((idx) => Math.max(idx - 1, 0));
        else if (view === 'scope') setScopeIdx((idx) => Math.max(idx - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (view === 'menu') {
          menuItems[selectedIdx]?.onSelect?.();
        } else if (view === 'scope') {
          const nextScope = SCOPES[scopeIdx]?.scope ?? 'workspace';
          setScope(nextScope);
          setView('edit');
          setMessage(null);
        }
      }
    },
    [directEditMode, menuItems, onClose, scopeIdx, selectedIdx, view],
  );

  const handleSubmit = useCallback(() => {
    const text = content.trim();
    if (!text) {
      setMessage('Memory content is empty.');
      return;
    }
    setSaving(true);
    setMessage(null);
    writeMemory({ scope, mode: 'append', content: text })
      .then((result) => {
        setContent('');
        if (directEditMode) {
          onClose();
          return;
        }
        setMessage(
          `${scopeLabel(scope)} saved: ${result.bytesWritten} bytes -> ${result.filePath}`,
        );
        setView('show');
        reload(
          `${scopeLabel(scope)} saved: ${result.bytesWritten} bytes -> ${result.filePath}`,
        );
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setSaving(false));
  }, [content, directEditMode, onClose, reload, scope, writeMemory]);

  const handleEditKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!saving) handleSubmit();
      }
    },
    [handleSubmit, saving],
  );

  const title =
    view === 'show'
      ? 'Memory Files'
      : view === 'scope'
        ? 'Add Memory'
        : view === 'edit'
          ? scopeLabel(scope)
          : 'Memory';

  return (
    <div className="resume-picker">
      <div className="resume-picker-header">
        <span className="resume-picker-title">{title}</span>
        <span className="resume-picker-count">
          {status
            ? `${status.fileCount} files · ${status.totalBytes} bytes`
            : ''}
        </span>
      </div>

      <div className="resume-picker-search">
        <span className="resume-picker-search-hint">
          {message ||
            (loading
              ? 'Loading memory...'
              : view === 'menu'
                ? 'Select an action'
                : view === 'scope'
                  ? 'Choose where to save the memory'
                  : view === 'edit'
                    ? 'Write memory content'
                    : 'Workspace and user memory files')}
        </span>
      </div>

      <div className="resume-picker-sep" />

      {view === 'menu' && (
        <div className="resume-picker-list" ref={listRef}>
          {menuItems.map((item, index) => (
            <div
              key={item.label}
              className={`resume-picker-item ${index === selectedIdx ? 'selected' : ''}`}
              onClick={() => item.onSelect?.()}
              onMouseEnter={() => setSelectedIdx(index)}
            >
              <div className="resume-picker-item-row">
                <span className="resume-picker-item-prefix">
                  {index === selectedIdx ? '›' : ' '}
                </span>
                <span className="resume-picker-item-title">{item.label}</span>
              </div>
              <div className="resume-picker-item-meta">{item.description}</div>
            </div>
          ))}
        </div>
      )}

      {view === 'scope' && (
        <div className="resume-picker-list" ref={listRef}>
          {SCOPES.map((item, index) => (
            <div
              key={item.scope}
              className={`resume-picker-item ${index === scopeIdx ? 'selected' : ''}`}
              onClick={() => {
                setScope(item.scope);
                setView('edit');
              }}
              onMouseEnter={() => setScopeIdx(index)}
            >
              <div className="resume-picker-item-row">
                <span className="resume-picker-item-prefix">
                  {index === scopeIdx ? '›' : ' '}
                </span>
                <span className="resume-picker-item-title">{item.label}</span>
              </div>
              <div className="resume-picker-item-meta">{item.description}</div>
            </div>
          ))}
        </div>
      )}

      {view === 'show' && (
        <div className="resume-picker-list">
          {!loading && status?.files.length === 0 && (
            <div className="resume-picker-empty">No memory files found.</div>
          )}
          {status?.files.map((file) => (
            <div
              key={`${file.scope}:${file.path}`}
              className="resume-picker-item"
            >
              <div className="resume-picker-item-row">
                <span className="resume-picker-item-prefix"> </span>
                <span className="resume-picker-item-title">
                  {file.scope === 'global' ? 'User memory' : 'Project memory'}
                </span>
                <span className="resume-picker-item-badge">
                  {file.bytes} bytes
                </span>
              </div>
              <div className="resume-picker-item-meta">{file.path}</div>
            </div>
          ))}
        </div>
      )}

      {view === 'edit' && (
        <div
          className={`dialog-form ${styles.editorForm}`}
          onKeyDown={handleEditKeyDown}
        >
          <textarea
            ref={textareaRef}
            className={`dialog-textarea ${styles.editorTextarea}`}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={`Write ${scopeLabel(scope)} content...`}
          />
          <button
            className="dialog-primary-button"
            disabled={saving}
            onClick={handleSubmit}
          >
            {saving ? 'Saving...' : 'Save Memory'}
          </button>
        </div>
      )}

      <div className="resume-picker-sep" />

      <div className="resume-picker-footer">
        {view === 'edit' && directEditMode
          ? '⌘/Ctrl+Enter to save · Esc to close'
          : view === 'edit'
            ? '⌘/Ctrl+Enter to save · Esc to menu'
            : view === 'menu' || view === 'scope'
              ? '↑↓ to navigate · Enter to select · Esc to close'
              : 'Esc to menu'}
      </div>
    </div>
  );
}
