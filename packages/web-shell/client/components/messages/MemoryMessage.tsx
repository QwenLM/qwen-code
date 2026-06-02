import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useMemory,
  type DaemonContextFileScope,
  type DaemonWorkspaceMemoryFile,
} from '@qwen-code/webui/daemon-react-sdk';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';
import styles from './MemoryMessage.module.css';

export const MEMORY_ACTIVE_EVENT = 'web-shell:memory-panel-active';

type FocusSection =
  | 'autoMemory'
  | 'autoDream'
  | 'autoSkill'
  | 'list'
  | 'detail';
type MemoryTarget = 'global' | 'workspace' | 'managed';

interface MemoryMessageProps {
  refreshSignal?: number;
  addSignal?: number;
  addScope?: DaemonContextFileScope;
  portalHost?: HTMLElement | null;
  onMessage?: (message: string, type?: 'status' | 'error') => void;
  onClose: () => void;
}

interface MemoryItem {
  label: string;
  value: MemoryTarget;
  description?: string;
  file?: DaemonWorkspaceMemoryFile;
}

function fileForScope(
  files: readonly DaemonWorkspaceMemoryFile[],
  scope: 'global' | 'workspace',
): DaemonWorkspaceMemoryFile | undefined {
  return files.find((file) => file.scope === scope);
}

function describeFile(
  file: DaemonWorkspaceMemoryFile | undefined,
  fallbackPath: string,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const path = file?.path ?? fallbackPath;
  return t('memory.savedIn', { path });
}

function isDisabledMemoryItem(item: MemoryItem | undefined): boolean {
  return item?.value === 'managed';
}

function scopeLabel(
  scope: DaemonContextFileScope,
  t: ReturnType<typeof useI18n>['t'],
): string {
  return scope === 'global' ? t('memory.global') : t('memory.project');
}

export function MemoryMessage({
  refreshSignal = 0,
  addSignal = 0,
  addScope = 'workspace',
  portalHost,
  onMessage,
  onClose,
}: MemoryMessageProps) {
  const { t } = useI18n();
  const panelIdRef = useRef(`memory-${Math.random().toString(36).slice(2)}`);
  const { files, loading, error, readFile, reload, writeMemory } = useMemory({
    autoLoad: true,
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [focusedSection, setFocusedSection] = useState<FocusSection>('list');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [closed, setClosed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [detailFile, setDetailFile] =
    useState<DaemonWorkspaceMemoryFile | null>(null);
  const [detailContent, setDetailContent] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editScope, setEditScope] =
    useState<DaemonContextFileScope>('workspace');
  const [editLoading, setEditLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addMode, setAddMode] = useState(false);

  const emitActive = useCallback((active: boolean) => {
    window.dispatchEvent(
      new CustomEvent(MEMORY_ACTIVE_EVENT, {
        detail: { id: panelIdRef.current, active },
      }),
    );
  }, []);

  useEffect(() => {
    emitActive(!closed);
    return () => emitActive(false);
  }, [closed, emitActive]);

  useEffect(() => {
    if (error) setMessage(error.message);
  }, [error]);

  useEffect(() => {
    if (refreshSignal <= 0) return;
    reload()
      .then(() => setMessage(t('memory.refreshed')))
      .catch((refreshError: unknown) => {
        setMessage(
          refreshError instanceof Error
            ? refreshError.message
            : String(refreshError),
        );
      });
  }, [refreshSignal, reload, t]);

  useEffect(() => {
    if (addSignal <= 0) return;
    setFocusedSection('list');
    setSelectedIdx(addScope === 'global' ? 0 : 1);
    setMessage(null);
    setAddMode(true);
  }, [addScope, addSignal]);

  const globalFile = fileForScope(files, 'global');
  const workspaceFile = fileForScope(files, 'workspace');

  const items = useMemo<MemoryItem[]>(
    () => [
      {
        label: t('memory.global'),
        value: 'global',
        description: describeFile(globalFile, '~/.qwen/QWEN.md', t),
        file: globalFile,
      },
      {
        label: t('memory.project'),
        value: 'workspace',
        description: describeFile(workspaceFile, 'QWEN.md', t),
        file: workspaceFile,
      },
      {
        label: t('memory.autoFolder'),
        value: 'managed',
      },
    ],
    [globalFile, t, workspaceFile],
  );

  const handleClose = useCallback(() => {
    setClosed(true);
    onClose();
  }, [onClose]);

  const openFile = useCallback(
    (file: DaemonWorkspaceMemoryFile | undefined, target: MemoryTarget) => {
      setMessage(null);
      if (target === 'managed') {
        const text = t('memory.openFolderUnsupported');
        setMessage(text);
        onMessage?.(text, 'status');
        return;
      }
      if (!file) {
        const text = t('memory.noFiles');
        setMessage(text);
        return;
      }
      setDetailFile(file);
      setDetailContent('');
      setFocusedSection('detail');
      setDetailLoading(true);
      readFile(file.path)
        .then((result) => {
          setDetailContent(result.content);
        })
        .catch((readError: unknown) => {
          const text =
            readError instanceof Error ? readError.message : String(readError);
          setDetailContent(text);
        })
        .finally(() => setDetailLoading(false));
    },
    [onMessage, readFile, t],
  );

  const openEditor = useCallback(
    (scope: DaemonContextFileScope) => {
      const file = fileForScope(files, scope);
      setEditScope(scope);
      setEditContent('');
      setMessage(null);
      setAddMode(false);
      setEditOpen(true);
      requestAnimationFrame(() => textareaRef.current?.focus());

      if (!file) return;

      setEditLoading(true);
      readFile(file.path)
        .then((result) => {
          setEditContent(result.content);
          if (result.truncated) {
            setMessage(t('memory.fileTruncated'));
          }
          requestAnimationFrame(() => textareaRef.current?.focus());
        })
        .catch((readError: unknown) => {
          const text =
            readError instanceof Error ? readError.message : String(readError);
          setMessage(text);
          onMessage?.(text, 'error');
        })
        .finally(() => setEditLoading(false));
    },
    [files, onMessage, readFile, t],
  );

  const triggerSelected = useCallback(
    (index = selectedIdx) => {
      const item = items[index];
      if (!item) return;
      if (isDisabledMemoryItem(item)) return;
      if (addMode) {
        if (item.value === 'global' || item.value === 'workspace') {
          openEditor(item.value);
        }
        return;
      }
      openFile(item.file, item.value);
    },
    [addMode, items, openEditor, openFile, selectedIdx],
  );

  const closeEditor = useCallback(() => {
    setEditOpen(false);
    setEditContent('');
    setMessage(null);
    setEditLoading(false);
  }, []);

  const saveMemory = useCallback(() => {
    const content = editContent;
    if (!content.trim()) {
      setMessage(t('memory.contentEmpty'));
      return;
    }
    setSaving(true);
    setMessage(null);
    writeMemory({ scope: editScope, mode: 'replace', content })
      .then((result) => {
        const savedMessage = t('memory.saved', {
          scope: scopeLabel(editScope, t),
          bytes: result.bytesWritten,
          path: result.filePath,
        });
        setEditOpen(false);
        setEditContent('');
        setMessage(savedMessage);
        onMessage?.(savedMessage, 'status');
        reload().catch(() => undefined);
      })
      .catch((saveError: unknown) => {
        const text =
          saveError instanceof Error ? saveError.message : String(saveError);
        setMessage(text);
        onMessage?.(text, 'error');
      })
      .finally(() => setSaving(false));
  }, [editContent, editScope, onMessage, reload, t, writeMemory]);

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
      if (closed) return;
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      const editingText =
        target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT';

      const claim = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (e.key === 'Escape') {
        claim();
        if (editOpen) {
          closeEditor();
        } else if (focusedSection === 'detail') {
          setFocusedSection('list');
          setDetailFile(null);
          setDetailContent('');
          setMessage(null);
        } else {
          handleClose();
        }
        return;
      }

      if (editOpen) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          claim();
          if (!saving) saveMemory();
        }
        return;
      }

      if (editingText) return;

      if (focusedSection === 'autoMemory') {
        if (e.key === 'ArrowDown' || e.key === 'j') {
          claim();
          setFocusedSection('autoDream');
        } else if (e.key === 'Enter') {
          claim();
        }
        return;
      }

      if (focusedSection === 'autoDream') {
        if (e.key === 'ArrowUp' || e.key === 'k') {
          claim();
          setFocusedSection('autoMemory');
        } else if (e.key === 'ArrowDown' || e.key === 'j') {
          claim();
          setFocusedSection('autoSkill');
        } else if (e.key === 'Enter') {
          claim();
        }
        return;
      }

      if (focusedSection === 'autoSkill') {
        if (e.key === 'ArrowUp' || e.key === 'k') {
          claim();
          setFocusedSection('autoDream');
        } else if (e.key === 'ArrowDown' || e.key === 'j') {
          claim();
          setFocusedSection('list');
          setSelectedIdx(0);
        } else if (e.key === 'Enter') {
          claim();
        }
        return;
      }

      if (focusedSection === 'detail') return;

      if (e.key === 'ArrowUp' || e.key === 'k') {
        claim();
        if (selectedIdx === 0) setFocusedSection('autoSkill');
        else setSelectedIdx((idx) => Math.max(idx - 1, 0));
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'j') {
        claim();
        setSelectedIdx((idx) => (idx + 1) % items.length);
        return;
      }

      if (e.key === 'Enter') {
        claim();
        triggerSelected();
        return;
      }

      if (/^[1-9]$/.test(e.key)) {
        claim();
        const nextIdx = Number(e.key) - 1;
        if (nextIdx >= items.length) return;
        setFocusedSection('list');
        setSelectedIdx(nextIdx);
        if (!isDisabledMemoryItem(items[nextIdx])) {
          triggerSelected(nextIdx);
        }
      }
    },
    [
      closed,
      focusedSection,
      handleClose,
      closeEditor,
      addMode,
      editOpen,
      items.length,
      items,
      saveMemory,
      saving,
      selectedIdx,
      triggerSelected,
    ],
  );

  if (closed) {
    return (
      <div className={styles.panel}>
        <div className={styles.secondary}>{t('memory.closed')}</div>
      </div>
    );
  }

  const autoMemorySelected = focusedSection === 'autoMemory';
  const autoDreamSelected = focusedSection === 'autoDream';
  const autoSkillSelected = focusedSection === 'autoSkill';
  const statusText = message ?? (loading ? t('memory.loading') : null);
  const enabled = t('memory.on');
  const closeDetail = () => {
    setFocusedSection('list');
    setDetailFile(null);
    setDetailContent('');
    setMessage(null);
  };
  const memoryDialogs = (
    <>
      {detailFile ? (
        <>
          <div className={styles.modalBackdrop} onClick={closeDetail} />
          <div
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-label={detailFile.path}
          >
            <div className={styles.modalHeader}>
              <span className={styles.modalTitle}>{detailFile.path}</span>
              <button
                type="button"
                className={styles.closeButton}
                onClick={closeDetail}
              >
                ESC
              </button>
            </div>
            <pre className={styles.content}>
              {detailLoading ? t('memory.loadingFile') : detailContent}
            </pre>
          </div>
        </>
      ) : null}

      {editOpen ? (
        <>
          <div className={styles.modalBackdrop} onClick={closeEditor} />
          <div
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-label={scopeLabel(editScope, t)}
          >
            <div className={styles.modalHeader}>
              <span className={styles.modalTitle}>
                {scopeLabel(editScope, t)}
              </span>
              <button
                type="button"
                className={styles.closeButton}
                onClick={closeEditor}
              >
                ESC
              </button>
            </div>
            <textarea
              ref={textareaRef}
              className={styles.editor}
              value={editContent}
              onChange={(event) => setEditContent(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  closeEditor();
                  return;
                }
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  if (!saving) saveMemory();
                }
              }}
              placeholder={t('memory.placeholder', {
                scope: scopeLabel(editScope, t),
              })}
            />
            <div className={styles.modalFooter}>
              <span>
                {editLoading
                  ? t('memory.loadingFile')
                  : t('dialog.footer.saveClose')}
              </span>
              <button
                type="button"
                className={styles.primaryButton}
                disabled={saving || editLoading}
                onClick={saveMemory}
              >
                {saving ? t('memory.saving') : t('memory.save')}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </>
  );

  return (
    <>
      <div className={styles.panel}>
        <div className={styles.title}>{t('memory.menu')}</div>

        <div className={styles.toggles}>
          <div
            className={`${styles.row} ${styles.disabled} ${
              autoMemorySelected ? styles.selected : ''
            }`}
            onMouseEnter={() => setFocusedSection('autoMemory')}
          >
            <span className={styles.pointer}>
              {autoMemorySelected ? '›' : ' '}
            </span>
            <span className={styles.label}>
              {t('memory.autoMemory', { status: enabled })}
            </span>
          </div>
          <div
            className={`${styles.row} ${styles.disabled} ${
              autoDreamSelected ? styles.selected : ''
            }`}
            onMouseEnter={() => setFocusedSection('autoDream')}
          >
            <span className={styles.pointer}>
              {autoDreamSelected ? '›' : ' '}
            </span>
            <span className={styles.label}>
              {t('memory.autoDream', {
                status: enabled,
                lastDream: t('memory.lastDream'),
              })}
            </span>
          </div>
          <div
            className={`${styles.row} ${styles.disabled} ${
              autoSkillSelected ? styles.selected : ''
            }`}
            onMouseEnter={() => setFocusedSection('autoSkill')}
          >
            <span className={styles.pointer}>
              {autoSkillSelected ? '›' : ' '}
            </span>
            <span className={styles.label}>
              {t('memory.autoSkill', { status: enabled })}
            </span>
          </div>
        </div>

        {error && <div className={styles.error}>{error.message}</div>}
        {statusText && <div className={styles.secondary}>{statusText}</div>}

        <div className={styles.list}>
          {items.map((item, index) => {
            const selected = focusedSection === 'list' && index === selectedIdx;
            const disabled = isDisabledMemoryItem(item);
            return (
              <div
                key={item.value}
                className={`${styles.row} ${disabled ? styles.disabled : ''} ${
                  selected ? styles.selected : ''
                }`}
                onClick={() => {
                  if (!disabled) triggerSelected(index);
                }}
                onMouseEnter={() => {
                  setFocusedSection('list');
                  setSelectedIdx(index);
                }}
              >
                <span className={styles.pointer}>{selected ? '›' : ' '}</span>
                <span className={styles.label}>
                  {index + 1}. {item.label}
                </span>
                {item.description ? (
                  <span className={styles.description}>{item.description}</span>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className={styles.shortcuts}>
          {detailFile ? t('memory.footer.back') : t('memory.footer')}
        </div>
      </div>
      {portalHost ? createPortal(memoryDialogs, portalHost) : null}
    </>
  );
}
