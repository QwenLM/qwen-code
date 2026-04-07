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
} from '@qwen-code/qwen-code-core';
import { useConfig } from '../contexts/ConfigContext.js';
import { useLaunchEditor } from '../hooks/useLaunchEditor.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';

type MemoryDialogTarget = 'project' | 'global' | 'managed';

interface MemoryDialogProps {
  onClose: () => void;
}

interface DialogItem {
  label: string;
  value: MemoryDialogTarget;
  description: string;
}

interface MemoryStatusState {
  lastExtractionAt?: string;
  lastDreamAt?: string;
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

function formatStatusTime(iso?: string): string {
  if (!iso) {
    return t('never');
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return t('never');
  }

  return date.toLocaleString();
}

export function MemoryDialog({ onClose }: MemoryDialogProps) {
  const config = useConfig();
  const launchEditor = useLaunchEditor();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<MemoryStatusState>({});
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const globalMemoryPath = useMemo(
    () => path.join(os.homedir(), QWEN_DIR, getAllGeminiMdFilenames()[0] ?? 'QWEN.md'),
    [],
  );
  const projectMemoryPath = useMemo(
    () => path.join(config.getWorkingDir(), getAllGeminiMdFilenames()[0] ?? 'QWEN.md'),
    [config],
  );
  const managedMemoryPath = useMemo(
    () => path.join(config.getProjectRoot(), '.qwen', 'memory'),
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
        description: t('Checked in at {{path}}', {
          path: path.relative(config.getWorkingDir(), projectMemoryPath) || path.basename(projectMemoryPath),
        }),
      },
      {
        label: t('Open auto-memory folder'),
        value: 'managed',
        description: t('Browse indexed memory files in {{path}}', {
          path: path.relative(config.getWorkingDir(), managedMemoryPath) || '.qwen/memory',
        }),
      },
    ],
    [config, globalMemoryPath, managedMemoryPath, projectMemoryPath],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadStatus() {
      try {
        const metadataPath = path.join(managedMemoryPath, 'meta.json');
        const content = await fs.readFile(metadataPath, 'utf-8');
        const parsed = JSON.parse(content) as MemoryStatusState;
        if (!cancelled) {
          setStatus(parsed);
        }
      } catch {
        if (!cancelled) {
          setStatus({});
        }
      }
    }

    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, [managedMemoryPath]);

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
          return path.join(
            config.getProjectRoot(),
            '.qwen',
            'memory',
          );
      }
    },
    [config],
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

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onClose();
        return;
      }

      if (key.name === 'up') {
        setHighlightedIndex((current) =>
          current === 0 ? items.length - 1 : current - 1,
        );
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
        <Text color={theme.text.secondary}>
          {t('Auto-memory: on · Last write {{time}}', {
            time: formatStatusTime(status.lastExtractionAt),
          })}
        </Text>
        <Text color={theme.text.secondary}>
          {t('Auto-dream: on · Last run {{time}}', {
            time: formatStatusTime(status.lastDreamAt),
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
          const isSelected = index === highlightedIndex;
          return (
            <Box key={item.value} flexDirection="column" marginBottom={1}>
              <Text color={isSelected ? theme.status.success : undefined}>
                {`${isSelected ? '›' : ' '} ${index + 1}. ${item.label}`}
              </Text>
              <Box marginLeft={4}>
                <Text color={theme.text.secondary}>{item.description}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          {t('Enter to confirm · Esc to cancel')}
        </Text>
      </Box>
    </Box>
  );
}
