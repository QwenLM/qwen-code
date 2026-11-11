/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useCallback, useMemo, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from '../semantic-colors.js';
import type { ShortcutHint } from '../hooks/useContainerKeyboard.js';
import { Command } from '../key/keyMatchers.js';
import type { Key } from '../hooks/useKeypress.js';
import {
  SettingsListPanel,
  type SettingsDialogItem,
} from './shared/SettingsListPanel.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';
import { useSearchBuffer } from '../hooks/useSearchBuffer.js';
import { useKeyMatchers } from '../hooks/useKeyMatchers.js';
import {
  fetchGitDiffFiles,
  isGitRepository,
  type DiffFile,
} from '../utils/gitDiff.js';

export interface DiffBrowserState {
  files?: DiffFile[];
  isRepository?: boolean;
  query: string;
  activeKey?: string;
}

interface DiffBrowserProps {
  state: DiffBrowserState;
  onClose: () => void;
  onOpenFile: (file: DiffFile) => void;
}

const MAX_ITEMS_TO_SHOW = 8;

/**
 * Formats a file path for display, truncating if necessary.
 */
function formatFilePath(path: string, maxWidth: number): string {
  if (path.length <= maxWidth) return path;
  return '...' + path.slice(-(maxWidth - 3));
}

/**
 * DiffBrowser component - Git diff file browser.
 * Lists changed files and allows opening individual file diffs.
 * Similar to AgentBrowser pattern.
 */
export const DiffBrowser: React.FC<DiffBrowserProps> = ({
  onClose,
  onOpenFile,
  state,
}) => {
  const keyMatchers = useKeyMatchers();
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? 80;

  const [gitFiles, setGitFiles] = useState<DiffFile[]>(state.files ?? []);
  const [isRepository, setIsRepository] = useState(state.isRepository);
  const [query, setQuery] = useState(state.query);
  const searchBuffer = useSearchBuffer({
    initialText: state.query,
    onChange: useCallback(
      (text: string) => {
        state.query = text;
        setQuery(text);
      },
      [state],
    ),
  });
  const openFile = useCallback(
    (file: DiffFile) => {
      state.activeKey = file.path;
      onOpenFile(file);
    },
    [state, onOpenFile],
  );

  // Probe repository metadata asynchronously before loading the diff.
  useEffect(() => {
    let active = true;
    void (async () => {
      const isGit = state.isRepository ?? (await isGitRepository());
      if (!active) return;
      state.isRepository = isGit;
      state.files ??= isGit ? fetchGitDiffFiles() : [];
      setIsRepository(isGit);
      setGitFiles(state.files);
    })();
    return () => {
      active = false;
    };
  }, [state]);

  // Derive stats from files (includes untracked, unlike fetchGitDiffStats)
  const gitStats = useMemo(() => {
    if (gitFiles.length === 0) return null;
    let insertions = 0;
    let deletions = 0;
    for (const f of gitFiles) {
      insertions += f.linesAdded;
      deletions += f.linesRemoved;
    }
    return { filesChanged: gitFiles.length, insertions, deletions };
  }, [gitFiles]);

  // Convert files to SettingsDialogItem[] for SettingsListPanel
  const fileItems: SettingsDialogItem[] = useMemo(
    () =>
      gitFiles.map((file) => {
        const statusChar = file.isUntracked ? 'U' : file.isNewFile ? 'A' : 'M';
        // Build change stats suffix
        const changeParts: string[] = [];
        if (file.linesAdded > 0) changeParts.push(`+${file.linesAdded}`);
        if (file.linesRemoved > 0) changeParts.push(`-${file.linesRemoved}`);
        if (file.isBinary) changeParts.push('binary');
        const changeStr =
          changeParts.length > 0 ? ` (${changeParts.join(', ')})` : '';

        return {
          key: file.path,
          label: `[${statusChar}] ${formatFilePath(file.path, terminalWidth - 30)}${changeStr}`,
          description: '',
          type: 'boolean' as const,
          displayValue: '',
          rawValue: file,
        };
      }),
    [gitFiles, terminalWidth],
  );

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.toLowerCase();
    return fileItems.filter((item) =>
      item.label.toLowerCase().includes(normalizedQuery),
    );
  }, [fileItems, query]);

  // Handle item toggle (Enter key opens file detail)
  const handleItemToggle = useCallback(
    (key: string, item: SettingsDialogItem) => {
      const file = item.rawValue as DiffFile;
      if (file) {
        openFile(file);
      }
    },
    [openFile],
  );

  // Handle edit commit (no-op for diff browser)
  const handleEditCommit = useCallback(
    (_key: string, _newValue: string, _item: SettingsDialogItem) => {
      // No-op
    },
    [],
  );

  // Handle item clear (no-op for diff browser)
  const handleItemClear = useCallback(
    (_key: string, _item: SettingsDialogItem) => {
      // No-op
    },
    [],
  );

  // Custom key handler for list view: Enter opens detail
  const handleListKeyPress = useCallback(
    (key: Key, currentItem: SettingsDialogItem | undefined): boolean => {
      if (keyMatchers[Command.RETURN](key) && currentItem) {
        const file = currentItem.rawValue as DiffFile;
        if (file) {
          openFile(file);
        }
        return true;
      }
      return false;
    },
    [keyMatchers, openFile],
  );

  // Extra hints for list view.
  // NOTE: "Esc close" is already auto-generated by BaseTabDialog's onClose →
  // the escape handler, so we only declare hints not already provided
  // at the BaseTabDialog level (the ↑↓ and Enter handlers live in
  // the SettingsListPanel's own useContainerKeyboard).
  const listExtraHints = useMemo(
    (): ShortcutHint[] => [
      { label: SHORTCUT_HINTS.ENTER_VIEW_DIFF, order: 30 },
    ],
    [],
  );

  // Stats summary — single line subtitle
  const statsSummary = (
    <Box flexDirection="row" gap={1}>
      <Text color={theme.text.secondary} dimColor>
        Current project ·{' '}
        {gitStats && gitStats.filesChanged > 0
          ? `${gitStats.filesChanged} file${gitStats.filesChanged !== 1 ? 's' : ''} changed`
          : 'uncommitted changes'}
      </Text>
      {gitStats && gitStats.insertions > 0 && (
        <Text color={theme.status.success}>+{gitStats.insertions}</Text>
      )}
      {gitStats && gitStats.deletions > 0 && (
        <Text color={theme.status.error}>-{gitStats.deletions}</Text>
      )}
    </Box>
  );

  // Empty state
  if (gitFiles.length === 0) {
    return (
      <BaseTabDialog
        title="Git Diff"
        tabs={[]}
        activeKey=""
        onTabChange={() => {}}
        isActive={true}
        showSeparator={true}
        showContent={true}
        onClose={onClose}
      >
        <Box flexDirection="column">
          {statsSummary}
          {isRepository === undefined ? (
            <Text color={theme.text.secondary}>Checking repository…</Text>
          ) : !isRepository ? (
            <Text color={theme.text.secondary}>Not a git repository</Text>
          ) : (
            <Text color={theme.status.success}>No uncommitted changes</Text>
          )}
        </Box>
      </BaseTabDialog>
    );
  }

  // List view
  return (
    <BaseTabDialog
      title="Git Diff"
      tabs={[]}
      activeKey=""
      onTabChange={() => {}}
      isActive={true}
      showSeparator={true}
      showContent={true}
      onClose={onClose}
      extraHints={listExtraHints}
    >
      <Box flexDirection="column">
        {statsSummary}
        <SettingsListPanel
          searchEnabled={true}
          searchPlaceholder="Search files"
          searchBuffer={searchBuffer}
          initialActiveKey={state.activeKey}
          items={filteredItems}
          maxItemsToShow={MAX_ITEMS_TO_SHOW}
          minItemSlots={Math.min(MAX_ITEMS_TO_SHOW, gitFiles.length)}
          itemHeight={1}
          onItemToggle={(key, item) => {
            handleItemToggle(key, item);
          }}
          onEditCommit={handleEditCommit}
          onItemClear={handleItemClear}
          onClose={onClose}
          onKeyPress={handleListKeyPress}
        />
      </Box>
    </BaseTabDialog>
  );
};
