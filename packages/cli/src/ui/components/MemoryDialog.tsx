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
import { spawn } from 'node:child_process';
import {
  getAllGeminiMdFilenames,
  Storage,
  getAutoMemoryRoot,
  getAutoMemoryProjectStateDir,
  getUserAutoMemoryRoot,
  AUTO_MEMORY_INDEX_FILENAME,
} from '@qwen-code/qwen-code-core';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { SettingScope } from '../../config/settings.js';
import { useLaunchEditor } from '../hooks/useLaunchEditor.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { keyMatchers, Command } from '../keyMatchers.js';
import { theme } from '../semantic-colors.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { t } from '../../i18n/index.js';

type MemoryDialogTarget = 'project' | 'global';
type MemoryDialogAction = 'file' | 'folder';
const DISPLAY_ENV_VARS = ['DISPLAY', 'WAYLAND_DISPLAY', 'MIR_SOCKET'] as const;

interface MemoryDialogProps {
  onClose: () => void;
}

interface DialogItem {
  label: string;
  value: MemoryDialogTarget;
  action: MemoryDialogAction;
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

async function openFolderPath(folderPath: string): Promise<void> {
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

  const child = spawn(command, [folderPath], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    // Exit codes are intentionally not observed: the folder opener is
    // fire-and-forget, and waiting for exit can block until the file manager
    // closes.
    child.once('spawn', () => resolve());
  });
}

function shouldOpenFolderPath(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return true;
  }
  return DISPLAY_ENV_VARS.some((key) => Boolean(process.env[key]));
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
  // 'autoMemory' | 'autoDream' | 'autoSkill' | 'autoSkillConfirm' = focus on that toggle row; 'list' = focus on the file list
  const [focusedSection, setFocusedSection] = useState<
    'autoMemory' | 'autoDream' | 'autoSkill' | 'autoSkillConfirm' | 'list'
  >('list');
  // Read the initial toggle state from the live merged settings rather than
  // the Config snapshot: Config is frozen at startup and never reflects a
  // setValue() write, so reopening the dialog would otherwise show stale state.
  const bareMode = config.getBareMode();
  const safeMode = config.isSafeMode();
  const readToggle = (value: boolean | undefined): boolean =>
    !bareMode && !safeMode && (value ?? true);
  const [autoMemoryOn, setAutoMemoryOn] = useState(() =>
    readToggle(loadedSettings.merged.memory?.enableManagedAutoMemory),
  );
  const [autoDreamOn, setAutoDreamOn] = useState(() =>
    readToggle(loadedSettings.merged.memory?.enableManagedAutoDream),
  );
  const [autoSkillOn, setAutoSkillOn] = useState(() =>
    readToggle(loadedSettings.merged.memory?.enableAutoSkill),
  );
  const [autoSkillConfirmOn, setAutoSkillConfirmOn] = useState(() =>
    readToggle(loadedSettings.merged.memory?.autoSkillConfirm ?? true),
  );
  const [lastDreamAt, setLastDreamAt] = useState<number | null>(null);

  const globalMemoryPath = useMemo(
    () =>
      path.join(
        Storage.getGlobalQwenDir(),
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
  const managedUserMemoryPath = useMemo(() => getUserAutoMemoryRoot(), []);

  const memoryStatePath = useMemo(
    () => getAutoMemoryProjectStateDir(config.getProjectRoot()),
    [config],
  );

  const items = useMemo<DialogItem[]>(() => {
    if (config.isManagedMemoryAvailable()) {
      return [
        {
          label: t('User memory'),
          value: 'global',
          action: 'folder',
          description: t('Saved in {{path}}', {
            path: formatDisplayPath(managedUserMemoryPath),
          }),
        },
        {
          label: t('Project memory'),
          value: 'project',
          action: 'folder',
          description: t('Saved in {{path}}', {
            path: formatDisplayPath(managedMemoryPath),
          }),
        },
      ];
    }

    return [
      {
        label: t('User memory'),
        value: 'global',
        action: 'file',
        description: t('Saved in {{path}}', {
          path: formatDisplayPath(globalMemoryPath),
        }),
      },
      {
        label: t('Project memory'),
        value: 'project',
        action: 'file',
        description: t('Saved in {{path}}', {
          path:
            path.relative(config.getWorkingDir(), projectMemoryPath) ||
            path.basename(projectMemoryPath),
        }),
      },
    ];
  }, [
    config,
    globalMemoryPath,
    managedMemoryPath,
    managedUserMemoryPath,
    projectMemoryPath,
  ]);

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
    async (item: DialogItem): Promise<string> => {
      if (item.action === 'folder') {
        switch (item.value) {
          case 'global':
            return managedUserMemoryPath;
          case 'project':
            return managedMemoryPath;
          default: {
            const _exhaustive: never = item.value;
            return _exhaustive;
          }
        }
      }

      switch (item.value) {
        case 'project':
          return resolvePreferredMemoryFile(
            config.getWorkingDir(),
            getAllGeminiMdFilenames()[0] ?? 'QWEN.md',
          );
        case 'global':
          return resolvePreferredMemoryFile(
            Storage.getGlobalQwenDir(),
            getAllGeminiMdFilenames()[0] ?? 'QWEN.md',
          );
        default: {
          const _exhaustive: never = item.value;
          return _exhaustive;
        }
      }
    },
    [config, managedMemoryPath, managedUserMemoryPath],
  );

  const handleSelect = useCallback(
    async (item: DialogItem) => {
      try {
        setError(null);
        const targetPath = await resolveTargetPath(item);
        if (item.action === 'folder') {
          await fs.mkdir(targetPath, { recursive: true });
          if (shouldOpenFolderPath()) {
            await openFolderPath(targetPath);
          } else {
            const indexPath = path.join(targetPath, AUTO_MEMORY_INDEX_FILENAME);
            await ensureFileExists(indexPath);
            await launchEditor(indexPath);
          }
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

  const handleToggleAutoSkill = useCallback(() => {
    const newValue = !autoSkillOn;
    loadedSettings.setValue(
      SettingScope.Workspace,
      'memory.enableAutoSkill',
      newValue,
    );
    // Also drive the live Config flag: it is copied from settings at startup and
    // read live by the skill-review scheduler. Without this, toggling here would
    // not take effect until restart — and in particular could not re-enable
    // auto-skill after the review dialog's turn-off option disabled it this
    // session.
    config.setAutoSkillEnabled(newValue);
    setAutoSkillOn(newValue);
  }, [autoSkillOn, loadedSettings, config]);

  const handleToggleAutoSkillConfirm = useCallback(() => {
    const newValue = !autoSkillConfirmOn;
    loadedSettings.setValue(
      SettingScope.Workspace,
      'memory.autoSkillConfirm',
      newValue,
    );
    setAutoSkillConfirmOn(newValue);
  }, [autoSkillConfirmOn, loadedSettings]);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onClose();
        return;
      }

      if (focusedSection === 'autoMemory') {
        // No "up" target above autoMemory; only handle down → autoDream.
        if (keyMatchers[Command.SELECTION_DOWN](key)) {
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
        if (keyMatchers[Command.SELECTION_UP](key)) {
          setFocusedSection('autoMemory');
          return;
        }
        if (keyMatchers[Command.SELECTION_DOWN](key)) {
          setFocusedSection('autoSkill');
          return;
        }
        if (key.name === 'return') {
          handleToggleAutoDream();
          return;
        }
        return;
      }

      if (focusedSection === 'autoSkill') {
        if (keyMatchers[Command.SELECTION_UP](key)) {
          setFocusedSection('autoDream');
          return;
        }
        if (keyMatchers[Command.SELECTION_DOWN](key)) {
          setFocusedSection('autoSkillConfirm');
          return;
        }
        if (key.name === 'return') {
          handleToggleAutoSkill();
          return;
        }
        return;
      }

      if (focusedSection === 'autoSkillConfirm') {
        if (keyMatchers[Command.SELECTION_UP](key)) {
          setFocusedSection('autoSkill');
          return;
        }
        if (keyMatchers[Command.SELECTION_DOWN](key)) {
          setFocusedSection('list');
          setHighlightedIndex(0);
          return;
        }
        if (key.name === 'return') {
          handleToggleAutoSkillConfirm();
          return;
        }
        return;
      }

      // focusedSection === 'list'
      if (keyMatchers[Command.SELECTION_UP](key)) {
        if (highlightedIndex === 0) {
          setFocusedSection('autoSkillConfirm');
        } else {
          setHighlightedIndex((current) => current - 1);
        }
        return;
      }

      if (keyMatchers[Command.SELECTION_DOWN](key)) {
        setHighlightedIndex((current) => (current + 1) % items.length);
        return;
      }

      if (key.name === 'return') {
        const selectedItem = items[highlightedIndex] ?? items[0];
        if (selectedItem) {
          void handleSelect(selectedItem);
        }
        return;
      }

      if (key.sequence && /^[1-9]$/.test(key.sequence)) {
        const nextIndex = Number(key.sequence) - 1;
        if (items[nextIndex]) {
          setHighlightedIndex(nextIndex);
          void handleSelect(items[nextIndex]);
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
        <Text
          color={
            focusedSection === 'autoSkill'
              ? theme.status.success
              : theme.text.secondary
          }
        >
          {focusedSection === 'autoSkill' ? '› ' : '  '}
          {t('Auto-skill: {{status}}', {
            status: autoSkillOn ? t('on') : t('off'),
          })}
        </Text>
        <Text
          color={
            focusedSection === 'autoSkillConfirm'
              ? theme.status.success
              : theme.text.secondary
          }
        >
          {focusedSection === 'autoSkillConfirm' ? '› ' : '  '}
          {t('Confirm auto-skills before saving: {{status}}', {
            status: autoSkillConfirmOn ? t('on') : t('off'),
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
            <Box key={`${item.value}-${item.action}`} flexDirection="row">
              <Text color={isSelected ? theme.status.success : undefined}>
                {isSelected ? '› ' : '  '}
                {index + 1}. {item.label}
              </Text>
              {item.description ? (
                <Text
                  color={theme.text.secondary}
                >{`  ${item.description}`}</Text>
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
