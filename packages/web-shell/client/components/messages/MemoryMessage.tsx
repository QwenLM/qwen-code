import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useMemory,
  type DaemonContextFileScope,
  type DaemonWorkspaceMemoryFile,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import styles from './MemoryMessage.module.css';

type MemoryMode = 'view' | 'edit';
type MemoryScope = 'global' | 'workspace';

interface MemoryMessageProps {
  refreshSignal?: number;
  addSignal?: number;
  addScope?: DaemonContextFileScope;
  onMessage?: (message: string, type?: 'status' | 'error') => void;
}

interface MemoryEntry {
  scope: MemoryScope;
  title: string;
  description: string;
  fallbackPath: string;
  file?: DaemonWorkspaceMemoryFile;
}

function fileForScope(
  files: readonly DaemonWorkspaceMemoryFile[],
  scope: MemoryScope,
): DaemonWorkspaceMemoryFile | undefined {
  return files.find((file) => file.scope === scope);
}

function scopeLabel(
  scope: MemoryScope,
  t: ReturnType<typeof useI18n>['t'],
): string {
  return scope === 'global' ? t('memory.global') : t('memory.project');
}

export function MemoryMessage({
  refreshSignal = 0,
  addSignal = 0,
  addScope = 'workspace',
  onMessage,
}: MemoryMessageProps) {
  const { t } = useI18n();
  const { files, loading, error, readFile, reload, writeMemory } = useMemory({
    autoLoad: true,
  });
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const loadSeqRef = useRef(0);
  const [selectedScope, setSelectedScope] = useState<MemoryScope>('workspace');
  const [mode, setMode] = useState<MemoryMode>('view');
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [contentLoading, setContentLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const handledAddSignalRef = useRef(0);

  const entries = useMemo<MemoryEntry[]>(() => {
    const globalFile = fileForScope(files, 'global');
    const workspaceFile = fileForScope(files, 'workspace');
    return [
      {
        scope: 'workspace',
        title: t('memory.project'),
        description: t('memory.project.desc'),
        fallbackPath: 'QWEN.md',
        file: workspaceFile,
      },
      {
        scope: 'global',
        title: t('memory.global'),
        description: t('memory.global.desc'),
        fallbackPath: '~/.qwen/QWEN.md',
        file: globalFile,
      },
    ];
  }, [files, t]);

  const selectedEntry =
    entries.find((entry) => entry.scope === selectedScope) ?? entries[0];

  const loadContent = useCallback(
    (entry: MemoryEntry | undefined, nextMode: MemoryMode) => {
      const loadSeq = ++loadSeqRef.current;
      setMode(nextMode);
      setMessage(null);
      setContent('');
      setDraft('');
      if (!entry?.file) {
        if (nextMode === 'edit') {
          requestAnimationFrame(() => editorRef.current?.focus());
        }
        return;
      }
      setContentLoading(true);
      readFile(entry.file.path)
        .then((result) => {
          if (loadSeq !== loadSeqRef.current) return;
          setContent(result.content);
          setDraft(result.content);
          if (result.truncated) setMessage(t('memory.fileTruncated'));
          requestAnimationFrame(() => editorRef.current?.focus());
        })
        .catch((readError: unknown) => {
          if (loadSeq !== loadSeqRef.current) return;
          const text =
            readError instanceof Error ? readError.message : String(readError);
          setMessage(text);
          if (entry.scope !== 'global') onMessage?.(text, 'error');
        })
        .finally(() => {
          if (loadSeq === loadSeqRef.current) setContentLoading(false);
        });
    },
    [onMessage, readFile, t],
  );

  useEffect(() => {
    if (!selectedEntry) return;
    loadContent(selectedEntry, mode);
    // Only reload when the selected file changes. Mode changes are explicit
    // button actions that call loadContent directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEntry?.file?.path, selectedEntry?.scope]);

  useEffect(() => {
    if (error) setMessage(error.message);
  }, [error]);

  useEffect(() => {
    if (refreshSignal <= 0) return;
    reload()
      .then(() => setMessage(t('memory.refreshed')))
      .catch((refreshError: unknown) => {
        const text =
          refreshError instanceof Error
            ? refreshError.message
            : String(refreshError);
        setMessage(text);
        onMessage?.(text, 'error');
      });
  }, [onMessage, refreshSignal, reload, t]);

  useEffect(() => {
    if (addSignal <= 0) return;
    if (handledAddSignalRef.current === addSignal) return;
    handledAddSignalRef.current = addSignal;
    const nextScope = addScope === 'global' ? 'global' : 'workspace';
    setSelectedScope(nextScope);
    const entry = entries.find((item) => item.scope === nextScope);
    loadContent(entry, 'edit');
  }, [addScope, addSignal, entries, loadContent]);

  const handleSelect = (entry: MemoryEntry) => {
    setSelectedScope(entry.scope);
    loadContent(entry, 'view');
  };

  const handleEdit = () => {
    if (!selectedEntry) return;
    loadContent(selectedEntry, 'edit');
  };

  const handleSave = () => {
    if (!selectedEntry) return;
    if (!draft.trim()) {
      setMessage(t('memory.contentEmpty'));
      return;
    }
    setSaving(true);
    setMessage(null);
    writeMemory({
      scope: selectedEntry.scope,
      mode: 'replace',
      content: draft,
    })
      .then((result) => {
        const savedMessage = t('memory.saved', {
          scope: scopeLabel(selectedEntry.scope, t),
          bytes: result.bytesWritten,
          path: result.filePath,
        });
        setContent(draft);
        setMode('view');
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
  };

  const path = selectedEntry?.file?.path ?? selectedEntry?.fallbackPath ?? '';
  const statusText = message ?? (loading ? t('memory.loading') : null);

  return (
    <div className={styles.page}>
      <nav className={styles.tabs} aria-label={t('memory.menu')}>
        {entries.map((entry) => {
          const active = entry.scope === selectedScope;
          return (
            <button
              key={entry.scope}
              type="button"
              className={`${styles.memoryCard} ${
                active ? styles.memoryCardActive : ''
              }`}
              onClick={() => handleSelect(entry)}
            >
              <span className={styles.memoryTitle}>{entry.title}</span>
            </button>
          );
        })}
      </nav>

      <section className={styles.detail}>
        <header className={styles.detailHeader}>
          <div className={styles.detailTitleWrap}>
            <div className={styles.detailPath}>{path}</div>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.actionButton}
              onClick={handleEdit}
            >
              {t('settings.action.edit')}
            </button>
          </div>
        </header>

        {statusText && <div className={styles.status}>{statusText}</div>}

        {mode === 'edit' ? (
          <>
            <textarea
              ref={editorRef}
              className={styles.editor}
              value={draft}
              disabled={saving || contentLoading}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t('memory.placeholder', {
                scope: selectedEntry ? scopeLabel(selectedEntry.scope, t) : '',
              })}
            />
            <div className={styles.editorFooter}>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={saving}
                onClick={() => {
                  setDraft(content);
                  setMode('view');
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                disabled={saving || contentLoading}
                onClick={handleSave}
              >
                {saving ? t('memory.saving') : t('memory.save')}
              </button>
            </div>
          </>
        ) : (
          <pre className={styles.content}>
            {contentLoading
              ? t('memory.loadingFile')
              : content || t('memory.noFiles')}
          </pre>
        )}
      </section>
    </div>
  );
}
