/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import type { Hunk } from 'diff';
import type {
  FileHistoryService,
  GitDiffResult,
  PerFileStats,
  TurnDiff,
  TurnFileDiff,
} from '@qwen-code/qwen-code-core';
import type { HistoryItem } from '../types.js';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useTurnDiffs, type TurnDiffEntry } from '../hooks/useTurnDiffs.js';
import { useDiffData } from '../hooks/useDiffData.js';
import { DiffRenderer } from './messages/DiffRenderer.js';
import { sanitizeFilenameForDisplay } from '../utils/textUtils.js';
import { t } from '../../i18n/index.js';

const MAX_VISIBLE_FILES = 8;

export interface DiffDialogProps {
  history: HistoryItem[];
  cwd: string | undefined;
  fileHistoryService: FileHistoryService | undefined;
  fileCheckpointingEnabled: boolean;
  onClose: () => void;
}

type UnifiedFile = {
  /** Raw repo-relative path. Used as a stable map key against
   *  `current.hunks` / `TurnDiff.files[].filePath`. Never rendered to the
   *  terminal — those keys can contain ANSI escapes or bare control bytes
   *  (git allows them in tracked / untracked paths via `-z`). */
  path: string;
  /** Sanitized version of `path` safe to drop into a `<Text>` node. */
  displayPath: string;
  added: number;
  removed: number;
  isBinary: boolean;
  isUntracked: boolean;
  isDeleted: boolean;
  isNewFile: boolean;
  truncated: boolean;
  oversized: boolean;
  /** Whether the source actually has hunks for this file. Untracked
   *  files don't appear in `git diff HEAD` output, capped/oversized
   *  turn entries have empty hunks — pressing Enter on those would land
   *  the user on a dead-end "No hunks available" screen, so we block
   *  Enter in the keypress handler when this is false. */
  hasHunks: boolean;
};

type Source =
  | { kind: 'current'; label: string }
  | { kind: 'turn'; label: string; entry: TurnDiffEntry };

type ViewMode = 'list' | 'detail';

export function DiffDialog({
  history,
  cwd,
  fileHistoryService,
  fileCheckpointingEnabled,
  onClose,
}: DiffDialogProps): React.JSX.Element {
  const current = useDiffData(cwd);
  const { turns, loading: turnsLoading } = useTurnDiffs(
    history,
    fileHistoryService,
    fileCheckpointingEnabled,
  );

  const sources = useMemo<Source[]>(() => {
    const list: Source[] = [{ kind: 'current', label: t('Current') }];
    for (const entry of turns) {
      list.push({
        kind: 'turn',
        label: `T${entry.turnIndex}`,
        entry,
      });
    }
    return list;
  }, [turns]);

  const [sourceIndex, setSourceIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  // Transient hint shown in place of the nav line when Enter lands on a
  // non-enterable row (binary / oversized / no-hunks). Cleared on the next
  // navigation keypress so it doesn't linger past the user's response.
  const [keyHint, setKeyHint] = useState<string | null>(null);

  // Derive clamped indexes inline rather than via a useEffect + setState.
  // Effect-based clamping causes an extra render frame (the first paint
  // uses the stale out-of-range index, the effect then schedules a
  // setState that retriggers the render), which can look like a flicker
  // in Ink. Computing on the fly keeps the dialog single-frame consistent
  // when `sources` or `files` shrink between mount and resolve.
  const safeSourceIndex = Math.min(
    sourceIndex,
    Math.max(0, sources.length - 1),
  );

  // Reset file selection when switching sources — file lists between
  // sources are unrelated. (This still needs an effect: it's mutating
  // state rather than just clamping on read.)
  useEffect(() => {
    setFileIndex(0);
    setViewMode('list');
  }, [safeSourceIndex]);

  const activeSource = sources[safeSourceIndex];
  const files = useMemo<UnifiedFile[]>(() => {
    if (!activeSource) return [];
    return activeSource.kind === 'current'
      ? currentToFiles(current.result, current.hunks)
      : turnToFiles(activeSource.entry.diff);
  }, [activeSource, current.result, current.hunks]);

  const safeFileIndex = Math.min(fileIndex, Math.max(0, files.length - 1));
  const selectedFile = files[safeFileIndex];

  const stats = useMemo(() => {
    if (!activeSource) return { filesCount: 0, linesAdded: 0, linesRemoved: 0 };
    if (activeSource.kind === 'current') {
      const s = current.result?.stats;
      return {
        filesCount: s?.filesCount ?? 0,
        linesAdded: s?.linesAdded ?? 0,
        linesRemoved: s?.linesRemoved ?? 0,
      };
    }
    const s = activeSource.entry.diff.stats;
    return {
      filesCount: s.filesChanged,
      linesAdded: s.linesAdded,
      linesRemoved: s.linesRemoved,
    };
  }, [activeSource, current.result]);

  // Refs let the keypress handler stay referentially stable across renders
  // even though it reads varying state. Without this, every render would
  // recreate the callback, churn `subscribe`/`unsubscribe` inside
  // `useKeypress`, and add unnecessary work to every keystroke.
  const viewModeRef = useRef(viewMode);
  const sourcesLenRef = useRef(sources.length);
  const filesLenRef = useRef(files.length);
  const selectedFileRef = useRef(selectedFile);
  const onCloseRef = useRef(onClose);
  const setKeyHintRef = useRef(setKeyHint);
  viewModeRef.current = viewMode;
  sourcesLenRef.current = sources.length;
  filesLenRef.current = files.length;
  selectedFileRef.current = selectedFile;
  onCloseRef.current = onClose;
  setKeyHintRef.current = setKeyHint;

  const handleKeypress = useCallback((key: { name?: string }) => {
    const name = key.name;
    // Ctrl+C is intentionally NOT handled here — the AppContainer-level
    // handler routes it through `closeAnyOpenDialog`, where this dialog
    // is registered. Handling it both places would double-fire and could
    // escalate to the exit prompt after the dialog already closed.
    if (name === 'escape') {
      if (viewModeRef.current === 'detail') {
        setViewMode('list');
      } else {
        onCloseRef.current();
      }
      return;
    }
    if (viewModeRef.current === 'detail') {
      if (name === 'left' || name === 'backspace') {
        setViewMode('list');
      }
      return;
    }
    // Any navigation key clears a previously displayed Enter-rejection
    // hint so it doesn't outlive the user's next action.
    setKeyHintRef.current(null);
    if (name === 'left') {
      setSourceIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (name === 'right') {
      setSourceIndex((i) => Math.min(sourcesLenRef.current - 1, i + 1));
      return;
    }
    if (name === 'up' || name === 'k') {
      setFileIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (name === 'down' || name === 'j') {
      setFileIndex((i) =>
        Math.min(Math.max(0, filesLenRef.current - 1), i + 1),
      );
      return;
    }
    if (name === 'return') {
      const sel = selectedFileRef.current;
      // Refuse Enter when the detail view would have nothing to show:
      // binary / oversized rows are presented with explicit notes in
      // the list, and rows with no hunks (untracked files, capped
      // entries) would otherwise land users on a dead-end screen.
      // Surface a transient hint so the keypress isn't silently
      // consumed — without it users could mistake the dialog for hung.
      if (!sel) return;
      if (sel.isBinary) {
        setKeyHintRef.current(t('Binary file — no diff to view.'));
        return;
      }
      if (sel.oversized) {
        setKeyHintRef.current(
          t('Oversized file — diff omitted. Use `git diff` to inspect.'),
        );
        return;
      }
      if (!sel.hasHunks) {
        setKeyHintRef.current(t('No diff content available for this file.'));
        return;
      }
      setViewMode('detail');
      return;
    }
  }, []);

  useKeypress(handleKeypress, { isActive: true });

  const { columns, rows } = useTerminalSize();
  // Cap to the app's main content area (AppContainer caps it at 100). The old
  // 110 cap exceeded that container, so on wide terminals the dialog overflowed
  // and its right border/edge was clipped off-screen.
  const dialogWidth = Math.min(columns - 4, 100);
  const detailHeight = Math.max(8, rows - 12);

  const headerTitle =
    activeSource?.kind === 'turn'
      ? t('Turn {{n}}', { n: String(activeSource.entry.turnIndex) })
      : t('Working tree vs HEAD');
  const headerSubtitle =
    activeSource?.kind === 'turn' && activeSource.entry.promptPreview
      ? `“${activeSource.entry.promptPreview}”`
      : activeSource?.kind === 'current'
        ? t('(git diff HEAD)')
        : '';

  const loadingNow =
    (activeSource?.kind === 'current' && current.loading) ||
    (activeSource?.kind === 'turn' && turnsLoading);

  // For "Current", `stats.filesCount` may exceed `files.length` when
  // `fetchGitDiff` capped `perFileStats` at MAX_FILES (=50). For turn
  // sources, `getTurnDiff` reports `filesOmitted` when the turn touched
  // more files than `MAX_TURN_DIFF_FILES`. Surface either gap so capped
  // rows aren't indistinguishable from "everything fit".
  //
  // Semantic asymmetry: the Current count is exact (numstat is cheap so
  // every change is counted before capping), while the turn count is an
  // upper bound — some of the cap-dropped files may have been unchanged.
  // The footer copy reflects that with "up to N more" for turn sources.
  const hiddenFileCount =
    activeSource?.kind === 'current'
      ? Math.max(0, stats.filesCount - files.length)
      : activeSource?.kind === 'turn'
        ? activeSource.entry.diff.stats.filesOmitted
        : 0;
  const hiddenIsUpperBound = activeSource?.kind === 'turn';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border.default}
      paddingX={1}
      width={dialogWidth}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={theme.text.primary}>
          /diff · {headerTitle}
          {headerSubtitle ? (
            <Text color={theme.text.secondary}> {headerSubtitle}</Text>
          ) : null}
        </Text>
        <Text color={theme.text.secondary}>
          {stats.filesCount} {stats.filesCount === 1 ? t('file') : t('files')}
          {stats.linesAdded > 0 ? (
            <Text color={theme.status.success}> +{stats.linesAdded}</Text>
          ) : null}
          {stats.linesRemoved > 0 ? (
            <Text color={theme.status.error}> -{stats.linesRemoved}</Text>
          ) : null}
        </Text>
      </Box>

      <SourceSwitcher sources={sources} sourceIndex={safeSourceIndex} />

      <Box marginTop={1} flexDirection="column">
        {loadingNow ? (
          <Text color={theme.text.secondary}>{t('Loading diff…')}</Text>
        ) : !activeSource || files.length === 0 ? (
          <Text color={theme.text.secondary}>
            {emptyMessage(
              activeSource,
              current.result,
              fileCheckpointingEnabled,
            )}
          </Text>
        ) : viewMode === 'list' ? (
          <>
            <FileList
              files={files}
              selectedIndex={safeFileIndex}
              contentWidth={dialogWidth - 4}
            />
            {hiddenFileCount > 0 ? (
              <Text color={theme.text.secondary}>
                {' '}
                {hiddenIsUpperBound
                  ? t('…and up to {{n}} more (showing first {{shown}})', {
                      n: String(hiddenFileCount),
                      shown: String(files.length),
                    })
                  : t('…and {{n}} more (showing first {{shown}})', {
                      n: String(hiddenFileCount),
                      shown: String(files.length),
                    })}
              </Text>
            ) : null}
          </>
        ) : selectedFile ? (
          <FileDetail
            file={selectedFile}
            activeSource={activeSource}
            currentHunks={current.hunks}
            availableHeight={detailHeight}
            contentWidth={dialogWidth - 4}
          />
        ) : null}
      </Box>

      <Box marginTop={1}>
        <Text color={keyHint ? theme.status.warning : theme.text.secondary}>
          {keyHint && viewMode === 'list'
            ? keyHint
            : viewMode === 'list'
              ? sources.length > 1
                ? t('←/→ source · ↑/↓ file · Enter view · Esc close')
                : t('↑/↓ file · Enter view · Esc close')
              : t('← back · Esc close')}
        </Text>
      </Box>
    </Box>
  );
}

function SourceSwitcher({
  sources,
  sourceIndex,
}: {
  sources: Source[];
  sourceIndex: number;
}): React.JSX.Element | null {
  if (sources.length <= 1) return null;
  return (
    <Box marginTop={1} flexDirection="row">
      {sourceIndex > 0 ? (
        <Text color={theme.text.secondary}>◀ </Text>
      ) : (
        <Text> </Text>
      )}
      {sources.map((s, i) => {
        const selected = i === sourceIndex;
        return (
          <Text
            key={`${s.kind}:${i}`}
            bold={selected}
            color={selected ? theme.text.accent : theme.text.secondary}
          >
            {i > 0 ? ' · ' : ''}
            {s.label}
          </Text>
        );
      })}
      {sourceIndex < sources.length - 1 ? (
        <Text color={theme.text.secondary}> ▶</Text>
      ) : null}
    </Box>
  );
}

function FileList({
  files,
  selectedIndex,
  contentWidth,
}: {
  files: UnifiedFile[];
  selectedIndex: number;
  contentWidth: number;
}): React.JSX.Element {
  const { startIndex, endIndex } = useVisibleWindow(
    files.length,
    selectedIndex,
    MAX_VISIBLE_FILES,
  );
  const visible = files.slice(startIndex, endIndex);
  const aboveCount = startIndex;
  const belowCount = files.length - endIndex;
  // Reserve room for the pointer (2), the tag column (≤16 chars), and the
  // stats column (≤16 chars). Anything past that gets head-truncated so
  // overflowing paths can't wrap and break the row layout.
  const TAG_AND_STATS_BUDGET = 32;
  const maxPathChars = Math.max(8, contentWidth - 2 - TAG_AND_STATS_BUDGET);
  return (
    <Box flexDirection="column">
      {aboveCount > 0 ? (
        <Text color={theme.text.secondary}>
          {' '}
          ↑ {aboveCount} {aboveCount === 1 ? t('more file') : t('more files')}
        </Text>
      ) : null}
      {visible.map((f, idx) => (
        <FileRow
          key={f.path}
          file={f}
          selected={startIndex + idx === selectedIndex}
          maxPathChars={maxPathChars}
        />
      ))}
      {belowCount > 0 ? (
        <Text color={theme.text.secondary}>
          {' '}
          ↓ {belowCount} {belowCount === 1 ? t('more file') : t('more files')}
        </Text>
      ) : null}
    </Box>
  );
}

function FileRow({
  file,
  selected,
  maxPathChars,
}: {
  file: UnifiedFile;
  selected: boolean;
  maxPathChars: number;
}): React.JSX.Element {
  const pointer = selected ? '› ' : '  ';
  // Tag priority: mutually exclusive states first (a file can't be both
  // deleted and untracked), then capability flags. `isBinary` is omitted
  // here because the stats column already renders an italic "binary"
  // marker — duplicating it as a tag would just clutter the row.
  const tag = file.isDeleted
    ? t(' (deleted)')
    : file.isUntracked
      ? t(' (untracked)')
      : file.oversized
        ? t(' (oversized — diff omitted)')
        : file.isNewFile
          ? t(' (new)')
          : file.truncated
            ? t(' (truncated)')
            : '';
  // Head-truncate so the basename (the part users actually read) is kept.
  // Use the sanitized displayPath — `file.path` may carry raw control bytes.
  const path = truncatePathStart(file.displayPath, maxPathChars);
  return (
    <Box flexDirection="row">
      <Text
        color={selected ? theme.text.accent : theme.text.primary}
        bold={selected}
      >
        {pointer}
        {path}
      </Text>
      <Text color={theme.text.secondary}>{tag} </Text>
      {file.isBinary ? (
        <Text color={theme.text.secondary} italic>
          {t('binary')}
        </Text>
      ) : (
        <>
          {file.added > 0 ? (
            <Text color={theme.status.success}>+{file.added}</Text>
          ) : null}
          {file.added > 0 && file.removed > 0 ? <Text> </Text> : null}
          {file.removed > 0 ? (
            <Text color={theme.status.error}>-{file.removed}</Text>
          ) : null}
        </>
      )}
    </Box>
  );
}

function FileDetail({
  file,
  activeSource,
  currentHunks,
  availableHeight,
  contentWidth,
}: {
  file: UnifiedFile;
  activeSource: Source;
  currentHunks: Map<string, Hunk[]>;
  availableHeight: number;
  contentWidth: number;
}): React.JSX.Element {
  const diffText = useMemo(() => {
    if (file.isBinary) return '';
    if (activeSource.kind === 'current') {
      const hunks = currentHunks.get(file.path);
      if (!hunks || hunks.length === 0) return '';
      return hunksToUnifiedDiff(file.path, hunks);
    }
    const entry = activeSource.entry.diff.files.find(
      (f) => f.filePath === file.path,
    );
    if (!entry) return '';
    return hunksToUnifiedDiff(file.path, entry.hunks);
  }, [file, activeSource, currentHunks]);

  if (file.isBinary) {
    return (
      <Text color={theme.text.secondary}>{t('Binary file — no diff.')}</Text>
    );
  }
  if (file.oversized) {
    return (
      <Text color={theme.text.secondary}>
        {t('Oversized file — diff omitted. Use `git diff` to inspect.')}
      </Text>
    );
  }
  if (!diffText) {
    return (
      <Text color={theme.text.secondary}>
        {t('No hunks available for {{path}}.', { path: file.displayPath })}
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold color={theme.text.primary}>
        {truncatePathStart(file.displayPath, contentWidth)}
      </Text>
      <Box marginTop={1}>
        <DiffRenderer
          diffContent={diffText}
          filename={file.displayPath}
          availableTerminalHeight={availableHeight}
          contentWidth={contentWidth}
        />
      </Box>
    </Box>
  );
}

/**
 * Truncate from the **start** so the basename — the most identifying part
 * of a path — survives. Mirrors claude-code's `truncateStartToWidth` and
 * keeps long absolute paths from wrapping and shattering the row layout.
 */
function truncatePathStart(path: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (path.length <= maxChars) return path;
  if (maxChars <= 1) return path.slice(-maxChars);
  return '…' + path.slice(-(maxChars - 1));
}

function useVisibleWindow(
  total: number,
  selectedIndex: number,
  windowSize: number,
): { startIndex: number; endIndex: number } {
  if (total <= windowSize) return { startIndex: 0, endIndex: total };
  let start = Math.max(0, selectedIndex - Math.floor(windowSize / 2));
  let end = start + windowSize;
  if (end > total) {
    end = total;
    start = Math.max(0, end - windowSize);
  }
  return { startIndex: start, endIndex: end };
}

function currentToFiles(
  result: GitDiffResult | null,
  hunks: Map<string, Hunk[]>,
): UnifiedFile[] {
  if (!result) return [];
  // `result.perFileStats` is already bounded by `fetchGitDiff` (MAX_FILES=50)
  // and the whole map is empty when the diff exceeds MAX_FILES_FOR_DETAILS
  // upstream, so no additional cap is necessary here.
  const out: UnifiedFile[] = [];
  for (const [path, s] of result.perFileStats) {
    out.push(perFileToUnified(path, s, hunks));
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function perFileToUnified(
  path: string,
  s: PerFileStats,
  hunks: Map<string, Hunk[]>,
): UnifiedFile {
  const fileHunks = hunks.get(path);
  // `s.truncated` from `parseGitNumstat` already means "untracked file
  // exceeded the line-counting read cap". The earlier `total >
  // MAX_LINES_PER_FILE` OR was conflating it with `parseGitDiff`'s
  // hunk-line cap (which is a separate, on-the-hunk-side cap that
  // doesn't lose the stats). A 500-line tracked file with accurate
  // numstat counts should NOT be flagged as truncated.
  return {
    path,
    displayPath: sanitizeFilenameForDisplay(path),
    added: s.added ?? 0,
    removed: s.isUntracked ? 0 : (s.removed ?? 0),
    isBinary: !!s.isBinary,
    isUntracked: !!s.isUntracked,
    isDeleted: !!s.isDeleted,
    // `isNewFile` means "added in this turn" (snapshot before-state empty,
    // after-state populated). Git's `untracked` is a different concept
    // (never in HEAD/index) and is tagged separately — conflating them
    // would mislead users about what `/rewind` can recover, since
    // untracked files are not under file-history protection.
    isNewFile: false,
    truncated: !!s.truncated,
    oversized: false,
    // `git diff HEAD` skips untracked files entirely and capped/skipped
    // entries can lack hunks even when present in perFileStats — gate
    // Enter on the actual presence of hunks rather than the row's
    // existence.
    hasHunks: !!fileHunks && fileHunks.length > 0,
  };
}

function turnToFiles(diff: TurnDiff): UnifiedFile[] {
  return diff.files.map(turnFileToUnified);
}

function turnFileToUnified(f: TurnFileDiff): UnifiedFile {
  return {
    path: f.filePath,
    displayPath: sanitizeFilenameForDisplay(f.filePath),
    added: f.linesAdded,
    removed: f.linesRemoved,
    // Binary detection lives in core (`looksBinary` NUL-byte sniff): the
    // snapshot is text content, so the renderer would otherwise feed
    // garbage to DiffRenderer for a turn that edited an image.
    isBinary: f.isBinary,
    isUntracked: false,
    isDeleted: f.isDeleted,
    isNewFile: f.isNewFile,
    truncated: false,
    oversized: f.oversized,
    hasHunks: f.hunks.length > 0,
  };
}

function hunksToUnifiedDiff(
  filePath: string,
  hunks: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>,
): string {
  // A header-only string isn't a valid unified diff and would confuse
  // DiffRenderer (which expects at least one `@@` block past `---/+++`).
  // The FileDetail empty-text check then catches this as "no hunks".
  if (hunks.length === 0) return '';
  // DiffRenderer expects unified-diff text starting with the file header so
  // its `--- /+++` skip works. We hand it a minimal envelope plus the hunk
  // headers and lines verbatim. Sanitize the embedded path to defang any
  // control bytes git could have round-tripped (DiffRenderer drops the
  // `---` line and only skips `+++` past unknown content, but sanitizing
  // both keeps oddities from sneaking into log captures).
  const safePath = sanitizeFilenameForDisplay(filePath);
  const lines: string[] = [`--- a/${safePath}`, `+++ b/${safePath}`];
  for (const h of hunks) {
    lines.push(
      `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
    );
    for (const l of h.lines) lines.push(l);
  }
  return lines.join('\n');
}

function emptyMessage(
  activeSource: Source | undefined,
  currentResult: GitDiffResult | null,
  fileCheckpointingEnabled: boolean,
): string {
  if (!activeSource) {
    return fileCheckpointingEnabled
      ? t('No diff data yet.')
      : t(
          'Per-turn diffs are unavailable because file checkpointing is disabled.',
        );
  }
  if (activeSource.kind === 'current') {
    if (!currentResult) {
      return t(
        'No diff available. Either this is not a git repository, HEAD is missing, or a merge/rebase/cherry-pick/revert is in progress.',
      );
    }
    // `fetchGitDiff` returns `filesCount > 0` with an empty `perFileStats`
    // map when the diff exceeds MAX_FILES_FOR_DETAILS — calling that case
    // "clean" would silently hide a large dirty tree. Surface it explicitly.
    if (currentResult.stats.filesCount > 0) {
      return t(
        '{{count}} files changed but the diff is too large to list per-file (+{{added}} / -{{removed}}). Use `git diff` for details.',
        {
          count: String(currentResult.stats.filesCount),
          added: String(currentResult.stats.linesAdded),
          removed: String(currentResult.stats.linesRemoved),
        },
      );
    }
    return t('Working tree is clean.');
  }
  return t('No file changes were captured in this turn.');
}
