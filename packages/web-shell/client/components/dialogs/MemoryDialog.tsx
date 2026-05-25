import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { dp } from './dialogStyles';
import type {
  DaemonContextFileScope,
  DaemonWorkspaceFile,
  DaemonWorkspaceMemoryFile,
  DaemonWorkspaceMemoryStatus,
  DaemonWriteMemoryRequest,
  DaemonWriteMemoryResult,
} from '@qwen-code/sdk/daemon';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';
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
  readFile: (filePath: string) => Promise<DaemonWorkspaceFile>;
  writeMemory: (
    req: DaemonWriteMemoryRequest,
  ) => Promise<DaemonWriteMemoryResult>;
  onMessage?: (message: string, type?: 'status' | 'error') => void;
  onClose: () => void;
}

type MemoryView = 'menu' | 'show' | 'detail' | 'scope' | 'edit';

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

function scopeLabel(
  scope: DaemonContextFileScope,
  t: ReturnType<typeof useI18n>['t'],
): string {
  return scope === 'global' ? t('memory.global') : t('memory.project');
}

export function MemoryDialog({
  initialMode = 'menu',
  loadStatus,
  readFile,
  writeMemory,
  onMessage,
  onClose,
}: MemoryDialogProps) {
  const { t } = useI18n();
  const scopes: ScopeItem[] = useMemo(
    () => [
      {
        label: t('memory.global'),
        description: t('memory.global.desc'),
        scope: 'global',
      },
      {
        label: t('memory.project'),
        description: t('memory.project.desc'),
        scope: 'workspace',
      },
    ],
    [t],
  );
  const [view, setView] = useState<MemoryView>(() => initialView(initialMode));
  const [status, setStatus] = useState<DaemonWorkspaceMemoryStatus | null>(
    null,
  );
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [fileIdx, setFileIdx] = useState(0);
  const [selectedFile, setSelectedFile] =
    useState<DaemonWorkspaceMemoryFile | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
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
  const directMode = initialMode !== 'menu';

  const reload = useCallback(
    (successMessage?: string) => {
      setLoading(true);
      loadStatus()
        .then((next) => {
          setStatus(next);
          setFileIdx((idx) =>
            Math.min(idx, Math.max(next.files.length - 1, 0)),
          );
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
    reload(initialMode === 'refresh' ? t('memory.refreshed') : undefined);
  }, [initialMode, reload, t]);

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
    reload(t('memory.refreshed'));
  }, [reload, t]);

  const openFile = useCallback(
    (file: DaemonWorkspaceMemoryFile) => {
      setSelectedFile(file);
      setFileContent('');
      setMessage(null);
      setView('detail');
      if (file.scope === 'global') {
        setFileLoading(false);
        setFileContent(t('memory.globalReadUnsupported'));
        setMessage(t('memory.globalReadUnsupported'));
        return;
      }
      setFileLoading(true);
      readFile(file.path)
        .then((result) => {
          setFileContent(result.content);
          setMessage(
            result.truncated ? t('memory.fileTruncated') : t('memory.fileOpen'),
          );
        })
        .catch((error: unknown) => {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          setFileContent(errorMessage);
          setMessage(errorMessage);
        })
        .finally(() => setFileLoading(false));
    },
    [readFile, t],
  );

  const menuItems = useMemo<MenuItem[]>(
    () => [
      {
        label: t('memory.add'),
        description: t('memory.add.desc'),
        onSelect: openScopePicker,
      },
      {
        label: t('memory.show'),
        description: t('memory.show.desc'),
        onSelect: openShow,
      },
      {
        label: t('memory.refresh'),
        description: t('memory.refresh.desc'),
        onSelect: refreshAndShow,
      },
    ],
    [openScopePicker, openShow, refreshAndShow, t],
  );

  useEffect(() => {
    const activeIndex =
      view === 'scope' ? scopeIdx : view === 'show' ? fileIdx : selectedIdx;
    const el = listRef.current?.children[activeIndex] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [fileIdx, scopeIdx, selectedIdx, view]);

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editingText =
        target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT';
      if (e.key === 'Escape') {
        e.preventDefault();
        if (view === 'detail') {
          setView('show');
          setMessage(null);
        } else if (
          view === 'menu' ||
          directMode ||
          (view === 'edit' && directEditMode)
        ) {
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
            Math.min(idx + 1, Math.max(scopes.length - 1, 0)),
          );
        } else if (view === 'show') {
          setFileIdx((idx) =>
            Math.min(idx + 1, Math.max((status?.files.length ?? 0) - 1, 0)),
          );
        }
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        if (view === 'menu') setSelectedIdx((idx) => Math.max(idx - 1, 0));
        else if (view === 'scope') setScopeIdx((idx) => Math.max(idx - 1, 0));
        else if (view === 'show') setFileIdx((idx) => Math.max(idx - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (view === 'menu') {
          menuItems[selectedIdx]?.onSelect?.();
        } else if (view === 'scope') {
          const nextScope = scopes[scopeIdx]?.scope ?? 'workspace';
          setScope(nextScope);
          setView('edit');
          setMessage(null);
        } else if (view === 'show') {
          const file = status?.files[fileIdx];
          if (file) openFile(file);
        }
      }
    },
    [
      directEditMode,
      directMode,
      fileIdx,
      menuItems,
      onClose,
      openFile,
      scopeIdx,
      scopes,
      selectedIdx,
      status?.files,
      view,
    ],
  );

  const handleSubmit = useCallback(() => {
    const text = content.trim();
    if (!text) {
      setMessage(t('memory.contentEmpty'));
      return;
    }
    setSaving(true);
    setMessage(null);
    writeMemory({ scope, mode: 'append', content: text })
      .then((result) => {
        const savedMessage = t('memory.saved', {
          scope: scopeLabel(scope, t),
          bytes: result.bytesWritten,
          path: result.filePath,
        });
        setContent('');
        onMessage?.(savedMessage);
        if (directEditMode) {
          onClose();
          return;
        }
        setMessage(savedMessage);
        setView('show');
        reload(savedMessage);
      })
      .catch((error: unknown) => {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        setMessage(errorMessage);
        if (directEditMode) {
          onMessage?.(errorMessage, 'error');
        }
      })
      .finally(() => setSaving(false));
  }, [
    content,
    directEditMode,
    onClose,
    onMessage,
    reload,
    scope,
    t,
    writeMemory,
  ]);

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
      ? t('memory.files')
      : view === 'detail'
        ? selectedFile
          ? scopeLabel(selectedFile.scope, t)
          : t('memory.file')
        : view === 'scope'
          ? t('memory.add')
          : view === 'edit'
            ? scopeLabel(scope, t)
            : t('memory.menu');

  return (
    <div className={dp('resume-picker')}>
      <div className={dp('resume-picker-header')}>
        <span className={dp('resume-picker-title')}>{title}</span>
        <span className={dp('resume-picker-count')}>
          {status
            ? `${status.fileCount} files · ${status.totalBytes} bytes`
            : ''}
        </span>
      </div>

      <div className={dp('resume-picker-search')}>
        <span className={dp('resume-picker-search-hint')}>
          {message ||
            (loading
              ? t('memory.loading')
              : view === 'menu'
                ? t('agent.selectAction')
                : view === 'scope'
                  ? t('memory.chooseScope')
                  : view === 'detail'
                    ? fileLoading
                      ? t('memory.loadingFile')
                      : t('memory.fileOpen')
                    : view === 'edit'
                      ? t('memory.write')
                      : t('memory.status'))}
        </span>
      </div>

      <div className={dp('resume-picker-sep')} />

      {view === 'menu' && (
        <div className={dp('resume-picker-list')} ref={listRef}>
          {menuItems.map((item, index) => (
            <div
              key={item.label}
              className={dp(
                'resume-picker-item',
                index === selectedIdx ? 'selected' : undefined,
              )}
              onClick={() => item.onSelect?.()}
              onMouseEnter={() => setSelectedIdx(index)}
            >
              <div className={dp('resume-picker-item-row')}>
                <span className={dp('resume-picker-item-prefix')}>
                  {index === selectedIdx ? '›' : ' '}
                </span>
                <span className={dp('resume-picker-item-title')}>
                  {item.label}
                </span>
              </div>
              <div className={dp('resume-picker-item-meta')}>
                {item.description}
              </div>
            </div>
          ))}
        </div>
      )}

      {view === 'scope' && (
        <div className={dp('resume-picker-list')} ref={listRef}>
          {scopes.map((item, index) => (
            <div
              key={item.scope}
              className={dp(
                'resume-picker-item',
                index === scopeIdx ? 'selected' : undefined,
              )}
              onClick={() => {
                setScope(item.scope);
                setView('edit');
              }}
              onMouseEnter={() => setScopeIdx(index)}
            >
              <div className={dp('resume-picker-item-row')}>
                <span className={dp('resume-picker-item-prefix')}>
                  {index === scopeIdx ? '›' : ' '}
                </span>
                <span className={dp('resume-picker-item-title')}>
                  {item.label}
                </span>
              </div>
              <div className={dp('resume-picker-item-meta')}>
                {item.description}
              </div>
            </div>
          ))}
        </div>
      )}

      {view === 'show' && (
        <div className={dp('resume-picker-list')} ref={listRef}>
          {!loading && status?.files.length === 0 && (
            <div className={dp('resume-picker-empty')}>
              {t('memory.noFiles')}
            </div>
          )}
          {status?.files.map((file, index) => (
            <div
              key={`${file.scope}:${file.path}`}
              className={dp(
                'resume-picker-item',
                index === fileIdx ? 'selected' : undefined,
              )}
              onClick={() => openFile(file)}
              onMouseEnter={() => setFileIdx(index)}
            >
              <div className={dp('resume-picker-item-row')}>
                <span className={dp('resume-picker-item-prefix')}>
                  {index === fileIdx ? '›' : ' '}
                </span>
                <span className={dp('resume-picker-item-title')}>
                  {scopeLabel(file.scope, t)}
                </span>
                <span className={dp('resume-picker-item-badge')}>
                  {file.bytes} bytes
                </span>
              </div>
              <div className={dp('resume-picker-item-meta')}>{file.path}</div>
            </div>
          ))}
        </div>
      )}

      {view === 'detail' && (
        <div className={`${dp('resume-picker-list')} ${styles.filePreview}`}>
          <div className={dp('resume-picker-item', 'selected')}>
            <div className={dp('resume-picker-item-row')}>
              <span className={dp('resume-picker-item-prefix')}>›</span>
              <span className={dp('resume-picker-item-title')}>
                {selectedFile?.path ?? t('memory.file')}
              </span>
              {selectedFile && (
                <span className={dp('resume-picker-item-badge')}>
                  {selectedFile.bytes} bytes
                </span>
              )}
            </div>
          </div>
          <pre className={styles.fileContent}>
            {fileLoading ? t('memory.loadingFile') : fileContent}
          </pre>
        </div>
      )}

      {view === 'edit' && (
        <div
          className={`${dp('dialog-form')} ${styles.editorForm}`}
          onKeyDown={handleEditKeyDown}
        >
          <textarea
            ref={textareaRef}
            className={`${dp('dialog-textarea')} ${styles.editorTextarea}`}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t('memory.placeholder', {
              scope: scopeLabel(scope, t),
            })}
          />
          <button
            className={dp('dialog-primary-button')}
            disabled={saving}
            onClick={handleSubmit}
          >
            {saving ? t('memory.saving') : t('memory.save')}
          </button>
        </div>
      )}

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-footer')}>
        {view === 'edit' && directEditMode
          ? t('dialog.footer.saveClose')
          : view === 'edit'
            ? t('dialog.footer.saveMenu')
            : view === 'detail'
              ? t('dialog.footer.back')
              : view === 'menu' || view === 'scope'
                ? t('dialog.footer.navSelectClose')
                : directMode
                  ? t('dialog.footer.navOpenClose')
                  : t('dialog.footer.navOpenMenu')}
      </div>
    </div>
  );
}
