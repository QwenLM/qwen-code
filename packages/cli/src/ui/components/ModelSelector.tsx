/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { I18nService } from '@qwen-code/core';

import type React from 'react';
import {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useReducer,
} from 'react';
import { Text, Box, useStdout } from 'ink';
import { theme } from '../semantic-colors.js';
import { SelectionText } from './SelectionText.js';
import { figures } from '../utils/figures.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import {
  SettingsListPanel,
  type SettingsDialogItem,
  type SettingsSuffixSegment,
} from './shared/SettingsListPanel.js';

import type {
  Config,
  Model,
  ReasoningEffortLevel,
  CustomProviderModelEdit,
} from '@qwen-code/core';

interface ModelEntry extends ContextWindowCapableModel {
  key: string;
  display_name: string;
  format: string;
  is_vl: boolean;
  is_reasoning: boolean;
  source: string;
  url: string;
  max_input_tokens: number;
  max_output_tokens?: number;
  available_context_windows?: readonly number[] | null;
  default_context_window?: number | null;
  context_window_is_estimate?: boolean;
  efforts?: readonly string[];
  supports_disabled?: boolean;
  default_effort?: string;
  enable: boolean;
  is_default: boolean;
  is_new: boolean;
  tags: readonly string[] | null;
  model_provider?: string;
}
import {
  QODER_PROVIDER_ID,
  QWEN_SUBSCRIPTION_PROVIDER_ID,
} from '@qwen-code/core';
import { useModelList } from '../contexts/ConfigContext.js';
import { getLocalModelEdit } from '../utils/localCustomModels.js';
import { LocalCustomModelForm } from './shared/LocalCustomModelForm.js';
import { CustomModelDeleteDialog } from './shared/CustomModelDeleteDialog.js';
import { formatCommand } from '../key/keybindingUtils.js';
import { CustomModelWizard } from './shared/CustomModelWizard.js';
import {
  useKeyMatchers,
  useKeyBindingConfig,
} from '../hooks/useKeyMatchers.js';
import { Command } from '../key/keyBindings.js';
import {
  useRegisterActionHandlers,
  type ActionHandler,
} from '../contexts/ActionHandlerRegistry.js';
import type { Key } from '../hooks/useKeypress.js';
import {
  ORDERED_EFFORT_LEVELS,
  formatEffortMeter,
  getDefaultReasoningEffort,
  getModelEfforts,
  getOrderedModelEfforts,
  supportsCurrentReasoningEffort,
} from '../utils/reasoningEffort.js';
import {
  formatContextWindowValueLabel,
  getEffectiveDefaultContextWindow,
  getModelContextWindows,
  type ContextWindowCapableModel,
} from '../utils/contextWindow.js';
import { getCachedStringWidth } from '../utils/textUtils.js';
import { formatLocalizedShortcutHint, useI18nService } from '../i18n/index.js';
import type { UiMessageKey } from '../i18n/types.js';

type ModelIdentity = {
  key: string;
  display_name: string;
};

function modelMatchesCurrentModel(
  model: ModelIdentity,
  currentModel: string | undefined,
): boolean {
  return (
    currentModel !== undefined &&
    (model.key === currentModel || model.display_name === currentModel)
  );
}

function resolveCurrentModelKey<T extends ModelIdentity>(
  modelList: readonly T[],
  currentModel: string | undefined,
): string | undefined {
  return modelList.find((model) =>
    modelMatchesCurrentModel(model, currentModel),
  )?.key;
}

const ADD_CUSTOM_MODEL_KEY = '__add_custom_model__';

/**
 * One row's in-dialog edits. Sparse: a field is present only while it differs
 * from what the row showed before the user touched it.
 */
export interface RowDraft {
  effort?: ReasoningEffortLevel;
  contextWindow?: number;
}

/** Row edits keyed by model key. */
export type RowDrafts = Record<string, RowDraft>;

function toModelEntry(model: Model): ModelEntry {
  const contextWindows = model.capabilities.contextWindows.map(
    ({ tokens }) => tokens,
  );
  const defaultContextWindow = model.defaultModelConfig?.context?.contextWindow;
  return {
    key: model.key,
    display_name: model.displayName,
    format: 'openai',
    is_vl: model.capabilities.vision,
    is_reasoning: model.capabilities.reasoning.supported,
    source: model.source,
    url: '',
    max_input_tokens: model.limits.maxContextTokens,
    max_output_tokens: model.limits.maxOutputTokens ?? 8_192,
    ...(contextWindows.length > 0
      ? { available_context_windows: contextWindows }
      : {}),
    ...(defaultContextWindow !== undefined
      ? { default_context_window: defaultContextWindow }
      : {}),
    efforts: [...model.capabilities.reasoning.supportedEfforts],
    enable: model.enabled !== false,
    is_default: model.isDefault === true,
    is_new: false,
    tags: null,
    model_provider: model.source,
  };
}

/** Local custom models keep their editable entries; provider models fill the rest. */
function mergeModelEntries(
  registryModels: readonly ModelEntry[],
  providerModels: readonly ModelEntry[],
): ModelEntry[] {
  const byKey = new Map<string, ModelEntry>();
  for (const model of registryModels) byKey.set(model.key, model);
  for (const model of providerModels) {
    if (!byKey.has(model.key)) byKey.set(model.key, model);
  }
  return [...byKey.values()];
}

interface ModelSelectorProps {
  config?: Config;
  /** Initial provider-manager catalog, used until the live query completes. */
  listedModels?: readonly Model[];
  currentModel?: string;
  currentReasoningEffort?: ReasoningEffortLevel;
  currentContextWindow?: number;
  onSelect: (
    modelKey: string,
    reasoningEffort?: ReasoningEffortLevel,
    contextWindow?: number,
    /**
     * `persist: false` applies the model to the running session without
     * writing it to settings (the `s` shortcut). Omitted means persist, which
     * is what Enter does.
     */
    options?: {
      persist?: boolean;
      /**
       * Rows the user tuned besides the one being selected, keyed by model.
       * The caller writes them as preferences with the same `persist` scope.
       */
      otherModelPreferences?: RowDrafts;
    },
  ) => void;
  onClose: () => void;
  /**
   * Reads a model's stored effort / context-window preference so each row can
   * open on what the user last chose for *that* model rather than its default.
   *
   * Injected by the caller so the UI does not need to interpret the stored
   * `model.preferences` shape.
   */
  readModelPreference?: (modelId: string) => {
    effort?: ReasoningEffortLevel;
    contextWindow?: number;
  };
}

/**
 * Cells in a row's effort gauge. Fixed rather than per-model: models expose
 * between two and six levels, and a gauge that changed width row to row would
 * leave every column after it ragged.
 *
 * Five is enough for six levels because `none` is not a rung on the ladder —
 * see `formatEffortMeter`.
 */
const EFFORT_METER_WIDTH = 5;
/** Cells the caret occupies on each side of a column, lit or not. */
const CARET_WIDTH = 2;
/** Cells reserved at the start of an adjustable row for its changed mark. */
const MODIFIED_MARK_WIDTH = 2;
/** Floor for the model-name column, so short lists still line up. */
const MIN_MODEL_LABEL_WIDTH = 12;
/** Ceiling for the name column, as a share of the terminal. */
const MODEL_LABEL_WIDTH_RATIO = 0.4;

function padRight(value: string, width: number): string {
  const length = getCachedStringWidth(value);
  return length >= width ? value : value + ' '.repeat(width - length);
}

/**
 * The width one row's label occupies, matching exactly what SettingsListPanel
 * will render: the label, then a single space, then the badge.
 *
 * The space is not decoration — SLP emits it as part of the badge run and
 * `labelSuffixPad` subtracts it when padding out to the column width. Leaving
 * it out here makes the longest badged row render one cell wider than every
 * other row, which is the alignment bug this exists to prevent.
 */
function measureRowLabelWidth(label: string): number {
  return getCachedStringWidth(label);
}

/**
 * The next value in `list`, or `undefined` when the step would not move.
 *
 * Shared by the key handler and the caret renderer on purpose: "this arrow is
 * lit" and "this arrow does something" have to be the same predicate, or the
 * list ends up with bright arrows that do nothing.
 *
 * Clamped rather than wrapping — jumping from the cheapest effort straight to
 * `max` on one keypress is an expensive surprise.
 */
export function stepValue<T>(
  list: readonly T[],
  current: T | undefined,
  delta: number,
): T | undefined {
  if (list.length === 0) return undefined;
  const index = current === undefined ? -1 : list.indexOf(current);
  const base = index < 0 ? 0 : index;
  const next = list[Math.min(list.length - 1, Math.max(0, base + delta))];
  return next === current ? undefined : next;
}

/**
 * Which column the arrows drive on this row: the focused one, unless the row
 * doesn't have it, in which case the other one — so the arrows stay useful
 * without the user first pressing Space. `undefined` when the row has neither.
 */
function resolveActiveColumn(
  efforts: readonly unknown[],
  windows: readonly unknown[],
  focusedColumn: 'effort' | 'context',
): 'effort' | 'context' | undefined {
  if (efforts.length === 0 && windows.length === 0) return undefined;
  if (focusedColumn === 'effort') {
    return efforts.length > 0 ? 'effort' : 'context';
  }
  return windows.length > 0 ? 'context' : 'effort';
}

/**
 * The options bag for `onSelect`, or `undefined` when it would carry nothing —
 * so a plain Enter keeps calling `onSelect` with exactly four arguments.
 *
 * Every tuned row except the selected one rides along: confirming a model
 * saves the edits made anywhere in the dialog. The selected key is always left
 * out (its draft travels in the positional arguments), which also keeps a
 * key that collides with another configured model key from being written twice.
 */
export function buildSelectOptions(
  drafts: RowDrafts,
  selectedKey: string,
  options: { persist?: boolean } | undefined,
): { persist?: boolean; otherModelPreferences?: RowDrafts } | undefined {
  const others: RowDrafts = {};
  for (const [key, draft] of Object.entries(drafts)) {
    if (key !== selectedKey) others[key] = draft;
  }
  const hasOthers = Object.keys(others).length > 0;
  if (!options && !hasOthers) return undefined;
  return {
    ...options,
    ...(hasOthers ? { otherModelPreferences: others } : {}),
  };
}

export interface EffortCapableModel {
  source?: string;
  context_window_is_estimate?: boolean;
  key: string;
  display_name: string;
  efforts?: readonly string[] | null;
  supports_disabled?: boolean | null;
  supportsDisabled?: boolean | null;
  default_effort?: string | null;
  defaultEffort?: string | null;
}

const EFFORT_LABEL_KEYS: Record<ReasoningEffortLevel, UiMessageKey> = {
  none: 'models.effort.none.label',
  low: 'models.effort.low.label',
  medium: 'models.effort.medium.label',
  high: 'models.effort.high.label',
  xhigh: 'models.effort.xhigh.label',
  max: 'models.effort.max.label',
};

function isDisableOnlyEffortToggle(
  model: EffortCapableModel,
  efforts: readonly ReasoningEffortLevel[],
): boolean {
  const supportsDisabled =
    model.supports_disabled === true || model.supportsDisabled === true;
  return (
    supportsDisabled &&
    efforts.length > 0 &&
    efforts.every((effort) => effort === 'none')
  );
}

function formatLocalizedEffortLabel(
  effort: ReasoningEffortLevel,
  t: I18nService['get'],
): string {
  return t(EFFORT_LABEL_KEYS[effort]);
}

type ModelOptionsCapableModel = EffortCapableModel & ContextWindowCapableModel;

interface ModelOptionChoice<T> {
  key: string;
  value: T;
  label: string;
}

interface ModelOptionRow {
  key: string;
  label: string;
  /** Leading icon shown before the label, matching the model-list footer. */
  icon?: string;
  valueLabel: string;
  description?: string;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  move: (direction: -1 | 1) => void;
}

/** One icon-prefixed setting shown in the model list footer. */
interface FocusedSettingsSegment {
  icon: string;
  /** Defaults to the success color the settings icons share. */
  iconColor?: string;
  label: string;
}

/**
 * Footer hint for the focused model in the model list: icon-prefixed settings
 * only. The "use /effort to change …" line that used to ride along here moved
 * out — the arrow keys now say what they do in the dialog's shortcut row.
 */
type FocusedModelSettingsHint = FocusedSettingsSegment[];

type ModelOptionsEffortSelection =
  | ReasoningEffortLevel
  | 'ultracode'
  | undefined;

interface ModelOptionsSelectorProps {
  model: ModelOptionsCapableModel;
  currentReasoningEffort?: ReasoningEffortLevel;
  currentUltracode?: boolean;
  ultracodeAvailable?: boolean;
  currentContextWindow?: number;
  initialFocusKey?: string;
  onSelect: (
    reasoningEffort: ReasoningEffortLevel | undefined,
    contextWindow: number | undefined,
    ultracode?: boolean,
  ) => void | Promise<void>;
  onCancel: () => void;
}

function wrapOptionIndex(current: number, direction: -1 | 1, length: number) {
  return (current + direction + length) % length;
}

export function ModelOptionsSelector({
  model,
  currentReasoningEffort,
  currentUltracode = false,
  ultracodeAvailable = false,
  currentContextWindow,
  initialFocusKey,
  onSelect,
  onCancel,
}: ModelOptionsSelectorProps): React.JSX.Element {
  const i18n = useI18nService();
  const getUiText = i18n.get;
  const efforts = useMemo(() => getOrderedModelEfforts(model), [model]);
  const contextWindows = useMemo(() => getModelContextWindows(model), [model]);
  const hasEffortOptions = efforts.length > 0;
  const supportsUltracode = ultracodeAvailable && efforts.includes('xhigh');
  const hasContextWindowOptions = contextWindows.length > 1;
  const disableOnlyEffortToggle = isDisableOnlyEffortToggle(model, efforts);
  const defaultEffort = getDefaultReasoningEffort(model);
  const defaultContextWindow = getEffectiveDefaultContextWindow(model);

  const effortChoices = useMemo<
    Array<ModelOptionChoice<ModelOptionsEffortSelection>>
  >(
    () =>
      hasEffortOptions
        ? [
            {
              key: 'default',
              value: undefined,
              label: disableOnlyEffortToggle
                ? getUiText(
                    model.source === 'custom'
                      ? 'models.local.providerDefault'
                      : 'models.options.enabledDefault',
                  )
                : defaultEffort !== undefined
                  ? `${formatLocalizedEffortLabel(defaultEffort, getUiText)} (${getUiText('models.options.default')})`
                  : getUiText('models.options.default'),
            },
            ...efforts.map((effort) => ({
              key: effort,
              value: effort,
              label:
                disableOnlyEffortToggle && effort === 'none'
                  ? getUiText('models.options.disabled')
                  : formatLocalizedEffortLabel(effort, getUiText),
            })),
            ...(supportsUltracode
              ? [
                  {
                    key: 'ultracode',
                    value: 'ultracode' as const,
                    label: 'Ultracode',
                  },
                ]
              : []),
          ]
        : [],
    [
      defaultEffort,
      disableOnlyEffortToggle,
      efforts,
      hasEffortOptions,
      supportsUltracode,
      getUiText,
      model.source,
    ],
  );

  const contextWindowChoices = useMemo<
    Array<ModelOptionChoice<number | undefined>>
  >(
    () =>
      hasContextWindowOptions
        ? [
            {
              key: 'default',
              value: undefined,
              label:
                defaultContextWindow !== undefined
                  ? formatContextWindowValueLabel(defaultContextWindow)
                  : getUiText('models.options.defaultLower'),
            },
            ...contextWindows
              .filter((value) => value !== defaultContextWindow)
              .map((value) => ({
                key: String(value),
                value,
                label: formatContextWindowValueLabel(value),
              })),
          ]
        : [],
    [contextWindows, defaultContextWindow, hasContextWindowOptions, getUiText],
  );

  const [selectedEffortIndex, setSelectedEffortIndex] = useState(() =>
    Math.max(
      0,
      effortChoices.findIndex(
        (choice) =>
          choice.value ===
          (currentUltracode && supportsUltracode
            ? 'ultracode'
            : currentReasoningEffort),
      ),
    ),
  );
  const [selectedContextWindowIndex, setSelectedContextWindowIndex] = useState(
    () =>
      Math.max(
        0,
        contextWindowChoices.findIndex(
          (choice) => choice.value === currentContextWindow,
        ),
      ),
  );
  // Track explicit effort selection, even when it returns to the same value.
  const [effortTouched, setEffortTouched] = useState(false);

  const moveEffort = useCallback(
    (direction: -1 | 1) => {
      if (effortChoices.length === 0) return;
      setEffortTouched(true);
      setSelectedEffortIndex((current) =>
        wrapOptionIndex(current, direction, effortChoices.length),
      );
    },
    [effortChoices.length],
  );

  const moveContextWindow = useCallback(
    (direction: -1 | 1) => {
      if (contextWindowChoices.length === 0) return;
      setSelectedContextWindowIndex((current) =>
        wrapOptionIndex(current, direction, contextWindowChoices.length),
      );
    },
    [contextWindowChoices.length],
  );

  const rows = useMemo<ModelOptionRow[]>(() => {
    const nextRows: ModelOptionRow[] = [];
    const noop = () => {};
    const contextWindowDescription = getUiText(
      model.context_window_is_estimate
        ? 'models.local.budgetDescription'
        : 'models.options.contextDescription',
    );
    // Wording adapts to the control: on/off toggle vs graded effort levels.
    const effortDescription =
      model.source === 'custom' && !hasEffortOptions
        ? getUiText('models.local.thinkingUnknown')
        : disableOnlyEffortToggle
          ? getUiText('models.options.effortToggleDescription')
          : getUiText('models.options.effortDescription');

    // Context Window — always shown. Falls back to the model's default value,
    // non-switchable, when there is nothing to choose from.
    const selectedContextWindow =
      contextWindowChoices[selectedContextWindowIndex];
    if (selectedContextWindow) {
      nextRows.push({
        key: 'context-window',
        label: getUiText('models.options.context'),
        icon: figures.contextWindow,
        valueLabel: selectedContextWindow.label,
        description: contextWindowDescription,
        canMoveLeft: contextWindowChoices.length > 1,
        canMoveRight: contextWindowChoices.length > 1,
        move: moveContextWindow,
      });
    } else {
      nextRows.push({
        key: 'context-window',
        label: getUiText('models.options.context'),
        icon: figures.contextWindow,
        valueLabel:
          defaultContextWindow !== undefined
            ? formatContextWindowValueLabel(defaultContextWindow)
            : getUiText('models.options.default'),
        description: contextWindowDescription,
        canMoveLeft: false,
        canMoveRight: false,
        move: noop,
      });
    }

    // Thinking Effort — always shown. Falls back to "Default", non-switchable.
    const selectedEffort = effortChoices[selectedEffortIndex];
    if (selectedEffort) {
      nextRows.push({
        key: 'effort',
        label: getUiText('models.options.effort'),
        icon: figures.thinkingEffort,
        valueLabel: selectedEffort.label,
        description:
          selectedEffort.value === 'ultracode'
            ? getUiText('models.options.ultracodeDescription')
            : effortDescription,
        canMoveLeft: effortChoices.length > 1,
        canMoveRight: effortChoices.length > 1,
        move: moveEffort,
      });
    } else {
      nextRows.push({
        key: 'effort',
        label: getUiText('models.options.effort'),
        icon: figures.thinkingEffort,
        valueLabel: getUiText('models.options.default'),
        description: effortDescription,
        canMoveLeft: false,
        canMoveRight: false,
        move: noop,
      });
    }

    return nextRows;
  }, [
    contextWindowChoices,
    defaultContextWindow,
    disableOnlyEffortToggle,
    hasEffortOptions,
    model,
    moveContextWindow,
    moveEffort,
    selectedContextWindowIndex,
    selectedEffortIndex,
    effortChoices,
    getUiText,
  ]);
  const optionValueWidth = useMemo(() => {
    const labels = [
      // Fallback value used for non-provided rows.
      getUiText('models.options.default'),
      ...contextWindowChoices.map((choice) => choice.label),
      ...effortChoices.map((choice) => choice.label),
    ];
    return Math.max(1, ...labels.map((label) => getCachedStringWidth(label)));
  }, [contextWindowChoices, effortChoices, getUiText]);
  // Column width for titles so the inline descriptions line up across rows.
  const labelColumnWidth = useMemo(
    () =>
      Math.max(1, ...rows.map((row) => getCachedStringWidth(row.label))) + 2,
    [rows],
  );
  const selectionSummary = useMemo(
    () =>
      [...rows]
        .sort((left, right) => {
          const summaryOrder: Record<string, number> = {
            'context-window': 0,
            effort: 1,
          };
          return (
            (summaryOrder[left.key] ?? 100) - (summaryOrder[right.key] ?? 100)
          );
        })
        .map((row) => ({
          key: row.key,
          icon: row.icon,
          // Icon-bearing rows show "<icon> <value>"; others keep their label.
          text: row.icon ? row.valueLabel : `${row.label}: ${row.valueLabel}`,
        })),
    [rows],
  );
  const [selectedRowIndex, setSelectedRowIndex] = useState(() => {
    if (!initialFocusKey) return 0;
    const index = rows.findIndex((row) => row.key === initialFocusKey);
    return Math.max(0, index);
  });

  useEffect(() => {
    setSelectedRowIndex((current) =>
      rows.length === 0 ? 0 : Math.min(current, rows.length - 1),
    );
  }, [rows.length]);

  const submit = useCallback(() => {
    const effort = hasEffortOptions
      ? effortChoices[selectedEffortIndex]?.value
      : undefined;
    void onSelect(
      effort === 'ultracode' ? 'xhigh' : effort,
      hasContextWindowOptions
        ? contextWindowChoices[selectedContextWindowIndex]?.value
        : undefined,
      effortTouched
        ? effort === 'ultracode'
        : currentUltracode && supportsUltracode
          ? true
          : undefined,
    );
  }, [
    contextWindowChoices,
    currentUltracode,
    effortChoices,
    effortTouched,
    hasContextWindowOptions,
    hasEffortOptions,
    onSelect,
    selectedContextWindowIndex,
    selectedEffortIndex,
    supportsUltracode,
  ]);

  const focusHandlers = useMemo<Record<string, ActionHandler>>(
    () => ({
      'dialog:navigate:up': () => {
        if (rows.length === 0) return true;
        setSelectedRowIndex(
          (current) => (current - 1 + rows.length) % rows.length,
        );
        return true;
      },
      'dialog:navigate:down': () => {
        if (rows.length === 0) return true;
        setSelectedRowIndex((current) => (current + 1) % rows.length);
        return true;
      },
      'dialog:navigate:left': () => {
        rows[selectedRowIndex]?.move(-1);
        return true;
      },
      'dialog:navigate:right': () => {
        rows[selectedRowIndex]?.move(1);
        return true;
      },
      'dialog:confirm': () => {
        submit();
        return true;
      },
    }),
    [rows, selectedRowIndex, submit],
  );
  useRegisterActionHandlers('Dialog', focusHandlers, rows.length > 0);

  return (
    <BaseTabDialog
      title={i18n.get('models.options.title')}
      onClose={onCancel}
      footer={`${i18n.get('models.options.selectHint')} · ${i18n.get(
        'shortcut.arrowSwitch',
      )} · ${i18n.get('models.options.applyHint')} · ${i18n.get('shortcut.back')}`}
    >
      <Box flexDirection="column" minWidth={62}>
        <Box marginBottom={1}>
          <Text color={theme.text.secondary}>
            {i18n.get('models.options.model')}
            <Text color={theme.text.primary}>{model.display_name}</Text>
          </Text>
        </Box>
        <Box flexDirection="column">
          {rows.map((row, index) => {
            const isSelected = index === selectedRowIndex;
            // A row with no movable choices (e.g. a fixed context window, or a
            // default-only effort/fast row) hides its arrows entirely; a blank
            // placeholder keeps the value column aligned with switchable rows.
            const isSwitchable = row.canMoveLeft || row.canMoveRight;
            return (
              <Box key={row.key} flexDirection="column">
                {/* Title line: black label + its description inline; only the
                    focus pointer marks the active row. */}
                <Box flexDirection="row">
                  <Text
                    color={isSelected ? theme.ui.focus : theme.text.primary}
                  >
                    {isSelected ? '❯ ' : '  '}
                  </Text>
                  <Box width={labelColumnWidth}>
                    <Text color={theme.text.primary}>{row.label}</Text>
                  </Box>
                  {row.description ? (
                    <Text color={theme.text.secondary} dimColor>
                      {row.description}
                    </Text>
                  ) : null}
                </Box>
                {/* Value line below the title — the highlighted part when the
                    row is selected. Switchable rows use triangle controls. */}
                <Box paddingLeft={4} flexDirection="row" alignItems="center">
                  <Text
                    color={
                      isSelected && row.canMoveLeft
                        ? theme.ui.focus
                        : theme.text.secondary
                    }
                    dimColor={!isSelected || !row.canMoveLeft}
                  >
                    {isSwitchable ? figures.triangleLeft : ' '}
                  </Text>
                  <Box
                    width={optionValueWidth}
                    marginX={1}
                    justifyContent="center"
                  >
                    <Text
                      color={isSelected ? theme.ui.focus : theme.text.primary}
                      bold={isSelected}
                    >
                      {row.valueLabel}
                    </Text>
                  </Box>
                  <Text
                    color={
                      isSelected && row.canMoveRight
                        ? theme.ui.focus
                        : theme.text.secondary
                    }
                    dimColor={!isSelected || !row.canMoveRight}
                  >
                    {isSwitchable ? figures.triangleRight : ' '}
                  </Text>
                </Box>
              </Box>
            );
          })}
          {selectionSummary.length > 0 && (
            <Box marginTop={1}>
              <Text color={theme.text.secondary} dimColor>
                {i18n.get('models.options.selected')}
                {selectionSummary.map((segment, index) => (
                  <Text key={segment.key}>
                    {index > 0 ? (
                      <Text color={theme.text.secondary}>{' · '}</Text>
                    ) : null}
                    {segment.icon ? (
                      <SelectionText bold>{segment.icon} </SelectionText>
                    ) : null}
                    <Text color={theme.text.primary}>{segment.text}</Text>
                  </Text>
                ))}
              </Text>
            </Box>
          )}
        </Box>
      </Box>
    </BaseTabDialog>
  );
}

// Stable no-op callbacks required by SettingsListPanel interface (model
// selection uses onItemToggle; edit/clear are not applicable here).
const noopEditCommit = (
  _key: string,
  _value: string,
  _item: SettingsDialogItem,
) => {};
const noopItemClear = (_key: string, _item: SettingsDialogItem) => {};

/**
 * Interactive model selector matching the original CLI UI layout:
 *
 * ```
 * Model:  [Default]  New  Custom
 *
 *   Available Models:
 *    - Auto        1.00x cost
 *      Smartly select the optimal model, balancing performance and cost
 *    → Ultimate    1.60x cost
 *      Expert-level deep reasoning and thinking with peak output quality
 * ```
 */
export function ModelSelector({
  config,
  listedModels,
  currentModel,
  currentReasoningEffort,
  currentContextWindow,
  onSelect,
  onClose,
  readModelPreference,
}: ModelSelectorProps): React.JSX.Element {
  const i18n = useI18nService();
  const getUiText = i18n.get;
  const keyMatchers = useKeyMatchers();
  const keyBindingConfig = useKeyBindingConfig();
  const [deleteItem, setDeleteItem] = useState<SettingsDialogItem>();
  const [customWizard, setCustomWizard] = useState(false);
  const [editModel, setEditModel] = useState<CustomProviderModelEdit>();
  const localEditorOpen = customWizard || editModel !== undefined;
  const [preferredCustomKey, setPreferredCustomKey] = useState<string>();
  const [, setAccessRevision] = useState(0);
  const [modelListRevision, refreshModelList] = useReducer(
    (value: number) => value + 1,
    0,
  );
  const providerSettings = config?.getLoadedSettings().merged.providers;
  const liveModels = useModelList(config, modelListRevision, listedModels);
  const { models, customProviderModels, selectableModels } = useMemo(() => {
    const registryModels = config
      ? config
          .getCustomProviderRegistry()
          .getPublicModels()
          .map(
            (model): ModelEntry => ({
              key: model.key,
              display_name: model.displayName,
              format: model.format,
              is_vl: false,
              is_reasoning: Boolean(model.capabilities?.thinking),
              source: 'custom',
              url: '',
              max_input_tokens: 128_000,
              max_output_tokens: 8_192,
              efforts: model.capabilities?.thinking?.supportedEffortLevels
                ? [...model.capabilities.thinking.supportedEffortLevels]
                : undefined,
              enable: true,
              is_default: false,
              is_new: false,
              tags: null,
              model_provider: model.providerId,
            }),
          )
      : [];
    const merged = mergeModelEntries(registryModels, liveModels.map(toModelEntry));
    const qoderModels = merged.filter(
      (model) => model.source === QODER_PROVIDER_ID,
    );
    const customProviderModels = merged.filter(
      (model) => model.source !== QODER_PROVIDER_ID,
    );
    return {
      models: merged,
      customProviderModels,
      // Qwen order: Qoder catalog entries first, then local/provider models.
      selectableModels: [...qoderModels, ...customProviderModels],
    };
  }, [config, liveModels]);
  const customAccessAllowed = config?.canUseCustomProviders() === true;
  const canManageCustom =
    config?.getCustomProviderAccessMode() === 'local' && customAccessAllowed;
  // Local Custom Provider entry/edit gates must mirror the save gate in
  // createLocalProviderFromTui, otherwise unentitled accounts reach a save
  // that is always rejected. Until the access check settles the gates stay
  // closed, matching the save gate.
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    void config.ensureCustomProvidersAccess().then(
      () => {
        if (!cancelled) setAccessRevision((revision) => revision + 1);
      },
      () => {
        // Keep manage actions gated if access preparation fails.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [config]);
  // The registry is the metadata source for protocol labels and local model
  // edits. Sessions started straight on a custom provider never go through
  // the Qoder runtime path that populates it.
  useEffect(() => {
    if (!config) return;
    const providers = config.getLoadedSettings().merged.providers;
    if (!providers || Object.keys(providers).length === 0) return;
    if (config.getCustomProviderRegistry().getPublicModels().length > 0) return;
    let cancelled = false;
    void config.initializeCustomProviders().then(
      () => {
        if (!cancelled) setAccessRevision((revision) => revision + 1);
      },
      () => {
        // Keep the manager-backed rows; labels fall back to the provider id.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [config]);
  const [searchState, setSearchState] = useState({
    active: false,
    hasQuery: false,
  });
  const searchActive = searchState.active;
  const [rowDrafts, setRowDrafts] = useState<RowDrafts>({});
  const rowDraftsRef = useRef<RowDrafts>({});
  const commitRowDrafts = useCallback((next: RowDrafts) => {
    rowDraftsRef.current = next;
    setRowDrafts(next);
  }, []);
  const [focusedColumn, setFocusedColumn] = useState<'effort' | 'context'>(
    'effort',
  );
  const focusedColumnRef = useRef<'effort' | 'context'>('effort');
  const [focusedModelKey, setFocusedModelKey] = useState<string | undefined>();
  const visibleDrafts = rowDrafts;
  const changedModelCount = Object.keys(visibleDrafts).length;
  const hasChanges = changedModelCount > 0;
  const { stdout } = useStdout();
  const columnLayout: 'full' | 'compact' | 'minimal' = useMemo(() => {
    const width = stdout?.columns ?? 80;
    if (width >= 100) return 'full';
    if (width >= 80) return 'compact';
    return 'minimal';
  }, [stdout?.columns]);

  const refreshActionHandlers = useMemo<Record<string, ActionHandler>>(
    () => ({
      'dialog:escape': () => {
        if (editModel) setEditModel(undefined);
        else if (customWizard) setCustomWizard(false);
        else if (deleteItem) setDeleteItem(undefined);
        else onClose();
        return true;
      },
    }),
    [customWizard, editModel, deleteItem, onClose],
  );
  useRegisterActionHandlers('Dialog', refreshActionHandlers, true);

  const currentModelDisplay =
    models.find((model) => modelMatchesCurrentModel(model, currentModel))
      ?.display_name ??
    currentModel ??
    'Auto';

  /**
   * Rows this picker can adjust inline. Disable-only models are excluded on
   * purpose: their "Enabled" state is spelled `undefined`, which is also how
   * `setModelAndLog` spells "leave it alone", so the inline control could
   * switch such a model off but never back on. They stay read-only here and
   * keep `/effort` as the way to change them.
   */
  const rowEfforts = useCallback(
    (model: ModelEntry): ReasoningEffortLevel[] => {
      const efforts = getOrderedModelEfforts(model as EffortCapableModel);
      // One level is a fact, not a choice: no arrows, and the focused-row hint
      // keeps reporting it the way it always has.
      if (efforts.length <= 1) return [];
      if (isDisableOnlyEffortToggle(model as EffortCapableModel, efforts)) {
        return [];
      }
      return efforts;
    },
    [],
  );

  /**
   * Context tiers this row can cycle. `getModelContextWindows` already returns
   * an empty list when the context-window feature gate is off, so this single
   * check covers both a gated-off build and a model with one fixed tier.
   */
  const rowContextWindows = useCallback((model: ModelEntry): number[] => {
    const windows = getModelContextWindows(model);
    // One tier is a fact, not a choice — and the helper already returns [] when
    // the context-window feature gate is off, so this covers both.
    if (windows.length <= 1) return [];
    // Sorted because the server's order is not guaranteed: the
    // `available_context_windows` path runs through `normalizeContextWindows`,
    // which dedupes but never sorts, so a payload of [1M, 128K, 200K] would
    // make Left/Right jump around and clamp at the wrong ends.
    return [...windows].sort((a, b) => a - b);
  }, []);

  /**
   * What a row shows before the user touches it: the active model's live value,
   * else what is stored for that model, else the model's own default. A draft
   * that lands back here is no draft at all.
   */
  const resolveBaselineEffort = useCallback(
    (model: ModelEntry): ReasoningEffortLevel | undefined => {
      const efforts = rowEfforts(model);
      if (efforts.length === 0) return undefined;
      const isCurrent = modelMatchesCurrentModel(model, currentModel);
      // The active model's live value beats anything stored on disk.
      if (isCurrent && currentReasoningEffort !== undefined) {
        return efforts.includes(currentReasoningEffort)
          ? currentReasoningEffort
          : getDefaultReasoningEffort(model);
      }
      const stored = readModelPreference?.(model.key)?.effort;
      if (stored !== undefined && efforts.includes(stored)) return stored;
      return getDefaultReasoningEffort(model);
    },
    [currentModel, currentReasoningEffort, readModelPreference, rowEfforts],
  );

  const resolveBaselineContextWindow = useCallback(
    (model: ModelEntry): number | undefined => {
      const windows = rowContextWindows(model);
      if (windows.length === 0) return undefined;
      const isCurrent = modelMatchesCurrentModel(model, currentModel);
      if (isCurrent && currentContextWindow !== undefined) {
        return windows.includes(currentContextWindow)
          ? currentContextWindow
          : getEffectiveDefaultContextWindow(model);
      }
      const stored = readModelPreference?.(model.key)?.contextWindow;
      if (stored !== undefined && windows.includes(stored)) return stored;
      // `getEffectiveDefaultContextWindow` hands back `default_context_window`
      // verbatim, without checking it against the tier list. Left alone, a
      // model advertising tiers [128K, 200K, 1M] with a 256K default would
      // display 256K and then *shrink* to 200K on the first Right press. Snap
      // onto a real tier so every rendered value is one the arrows can walk.
      const fallback = getEffectiveDefaultContextWindow(model);
      if (fallback === undefined) return undefined;
      if (windows.includes(fallback)) return fallback;
      return windows.reduce((best, tier) =>
        Math.abs(tier - fallback) < Math.abs(best - fallback) ? tier : best,
      );
    },
    [
      currentContextWindow,
      currentModel,
      readModelPreference,
      rowContextWindows,
    ],
  );

  /**
   * What a row displays and Enter applies: its draft if any, else its baseline.
   * Key handlers pass `rowDraftsRef.current`, which can be ahead of the render.
   */
  const resolveRowEffort = useCallback(
    (
      model: ModelEntry,
      drafts: RowDrafts = rowDrafts,
    ): ReasoningEffortLevel | undefined =>
      rowEfforts(model).length === 0
        ? undefined
        : (drafts[model.key]?.effort ?? resolveBaselineEffort(model)),
    [resolveBaselineEffort, rowDrafts, rowEfforts],
  );

  const resolveRowContextWindow = useCallback(
    (model: ModelEntry, drafts: RowDrafts = rowDrafts): number | undefined =>
      rowContextWindows(model).length === 0
        ? undefined
        : (drafts[model.key]?.contextWindow ??
          resolveBaselineContextWindow(model)),
    [resolveBaselineContextWindow, rowContextWindows, rowDrafts],
  );

  /**
   * Step the focused column of `model` by one notch, clamped at both ends.
   *
   * Clamped rather than wrapping: wrapping from the cheapest effort straight to
   * `max` on one keypress is an expensive surprise.
   *
   * Returns true whenever the key belonged to this list — including when the
   * row has nothing to step. Declining would let the arrow fall through to the
   * dialog and switch tabs, which is exactly the surprise this consumes.
   */
  const stepFocusedColumn = useCallback(
    (modelKey: string, delta: number): boolean => {
      const model = selectableModels.find((m) => m.key === modelKey);
      if (!model) return true;
      // An unavailable model can never be applied, so a draft on it is dead
      // state. Still consume the key, or it would fall through to the dialog.
      if (model.enable === false) return true;
      const efforts = rowEfforts(model);
      const windows = rowContextWindows(model);
      // Read the refs, not the state: Space and an arrow, or two arrows, can
      // arrive in one stdin chunk before React commits the first of them.
      const column = resolveActiveColumn(
        efforts,
        windows,
        focusedColumnRef.current,
      );
      if (!column) return true;
      const drafts = rowDraftsRef.current;
      const draft: RowDraft = { ...drafts[model.key] };

      // Landing back on the baseline undoes the edit instead of recording a
      // "change" to the value the row already had — Enter would otherwise
      // write a preference for an edit the user took back.
      if (column === 'effort') {
        const next = stepValue(efforts, resolveRowEffort(model, drafts), delta);
        if (next === undefined) return true;
        if (next === resolveBaselineEffort(model)) {
          delete draft.effort;
        } else {
          draft.effort = next;
        }
      } else {
        const next = stepValue(
          windows,
          resolveRowContextWindow(model, drafts),
          delta,
        );
        if (next === undefined) return true;
        if (next === resolveBaselineContextWindow(model)) {
          delete draft.contextWindow;
        } else {
          draft.contextWindow = next;
        }
      }

      const nextDrafts: RowDrafts = { ...drafts };
      if (draft.effort === undefined && draft.contextWindow === undefined) {
        delete nextDrafts[model.key];
      } else {
        nextDrafts[model.key] = draft;
      }
      commitRowDrafts(nextDrafts);
      return true;
    },
    [
      commitRowDrafts,
      selectableModels,
      resolveBaselineContextWindow,
      resolveBaselineEffort,
      resolveRowContextWindow,
      resolveRowEffort,
      rowContextWindows,
      rowEfforts,
    ],
  );

  /**
   * Move the arrows to the other column, if that would actually change which
   * column they drive.
   *
   * The guard matters because the switch is otherwise invisible: pressing Space
   * on a row with only one adjustable column does nothing on screen but still
   * flips the state, so the *next* two-column row the user scrolls to would
   * come up driving a different column than the one they last saw.
   */
  const toggleFocusedColumn = useCallback(
    (model: ModelEntry | undefined): boolean => {
      if (!model) return true;
      const efforts = rowEfforts(model);
      const windows = rowContextWindows(model);
      if (efforts.length === 0 || windows.length === 0) return true;
      const next = focusedColumnRef.current === 'effort' ? 'context' : 'effort';
      focusedColumnRef.current = next;
      setFocusedColumn(next);
      return true;
    },
    [rowContextWindows, rowEfforts],
  );

  /**
   * Drop draft fields that the current local configuration no longer supports or that now
   * match the row's baseline, and whole drafts for models that disappeared or
   * became unavailable. Otherwise an edit made before a background refresh
   * could be written back as a value `setModelPreference` rejects, or saved for
   * a model the user can no longer pick.
   */
  useEffect(() => {
    const prev = rowDraftsRef.current;
    const keys = Object.keys(prev);
    if (keys.length === 0) return;
    let changed = false;
    const next: RowDrafts = {};
    for (const key of keys) {
      const model = selectableModels.find((m) => m.key === key);
      if (!model || model.enable === false) {
        changed = true;
        continue;
      }
      const draft = prev[key];
      const effort =
        draft.effort !== undefined &&
        rowEfforts(model).includes(draft.effort) &&
        draft.effort !== resolveBaselineEffort(model)
          ? draft.effort
          : undefined;
      const contextWindow =
        draft.contextWindow !== undefined &&
        rowContextWindows(model).includes(draft.contextWindow) &&
        draft.contextWindow !== resolveBaselineContextWindow(model)
          ? draft.contextWindow
          : undefined;
      if (effort !== draft.effort || contextWindow !== draft.contextWindow) {
        changed = true;
      }
      if (effort === undefined && contextWindow === undefined) continue;
      next[key] = {
        ...(effort !== undefined ? { effort } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      };
    }
    if (changed) commitRowDrafts(next);
  }, [
    commitRowDrafts,
    selectableModels,
    resolveBaselineContextWindow,
    resolveBaselineEffort,
    rowContextWindows,
    rowEfforts,
  ]);

  const getFocusedModelSettingsHint = useCallback(
    (model: ModelEntry): FocusedModelSettingsHint | undefined => {
      const isCurrentModel = modelMatchesCurrentModel(model, currentModel);
      const segments: FocusedSettingsSegment[] = [];

      // Leads the line: it is the one segment that changes while the user
      // works, and the line truncates from the end. It also stands on its own —
      // a row whose effort and context both sit in the columns often has
      // nothing else to report.
      if (changedModelCount > 0) {
        segments.push({
          icon: figures.modified,
          iconColor: theme.status.warning,
          label: getUiText('models.inline.changedCount', {
            count: changedModelCount,
          }),
        });
      }

      if (model.context_window_is_estimate)
        segments.push({
          icon: figures.contextWindow,
          label: getUiText('models.local.budgetValue', {
            value: formatContextWindowValueLabel(model.max_input_tokens),
          }),
        });
      if (model.source === 'custom' && getModelEfforts(model).length === 0)
        segments.push({
          icon: figures.thinkingEffort,
          label: getUiText('models.local.thinkingUnknown'),
        });
      // Effort and the context tier are columns on the row now, so the hint
      // stops repeating them — but only where the row actually shows them. A
      // fixed single-tier model, or the narrow layout that drops the column,
      // still reports the value here rather than losing it.
      const contextAdjustable = rowContextWindows(model).length > 0;
      const contextShownInRow = contextAdjustable && columnLayout !== 'minimal';
      if (!contextShownInRow) {
        // An adjustable row resolves through the draft first. Reading the live
        // prop ahead of it would freeze this line at the model's current value
        // while Space+Right silently moved the draft underneath — and Enter
        // would then apply a tier the user never saw.
        const contextWindow = contextAdjustable
          ? resolveRowContextWindow(model)
          : isCurrentModel && currentContextWindow !== undefined
            ? currentContextWindow
            : (resolveRowContextWindow(model) ??
              getEffectiveDefaultContextWindow(model));
        if (contextWindow !== undefined) {
          segments.push({
            icon: figures.contextWindow,
            label: getUiText('models.options.contextSummary', {
              value: formatContextWindowValueLabel(contextWindow),
            }),
          });
        }
      }

      const efforts = getModelEfforts(model);
      const effortShownInRow = rowEfforts(model).length > 0;
      if (efforts.length > 0 && !effortShownInRow) {
        const effortModel = model as EffortCapableModel;
        let effortValue: string | undefined;
        if (isDisableOnlyEffortToggle(effortModel, efforts)) {
          const explicitDefault =
            effortModel.default_effort ?? effortModel.defaultEffort;
          const disabled =
            (isCurrentModel && currentReasoningEffort === 'none') ||
            explicitDefault === 'none';
          effortValue = disabled
            ? getUiText('models.options.disabled')
            : getUiText('models.options.enabled');
        } else if (
          isCurrentModel &&
          currentReasoningEffort &&
          supportsCurrentReasoningEffort(model, currentReasoningEffort)
        ) {
          effortValue = formatLocalizedEffortLabel(
            currentReasoningEffort,
            getUiText,
          );
        } else {
          const effort = getDefaultReasoningEffort(model);
          if (effort)
            effortValue = formatLocalizedEffortLabel(effort, getUiText);
        }
        if (effortValue !== undefined) {
          segments.push({
            icon: figures.thinkingEffort,
            label: getUiText('models.options.effortSummary', {
              value: effortValue,
            }),
          });
        }
      }

      // Vision is a capability, not a setting, but this is the only place it
      // can report now that it no longer rides in the name column.
      if (model.is_vl) {
        segments.push({
          icon: figures.vision,
          label: getUiText('models.tag.vision'),
        });
      }

      return segments.length > 0 ? segments : undefined;
    },
    [
      changedModelCount,
      columnLayout,
      currentContextWindow,
      currentModel,
      currentReasoningEffort,
      resolveRowContextWindow,
      rowContextWindows,
      rowEfforts,
      getUiText,
    ],
  );

  /**
   * Which keys act on the focused row, named only where they do something.
   *
   * Lives here rather than in the row footer because it belongs in the dialog's
   * shortcut line with the other keys. It has to read `focusedColumn`: the
   * arrows drive whichever column has focus, and a hint that always claimed
   * "effort" went stale the moment Space moved it.
   */
  const getFocusedRowKeyHint = useCallback(
    (model: ModelEntry): string | undefined => {
      // An unavailable model can't be selected, so nothing it drafts matters.
      if (model.enable === false) return undefined;
      const efforts = rowEfforts(model);
      const windows = rowContextWindows(model);
      const activeColumn = resolveActiveColumn(efforts, windows, focusedColumn);
      if (!activeColumn) return undefined;

      const keys = `${figures.arrowLeft}${figures.arrowRight}`;
      const parts = [
        activeColumn === 'effort'
          ? getUiText('models.inline.effortKey', { keys })
          : getUiText('models.inline.contextKeyOnly', { keys }),
      ];
      // Space only has somewhere to go when the row has both columns.
      if (efforts.length > 0 && windows.length > 0) {
        parts.push(
          activeColumn === 'effort'
            ? getUiText('models.inline.contextKey')
            : getUiText('models.inline.effortKeySwitch'),
        );
      }
      return parts.join(' · ');
    },
    [focusedColumn, rowContextWindows, rowEfforts, getUiText],
  );

  /**
   * The one guarded way to apply a model from this dialog. Enter (persist) and
   * `s` (this session only) differ solely in `persist`, so the availability
   * rules can never drift between them.
   *
   * Returns whether the model was applied.
   */
  const applyModel = useCallback(
    (modelKey: string, options?: { persist?: boolean }) => {
      const selectedModel = selectableModels.find(
        (model) => model.key === modelKey,
      );
      if (selectedModel?.enable === false) {
        return false;
      }
      const resolvedKey = selectedModel?.key ?? modelKey;
      // Read the ref: Right and Enter can arrive in one stdin chunk, and Enter
      // must apply the step that came first. An absent draft sends `undefined`,
      // which setModelAndLog reads as "leave the stored preference alone".
      const drafts = rowDraftsRef.current;
      const draft = drafts[resolvedKey];
      const effort = draft?.effort;
      const contextWindow = draft?.contextWindow;
      const selectOptions = buildSelectOptions(drafts, resolvedKey, options);
      // Only pass the options bag when it carries something, so a plain Enter
      // keeps calling onSelect exactly as it always has.
      if (selectOptions) {
        onSelect(resolvedKey, effort, contextWindow, selectOptions);
      } else {
        onSelect(resolvedKey, effort, contextWindow);
      }
      onClose();
      return true;
    },
    [selectableModels, onSelect, onClose],
  );

  const handleItemToggle = useCallback(
    (key: string, _item: SettingsDialogItem) => {
      if (key === ADD_CUSTOM_MODEL_KEY) {
        setPreferredCustomKey(key);
        setCustomWizard(true);
      } else applyModel(key);
    },
    [applyModel],
  );

  /**
   * The model list's bare-letter shortcuts are scoped to the list so printable
   * input continues to belong to the search field while it is open.
   */
  const handleModelListKeyPress = useCallback(
    (key: Key, currentItem: SettingsDialogItem | undefined): boolean => {
      if (
        // A paste arrives as one key whose sequence is the pasted text, so
        // pasting the single letter "s" would otherwise switch models.
        key.name === 'paste'
      ) {
        return false;
      }
      if (canManageCustom && keyMatchers[Command.MODEL_ADD](key)) {
        setPreferredCustomKey(currentItem?.key);
        setCustomWizard(true);
        return true;
      }
      if (
        canManageCustom &&
        currentItem &&
        customProviderModels.some((model) => model.key === currentItem.key) &&
        keyMatchers[Command.MODEL_DELETE](key)
      ) {
        setDeleteItem(currentItem);
        return true;
      }
      if (
        config &&
        customAccessAllowed &&
        currentItem &&
        keyMatchers[Command.MODEL_EDIT](key)
      ) {
        const editable = getLocalModelEdit(config, currentItem.key);
        if (editable) {
          setPreferredCustomKey(currentItem.key);
          setEditModel(editable);
        }
        return true;
      }
      if (key.ctrl || key.alt || key.cmd) return false;
      // Left/Right adjust the focused column of the focused row. They only
      // reach here when the filter is closed: SettingsListPanel consumes them
      // while it is open so they can never leak into tab navigation.
      if (key.name === 'left' || key.name === 'right') {
        if (!currentItem) return true;
        return stepFocusedColumn(currentItem.key, key.name === 'left' ? -1 : 1);
      }
      // Space swaps which column the arrows drive. Printable, so the filter
      // takes it first when open — leaving model names with spaces searchable.
      if (key.name === 'space' || key.sequence === ' ') {
        return toggleFocusedColumn(
          currentItem
            ? selectableModels.find((m) => m.key === currentItem.key)
            : undefined,
        );
      }
      if (
        key.sequence !== 's' ||
        !currentItem ||
        currentItem.key === ADD_CUSTOM_MODEL_KEY
      ) {
        return false;
      }
      return applyModel(currentItem.key, { persist: false });
    },
    [
      config,
      customAccessAllowed,
      canManageCustom,
      customProviderModels,
      keyMatchers,
      applyModel,
      selectableModels,
      stepFocusedColumn,
      toggleFocusedColumn,
    ],
  );

  // Previously, navigation commands were disabled on the Custom tab to avoid
  // conflict with CustomTabContent's own keymap. Now that child components
  // register their own Dialog context action handlers (which take priority
  // over BTD's fallback), this is no longer needed — BTD no longer registers
  // navigation up/down/confirm handlers at all.

  const activeTabHasModels = selectableModels.length > 0;

  // Empty lists still render the panel so the add action remains available.
  const renderModelListPanel = (modelList: ModelEntry[]) => {
    const grouped = false;
    const groupFor = (_model: ModelEntry) => i18n.get('models.local.local');
    const groupCounts = new Map<string, number>();
    if (grouped) {
      for (const model of modelList) {
        const group = groupFor(model);
        groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
      }
    }
    const registryModelsByKey = new Map(
      (config?.getCustomProviderRegistry().getPublicModels() ?? []).map(
        (model) => [model.key, model] as const,
      ),
    );
    const modelIdOf = (model: ModelEntry): string => {
      const registryModel = registryModelsByKey.get(model.key);
      if (registryModel) return registryModel.modelId;
      if (model.source === QODER_PROVIDER_ID) return model.key;
      const separator = model.key.indexOf('/');
      return separator > 0 ? model.key.slice(separator + 1) : model.key;
    };
    const protocolOf = (model: ModelEntry): string => {
      if (model.source === QODER_PROVIDER_ID) return 'Qoder';
      if (model.source === QWEN_SUBSCRIPTION_PROVIDER_ID)
        return 'qwen-subscription';
      const adapter = registryModelsByKey.get(model.key)?.adapter;
      if (adapter === 'openai-responses') return 'openai-responses';
      if (adapter === 'anthropic-compatible') return 'anthropic';
      if (adapter === 'gemini') return 'gemini';
      return 'openai';
    };
    const providerLabelOf = (model: ModelEntry): string | undefined => {
      if (
        model.source === QODER_PROVIDER_ID ||
        model.source === QWEN_SUBSCRIPTION_PROVIDER_ID
      ) {
        return undefined;
      }
      const descriptor = registryModelsByKey.get(model.key);
      const providerId =
        descriptor?.providerId ??
        (model.key.includes('/')
          ? model.key.slice(0, model.key.indexOf('/'))
          : model.source);
      // Manually added custom providers are identified by their generated id;
      // unlike platform presets they do not add a provider tag.
      if (providerId.startsWith('custom-')) return undefined;
      return (
        descriptor?.providerDisplayName ?? model.model_provider ?? model.source
      );
    };
    const modelLabelSegments = (model: ModelEntry): SettingsSuffixSegment[] => {
      const id = modelIdOf(model);
      const provider = providerLabelOf(model);
      const segments: SettingsSuffixSegment[] = [
        {
          text: `[${protocolOf(model)}] `,
          color: theme.text.accent,
          bold: true,
        },
      ];
      if (provider) segments.push({ text: `[${provider}] ` });
      segments.push({ text: model.display_name });
      // Platform presets render `[prefix] id` as the label, so the raw id is
      // shown separately even when the display name equals it. Custom models
      // without a provider tag keep the shorter `id` form.
      if (id !== model.display_name || provider !== undefined) {
        segments.push({ text: ` (${id})`, color: theme.text.secondary });
      }
      if (modelMatchesCurrentModel(model, currentModel)) {
        segments.push({ text: ' ✓' });
      }
      return segments;
    };
    const modelLabel = (model: ModelEntry): string =>
      modelLabelSegments(model)
        .map((segment) => segment.text)
        .join('');

    // Widths are per rendered list, not global. A single custom-provider model
    // carrying a long "(provider)" suffix used to widen the name column on
    // every other tab too, because the old memo scanned all models at once.
    // Plain functions rather than hooks: this runs during render and more than
    // once per pass, so a hook here would break call order.
    const labelWidth = (() => {
      const natural = Math.max(
        MIN_MODEL_LABEL_WIDTH,
        ...modelList.map((model) => measureRowLabelWidth(modelLabel(model))),
      );
      // Nothing else bounds this: SLP's own terminal cap only applies to
      // left-aligned values, and this panel is right-aligned. A provider name
      // is server-controlled and has no length limit, so cap it here and let
      // SLP's overflow:hidden clip the rest.
      const cap = Math.max(
        MIN_MODEL_LABEL_WIDTH,
        Math.floor((stdout?.columns ?? 80) * MODEL_LABEL_WIDTH_RATIO),
      );
      return Math.min(natural, cap);
    })();

    // Sized for the longest label that can actually appear, not a hardcoded
    // guess. The old constant was 8 "for Disabled", but rows never show
    // Disabled — they show effort names, and "Extra High" is 10. Localized:
    // zh-CN levels are one or two CJK characters, so measuring beats guessing.
    const effortLabelWidth = Math.max(
      1,
      ...ORDERED_EFFORT_LEVELS.map((effort) =>
        getCachedStringWidth(formatLocalizedEffortLabel(effort, i18n.get)),
      ),
    );
    // Same treatment for the context tier, so the right caret doesn't slide two
    // columns between a "1M" row and a "200K" row.
    const contextLabelWidth = Math.max(
      1,
      ...modelList.flatMap((model) =>
        rowContextWindows(model).map((value) =>
          getCachedStringWidth(formatContextWindowValueLabel(value)),
        ),
      ),
    );

    /** Cells the whole effort group occupies, carets included. */
    const effortGroupWidth =
      CARET_WIDTH * 2 +
      effortLabelWidth +
      (columnLayout === 'full' ? EFFORT_METER_WIDTH + 1 : 0);

    /**
     * The inline effort / context columns for one row.
     *
     * Multi-segment because only the column the arrows currently drive is
     * highlighted, and a single `suffix` string renders in one color. Widths
     * are padded to a common size so the columns stay flush down the list even
     * though models support different numbers of effort levels.
     */
    const buildColumnSegments = (
      model: ModelEntry,
      isFocused: boolean,
    ): SettingsSuffixSegment[] | undefined => {
      const efforts = rowEfforts(model);
      const windows = rowContextWindows(model);
      if (efforts.length === 0 && windows.length === 0) return undefined;

      const activeColumn = resolveActiveColumn(efforts, windows, focusedColumn);

      const segments: SettingsSuffixSegment[] = [];
      const dim = theme.text.secondary;
      const focus = theme.ui.focus;
      const changedColor = theme.status.warning;
      const draft = visibleDrafts[model.key];

      // One fixed-width slot per row rather than one per column: the narrow
      // layout drops the context column, and a context-only edit still needs a
      // mark. Blank when clean so nothing after it shifts.
      segments.push({
        text: draft ? `${figures.modified} ` : ' '.repeat(MODIFIED_MARK_WIDTH),
        color: changedColor,
      });

      // An unavailable model can't be selected, so a draft on it would never be
      // applied; the search box owns the arrows while it has focus. In both
      // cases the arrows are inert, and a lit caret would be a lie.
      const rowEditable = model.enable !== false && !searchActive;

      const caret = (
        column: 'effort' | 'context',
        side: 'left' | 'right',
        canMove: boolean,
      ): SettingsSuffixSegment => {
        const show = isFocused && activeColumn === column;
        const live = show && canMove;
        const glyph = side === 'left' ? figures.arrowLeft : figures.arrowRight;
        // Always CARET_WIDTH cells, lit or not, so the columns do not shift as
        // focus moves down the list.
        return {
          text:
            side === 'left'
              ? `${show ? glyph : ' '} `
              : ` ${show ? glyph : ' '}`,
          // Greyed at the end of the range, and not bold either — a bold dim
          // arrow still reads as "press me".
          color: live ? focus : dim,
          bold: live,
          dimColor: show && !live,
        };
      };

      if (efforts.length > 0) {
        const effort = resolveRowEffort(model, visibleDrafts);
        const isActive = isFocused && activeColumn === 'effort';
        const changed = draft?.effort !== undefined;
        segments.push(
          caret(
            'effort',
            'left',
            rowEditable && stepValue(efforts, effort, -1) !== undefined,
          ),
        );
        if (columnLayout === 'full') {
          segments.push({
            text: formatEffortMeter(efforts, effort, EFFORT_METER_WIDTH),
            color: changed ? changedColor : isActive ? focus : dim,
          });
          segments.push({ text: ' ', color: dim });
        }
        segments.push({
          text: padRight(
            effort ? formatLocalizedEffortLabel(effort, i18n.get) : '',
            effortLabelWidth,
          ),
          color: changed ? changedColor : isActive ? focus : dim,
          bold: isActive,
        });
        segments.push(
          caret(
            'effort',
            'right',
            rowEditable && stepValue(efforts, effort, 1) !== undefined,
          ),
        );
      } else {
        // Keep the columns aligned for rows with no adjustable effort. Derived
        // from the same parts the branch above renders, so the two can't drift.
        segments.push({ text: ' '.repeat(effortGroupWidth) });
      }

      if (columnLayout === 'full' || columnLayout === 'compact') {
        if (windows.length > 0) {
          const contextWindow = resolveRowContextWindow(model, visibleDrafts);
          const isActive = isFocused && activeColumn === 'context';
          const changed = draft?.contextWindow !== undefined;
          segments.push({ text: ' ' });
          segments.push(
            caret(
              'context',
              'left',
              rowEditable &&
                stepValue(windows, contextWindow, -1) !== undefined,
            ),
          );
          segments.push({
            text: `${figures.contextWindow} ${padRight(
              contextWindow === undefined
                ? ''
                : formatContextWindowValueLabel(contextWindow),
              contextLabelWidth,
            )}`,
            color: changed ? changedColor : isActive ? focus : dim,
            bold: isActive,
          });
          segments.push(
            caret(
              'context',
              'right',
              rowEditable && stepValue(windows, contextWindow, 1) !== undefined,
            ),
          );
        }
      }

      return segments;
    };

    const panelItems: SettingsDialogItem[] = modelList.map((model) => {
      const unavailable = model.enable === false;
      const currentModelColor = theme.ui.selection ?? theme.status.success;
      // The active model always carries a check mark after its name, shown
      // regardless of which row currently has keyboard focus (the `❯` pointer
      // is a separate, focus-driven indicator rendered by SettingsListPanel).
      const isCurrentModel = modelMatchesCurrentModel(model, currentModel);

      return {
        key: model.key,
        label: modelLabel(model),
        labelSegments: modelLabelSegments(model),
        labelGradient: isCurrentModel ? theme.ui.selectionGradient : undefined,
        groupLabel: grouped
          ? `${groupFor(model)} (${groupCounts.get(groupFor(model))})`
          : undefined,
        labelColor: isCurrentModel
          ? currentModelColor
          : unavailable
            ? theme.text.secondary
            : undefined,
        type: 'enum' as const,
        suffixSegments: buildColumnSegments(model, false),
        focusedSuffixSegments: buildColumnSegments(model, true),
        displayValue:
          grouped && model.source === 'custom'
            ? (() => {
                const adapter = config
                  ?.getCustomProviderRegistry()
                  .getPublicModels()
                  .find((entry) => entry.key === model.key)?.adapter;
                return adapter === 'openai-responses'
                  ? 'Responses'
                  : adapter === 'anthropic-compatible'
                    ? 'Anthropic'
                    : adapter === 'gemini'
                      ? 'Gemini'
                      : 'Chat';
              })()
            : '',
        highlightValueOnFocus: false,
        isGreyedOut: unavailable,
      };
    });

    if (canManageCustom)
      panelItems.unshift({
        key: ADD_CUSTOM_MODEL_KEY,
        label: i18n.get('models.local.add'),
        displayValue: '',
        type: 'enum',
      });

    return (
      <Box flexDirection="column">
        <SettingsListPanel
          selectionColor={theme.ui.selection ?? theme.status.success}
          selectionGradient={theme.ui.selectionGradient}
          searchEnabled={true}
          searchTrigger="slash"
          onSearchStateChange={setSearchState}
          emptyMessage={i18n.get('models.noneInGroup')}
          onKeyPress={handleModelListKeyPress}
          onActiveKeyChange={setFocusedModelKey}
          searchPlaceholder={
            searchActive
              ? i18n.get('models.search')
              : i18n.get('models.searchHint')
          }
          searchResetKey="models"
          items={panelItems}
          filterFn={(item, query) => {
            const model = modelList.find((entry) => entry.key === item.key);
            const provider = config
              ?.getCustomProviderRegistry()
              .getPublicModels()
              .find((entry) => entry.key === item.key);
            const settingsProvider =
              providerSettings?.[model?.model_provider ?? ''];
            return [
              item.label,
              item.displayValue,
              item.key,
              model?.model_provider,
              provider?.providerDisplayName,
              provider?.modelId,
              settingsProvider?.displayName,
              settingsProvider?.baseUrl,
            ].some((value) =>
              value?.toLowerCase().includes(query.toLowerCase()),
            );
          }}
          pinnedItemKey={canManageCustom ? ADD_CUSTOM_MODEL_KEY : undefined}
          maxItemsToShow={10}
          labelWidth={labelWidth}
          onItemToggle={handleItemToggle}
          onEditCommit={noopEditCommit}
          onItemClear={noopItemClear}
          onClose={onClose}
          initialActiveKey={
            preferredCustomKey ??
            resolveCurrentModelKey(modelList, currentModel) ??
            currentModel
          }
          itemHeight={1}
          footer={{
            height: 2,
            content: (focusedItem) => {
              const focusedModel = modelList.find(
                (model) => model.key === focusedItem?.key,
              );
              const focusedHint = focusedModel
                ? getFocusedModelSettingsHint(focusedModel)
                : undefined;
              // Truncate rather than wrap: the footer reserves a fixed number
              // of rows and clips the overflow.
              const settingsLine = focusedHint ? (
                <Box paddingLeft={1}>
                  <Text wrap="truncate-end">
                    {focusedHint.map((segment, index) => (
                      <Text key={segment.label}>
                        {index > 0 ? (
                          <Text color={theme.text.secondary}>{'  '}</Text>
                        ) : null}
                        <SelectionText
                          color={
                            segment.iconColor ??
                            theme.ui.selection ??
                            theme.status.success
                          }
                        >
                          {segment.icon}{' '}
                        </SelectionText>
                        <Text color={theme.text.primary}>{segment.label}</Text>
                      </Text>
                    ))}
                  </Text>
                </Box>
              ) : null;
              if (focusedModel?.enable === false) {
                // Unavailable models can't be selected, but their capabilities
                // still belong in this footer.
                return (
                  <Box flexDirection="column">
                    <Box paddingLeft={1}>
                      <Text color={theme.text.secondary}>
                        ⚠ {i18n.get('models.unavailable')}
                      </Text>
                    </Box>
                    {settingsLine}
                  </Box>
                );
              }
              if (!settingsLine) return null;
              return (
                <Box flexDirection="column">
                  <Box height={1} />
                  {/* paddingLeft 1 aligns the icon with the list's `❯`
                      pointer column (1 leading space + pointer). */}
                  {settingsLine}
                </Box>
              );
            },
          }}
        />
      </Box>
    );
  };

  // Row-edit hints are hidden while an add/delete subdialog owns the keys.
  const focusedRowKeyHint =
    localEditorOpen || deleteItem || !focusedModelKey
      ? undefined
      : (() => {
          const model = selectableModels.find((m) => m.key === focusedModelKey);
          return model ? getFocusedRowKeyHint(model) : undefined;
        })();

  const editableFocused =
    config &&
    customAccessAllowed &&
    focusedModelKey &&
    getLocalModelEdit(config, focusedModelKey);
  const deletableFocused =
    canManageCustom &&
    customProviderModels.some((model) => model.key === focusedModelKey);
  return (
    <BaseTabDialog
      title={i18n.get('models.title')}
      isActive={!localEditorOpen && !deleteItem}
      onClose={onClose}
      footer={
        deleteItem
          ? formatLocalizedShortcutHint(
              i18n.get,
              'NAVIGATE',
              'SELECT',
              'GO_BACK',
            )
          : localEditorOpen
            ? undefined
            : searchActive
              ? // While the filter has focus: Enter and the arrows hand focus
                // back rather than selecting, Esc cancels the filter rather than
                // closing, `s` is a plain character, and ←→ move the cursor
                // instead of switching tabs.
                formatLocalizedShortcutHint(
                  i18n.get,
                  'ENTER_TO_LIST',
                  'ESC_CANCEL_SEARCH',
                )
              : // Row keys are spliced into the same dynamic list rather than
                // replacing it, so empty-group and active-filter branches above
                // keep working.
                [
                  // An empty group has nothing to select or apply.
                  ...(activeTabHasModels
                    ? [
                        hasChanges
                          ? i18n.get('models.inline.selectAndSave')
                          : formatLocalizedShortcutHint(i18n.get, 'SELECT'),
                        formatLocalizedShortcutHint(i18n.get, 'S_SESSION_ONLY'),
                      ]
                    : []),
                  focusedRowKeyHint,
                  editableFocused
                    ? i18n.get('models.local.editHint', {
                        edit: formatCommand(
                          Command.MODEL_EDIT,
                          keyBindingConfig,
                        ).toLowerCase(),
                      })
                    : undefined,
                  canManageCustom
                    ? i18n.get('models.local.addHint', {
                        add: formatCommand(
                          Command.MODEL_ADD,
                          keyBindingConfig,
                        ).toLowerCase(),
                      })
                    : undefined,
                  deletableFocused
                    ? i18n.get('models.local.deleteHint', {
                        delete: formatCommand(
                          Command.MODEL_DELETE,
                          keyBindingConfig,
                        ).toLowerCase(),
                      })
                    : undefined,
                  formatLocalizedShortcutHint(
                    i18n.get,
                    ...(searchState.hasQuery ? (['SEARCH'] as const) : []),
                    hasChanges ? 'CANCEL' : 'GO_BACK',
                  ),
                ]
                  .filter(Boolean)
                  .join(' · ')
      }
      defaultHintLabels={{
        // The Custom tab builds its hints from these labels, and Esc discards
        // pending edits from every tab.
        goBack: hasChanges
          ? i18n.get('shortcut.cancel')
          : i18n.get('shortcut.back'),
        tabSwitch: i18n.get('shortcut.tabOnlySwitch'),
      }}
      // The model list drives the focused row's effort / context with the
      // arrows, so they can no longer double as tab navigation. Tab and
      // Shift+Tab still switch tabs.
      arrowTabNavigation={false}
      // The shortcut line grows and shrinks with the focused row, and it wraps
      // rather than truncating — so without a reserved floor the whole dialog
      // would gain and lose a row on every Up/Down. Two rows unconditionally:
      // the widest variant (with `/ search` appended) reaches 104 columns, so
      // gating this on terminal width just moves the jitter to another band.
      footerMinHeight={2}
      equalizeTabHeight
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text color={theme.text.primary} bold>
          {i18n.get('models.overview.title')}
        </Text>
        <Box paddingLeft={1}>
          <Text color={theme.text.secondary}>
            {i18n.get('models.overview.current')}
            <Text color={theme.text.primary}>{currentModelDisplay}</Text>
          </Text>
        </Box>
      </Box>
      {deleteItem && canManageCustom ? (
        <CustomModelDeleteDialog
          config={config}
          modelKey={deleteItem.key}
          isLocalProvider={customProviderModels.some(
            (model) => model.key === deleteItem.key,
          )}
          name={deleteItem.label}
          currentModel={
            resolveCurrentModelKey(selectableModels, currentModel) ??
            currentModel
          }
          onDeleteLegacy={() => {}}
          onDeleted={() => {
            setDeleteItem(undefined);
            refreshModelList();
          }}
          onClose={() => setDeleteItem(undefined)}
        />
      ) : editModel && config ? (
        <LocalCustomModelForm
          config={config}
          protocol={editModel.protocol}
          edit={editModel}
          onClose={() => setEditModel(undefined)}
          onSaved={(modelKey) => {
            setEditModel(undefined);
            setPreferredCustomKey(modelKey);
            refreshModelList();
          }}
        />
      ) : customWizard && canManageCustom ? (
        <CustomModelWizard
          config={config}
          onSaved={(modelKey) => {
            setCustomWizard(false);
            setPreferredCustomKey(modelKey);
            refreshModelList();
          }}
          onClose={() => setCustomWizard(false)}
        />
      ) : (
        renderModelListPanel(selectableModels)
      )}
    </BaseTabDialog>
  );
}
