/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
// @ts-expect-error types exist in SDK source, not in stale dist
import type {
  DaemonGitLog,
  DaemonGitLogEntry,
  DaemonGitCommitDetail,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { DialogShell } from './DialogShell';
import styles from './GitLogDialog.module.css';

const PAGE_SIZE = 50;

function timeAgo(timestamp: number, now: number, language: string): string {
  const seconds = Math.max(0, Math.floor(now - timestamp));
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  if (seconds < 60) return formatter.format(0, 'second');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return formatter.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatter.format(-hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 7) return formatter.format(-days, 'day');
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return formatter.format(-weeks, 'week');
  const months = Math.floor(days / 30);
  if (months < 12) return formatter.format(-months, 'month');
  return formatter.format(-Math.max(1, Math.floor(days / 365)), 'year');
}

function parseRefs(refs: string): { label: string; isHead: boolean }[] {
  if (!refs) return [];
  return refs
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((r) => {
      const isHead = r.startsWith('HEAD ->');
      const label = isHead ? r.replace('HEAD -> ', '') : r;
      return { label, isHead };
    });
}

function CommitRow({
  entry,
  workspaceCwd,
  now,
}: {
  entry: DaemonGitLogEntry;
  workspaceCwd: string;
  now: number;
}) {
  const { client } = useWorkspace();
  const { language, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<DaemonGitCommitDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  const cancelledRef = useRef(false);

  const copySha = () => {
    void navigator.clipboard
      .writeText(entry.sha)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && detail === null && !loading) {
      setLoading(true);
      setError(false);
      client
        .workspaceByCwd(workspaceCwd)
        // @ts-expect-error workspaceGitCommitDetail exists in SDK source, not in stale dist
        .workspaceGitCommitDetail(entry.sha)
        .then((result: DaemonGitCommitDetail) => {
          if (cancelledRef.current) return;
          setDetail(result);
        })
        .catch(() => {
          if (cancelledRef.current) return;
          setError(true);
        })
        .finally(() => {
          if (cancelledRef.current) return;
          setLoading(false);
        });
    }
  };

  const refs = parseRefs(entry.refs ?? '');
  const isMerge = entry.parents.length > 1;

  let detailBody: ReactNode;
  if (open) {
    if (loading) {
      detailBody = (
        <div className={styles.commitDetail}>
          <span className={styles.fileBinary}>{t('gitLog.loading')}</span>
        </div>
      );
    } else if (error) {
      detailBody = (
        <div className={styles.commitDetail}>
          <span className={styles.detailError}>{t('gitLog.detailError')}</span>
        </div>
      );
    } else if (detail && detail.available) {
      detailBody = (
        <div className={styles.commitDetail}>
          {detail.body && (
            <pre className={styles.commitBody}>{detail.body}</pre>
          )}
          {detail.files && (
            <div className={styles.fileStats}>
              <div className={styles.fileStatHeader}>
                {t('gitLog.files', {
                  count: detail.filesCount ?? 0,
                  added: detail.linesAdded ?? 0,
                  removed: detail.linesRemoved ?? 0,
                })}
              </div>
              {detail.files.map((f: DaemonGitCommitDetail['files'][number]) => (
                <div key={f.path} className={styles.fileStatRow}>
                  {f.isBinary ? (
                    <span className={styles.fileBinary}>~</span>
                  ) : (
                    <span className={styles.statNums}>
                      <span className={styles.statAdd}>+{f.added}</span>
                      <span className={styles.statDel}>−{f.removed}</span>
                    </span>
                  )}
                  <span className={styles.fileStatPath}>{f.path}</span>
                </div>
              ))}
              {(detail.hiddenCount ?? 0) > 0 && (
                <div className={styles.hiddenNote}>
                  {t('gitLog.hidden', { count: detail.hiddenCount ?? 0 })}
                </div>
              )}
            </div>
          )}
        </div>
      );
    } else if (detail && !detail.available) {
      detailBody = (
        <div className={styles.commitDetail}>
          <span className={styles.detailError}>{t('gitLog.detailError')}</span>
        </div>
      );
    }
  }

  return (
    <div className={styles.commitRow}>
      <div className={styles.commitHeader}>
        <button
          type="button"
          className={styles.commitToggle}
          onClick={toggle}
          aria-expanded={open}
        >
          {isMerge && <span className={styles.mergeIcon}>⎇</span>}
          <span className={styles.commitSha} title={entry.sha}>
            {entry.shortSha}
          </span>
          <span className={styles.commitSubject}>{entry.subject}</span>
          {refs.length > 0 && (
            <span className={styles.commitRefs}>
              {refs.map((r) => (
                <span
                  key={r.label}
                  className={`${styles.refTag}${r.isHead ? ` ${styles.refHead}` : ''}`}
                >
                  {r.label}
                </span>
              ))}
            </span>
          )}
          <span className={styles.commitMeta}>
            {entry.authorName} · {timeAgo(entry.authorDate, now, language)}
          </span>
        </button>
        <button
          type="button"
          className={styles.copyBtn}
          onClick={copySha}
          aria-label={t('gitLog.copySha', { sha: entry.shortSha })}
        >
          {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
        </button>
      </div>
      {detailBody}
    </div>
  );
}

export function GitLogContent({
  workspaceCwd,
  onSubtitleChange,
}: {
  workspaceCwd: string;
  onSubtitleChange?: (subtitle: string | undefined) => void;
}) {
  const { client } = useWorkspace();
  const { t } = useI18n();
  const [log, setLog] = useState<DaemonGitLog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [now, setNow] = useState(Date.now() / 1000);
  const nextSkipRef = useRef(0);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setLoadMoreError(false);
    nextSkipRef.current = 0;
    client
      .workspaceByCwd(workspaceCwd)
      // @ts-expect-error workspaceGitLog exists in SDK source, not in stale dist
      .workspaceGitLog(PAGE_SIZE, 0)
      .then((result: DaemonGitCommitDetail) => {
        if (!cancelled) {
          nextSkipRef.current = result.entries.length;
          setLog(result);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, workspaceCwd]);

  const loadMore = useCallback(() => {
    if (!log || loadingMore) return;
    setLoadingMore(true);
    client
      .workspaceByCwd(workspaceCwd)
      // @ts-expect-error workspaceGitLog exists in SDK source, not in stale dist
      .workspaceGitLog(PAGE_SIZE, nextSkipRef.current)
      .then((result: DaemonGitCommitDetail) => {
        nextSkipRef.current += result.entries.length;
        setLog((prev: DaemonGitLog | null) => {
          if (!prev) return result;
          const existing = new Set(
            prev.entries.map((entry: DaemonGitLogEntry) => entry.sha),
          );
          return {
            ...prev,
            entries: [
              ...prev.entries,
              ...result.entries.filter(
                (entry: DaemonGitLogEntry) => !existing.has(entry.sha),
              ),
            ],
            hasMore: result.hasMore,
          };
        });
      })
      .catch(() => {
        setLoadMoreError(true);
      })
      .finally(() => {
        setLoadingMore(false);
      });
  }, [client, workspaceCwd, log, loadingMore]);

  const subtitle = log?.available
    ? t('gitLog.subtitle', { count: log.entries.length })
    : undefined;

  useEffect(() => {
    onSubtitleChange?.(subtitle);
  }, [onSubtitleChange, subtitle]);

  let body: ReactNode;
  if (loading) {
    body = <div className={styles.placeholder}>{t('gitLog.loading')}</div>;
  } else if (error) {
    body = <div className={styles.placeholder}>{t('gitLog.error')}</div>;
  } else if (!log || !log.available) {
    body = <div className={styles.placeholder}>{t('gitLog.unavailable')}</div>;
  } else if (log.entries.length === 0) {
    body = <div className={styles.placeholder}>{t('gitLog.empty')}</div>;
  } else {
    body = (
      <>
        <div className={styles.commitList}>
          {log.entries.map((entry: DaemonGitLogEntry) => (
            <CommitRow
              key={entry.sha}
              entry={entry}
              workspaceCwd={workspaceCwd}
              now={now}
            />
          ))}
        </div>
        {loadMoreError && (
          <div className={styles.placeholder}>{t('gitLog.error')}</div>
        )}
        {log.hasMore && (
          <button
            type="button"
            className={styles.loadMore}
            onClick={() => {
              setLoadMoreError(false);
              loadMore();
            }}
            disabled={loadingMore}
          >
            {loadingMore ? t('gitLog.loadingMore') : t('gitLog.loadMore')}
          </button>
        )}
      </>
    );
  }

  return <div className={styles.content}>{body}</div>;
}

export function GitLogDialog({
  workspaceCwd,
  onClose,
}: {
  workspaceCwd: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <DialogShell
      title={t('gitLog.title')}
      size="xl"
      allowFullscreen
      onClose={onClose}
    >
      <GitLogContent workspaceCwd={workspaceCwd} />
    </DialogShell>
  );
}
