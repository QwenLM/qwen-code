/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import type {
  DaemonDiffHunk,
  DaemonGitBranchesResult,
  DaemonGitDiffMode,
  DaemonGitLogEntry,
  DaemonWorkspaceGitDiff,
  DaemonWorkspaceGitDiffFile,
  DaemonWorkspaceGitDiffOptions,
} from '@qwen-code/sdk/daemon';
import { ArrowRightIcon, ChevronDownIcon, SearchIcon } from 'lucide-react';
import type { BundledLanguage, ThemedToken } from 'shiki';
import { useI18n } from '../../i18n';
import { useTheme, WebShellThemeId } from '../../themeContext';
import {
  getCodeHighlighter,
  isTooLargeToHighlight,
} from '../messages/codeHighlighter';
import { resolveFenceLanguage } from '../messages/Markdown';
import { languageForPath } from '../messages/ToolGroup';
import { sanitizeControlChars } from '../messages/toolFormatting';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { DialogShell } from './DialogShell';
import styles from './GitDiffDialog.module.css';

type RowType = 'add' | 'del' | 'context' | 'meta';

interface DiffRow {
  type: RowType;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  tokens: ThemedToken[] | null;
}

const ROW_CLASS: Record<RowType, string> = {
  add: styles.diffLineAdd,
  del: styles.diffLineDel,
  context: styles.diffLineContext,
  meta: styles.diffLineMeta,
};

function shikiThemeFor(theme: ReturnType<typeof useTheme>): string {
  return theme === WebShellThemeId.Light
    ? 'github-light-default'
    : 'github-dark-default';
}

// Build the unified-diff rows for a file's hunks, highlighting each side
// (context+added / context+removed) as its own code block so multi-line tokens
// (a comment or string crossing an add/delete boundary) still tokenize
// correctly. Each rendered line then pulls its tokens from the matching side:
// `+` from the new side, `-` from the old side, context from either (identical).
async function buildRows(
  hunks: DaemonDiffHunk[],
  path: string,
  theme: string,
): Promise<DiffRow[]> {
  const { resolvedLang } = resolveFenceLanguage(languageForPath(path));
  let highlighter: Awaited<ReturnType<typeof getCodeHighlighter>> | null = null;
  if (resolvedLang !== 'text') {
    try {
      highlighter = await getCodeHighlighter(resolvedLang);
    } catch {
      highlighter = null;
    }
  }

  const rows: DiffRow[] = [];
  for (const hunk of hunks) {
    const newSide: string[] = [];
    const oldSide: string[] = [];
    for (const line of hunk.lines) {
      const prefix = line[0];
      const body = line.slice(1);
      if (prefix === '+') newSide.push(body);
      else if (prefix === '-') oldSide.push(body);
      else if (prefix === ' ') {
        newSide.push(body);
        oldSide.push(body);
      }
    }
    const newCode = newSide.join('\n');
    const oldCode = oldSide.join('\n');
    let newTokens: ThemedToken[][] | null = null;
    let oldTokens: ThemedToken[][] | null = null;
    if (highlighter) {
      // resolvedLang is a real Shiki language id here ('text' was filtered out
      // before the highlighter was loaded).
      const lang = resolvedLang as BundledLanguage;
      // Highlight each side independently so a small side keeps its tokens even
      // when the other side exceeds the size cap.
      if (!isTooLargeToHighlight(newCode)) {
        try {
          newTokens = highlighter.codeToTokens(newCode, { lang, theme }).tokens;
        } catch {
          newTokens = null;
        }
      }
      if (!isTooLargeToHighlight(oldCode)) {
        try {
          oldTokens = highlighter.codeToTokens(oldCode, { lang, theme }).tokens;
        } catch {
          oldTokens = null;
        }
      }
    }

    let ni = 0;
    let oi = 0;
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    for (const line of hunk.lines) {
      const prefix = line[0];
      const body = line.slice(1);
      if (prefix === '+') {
        rows.push({
          type: 'add',
          oldNo: null,
          newNo,
          text: body,
          tokens: newTokens?.[ni] ?? null,
        });
        ni++;
        newNo++;
      } else if (prefix === '-') {
        rows.push({
          type: 'del',
          oldNo,
          newNo: null,
          text: body,
          tokens: oldTokens?.[oi] ?? null,
        });
        oi++;
        oldNo++;
      } else if (prefix === ' ') {
        rows.push({
          type: 'context',
          oldNo,
          newNo,
          text: body,
          tokens: newTokens?.[ni] ?? null,
        });
        ni++;
        oi++;
        oldNo++;
        newNo++;
      } else {
        // e.g. "\ No newline at end of file" — a neutral marker, no line number.
        rows.push({
          type: 'meta',
          oldNo: null,
          newNo: null,
          text: line,
          tokens: null,
        });
      }
    }
  }
  return rows;
}

function renderContent(row: DiffRow): ReactNode {
  if (!row.tokens || row.tokens.length === 0) return row.text;
  return row.tokens.map((token, index) => (
    <span key={index} style={token.color ? { color: token.color } : undefined}>
      {token.content}
    </span>
  ));
}

function DiffHunks({ hunks, path }: { hunks: DaemonDiffHunk[]; path: string }) {
  const { t } = useI18n();
  const theme = useTheme();
  const shikiTheme = shikiThemeFor(theme);
  const [rows, setRows] = useState<DiffRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setFailed(false);
    buildRows(hunks, path, shikiTheme)
      .then((built) => {
        if (!cancelled) setRows(built);
      })
      // Highlighter failures degrade to plain text inside buildRows; this
      // catches the unexpected (e.g. malformed hunk lines), which would
      // otherwise be an unhandled rejection leaving `rows` stuck at null with
      // no feedback.
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [hunks, path, shikiTheme]);

  if (failed) {
    return (
      <div className={styles.filePlaceholder}>{t('gitDiff.fileError')}</div>
    );
  }

  // null while the rows are first built and again while re-tokenizing after a
  // theme switch; show a placeholder instead of an empty, jumpily-resized box.
  if (rows === null) {
    return <div className={styles.filePlaceholder}>{t('gitDiff.loading')}</div>;
  }

  return (
    <div className={styles.diffLines}>
      {(rows ?? []).map((row, index) => (
        <div
          key={index}
          className={`${styles.diffLine} ${ROW_CLASS[row.type]}`}
        >
          <span className={styles.diffOldNo}>{row.oldNo ?? ''}</span>
          <span className={styles.diffNewNo}>{row.newNo ?? ''}</span>
          <span className={styles.diffMarker}>
            {row.type === 'add'
              ? '+'
              : row.type === 'del'
                ? '-'
                : row.type === 'meta'
                  ? ''
                  : ' '}
          </span>
          <code className={styles.diffContent}>{renderContent(row)}</code>
        </div>
      ))}
    </div>
  );
}

function DiffFileRow({
  workspaceCwd,
  gitCwd,
  file,
  options,
}: {
  workspaceCwd: string;
  gitCwd?: string;
  file: DaemonWorkspaceGitDiffFile;
  options?: DaemonWorkspaceGitDiffOptions;
}) {
  const { t } = useI18n();
  const { client } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [hunks, setHunks] = useState<DaemonDiffHunk[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // Guard the in-flight fetch so closing the dialog before it resolves doesn't
  // settle state on an unmounted row (matching DiffHunks / GitDiffDialog).
  const cancelledRef = useRef(false);
  useEffect(() => {
    // Reset on mount: StrictMode replays mount→unmount→mount and the ref
    // persists across the replay, so without this reset the flag would stick at
    // true and suppress every post-fetch state update (row stuck on "Loading").
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && hunks === null && !loading && !file.isBinary) {
      setLoading(true);
      setError(false);
      const ws = client.workspaceByCwd(workspaceCwd);
      // Pass the pre-rename path so a renamed file diffs old→new (rename
      // detection) instead of showing the new path as fully added.
      const request = options
        ? ws.workspaceGitDiffFile(file.path, file.oldPath, gitCwd, options)
        : ws.workspaceGitDiffFile(file.path, file.oldPath, gitCwd);
      request
        .then((result) => {
          if (cancelledRef.current) return;
          setHunks(result.hunks);
          setTruncated(result.truncated === true);
        })
        .catch(() => {
          if (!cancelledRef.current) setError(true);
        })
        .finally(() => {
          if (!cancelledRef.current) setLoading(false);
        });
    }
  };

  const displayName = sanitizeControlChars(file.path);

  return (
    <div className={styles.file}>
      <button
        type="button"
        className={styles.fileHeader}
        onClick={toggle}
        aria-expanded={open}
        aria-label={t(open ? 'gitDiff.collapse' : 'gitDiff.expand', {
          path: file.oldPath
            ? `${sanitizeControlChars(file.oldPath)} → ${displayName}`
            : displayName,
        })}
      >
        <span className={styles.fileStats}>
          {file.isBinary ? (
            <span className={styles.fileBinary}>{t('gitDiff.binary')}</span>
          ) : (
            <>
              <span className={styles.statAdd}>+{file.added ?? 0}</span>
              <span className={styles.statDel}>-{file.removed ?? 0}</span>
            </>
          )}
        </span>
        <span className={styles.filePath} title={displayName}>
          {file.oldPath ? (
            <>
              <span className={styles.fileOldPath}>
                {sanitizeControlChars(file.oldPath)}
              </span>
              {' → '}
            </>
          ) : null}
          {displayName}
        </span>
        {file.isUntracked && (
          <span className={styles.fileTag}>{t('gitDiff.untracked')}</span>
        )}
        {file.isDeleted && (
          <span className={styles.fileTag}>{t('gitDiff.deleted')}</span>
        )}
      </button>
      {open && (
        <div className={styles.fileBody}>
          {file.isBinary ? (
            <div className={styles.filePlaceholder}>{t('gitDiff.binary')}</div>
          ) : loading ? (
            <div className={styles.filePlaceholder}>{t('gitDiff.loading')}</div>
          ) : error ? (
            <div className={styles.filePlaceholder}>
              {t('gitDiff.fileError')}
            </div>
          ) : hunks && hunks.length > 0 ? (
            <>
              <DiffHunks hunks={hunks} path={file.path} />
              {truncated && (
                <div className={styles.filePlaceholder} role="note">
                  {t('gitDiff.truncated')}
                </div>
              )}
            </>
          ) : (
            <div className={styles.filePlaceholder}>{t('gitDiff.noDiff')}</div>
          )}
        </div>
      )}
    </div>
  );
}

interface DiffRefItem {
  value: string;
  label: string;
}

function SearchableDiffRefSelect({
  value,
  items,
  prefix,
  label,
  searchPlaceholder,
  noMatches,
  onChange,
}: {
  value: string;
  items: DiffRefItem[];
  prefix?: string;
  label: string;
  searchPlaceholder: string;
  noMatches: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredItems = normalizedQuery
    ? items.filter(
        (item) =>
          item.value.toLowerCase().includes(normalizedQuery) ||
          item.label.toLowerCase().includes(normalizedQuery),
      )
    : items;
  const selected = items.find((item) => item.value === value);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={styles.refTrigger}
          aria-label={label}
          aria-expanded={open}
        >
          {prefix && (
            <>
              <span className={styles.refPrefix} title={prefix}>
                {prefix}
              </span>
              <ArrowRightIcon className={styles.refArrow} size={14} />
            </>
          )}
          <span className={styles.refValue}>{selected?.label ?? value}</span>
          <ChevronDownIcon size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={styles.refPopover}
        align="start"
        sideOffset={4}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <div className={styles.refSearch}>
          <SearchIcon size={14} />
          <input
            ref={inputRef}
            className={styles.refSearchInput}
            value={query}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div
          className={styles.refList}
          role="listbox"
          aria-label={label}
          onWheelCapture={(event) => event.stopPropagation()}
        >
          {filteredItems.map((item) => (
            <button
              key={item.value}
              type="button"
              role="option"
              aria-selected={item.value === value}
              className={`${styles.refItem} ${
                item.value === value ? styles.refItemActive : ''
              }`}
              onClick={() => {
                onChange(item.value);
                setOpen(false);
                setQuery('');
              }}
            >
              {item.label}
            </button>
          ))}
          {filteredItems.length === 0 && (
            <div className={styles.refEmpty}>{noMatches}</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function GitDiffContent({
  workspaceCwd,
  gitCwd,
  onSubtitleChange,
}: {
  workspaceCwd: string;
  gitCwd?: string;
  onSubtitleChange?: (subtitle: string | undefined) => void;
}) {
  const { t } = useI18n();
  const { client } = useWorkspace();
  const [diff, setDiff] = useState<DaemonWorkspaceGitDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [mode, setMode] = useState<DaemonGitDiffMode>('uncommitted');
  const [commitRef, setCommitRef] = useState('');
  const [branchRef, setBranchRef] = useState('');
  const [commits, setCommits] = useState<DaemonGitLogEntry[] | null>(null);
  const [branches, setBranches] = useState<DaemonGitBranchesResult | null>(
    null,
  );
  const [sourceLoading, setSourceLoading] = useState<
    'commit' | 'branch' | null
  >(null);
  const [sourceError, setSourceError] = useState<'commit' | 'branch' | null>(
    null,
  );

  useEffect(() => {
    setMode('uncommitted');
    setCommitRef('');
    setBranchRef('');
    setCommits(null);
    setBranches(null);
    setSourceLoading(null);
    setSourceError(null);
  }, [workspaceCwd, gitCwd]);

  useEffect(() => {
    if (mode !== 'commit' || commits !== null) return;
    let cancelled = false;
    setSourceLoading('commit');
    setSourceError(null);
    client
      .workspaceByCwd(workspaceCwd)
      .workspaceGitLog(200, 0, gitCwd)
      .then((result) => {
        if (cancelled) return;
        setCommits(result.entries);
        setCommitRef(result.entries[0]?.sha ?? '');
      })
      .catch(() => {
        if (!cancelled) setSourceError('commit');
      })
      .finally(() => {
        if (!cancelled) setSourceLoading(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client, workspaceCwd, gitCwd, mode, commits]);

  useEffect(() => {
    if (mode !== 'branch' || branches !== null) return;
    let cancelled = false;
    setSourceLoading('branch');
    setSourceError(null);
    client
      .workspaceByCwd(workspaceCwd)
      .workspaceGitBranches(gitCwd)
      .then((result) => {
        if (cancelled) return;
        setBranches(result);
        setBranchRef(
          result.local.find((branch) => !branch.isHead)?.name ??
            result.remote[0]?.name ??
            '',
        );
      })
      .catch(() => {
        if (!cancelled) setSourceError('branch');
      })
      .finally(() => {
        if (!cancelled) setSourceLoading(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client, workspaceCwd, gitCwd, mode, branches]);

  const options = useMemo<
    DaemonWorkspaceGitDiffOptions | undefined | null
  >(() => {
    if (mode === 'uncommitted') return undefined;
    if (mode === 'commit') {
      return commitRef ? { mode, ref: commitRef } : null;
    }
    if (mode === 'branch') {
      return branchRef ? { mode, ref: branchRef } : null;
    }
    return { mode };
  }, [mode, commitRef, branchRef]);

  const commitItems = useMemo(
    () =>
      (commits ?? []).map((commit) => ({
        value: commit.sha,
        label: `${commit.shortSha} ${commit.subject}`,
      })),
    [commits],
  );

  const branchItems = useMemo(
    () => [
      ...(branches?.local ?? [])
        .filter((branch) => !branch.isHead)
        .map((branch) => ({
          value: branch.name,
          label: branch.name,
        })),
      ...(branches?.remote ?? []).map((branch) => ({
        value: branch.name,
        label: branch.name,
      })),
    ],
    [branches],
  );

  useEffect(() => {
    if (options === null) {
      setDiff(null);
      setLoading(sourceLoading === mode);
      setError(sourceError === mode);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    const ws = client.workspaceByCwd(workspaceCwd);
    const request = options
      ? ws.workspaceGitDiff(gitCwd, options)
      : ws.workspaceGitDiff(gitCwd);
    request
      .then((result) => {
        if (!cancelled) setDiff(result);
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
  }, [client, workspaceCwd, gitCwd, mode, options, sourceLoading, sourceError]);

  const subtitle =
    diff && diff.available
      ? t('gitDiff.summary', {
          count: diff.filesCount,
          added: diff.linesAdded,
          removed: diff.linesRemoved,
        })
      : undefined;

  useEffect(() => {
    onSubtitleChange?.(subtitle);
  }, [onSubtitleChange, subtitle]);

  let body: ReactNode;
  if (loading) {
    body = <div className={styles.placeholder}>{t('gitDiff.loading')}</div>;
  } else if (error) {
    body = <div className={styles.placeholder}>{t('gitDiff.error')}</div>;
  } else if (!diff || !diff.available) {
    body = (
      <div className={styles.placeholder}>
        {t(
          mode === 'uncommitted'
            ? 'gitDiff.unavailable'
            : 'gitDiff.comparisonUnavailable',
        )}
      </div>
    );
  } else if (diff.filesCount === 0) {
    body = <div className={styles.placeholder}>{t('gitDiff.empty')}</div>;
  } else {
    body = (
      <div className={styles.fileList}>
        {diff.files.map((file) => (
          <DiffFileRow
            // Key by workspace + path so switching workspace remounts the row
            // instead of reusing another workspace's hunks/open state for a
            // path both workspaces share.
            key={`${workspaceCwd}:${gitCwd ?? ''}:${mode}:${options?.ref ?? ''}:${file.path}`}
            workspaceCwd={workspaceCwd}
            gitCwd={gitCwd}
            file={file}
            options={options ?? undefined}
          />
        ))}
        {diff.hiddenCount > 0 && (
          <div className={styles.hiddenNote}>
            {t('gitDiff.hidden', { count: diff.hiddenCount })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={styles.content}>
      <div className={styles.sourceBar}>
        <label className={styles.sourceLabel} htmlFor="git-diff-source">
          {t('gitDiff.source.label')}
        </label>
        <select
          id="git-diff-source"
          className={styles.sourceSelect}
          value={mode}
          onChange={(event) => setMode(event.target.value as DaemonGitDiffMode)}
        >
          <option value="uncommitted">{t('gitDiff.source.uncommitted')}</option>
          <option value="unstaged">{t('gitDiff.source.unstaged')}</option>
          <option value="staged">{t('gitDiff.source.staged')}</option>
          <option value="commit">{t('gitDiff.source.commit')}</option>
          <option value="branch">{t('gitDiff.source.branch')}</option>
        </select>
        {mode === 'commit' && commitItems.length > 0 && (
          <SearchableDiffRefSelect
            value={commitRef}
            items={commitItems}
            label={t('gitDiff.source.selectCommit')}
            searchPlaceholder={t('gitDiff.source.searchCommit')}
            noMatches={t('gitDiff.source.noMatches')}
            onChange={setCommitRef}
          />
        )}
        {mode === 'branch' && branchItems.length > 0 && (
          <SearchableDiffRefSelect
            value={branchRef}
            items={branchItems}
            prefix={branches?.head}
            label={t('gitDiff.source.selectBranch')}
            searchPlaceholder={t('gitDiff.source.searchBranch')}
            noMatches={t('gitDiff.source.noMatches')}
            onChange={setBranchRef}
          />
        )}
      </div>
      {body}
    </div>
  );
}

export function GitDiffDialog({
  workspaceCwd,
  onClose,
}: {
  workspaceCwd: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <DialogShell
      title={t('gitDiff.title')}
      size="xl"
      allowFullscreen
      onClose={onClose}
    >
      <GitDiffContent workspaceCwd={workspaceCwd} />
    </DialogShell>
  );
}
