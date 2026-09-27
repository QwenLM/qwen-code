/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CheckIcon, CopyIcon, SearchIcon } from 'lucide-react';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import type {
  DaemonGitLog,
  DaemonGitLogEntry,
  DaemonGitCommitDetail,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import {
  warnClipboardWriteFailure,
  writeClipboardText,
} from '../../utils/clipboard';
import { useCopiedFlash } from '../../hooks/useCopiedFlash';
import { timeAgo } from '../../utils/timeAgo';
import {
  layoutCommitGraph,
  type CommitGraphRow,
} from '../../utils/commitGraph';
import { DialogShell } from './DialogShell';
import styles from './GitLogDialog.module.css';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

const LANE_WIDTH = 12;
/** Lanes past this share the last column so a busy graph cannot crowd out the subject. */
const MAX_LANES = 20;
const LANE_COLORS = [
  '#2f81f7',
  '#e3742f',
  '#3fb950',
  '#a371f7',
  '#f778ba',
  '#39c5cf',
  '#d29922',
  '#8b949e',
];

function laneX(column: number): number {
  return Math.min(column, MAX_LANES - 1) * LANE_WIDTH + LANE_WIDTH / 2;
}

function laneColor(color: number): string {
  return LANE_COLORS[color % LANE_COLORS.length];
}

/** Node and connecting curves for one commit row; stretched to the row height. */
function CommitGraphCell({
  row,
  width,
  isMerge,
}: {
  row: CommitGraphRow;
  width: number;
  isMerge: boolean;
}) {
  const x = laneX(row.column);
  const paths: ReactNode[] = [];
  row.through.forEach((line) => {
    const lx = laneX(line.column);
    paths.push(
      <path
        key={`t${line.column}`}
        d={`M${lx},0 V100`}
        stroke={laneColor(line.color)}
      />,
    );
  });
  row.incoming.forEach((line) => {
    const lx = laneX(line.column);
    paths.push(
      <path
        key={`i${line.column}`}
        d={lx === x ? `M${x},0 V50` : `M${lx},0 C${lx},50 ${x},0 ${x},50`}
        stroke={laneColor(line.color)}
      />,
    );
  });
  row.outgoing.forEach((line) => {
    const lx = laneX(line.column);
    paths.push(
      <path
        key={`o${line.column}`}
        d={lx === x ? `M${x},50 V100` : `M${x},50 C${x},100 ${lx},50 ${lx},100`}
        stroke={laneColor(line.color)}
      />,
    );
  });
  const color = laneColor(row.color);
  return (
    <span
      className={styles.graph}
      style={{ width }}
      aria-hidden="true"
      data-testid="commit-graph"
      data-column={row.column}
    >
      <svg
        viewBox={`0 0 ${width} 100`}
        preserveAspectRatio="none"
        className={styles.graphSvg}
      >
        {paths}
      </svg>
      <span
        className={`${styles.graphNode}${isMerge ? ` ${styles.graphNodeMerge}` : ''}`}
        style={{
          left: x,
          borderColor: color,
          background: isMerge ? undefined : color,
        }}
      />
    </span>
  );
}

/** Lanes that continue below a row, drawn straight through its expanded detail. */
function CommitGraphTail({
  row,
  width,
}: {
  row: CommitGraphRow;
  width: number;
}) {
  return (
    <span
      className={styles.graph}
      style={{ width }}
      aria-hidden="true"
      data-testid="commit-graph-tail"
    >
      <svg
        viewBox={`0 0 ${width} 100`}
        preserveAspectRatio="none"
        className={styles.graphSvg}
      >
        {row.after.map((line) => (
          <path
            key={line.column}
            d={`M${laneX(line.column)},0 V100`}
            stroke={laneColor(line.color)}
          />
        ))}
      </svg>
    </span>
  );
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
  gitCwd,
  now,
  graph,
  graphWidth,
}: {
  entry: DaemonGitLogEntry;
  workspaceCwd: string;
  gitCwd?: string;
  now: number;
  graph?: CommitGraphRow;
  graphWidth: number;
}) {
  const { client } = useWorkspace();
  const { language, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<DaemonGitCommitDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [copied, flashCopied] = useCopiedFlash(1500);
  const cancelledRef = useRef(false);

  const copySha = () => {
    void writeClipboardText(entry.sha)
      .then(() => {
        flashCopied();
      })
      .catch(warnClipboardWriteFailure);
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
        .workspaceGitCommitDetail(entry.sha, gitCwd)
        .then((result) => {
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
        <span className={styles.fileBinary}>{t('gitLog.loading')}</span>
      );
    } else if (error || (detail && !detail.available)) {
      detailBody = (
        <span className={styles.detailError}>{t('gitLog.detailError')}</span>
      );
    } else if (detail) {
      detailBody = (
        <>
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
              {detail.files.map((f) => (
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
        </>
      );
    }
  }

  return (
    <div className={styles.commitRow}>
      <div className={styles.commitHeader}>
        {graph && (
          <CommitGraphCell row={graph} width={graphWidth} isMerge={isMerge} />
        )}
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
      {detailBody !== undefined && (
        <div className={styles.detailRow}>
          {graph && <CommitGraphTail row={graph} width={graphWidth} />}
          <div className={styles.commitDetail}>{detailBody}</div>
        </div>
      )}
    </div>
  );
}

export function GitLogContent({
  workspaceCwd,
  gitCwd,
  onSubtitleChange,
}: {
  workspaceCwd: string;
  gitCwd?: string;
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
  const [allBranches, setAllBranches] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const nextSkipRef = useRef(0);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === query) return;
    const id = setTimeout(() => setQuery(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search, query]);

  const fetchPage = useCallback(
    (skip: number) =>
      client
        .workspaceByCwd(workspaceCwd)
        .workspaceGitLog(PAGE_SIZE, skip, gitCwd, undefined, {
          all: allBranches,
          search: query || undefined,
        }),
    [client, workspaceCwd, gitCwd, allBranches, query],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setLoadMoreError(false);
    nextSkipRef.current = 0;
    fetchPage(0)
      .then((result) => {
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
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (!log || loadingMore) return;
    setLoadingMore(true);
    fetchPage(nextSkipRef.current)
      .then((result) => {
        nextSkipRef.current += result.entries.length;
        setLog((prev) => {
          if (!prev) return result;
          const existing = new Set(prev.entries.map((entry) => entry.sha));
          return {
            ...prev,
            entries: [
              ...prev.entries,
              ...result.entries.filter((entry) => !existing.has(entry.sha)),
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
  }, [fetchPage, log, loadingMore]);

  const subtitle = log?.available
    ? t('gitLog.subtitle', { count: log.entries.length })
    : undefined;

  useEffect(() => {
    onSubtitleChange?.(subtitle);
  }, [onSubtitleChange, subtitle]);

  // Search results are not contiguous history, so lanes would mislead.
  const graph = useMemo(
    () => (log && !query ? layoutCommitGraph(log.entries) : undefined),
    [log, query],
  );
  const graphWidth = graph
    ? Math.min(
        graph.reduce((max, row) => Math.max(max, row.width), 1),
        MAX_LANES,
      ) * LANE_WIDTH
    : 0;

  let body: ReactNode;
  if (loading) {
    body = <div className={styles.placeholder}>{t('gitLog.loading')}</div>;
  } else if (error) {
    body = <div className={styles.placeholder}>{t('gitLog.error')}</div>;
  } else if (!log || !log.available) {
    body = <div className={styles.placeholder}>{t('gitLog.unavailable')}</div>;
  } else if (log.entries.length === 0) {
    body = (
      <div className={styles.placeholder}>
        {t(query ? 'gitLog.noMatches' : 'gitLog.empty')}
      </div>
    );
  } else {
    body = (
      <>
        <div className={styles.commitList}>
          {log.entries.map((entry, index) => (
            <CommitRow
              key={entry.sha}
              entry={entry}
              workspaceCwd={workspaceCwd}
              gitCwd={gitCwd}
              now={now}
              graph={graph?.[index]}
              graphWidth={graphWidth}
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

  return (
    <div className={styles.content}>
      <div className={styles.toolbar}>
        <label className={styles.search}>
          <SearchIcon size={13} />
          <input
            className={styles.searchInput}
            type="search"
            placeholder={t('gitLog.search')}
            aria-label={t('gitLog.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <button
          type="button"
          className={`${styles.toggle}${allBranches ? ` ${styles.toggleOn}` : ''}`}
          aria-pressed={allBranches}
          data-testid="git-log-all-branches"
          onClick={() => setAllBranches((v) => !v)}
        >
          {t('gitLog.allBranches')}
        </button>
      </div>
      {body}
    </div>
  );
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
