/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useCallback, useMemo } from 'react';
import { Box, Text, useStdin } from 'ink';
import { theme } from '../semantic-colors.js';
import { figures } from '../utils/figures.js';
import { Colors } from '../colors.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  useRegisterActionHandlers,
  type ActionHandler,
} from '../contexts/ActionHandlerRegistry.js';
import type { ShortcutHint } from '../hooks/useContainerKeyboard.js';
import type {
  Config,
  HookRegistryEntry,
  EditorType,
} from '@qwen-code/core';
import {
  ConfigSource,
  HookType,
  CONFIG_DIR,
  getUserConfigDisplayPath,
} from '@qwen-code/core';
import type { LoadedSettings } from '../../config/settings.js';
import { removeHook } from '../../utils/hookSettings.js';
import { getScopeForHookSource } from '../../utils/scopeUtils.js';
import {
  getHookDisplayName,
  getHookIfCondition,
} from '../../utils/hookUtils.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import { DeleteConfirmation } from './shared/DeleteConfirmation.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';
import { openFileInEditor } from '../utils/editorUtils.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Field definition for hook detail panel */
interface HookDetailField {
  key: string;
  label: string;
  type: 'info' | 'boolean' | 'action';
  value?: string | boolean;
  actionLabel?: string;
}

export interface HookDetailViewProps {
  hookEntry: HookRegistryEntry;
  config: Config;
  settings: LoadedSettings;
  onClose: () => void;
  onSave?: () => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Map ConfigSource to display label for breadcrumb titles */
const SOURCE_LABELS: Record<string, string> = {
  [ConfigSource.Project]: 'Project',
  [ConfigSource.Local]: 'Local',
  [ConfigSource.User]: 'User',
  [ConfigSource.Plugins]: 'Plugin',
  [ConfigSource.Flag]: 'Flag',
};

/** Map ConfigSource to descriptive file path string */
function getSourceFileDescription(source: ConfigSource): string {
  switch (source) {
    case ConfigSource.Project:
      return `Project settings (${CONFIG_DIR}/settings.json)`;
    case ConfigSource.Local:
      return `Local settings (${CONFIG_DIR}/settings.local.json)`;
    case ConfigSource.User:
      return `User settings (${getUserConfigDisplayPath('settings.json')})`;
    case ConfigSource.Plugins:
      return 'Plugin settings';
    case ConfigSource.Flag:
      return 'Flag settings (--settings)';
    default:
      return String(source);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Whether the hook can be deleted (only Project and User scoped hooks) */
function isDeletable(source: ConfigSource): boolean {
  return (
    source === ConfigSource.Project ||
    source === ConfigSource.Local ||
    source === ConfigSource.User
  );
}

/** Build fields dynamically from hook entry */
function buildFields(entry: HookRegistryEntry): HookDetailField[] {
  const fields: HookDetailField[] = [];
  const isPlugin = entry.source === ConfigSource.Plugins;

  // Event name
  fields.push({
    key: 'eventName',
    label: 'Event',
    type: 'info',
    value: entry.eventName,
  });

  // Source file path
  fields.push({
    key: 'source',
    label: 'Source',
    type: 'info',
    value: getSourceFileDescription(entry.source),
  });

  // Hook type
  fields.push({
    key: 'type',
    label: 'Type',
    type: 'info',
    value: entry.config.type,
  });

  // Command or URL based on type
  if (entry.config.type === HookType.Command) {
    fields.push({
      key: 'command',
      label: 'Command',
      type: 'info',
      value: entry.config.command,
    });
  } else if (entry.config.type === HookType.Http) {
    fields.push({
      key: 'url',
      label: 'URL',
      type: 'info',
      value: entry.config.url,
    });
  } else if (entry.config.type === HookType.Runtime) {
    fields.push({
      key: 'runtimeName',
      label: 'Runtime Name',
      type: 'info',
      value: entry.config.name,
    });
  }

  // Conditional fields
  if (entry.sequential !== undefined) {
    fields.push({
      key: 'sequential',
      label: 'Sequential',
      type: 'info',
      value: entry.sequential ? 'Yes' : 'No',
    });
  }

  if (entry.async !== undefined) {
    fields.push({
      key: 'async',
      label: 'Async',
      type: 'info',
      value: entry.async ? 'Yes' : 'No',
    });
  }

  if (entry.config.timeout) {
    fields.push({
      key: 'timeout',
      label: 'Timeout',
      type: 'info',
      value: `${entry.config.timeout}s`,
    });
  }

  if (entry.matcher) {
    fields.push({
      key: 'matcher',
      label: 'Matcher',
      type: 'info',
      value: entry.matcher,
    });
  }

  // If condition
  const ifCondition = getHookIfCondition(entry.config);
  if (ifCondition) {
    fields.push({
      key: 'if',
      label: 'If',
      type: 'info',
      value: ifCondition,
    });
  }

  // Edit source action (not available for plugin hooks)
  if (!isPlugin) {
    fields.push({
      key: 'editSource',
      label: 'Edit Source',
      type: 'action',
      actionLabel: `⏎ ${SHORTCUT_HINTS.ENTER_EDIT}`,
    });
  }

  // Delete action (not available for plugin hooks)
  if (!isPlugin) {
    fields.push({
      key: 'deleteHook',
      label: 'Delete Hook',
      type: 'action',
      actionLabel: `⏎ ${SHORTCUT_HINTS.ENTER_DELETE_ITEM}`,
    });
  }

  return fields;
}

// ─── Field Row ───────────────────────────────────────────────────────────────

const HookDetailFieldRow = ({
  field,
  isActive,
  disabled,
  disabledLabel,
}: {
  field: HookDetailField;
  isActive: boolean;
  disabled?: boolean;
  disabledLabel?: string;
}): React.JSX.Element => {
  const isDisabled = disabled === true;
  const labelColor = isDisabled
    ? Colors.Gray
    : isActive
      ? theme.ui.focus
      : Colors.Foreground;
  const prefix = isActive ? `${figures.pointer} ` : '  ';

  let displayStr: string;
  if (field.type === 'action') {
    displayStr = isDisabled
      ? (disabledLabel ?? '(built-in hook, cannot delete)')
      : (field.actionLabel ?? '⏎ Enter');
  } else if (field.type === 'boolean') {
    displayStr = field.value ? '✓ Yes' : '✗ No';
  } else {
    displayStr = field.value !== undefined ? String(field.value) : '(none)';
  }

  const valueColor = isDisabled
    ? Colors.Gray
    : field.type === 'action'
      ? isActive
        ? theme.status.error
        : Colors.Gray
      : field.type === 'boolean'
        ? isActive
          ? theme.ui.focus
          : field.value
            ? theme.status.success
            : theme.text.secondary
        : isActive
          ? theme.ui.focus
          : Colors.Gray;

  return (
    <Box flexDirection="row">
      <Text color={labelColor}>{prefix}</Text>
      <Box width={18}>
        <Text color={labelColor} bold={isActive}>
          {field.label}
        </Text>
      </Box>
      <Text color={valueColor}>{displayStr}</Text>
    </Box>
  );
};

// ─── Main Component ─────────────────────────────────────────────────────────

export function HookDetailView({
  hookEntry,
  config,
  settings,
  onClose,
  onSave,
}: HookDetailViewProps): React.JSX.Element {
  const { columns: terminalWidth } = useTerminalSize();
  const { stdin, setRawMode } = useStdin();

  // Field navigation state
  const [fieldIndex, setFieldIndex] = useState(0);
  const [isDeleteConfirmMode, setIsDeleteConfirmMode] = useState(false);

  // Build fields
  const fields = useMemo(() => buildFields(hookEntry), [hookEntry]);

  // ─── Operations ────────────────────────────────────────────────────────────

  const handleDelete = useCallback(async () => {
    if (!isDeletable(hookEntry.source)) return;

    const result = removeHook(settings, hookEntry);
    if (result.status === 'success') {
      // Config-backed hooks are rebuilt via disk→reload, not direct memory removal.
      await config.reloadHooks();
      onSave?.();
    }
    onClose();
  }, [hookEntry, config, settings, onClose, onSave]);

  // ─── Keyboard Handler ────────────────────────────────────────────────────

  const actionHandlers = useMemo<Record<string, ActionHandler>>(
    () => ({
      'dialog:escape': () => {
        if (isDeleteConfirmMode) {
          setIsDeleteConfirmMode(false);
        } else {
          onClose();
        }
        return true;
      },
      'dialog:navigate:up': () => {
        if (isDeleteConfirmMode) return false;
        setFieldIndex((i) => Math.max(0, i - 1));
        return true;
      },
      'dialog:navigate:down': () => {
        if (isDeleteConfirmMode) return false;
        setFieldIndex((i) => Math.min(fields.length - 1, i + 1));
        return true;
      },
      'dialog:confirm': () => {
        if (isDeleteConfirmMode) return false;
        const field = fields[fieldIndex];
        if (field) {
          if (field.type === 'action') {
            if (field.key === 'editSource' && isDeletable(hookEntry.source)) {
              const scope = getScopeForHookSource(hookEntry.source);
              const filePath = settings.forScope(scope).path;
              if (filePath) {
                const editorType = settings.merged.general?.preferredEditor as
                  | EditorType
                  | undefined;
                openFileInEditor(filePath, stdin, setRawMode, editorType)
                  .then(() => {
                    onSave?.();
                  })
                  .catch(() => {
                    // Editor errors are already surfaced via coreEvents
                  });
              }
              return true;
            }
            if (field.key === 'deleteHook' && isDeletable(hookEntry.source)) {
              setIsDeleteConfirmMode(true);
            }
            return true;
          }
        }
        return true;
      },
    }),
    [
      isDeleteConfirmMode,
      onClose,
      fields,
      fieldIndex,
      hookEntry.source,
      settings,
      stdin,
      setRawMode,
      onSave,
    ],
  );

  useRegisterActionHandlers('Dialog', actionHandlers, true);

  const extraHints = useMemo<ShortcutHint[]>(
    () => [
      { label: SHORTCUT_HINTS.CLOSE, order: 10 },
      { label: SHORTCUT_HINTS.NAVIGATE, order: 20 },
    ],
    [],
  );

  // ─── Render ───────────────────────────────────────────────────────────────

  const sourceLabel = SOURCE_LABELS[hookEntry.source] ?? 'Built-in';
  const hookName = getHookDisplayName(hookEntry);
  const detailTitle = `Hooks > ${sourceLabel} > ${hookName}`;

  return (
    <BaseTabDialog title={detailTitle} isActive={true} extraHints={extraHints}>
      {/* Detail fields */}
      {isDeleteConfirmMode ? (
        <DeleteConfirmation
          itemLabel={`hook "${getHookDisplayName(hookEntry)}"`}
          onConfirm={handleDelete}
          onCancel={() => setIsDeleteConfirmMode(false)}
        />
      ) : (
        <Box flexDirection="column">
          {fields.map((field, idx) => {
            const isActionDisabled =
              (field.key === 'deleteHook' || field.key === 'editSource') &&
              !isDeletable(hookEntry.source);
            const verb = field.key === 'editSource' ? 'edit' : 'delete';
            const sourceLabel =
              hookEntry.source === ConfigSource.Plugins
                ? 'extension'
                : 'built-in';
            const actionDisabledLabel = isActionDisabled
              ? `(${sourceLabel} hook, cannot ${verb})`
              : undefined;
            return (
              <Box key={field.key} flexDirection="column">
                {field.type === 'action' && (
                  <Box marginTop={1} marginBottom={0}>
                    <Text color={Colors.Gray}>
                      {'─'.repeat(Math.min(50, terminalWidth - 4))}
                    </Text>
                  </Box>
                )}
                <HookDetailFieldRow
                  field={field}
                  isActive={idx === fieldIndex}
                  disabled={isActionDisabled}
                  disabledLabel={actionDisabledLabel}
                />
              </Box>
            );
          })}
        </Box>
      )}

      {/* Footer separator and auto-save message */}
      <Box marginTop={1}>
        <Text color={Colors.Gray}>
          {'─'.repeat(Math.min(50, terminalWidth - 4))}
        </Text>
      </Box>
      <Text color={theme.text.secondary}>Changes saved automatically.</Text>
    </BaseTabDialog>
  );
}
