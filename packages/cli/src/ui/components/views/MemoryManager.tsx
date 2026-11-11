/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useMemo, useCallback } from 'react';
import { Box, Text, useStdin } from 'ink';
import {
  type MemoryEntry,
  type MemoryType,
  type MemoryScope,
  deleteMemoryFile,
  removeIndexEntry,
  listStructuredMemoryFiles,
} from '@qwen-code/core';
import { basename, dirname } from 'node:path';
import { theme } from '../../semantic-colors.js';
import {
  BaseSelectionList,
  type RenderItemContext,
} from '../shared/BaseSelectionList.js';
import type { SelectionListItem } from '../../hooks/useSelectionList.js';
import { useRegisterFallbackHandler } from '../../contexts/ActionHandlerRegistry.js';
import type { Key } from '../../contexts/KeypressContext.js';
import type { ShortcutHint } from '../../hooks/useContainerKeyboard.js';
import { BaseTabDialog } from '../shared/BaseTabDialog.js';
import { SHORTCUT_HINTS } from '../../constants/shortcuts.js';
import { openFileInEditor } from '../../utils/editorUtils.js';

const TYPE_ORDER: MemoryType[] = ['user', 'feedback', 'project', 'reference'];
const TYPE_LABELS: Record<MemoryType, string> = {
  user: 'User',
  feedback: 'Feedback',
  project: 'Project',
  reference: 'Reference',
};

interface MemoryListItem extends SelectionListItem<MemoryEntry | null> {
  isHeader?: boolean;
  headerType?: string;
  /** When true, this is a scope-level header (rendered emphasized). */
  isScopeHeader?: boolean;
}

/** One memory root (USER or PROJECT) with its loaded entries. */
export interface MemoryManagerRoot {
  scope: MemoryScope;
  /** Absolute path to the root directory (holds MEMORY.md + topic files). */
  dir: string;
  entries: MemoryEntry[];
}

interface MemoryManagerProps {
  roots: MemoryManagerRoot[];
  onClose: () => void;
}

const SCOPE_LABELS: Record<MemoryScope, string> = {
  user: 'User scope (all projects)',
  project: 'Project scope (this project)',
};

function buildListItems(
  roots: readonly MemoryManagerRoot[],
  multiRoot: boolean,
): MemoryListItem[] {
  const items: MemoryListItem[] = [];

  for (const root of roots) {
    if (root.entries.length === 0) continue;

    // Label dual-scope views and the otherwise ambiguous USER-only view.
    if (multiRoot || root.scope === 'user') {
      items.push({
        key: `scope-header-${root.scope}`,
        value: null,
        disabled: true,
        hideNumber: true,
        isHeader: true,
        isScopeHeader: true,
        headerType: SCOPE_LABELS[root.scope],
      });
    }

    const grouped = new Map<MemoryType, MemoryEntry[]>();
    for (const entry of root.entries) {
      const list = grouped.get(entry.type) ?? [];
      list.push(entry);
      grouped.set(entry.type, list);
    }

    for (const type of TYPE_ORDER) {
      const typeEntries = grouped.get(type);
      if (!typeEntries || typeEntries.length === 0) continue;

      // Type header (disabled, not selectable)
      items.push({
        key: `header-${root.scope}-${type}`,
        value: null,
        disabled: true,
        hideNumber: true,
        isHeader: true,
        headerType: TYPE_LABELS[type],
      });

      for (const entry of typeEntries) {
        items.push({
          key: entry.filePath ?? entry.name,
          value: entry,
        });
      }
    }
  }

  return items;
}

export const MemoryManager: React.FC<MemoryManagerProps> = ({
  roots: initialRoots,
  onClose,
}) => {
  const [roots, setRoots] = useState(initialRoots);
  const [highlightedEntry, setHighlightedEntry] = useState<MemoryEntry | null>(
    null,
  );
  const [deleteConfirm, setDeleteConfirm] = useState<MemoryEntry | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const { stdin, setRawMode } = useStdin();

  const multiRoot = roots.length > 1;
  const items = useMemo(
    () => buildListItems(roots, multiRoot),
    [roots, multiRoot],
  );

  const refreshEntries = useCallback(async () => {
    const updated = await Promise.all(
      roots.map(async (root) => ({
        ...root,
        entries: await listStructuredMemoryFiles(root.dir),
      })),
    );
    setRoots(updated);
  }, [roots]);

  const handleSelect = useCallback(
    async (value: MemoryEntry | null) => {
      if (!value?.filePath) return;
      try {
        await openFileInEditor(value.filePath, stdin, setRawMode);
      } catch {
        // Already surfaced by openFileInEditor. Swallow so a failed launch
        // doesn't become an unhandled rejection.
        return;
      }
      // Refresh after editing in case user changed content
      await refreshEntries();
    },
    [stdin, setRawMode, refreshEntries],
  );

  const handleDelete = useCallback(
    async (entry: MemoryEntry) => {
      if (!entry.filePath) return;
      try {
        const filename = basename(entry.filePath);
        // The entry's own root directory holds its MEMORY.md index — derive it
        // so deletes update the correct scope's index in the dual-root case.
        const rootDir = dirname(entry.filePath);
        await deleteMemoryFile(entry.filePath);
        await removeIndexEntry(rootDir, filename);
        await refreshEntries();
        setStatusMessage(`Deleted: ${entry.name}`);
        setDeleteConfirm(null);
        // Clear status after a moment
        setTimeout(() => setStatusMessage(null), 2000);
      } catch (err) {
        setStatusMessage(`Failed to delete: ${(err as Error).message}`);
        setDeleteConfirm(null);
      }
    },
    [refreshEntries],
  );

  // Fallback handler: delete confirmation and 'd' to initiate delete
  useRegisterFallbackHandler(
    'Dialog',
    useCallback(
      (key: Key) => {
        // Delete confirmation mode
        if (deleteConfirm) {
          if (key.name === 'y') {
            void handleDelete(deleteConfirm);
            return true;
          }
          if (key.name === 'n' || key.name === 'escape') {
            setDeleteConfirm(null);
            return true;
          }
          // Swallow all other keys during confirmation
          return true;
        }

        // 'd' to initiate delete
        if (key.name === 'd' && highlightedEntry) {
          setDeleteConfirm(highlightedEntry);
          return true;
        }

        return false;
      },
      [deleteConfirm, highlightedEntry, handleDelete],
    ),
    true,
  );

  const extraHints = useMemo<ShortcutHint[]>(
    () => [
      { label: SHORTCUT_HINTS.ENTER_EDIT, order: 10 },
      { label: SHORTCUT_HINTS.DELETE, order: 20 },
    ],
    [],
  );

  const selectableCount = roots.reduce((n, r) => n + r.entries.length, 0);

  return (
    <BaseTabDialog
      title={`Auto-Memory Manager (${selectableCount} ${selectableCount === 1 ? 'file' : 'files'})`}
      tabs={[]}
      activeKey=""
      onTabChange={() => {}}
      onClose={onClose}
      extraHints={extraHints}
    >
      {selectableCount === 0 ? (
        <Text color={theme.text.secondary}>
          No auto-memory files found. Memories will be automatically created
          during conversations.
        </Text>
      ) : (
        <BaseSelectionList<MemoryEntry | null, MemoryListItem>
          items={items}
          onSelect={handleSelect}
          onHighlight={(value) => {
            if (value) setHighlightedEntry(value);
          }}
          showNumbers
          showScrollArrows
          maxItemsToShow={12}
          variant="arrow"
          renderItem={(
            item: MemoryListItem,
            ctx: RenderItemContext,
          ): React.ReactNode => {
            if (item.isHeader) {
              return (
                <Text
                  bold
                  color={
                    item.isScopeHeader
                      ? theme.text.primary
                      : theme.text.secondary
                  }
                >
                  {item.isScopeHeader ? `▌ ${item.headerType}` : item.headerType}
                </Text>
              );
            }

            const entry = item.value;
            if (!entry) return null;

            const filename = entry.filePath
              ? (entry.filePath.split('/').pop() ?? entry.name)
              : entry.name;

            return (
              <Box flexDirection="column">
                <Text color={ctx.titleColor} bold>
                  {filename}
                </Text>
                {entry.description && (
                  <Text color={theme.text.secondary}>{entry.description}</Text>
                )}
              </Box>
            );
          }}
        />
      )}

      {/* Delete confirmation */}
      {deleteConfirm && (
        <Box marginTop={1}>
          <Text color={theme.status.warning}>
            Delete &quot;{deleteConfirm.name}&quot;? (y/n)
          </Text>
        </Box>
      )}

      {/* Status message */}
      {statusMessage && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>{statusMessage}</Text>
        </Box>
      )}
    </BaseTabDialog>
  );
};
