/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { useReducer, useRef } from 'react';
import { Box, Text } from 'ink';
import {
  CUSTOM_MODEL_PROVIDER_CONFIG_ERROR,
  CustomModelProviderConfigError,
  DEFAULT_CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS,
  type Config,
  type CustomModelProviderProtocol,
  type CustomProviderModelEdit,
} from '@qwen-code/core';
import {
  createLocalProviderFromTui,
  updateLocalModelFromTui,
} from '../../utils/localCustomModels.js';
import type { CustomProviderModelSetting } from '../../../config/settingsSchema.js';
import { RadioButtonSelect } from './RadioButtonSelect.js';
import { InputField } from './InputField.js';
import { useSearchBuffer } from '../../hooks/useSearchBuffer.js';
import { useRegisterHints } from '../../contexts/HintRegistryContext.js';
import { useI18nService } from '../../i18n/index.js';
import { theme } from '../../semantic-colors.js';

type Field =
  | 'baseUrl'
  | 'model'
  | 'displayName'
  | 'apiKey'
  | 'contextWindow'
  | 'maxOutputTokens';
type Page =
  | 'form'
  | 'input'
  | 'capabilities'
  | 'thinking'
  | 'modes'
  | 'levels'
  | 'review'
  | 'budget';
type Thinking = NonNullable<
  NonNullable<CustomProviderModelSetting['capabilities']>['thinking']
>;
type Level = NonNullable<Thinking['supportedEffortLevels']>[number];
const levels: Level[] = ['low', 'medium', 'high', 'xhigh', 'max'];
interface State {
  page: Page;
  field: Field;
  focus: number;
  selections: Partial<Record<Page, string>>;
  baseUrl: string;
  apiKey: string;
  model: CustomProviderModelSetting;
  error?: string;
  saving: boolean;
}
type Action =
  | { type: 'remember'; page: Page; key: string }
  | { type: 'patch'; patch: Partial<State> }
  | { type: 'model'; patch: Partial<CustomProviderModelSetting> };
function reducer(state: State, action: Action): State {
  if (action.type === 'remember')
    return {
      ...state,
      selections: { ...state.selections, [action.page]: action.key },
    };
  return action.type === 'patch'
    ? { ...state, ...action.patch }
    : {
        ...state,
        model: { ...state.model, ...action.patch },
        error: undefined,
      };
}
export function LocalCustomModelForm({
  config,
  protocol,
  edit,
  onClose,
  onSaved,
  providerIdPrefix = 'custom',
}: {
  config: Config;
  protocol: CustomModelProviderProtocol;
  edit?: CustomProviderModelEdit;
  onClose: () => void;
  onSaved: (key?: string, applied?: boolean) => void;
  /** Product namespace for generated provider IDs. */
  providerIdPrefix?: string;
}) {
  const i18n = useI18nService();
  const [state, dispatch] = useReducer(reducer, {
    page: 'form',
    field: 'baseUrl',
    focus: 0,
    selections: {},
    baseUrl: edit?.baseUrl ?? '',
    apiKey: '',
    model: edit?.model ?? {
      model: '',
      maxOutputTokens: DEFAULT_CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS,
    },
    saving: false,
  });
  const providerId = useRef(
    edit?.providerId ?? `${providerIdPrefix}-${randomUUID()}`,
  );
  const saving = useRef(false);
  const patch = (patch: Partial<State>) => dispatch({ type: 'patch', patch });
  const modelPatch = (patch: Partial<CustomProviderModelSetting>) =>
    dispatch({ type: 'model', patch });
  const go = (page: Page) => patch({ page, error: undefined, focus: 0 });
  const thinking = state.model.capabilities?.thinking;
  const setThinking = (value: Thinking) =>
    modelPatch({
      capabilities: { ...state.model.capabilities, thinking: value },
    });
  const api =
    protocol === 'anthropic'
      ? 'Anthropic · Messages'
      : protocol === 'gemini'
        ? 'Google · Gemini'
        : protocol === 'openai-responses'
          ? 'OpenAI · Responses'
          : 'OpenAI · Chat Completions';
  const context = state.model.contextWindow
    ? `${state.model.contextWindow.toLocaleString('en-US')} tokens`
    : i18n.get('models.local.defaultBudget');
  const thinkingLabel = !thinking?.modes.length
    ? '—'
    : thinking.supportedEffortLevels?.length
      ? thinking.supportedEffortLevels.join(' / ')
      : i18n.get('models.local.configured');
  const labels: Record<Field, string> = {
    baseUrl: 'Base URL',
    model: 'Model ID',
    displayName: i18n.get('models.local.reviewName'),
    apiKey: 'API Key',
    contextWindow: i18n.get('models.local.contextCapacity'),
    maxOutputTokens: i18n.get('models.local.maxOutput'),
  };
  useRegisterHints('LocalCustomModelForm', [
    {
      label: i18n.get(
        state.page === 'review' || state.page === 'budget'
          ? 'models.local.reviewKeys'
          : 'models.local.formKeys',
      ),
      order: 20,
    },
  ]);
  const beginField = (field: Field, focus: number) =>
    patch({ page: 'input', field, focus, error: undefined });
  const save = async () => {
    if (saving.current) return;
    saving.current = true;
    patch({ saving: true, error: undefined });
    try {
      const savedModel = {
        ...state.model,
        displayName: state.model.displayName || state.model.model,
      };
      const result = edit
        ? await updateLocalModelFromTui(config, edit, {
            baseUrl: state.baseUrl,
            ...(state.apiKey ? { apiKey: state.apiKey } : {}),
            model: savedModel,
          })
        : await createLocalProviderFromTui(config, {
            providerId: providerId.current,
            type: 'openai-compatible',
            protocol,
            authType:
              protocol === 'anthropic'
                ? 'api-key'
                : protocol === 'gemini'
                  ? 'google-api-key'
                  : 'bearer',
            baseUrl: state.baseUrl,
            apiKey: state.apiKey,
            model: state.model.model,
            displayName: state.model.displayName || state.model.model,
            models: [savedModel],
          });
      onSaved(result.modelKey, result.applied);
    } catch (error) {
      // Surface the real reason when the save gate rejects the account;
      // every other failure keeps the generic retry hint.
      patch({
        error:
          error instanceof CustomModelProviderConfigError &&
          error.code === CUSTOM_MODEL_PROVIDER_CONFIG_ERROR.accessDenied
            ? i18n.get('models.local.accessDenied')
            : i18n.get('models.local.saveFailed'),
      });
    } finally {
      saving.current = false;
      patch({ saving: false });
    }
  };
  const review = () => {
    try {
      // Existing environment references stay intact unless the URL was changed.
      if (!edit || state.baseUrl !== edit.baseUrl) {
        const url = new URL(state.baseUrl);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error();
      }
    } catch {
      patch({ error: i18n.get('models.local.invalidUrl') });
      return;
    }
    if (!state.model.model.trim()) {
      patch({ error: i18n.get('models.local.modelRequired') });
      return;
    }
    if (
      protocol === 'anthropic' &&
      thinking?.supportedEffortLevels?.length &&
      !thinking.modes.length
    ) {
      patch({ error: i18n.get('models.local.thinkingIncomplete') });
      return;
    }
    go('review');
  };
  const menu = (
    items: Array<{
      key: string;
      label: string;
      sublabel?: string;
      valueText?: string;
      run: () => void;
    }>,
    back: () => void,
    initialIndex = 0,
  ) => (
    <RadioButtonSelect
      key={`${state.page}:${state.focus}`}
      showNumbers={false}
      enableNumericSelection={false}
      maxItemsToShow={10}
      renderItem={(item, { titleColor }) => {
        const row = items.find((entry) => entry.key === item.key)!;
        return (
          <Box
            marginBottom={
              ['capabilities', 'review', 'done'].includes(
                items[items.findIndex((entry) => entry.key === item.key) + 1]
                  ?.key,
              )
                ? 1
                : 0
            }
            flexDirection="column"
          >
            <Box>
              <Box
                width={row.valueText === undefined ? undefined : 20}
                flexShrink={0}
              >
                <Text color={titleColor}>{item.label}</Text>
              </Box>
              {row.valueText !== undefined && (
                <Text color={theme.text.secondary}>{row.valueText}</Text>
              )}
            </Box>
            {row.sublabel && (
              <Text color={theme.text.secondary}>{row.sublabel}</Text>
            )}
          </Box>
        );
      }}
      initialIndex={Math.max(
        0,
        state.selections[state.page]
          ? items.findIndex((item) => item.key === state.selections[state.page])
          : initialIndex,
      )}
      isFocused={!state.saving}
      items={items.map((item) => ({ ...item, value: item.key }))}
      onHighlight={(highlighted) => {
        dispatch({ type: 'remember', page: state.page, key: highlighted });
      }}
      onCancel={back}
      onSelect={(key) => {
        dispatch({ type: 'remember', page: state.page, key });
        items.find((item) => item.key === key)?.run();
      }}
    />
  );
  const fieldRow = (field: Field, value: string, index: number) => ({
    key: field,
    label: `${labels[field]}${field === 'baseUrl' || field === 'model' ? ' *' : ''}`,
    valueText: value || '—',
    run: () => beginField(field, index),
  });
  return (
    <Box flexDirection="column">
      <Text bold>
        {i18n.get(
          state.page === 'review' || state.page === 'budget'
            ? 'models.local.reviewTitle'
            : ['thinking', 'modes', 'levels'].includes(state.page)
              ? 'models.local.thinkingControls'
              : state.page === 'capabilities'
                ? 'models.local.capabilitiesTitle'
                : edit
                  ? 'models.local.editTitle'
                  : 'models.local.addTitle',
        )}
      </Text>
      {state.page !== 'review' && state.page !== 'budget' && (
        <Text color={theme.text.secondary}>{api}</Text>
      )}
      {state.error && <Text color={theme.status.error}>{state.error}</Text>}
      <Box marginTop={1} flexDirection="column">
        {state.page === 'form' && (
          <>
            {edit && (
              <Text color={theme.text.secondary}>
                {i18n.get('models.local.identityFixed', {
                  model: state.model.model,
                })}
              </Text>
            )}
            {menu(
              [
                fieldRow('baseUrl', state.baseUrl, 0),
                ...(!edit ? [fieldRow('model', state.model.model, 1)] : []),
                fieldRow(
                  'displayName',
                  state.model.displayName ?? '',
                  edit ? 1 : 2,
                ),
                fieldRow(
                  'apiKey',
                  state.apiKey || edit?.hasApiKey ? '••••••••' : '',
                  edit ? 2 : 3,
                ),
                {
                  key: 'capabilities',
                  label: i18n.get('models.local.capabilities'),

                  run: () => go('capabilities'),
                },
                {
                  key: 'review',
                  label: i18n.get('models.local.reviewAction'),
                  run: review,
                },
              ],
              onClose,
              state.focus,
            )}
          </>
        )}
        {state.page === 'form' && (
          <Text color={theme.text.secondary}>
            {i18n.get('models.local.requiredHint')}
          </Text>
        )}
        {state.page === 'input' && (
          <>
            <Text>{labels[state.field]}</Text>
            {state.field === 'displayName' && (
              <Text color={theme.text.secondary}>
                {i18n.get('models.local.nameHint')}
              </Text>
            )}
            {state.field === 'maxOutputTokens' && (
              <Text color={theme.text.secondary}>
                {i18n.get('models.local.outputHelp')}
              </Text>
            )}
            {state.field === 'apiKey' && (
              <Text color={theme.text.secondary}>
                {i18n.get(
                  edit ? 'models.local.keepKey' : 'models.local.keyHint',
                )}
              </Text>
            )}
            {state.field === 'contextWindow' && (
              <Text color={theme.text.secondary}>
                {i18n.get('models.local.contextHelp')}
              </Text>
            )}
            <LocalTextInput
              key={state.field}
              value={
                state.field === 'baseUrl'
                  ? state.baseUrl
                  : state.field === 'apiKey'
                    ? state.apiKey
                    : String(state.model[state.field] ?? '')
              }
              onCancel={() =>
                go(
                  state.field === 'contextWindow' ||
                    state.field === 'maxOutputTokens'
                    ? 'capabilities'
                    : 'form',
                )
              }
              onSubmit={(value) => {
                if (
                  state.field === 'contextWindow' ||
                  state.field === 'maxOutputTokens'
                ) {
                  const parsed = value.trim() ? Number(value) : undefined;
                  if (
                    (parsed !== undefined &&
                      (!/^\d+$/.test(value.trim()) ||
                        !Number.isSafeInteger(parsed) ||
                        parsed <= 0)) ||
                    (state.field === 'maxOutputTokens' && parsed === undefined)
                  ) {
                    patch({ error: i18n.get('models.local.positiveTokens') });
                    return;
                  }
                  modelPatch({ [state.field]: parsed });
                  go('capabilities');
                } else {
                  if (state.field === 'baseUrl' || state.field === 'apiKey')
                    patch({
                      [state.field]:
                        state.field === 'apiKey' ? value : value.trim(),
                    });
                  else modelPatch({ [state.field]: value.trim() });
                  dispatch({
                    type: 'remember',
                    page: 'form',
                    key:
                      state.field === 'baseUrl'
                        ? edit
                          ? 'displayName'
                          : 'model'
                        : state.field === 'model'
                          ? 'displayName'
                          : state.field === 'displayName'
                            ? 'apiKey'
                            : 'capabilities',
                  });
                  patch({
                    page: 'form',
                    focus: state.focus + 1,
                    error: undefined,
                  });
                }
              }}
            />
          </>
        )}
        {state.page === 'capabilities' && (
          <>
            {menu(
              [
                fieldRow(
                  'contextWindow',
                  state.model.contextWindow
                    ? state.model.contextWindow.toLocaleString('en-US')
                    : '',
                  0,
                ),
                fieldRow(
                  'maxOutputTokens',
                  (
                    state.model.maxOutputTokens ??
                    DEFAULT_CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS
                  ).toLocaleString('en-US'),
                  1,
                ),
                {
                  key: 'vision',
                  label: 'Vision',
                  valueText: state.model.capabilities?.vision ? 'On' : 'Off',
                  run: () =>
                    modelPatch({
                      capabilities: {
                        ...state.model.capabilities,
                        vision: !state.model.capabilities?.vision,
                      },
                    }),
                },
                {
                  key: 'thinking',
                  label: i18n.get('models.local.thinkingControls'),
                  valueText: thinkingLabel,
                  run: () => go('thinking'),
                },
                {
                  key: 'done',
                  label: i18n.get('models.local.done'),
                  run: () => go('form'),
                },
              ],
              () => go('form'),
            )}
          </>
        )}
        {state.page === 'capabilities' && (
          <Text color={theme.text.secondary}>
            {i18n.get(
              state.selections[state.page] === 'vision'
                ? 'models.local.visionHelp'
                : state.selections[state.page] === 'thinking'
                  ? 'models.local.controlsHelp'
                  : state.selections[state.page] === 'maxOutputTokens'
                    ? 'models.local.outputHelp'
                    : 'models.local.contextHelp',
            )}
          </Text>
        )}
        {state.page === 'thinking' &&
          menu(
            [
              ...(protocol === 'anthropic'
                ? [
                    {
                      key: 'modes',
                      label: i18n.get('models.local.supportedModes'),
                      valueText: thinking?.modes.join(' / ') || '—',
                      run: () => go('modes'),
                    },
                  ]
                : []),
              {
                key: 'levels',
                label: i18n.get('models.local.effortLevels'),
                valueText: thinking?.supportedEffortLevels?.join(' / ') || '—',
                run: () => go('levels'),
              },
              {
                key: 'done',
                label: i18n.get('models.local.done'),
                run: () => go('capabilities'),
              },
            ],
            () => go('capabilities'),
          )}
        {state.page === 'modes' && (
          <>
            <Text color={theme.text.secondary}>
              {i18n.get('models.local.modesHelp')}
            </Text>
            {menu(
              [
                ...(['adaptive', 'enabled'] as const).map((mode) => ({
                  key: mode,
                  label: `${thinking?.modes.includes(mode) ? '[x]' : '[ ]'} ${mode}`,
                  run: () => {
                    const modes = thinking?.modes.includes(mode)
                      ? thinking.modes.filter((v) => v !== mode)
                      : [...(thinking?.modes ?? []), mode];
                    setThinking({
                      ...thinking,
                      modes,
                      requiresBudgetForEnabled: modes.includes('enabled')
                        ? thinking?.requiresBudgetForEnabled
                        : undefined,
                      preferredMode:
                        thinking?.preferredMode &&
                        modes.includes(thinking.preferredMode)
                          ? thinking?.preferredMode
                          : undefined,
                    });
                  },
                })),
                ...(thinking?.modes.includes('enabled')
                  ? [
                      {
                        key: 'budgetRequired',
                        label: i18n.get('models.local.budgetRequired'),
                        valueText:
                          thinking.requiresBudgetForEnabled === false
                            ? 'No'
                            : 'Yes',
                        run: () =>
                          setThinking({
                            ...thinking,
                            requiresBudgetForEnabled:
                              thinking.requiresBudgetForEnabled === false,
                          }),
                      },
                    ]
                  : []),
                ...(thinking?.modes.length === 2
                  ? [
                      {
                        key: 'preferred',
                        label: i18n.get('models.local.preferredMode'),
                        valueText: thinking.preferredMode ?? '—',
                        run: () =>
                          setThinking({
                            ...thinking,
                            preferredMode:
                              thinking.preferredMode === undefined
                                ? 'adaptive'
                                : thinking.preferredMode === 'adaptive'
                                  ? 'enabled'
                                  : undefined,
                          }),
                      },
                    ]
                  : []),
                {
                  key: 'done',
                  label: i18n.get('models.local.done'),
                  run: () => go('thinking'),
                },
              ],
              () => go('thinking'),
            )}
          </>
        )}
        {state.page === 'levels' && (
          <>
            <Text color={theme.text.secondary}>
              {i18n.get('models.local.levelsHelp')}
            </Text>
            {menu(
              [
                ...levels.map((level) => ({
                  key: level,
                  label: `${thinking?.supportedEffortLevels?.includes(level) ? '[x]' : '[ ]'} ${level}`,
                  run: () => {
                    const selected = thinking?.supportedEffortLevels ?? [];
                    setThinking({
                      ...thinking,
                      modes: thinking?.modes.length
                        ? thinking.modes
                        : protocol === 'anthropic'
                          ? []
                          : ['enabled'],
                      requiresBudgetForEnabled: (
                        thinking?.modes.length
                          ? thinking.modes.includes('enabled')
                          : protocol !== 'anthropic'
                      )
                        ? (thinking?.requiresBudgetForEnabled ?? false)
                        : undefined,
                      supportsEffort: !(
                        selected.includes(level) && selected.length === 1
                      ),
                      supportedEffortLevels: selected.includes(level)
                        ? selected.filter((value) => value !== level)
                        : levels.filter(
                            (value) =>
                              value === level || selected.includes(value),
                          ),
                    });
                  },
                })),
                {
                  key: 'done',
                  label: i18n.get('models.local.done'),
                  run: () => go('thinking'),
                },
              ],
              () => go('thinking'),
            )}
          </>
        )}
        {(state.page === 'review' || state.page === 'budget') && (
          <>
            <Box flexDirection="column" marginLeft={2} marginY={1}>
              {state.model.displayName && (
                <Summary
                  label={i18n.get('models.local.reviewName')}
                  value={state.model.displayName}
                />
              )}
              <Summary label="Model ID" value={state.model.model} />
              <Summary label="API" value={api} />
              <Summary label="Base URL" value={state.baseUrl} />
              <Summary
                label={i18n.get('models.options.context')}
                value={context}
              />
              <Summary
                label={i18n.get('models.local.maxOutput')}
                value={String(
                  state.model.maxOutputTokens ??
                    DEFAULT_CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS,
                )}
              />
              <Summary
                label={i18n.get('models.local.thinkingControls')}
                value={thinkingLabel}
              />
              {protocol === 'anthropic' && (
                <>
                  <Summary
                    label={i18n.get('models.local.supportedModes')}
                    value={thinking?.modes.join(' / ') || '—'}
                  />
                  {thinking?.modes.includes('enabled') && (
                    <Summary
                      label={i18n.get('models.local.budgetRequired')}
                      value={
                        thinking.requiresBudgetForEnabled === false
                          ? 'No'
                          : 'Yes'
                      }
                    />
                  )}
                </>
              )}
              <Summary
                label={i18n.get('models.local.vision')}
                value={i18n.get(
                  state.model.capabilities?.vision
                    ? 'models.local.yes'
                    : 'models.local.no',
                )}
              />
            </Box>
            <Text color={theme.text.secondary}>
              {i18n.get('models.local.saveHint')}
            </Text>
            {state.page === 'budget' && (
              <Text color={theme.status.warning}>
                {i18n.get('models.local.budgetHelp')}
              </Text>
            )}
            {menu(
              [
                {
                  key: 'save',
                  label: state.saving
                    ? i18n.get('models.local.saving')
                    : i18n.get(
                        state.page === 'budget'
                          ? 'models.local.confirmBudget'
                          : 'models.local.save',
                      ),
                  run: () =>
                    state.model.contextWindow || state.page === 'budget'
                      ? void save()
                      : go('budget'),
                },
              ],
              () => go('form'),
            )}
          </>
        )}
      </Box>
    </Box>
  );
}
function LocalTextInput({
  value,
  mask,
  onSubmit,
  onCancel,
}: {
  value: string;
  mask?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const buffer = useSearchBuffer({ initialText: value, onChange: () => {} });
  return (
    <InputField
      buffer={buffer}
      mask={mask ? '*' : undefined}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}
function Summary({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Box width={18} flexShrink={0}>
        <Text color={theme.text.secondary}>{label}</Text>
      </Box>
      <Box flexShrink={1}>
        <Text>{value}</Text>
      </Box>
    </Box>
  );
}
