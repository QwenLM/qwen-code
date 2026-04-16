/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  getAllGeminiMdFilenames,
  QWEN_DIR,
  getAutoMemoryRoot,
  getAutoMemoryProjectStateDir,
} from '@qwen-code/qwen-code-core';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { SettingScope } from '../../config/settings.js';
import { useLaunchEditor } from '../hooks/useLaunchEditor.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { t } from '../../i18n/index.js';

type MemoryDialogTarget = 'project' | 'global' | 'managed';

interface MemoryDialogProps {
  onClose: () => void;
}

interface DialogItem {
  label: string;
  value: MemoryDialogTarget;
  description?: string;
}

async function resolvePreferredMemoryFile(
  dir: string,
  fallbackFilename: string,
): Promise<string> {
  for (const filename of getAllGeminiMdFilenames()) {
    const filePath = path.join(dir, filename);
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // Try the next configured file name.
    }
  }

  return path.join(dir, fallbackFilename);
}

function openFolderPath(folderPath: string): void {
  let command = 'xdg-open';

  switch (process.platform) {
    case 'darwin':
      command = 'open';
      break;
    case 'win32':
      command = 'explorer';
      break;
    default:
      command = 'xdg-open';
      break;
  }

  const needsShell =
    process.platform === 'win32' &&
    (command.endsWith('.cmd') || command.endsWith('.bat'));

  const result = spawnSync(command, [folderPath], {
    stdio: 'inherit',
    shell: needsShell,
  });

  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`Folder opener exited with status ${result.status}`);
  }
}

async function ensureFileExists(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, '', 'utf-8');
  }
}

function formatDisplayPath(filePath: string): string {
  const home = os.homedir();
  if (filePath.startsWith(home)) {
    return `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

export function MemoryDialog({ onClose }: MemoryDialogProps) {
  const config = useConfig();
  const loadedSettings = useSettings();
  const launchEditor = useLaunchEditor();
  const [error, setError] = useState<string | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  // 'autoMemory' | 'autoDream' = focus on that toggle row; 'list' = focus on the file list
  const [focusedSection, setFocusedSection] = useState<
    'autoMemory' | 'autoDream' | 'list'
  >('list');
  const [autoMemoryOn, setAutoMemoryOn] = useState(() =>
    config.getManagedAutoMemoryEnabled(),
  );
  const [autoDreamOn, setAutoDreamOn] = useState(() =>
    config.getManagedAutoDreamEnabled(),
  );
  const [lastDreamAt, setLastDreamAt] = useState<number | null>(null);

  const globalMemoryPath = useMemo(
    () =>
      path.join(
        os.homedir(),
        QWEN_DIR,
        getAllGeminiMdFilenames()[0] ?? 'QWEN.md',
      ),
    [],
  );
  const projectMemoryPath = useMemo(
    () =>
      path.join(
        config.getWorkingDir(),
        getAllGeminiMdFilenames()[0] ?? 'QWEN.md',
      ),
    [config],
  );
  const managedMemoryPath = useMemo(
    () => getAutoMemoryRoot(config.getProjectRoot()),
    [config],
  );

  const memoryStatePath = useMemo(
    () => getAutoMemoryProjectStateDir(config.getProjectRoot()),
    [config],
  );

  const items = useMemo<DialogItem[]>(
    () => [
      {
        label: t('User memory'),
        value: 'global',
        description: t('Saved in {{path}}', {
          path: formatDisplayPath(globalMemoryPath),
        }),
      },
      {
        label: t('Project memory'),
        value: 'project',
        description: t('Saved in {{path}}', {
          path:
            path.relative(config.getWorkingDir(), projectMemoryPath) ||
            path.basename(projectMemoryPath),
        }),
      },
      {
        label: t('Open auto-memory folder'),
        value: 'managed',
      },
    ],
    [config, globalMemoryPath, projectMemoryPath],
  );

  // Load lastDreamAt from meta.json
  useEffect(() => {
    let cancelled = false;

    async function loadMeta() {
      try {
        const metadataPath = path.join(memoryStatePath, 'meta.json');
        const content = await fs.readFile(metadataPath, 'utf-8');
        const parsed = JSON.parse(content) as { lastDreamAt?: string };
        if (!cancelled && parsed.lastDreamAt) {
          const ts = new Date(parsed.lastDreamAt).getTime();
          if (!Number.isNaN(ts)) {
            setLastDreamAt(ts);
          }
        }
      } catch {
        // meta.json not found or invalid — keep null
      }
    }

    void loadMeta();
    return () => {
      cancelled = true;
    };
  }, [memoryStatePath]);

  const dreamStatusText = useMemo(() => {
    if (lastDreamAt !== null) return formatRelativeTime(lastDreamAt);
    return t('never');
  }, [lastDreamAt]);

  const resolveTargetPath = useCallback(
    async (target: MemoryDialogTarget): Promise<string> => {
      switch (target) {
        case 'project':
          return resolvePreferredMemoryFile(
            config.getWorkingDir(),
            getAllGeminiMdFilenames()[0] ?? 'QWEN.md',
          );
        case 'global':
          return resolvePreferredMemoryFile(
            path.join(os.homedir(), QWEN_DIR),
            getAllGeminiMdFilenames()[0] ?? 'QWEN.md',
          );
        case 'managed':
          return managedMemoryPath;
        default:
          return managedMemoryPath;
      }
    },
    [config, managedMemoryPath],
  );

  const handleSelect = useCallback(
    async (target: MemoryDialogTarget) => {
      try {
        setError(null);
        const targetPath = await resolveTargetPath(target);
        if (target === 'managed') {
          await fs.mkdir(targetPath, { recursive: true });
          openFolderPath(targetPath);
        } else {
          await ensureFileExists(targetPath);
          await launchEditor(targetPath);
        }
        onClose();
      } catch (selectionError) {
        setError(
          selectionError instanceof Error
            ? selectionError.message
            : String(selectionError),
        );
      }
    },
    [launchEditor, onClose, resolveTargetPath],
  );

  const handleToggleAutoMemory = useCallback(() => {
    const newValue = !autoMemoryOn;
    loadedSettings.setValue(
      SettingScope.Workspace,
      'memory.enableManagedAutoMemory',
      newValue,
    );
    setAutoMemoryOn(newValue);
  }, [autoMemoryOn, loadedSettings]);

  const handleToggleAutoDream = useCallback(() => {
    const newValue = !autoDreamOn;
    loadedSettings.setValue(
      SettingScope.Workspace,
      'memory.enableManagedAutoDream',
      newValue,
    );
    setAutoDreamOn(newValue);
  }, [autoDreamOn, loadedSettings]);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onClose();
        return;
      }

      if (focusedSection === 'autoMemory') {
        if (key.name === 'down') {
          setFocusedSection('autoDream');
          return;
        }
        if (key.name === 'return') {
          handleToggleAutoMemory();
          return;
        }
        return;
      }

      if (focusedSection === 'autoDream') {
        if (key.name === 'up') {
          setFocusedSection('autoMemory');
          return;
        }
        if (key.name === 'down') {
          setFocusedSection('list');
          setHighlightedIndex(0);
          return;
        }
        if (key.name === 'return') {
          handleToggleAutoDream();
          return;
        }
        return;
      }

      // focusedSection === 'list'
      if (key.name === 'up') {
        if (highlightedIndex === 0) {
          setFocusedSection('autoDream');
        } else {
          setHighlightedIndex((current) => current - 1);
        }
        return;
      }

      if (key.name === 'down') {
        setHighlightedIndex((current) => (current + 1) % items.length);
        return;
      }

      if (key.name === 'return') {
        void handleSelect(items[highlightedIndex]?.value ?? 'project');
        return;
      }

      if (key.sequence && /^[1-3]$/.test(key.sequence)) {
        const nextIndex = Number(key.sequence) - 1;
        if (items[nextIndex]) {
          setHighlightedIndex(nextIndex);
          void handleSelect(items[nextIndex].value);
        }
      }
    },
    { isActive: true },
  );

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>{t('Memory')}</Text>

      <Box marginTop={1} flexDirection="column">
        <Text
          color={
            focusedSection === 'autoMemory'
              ? theme.status.success
              : theme.text.secondary
          }
        >
          {focusedSection === 'autoMemory' ? '› ' : '  '}
          {t('Auto-memory: {{status}}', {
            status: autoMemoryOn ? t('on') : t('off'),
          })}
        </Text>
        <Text
          color={
            focusedSection === 'autoDream'
              ? theme.status.success
              : theme.text.secondary
          }
        >
          {focusedSection === 'autoDream' ? '› ' : '  '}
          {t('Auto-dream: {{status}} · {{lastDream}} · /dream to run', {
            status: autoDreamOn ? t('on') : t('off'),
            lastDream: dreamStatusText,
          })}
        </Text>
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{error}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        {items.map((item, index) => {
          const isSelected =
            focusedSection === 'list' && index === highlightedIndex;
          return (
            <Box key={item.value} flexDirection="row">
              <Text color={isSelected ? theme.status.success : undefined}>
                {isSelected ? '› ' : '  '}
                {index + 1}. {item.label}
              </Text>
              {item.description ? (
                <Text color={theme.text.secondary}>{`  ${item.description}`}</Text>
              ) : null}
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t('Enter to confirm · Esc to cancel')}
        </Text>
      </Box>
    </Box>
  );
}
