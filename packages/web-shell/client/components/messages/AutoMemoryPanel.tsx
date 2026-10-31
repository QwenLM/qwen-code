/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useAutoMemory,
  useConnection,
  useSettings,
  type DaemonAutoMemoryFile,
  type DaemonSettingDescriptor,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { isLocalDaemon } from '../../config/daemon';
import { useI18n } from '../../i18n';
import { Switch } from '../ui/switch';
import styles from './MemoryMessage.module.css';

const TOGGLES = [
  {
    key: 'memory.enableManagedAutoMemory',
    labelKey: 'memory.enableAutoMemory',
    descKey: 'memory.enableAutoMemory.desc',
  },
  {
    key: 'memory.enableManagedAutoDream',
    labelKey: 'memory.enableAutoDream',
    descKey: 'memory.enableAutoDream.desc',
  },
] as const;

function formatBytes(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1) return `${Math.round(bytes)} B`;
  const mb = kb / 1024;
  if (mb < 1) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

/**
 * True when a scope the panel cannot write (system / managed settings)
 * defines the effective value: neither the workspace nor the user value
 * (nor the default, when both are unset) explains it, so a write here
 * would answer 200 and never take effect.
 */
function isShadowed(descriptor: DaemonSettingDescriptor): boolean {
  const { effective, user, workspace } = descriptor.values;
  const written =
    workspace !== undefined
      ? workspace
      : user !== undefined
        ? user
        : descriptor.default;
  return effective !== written;
}

/** The listing revision an entry's loaded content belongs to. */
function entryRevision(entry: DaemonAutoMemoryFile): string {
  return `${entry.modifiedAt}\0${entry.bytes}`;
}

function formatModifiedAt(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

interface AutoMemoryPanelProps {
  onMessage?: (message: string, type?: 'status' | 'error') => void;
  /** The dialog's `/memory refresh` counter; a real change re-fetches. */
  refreshSignal?: number;
}

export function AutoMemoryPanel({
  onMessage,
  refreshSignal = 0,
}: AutoMemoryPanelProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const {
    status,
    entries,
    loading,
    error,
    readAutoMemoryFile,
    openAutoMemoryFolder,
    // Distinct from the settings `reload` below; this one refreshes the
    // auto-memory listing only.
    reload: reloadAutoMemory,
  } = useAutoMemory({ autoLoad: true });
  const {
    settings,
    setValue,
    reload,
    error: settingsError,
  } = useSettings({ autoLoad: true });

  // Host-local affordance: the daemon opens the folder on ITS host, so the
  // button is only honest when the browser sits on that same machine.
  const localOpenEnabled =
    connection.capabilities?.features?.includes('workspace_local_open') &&
    isLocalDaemon();

  const [togglingKeys, setTogglingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [contentTorn, setContentTorn] = useState(false);
  const loadSeqRef = useRef(0);
  // Revision of the listing entry the shown content was read for; a
  // listing reload that changes it invalidates the content.
  const loadedRevisionRef = useRef<string | null>(null);

  // The dialog's `/memory refresh` bumps `refreshSignal`; the panel already
  // auto-loads on mount, so fire only on a real CHANGE (a ref of the last-seen
  // value), never on the initial paint or a signal set before mount.
  const lastRefreshSignalRef = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal <= 0) return;
    if (refreshSignal === lastRefreshSignalRef.current) return;
    lastRefreshSignalRef.current = refreshSignal;
    reloadAutoMemory();
  }, [refreshSignal, reloadAutoMemory]);

  const projectEntries = entries.filter((entry) => entry.scope === 'project');
  const userEntries = entries.filter((entry) => entry.scope === 'user');
  // `hint` names the root a cell is about (the cell's error text alone
  // may be pathless, e.g. a refused symlinked root).
  const scanErrors = (status?.errors ?? [])
    .filter((cell) => Boolean(cell.error))
    .map((cell) => (cell.hint ? `${cell.error} (${cell.hint})` : cell.error));

  const toggleValue = useCallback(
    (key: string) =>
      settings.find((item) => item.key === key)?.values?.effective === true,
    [settings],
  );

  const handleToggle = (key: string, next: boolean) => {
    setTogglingKeys((current) => new Set(current).add(key));
    setNotice(null);
    // The switch renders values.effective, where a workspace-scope value
    // wins over user. Writing at user scope under an existing workspace
    // value would answer 200 without changing the displayed value, so
    // write the scope that currently defines it (workspace when present,
    // user otherwise).
    const descriptor = settings.find((item) => item.key === key);
    const scope =
      descriptor?.values?.workspace !== undefined ? 'workspace' : 'user';
    setValue(scope, key, next)
      .then(async (result) => {
        // Both toggles are read once at session start: say so instead of
        // letting the running session silently keep the old value.
        if (result?.requiresRestart) setNotice(t('settings.requiresRestart'));
        // Refresh so the controlled switch reflects the persisted value.
        // reload() never rejects; a failed refresh surfaces through the
        // settings error in the status region.
        await reload();
      })
      .catch((toggleError: unknown) => {
        const text =
          toggleError instanceof Error
            ? toggleError.message
            : String(toggleError);
        setNotice(text);
        onMessage?.(text, 'error');
      })
      .finally(() => {
        setTogglingKeys((current) => {
          const done = new Set(current);
          done.delete(key);
          return done;
        });
      });
  };

  const handleOpen = (scope: 'project' | 'user', dir?: string) => {
    const cwd = status?.workspaceCwd;
    if (!cwd) return;
    setNotice(null);
    openAutoMemoryFolder(scope, cwd, dir).catch((openError: unknown) => {
      const text =
        openError instanceof Error ? openError.message : String(openError);
      setNotice(text);
      onMessage?.(text, 'error');
    });
  };

  const readEntry = (entry: DaemonAutoMemoryFile) => {
    // Every read bumps the staleness token: a late response must never
    // overwrite a newer selection or a newer read of the same entry.
    const loadSeq = ++loadSeqRef.current;
    loadedRevisionRef.current = entryRevision(entry);
    setSelectedPath(entry.path);
    setContent(null);
    setTruncated(false);
    setContentError(null);
    setContentTorn(false);
    setContentLoading(true);
    readAutoMemoryFile(entry.path)
      .then((result) => {
        if (loadSeq !== loadSeqRef.current) return;
        setContent(result.content ?? null);
        setTruncated(result.truncated === true);
        setContentTorn(result.contentUnavailable === 'torn');
      })
      .catch((readError: unknown) => {
        if (loadSeq !== loadSeqRef.current) return;
        setContentError(
          readError instanceof Error ? readError.message : String(readError),
        );
      })
      .finally(() => {
        if (loadSeq === loadSeqRef.current) setContentLoading(false);
      });
  };

  const handleSelect = (entry: DaemonAutoMemoryFile) => {
    // Only a re-select of an entry whose content actually loaded is a
    // no-op: a failed or content-less read (e.g. a torn read, which is
    // retryable) re-reads.
    if (entry.path === selectedPath && !contentError && content !== null) {
      return;
    }
    readEntry(entry);
  };

  const selectedEntry = entries.find((entry) => entry.path === selectedPath);
  const selectedRevision = selectedEntry
    ? entryRevision(selectedEntry)
    : undefined;

  // The listing reloads under the open pane (memory-changed signal): a
  // changed entry is re-read, a vanished one closes the pane, so the pane
  // never shows content older than the row it sits under.
  useEffect(() => {
    if (!status || selectedPath === null) return;
    if (loadedRevisionRef.current === null) return;
    if (!selectedEntry) {
      ++loadSeqRef.current;
      loadedRevisionRef.current = null;
      setSelectedPath(null);
      setContent(null);
      setTruncated(false);
      setContentError(null);
      setContentTorn(false);
      setContentLoading(false);
      return;
    }
    if (selectedRevision !== loadedRevisionRef.current)
      readEntry(selectedEntry);
    // readEntry/selectedEntry are derived from the deps below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, selectedPath, selectedRevision]);

  // One row per directory. A directory gets an Open button only when the
  // listing says it exists (`openable`): opening an absent root answers
  // 404 for a click the panel itself offered.
  const dirRow = (
    scope: 'project' | 'user',
    dir: string,
    openable: boolean,
  ) => (
    <>
      <span className={styles.autoScopePath}>{dir}</span>
      {localOpenEnabled && openable && (
        <button
          type="button"
          className={styles.actionButton}
          onClick={() =>
            handleOpen(scope, scope === 'project' ? dir : undefined)
          }
        >
          {t('memory.openFolder')}
        </button>
      )}
    </>
  );

  const scopeBlock = (
    scope: 'project' | 'user',
    dirs: ReadonlyArray<{ dir: string; openable: boolean }>,
    list: DaemonAutoMemoryFile[],
  ) => (
    <div className={styles.autoScope} key={scope}>
      <header className={styles.autoScopeHeader}>
        <span className={styles.autoScopeTitle}>
          {t(
            scope === 'project'
              ? 'memory.autoProjectScope'
              : 'memory.autoUserScope',
          )}
        </span>
        <span className={styles.autoScopeMeta}>
          {list.length} ·{' '}
          {formatBytes(list.reduce((sum, entry) => sum + entry.bytes, 0))}
        </span>
        {dirs[0] && dirRow(scope, dirs[0].dir, dirs[0].openable)}
      </header>
      {dirs.slice(1).map(({ dir, openable }) => (
        <div className={styles.autoScopeDir} key={dir}>
          {dirRow(scope, dir, openable)}
        </div>
      ))}
      {list.length === 0 ? (
        <div className={styles.status}>{t('memory.autoEmpty')}</div>
      ) : (
        <ul className={styles.autoList}>
          {list.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className={`${styles.autoEntry} ${
                  entry.path === selectedPath ? styles.autoEntryActive : ''
                }`}
                onClick={() => handleSelect(entry)}
              >
                <span className={styles.autoEntryTitle}>{entry.title}</span>
                {entry.description && (
                  <span className={styles.autoEntryDesc}>
                    {entry.description}
                  </span>
                )}
                <span className={styles.autoEntryMeta}>
                  {entry.type ? `${entry.type} · ` : ''}
                  {formatBytes(entry.bytes)}
                  {entry.modifiedAt
                    ? ` · ${formatModifiedAt(entry.modifiedAt)}`
                    : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <section className={styles.autoSection}>
      <div className={styles.autoToggles}>
        {TOGGLES.map((toggle) => {
          const descriptor = settings.find((item) => item.key === toggle.key);
          const managed = descriptor !== undefined && isShadowed(descriptor);
          return (
            <div key={toggle.key} className={styles.autoToggleRow}>
              <Switch
                aria-label={t(toggle.labelKey)}
                checked={toggleValue(toggle.key)}
                disabled={
                  togglingKeys.has(toggle.key) ||
                  descriptor === undefined ||
                  managed
                }
                onCheckedChange={(next) => handleToggle(toggle.key, next)}
              />
              <div className={styles.autoToggleText}>
                <span className={styles.autoToggleLabel}>
                  {t(toggle.labelKey)}
                </span>
                <span className={styles.autoToggleDesc}>
                  {t(toggle.descKey)}
                </span>
                {managed && (
                  <span className={styles.autoToggleDesc}>
                    {t('memory.autoToggleManaged')}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div role="status" aria-live="polite">
        {(notice ||
          error?.message ||
          settingsError?.message ||
          scanErrors.length > 0) && (
          <div className={styles.status}>
            {notice ??
              error?.message ??
              settingsError?.message ??
              scanErrors.join('; ')}
          </div>
        )}
      </div>

      {!status && loading && (
        <div className={styles.status}>{t('memory.loading')}</div>
      )}
      {status && status.entries.length === 0 && !status.initialized && (
        <div className={styles.status}>{t('memory.autoNotInitialized')}</div>
      )}

      {status &&
        scopeBlock(
          'project',
          status.projectDirs.length > 0
            ? status.projectDirs.map((dir) => ({ dir, openable: true }))
            : [{ dir: status.projectDir, openable: false }],
          projectEntries,
        )}
      {status &&
        scopeBlock(
          'user',
          [{ dir: status.userDir, openable: status.userDirExists }],
          userEntries,
        )}

      {selectedEntry && (
        <div className={styles.detail}>
          <header className={styles.detailHeader}>
            <div className={styles.detailTitleWrap}>
              <div className={styles.detailPath}>{selectedEntry.path}</div>
            </div>
          </header>
          {/* Read outcomes are announced like the toggle/open ones; only
              this pane's messages live here, so nothing is announced twice. */}
          <div role="status" aria-live="polite">
            {contentError && (
              <div className={styles.status}>{contentError}</div>
            )}
          </div>
          <pre className={styles.content}>
            {contentLoading
              ? t('memory.loadingFile')
              : content === null
                ? t(
                    contentTorn
                      ? 'memory.autoContentChanged'
                      : 'memory.autoContentUnavailable',
                  )
                : content}
          </pre>
          {truncated && (
            <div className={styles.status}>{t('memory.autoTruncated')}</div>
          )}
        </div>
      )}
    </section>
  );
}
