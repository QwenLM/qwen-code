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
import { Colors } from '../colors.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  useRegisterActionHandlers,
  useRegisterFallbackHandler,
  type ActionHandler,
} from '../contexts/ActionHandlerRegistry.js';
import type { ShortcutHint } from '../hooks/useContainerKeyboard.js';
import type { Config, EditorType } from '@qwen-code/core';
import type { LoadedSettings } from '../../config/settings.js';
import { enableSkill, disableSkill } from '../../utils/skillSettings.js';
import { getScopeForAgentSource } from '../../utils/scopeUtils.js';
import { openFileInEditor } from '../utils/editorUtils.js';
import { DeleteConfirmation } from './shared/DeleteConfirmation.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import type { SkillDisplayInfo } from './SkillBrowser.js';
import { SKILL_SOURCE_LABELS, safeDeleteSkill } from '../../utils/skillUtils.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';
import { figures } from '../utils/figures.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ConfigField {
  key: string;
  label: string;
  type: 'select' | 'action';
  options?: Array<{ label: string; value: unknown }>;
  actionLabel?: string;
}

export interface SkillDetailViewProps {
  skill: SkillDisplayInfo;
  config: Config;
  settings: LoadedSettings;
  onClose: () => void;
  onSave?: () => void;
  /** Warning from a tolerated load error (e.g. YAML fallback to simple parser) */
  loadWarning?: import('@qwen-code/core').ConfigLoadError;
}

// ─── Constants ──────────────────────────────────────────────────────────────

function buildConfigFields(skill: SkillDisplayInfo): ConfigField[] {
  // Shadowed skills cannot be toggled, edited, or deleted
  if (skill.shadowedBy) {
    return [];
  }
  // Plugin skills are read-only — show no interactive fields
  if (skill.source === 'plugin') {
    return [];
  }
  const fields: ConfigField[] = [
    {
      key: 'enabled',
      label: 'Enabled',
      type: 'select',
      options: [
        { label: 'Yes', value: true },
        { label: 'No', value: false },
      ],
    },
    {
      key: 'editSkill',
      label: 'Edit Source',
      type: 'action',
      actionLabel: `⏎ ${SHORTCUT_HINTS.ENTER_EDIT}`,
    },
    {
      key: 'deleteSkill',
      label: 'Delete Skill',
      type: 'action',
      actionLabel: `⏎ ${SHORTCUT_HINTS.ENTER_DELETE_ITEM}`,
    },
  ];
  return fields;
}

// ─── Config Field Row ────────────────────────────────────────────────────────

const ConfigFieldRow = ({
  field,
  value,
  isActive,
  disabled,
  disabledLabel,
}: {
  field: ConfigField;
  value: unknown;
  isActive: boolean;
  disabled?: boolean;
  disabledLabel?: string;
}): React.JSX.Element => {
  const isDisabled = disabled === true;
  const labelColor = isDisabled
    ? theme.text.secondary
    : isActive
      ? theme.ui.focus
      : theme.text.primary;
  const prefix = isActive ? figures.pointer : '-';

  let displayValue: string;
  if (field.type === 'action') {
    displayValue = isDisabled
      ? (disabledLabel ??
        (field.key === 'editSkill'
          ? '(built-in skill, cannot edit)'
          : '(built-in skill, cannot delete)'))
      : (field.actionLabel ?? '⏎ Enter');
  } else if (field.type === 'select' && field.options) {
    const match = field.options.find((o) => o.value === value);
    if (match) {
      const idx = field.options.indexOf(match);
      const prev = idx > 0 ? '◀' : ' ';
      const next = idx < field.options.length - 1 ? figures.play : ' ';
      displayValue = `${prev} ${match.label} ${next}`;
    } else {
      displayValue = value !== undefined ? String(value) : '(default)';
    }
  } else {
    displayValue = value !== undefined ? String(value) : '(default)';
  }

  const valueColor = isDisabled
    ? theme.text.secondary
    : field.type === 'action'
      ? isActive
        ? theme.status.error
        : theme.text.secondary
      : isActive
        ? theme.ui.focus
        : theme.text.secondary;

  return (
    <Box flexDirection="row">
      <Text color={labelColor} bold={isActive}>
        {` ${prefix} `}
      </Text>
      <Box width={22}>
        <Text color={labelColor} bold={isActive}>
          {field.label}
        </Text>
      </Box>
      <Text color={valueColor} bold={isActive}>
        {displayValue}
      </Text>
    </Box>
  );
};

// ─── Main Component ─────────────────────────────────────────────────────────

export function SkillDetailView({
  skill,
  config,
  settings,
  onClose,
  onSave,
  loadWarning,
}: SkillDetailViewProps): React.JSX.Element {
  const { columns: terminalWidth } = useTerminalSize();

  const [detailFieldIndex, setDetailFieldIndex] = useState(0);
  const [isEnabled, setIsEnabled] = useState(skill.enabled);
  const [isDeleteConfirmMode, setIsDeleteConfirmMode] = useState(false);
  const { stdin, setRawMode } = useStdin();

  const configFields = useMemo(() => buildConfigFields(skill), [skill]);

  const canModify = !skill.isBuiltin && skill.source !== 'plugin';

  // ─── Detail Operations ─────────────────────────────────────────────────────

  const handleToggleEnabled = useCallback(
    async (newEnabled: boolean) => {
      // Plugin skills are read-only — cannot toggle individually
      if (skill.source === 'plugin') return;
      const scope = getScopeForAgentSource(skill.source);
      const result = newEnabled
        ? enableSkill(settings, skill.name, scope)
        : disableSkill(settings, skill.name, scope);
      if (result.status === 'error') return;
      setIsEnabled(newEnabled);
      await config.reloadSkills();
      onSave?.();
    },
    [skill.name, skill.source, settings, config, onSave],
  );

  const handleDetailCycle = useCallback(
    (direction: 1 | -1) => {
      const field = configFields[detailFieldIndex];
      if (!field || !field.options || field.key !== 'enabled') return;

      const currentValue = isEnabled;
      const idx = field.options.findIndex((o) => o.value === currentValue);
      let newIdx: number;
      if (idx === -1) {
        newIdx = direction === 1 ? 0 : field.options.length - 1;
      } else {
        newIdx = Math.max(
          0,
          Math.min(field.options.length - 1, idx + direction),
        );
      }
      const newValue = field.options[newIdx].value as boolean;
      handleToggleEnabled(newValue).catch(() => {});
    },
    [configFields, detailFieldIndex, isEnabled, handleToggleEnabled],
  );

  const handleDeleteSkill = useCallback(async () => {
    if (!canModify) return;

    try {
      await safeDeleteSkill(skill.location);
    } catch {
      // Directory may already be gone
    }

    await config.reloadSkills();
    onClose();
  }, [skill, config, onClose, canModify]);

  // ─── Keyboard Handler ─────────────────────────────────────────────────────

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
        setDetailFieldIndex((i) => Math.max(0, i - 1));
        return true;
      },
      'dialog:navigate:down': () => {
        if (isDeleteConfirmMode) return false;
        setDetailFieldIndex((i) => Math.min(configFields.length - 1, i + 1));
        return true;
      },
      'dialog:confirm': () => {
        if (isDeleteConfirmMode) return false;
        const field = configFields[detailFieldIndex];
        if (field?.key === 'editSkill' && canModify) {
          const editorType = settings.merged.general?.preferredEditor as
            | EditorType
            | undefined;
          openFileInEditor(skill.location, stdin, setRawMode, editorType)
            .then(async () => {
              await config.reloadSkills();
              onSave?.();
            })
            .catch(() => {});
          return true;
        }
        if (field?.key === 'deleteSkill' && canModify) {
          setIsDeleteConfirmMode(true);
          return true;
        }
        return true;
      },
      'dialog:navigate:left': () => {
        const field = configFields[detailFieldIndex];
        if (field?.type === 'select') {
          handleDetailCycle(-1);
        }
        return true;
      },
      'dialog:navigate:right': () => {
        const field = configFields[detailFieldIndex];
        if (field?.type === 'select') {
          handleDetailCycle(1);
        }
        return true;
      },
    }),
    [
      onClose,
      configFields,
      detailFieldIndex,
      handleDetailCycle,
      isDeleteConfirmMode,
      canModify,
      skill,
      stdin,
      setRawMode,
      settings,
      config,
      onSave,
    ],
  );

  useRegisterActionHandlers('Dialog', actionHandlers, true);

  const fallbackHandler = useCallback(
    (key: { sequence?: string }) => {
      if (isDeleteConfirmMode) return false;
      if (key.sequence === 'q') {
        onClose();
        return true;
      }
      return false;
    },
    [isDeleteConfirmMode, onClose],
  );

  useRegisterFallbackHandler('Dialog', fallbackHandler, true);

  const extraHints = useMemo<ShortcutHint[]>(
    () => [
      { label: SHORTCUT_HINTS.GO_BACK, order: 5 },
      { label: SHORTCUT_HINTS.NAVIGATE, order: 10 },
      { label: SHORTCUT_HINTS.ARROW_CYCLE, order: 40 },
    ],
    [],
  );

  // ─── Render ───────────────────────────────────────────────────────────────

  const sourceLabel = SKILL_SOURCE_LABELS[skill.source];
  const detailTitle = `Skills > ${sourceLabel} > ${skill.name}`;

  return (
    <BaseTabDialog title={detailTitle} isActive={true} extraHints={extraHints}>
      <Box flexDirection="column" marginBottom={1}>
        {skill.description ? (
          <Text color={theme.text.secondary}>{skill.description}</Text>
        ) : null}
        <Text color={theme.text.secondary}>Location: {skill.location}</Text>
        {skill.pluginName ? (
          <Text color={theme.text.secondary}>Plugin: {skill.pluginName}</Text>
        ) : null}
        {skill.shadowedBy ? (
          <Text color={theme.status.warning}>
            Shadowed by:{' '}
            {SKILL_SOURCE_LABELS[skill.shadowedBy] ?? skill.shadowedBy}
          </Text>
        ) : null}
        {skill.alsoDefinedAt && skill.alsoDefinedAt.length > 0 ? (
          <Box flexDirection="column">
            <Text color={theme.text.secondary}>Also defined at:</Text>
            <Box flexDirection="column" marginLeft={2}>
              {skill.alsoDefinedAt.map((loc) => (
                <Text key={loc} color={theme.text.secondary}>
                  {`${figures.bullet} ${loc}`}
                </Text>
              ))}
            </Box>
          </Box>
        ) : null}
        {loadWarning ? (
          <Text color={theme.status.warning}>⚠ {loadWarning.message}</Text>
        ) : null}
      </Box>

      {isDeleteConfirmMode ? (
        <DeleteConfirmation
          itemLabel={`skill "${skill.name}"`}
          onConfirm={() => {
            handleDeleteSkill().catch(() => {});
          }}
          onCancel={() => setIsDeleteConfirmMode(false)}
        />
      ) : (
        <Box flexDirection="column">
          {configFields.map((field, idx) => {
            const value = field.key === 'enabled' ? isEnabled : undefined;
            const isActionDisabled =
              (field.key === 'deleteSkill' || field.key === 'editSkill') &&
              !canModify;
            const actionDisabledLabel =
              isActionDisabled && skill.source === 'plugin'
                ? field.key === 'editSkill'
                  ? '(plugin skill, cannot edit)'
                  : '(plugin skill, cannot delete)'
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
                <ConfigFieldRow
                  field={field}
                  value={value}
                  isActive={idx === detailFieldIndex}
                  disabled={isActionDisabled}
                  disabledLabel={actionDisabledLabel}
                />
              </Box>
            );
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={Colors.Gray}>
          {'─'.repeat(Math.min(50, terminalWidth - 4))}
        </Text>
      </Box>
      <Text color={theme.text.secondary}>Changes saved automatically.</Text>
    </BaseTabDialog>
  );
}
