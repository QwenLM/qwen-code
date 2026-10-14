/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react';
import {
  useAutoMemory,
  useConnection,
  useSettings,
  type DaemonAutoMemoryFile,
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

function formatModifiedAt(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

interface AutoMemoryPanelProps {
  onMessage?: (message: string, type?: 'status' | 'error') => void;
}

export function AutoMemoryPanel({ onMessage }: AutoMemoryPanelProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const {
    status,
    entries,
    loading,
    error,
    readAutoMemoryFile,
    openAutoMemoryFolder,
  } = useAutoMemory({ autoLoad: true });
  const { settings, setValue } = useSettings({ autoLoad: true });

  // Host-local affordance: the daemon opens the folder on ITS host, so the
  // button is only honest when the browser sits on that same machine.
  const localOpenEnabled =
    connection.capabilities?.features?.includes('workspace_local_open') &&
    isLocalDaemon();

  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const loadSeqRef = useRef(0);

  const projectEntries = entries.filter((entry) => entry.scope === 'project');
  const userEntries = entries.filter((entry) => entry.scope === 'user');

  const toggleValue = useCallback(
    (key: string) =>
      settings.find((item) => item.key === key)?.values?.effective === true,
    [settings],
  );

  const handleToggle = (key: string, next: boolean) => {
    setTogglingKey(key);
    setNotice(null);
    setValue('user', key, next)
      .catch((toggleError: unknown) => {
        const text =
          toggleError instanceof Error
            ? toggleError.message
            : String(toggleError);
        setNotice(text);
        onMessage?.(text, 'error');
      })
      .finally(() => setTogglingKey(null));
  };

  const handleOpen = (scope: 'project' | 'user') => {
    const cwd = status?.workspaceCwd;
    if (!cwd) return;
    setNotice(null);
    openAutoMemoryFolder(scope, cwd).catch((openError: unknown) => {
      const text =
        openError instanceof Error ? openError.message : String(openError);
      setNotice(text);
      onMessage?.(text, 'error');
    });
  };

  const handleSelect = (entry: DaemonAutoMemoryFile) => {
    if (entry.path === selectedPath) return;
    const loadSeq = ++loadSeqRef.current;
    setSelectedPath(entry.path);
    setContent(null);
    setTruncated(false);
    setContentError(null);
    setContentLoading(true);
    readAutoMemoryFile(entry.path)
      .then((result) => {
        if (loadSeq !== loadSeqRef.current) return;
        setContent(result.content ?? null);
        setTruncated(result.truncated === true);
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

  const selectedEntry = entries.find((entry) => entry.path === selectedPath);

  const scopeBlock = (
    scope: 'project' | 'user',
    dir: string | undefined,
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
        {dir && <span className={styles.autoScopePath}>{dir}</span>}
        {localOpenEnabled && (
          <button
            type="button"
            className={styles.actionButton}
            onClick={() => handleOpen(scope)}
          >
            {t('memory.openFolder')}
          </button>
        )}
      </header>
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
        {TOGGLES.map((toggle) => (
          <div key={toggle.key} className={styles.autoToggleRow}>
            <Switch
              checked={toggleValue(toggle.key)}
              disabled={togglingKey === toggle.key || settings.length === 0}
              onCheckedChange={(next) => handleToggle(toggle.key, next)}
            />
            <div className={styles.autoToggleText}>
              <span className={styles.autoToggleLabel}>
                {t(toggle.labelKey)}
              </span>
              <span className={styles.autoToggleDesc}>{t(toggle.descKey)}</span>
            </div>
          </div>
        ))}
      </div>

      {(notice || error?.message) && (
        <div className={styles.status}>{notice ?? error?.message}</div>
      )}

      {!status && loading && (
        <div className={styles.status}>{t('memory.loading')}</div>
      )}
      {status && status.entries.length === 0 && !status.initialized && (
        <div className={styles.status}>{t('memory.autoNotInitialized')}</div>
      )}

      {status && scopeBlock('project', status.projectDir, projectEntries)}
      {status && scopeBlock('user', status.userDir, userEntries)}

      {selectedEntry && (
        <div className={styles.detail}>
          <header className={styles.detailHeader}>
            <div className={styles.detailTitleWrap}>
              <div className={styles.detailPath}>{selectedEntry.path}</div>
            </div>
          </header>
          {contentError && <div className={styles.status}>{contentError}</div>}
          <pre className={styles.content}>
            {contentLoading
              ? t('memory.loadingFile')
              : content === null
                ? t('memory.autoContentUnavailable')
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
