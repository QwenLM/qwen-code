/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Box, Text, useStdout } from 'ink';
import {
  AuthType,
  QODER_ENV_ACCOUNT_REGION,
  QODER_PROVIDER_ID,
  QWEN_SUBSCRIPTION_PROVIDER_ID,
  QwenSubscriptionOAuthError,
  QwenSubscriptionSession,
  buildProviderSettingsEntry,
  buildQwenSubscriptionProviderEntry,
  createQoderClient,
  discoverProviderModels,
  getQwenSubscriptionAuthorizationUrl,
  getQwenSubscriptionPlansUrl,
  isGenerationModelId,
  isQoderAccountRegion,
  openBrowserSecurely,
  parseCustomProviderSettings,
  resolveQoderAccountRegion,
  runLogger,
  selectQwenSubscriptionModel,
  toSubscriptionOAuthError,
  type Config,
  type PresetEndpoint,
  type PresetModel,
  type PresetProtocol,
  type ProviderPreset,
  type QoderAccountRegion,
  type QwenSubscriptionUserInfo,
} from '@qwen-code/core';
import { resolveEnvVarsInObject } from '@qwen-code/resource';

import {
  RadioButtonSelect,
  type RadioSelectItem,
} from '../components/shared/RadioButtonSelect.js';
import { createQoderProviders } from '../../auth/qoderProviders.js';
import { InputField } from '../components/shared/InputField.js';
import { Link } from '../components/shared/Link.js';
import { useSearchBuffer } from '../hooks/useSearchBuffer.js';
import { useKeypress, type Key } from '../hooks/useKeypress.js';
import { useRegisterActionHandlers } from '../contexts/ActionHandlerRegistry.js';
import { theme } from '../semantic-colors.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import {
  ALIBABA_PRESETS,
  QWENCLOUD_PRESETS,
  THIRD_PARTY_PRESETS,
  customProviderPreset,
} from '@qwen-code/core';

export interface AuthDoneSelection {
  /** Full model key to activate (and persist) after the dialog closes. */
  readonly modelKey: string;
}

export interface AuthDialogProps {
  readonly config: Config;
  readonly settings: LoadedSettings;
  /** Whether Esc may dismiss the dialog into the running session. */
  readonly canClose: boolean;
  /** Called when the user dismisses the dialog. */
  readonly onClose: () => void;
  /** Called when a provider or account is connected. */
  readonly onDone: (selection?: AuthDoneSelection) => void;
}

const TERMS_URL =
  'https://qwenlm.github.io/qwen-code-docs/en/users/support/tos-privacy/';
const MENU_HINT = 'Enter to select, ↑↓ to navigate, Esc to go back';
const MODEL_HINT =
  'Enter to submit, ↑↓ navigate, Space toggle, / search, Esc back';
const STEP_HINT = 'Enter to submit, Esc to go back';

type PreconnectGroup = 'qwencloud' | 'alibaba' | 'third-party';

type MainMenuValue =
  | 'qoder'
  | 'qwen-account'
  | 'qwencloud'
  | 'alibaba'
  | 'third-party'
  | 'custom'
  | `remove-invalid:${string}`;

type Page =
  | { readonly kind: 'main' }
  | { readonly kind: 'presets'; readonly group: PreconnectGroup }
  | { readonly kind: 'setup'; readonly preset: ProviderPreset }
  | { readonly kind: 'qoder-region' }
  | { readonly kind: 'qoder-login'; readonly region: QoderAccountRegion }
  | { readonly kind: 'qwen-account' }
  | { readonly kind: 'remove-invalid'; readonly providerId: string };

const REMOVE_INVALID_PREFIX = 'remove-invalid:';

type SetupStep =
  | 'protocol'
  | 'wireApi'
  | 'baseUrl'
  | 'endpoint'
  | 'apiKey'
  | 'models'
  | 'advancedConfig'
  | 'review';

const STEP_LABELS: Record<SetupStep, string> = {
  protocol: 'Protocol',
  wireApi: 'API',
  baseUrl: 'Base URL',
  endpoint: 'Endpoint',
  apiKey: 'API Key',
  models: 'Model IDs',
  advancedConfig: 'Advanced Config',
  review: 'Review',
};

/** Default budget for the advanced "Enable thinking" toggle. */
const ADVANCED_THINKING_BUDGET = 16_384;

const AUTH_TYPE_FOR_PROTOCOL: Record<PresetProtocol, AuthType> = {
  openai: AuthType.USE_OPENAI,
  'openai-responses': AuthType.USE_OPENAI_RESPONSES,
  anthropic: AuthType.USE_ANTHROPIC,
  gemini: AuthType.USE_GEMINI,
};

/** Gemini appends its own API version; the other protocols keep it in the URL. */
const BASE_URL_PLACEHOLDER: Record<PresetProtocol, string> = {
  openai: 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com',
};


interface SetupState {
  readonly preset: ProviderPreset;
  readonly step: SetupStep;
  readonly protocol: PresetProtocol;
  readonly wireApi: 'chat-completions' | 'responses';
  readonly baseUrl: string;
  readonly endpoint?: PresetEndpoint;
  readonly apiKey: string;
  readonly modelIdsText: string;
  readonly modelOptions: readonly string[];
  readonly modelsCustomInput: boolean;
  readonly modelsSearch: string;
  readonly modelsSearchFocused: boolean;
  readonly primaryModelId: string;
  readonly thinkingEnabled: boolean;
  readonly modalityEnabled: boolean;
  readonly modalityImage: boolean;
  readonly contextWindowSize: string;
  readonly advancedFocus: number;
  readonly discovering: boolean;
  readonly busy: boolean;
  readonly error?: string;
}

type SetupAction =
  | { readonly type: 'step'; readonly step: SetupStep }
  | { readonly type: 'patch'; readonly patch: Partial<SetupState> }
  | { readonly type: 'discovered'; readonly ids: readonly string[] };

function setupReducer(state: SetupState, action: SetupAction): SetupState {
  if (action.type === 'step') return { ...state, step: action.step };
  if (action.type === 'discovered') {
    // The provider list replaces the selectable candidates; ids that were
    // saved earlier but are absent from this response stay selected and are
    // surfaced through the direct model-ids editor instead.
    return {
      ...state,
      modelOptions: [...action.ids],
      error: undefined,
    };
  }
  return { ...state, ...action.patch };
}

const MAIN_ITEMS: Array<RadioSelectItem<MainMenuValue>> = [
  {
    key: 'qoder',
    value: 'qoder' as const,
    label: 'Qoder',
    sublabel:
      'Sign in to claim free Qwen model access during a limited-time promotion.',
  },
  {
    key: 'qwen-account',
    value: 'qwen-account' as const,
    label: 'Qwen Account',
    sublabel: 'Sign in with a Qwen account with an active Plus or Pro plan.',
  },
  {
    key: 'qwencloud',
    value: 'qwencloud' as const,
    label: 'QwenCloud',
    sublabel: 'Connect with a Token Plan or a standard API key.',
  },
  {
    key: 'alibaba',
    value: 'alibaba' as const,
    label: 'Alibaba Cloud Model Studio',
    sublabel:
      'Connect with a Coding Plan, Token Plan, or a standard API key.',
  },
  {
    key: 'third-party',
    value: 'third-party' as const,
    label: 'Other Providers',
    sublabel: 'Choose a supported provider and connect with an API key.',
  },
  {
    key: 'custom',
    value: 'custom' as const,
    label: 'Custom Provider',
    sublabel:
      'Configure a local model server, proxy, or another compatible API endpoint.',
  },
];

const GROUP_TITLES: Record<PreconnectGroup, string> = {
  qwencloud: 'QwenCloud · Access Method',
  alibaba: 'Alibaba Cloud Model Studio · Access Method',
  'third-party': 'Other Providers · Provider',
};

const QODER_REGION_ITEMS: Array<RadioSelectItem<QoderAccountRegion>> = [
  {
    key: 'global',
    value: 'global',
    label: 'International',
    sublabel: 'Sign in with a Qoder account on qoder.com',
  },
  {
    key: 'cn',
    value: 'cn',
    label: 'China',
    sublabel: 'Sign in with a Qoder account on qoder.cn',
  },
];

function presetsForGroup(group: PreconnectGroup): readonly ProviderPreset[] {
  if (group === 'qwencloud') return QWENCLOUD_PRESETS;
  if (group === 'alibaba') return ALIBABA_PRESETS;
  return THIRD_PARTY_PRESETS;
}

function invalidUserCustomProviderIds(
  config: Config,
  settings: LoadedSettings,
): string[] {
  const providers = settings.merged?.providers ?? {};
  const state = config.getCustomProvidersState?.();
  const stateIssues = state && 'issues' in state ? (state.issues ?? []) : [];
  const parsed = parseCustomProviderSettings(
    resolveEnvVarsInObject(providers),
  );
  const overrides = [
    settings.flag,
    ...(settings.isTrusted ? [settings.project, settings.local] : []),
  ].filter((file) => file !== undefined);
  const ids = new Set<string>();
  for (const issue of [...stateIssues, ...parsed.issues]) {
    const id = issue.providerId;
    if (id === '*' || !Object.hasOwn(providers, id)) continue;
    if (
      overrides.some((file) =>
        Object.hasOwn(file.settings.providers ?? {}, id),
      )
    )
      continue;
    ids.add(id);
  }
  return [...ids];
}

/** Model id column width, matching the catalog label layout. */
const MODEL_LABEL_COLUMN = 28;

function modelOptionLabel(
  id: string,
  selected: boolean,
  model: PresetModel | undefined,
): string {
  const mark = selected ? '◉' : '○';
  const details: string[] = [];
  if (model?.contextWindow) {
    details.push(`${model.contextWindow.toLocaleString('en-US')} tokens`);
  }
  if (model?.thinking) details.push('thinking');
  details.push(model?.vision ? 'text/image' : 'text');
  return `${mark} ${id.padEnd(MODEL_LABEL_COLUMN)} ${details.join(', ')}`;
}

/** Qwen Code separates menu options with one blank line. */
function menuRenderer<T>(items: ReadonlyArray<RadioSelectItem<T>>) {
  return (item: RadioSelectItem<T>, { titleColor }: { titleColor: string }) => (
    <Box
      flexDirection="column"
      marginBottom={item.key === items[items.length - 1]?.key ? 0 : 1}
    >
      <Text color={titleColor} wrap="wrap">
        {item.label}
      </Text>
      {item.sublabel ? (
        <Text color={theme.text.secondary} wrap="wrap">
          {item.sublabel}
        </Text>
      ) : null}
    </Box>
  );
}

export function AuthDialog({
  config,
  settings,
  canClose,
  onClose,
  onDone,
}: AuthDialogProps): React.JSX.Element {
  const [page, setPage] = useReducer(
    (_current: Page, next: Page) => next,
    { kind: 'main' } as Page,
  );
  const [mainError, setMainError] = useState<string>();
  const invalidProviderIds = invalidUserCustomProviderIds(config, settings);
  const mainItems: Array<RadioSelectItem<MainMenuValue>> =
    invalidProviderIds.length > 0
      ? [
          ...MAIN_ITEMS,
          ...invalidProviderIds.map((id) => ({
            key: `${REMOVE_INVALID_PREFIX}${id}`,
            value: `${REMOVE_INVALID_PREFIX}${id}` as const,
            label: `Remove invalid Custom Provider: ${id}`,
            sublabel:
              'Its settings are ignored by the model catalog until removed.',
          })),
        ]
      : MAIN_ITEMS;

  const leaveMain = (): void => {
    if (canClose) {
      onClose();
      return;
    }
    setMainError(
      'You must connect a provider to proceed. Press Ctrl+C again to exit.',
    );
  };

  if (page.kind === 'main') {
    return (
      <Frame
        title="Connect a Provider"
        error={mainError}
        footer={MENU_HINT}
        showTerms
      >
        <RadioButtonSelect
          showNumbers={false}
          selectionColor={theme.status.success}
          items={mainItems}
          renderItem={menuRenderer(mainItems)}
          onSelect={(value) => {
            if (value.startsWith(REMOVE_INVALID_PREFIX)) {
              setPage({
                kind: 'remove-invalid',
                providerId: value.slice(REMOVE_INVALID_PREFIX.length),
              });
            } else if (value === 'custom') {
              setPage({ kind: 'setup', preset: customProviderPreset });
            } else if (value === 'qoder') {
              setPage({ kind: 'qoder-region' });
            } else if (value === 'qwen-account') {
              setPage({ kind: 'qwen-account' });
            } else if (
              value === 'qwencloud' ||
              value === 'alibaba' ||
              value === 'third-party'
            ) {
              setPage({ kind: 'presets', group: value });
            }
          }}
          onCancel={leaveMain}
        />
      </Frame>
    );
  }

  if (page.kind === 'remove-invalid') {
    return (
      <Frame
        title="Remove Invalid Custom Provider"
        error={mainError}
        footer={MENU_HINT}
      >
        <Text>{page.providerId}</Text>
        <RadioButtonSelect
          showNumbers={false}
          items={[
            { key: 'cancel', value: false, label: 'Cancel' },
            { key: 'remove', value: true, label: 'Remove' },
          ]}
          onCancel={() => setPage({ kind: 'main' })}
          onSelect={(confirmed) => {
            if (!confirmed) {
              setPage({ kind: 'main' });
              return;
            }
            if (
              !settings.deleteValue(SettingScope.User, [
                'providers',
                page.providerId,
              ])
            ) {
              setMainError('Could not remove the invalid custom provider.');
              setPage({ kind: 'main' });
              return;
            }
            const reload = config.reloadModelConfigFromDisk;
            if (typeof reload !== 'function') {
              setPage({ kind: 'main' });
              return;
            }
            void reload
              .call(config)
              .then(() => setPage({ kind: 'main' }))
              .catch(() => {
                setMainError(
                  'Could not reload custom provider settings from disk.',
                );
                setPage({ kind: 'main' });
              });
          }}
        />
      </Frame>
    );
  }

  if (page.kind === 'presets') {
    const presets = presetsForGroup(page.group);
    const items = presets.map((preset) => ({
      key: preset.id,
      value: preset.id,
      label: preset.label,
      sublabel: preset.description,
    }));
    return (
      <Frame title={GROUP_TITLES[page.group]} footer={MENU_HINT}>
        <RadioButtonSelect
          showNumbers={false}
          selectionColor={theme.status.success}
          items={items}
          renderItem={menuRenderer(items)}
          onSelect={(id) => {
            const preset = presets.find((entry) => entry.id === id);
            if (preset) setPage({ kind: 'setup', preset });
          }}
          onCancel={() => setPage({ kind: 'main' })}
        />
      </Frame>
    );
  }

  if (page.kind === 'qoder-region') {
    const savedRegion = settings.merged.security?.auth?.qoderRegion;
    const envRegion = process.env[QODER_ENV_ACCOUNT_REGION]
      ?.trim()
      .toLowerCase();
    const preferred = isQoderAccountRegion(envRegion)
      ? envRegion
      : isQoderAccountRegion(savedRegion)
        ? savedRegion
        : resolveQoderAccountRegion();
    const initialIndex = Math.max(
      0,
      QODER_REGION_ITEMS.findIndex((item) => item.value === preferred),
    );
    return (
      <Frame title="Qoder · Region" footer={MENU_HINT}>
        <RadioButtonSelect
          showNumbers={false}
          selectionColor={theme.status.success}
          items={QODER_REGION_ITEMS}
          initialIndex={initialIndex}
          renderItem={menuRenderer(QODER_REGION_ITEMS)}
          onSelect={(region) => setPage({ kind: 'qoder-login', region })}
          onCancel={() => setPage({ kind: 'main' })}
        />
      </Frame>
    );
  }

  if (page.kind === 'qoder-login') {
    return (
      <QoderLogin
        config={config}
        settings={settings}
        region={page.region}
        onBack={() => setPage({ kind: 'qoder-region' })}
        onDone={onDone}
      />
    );
  }

  if (page.kind === 'qwen-account') {
    return (
      <QwenAccountLogin
        config={config}
        settings={settings}
        onBack={() => setPage({ kind: 'main' })}
        onDone={onDone}
      />
    );
  }

  const presetGroup = page.preset.group;
  return (
    <ProviderSetup
      settings={settings}
      preset={page.preset}
      onBack={() =>
        presetGroup === 'custom'
          ? setPage({ kind: 'main' })
          : setPage({ kind: 'presets', group: presetGroup })
      }
      onDone={onDone}
    />
  );
}

function Frame({
  title,
  children,
  error,
  footer,
  showTerms = false,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly error?: string;
  readonly footer?: string;
  readonly showTerms?: boolean;
}): React.JSX.Element {
  const { stdout } = useStdout();
  const separator = '─'.repeat(Math.max(20, (stdout?.columns ?? 80) - 4));
  return (
    <Box
      borderStyle="single"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingX={1}
      paddingY={1}
      width="100%"
    >
      <Text bold>{title}</Text>
      <Box marginTop={1} flexDirection="column">
        {children}
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{error}</Text>
        </Box>
      ) : null}
      {showTerms ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.border.default}>{separator}</Text>
          <Box marginTop={1}>
            <Text>Terms of Services and Privacy Notice:</Text>
          </Box>
          <Text color={theme.text.secondary} underline>
            {TERMS_URL}
          </Text>
        </Box>
      ) : footer ? (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>{footer}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function TextField({
  value,
  placeholder,
  mask,
  onSubmit,
  onCancel,
  onChange,
  focus = true,
  onKeyBeforeInput,
  variant,
}: {
  readonly value: string;
  readonly placeholder?: string;
  readonly mask?: string;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
  readonly onChange?: (value: string) => void;
  readonly focus?: boolean;
  readonly onKeyBeforeInput?: (key: Key) => boolean;
  readonly variant?: 'framed' | 'inline';
}): React.JSX.Element {
  const buffer = useSearchBuffer({
    initialText: value,
    onChange: onChange ?? (() => {}),
  });
  return (
    <InputField
      buffer={buffer}
      placeholder={placeholder}
      mask={mask}
      focus={focus}
      onKeyBeforeInput={onKeyBeforeInput}
      onSubmit={onSubmit}
      onCancel={onCancel}
      variant={variant}
    />
  );
}

type ProviderEntry = ReturnType<typeof buildProviderSettingsEntry>;

function thinkingPreference(enabled: boolean): {
  reasoning: { thinking: { type: 'enabled'; budgetTokens: number } | { type: 'disabled' } };
} {
  return {
    reasoning: {
      thinking: enabled
        ? { type: 'enabled', budgetTokens: ADVANCED_THINKING_BUDGET }
        : { type: 'disabled' },
    },
  };
}

/**
 * Mirror Qwen Code's advanced step onto the fields this stack persists:
 * thinking capability, image input and the context window tier. Video/audio/
 * PDF toggles stay presentational until the model contract carries them.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readModelId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const id = value['model'];
  return typeof id === 'string' ? id : undefined;
}

/**
 * Reconnecting the same custom endpoint keeps the models saved by earlier
 * wizard runs. The provider id is derived from protocol + base URL, so a
 * write would otherwise replace the whole entry with only the new models.
 */
function mergeCustomProviderModels(
  existing: { readonly models?: unknown } | undefined,
  entry: ProviderEntry,
): void {
  if (!existing || !Array.isArray(existing.models)) return;
  const merged = new Map<string, Record<string, unknown>>();
  for (const model of existing.models) {
    const id = readModelId(model);
    if (!id || !isRecord(model)) continue;
    merged.set(id, model);
  }
  const incoming = Array.isArray(entry.value['models'])
    ? entry.value['models']
    : [];
  for (const model of incoming) {
    const id = readModelId(model);
    if (!id || !isRecord(model)) continue;
    merged.set(id, { ...(merged.get(id) ?? {}), ...model });
  }
  if (merged.size > 0) entry.value['models'] = [...merged.values()];
}

function applyCustomAdvanced(entry: ProviderEntry, state: SetupState): void {
  if (state.preset.group !== 'custom') return;
  const contextWindow = Number.parseInt(state.contextWindowSize, 10);
  const hasContextWindow =
    Number.isFinite(contextWindow) && contextWindow > 0;
  const models = Array.isArray(entry.value['models'])
    ? (entry.value['models'] as Array<Record<string, unknown>>)
    : [];
  for (const model of models) {
    if (hasContextWindow) model['contextWindow'] = contextWindow;
    if (
      !state.thinkingEnabled &&
      !(state.modalityEnabled && state.modalityImage)
    ) {
      continue;
    }
    const capabilities = isRecord(model['capabilities'])
      ? model['capabilities']
      : {};
    if (state.thinkingEnabled) {
      capabilities['thinking'] = {
        modes: ['enabled'],
        supportsEffort: false,
      };
    }
    if (state.modalityEnabled && state.modalityImage) {
      capabilities['vision'] = true;
    }
    model['capabilities'] = capabilities;
  }
}

function ProviderSetup({
  settings,
  preset,
  onBack,
  onDone,
}: {
  readonly settings: LoadedSettings;
  readonly preset: ProviderPreset;
  readonly onBack: () => void;
  readonly onDone: (selection?: AuthDoneSelection) => void;
}): React.JSX.Element {
  const initialStep: SetupStep =
    preset.group === 'custom'
      ? 'protocol'
      : preset.endpoints.length > 1
        ? 'endpoint'
        : 'apiKey';
  const [focusedModelKey, setFocusedModelKey] = useState<string>();
  // Reconnecting a preset starts from its saved entry, like Qwen Code's
  // provider edit flow; custom providers have no stable id until a URL exists.
  const existingProvider =
    preset.group === 'custom' ? undefined : settings.merged.providers?.[preset.id];
  const savedModelIds =
    existingProvider?.models
      ?.map((model) => model.model)
      .filter((id) => Boolean(id))
      .filter(
        (id) =>
          preset.models.some((model) => model.id === id) ||
          !isGenerationModelId(id),
      ) ?? [];
  const savedEndpoint = preset.endpoints.find(
    (endpoint) => endpoint.url === existingProvider?.baseUrl,
  );
  const savedModelIdsText =
    savedModelIds.length > 0
      ? savedModelIds.join(', ')
      : preset.models.map((model) => model.id).join(', ');
  const [state, dispatch] = useReducer(setupReducer, {
    preset,
    step: initialStep,
    protocol: preset.protocol,
    wireApi:
      existingProvider?.protocol === 'openai-responses'
        ? 'responses'
        : 'chat-completions',
    baseUrl: existingProvider?.baseUrl ?? '',
    endpoint: savedEndpoint ?? preset.endpoints[0],
    apiKey: existingProvider?.apiKey?.trim() ?? '',
    modelIdsText: savedModelIdsText,
    modelOptions: [
      ...new Set([
        ...preset.models.map((model) => model.id),
        ...savedModelIds,
      ]),
    ],
    modelsCustomInput: false,
    modelsSearch: '',
    modelsSearchFocused: false,
    primaryModelId: '',
    thinkingEnabled: false,
    modalityEnabled: false,
    modalityImage: true,
    contextWindowSize: '',
    advancedFocus: 0,
    discovering: false,
    busy: false,
  });

  useEffect(() => {
    if (
      state.step !== 'models' ||
      !state.preset.supportsModelDiscovery ||
      !state.endpoint
    ) {
      return;
    }
    let cancelled = false;
    dispatch({ type: 'patch', patch: { discovering: true } });
    void discoverProviderModels({
      baseUrl: state.endpoint.url,
      apiKey: state.apiKey,
    })
      .then((ids) => {
        if (!cancelled && ids) {
          dispatch({ type: 'discovered', ids });
        }
      })
      .finally(() => {
        if (!cancelled) {
          dispatch({ type: 'patch', patch: { discovering: false } });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    state.step,
    state.preset.supportsModelDiscovery,
    state.endpoint,
    state.apiKey,
  ]);

  const effectiveProtocol: PresetProtocol =
    state.protocol === 'openai' && state.wireApi === 'responses'
      ? 'openai-responses'
      : state.protocol;
  const buildEntry = (modelIdsText: string) => {
    const entry = buildProviderSettingsEntry({
      preset: { ...preset, protocol: effectiveProtocol },
      baseUrl: state.endpoint?.url ?? state.baseUrl,
      apiKey: state.apiKey,
      modelIds: modelIdsText.split(','),
    });
    applyCustomAdvanced(entry, state);
    return entry;
  };
  const connect = async (overrides?: {
    modelIdsText?: string;
    primaryModelId?: string;
  }): Promise<void> => {
    dispatch({ type: 'patch', patch: { busy: true, error: undefined } });
    try {
      const modelIdsText = overrides?.modelIdsText ?? state.modelIdsText;
      const entry = buildEntry(modelIdsText);
      if (preset.group === 'custom') {
        mergeCustomProviderModels(
          settings.merged.providers?.[entry.providerId],
          entry,
        );
      }
      const savedProvider = settings.setValue(
        SettingScope.User,
        ['providers', entry.providerId],
        entry.value,
      );
      const savedAuthType = settings.setValue(
        SettingScope.User,
        'security.auth.selectedType',
        AUTH_TYPE_FOR_PROTOCOL[effectiveProtocol],
      );
      if (!savedProvider || !savedAuthType) {
        throw new Error(
          'Could not write provider settings to settings.json.',
        );
      }
      if (preset.group === 'custom') {
        const preference = thinkingPreference(state.thinkingEnabled);
        for (const id of modelIdsText
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)) {
          const saved = settings.setValue(
            SettingScope.User,
            [
              'model',
              'preferences',
              `${entry.providerId}/${id}`,
              'reasoning',
              'thinking',
            ],
            preference.reasoning.thinking,
          );
          if (!saved) {
            runLogger.warn(
              `[auth] could not persist thinking preference for ${entry.providerId}/${id}`,
            );
          }
        }
      }
      const primaryModel =
        overrides?.primaryModelId ??
        (state.primaryModelId || modelIdsText.split(',')[0]?.trim());
      dispatch({ type: 'patch', patch: { busy: false } });
      onDone(
        primaryModel
          ? { modelKey: `${entry.providerId}/${primaryModel}` }
          : undefined,
      );
    } catch (error) {
      dispatch({
        type: 'patch',
        patch: {
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };

  const selectedModelIds = state.modelIdsText
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const selectedModelSet = useMemo(
    () =>
      new Set(
        state.modelIdsText
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    [state.modelIdsText],
  );
  // Saved ids the provider no longer returns are only kept as direct entries
  // when they are not part of the preset catalog. Catalog entries that the
  // provider stopped serving are dropped on submit, matching the wizard.
  const extraSelectedIds = selectedModelIds.filter(
    (id) =>
      !state.modelOptions.includes(id) &&
      !preset.models.some((model) => model.id === id),
  );
  const orderedSelectedIds = [
    ...state.modelOptions.filter((id) => selectedModelSet.has(id)),
    ...extraSelectedIds,
  ];
  const toggleModel = (id: string): void => {
    const next = new Set(selectedModelSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const ordered = [
      ...state.modelOptions.filter((option) => next.has(option)),
      ...[...next].filter(
        (option) =>
          !state.modelOptions.includes(option) &&
          !preset.models.some((model) => model.id === option),
      ),
    ];
    dispatch({
      type: 'patch',
      patch: { modelIdsText: ordered.join(', '), error: undefined },
    });
  };
  const handleModelsSearchChange = useCallback((value: string) => {
    dispatch({
      type: 'patch',
      patch: { modelsSearch: value, error: undefined },
    });
  }, []);
  const modelSearchQuery = state.modelsSearch.trim().toLowerCase();
  const filteredModelOptions = useMemo(
    () =>
      modelSearchQuery
        ? state.modelOptions.filter((id) =>
            id.toLowerCase().includes(modelSearchQuery),
          )
        : state.modelOptions,
    [state.modelOptions, modelSearchQuery],
  );
  const presetModelById = useMemo(
    () => new Map(preset.models.map((model) => [model.id, model])),
    [preset.models],
  );
  const isGenerationModel = useCallback(
    (id: string) => !presetModelById.has(id) && isGenerationModelId(id),
    [presetModelById],
  );
  const selectableModelOptions = useMemo(
    () =>
      filteredModelOptions.filter(
        (id) => !isGenerationModel(id) || selectedModelSet.has(id),
      ),
    [filteredModelOptions, isGenerationModel, selectedModelSet],
  );
  useEffect(() => {
    if (state.step !== 'models' || state.modelsCustomInput) return;
    const next = selectableModelOptions[0];
    if (focusedModelKey === next) return;
    if (!focusedModelKey || !selectableModelOptions.includes(focusedModelKey)) {
      if (next !== undefined || focusedModelKey !== undefined) {
        setFocusedModelKey(next);
      }
    }
  }, [
    state.step,
    state.modelsCustomInput,
    selectableModelOptions,
    focusedModelKey,
  ]);
  useKeypress(
    (key) => {
      if (key.name !== 'space' && key.sequence !== ' ') return;
      if (!focusedModelKey || focusedModelKey === '__custom__') return;
      if (
        isGenerationModel(focusedModelKey) &&
        !selectedModelSet.has(focusedModelKey)
      ) {
        return;
      }
      toggleModel(focusedModelKey);
    },
    { isActive: state.step === 'models' && !state.modelsCustomInput },
  );
  // Match /model: `/` enters the filter, so typing stays free for the list.
  useKeypress(
    (key) => {
      if (
        key.sequence !== '/' ||
        key.ctrl ||
        key.alt ||
        key.cmd ||
        state.modelsSearchFocused
      ) {
        return;
      }
      dispatch({ type: 'patch', patch: { modelsSearchFocused: true } });
      return true;
    },
    { isActive: state.step === 'models' && !state.modelsCustomInput },
  );
  useKeypress(
    (key) => {
      if (key.name !== 'escape') return;
      dispatch({
        type: 'patch',
        patch: { step: 'apiKey', error: undefined, discovering: false },
      });
    },
    { isActive: state.step === 'models' && state.discovering },
  );

  const steps: SetupStep[] = [
    ...(preset.group === 'custom' ? (['protocol'] as const) : []),
    ...(preset.group === 'custom' && state.protocol === 'openai'
      ? (['wireApi'] as const)
      : []),
    ...(preset.group === 'custom' ? (['baseUrl'] as const) : []),
    ...(preset.endpoints.length > 1 ? (['endpoint'] as const) : []),
    'apiKey',
    'models',
    ...(preset.group === 'custom'
      ? (['advancedConfig', 'review'] as const)
      : []),
  ];
  /** Esc always returns to the previous visible step, like Qwen Code. */
  const goBackStep = (): void => {
    const index = steps.indexOf(state.step);
    if (index <= 0) {
      onBack();
      return;
    }
    dispatch({
      type: 'patch',
      patch: { step: steps[index - 1], error: undefined },
    });
  };
  const advancedContextIndex = state.modalityEnabled ? 3 : 2;
  const submitAdvanced = (contextWindowValue: string): void => {
    const raw = contextWindowValue.trim();
    if (raw) {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        dispatch({
          type: 'patch',
          patch: { error: 'Context window must be a positive number.' },
        });
        return;
      }
    }
    dispatch({
      type: 'patch',
      patch: {
        contextWindowSize: raw,
        error: undefined,
        step: 'review',
      },
    });
  };
  const toggleAdvanced = (index: number): void => {
    if (index === 0) {
      dispatch({
        type: 'patch',
        patch: { thinkingEnabled: !state.thinkingEnabled, error: undefined },
      });
    } else if (index === 1) {
      dispatch({
        type: 'patch',
        patch: { modalityEnabled: !state.modalityEnabled, error: undefined },
      });
    } else if (state.modalityEnabled && index === 2) {
      dispatch({
        type: 'patch',
        patch: { modalityImage: !state.modalityImage, error: undefined },
      });
    }
  };
  const handleContextWindowChange = useCallback((value: string) => {
    dispatch({
      type: 'patch',
      patch: { contextWindowSize: value, error: undefined },
    });
  }, []);
  const moveAdvancedFocus = (delta: number): void => {
    dispatch({
      type: 'patch',
      patch: {
        advancedFocus:
          (state.advancedFocus + delta + advancedContextIndex + 1) %
          (advancedContextIndex + 1),
      },
    });
  };
  // The inline context-window field owns keys while it is focused; row
  // navigation is handled in its onKeyBeforeInput so arrows cannot get stuck
  // in the text buffer.
  useKeypress(
    (key) => {
      if (state.step !== 'advancedConfig') return false;
      if (state.advancedFocus === advancedContextIndex) return false;
      switch (key.name) {
        case 'up':
          moveAdvancedFocus(-1);
          return true;
        case 'down':
          moveAdvancedFocus(1);
          return true;
        case 'space':
          toggleAdvanced(state.advancedFocus);
          return true;
        case 'enter':
          submitAdvanced(state.contextWindowSize);
          return true;
        case 'escape':
          goBackStep();
          return true;
        default:
          return false;
      }
    },
    { isActive: state.step === 'advancedConfig' },
  );
  useKeypress(
    (key) => {
      if (state.step !== 'review') return;
      if (key.name === 'enter') {
        if (!state.busy) {
          void connect({
            primaryModelId: state.primaryModelId || undefined,
          });
        }
      } else if (key.name === 'escape') {
        goBackStep();
      }
    },
    { isActive: state.step === 'review' },
  );
  const stepIndex = Math.max(1, steps.indexOf(state.step) + 1);
  const stepLabel =
    state.step === 'endpoint'
      ? preset.endpointStepTitle
      : STEP_LABELS[state.step];
  const stepTitle = `${preset.flowTitle} · Step ${stepIndex}/${steps.length} · ${stepLabel}`;

  if (state.step === 'protocol') {
    const items = [
      {
        key: 'openai',
        value: 'openai',
        label: 'OpenAI-compatible',
        sublabel: 'Standard OpenAI API format (most common)',
      },
      {
        key: 'anthropic',
        value: 'anthropic',
        label: 'Anthropic-compatible',
        sublabel: 'Anthropic Messages API format',
      },
      {
        key: 'gemini',
        value: 'gemini',
        label: 'Gemini-compatible',
        sublabel: 'Google Gemini API format',
      },
    ];
    return (
      <Frame title={stepTitle} footer={MENU_HINT}>
        <RadioButtonSelect
          showNumbers={false}
          selectionColor={theme.status.success}
          items={items}
          renderItem={menuRenderer(items)}
          onSelect={(value) => {
            const protocol = value as PresetProtocol;
            dispatch({
              type: 'patch',
              patch: {
                protocol,
                step: protocol === 'openai' ? 'wireApi' : 'baseUrl',
              },
            });
          }}
          onCancel={goBackStep}
        />
      </Frame>
    );
  }

  if (state.step === 'wireApi') {
    const wireApiItems = [
      {
        key: 'chat-completions',
        value: 'chat-completions',
        label: 'Chat Completions',
        sublabel: 'Standard OpenAI API format (most common)',
      },
      {
        key: 'responses',
        value: 'responses',
        label: 'Responses',
        sublabel: 'OpenAI Responses API — streaming reasoning + tool use',
      },
    ];
    return (
      <Frame title={stepTitle} footer={MENU_HINT}>
        <Text color={theme.text.secondary}>
          Choose the wire format used by this OpenAI-compatible endpoint.
        </Text>
        <Box marginTop={1}>
          <RadioButtonSelect
            showNumbers={false}
            selectionColor={theme.status.success}
              items={wireApiItems}
            renderItem={menuRenderer(wireApiItems)}
            onSelect={(value) => {
              dispatch({
                type: 'patch',
                patch: {
                  wireApi: value as 'chat-completions' | 'responses',
                  step: 'baseUrl',
                },
              });
            }}
            onCancel={goBackStep}
          />
        </Box>
      </Frame>
    );
  }

  if (state.step === 'baseUrl') {
    return (
      <Frame title={stepTitle} footer={STEP_HINT}>
        <Text color={theme.text.secondary}>
          Enter the API endpoint for this protocol.
        </Text>
        <Box marginTop={1}>
          <TextField
            key="gemini-base-url"
            value={state.baseUrl}
            placeholder={BASE_URL_PLACEHOLDER[state.protocol]}
            onSubmit={(value) => {
              // Empty input adopts the placeholder default, matching the
              // visible hint and upstream behavior.
              const effective =
                value.trim() || BASE_URL_PLACEHOLDER[state.protocol];
              dispatch({
                type: 'patch',
                patch: {
                  baseUrl: effective,
                  error: undefined,
                  step: 'apiKey',
                },
              });
            }}
            onCancel={goBackStep}
          />
        </Box>
        <ErrorLine error={state.error} />
      </Frame>
    );
  }

  if (state.step === 'endpoint') {
    const items = preset.endpoints.map((endpoint) => ({
      key: endpoint.id,
      value: endpoint.id,
      label: endpoint.label,
      sublabel: endpoint.url,
    }));
    const savedEndpointIndex = items.findIndex(
      (item) => item.key === state.endpoint?.id,
    );
    return (
      <Frame title={stepTitle} footer={MENU_HINT}>
        <RadioButtonSelect
          showNumbers={false}
          selectionColor={theme.status.success}
          initialIndex={savedEndpointIndex >= 0 ? savedEndpointIndex : 0}
          items={items}
          renderItem={menuRenderer(items)}
          onSelect={(id) => {
            const endpoint = preset.endpoints.find((entry) => entry.id === id);
            if (endpoint) {
              dispatch({
                type: 'patch',
                patch: { endpoint, step: 'apiKey' },
              });
            }
          }}
          onCancel={goBackStep}
        />
      </Frame>
    );
  }

  if (state.step === 'apiKey') {
    return (
      <Frame title={stepTitle} footer={STEP_HINT}>
        <Text color={theme.text.secondary}>
          Paste the API key for {state.endpoint?.label ?? preset.label}.
        </Text>
        <Box marginTop={1}>
          <TextField
            key="gemini-api-key"
            value={state.apiKey}
            placeholder={preset.apiKeyPlaceholder ?? 'sk-...'}
            onSubmit={(value) => {
              const trimmed = value.trim();
              if (!trimmed) {
                dispatch({
                  type: 'patch',
                  patch: { error: 'An API key is required.' },
                });
                return;
              }
              const keyError = preset.validateApiKey?.(trimmed);
              if (keyError) {
                dispatch({ type: 'patch', patch: { error: keyError } });
                return;
              }
              dispatch({
                type: 'patch',
                patch: {
                  apiKey: trimmed,
                  error: undefined,
                  step: 'models',
                  discovering: preset.supportsModelDiscovery,
                },
              });
            }}
            onCancel={goBackStep}
          />
        </Box>
        {state.endpoint?.documentationUrl ? (
          <Box marginTop={1}>
            <Link href={state.endpoint.documentationUrl}>
              <Text color={theme.text.link} underline>
                Documentation: {state.endpoint.documentationUrl}
              </Text>
            </Link>
          </Box>
        ) : null}
        <ErrorLine error={state.error} />
      </Frame>
    );
  }

  if (state.step === 'models') {
    if (state.discovering) {
      return (
        <Frame title={stepTitle} footer={STEP_HINT}>
          <Text color={theme.text.secondary}>
            Loading models from provider…
          </Text>
        </Frame>
      );
    }
    if (state.modelOptions.length === 0) {
      return (
        <Frame title={stepTitle} footer={STEP_HINT}>
          <Text color={theme.text.secondary}>
            Enter model IDs separated by commas.
          </Text>
          <Box marginTop={1}>
            <TextField
              key="gemini-model-ids-empty"
              value={state.modelIdsText}
              placeholder="model-id-1, model-id-2"
              onSubmit={(value) => {
                if (state.busy) return;
                const ids = value
                  .split(',')
                  .map((id) => id.trim())
                  .filter(Boolean);
                if (ids.length === 0) {
                  dispatch({
                    type: 'patch',
                    patch: { error: 'Choose at least one model.' },
                  });
                  return;
                }
                dispatch({
                  type: 'patch',
                  patch: {
                    modelIdsText: ids.join(', '),
                    error: undefined,
                  },
                });
                if (preset.group === 'custom') {
                  dispatch({
                    type: 'patch',
                    patch: { primaryModelId: ids[0], step: 'advancedConfig' },
                  });
                } else {
                  void connect({
                    modelIdsText: ids.join(', '),
                    primaryModelId: ids[0],
                  });
                }
              }}
              onCancel={goBackStep}
            />
          </Box>
          <ErrorLine error={state.error} />
        </Frame>
      );
    }
    if (state.modelsCustomInput) {
      return (
        <Frame title={stepTitle} footer={STEP_HINT}>
          <Text color={theme.text.secondary}>
            Model ids outside the provider list, separated by commas. Enter to
            apply them together with the checked models.
          </Text>
          <Box marginTop={1}>
            <TextField
              key="gemini-model-ids"
              value={extraSelectedIds.join(', ')}
              placeholder="model-id"
              onSubmit={(value) => {
                const ids = value
                  .split(',')
                  .map((id) => id.trim())
                  .filter(Boolean);
                // Checked provider models lead, matching the wizard's
                // "selections + direct ids" merge on submit.
                const checkedOptionIds = state.modelOptions.filter((id) =>
                  selectedModelSet.has(id),
                );
                const merged = [...new Set([...checkedOptionIds, ...ids])];
                if (merged.length === 0) {
                  dispatch({
                    type: 'patch',
                    patch: { error: 'Choose at least one model.' },
                  });
                  return;
                }
                dispatch({
                  type: 'patch',
                  patch: {
                    modelIdsText: merged.join(', '),
                    modelsCustomInput: false,
                    error: undefined,
                  },
                });
              }}
              onCancel={() =>
                dispatch({
                  type: 'patch',
                  patch: {
                    modelsCustomInput: false,
                    error: undefined,
                  },
                })
              }
            />
          </Box>
          <ErrorLine error={state.error} />
        </Frame>
      );
    }
    return (
      <Frame title={stepTitle} footer={MODEL_HINT}>
        <Text color={theme.text.secondary}>
          Select the models to enable
        </Text>
        {extraSelectedIds.length > 0 ? (
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              Also enabled (not returned by the provider):{' '}
              {extraSelectedIds.join(', ')}
            </Text>
          </Box>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.text.secondary}>Search</Text>
          <TextField
            key="model-search"
            value={state.modelsSearch}
            placeholder={
              state.modelsSearchFocused ? 'search' : 'press / to filter'
            }
            focus={state.modelsSearchFocused}
            onChange={handleModelsSearchChange}
            onKeyBeforeInput={(key) => {
              if (
                key.name === 'up' ||
                key.name === 'down' ||
                key.name === 'tab' ||
                key.name === 'enter'
              ) {
                dispatch({
                  type: 'patch',
                  patch: { modelsSearchFocused: false },
                });
                return true;
              }
              return false;
            }}
            onSubmit={() =>
              dispatch({
                type: 'patch',
                patch: { modelsSearchFocused: false },
              })
            }
            onCancel={() =>
              dispatch({
                type: 'patch',
                patch: { modelsSearch: '', modelsSearchFocused: false },
              })
            }
          />
        </Box>
        {modelSearchQuery && filteredModelOptions.length === 0 ? (
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>No models match.</Text>
          </Box>
        ) : null}
        <Box marginTop={1}>
          <RadioButtonSelect
            selectionColor={theme.status.success}
            showNumbers={false}
            isFocused={!state.modelsSearchFocused}
            items={[
              ...filteredModelOptions.map((id) => {
                const selected = selectedModelSet.has(id);
                const generation = isGenerationModel(id);
                return {
                  key: id,
                  value: id,
                  label: modelOptionLabel(
                    id,
                    selected,
                    presetModelById.get(id),
                  ),
                  ...(generation
                    ? {
                        disabled: !selected,
                        sublabel:
                          'Image/video/audio generation model — not available for chat',
                      }
                    : {}),
                };
              }),
              {
                key: '__custom__',
                value: '__custom__',
                label: 'Enter custom model ids…',
                sublabel: 'Add model ids the catalog does not list',
              },
            ]}
            onHighlight={setFocusedModelKey}
            onSelect={(value) => {
              if (state.busy) return;
              if (value === '__custom__') {
                dispatch({
                  type: 'patch',
                  patch: {
                    modelsCustomInput: true,
                    error: undefined,
                  },
                });
                return;
              }
              if (isGenerationModel(value)) {
                // Legacy selections can be checked off; new selections are
                // disabled before reaching this handler.
                if (selectedModelSet.has(value)) toggleModel(value);
                return;
              }
              // Activate the highlighted model; keep the rest of the
              // checked set enabled in the provider entry.
              const nextSelected = selectedModelSet.has(value)
                ? orderedSelectedIds
                : [...orderedSelectedIds, value];
              const nextModelIds = nextSelected.join(', ');
              if (preset.group === 'custom') {
                dispatch({
                  type: 'patch',
                  patch: {
                    modelIdsText: nextModelIds,
                    primaryModelId: value,
                    error: undefined,
                    step: 'advancedConfig',
                  },
                });
              } else {
                dispatch({
                  type: 'patch',
                  patch: { modelIdsText: nextModelIds, error: undefined },
                });
                void connect({
                  modelIdsText: nextModelIds,
                  primaryModelId: value,
                });
              }
            }}
            onCancel={goBackStep}
          />
        </Box>
        <ErrorLine error={state.error} />
      </Frame>
    );
  }

  if (state.step === 'advancedConfig') {
    const checkmark = (value: boolean) => (value ? '◉' : '○');
    const row = (
      index: number,
      label: string,
      value: boolean,
      marginLeft = 2,
    ) => (
      <Box marginTop={1} marginLeft={marginLeft}>
        <Text
          color={
            state.advancedFocus === index ? theme.status.success : undefined
          }
        >
          {state.advancedFocus === index ? '›' : ' '} {checkmark(value)} {label}
        </Text>
      </Box>
    );
    const modalityIndex = 2;
    return (
      <Frame
        title={stepTitle}
        footer="↑↓ to navigate, Space to toggle, Enter to continue, Esc to go back"
      >
        <Text color={theme.text.secondary}>
          Optional: configure advanced generation settings.
        </Text>
        {row(0, 'Enable thinking', state.thinkingEnabled)}
        <Box marginLeft={4}>
          <Text color={theme.text.secondary}>
            Allows the model to perform extended reasoning before responding.
          </Text>
        </Box>
        {row(1, 'Enable modality', state.modalityEnabled)}
        <Box marginLeft={4}>
          <Text color={theme.text.secondary}>
            Enables multimodal input capabilities (image, video, etc.).
          </Text>
        </Box>
        {state.modalityEnabled ? (
          <Box marginLeft={6} marginTop={0}>
            <Text
              color={
                state.advancedFocus === modalityIndex
                  ? theme.status.success
                  : undefined
              }
            >
              {state.advancedFocus === modalityIndex ? '›' : ' '}{' '}
              {checkmark(state.modalityImage)} Image
            </Text>
          </Box>
        ) : null}
        <Box marginTop={1} marginLeft={2} flexDirection="row">
          <Text
            color={
              state.advancedFocus === advancedContextIndex
                ? theme.status.success
                : undefined
            }
          >
            {state.advancedFocus === advancedContextIndex ? '›' : ' '} Context
            window:{' '}
          </Text>
          <TextField
            key="advanced-context-window"
            value={state.contextWindowSize}
            placeholder="auto"
            variant="inline"
            focus={state.advancedFocus === advancedContextIndex}
            onChange={handleContextWindowChange}
            onKeyBeforeInput={(key) => {
              if (key.name === 'up' || key.name === 'down') {
                moveAdvancedFocus(key.name === 'up' ? -1 : 1);
                return true;
              }
              if (key.name === 'space' || key.sequence === ' ') return true;
              if (key.name === 'enter') {
                submitAdvanced(state.contextWindowSize);
                return true;
              }
              if (key.name === 'escape') {
                goBackStep();
                return true;
              }
              return false;
            }}
            onSubmit={submitAdvanced}
            onCancel={goBackStep}
          />
        </Box>
        <Box marginLeft={4}>
          <Text color={theme.text.secondary}>
            Max input tokens (leave empty to auto-detect from model name).
          </Text>
        </Box>
        <ErrorLine error={state.error} />
      </Frame>
    );
  }

  if (state.step === 'review') {
    let preview: Record<string, unknown> | undefined;
    let previewError: string | undefined;
    try {
      const entry = buildEntry(state.modelIdsText);
      const preferences = state.modelIdsText
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .reduce<Record<string, unknown>>((all, id) => {
          all[`${entry.providerId}/${id}`] = thinkingPreference(
            state.thinkingEnabled,
          );
          return all;
        }, {});
      preview = {
        [entry.providerId]: entry.value,
        model: { preferences },
      };
    } catch (error) {
      previewError = error instanceof Error ? error.message : String(error);
    }
    return (
      <Frame title={stepTitle} footer="Enter to save, Esc to go back">
        <Text color={theme.text.primary}>
          The following JSON will be saved to settings.json:
        </Text>
        <Box marginTop={1} flexDirection="column">
          {preview ? (
            <Text>{JSON.stringify(preview, null, 2)}</Text>
          ) : (
            <Text color={theme.status.error}>{previewError}</Text>
          )}
        </Box>
        {state.busy ? (
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>Saving…</Text>
          </Box>
        ) : null}
        <ErrorLine error={state.error} />
      </Frame>
    );
  }

  return (
    <Frame title={stepTitle} footer={STEP_HINT}>
      <ErrorLine error={state.error} />
    </Frame>
  );
}

function QoderLogin({
  config,
  settings,
  region,
  onBack,
  onDone,
}: {
  readonly config: Config;
  readonly settings: LoadedSettings;
  readonly region: QoderAccountRegion;
  readonly onBack: () => void;
  readonly onDone: (selection?: AuthDoneSelection) => void;
}): React.JSX.Element {
  const [state, dispatch] = useReducer(
    (
      current: {
        readonly phase:
          | 'starting'
          | 'waiting'
          | 'loading-models'
          | 'models'
          | 'error';
        readonly authUrl?: string;
        readonly error?: string;
        readonly models?: ReadonlyArray<{
          key: string;
          displayName: string;
          isDefault: boolean;
        }>;
      },
      next: Partial<{
        readonly phase:
          | 'starting'
          | 'waiting'
          | 'loading-models'
          | 'models'
          | 'error';
        readonly authUrl?: string;
        readonly error?: string;
        readonly models?: ReadonlyArray<{
          key: string;
          displayName: string;
          isDefault: boolean;
        }>;
      }>,
    ) => ({ ...current, ...next }),
    {
      phase: 'starting' as const,
    },
  );

  const loginRef = useRef<{ cancel(): void } | undefined>(undefined);
  const cancelledRef = useRef(false);

  useRegisterActionHandlers(
    'Dialog',
    {
      'dialog:escape': () => {
        cancelledRef.current = true;
        loginRef.current?.cancel();
        loginRef.current = undefined;
        onBack();
        return true;
      },
    },
    state.phase === 'starting' || state.phase === 'waiting',
  );

  const finishLogin = async (): Promise<void> => {
    persist(settings, region);
    dispatch({ phase: 'loading-models', error: undefined });
    // The session may have started with another auth type, so the Qoder
    // provider might not exist yet; register it before listing models.
    const manager = config.getModelProviderManager();
    for (const provider of createQoderProviders(
      config.getSettingsService(),
      config.getModelTransportManager(),
      region,
    )) {
      await manager.registerAccountProvider(provider).catch((error: unknown) => {
        runLogger.warn(
          `[qoder-login] provider registration failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
    const listed = await manager.listModels({ skipCache: true }).catch(() => []);
    if (cancelledRef.current) return;
    const qoderModels = listed
      .filter((model) => model.source === QODER_PROVIDER_ID)
      .map((model) => ({
        key: model.key,
        displayName: model.displayName,
        isDefault: model.isDefault === true,
      }));
    if (qoderModels.length === 0) {
      dispatch({
        phase: 'error',
        error:
          'Signed in, but no Qoder models are available for this account. Check your network or choose another provider.',
      });
      return;
    }
    dispatch({ phase: 'models', models: qoderModels });
  };

  const start = async (): Promise<void> => {
    cancelledRef.current = false;
    dispatch({ phase: 'starting', error: undefined });
    try {
      const client = createQoderClient({ region });
      // Always run the full device flow: /auth is an explicit sign-in action,
      // so an existing account must not skip the browser step.
      const handle = client.api.auth.startDeviceLogin();
      loginRef.current = handle;
      dispatch({ phase: 'waiting', authUrl: handle.authUrl });
      if (!config.isBrowserLaunchSuppressed?.()) {
        void openBrowserSecurely(handle.authUrl).catch((error: unknown) => {
          runLogger.debug(
            `[qoder-login] could not open the browser: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
      await handle.completion;
      loginRef.current = undefined;
      if (cancelledRef.current) return;
      await finishLogin();
    } catch (error) {
      loginRef.current = undefined;
      if (cancelledRef.current) return;
      dispatch({
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  useEffect(() => {
    void start();
    return () => {
      cancelledRef.current = true;
      loginRef.current?.cancel();
      loginRef.current = undefined;
    };
    // Start once on mount; retries go through the error screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.phase === 'models') {
    return (
      <Frame title="Qoder · Select Model" footer={MENU_HINT}>
        <Text color={theme.text.secondary}>
          Choose the model this session should use, or press Esc to keep the
          current one.
        </Text>
        <Box marginTop={1}>
          <RadioButtonSelect
            showNumbers={false}
            selectionColor={theme.status.success}
            items={(state.models ?? []).map((model) => ({
              key: model.key,
              value: model.key,
              label: model.displayName,
              sublabel: model.key,
            }))}
            onSelect={(key) => onDone({ modelKey: key })}
            onCancel={() => {
              // Esc keeps an explicitly configured session model. Without one
              // the anchor still resolves to the shared 'auto' fallback, which
              // the Qoder catalog does not serve, so adopt the catalog default
              // instead of leaving the session unusable.
              const current = settings.merged.model?.name;
              if (current && current !== 'auto') {
                onDone();
                return;
              }
              const fallback =
                (state.models ?? []).find((model) => model.isDefault) ??
                state.models?.[0];
              onDone(fallback ? { modelKey: fallback.key } : undefined);
            }}
          />
        </Box>
      </Frame>
    );
  }

  return (
    <Frame
      title="Qoder Sign-in"
      footer={
        state.phase === 'waiting' ? 'Esc to cancel sign-in' : undefined
      }
    >
      {state.phase === 'starting' && (
        <Text color={theme.text.secondary}>Starting sign-in…</Text>
      )}
      {state.phase === 'loading-models' && (
        <Text color={theme.text.secondary}>Loading models…</Text>
      )}
      {state.phase === 'waiting' && (
        <Box flexDirection="column">
          <Text color={theme.text.secondary}>
            Open this URL to sign in to Qoder:
          </Text>
          <Text color={theme.text.primary}>{state.authUrl}</Text>
          <Text color={theme.text.secondary}>Waiting for authorization…</Text>
        </Box>
      )}
      {state.phase === 'error' && (
        <Box flexDirection="column">
          <Text color={theme.status.error}>{state.error}</Text>
          <RadioButtonSelect
            showNumbers={false}
            selectionColor={theme.status.success}
            items={[
              {
                key: 'retry',
                value: 'retry',
                label: 'Try again',
                sublabel: 'Start a new sign-in',
              },
              {
                key: 'back',
                value: 'back',
                label: 'Back',
                sublabel: 'Return to region selection',
              },
            ]}
            onSelect={(value) => {
              if (value === 'back') onBack();
              else void start();
            }}
          />
        </Box>
      )}
    </Frame>
  );
}

function persist(
  settings: LoadedSettings,
  region: QoderAccountRegion,
): void {
  const savedRegion = settings.setValue(
    SettingScope.User,
    'security.auth.qoderRegion',
    region,
  );
  const savedType = settings.setValue(
    SettingScope.User,
    'security.auth.selectedType',
    AuthType.QODER_OAUTH,
  );
  if (!savedRegion || !savedType) {
    throw new Error('Could not write Qoder account settings to settings.json.');
  }
}

const PURCHASE_POLL_INTERVAL_MS = 5_000;
const PURCHASE_POLL_TIMEOUT_MS = 120_000;

type QwenAccountPhase =
  | 'starting'
  | 'waiting'
  | 'purchase'
  | 'activating'
  | 'success'
  | 'error';

interface QwenAccountState {
  readonly phase: QwenAccountPhase;
  readonly authUrl?: string;
  readonly userCode?: string;
  readonly email?: string;
  readonly plan?: string;
  readonly model?: string;
  readonly message?: string;
  readonly checking?: boolean;
}

/**
 * Qwen membership sign-in: device authorization, membership confirmation and
 * model activation. Plus/Pro accounts are connected immediately; other plans
 * stay on a purchase page that polls membership until the window expires.
 */
function QwenAccountLogin({
  config,
  settings,
  onBack,
  onDone,
}: {
  readonly config: Config;
  readonly settings: LoadedSettings;
  readonly onBack: () => void;
  readonly onDone: (selection?: AuthDoneSelection) => void;
}): React.JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [state, dispatch] = useReducer(
    (current: QwenAccountState, patch: Partial<QwenAccountState>) => ({
      ...current,
      ...patch,
    }),
    { phase: 'starting' } as QwenAccountState,
  );
  const lifetime = useRef<AbortController | undefined>(undefined);
  const sessionRef = useRef<QwenSubscriptionSession | undefined>(undefined);
  const activateRef = useRef<
    ((info: QwenSubscriptionUserInfo) => Promise<void>) | undefined
  >(undefined);

  const cancel = (): void => {
    lifetime.current?.abort();
    lifetime.current = undefined;
  };

  useRegisterActionHandlers(
    'Dialog',
    {
      'dialog:escape': () => {
        cancel();
        onBack();
        return true;
      },
    },
    state.phase !== 'success',
  );

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    lifetime.current = controller;
    const session = new QwenSubscriptionSession();
    sessionRef.current = session;
    let alive = true;
    const patch = (next: Partial<QwenAccountState>): void => {
      if (alive && !signal.aborted) dispatch(next);
    };

    const activate = async (info: QwenSubscriptionUserInfo): Promise<void> => {
      patch({
        phase: 'activating',
        email: info.email,
        plan: planLabel(info.member_type),
        message: undefined,
      });
      const { models } = await session.getModels(signal);
      signal.throwIfAborted();
      const modelId = selectQwenSubscriptionModel(models);
      if (!modelId) throw new QwenSubscriptionOAuthError('models_unavailable');
      const entry = buildQwenSubscriptionProviderEntry(models);
      const savedProvider = settings.setValue(
        SettingScope.User,
        ['providers', entry.providerId],
        entry.value,
      );
      const savedAuthType = settings.setValue(
        SettingScope.User,
        'security.auth.selectedType',
        AuthType.QWEN_SUBSCRIPTION,
      );
      if (!savedProvider || !savedAuthType) {
        throw new Error(
          'Could not write Qwen account settings to settings.json.',
        );
      }
      patch({
        phase: 'success',
        email: info.email,
        plan: planLabel(info.member_type),
        model: modelId,
      });
    };
    activateRef.current = activate;

    const applyMembership = async (
      info: QwenSubscriptionUserInfo,
    ): Promise<void> => {
      if (isPaidPlan(info.member_type)) {
        await activate(info);
        return;
      }
      patch({
        phase: 'purchase',
        email: info.email,
        plan: planLabel(info.member_type),
        message: undefined,
      });
      await pollPurchase(session, signal, patch, activate);
    };

    void (async () => {
      patch({ phase: 'starting' });
      const info = await session.signIn((device) => {
        if (!alive || signal.aborted) return;
        const url = getQwenSubscriptionAuthorizationUrl(device);
        patch({
          phase: 'waiting',
          authUrl: url,
          userCode: device.user_code,
        });
        if (!config.isBrowserLaunchSuppressed?.()) {
          void openBrowserSecurely(url).catch((error: unknown) => {
            runLogger.debug(
              `[qwen-subscription] could not open the browser: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }
      }, signal);
      signal.throwIfAborted();
      await applyMembership(info);
    })().catch((error: unknown) => {
      if (signal.aborted) return;
      patch(subscriptionErrorPatch(error));
    });

    return () => {
      alive = false;
      controller.abort();
      if (lifetime.current === controller) lifetime.current = undefined;
    };
  }, [attempt, config, settings]);

  const checkAgain = (): void => {
    const session = sessionRef.current;
    const signal = lifetime.current?.signal;
    const activate = activateRef.current;
    if (!session || !signal || signal.aborted || state.checking || !activate) {
      return;
    }
    dispatch({ checking: true, message: undefined });
    void session
      .getUserInfo(signal)
      .then(async (info) => {
        if (signal.aborted) return;
        if (!info) throw new QwenSubscriptionOAuthError('session_changed');
        if (isPaidPlan(info.member_type)) {
          dispatch({ checking: false });
          await activate(info);
          return;
        }
        dispatch({
          checking: false,
          message: choosePlanMessage,
        });
      })
      .catch((error: unknown) => {
        if (!signal.aborted) dispatch(subscriptionErrorPatch(error));
      });
  };

  const switchAccount = (): void => {
    const session = sessionRef.current;
    cancel();
    void (async () => {
      await session?.signOut().catch(() => undefined);
      setAttempt((value) => value + 1);
    })();
  };

  const openPlans = (): void => {
    const url = getQwenSubscriptionPlansUrl();
    if (!config.isBrowserLaunchSuppressed?.()) {
      void openBrowserSecurely(url).catch(() => {
        dispatch({ message: `Open this page to manage your plan: ${url}` });
      });
      return;
    }
    dispatch({ message: `Open this page to manage your plan: ${url}` });
  };

  if (state.phase === 'success') {
    return (
      <Frame title="Qwen Account" footer="Enter to continue">
        <Text color={theme.text.primary}>
          Signed in as {state.email ?? 'your Qwen account'}.
        </Text>
        <Text color={theme.text.primary}>
          Plan: {state.plan ?? 'Active'} · Model: {state.model}
        </Text>
        <Box marginTop={1}>
          <RadioButtonSelect
            showNumbers={false}
            selectionColor={theme.status.success}
            items={[
              {
                key: 'continue',
                value: 'continue',
                label: 'Continue',
                sublabel: 'Start using Qwen models',
              },
            ]}
            onSelect={() =>
              onDone(
                state.model
                  ? {
                      modelKey: `${QWEN_SUBSCRIPTION_PROVIDER_ID}/${state.model}`,
                    }
                  : undefined,
              )
            }
            onCancel={() =>
              onDone(
                state.model
                  ? {
                      modelKey: `${QWEN_SUBSCRIPTION_PROVIDER_ID}/${state.model}`,
                    }
                  : undefined,
              )
            }
          />
        </Box>
      </Frame>
    );
  }

  if (state.phase === 'error') {
    return (
      <Frame title="Qwen Account" footer={MENU_HINT}>
        <Text color={theme.status.error}>
          {state.message ?? 'Qwen sign-in failed. Please try again.'}
        </Text>
        <Box marginTop={1}>
          <RadioButtonSelect
            showNumbers={false}
            selectionColor={theme.status.success}
            items={[
              {
                key: 'retry',
                value: 'retry',
                label: 'Try again',
                sublabel: 'Start a new sign-in',
              },
              {
                key: 'back',
                value: 'back',
                label: 'Back',
                sublabel: 'Return to the provider menu',
              },
            ]}
            onSelect={(value) => {
              if (value === 'back') {
                cancel();
                onBack();
              } else {
                setAttempt((current) => current + 1);
              }
            }}
            onCancel={onBack}
          />
        </Box>
      </Frame>
    );
  }

  if (state.phase === 'purchase') {
    return (
      <Frame title="Qwen Account" footer={MENU_HINT}>
        <Text color={theme.text.primary}>
          Signed in as {state.email ?? 'your Qwen account'}.
        </Text>
        <Text color={theme.text.primary}>
          Plan: {state.plan ?? 'Free'} · Qwen Code requires Plus or Pro
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.text.secondary}>
            {state.message ?? choosePlanMessage}
          </Text>
          {state.checking ? (
            <Text color={theme.text.secondary}>Checking membership…</Text>
          ) : null}
        </Box>
        <Box marginTop={1}>
          <RadioButtonSelect
            showNumbers={false}
            selectionColor={theme.status.success}
            items={[
              {
                key: 'plans',
                value: 'plans',
                label: 'View Plans',
                sublabel: 'Open the Qwen plans page in your browser',
              },
              {
                key: 'check',
                value: 'check',
                label: 'Check again',
                sublabel: 'Recheck membership after completing payment',
              },
              {
                key: 'switch',
                value: 'switch',
                label: 'Use another account',
                sublabel: 'Sign out locally and start a new sign-in',
              },
              {
                key: 'back',
                value: 'back',
                label: 'Back',
                sublabel: 'Return to the provider menu',
              },
            ]}
            onSelect={(value) => {
              if (value === 'plans') openPlans();
              else if (value === 'check') checkAgain();
              else if (value === 'switch') switchAccount();
              else {
                cancel();
                onBack();
              }
            }}
            onCancel={() => {
              cancel();
              onBack();
            }}
          />
        </Box>
      </Frame>
    );
  }

  return (
    <Frame
      title="Qwen Account"
      footer={
        state.phase === 'waiting' ? 'Esc to cancel sign-in' : undefined
      }
    >
      {state.phase === 'starting' && (
        <Text color={theme.text.secondary}>Starting sign-in…</Text>
      )}
      {state.phase === 'activating' && (
        <Text color={theme.text.secondary}>
          Signed in as {state.email ?? 'your Qwen account'}. Loading
          models…
        </Text>
      )}
      {state.phase === 'waiting' && (
        <Box flexDirection="column">
          <Text color={theme.text.secondary}>
            Open this URL to sign in to Qwen:
          </Text>
          <Text color={theme.text.primary}>{state.authUrl}</Text>
          {state.userCode ? (
            <Text color={theme.text.secondary}>
              Confirmation code: {state.userCode}
            </Text>
          ) : null}
          <Text color={theme.text.secondary}>Waiting for authorization…</Text>
        </Box>
      )}
    </Frame>
  );
}

const choosePlanMessage =
  "Your subscription isn't active yet. If you've completed payment, please wait a moment and check again.";

function isPaidPlan(memberType: string): boolean {
  const value = memberType.toLowerCase();
  return value === 'plus' || value === 'pro';
}

function planLabel(memberType: string): string {
  const value = memberType.toLowerCase();
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function isCredentialFailure(error: unknown): boolean {
  const failure = toSubscriptionOAuthError(error, 'userinfo');
  return (
    failure.code === 'session_changed' ||
    (failure.stage === 'refresh' && failure.code === 'invalid_grant')
  );
}

async function pollPurchase(
  session: QwenSubscriptionSession,
  signal: AbortSignal,
  patch: (next: Partial<QwenAccountState>) => void,
  activate: (info: QwenSubscriptionUserInfo) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + PURCHASE_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await waitFor(PURCHASE_POLL_INTERVAL_MS, signal);
    signal.throwIfAborted();
    let info: QwenSubscriptionUserInfo | null;
    try {
      info = await session.getUserInfo(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (isCredentialFailure(error)) throw error;
      continue;
    }
    if (!info) throw new QwenSubscriptionOAuthError('session_changed');
    if (isPaidPlan(info.member_type)) {
      await activate(info);
      return;
    }
  }
  patch({
    phase: 'purchase',
    checking: false,
    message: choosePlanMessage,
  });
}

function subscriptionErrorPatch(
  error: unknown,
): Partial<QwenAccountState> {
  const failure = toSubscriptionOAuthError(error, 'exchange');
  if (failure.code === 'expired_token' && failure.stage === 'exchange') {
    return {
      phase: 'error',
      message:
        'Authentication timed out. Please try again or select a different authentication method.',
    };
  }
  if (
    failure.code === 'session_changed' ||
    (failure.stage === 'refresh' && failure.code === 'invalid_grant') ||
    (failure.stage === 'userinfo' &&
      (failure.status === 401 || failure.code === 'invalid_token'))
  ) {
    return {
      phase: 'error',
      message:
        'Your login credentials are no longer valid. Run /auth to sign in again.',
    };
  }
  const messages: Record<string, string> = {
    device: 'Could not request an authorization link. Please try again.',
    exchange: 'Could not complete authorization. Please try again.',
    credentials:
      'Could not read or save Qwen credentials. Check local file permissions and disk space.',
    userinfo: "Couldn't check your subscription status. Please try again.",
    refresh: 'Could not refresh your Qwen session. Please try again.',
    revoke:
      'You are signed out locally, but the remote session could not be revoked.',
    cleanup:
      'Could not remove local Qwen credentials. Check local file permissions.',
  };
  let message =
    messages[failure.stage ?? 'exchange'] ??
    'Qwen sign-in failed. Please try again.';
  if (failure.code === 'access_denied') {
    message += ' Authorization or access was denied.';
  } else if (failure.status === 429) {
    message += ' Too many requests. Please try again later.';
  } else if (
    [
      'invalid_grant',
      'invalid_client',
      'invalid_scope',
      'invalid_request',
      'unsupported_grant_type',
    ].includes(failure.code)
  ) {
    message += ` (${failure.code})`;
  }
  return { phase: 'error', message };
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function ErrorLine({ error }: { readonly error?: string }): React.JSX.Element | null {
  return error ? (
    <Box marginTop={1}>
      <Text color={theme.status.error}>{error}</Text>
    </Box>
  ) : null;
}
