/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import type { Hunk } from 'diff';
import type {
  FileHistoryService,
  GitDiffResult,
  PerFileStats,
  TurnDiff,
  TurnFileDiff,
} from '@qwen-code/qwen-code-core';
import {
  MAX_FILES_FOR_DETAILS,
  MAX_LINES_PER_FILE,
} from '@qwen-code/qwen-code-core';
import type { HistoryItem } from '../types.js';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useTurnDiffs, type TurnDiffEntry } from '../hooks/useTurnDiffs.js';
import { useDiffData } from '../hooks/useDiffData.js';
import { DiffRenderer } from './messages/DiffRenderer.js';
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
  path: string;
  added: number;
  removed: number;
  isBinary: boolean;
  isUntracked: boolean;
  isDeleted: boolean;
  isNewFile: boolean;
  truncated: boolean;
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

  // Keep selection sane as `sources` resolves asynchronously (turns load
  // after the dialog mounts). Without this guard, an initial render with
  // sources=[Current] followed by a turn append would silently shift the
  // user off the source they were inspecting.
  useEffect(() => {
    if (sourceIndex >= sources.length) {
      setSourceIndex(Math.max(0, sources.length - 1));
    }
  }, [sources, sourceIndex]);

  // Reset file selection when switching sources — file lists between
  // sources are unrelated.
  useEffect(() => {
    setFileIndex(0);
    setViewMode('list');
  }, [sourceIndex]);

  const activeSource = sources[sourceIndex];
  const files = useMemo<UnifiedFile[]>(() => {
    if (!activeSource) return [];
    return activeSource.kind === 'current'
      ? currentToFiles(current.result)
      : turnToFiles(activeSource.entry.diff);
  }, [activeSource, current.result]);

  const selectedFile = files[fileIndex];

  // Clamp file selection — file list shrinks when switching sources or
  // when the underlying data updates (e.g. live tree changes during the
  // dialog session, though uncommon).
  useEffect(() => {
    if (fileIndex >= files.length) {
      setFileIndex(Math.max(0, files.length - 1));
    }
  }, [files, fileIndex]);

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

  const handleClose = useCallback(() => {
    if (viewMode === 'detail') {
      setViewMode('list');
      return;
    }
    onClose();
  }, [viewMode, onClose]);

  useKeypress(
    (key) => {
      const name = key.name;
      const ctrl = key.ctrl;
      if (name === 'escape' || (ctrl && name === 'c')) {
        handleClose();
        return;
      }
      if (viewMode === 'detail') {
        if (name === 'left' || name === 'backspace') {
          setViewMode('list');
        }
        return;
      }
      if (name === 'left') {
        setSourceIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (name === 'right') {
        setSourceIndex((i) => Math.min(sources.length - 1, i + 1));
        return;
      }
      if (name === 'up' || name === 'k') {
        setFileIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (name === 'down' || name === 'j') {
        setFileIndex((i) => Math.min(Math.max(0, files.length - 1), i + 1));
        return;
      }
      if (name === 'return') {
        if (selectedFile && !selectedFile.isBinary) {
          setViewMode('detail');
        }
        return;
      }
    },
    { isActive: true },
  );

  const { columns, rows } = useTerminalSize();
  const dialogWidth = Math.min(columns - 4, 110);
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

      <SourceSwitcher sources={sources} sourceIndex={sourceIndex} />

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
          <FileList files={files} selectedIndex={fileIndex} />
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
        <Text color={theme.text.secondary}>
          {viewMode === 'list'
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
}: {
  files: UnifiedFile[];
  selectedIndex: number;
}): React.JSX.Element {
  const { startIndex, endIndex } = useVisibleWindow(
    files.length,
    selectedIndex,
    MAX_VISIBLE_FILES,
  );
  const visible = files.slice(startIndex, endIndex);
  const aboveCount = startIndex;
  const belowCount = files.length - endIndex;
  const maxPathLen = visible.reduce((m, f) => Math.max(m, f.path.length), 1);
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
          pathColumn={maxPathLen}
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
  pathColumn,
}: {
  file: UnifiedFile;
  selected: boolean;
  pathColumn: number;
}): React.JSX.Element {
  const pointer = selected ? '› ' : '  ';
  const tag = file.isNewFile
    ? t(' (new)')
    : file.isDeleted
      ? t(' (deleted)')
      : file.isUntracked
        ? t(' (untracked)')
        : file.truncated
          ? t(' (truncated)')
          : '';
  const path = file.path.padEnd(pathColumn);
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
  if (!diffText) {
    return (
      <Text color={theme.text.secondary}>
        {t('No hunks available for {{path}}.', { path: file.path })}
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold color={theme.text.primary}>
        {file.path}
      </Text>
      <Box marginTop={1}>
        <DiffRenderer
          diffContent={diffText}
          filename={file.path}
          availableTerminalHeight={availableHeight}
          contentWidth={contentWidth}
        />
      </Box>
    </Box>
  );
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

function currentToFiles(result: GitDiffResult | null): UnifiedFile[] {
  if (!result) return [];
  const out: UnifiedFile[] = [];
  let count = 0;
  for (const [path, s] of result.perFileStats) {
    if (++count > MAX_FILES_FOR_DETAILS) break;
    out.push(perFileToUnified(path, s));
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function perFileToUnified(path: string, s: PerFileStats): UnifiedFile {
  const total = (s.added ?? 0) + (s.removed ?? 0);
  return {
    path,
    added: s.added ?? 0,
    removed: s.isUntracked ? 0 : (s.removed ?? 0),
    isBinary: !!s.isBinary,
    isUntracked: !!s.isUntracked,
    isDeleted: !!s.isDeleted,
    isNewFile: !!s.isUntracked,
    truncated: !!s.truncated || (!s.isBinary && total > MAX_LINES_PER_FILE),
  };
}

function turnToFiles(diff: TurnDiff): UnifiedFile[] {
  return diff.files.map(turnFileToUnified);
}

function turnFileToUnified(f: TurnFileDiff): UnifiedFile {
  return {
    path: f.filePath,
    added: f.linesAdded,
    removed: f.linesRemoved,
    isBinary: false,
    isUntracked: false,
    isDeleted: f.isDeleted,
    isNewFile: f.isNewFile,
    truncated: false,
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
  // DiffRenderer expects unified-diff text starting with the file header so
  // its `--- /+++` skip works. We hand it a minimal envelope plus the hunk
  // headers and lines verbatim.
  const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
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
    return t('Working tree is clean.');
  }
  return t('No file changes were captured in this turn.');
}
