/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import * as process from 'node:process';
import type { PermissionUpdate } from '@qwen-code/core';
import { theme } from '../../semantic-colors.js';

/**
 * Where a trusted directory came from.
 *
 * Derived from the settings file rather than carried on the directory itself: the
 * module keeps one flat list with no source attribution, and reading the truth out
 * of settings is more reliable than a label remembered from when it was added.
 * A directory that is not in local settings is session-scoped in effect — it goes
 * away on the next launch unless `--add-dir` names it again.
 */
type DirSource = 'localSettings' | 'session';

interface DirEntry {
  path: string;
  source: DirSource;
}
import { useSettingsStore, useSettings } from '../../contexts/SettingsContext.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import { SettingScope } from '../../../config/settings.js';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from '../shared/RadioButtonSelect.js';
import type { RenderItemContext } from '../shared/BaseSelectionList.js';
import { useRegisterFallbackHandler } from '../../contexts/ActionHandlerRegistry.js';
import { RemoveWorkspaceDirectory } from './RemoveWorkspaceDirectory.js';
import { AddWorkspaceDirectory } from './AddWorkspaceDirectory.js';
import type { AddDirTrustChoice } from '../../commands/AddDirTrustSelector.js';
import { formatScopeTag } from '../../utils/scopeTag.js';

// Sentinel value used as the "Add directory…" entry's item key/value.
const ADD_DIRECTORY_KEY = '__add-workspace-directory__';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Maps a directory's source to a human-readable scope label.
 * Delegates to the shared formatScopeTag helper.
 */
function formatSourceTag(source: DirSource | undefined) {
  return formatScopeTag(source);
}

/** The paths local settings has written down. */
function persistedDirectories(
  localPermissions: Record<string, unknown> | undefined,
): string[] {
  return (localPermissions?.['additionalDirectories'] as string[]) ?? [];
}

// ── Types ────────────────────────────────────────────────────────────────────

interface TrustTabProps {
  /** The directories trusted beyond the workspace root, as the module holds them. */
  trustedDirectories: string[];
  /** Applies directory changes to the live module and re-renders the dialog. */
  applyUpdates: (...updates: PermissionUpdate[]) => void;
  /** Close callback (currently unused but kept for parity with other tabs). */
  onClose: () => void;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Trust tab content for the /permissions dialog.
 *
 * The data source is the runtime `additionalWorkingDirectories` map on the
 * permission context, so both session-only and persisted directories are
 * visible in a single unified list — keeping the UI in sync with what the
 * permission pipeline actually sees. Users can add new directories from the
 * top-of-list "Add directory…" entry (path input + trust choice flow) and
 * remove existing ones with x (gated by the confirmation sub-screen).
 *
 * Keyboard:
 *   ↑/↓   navigate
 *   Enter "Add directory…" → AddWorkspaceDirectory flow
 *   x     request removal of the highlighted directory; the actual delete
 *         is gated by the RemoveWorkspaceDirectory confirmation sub-screen.
 */
export function TrustTab({
  trustedDirectories,
  applyUpdates,
  onClose: _onClose,
}: TrustTabProps): React.JSX.Element {
  const { settings } = useSettingsStore();
  const rawSettings = useSettings();
  const config = useConfig();
  const cwd = process.cwd();

  // Source of truth: the in-memory permission context. Includes both
  // session-only directories (added via /add-dir → 'memory' choice) and
  // persisted directories loaded from settings files.
  const directories: DirEntry[] = useMemo(() => {
    const persisted = new Set(
      persistedDirectories(
        settings.local.settings.permissions as Record<string, unknown> | undefined,
      ),
    );
    return trustedDirectories.map((path) => ({
      path,
      source: persisted.has(path) ? 'localSettings' : 'session',
    }));
  }, [trustedDirectories, settings]);

  const items: Array<RadioSelectItem<string>> = [
    {
      key: ADD_DIRECTORY_KEY,
      value: ADD_DIRECTORY_KEY,
      label: 'Add directory…',
    },
    ...directories.map((dir) => ({
      key: dir.path,
      value: dir.path,
      label: dir.path,
    })),
  ];

  // Build a quick lookup so renderItem can show the originating source
  // without re-iterating the directories array on every render frame.
  const sourceByPath = useMemo(() => {
    const map = new Map<string, DirSource>();
    for (const d of directories) map.set(d.path, d.source);
    return map;
  }, [directories]);

  // Track highlighted directory via ref to avoid stale closures in the
  // fallback handler. Initialize to the first item.
  const highlightedPathRef = useRef<string | undefined>(directories[0]?.path);

  const handleHighlight = useCallback((path: string) => {
    highlightedPathRef.current = path;
  }, []);

  // When non-null, the dialog is showing the RemoveWorkspaceDirectory
  // confirmation sub-screen for this directory.
  const [pendingRemoval, setPendingRemoval] = useState<
    DirEntry | null
  >(null);

  const performDelete = useCallback(
    (dir: DirEntry) => {
      if (dir.source === 'localSettings') {
        const saved = rawSettings.updateValue(
          SettingScope.Local,
          'permissions.additionalDirectories',
          (current) =>
            (Array.isArray(current) ? current : []).filter(
              (entry) => entry !== dir.path,
            ),
        );
        if (!saved) return;
      }

      applyUpdates({
        type: 'removeDirectories',
        destination: 'session',
        directories: [dir.path],
      });
    },
    [applyUpdates, rawSettings],
  );

  const handleRequestRemove = useCallback(
    (path: string) => {
      const dir = directories.find((d) => d.path === path);
      if (!dir) return;
      setPendingRemoval(dir);
    },
    [directories],
  );

  const handleConfirmRemove = useCallback(() => {
    if (pendingRemoval) {
      performDelete(pendingRemoval);
    }
    setPendingRemoval(null);
  }, [pendingRemoval, performDelete]);

  const handleCancelRemove = useCallback(() => {
    setPendingRemoval(null);
  }, []);

  // Add directory flow ------------------------------------------------------
  const [isAddingDirectory, setIsAddingDirectory] = useState(false);
  const [addWarning, setAddWarning] = useState<string | null>(null);

  const performAdd = useCallback(
    (
      resolvedPath: string,
      choice: AddDirTrustChoice,
    ): string | null | false => {
      // Reject duplicate (exact match)
      if (trustedDirectories.includes(resolvedPath)) {
        return `Directory already trusted: ${resolvedPath}`;
      }

      // If local settings is read-only (home directory workspace), downgrade
      let effectiveChoice = choice;
      if (choice === 'persist' && rawSettings.local.readOnly) {
        effectiveChoice = 'memory';
      }

      if (effectiveChoice === 'persist') {
        const saved = rawSettings.updateValue(
          SettingScope.Local,
          'permissions.additionalDirectories',
          (current) => {
            const existing = Array.isArray(current)
              ? current.filter(
                  (entry): entry is string => typeof entry === 'string',
                )
              : [];
            return existing.includes(resolvedPath)
              ? existing
              : [...existing, resolvedPath];
          },
        );
        if (!saved) return false;
      }

      try {
        config.getWorkspaceContext().addDirectory(resolvedPath);
      } catch {
        // If workspace context rejects, continue.
      }

      applyUpdates({
        type: 'addDirectories',
        destination: 'session',
        directories: [resolvedPath],
      });

      if (choice === 'persist' && effectiveChoice !== 'persist') {
        return 'Cannot persist in this workspace (home directory) \u2014 added for this session only.';
      }
      return null;
    },
    [config, trustedDirectories, applyUpdates, rawSettings],
  );

  const handleAddSubmit = useCallback(
    (resolvedPath: string, choice: AddDirTrustChoice) => {
      const warning = performAdd(resolvedPath, choice);
      if (warning === false) return;
      setAddWarning(warning);
      setIsAddingDirectory(false);
    },
    [performAdd],
  );

  const handleAddCancel = useCallback(() => {
    setIsAddingDirectory(false);
  }, []);

  const handleListSelect = useCallback(
    (value: string) => {
      setAddWarning(null);
      if (value === ADD_DIRECTORY_KEY) {
        setIsAddingDirectory(true);
        return;
      }
      // Pressing Enter on an existing directory entry asks to remove it.
      // The actual delete is still gated by the RemoveWorkspaceDirectory
      // confirmation sub-screen, so a stray Enter cannot drop a trusted
      // directory by accident.
      handleRequestRemove(value);
    },
    [handleRequestRemove],
  );

  // Handle 'x' key to request removal of the highlighted directory.
  // The actual delete waits for confirmation in RemoveWorkspaceDirectory.
  // Skipped while the highlight is on the synthetic "Add directory…" entry,
  // and while either sub-screen is active.
  useRegisterFallbackHandler(
    'Select',
    useCallback(
      (key) => {
        if (
          key.sequence === 'x' &&
          highlightedPathRef.current &&
          highlightedPathRef.current !== ADD_DIRECTORY_KEY
        ) {
          handleRequestRemove(highlightedPathRef.current);
          return true;
        }
        return false;
      },
      [handleRequestRemove],
    ),
    directories.length > 0 && pendingRemoval === null && !isAddingDirectory,
  );

  const renderItem = useCallback(
    (item: RadioSelectItem<string>, { titleColor }: RenderItemContext) => {
      if (item.value === ADD_DIRECTORY_KEY) {
        return (
          <Box>
            <Text color={titleColor} bold>
              {item.label}
            </Text>
          </Box>
        );
      }
      const source = sourceByPath.get(item.value);
      const tag = formatSourceTag(source);
      return (
        <Box>
          <Text color={titleColor} wrap="truncate">
            {item.label}
          </Text>
          {tag && (
            <>
              <Text color={theme.text.secondary}> </Text>
              <Text color={tag.color} bold>
                [{tag.label}]
              </Text>
            </>
          )}
        </Box>
      );
    },
    [sourceByPath],
  );

  // Sub-screens rendered alongside the main list. The main list stays
  // mounted (display:none) so RadioButtonSelect keeps its cursor position.
  // IMPORTANT: display:none Box must render BEFORE sub-screens so that its
  // useLayoutEffect (unregister Select) fires before the sub-screen's
  // mount effect (register Select), keeping Select context active.
  const isSubScreenActive = !!pendingRemoval || isAddingDirectory;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" display={isSubScreenActive ? 'none' : 'flex'}>
        {addWarning && (
          <Box marginBottom={1}>
            <Text color={theme.status.warning}>{addWarning}</Text>
          </Box>
        )}
        <Box marginBottom={1} flexDirection="column">
          <Text color={theme.text.secondary}>
            {cwd} <Text dimColor>(Original working directory)</Text>
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text>Additional Directories:</Text>
          <Box marginTop={1}>
            <RadioButtonSelect
              items={items}
              onSelect={handleListSelect}
              onHighlight={handleHighlight}
              isFocused={!isSubScreenActive}
              showNumbers={false}
              renderItem={renderItem}
            />
          </Box>
          {directories.length === 0 && (
            <Box marginTop={1}>
              <Text color={theme.text.secondary}>
                No additional directories added yet — pick “Add directory…” above
                to add one.
              </Text>
            </Box>
          )}
        </Box>
      </Box>

      {pendingRemoval && (
        <RemoveWorkspaceDirectory
          directory={pendingRemoval.path}
          isPersisted={pendingRemoval.source === 'localSettings'}
          onConfirm={handleConfirmRemove}
          onCancel={handleCancelRemove}
        />
      )}
      {isAddingDirectory && (
        <AddWorkspaceDirectory
          onSubmit={handleAddSubmit}
          onCancel={handleAddCancel}
        />
      )}
    </Box>
  );
}
