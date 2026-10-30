/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { decodePasteBytes } from '@opentui/core';
import { useKeyboard, usePaste, useTerminalDimensions } from '@opentui/react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { Kind } from '@qwen-code/qwen-code-core/tools/tools.js';
import type { SubagentConfig } from '@qwen-code/qwen-code-core/subagents/types.js';
import { t } from '../../i18n/index.js';
import { Command, keyMatchers } from '../keyMatchers.js';
import { COLOR_OPTIONS } from '../components/subagents/constants.js';
import {
  initialWizardState,
  wizardReducer,
} from '../components/subagents/reducers.js';
import type {
  CreationWizardState,
  WizardAction,
} from '../components/subagents/types.js';
import { getStepKind } from '../components/subagents/utils.js';
import {
  sanitizeTerminalLine,
  sanitizeTerminalText,
} from '../utils/textUtils.js';
import { useBatchSafeState } from './batch-cursor.js';
import { toOriginalKey } from './key-map.js';
import { useLineEdit, windowLineAtCaret } from './line-edit.js';
import { isPrintableKeyInput } from './input-prompt-key.js';
import { normalizePastedText } from './input-prompt-model.js';
import {
  DialogFrame,
  DialogSelect,
  FooterHint,
  dialogContentWidth,
  useDialogSelect,
} from './dialogs-shared.js';
import { C } from './theme.js';

export function OpenTuiSubagentCreateDialog({
  config,
  onClose,
  availableTerminalHeight,
}: {
  config: Config | null;
  onClose: () => void;
  availableTerminalHeight?: number;
}) {
  const draft = useBatchSafeState<CreationWizardState>({
    ...initialWizardState,
    generationMethod: 'manual' as const,
  });
  const saving = useBatchSafeState(false);
  const succeeded = useBatchSafeState(false);
  const checkingName = useBatchSafeState(false);
  const setCheckingName = checkingName.setValue;
  const nameCheckFailed = useBatchSafeState(false);
  const setNameCheckFailed = nameCheckFailed.setValue;
  const [saveError, setSaveError] = useState('');
  const [warning, setWarning] = useState('');
  const [checkedName, setCheckedName] = useState<{
    draft: CreationWizardState;
    config: Config;
  } | null>(null);
  const alive = useRef(true);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);
  const { width, height } = useTerminalDimensions();
  const step = draft.value.currentStep;
  const kind = getStepKind('manual', step);
  const fieldAction =
    kind === 'MANUAL_NAME'
      ? 'SET_GENERATED_NAME'
      : kind === 'MANUAL_PROMPT'
        ? 'SET_GENERATED_SYSTEM_PROMPT'
        : kind === 'MANUAL_DESC'
          ? 'SET_GENERATED_DESCRIPTION'
          : null;
  const text =
    kind === 'MANUAL_NAME'
      ? draft.value.generatedName
      : kind === 'MANUAL_PROMPT'
        ? draft.value.generatedSystemPrompt
        : kind === 'MANUAL_DESC'
          ? draft.value.generatedDescription
          : '';
  const update = (...actions: WizardAction[]) => {
    draft.setValue(actions.reduce(wizardReducer, draft.ref.current));
  };
  const field = useLineEdit(
    text,
    (value) => {
      if (!alive.current || draft.ref.current.currentStep !== step) return;
      if (fieldAction === 'SET_GENERATED_NAME')
        update({ type: fieldAction, name: value });
      if (fieldAction === 'SET_GENERATED_SYSTEM_PROMPT')
        update({ type: fieldAction, systemPrompt: value });
      if (fieldAction === 'SET_GENERATED_DESCRIPTION')
        update({ type: fieldAction, description: value });
    },
    step,
  );
  const close = () => {
    if (!alive.current) return;
    alive.current = false;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    field.settle();
    onClose();
  };

  const toolCategories = useMemo(() => {
    const tools = config?.getToolRegistry().getAllTools() ?? [];
    const read = tools
      .filter((tool) =>
        [Kind.Read, Kind.Search, Kind.Fetch, Kind.Think].includes(tool.kind),
      )
      .map((tool) => tool.displayName)
      .sort();
    const edit = tools
      .filter((tool) => [Kind.Edit, Kind.Delete, Kind.Move].includes(tool.kind))
      .map((tool) => tool.displayName)
      .sort();
    const execute = tools
      .filter((tool) => tool.kind === Kind.Execute)
      .map((tool) => tool.displayName)
      .sort();
    return [
      { id: 'all', label: t('All Tools'), tools: [] as string[] },
      { id: 'read', label: t('Read-only Tools'), tools: read },
      { id: 'edit', label: t('Read & Edit Tools'), tools: [...read, ...edit] },
      {
        id: 'execute',
        label: t('Read & Edit & Execution Tools'),
        tools: [...read, ...edit, ...execute],
      },
    ].filter((category) => category.id === 'all' || category.tools.length > 0);
  }, [config]);
  const items = useMemo(
    () =>
      kind === 'LOCATION'
        ? [
            {
              key: 'project',
              value: 'project',
              label: t('Project Level (.qwen/agents/)'),
            },
            {
              key: 'user',
              value: 'user',
              label: t('User Level (~/.qwen/agents/)'),
            },
          ]
        : kind === 'GEN_METHOD'
          ? [{ key: 'manual', value: 'manual', label: t('Manual Creation') }]
          : kind === 'TOOLS'
            ? toolCategories.map((category) => ({
                key: category.id,
                value: category.id,
                label: category.label,
              }))
            : kind === 'COLOR'
              ? COLOR_OPTIONS.map((color) => ({
                  key: color.id,
                  value: color.id,
                  label: color.name,
                }))
              : [],
    [kind, toolCategories],
  );
  const initialIndex =
    kind === 'LOCATION'
      ? items.findIndex((item) => item.value === draft.value.location)
      : kind === 'COLOR'
        ? Math.max(
            0,
            COLOR_OPTIONS.findIndex(
              (color) =>
                color.id === draft.value.color ||
                color.name === draft.value.color ||
                color.value === draft.value.color,
            ),
          )
        : kind === 'TOOLS'
          ? Math.max(
              0,
              toolCategories.findIndex(
                (category) =>
                  category.tools.length === draft.value.selectedTools.length &&
                  category.tools.every((tool) =>
                    draft.value.selectedTools.includes(tool),
                  ),
              ),
            )
          : 0;
  const bodyRows = Math.max(
    1,
    Math.min(12, (availableTerminalHeight ?? height - 8) - 6),
  );
  const select = useDialogSelect({
    items,
    initialIndex,
    resyncKey: step,
    focused: items.length > 0 && !saving.value && !succeeded.value,
    maxItemsToShow: bodyRows,
    onSelect: (value) => {
      if (
        !alive.current ||
        saving.ref.current ||
        succeeded.ref.current ||
        draft.ref.current.currentStep !== step
      )
        return;
      setSaveError('');
      if (kind === 'LOCATION')
        update(
          {
            type: 'SET_LOCATION',
            location: value === 'user' ? 'user' : 'project',
          },
          { type: 'GO_TO_NEXT_STEP' },
        );
      if (kind === 'GEN_METHOD')
        update(
          { type: 'SET_GENERATION_METHOD', method: 'manual' },
          { type: 'GO_TO_NEXT_STEP' },
        );
      if (kind === 'TOOLS') {
        const category = toolCategories.find((entry) => entry.id === value);
        if (category)
          update(
            { type: 'SET_TOOLS', tools: category.tools },
            { type: 'GO_TO_NEXT_STEP' },
          );
      }
      if (kind === 'COLOR') {
        const color = COLOR_OPTIONS.find((entry) => entry.id === value);
        if (color) {
          checkingName.setValue(true);
          update(
            {
              type: 'SET_BACKGROUND_COLOR',
              color: color.id,
            },
            { type: 'GO_TO_NEXT_STEP' },
          );
        }
      }
    },
  });

  useEffect(() => {
    let current = true;
    setWarning('');
    setCheckedName(null);
    setNameCheckFailed(false);
    if (kind !== 'FINAL' || !config) {
      setCheckingName(false);
      return;
    }
    const snapshot = draft.value;
    void Promise.resolve()
      .then(() =>
        config.getSubagentManager().loadSubagent(snapshot.generatedName),
      )
      .then((existing) => {
        if (!current || !alive.current) return;
        setCheckingName(false);
        setCheckedName({ draft: snapshot, config });
        if (!existing) return;
        const level = existing.level === 'project' ? 'project' : 'user';
        setWarning(
          level === snapshot.location
            ? t(
                'Name "{{name}}" already exists at {{level}} level - will overwrite existing subagent',
                { name: snapshot.generatedName, level },
              )
            : snapshot.location === 'project'
              ? t(
                  'Name "{{name}}" exists at user level - project level will take precedence',
                  { name: snapshot.generatedName },
                )
              : t(
                  'Name "{{name}}" exists at project level - existing subagent will take precedence',
                  { name: snapshot.generatedName },
                ),
        );
      })
      .catch(() => {
        if (current && alive.current) {
          setNameCheckFailed(true);
          setCheckingName(false);
          setWarning(
            t('Unable to check existing subagents. Go back to try again.'),
          );
        }
      });
    return () => {
      current = false;
    };
  }, [config, kind, draft.value, setCheckingName, setNameCheckFailed]);

  const save = async () => {
    if (
      !alive.current ||
      checkingName.ref.current ||
      nameCheckFailed.ref.current ||
      saving.ref.current ||
      succeeded.ref.current ||
      (config &&
        (!checkedName ||
          checkedName.draft !== draft.ref.current ||
          checkedName.config !== config))
    )
      return;
    saving.setValue(true);
    setSaveError('');
    const snapshot = draft.ref.current;
    try {
      if (!config) throw new Error(t('Configuration not available'));
      const agent: SubagentConfig = {
        name: snapshot.generatedName,
        description: snapshot.generatedDescription,
        systemPrompt: snapshot.generatedSystemPrompt,
        level: snapshot.location,
        filePath: '',
        tools: snapshot.selectedTools,
        color: snapshot.color,
      };
      await config.getSubagentManager().createSubagent(agent, {
        level: snapshot.location,
        overwrite: true,
        assertCanCommit: () => {
          if (!alive.current) throw new Error('Subagent creation cancelled');
        },
      });
      if (!alive.current) return;
      succeeded.setValue(true);
      closeTimer.current = setTimeout(close, 2000);
    } catch (error) {
      if (alive.current)
        setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      if (alive.current) saving.setValue(false);
    }
  };

  useKeyboard((key) => {
    if (!alive.current || key.eventType === 'release') return;
    const original = toOriginalKey(key);
    if (original.name === 'escape') {
      if (
        saving.ref.current ||
        succeeded.ref.current ||
        draft.ref.current.currentStep === 1
      )
        close();
      else {
        field.settle();
        setSaveError('');
        update({ type: 'GO_TO_PREVIOUS_STEP' });
      }
      return;
    }
    if (
      saving.ref.current ||
      succeeded.ref.current ||
      draft.ref.current.currentStep !== step
    )
      return;
    if (fieldAction) {
      if (keyMatchers[Command.CLEAR_INPUT](original)) {
        field.clear();
      } else if (original.name === 'return') {
        if (!field.text.trim()) {
          update({
            type: 'SET_VALIDATION_ERRORS',
            errors: [t('Please enter a value.')],
          });
        } else {
          update(
            { type: 'SET_VALIDATION_ERRORS', errors: [] },
            { type: 'GO_TO_NEXT_STEP' },
          );
          field.settle();
        }
      } else if (!field.handleKey(original) && isPrintableKeyInput(key))
        field.insert(original.sequence);
    } else if (
      kind === 'FINAL' &&
      (original.name === 'return' || original.sequence === 's')
    )
      void save();
  });
  usePaste((event) => {
    if (
      !alive.current ||
      !fieldAction ||
      field.settled ||
      saving.ref.current ||
      succeeded.ref.current ||
      draft.ref.current.currentStep !== step
    )
      return;
    const value = normalizePastedText(decodePasteBytes(event.bytes));
    if (!value) return;
    event.preventDefault();
    field.insert(value);
  });

  const title =
    kind === 'LOCATION'
      ? t('Choose Location')
      : kind === 'GEN_METHOD'
        ? t('Choose Generation Method')
        : kind === 'MANUAL_NAME'
          ? t('Enter Subagent Name')
          : kind === 'MANUAL_PROMPT'
            ? t('Enter System Prompt')
            : kind === 'MANUAL_DESC'
              ? t('Enter Description')
              : kind === 'TOOLS'
                ? t('Select Tools')
                : kind === 'COLOR'
                  ? t('Choose Background Color')
                  : t('Confirm and Save');
  const spans = windowLineAtCaret(
    { text, cursor: field.caret },
    Math.max(1, dialogContentWidth(width)),
  );
  const before = sanitizeTerminalLine(spans.before);
  const after = sanitizeTerminalLine(spans.after);
  return (
    <DialogFrame>
      <text fg={C.text}>{`Step ${step}: ${title}`}</text>
      {succeeded.value ? (
        <text fg={C.green}>{t('✓ Subagent Created Successfully!')}</text>
      ) : (
        <scrollbox height={bodyRows} marginTop={1}>
          {items.length > 0 ? (
            <DialogSelect
              items={items}
              activeIndex={select.activeIndex}
              scrollOffset={select.scrollOffset}
              maxItemsToShow={bodyRows}
              onHover={select.highlightIndex}
              onSelectIndex={select.selectIndex}
              renderLabel={(item, { titleColor }) => (
                <text fg={titleColor}>{sanitizeTerminalLine(item.label)}</text>
              )}
            />
          ) : null}
          {fieldAction ? (
            <box flexDirection="column">
              <box flexDirection="row">
                {before ? <text fg={C.text}>{before}</text> : null}
                <text bg={C.accent}>
                  {sanitizeTerminalLine(spans.at) || ' '}
                </text>
                {after ? <text fg={C.text}>{after}</text> : null}
              </box>
              {draft.value.validationErrors.map((error) => (
                <text key={error} fg={C.red}>
                  {sanitizeTerminalText(error)}
                </text>
              ))}
            </box>
          ) : null}
          {warning ? (
            <text fg={C.yellow}>{sanitizeTerminalText(warning)}</text>
          ) : null}
          {kind === 'FINAL' ? (
            <box flexDirection="column">
              <text>
                {t('Name: ') + sanitizeTerminalLine(draft.value.generatedName)}
              </text>
              <text>
                {t('Location: ') +
                  (draft.value.location === 'project'
                    ? t('Project Level (.qwen/agents/)')
                    : t('User Level (~/.qwen/agents/)'))}
              </text>
              <text>
                {t('Tools: ') +
                  sanitizeTerminalLine(
                    draft.value.selectedTools.join(', ') || '*',
                  )}
              </text>
              <text>
                {t('Color: ') + sanitizeTerminalLine(draft.value.color)}
              </text>
              <text>
                {t('Description:') +
                  ' ' +
                  sanitizeTerminalText(draft.value.generatedDescription)}
              </text>
              <text>
                {t('System Prompt:') +
                  ' ' +
                  sanitizeTerminalText(draft.value.generatedSystemPrompt)}
              </text>
            </box>
          ) : null}
          {saveError ? (
            <text fg={C.red}>
              {t('✗ Error saving subagent:') +
                ' ' +
                sanitizeTerminalText(saveError)}
            </text>
          ) : null}
        </scrollbox>
      )}
      <FooterHint
        text={
          nameCheckFailed.value
            ? t('Esc to go back')
            : checkingName.value
              ? t('Checking existing subagents… Esc to go back')
              : saving.value
                ? t('Saving… Esc to close')
                : succeeded.value
                  ? t('Esc to close')
                  : kind === 'FINAL'
                    ? t('Press Enter to save, Esc to go back')
                    : step === 1
                      ? t(
                          'Press Enter to continue, ↑↓ to navigate, Esc to cancel',
                        )
                      : t('Press Enter to continue, Esc to go back')
        }
      />
    </DialogFrame>
  );
}
