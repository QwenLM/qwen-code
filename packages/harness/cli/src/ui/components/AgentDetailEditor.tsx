/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useCallback, useMemo, useEffect } from 'react';
import { Box, Text, useStdin } from 'ink';
import { theme } from '../semantic-colors.js';
import { Colors } from '../colors.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { InputField } from './shared/InputField.js';
import { useTextBuffer } from './shared/text-buffer.js';
import {
  useRegisterActionHandlers,
  useRegisterFallbackHandler,
  type ActionHandler,
} from '../contexts/ActionHandlerRegistry.js';
import type { ShortcutHint } from '../hooks/useContainerKeyboard.js';
import { SHORTCUT_HINTS, formatShortcutHint } from '../constants/shortcuts.js';
import type { AgentDefinition, AgentSource, EditorType } from '@qwen-code/core';
import {
  DEFAULT_LOCAL_SUBAGENT_MAX_TURNS,
  coreEvents,
  CoreEvent,
} from '@qwen-code/core';
import { getNestedValue } from '../../utils/settingsUtils.js';
import { AGENT_SOURCE_LABELS } from '../../utils/agentUtils.js';
import { getScopeForAgentSource } from '../../utils/scopeUtils.js';
import { openFileInEditor } from '../utils/editorUtils.js';
import { DeleteConfirmation } from './shared/DeleteConfirmation.js';
import fs from 'node:fs';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import type {
  AgentDetailField,
  AgentDetailEditorProps,
} from './AgentDetailTypes.js';
import { AgentDetailFieldRow } from './AgentDetailFieldRow.js';

function getFieldDefaultFromDef(
  field: AgentDetailField,
  definition: AgentDefinition,
): unknown {
  if (field.key === 'enabled') return !definition.experimental;
  if (field.key === 'model') return definition.modelConfig?.model ?? 'inherit';
  return field.type === 'select'
    ? getNestedValue(definition, field.path)
    : undefined;
}

function sameAgentSource(
  left: AgentSource | undefined,
  right: AgentSource | undefined,
): boolean {
  return (left ?? 'built-in') === (right ?? 'built-in');
}

function getEffectiveEnabled(
  definition: AgentDefinition,
  override: unknown,
): boolean {
  const enabledOverride = getNestedValue(override, ['enabled']);
  if (typeof enabledOverride === 'boolean') return enabledOverride;
  return !definition.experimental;
}

export function AgentDetailEditor({
  agentName,
  description,
  definition,
  filePath,
  source,
  config,
  settings,
  onClose,
  onSave,
  onRunAgent,
  fields: configFields,
}: AgentDetailEditorProps): React.JSX.Element {
  const { columns: terminalWidth } = useTerminalSize();

  // Detail field navigation state
  const [detailFieldIndex, setDetailFieldIndex] = useState(0);
  const [settingsNonce, setSettingsNonce] = useState(0);
  const [registryNonce, setRegistryNonce] = useState(0);
  const isFlagAgent = source === 'flag';

  // Run Agent query input mode
  const [isQueryInputMode, setIsQueryInputMode] = useState(false);
  const [isMaxTurnsInputMode, setIsMaxTurnsInputMode] = useState(false);
  const [maxTurnsInputError, setMaxTurnsInputError] = useState<
    string | undefined
  >();

  const queryBuffer = useTextBuffer({
    initialText: '',
    initialCursorOffset: 0,
    viewport: { width: Math.max(20, terminalWidth - 12), height: 1 },
    singleLine: true,
  });
  const maxTurnsInputBuffer = useTextBuffer({
    initialText: '',
    initialCursorOffset: 0,
    viewport: { width: Math.max(20, terminalWidth - 12), height: 1 },
    singleLine: true,
  });

  // Delete confirmation mode
  const [isDeleteConfirmMode, setIsDeleteConfirmMode] = useState(false);

  // Get stdin for editor integration
  const { stdin, setRawMode } = useStdin();

  // Current override from settings
  const detailOverride = useMemo(() => {
    const scope = getScopeForAgentSource(source);
    const scopeSettings = settings.forScope(scope).settings;
    return scopeSettings.agents?.overrides?.[agentName] ?? {};
    // settingsNonce is used to trigger re-computation when settings are saved
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, agentName, source, settingsNonce]);

  const activeAgentDefinition = useMemo(
    () => config.getAgentRegistry()?.getDefinition(agentName),
    // Nonces intentionally force a registry re-read after settings or registry updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, agentName, settingsNonce, registryNonce],
  );

  const effectiveEnabled = useMemo(
    () => getEffectiveEnabled(definition, detailOverride),
    [definition, detailOverride],
  );

  // The registry's live (enabled-only) set is the single source of truth for
  // whether the agent can run. effectiveEnabled only picks the wording so the
  // gate can never drift from the subagent's actual loaded state.
  const runAgentDisabledLabel = useMemo(() => {
    if (!activeAgentDefinition) {
      return effectiveEnabled
        ? '(agent unavailable, cannot run)'
        : '(disabled agent, cannot run)';
    }
    if (!sameAgentSource(activeAgentDefinition.metadata?.source, source)) {
      return '(shadowed agent, cannot run)';
    }
    return undefined;
  }, [activeAgentDefinition, effectiveEnabled, source]);
  const canRunAgent = runAgentDisabledLabel === undefined;

  useEffect(() => {
    if (!canRunAgent && isQueryInputMode) {
      setIsQueryInputMode(false);
      queryBuffer.setText('');
    }
  }, [canRunAgent, isQueryInputMode, queryBuffer]);

  // Keep the Run Agent gate live: recompute when the registry reloads or
  // settings change through any path (this view's toggle, the browser, trust
  // changes, plugin hot-reload, external settings edits) so the judged state
  // never drifts from the subagent's actual loaded state.
  useEffect(() => {
    const onRefresh = () => setRegistryNonce((n) => n + 1);
    const onSettings = () => setSettingsNonce((n) => n + 1);
    coreEvents.on(CoreEvent.AgentsRefreshed, onRefresh);
    coreEvents.on(CoreEvent.SettingsChanged, onSettings);
    return () => {
      coreEvents.off(CoreEvent.AgentsRefreshed, onRefresh);
      coreEvents.off(CoreEvent.SettingsChanged, onSettings);
    };
  }, []);

  // ─── Detail Operations ─────────────────────────────────────────────────────

  const saveFieldValue = useCallback(
    (path: string[], value: unknown) => {
      // Plugin and --agents definitions are runtime-owned and read-only.
      if (source === 'plugin' || isFlagAgent) return false;
      if (['__proto__', 'constructor', 'prototype'].includes(agentName)) {
        return false;
      }
      const scope = getScopeForAgentSource(source);
      const settingsPath = ['agents', 'overrides', agentName, ...path];
      if (!settings.setValue(scope, settingsPath, value)) return false;
      // Reload registry when config fields that affect runtime behavior change
      if (path[0] === 'enabled') {
        const reg = config.getAgentRegistry();
        reg
          ?.reload()
          .then(() => setRegistryNonce((n) => n + 1))
          .catch(() => {});
      }
      setSettingsNonce((n) => n + 1);
      onSave?.();
      return true;
    },
    [agentName, source, settings, config, onSave, isFlagAgent],
  );

  /** Cycle select field with left/right arrows */
  const handleDetailCycle = useCallback(
    (direction: 1 | -1) => {
      const field = configFields[detailFieldIndex];
      if (!field || field.type !== 'select' || isFlagAgent) return;

      const current = getNestedValue(detailOverride, field.path);
      const def = getFieldDefaultFromDef(field, definition);
      const effective = current !== undefined ? current : def;

      if (field.key === 'maxTurns' && typeof effective === 'number') {
        const numericOptions = field.options.map((option) => ({
          option,
          numericValue:
            option.value === undefined
              ? DEFAULT_LOCAL_SUBAGENT_MAX_TURNS
              : Number(option.value),
        }));
        const candidate =
          direction === 1
            ? numericOptions.find((option) => option.numericValue > effective)
            : numericOptions.findLast(
                (option) => option.numericValue < effective,
              );
        if (candidate) {
          saveFieldValue(field.path, candidate.option.value);
        }
        return;
      }

      const idx = field.options.findIndex((o) => o.value === effective);
      let newIdx: number;
      if (idx === -1) {
        newIdx = direction === 1 ? 0 : field.options.length - 1;
      } else {
        newIdx = Math.max(
          0,
          Math.min(field.options.length - 1, idx + direction),
        );
      }
      saveFieldValue(field.path, field.options[newIdx].value);
    },
    [
      configFields,
      detailFieldIndex,
      detailOverride,
      definition,
      saveFieldValue,
      isFlagAgent,
    ],
  );

  const handleDetailReset = useCallback(() => {
    const field = configFields[detailFieldIndex];
    if (!field || field.type !== 'select' || isFlagAgent) return;
    saveFieldValue(field.path, undefined);
  }, [configFields, detailFieldIndex, saveFieldValue, isFlagAgent]);

  const canModify = !!filePath && source !== 'flag' && source !== 'plugin';

  const handleDeleteAgent = useCallback(async () => {
    if (!canModify) return; // Built-in and CLI Args agents cannot be deleted

    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // File may already be gone
    }

    // Also clean up any override settings for this agent
    const scope = getScopeForAgentSource(source);
    const settingsPath = ['agents', 'overrides', agentName];
    settings.setValue(scope, settingsPath, undefined);

    // Reload registry and go back to list
    const reg = config.getAgentRegistry();
    if (reg) {
      await reg.reload();
    }
    onClose();
  }, [canModify, filePath, source, settings, agentName, config, onClose]);

  // ─── Keyboard Handler ─────────────────────────────────────────────────────

  const actionHandlers = useMemo(
    (): Record<string, ActionHandler> => ({
      'dialog:escape': () => {
        if (isDeleteConfirmMode) {
          setIsDeleteConfirmMode(false);
        } else if (isMaxTurnsInputMode) {
          setIsMaxTurnsInputMode(false);
          setMaxTurnsInputError(undefined);
          maxTurnsInputBuffer.setText('');
        } else if (isQueryInputMode) {
          setIsQueryInputMode(false);
          queryBuffer.setText('');
        } else {
          onClose();
        }
        return true;
      },
      'dialog:navigate:up': () => {
        if (isQueryInputMode || isMaxTurnsInputMode || isDeleteConfirmMode) {
          return false;
        }
        setDetailFieldIndex((i) => Math.max(0, i - 1));
        return true;
      },
      'dialog:navigate:down': () => {
        if (isQueryInputMode || isMaxTurnsInputMode || isDeleteConfirmMode) {
          return false;
        }
        setDetailFieldIndex((i) => Math.min(configFields.length - 1, i + 1));
        return true;
      },
      'dialog:confirm': () => {
        if (isQueryInputMode || isMaxTurnsInputMode) return false;
        if (isDeleteConfirmMode) return false;
        const field = configFields[detailFieldIndex];
        if (field?.key === 'maxTurns' && !isFlagAgent) {
          setMaxTurnsInputError(undefined);
          maxTurnsInputBuffer.setText('');
          setIsMaxTurnsInputMode(true);
          return true;
        }
        if (field?.key === 'runAgent') {
          if (!canRunAgent) return true;
          setIsQueryInputMode(true);
          return true;
        }
        if (field?.key === 'editAgent' && canModify) {
          const editorType = settings.merged.general?.preferredEditor as
            | EditorType
            | undefined;
          openFileInEditor(filePath, stdin, setRawMode, editorType)
            .then(async () => {
              const reg = config.getAgentRegistry();
              if (reg) await reg.reload();
              onSave?.();
            })
            .catch(() => {});
          return true;
        }
        if (field?.key === 'deleteAgent' && canModify) {
          setIsDeleteConfirmMode(true);
          return true;
        }
        return true;
      },
      'dialog:navigate:left': () => {
        if (isQueryInputMode || isMaxTurnsInputMode) return false;
        const field = configFields[detailFieldIndex];
        if (field?.type === 'select') {
          handleDetailCycle(-1);
        }
        return true;
      },
      'dialog:navigate:right': () => {
        if (isQueryInputMode || isMaxTurnsInputMode) return false;
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
      canModify,
      filePath,
      isQueryInputMode,
      isMaxTurnsInputMode,
      isDeleteConfirmMode,
      queryBuffer,
      maxTurnsInputBuffer,
      stdin,
      setRawMode,
      settings,
      config,
      onSave,
      canRunAgent,
      isFlagAgent,
    ],
  );

  useRegisterActionHandlers('Dialog', actionHandlers, true);

  const fallbackHandler = useCallback(
    (key: { sequence?: string; name?: string }): boolean | void => {
      if (isQueryInputMode || isMaxTurnsInputMode) return false;
      if (isDeleteConfirmMode) return false;
      if (key.sequence === 'q') {
        onClose();
        return true;
      }
      // Backspace/Delete resets to default
      if (key.name === 'backspace' || key.name === 'delete') {
        handleDetailReset();
        return true;
      }
      return false;
    },
    [
      isQueryInputMode,
      isMaxTurnsInputMode,
      isDeleteConfirmMode,
      onClose,
      handleDetailReset,
    ],
  );

  useRegisterFallbackHandler('Dialog', fallbackHandler, true);

  // Hints for the footer — merged into extraHints below
  const behaviorHints = useMemo(
    (): ShortcutHint[] => [
      { label: SHORTCUT_HINTS.GO_BACK, order: 100 },
      { label: SHORTCUT_HINTS.NAVIGATE, order: 10 },
    ],
    [],
  );

  // ─── Render ───────────────────────────────────────────────────────────────

  const sourceLabel = AGENT_SOURCE_LABELS[source ?? 'built-in'] ?? 'Built-in';
  const detailTitle = `Agents > ${sourceLabel} > ${agentName}`;

  return (
    <BaseTabDialog
      title={detailTitle}
      isActive={true}
      extraHints={[
        ...behaviorHints,
        ...(isFlagAgent
          ? []
          : [
              { label: SHORTCUT_HINTS.NAVIGATE, order: 20 },
              ...(configFields[detailFieldIndex]?.key === 'maxTurns'
                ? [{ label: SHORTCUT_HINTS.ENTER_EDIT, order: 30 }]
                : []),
              { label: SHORTCUT_HINTS.ARROW_CYCLE, order: 40 },
              { label: SHORTCUT_HINTS.BACKSPACE_RESET, order: 50 },
            ]),
      ]}
    >
      {/* Description */}
      <Box flexDirection="column" marginBottom={1}>
        {description ? (
          <Text color={theme.text.secondary}>{description}</Text>
        ) : null}
      </Box>

      {isDeleteConfirmMode ? (
        <DeleteConfirmation
          itemLabel={`agent "${agentName}"`}
          onConfirm={() => {
            handleDeleteAgent().catch(() => {});
          }}
          onCancel={() => setIsDeleteConfirmMode(false)}
        />
      ) : isMaxTurnsInputMode ? (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color={theme.ui.focus} bold>
              Enter Max Turns:
            </Text>
          </Box>
          <InputField
            prefix={<Text color={theme.text.secondary}>{'> '}</Text>}
            buffer={maxTurnsInputBuffer}
            onSubmit={(value: string) => {
              const trimmed = value.trim();
              if (!/^[1-9]\d*$/.test(trimmed)) {
                setMaxTurnsInputError('Max Turns must be a positive integer.');
                return;
              }
              const parsed = Number(trimmed);
              if (!Number.isSafeInteger(parsed)) {
                setMaxTurnsInputError(
                  'Max Turns must be a positive safe integer.',
                );
                return;
              }
              if (!saveFieldValue(['runConfig', 'maxTurns'], parsed)) return;
              setIsMaxTurnsInputMode(false);
              setMaxTurnsInputError(undefined);
              maxTurnsInputBuffer.setText('');
            }}
            onCancel={() => {
              setIsMaxTurnsInputMode(false);
              setMaxTurnsInputError(undefined);
              maxTurnsInputBuffer.setText('');
            }}
            placeholder="Enter any positive integer, for example 250"
          />
          {maxTurnsInputError && (
            <Box marginTop={1}>
              <Text color={theme.status.error}>{maxTurnsInputError}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {formatShortcutHint('SUBMIT', 'CANCEL')}
            </Text>
          </Box>
        </Box>
      ) : isQueryInputMode ? (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color={theme.ui.focus} bold>
              Enter query for {agentName}:
            </Text>
          </Box>
          <InputField
            prefix={<Text color={theme.text.secondary}>{'> '}</Text>}
            buffer={queryBuffer}
            onSubmit={(value: string) => {
              if (!canRunAgent) return;
              onRunAgent?.(agentName, value);
            }}
            onCancel={() => {
              setIsQueryInputMode(false);
              queryBuffer.setText('');
            }}
            placeholder="Enter your query..."
          />
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {formatShortcutHint('SUBMIT', 'CANCEL')}
            </Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {configFields.map((field, idx) => {
            const currentValue =
              field.type !== 'action'
                ? getNestedValue(detailOverride, field.path)
                : undefined;
            const defaultValue =
              field.type !== 'action'
                ? getFieldDefaultFromDef(field, definition)
                : undefined;
            return (
              <Box key={field.key} flexDirection="column">
                {field.type === 'action' && (
                  <Box
                    marginTop={field.key === 'runAgent' ? 1 : 0}
                    marginBottom={0}
                  >
                    <Text color={Colors.Gray}>
                      {'─'.repeat(Math.min(50, terminalWidth - 4))}
                    </Text>
                  </Box>
                )}
                <AgentDetailFieldRow
                  field={field}
                  value={currentValue}
                  defaultValue={defaultValue}
                  isActive={idx === detailFieldIndex}
                  disabled={
                    (isFlagAgent && field.type === 'select') ||
                    (field.key === 'runAgent' && !canRunAgent) ||
                    ((field.key === 'deleteAgent' ||
                      field.key === 'editAgent') &&
                      !canModify)
                  }
                  disabledLabel={
                    field.key === 'runAgent' && !canRunAgent
                      ? runAgentDisabledLabel
                      : (field.key === 'deleteAgent' ||
                            field.key === 'editAgent') &&
                          !canModify
                        ? source === 'flag'
                          ? field.key === 'editAgent'
                            ? '(Flag agent, cannot edit)'
                            : '(Flag agent, cannot delete)'
                          : undefined // fall back to default built-in label
                        : undefined
                  }
                />
              </Box>
            );
          })}
        </Box>
      )}

      {/* Separator */}
      <Box>
        <Text color={Colors.Gray}>
          {'─'.repeat(Math.min(50, terminalWidth - 4))}
        </Text>
      </Box>
      <Text color={theme.text.secondary}>
        {isFlagAgent
          ? 'Values provided by --agents are read-only.'
          : 'Changes saved automatically.'}
      </Text>
    </BaseTabDialog>
  );
}
