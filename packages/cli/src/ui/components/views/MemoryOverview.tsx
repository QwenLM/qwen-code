/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo, useCallback, useEffect, useState } from 'react';
import { Box, Text, useStdin } from 'ink';
import {
  getGlobalContextFilePaths,
  getScopedAutoMemoryDirs,
  type Config,
} from '@qwen-code/core';
import { theme } from '../../semantic-colors.js';
import {
  BaseSelectionList,
  type RenderItemContext,
} from '../shared/BaseSelectionList.js';
import type { SelectionListItem } from '../../hooks/useSelectionList.js';
import type { ShortcutHint } from '../../hooks/useContainerKeyboard.js';
import { BaseTabDialog } from '../shared/BaseTabDialog.js';
import { SHORTCUT_HINTS } from '../../constants/shortcuts.js';
import { openFileInEditor } from '../../utils/editorUtils.js';
import { isGitRepository } from '../../utils/gitDiff.js';
import { exec } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

interface MemoryOverviewItem extends SelectionListItem<OverviewEntry | null> {
  isHeader?: boolean;
  headerLabel?: string;
}

type OverviewEntryAction = 'open-file' | 'open-folder';

interface OverviewEntry {
  label: string;
  detail: string;
  action: OverviewEntryAction;
  filePath?: string;
}

interface MemoryOverviewProps {
  config: Config;
  onClose: () => void;
}

const caseInsensitive =
  process.platform === 'darwin' || process.platform === 'win32';

const normaliseForCompare = (p: string) => {
  const normalized = path.normalize(p);
  return caseInsensitive ? normalized.toLowerCase() : normalized;
};

const homeDir = process.env['HOME'] ?? '';

function isRelativeInside(relativePath: string): boolean {
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function getRelativeInside(baseDir: string, filePath: string): string | null {
  const relative = path.relative(baseDir, filePath);
  if (relative === '' || isRelativeInside(relative)) return relative;

  if (!caseInsensitive) return null;

  const relativeIgnoreCase = path.relative(
    path.resolve(baseDir).toLowerCase(),
    path.resolve(filePath).toLowerCase(),
  );
  if (relativeIgnoreCase === '' || isRelativeInside(relativeIgnoreCase)) {
    return relativeIgnoreCase;
  }

  return null;
}

function withPreferredBasename(
  displayValue: string,
  preferredBasename?: string,
): string {
  if (
    !preferredBasename ||
    normaliseForCompare(path.basename(displayValue)) !==
      normaliseForCompare(preferredBasename)
  ) {
    return displayValue;
  }

  const dir = path.dirname(displayValue);
  if (dir === '.') {
    return displayValue.startsWith('./')
      ? `./${preferredBasename}`
      : preferredBasename;
  }
  return path.join(dir, preferredBasename);
}

function shortenHomePath(filePath: string): string {
  if (!path.isAbsolute(filePath)) return filePath;
  if (!homeDir) return filePath;
  const relative = getRelativeInside(homeDir, filePath);
  if (relative === '') return '~';
  if (relative !== null) {
    return path.join('~', relative);
  }
  return filePath;
}

function displayPath(
  filePath: string,
  baseDir?: string,
  preferredBasename?: string,
): string {
  if (baseDir && path.isAbsolute(filePath)) {
    const relative = getRelativeInside(baseDir, filePath);
    if (relative === '') return '.';
    if (relative !== null) {
      return withPreferredBasename('./' + relative, preferredBasename);
    }
  }
  return withPreferredBasename(shortenHomePath(filePath), preferredBasename);
}

function resolveEditorFilePath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    try {
      return fs.realpathSync(filePath);
    } catch {
      return filePath;
    }
  }
}

function buildItems(
  config: Config,
  autoMemoryEnabled: boolean,
  isGit: boolean,
): MemoryOverviewItem[] {
  const items: MemoryOverviewItem[] = [];
  const contextFileName = config.getCurrentContextFileName();
  const [globalFilePath] = getGlobalContextFilePaths(
    config.getAllContextFileNames(),
  );
  const cwd = config.storage.getProjectRoot();
  const projectFilePath = path.join(cwd, contextFileName);

  // Get categorized paths from config
  const categorized = config.getCategorizedMemoryPaths();
  const globalPaths = categorized?.global ?? [];
  const projectPaths = categorized?.project ?? [];
  const localPaths = categorized?.local ?? [];

  // User memory section
  if (globalPaths.length > 0) {
    for (const fp of globalPaths) {
      items.push({
        key: fp,
        value: {
          label: 'User memory',
          detail: `Saved in ${displayPath(fp, undefined, contextFileName)}`,
          action: 'open-file',
          filePath: fp,
        },
      });
    }
  } else {
    items.push({
      key: 'global-memory',
      value: {
        label: 'User memory',
        detail: 'Not created yet',
        action: 'open-file',
        filePath: globalFilePath,
      },
    });
  }

  // Project memory section (checked in)
  if (projectPaths.length > 0) {
    for (const fp of projectPaths) {
      const relPath = displayPath(fp, cwd, path.basename(projectFilePath));

      const isMainProjectFile =
        normaliseForCompare(fp) === normaliseForCompare(projectFilePath);
      items.push({
        key: fp,
        value: {
          label: isMainProjectFile ? 'Project memory' : `Project: ${relPath}`,
          detail: `${isGit ? 'Checked in at' : 'Saved in'} ${relPath}`,
          action: 'open-file',
          filePath: fp,
        },
      });
    }
  } else {
    items.push({
      key: 'project-memory',
      value: {
        label: 'Project memory',
        detail: `Not created yet (${path.basename(projectFilePath)})`,
        action: 'open-file',
        filePath: projectFilePath,
      },
    });
  }

  // Local memory section (private, not checked in)
  for (const fp of localPaths) {
    const relPath = displayPath(fp, cwd);

    const isRootLocalFile =
      normaliseForCompare(path.dirname(fp)) === normaliseForCompare(cwd);
    items.push({
      key: fp,
      value: {
        label: isRootLocalFile ? 'Local memory' : `Local: ${relPath}`,
        detail: `Private, not checked in (${relPath})`,
        action: 'open-file',
        filePath: fp,
      },
    });
  }

  // Auto-memory folder entries — one per independently enabled scope root.
  if (autoMemoryEnabled) {
    const scopedDirs = getScopedAutoMemoryDirs(config);
    const multiScope = scopedDirs.length > 1;
    for (const { scope, dir } of scopedDirs) {
      items.push({
        key: `auto-memory-folder-${scope}`,
        value: {
          label: multiScope || scope === 'user'
            ? `Open auto-memory folder (${scope} scope)`
            : 'Open auto-memory folder',
          detail: displayPath(dir),
          action: 'open-folder',
          filePath: dir,
        },
      });
    }
  }

  return items;
}

export const MemoryOverview: React.FC<MemoryOverviewProps> = ({
  config,
  onClose,
}) => {
  const { stdin, setRawMode } = useStdin();
  const autoMemoryEnabled = config.isAutoMemoryEnabled();
  const cwd = config.storage.getProjectRoot();
  const [isGit, setIsGit] = useState(false);
  useEffect(() => {
    let active = true;
    setIsGit(false);
    void isGitRepository(cwd).then((value) => {
      if (active) setIsGit(value);
    });
    return () => {
      active = false;
    };
  }, [cwd]);
  const items = useMemo(
    () => buildItems(config, autoMemoryEnabled, isGit),
    [config, autoMemoryEnabled, isGit],
  );

  const handleSelect = useCallback(
    async (value: OverviewEntry | null) => {
      if (!value) return;

      switch (value.action) {
        case 'open-folder': {
          if (!value.filePath) return;
          const platform = process.platform;
          const cmd =
            platform === 'darwin'
              ? 'open'
              : platform === 'win32'
                ? 'explorer'
                : 'xdg-open';
          exec(`${cmd} "${value.filePath}"`);
          onClose();
          return;
        }
        case 'open-file': {
          if (!value.filePath) return;
          // Ensure file exists before opening
          if (!fs.existsSync(value.filePath)) {
            const dir = path.dirname(value.filePath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(value.filePath, '', 'utf-8');
          }
          try {
            await openFileInEditor(
              resolveEditorFilePath(value.filePath),
              stdin,
              setRawMode,
            );
          } catch {
            // Already surfaced by openFileInEditor. Swallow so a failed launch
            // doesn't become an unhandled rejection.
          } finally {
            onClose();
          }
          return;
        }
        default: {
          return;
        }
      }
    },
    [stdin, setRawMode, onClose],
  );

  const extraHints = useMemo<ShortcutHint[]>(
    () => [{ label: SHORTCUT_HINTS.SELECT, order: 30 }],
    [],
  );

  return (
    <BaseTabDialog
      title="Memory"
      tabs={[]}
      activeKey=""
      onTabChange={() => {}}
      onClose={onClose}
      extraHints={extraHints}
    >
      <BaseSelectionList<OverviewEntry | null, MemoryOverviewItem>
        items={items}
        onSelect={handleSelect}
        showNumbers
        variant="arrow"
        renderItem={(
          item: MemoryOverviewItem,
          ctx: RenderItemContext,
        ): React.ReactNode => {
          if (item.isHeader) {
            return (
              <Text bold color={theme.text.secondary}>
                {item.headerLabel}
              </Text>
            );
          }

          const entry = item.value;
          if (!entry) return null;

          return (
            <Box flexDirection="column">
              <Text color={ctx.titleColor} bold>
                {entry.label}
              </Text>
              {entry.detail && (
                <Text color={theme.text.secondary}>{entry.detail}</Text>
              )}
            </Box>
          );
        }}
      />
    </BaseTabDialog>
  );
};
