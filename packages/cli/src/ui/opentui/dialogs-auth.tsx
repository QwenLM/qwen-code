/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Full /auth onboarding flow (#57, M4 fidelity pass): a native OpenTUI port
 * of ink's AuthDialog + ProviderSetupSteps. The navigation state machine
 * (main → alibaba/thirdparty-select → provider-setup), the setup-flow state
 * (useProviderSetupFlow — renderer-agnostic, reused verbatim from the ink
 * tree) and the final submit (buildInstallPlan → applyProviderInstallPlan,
 * the same write path useAuth.handleProviderSubmit drives) mirror the ink
 * implementation; only the view layer is OpenTUI.
 *
 * Known simplifications vs ink (recorded in the gap tracker):
 *  - the models step omits the recommended-list search box (list is short);
 *  - documentation/TOS links render as plain text (no OSC 8 in dialogs).
 */

import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { useKeyboard, usePaste, useRenderer } from '@opentui/react';
import type { PasteEvent } from '@opentui/core';
import { decodePasteBytes } from '@opentui/core';
import type {
  BaseUrlOption,
  Config,
  ProviderConfig,
  ProviderSetupInputs,
} from '@qwen-code/qwen-code-core';
import {
  ALIBABA_PROVIDERS,
  THIRD_PARTY_PROVIDERS,
  AuthEvent,
  AuthType,
  applyProviderInstallPlan,
  buildInstallPlan,
  customProvider,
  findExistingProviderModels,
  findProviderByCredentials,
  findProviderById,
  getDefaultModelIds,
  getErrorMessage,
  logAuth,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { createLoadedSettingsAdapter } from '../../config/loadedSettingsAdapter.js';
import { t } from '../../i18n/index.js';
import {
  useProviderSetupFlow,
  type ProviderSetupFlow,
} from '../auth/useProviderSetupFlow.js';
import { normalizeModelIds } from '../auth/useAuth.js';
import { toOriginalKey } from './key-map.js';
import { isPrintableKeyInput } from './input-prompt-key.js';
import { normalizePastedText } from './input-prompt-model.js';
import { Shell } from './dialogs-misc.js';
import { C } from './theme.js';

// ---------------------------------------------------------------------------
// Types & static data (AuthDialog parity)
// ---------------------------------------------------------------------------

type ViewLevel =
  | 'main'
  | 'alibaba-select'
  | 'thirdparty-select'
  | 'provider-setup';

type MainOption =
  | 'ALIBABA_MODELSTUDIO'
  | 'THIRD_PARTY_PROVIDERS'
  | 'CUSTOM_PROVIDER';

interface RadioItem {
  key: string;
  label: string;
  description?: string;
  value: string;
}

const MAIN_ITEMS: RadioItem[] = [
  {
    key: 'ALIBABA_MODELSTUDIO',
    label: t('Alibaba ModelStudio'),
    description: t(
      'Official recommended setup: Coding Plan, Token Plan, or Standard API Key',
    ),
    value: 'ALIBABA_MODELSTUDIO',
  },
  {
    key: 'THIRD_PARTY_PROVIDERS',
    label: t('Third-party Providers'),
    description: t('Choose a built-in provider and connect with an API key'),
    value: 'THIRD_PARTY_PROVIDERS',
  },
  {
    key: 'CUSTOM_PROVIDER',
    label: t('Custom Provider'),
    description: t(
      'Manually connect a local server, proxy, or unsupported provider',
    ),
    value: 'CUSTOM_PROVIDER',
  },
];

const PROTOCOL_ITEMS: RadioItem[] = [
  {
    key: AuthType.USE_OPENAI,
    label: t('OpenAI-compatible'),
    description: t('Standard OpenAI API format (most common)'),
    value: AuthType.USE_OPENAI,
  },
  {
    key: AuthType.USE_ANTHROPIC,
    label: t('Anthropic-compatible'),
    description: t('Anthropic Messages API format'),
    value: AuthType.USE_ANTHROPIC,
  },
  {
    key: AuthType.USE_GEMINI,
    label: t('Gemini-compatible'),
    description: t('Google Gemini API format'),
    value: AuthType.USE_GEMINI,
  },
];

const VIEW_TITLES: Record<string, string> = {
  main: t('Connect a Provider'),
  'alibaba-select': t('Alibaba ModelStudio · Access Method'),
  'thirdparty-select': t('Third-party Providers · Provider'),
};

function providerToItem(config: ProviderConfig): RadioItem {
  return {
    key: config.id,
    label: t(config.label),
    description: t(config.description),
    value: config.id,
  };
}

function getStepLabel(step: string | null, p: ProviderConfig): string {
  if (step === 'protocol') return t('Protocol');
  if (step === 'baseUrl') {
    if (p.uiLabels?.baseUrlStepTitle) return t(p.uiLabels.baseUrlStepTitle);
    return Array.isArray(p.baseUrl) ? t('Endpoint') : t('Base URL');
  }
  if (step === 'apiKey') return t('API Key');
  if (step === 'models') return t('Model IDs');
  if (step === 'advancedConfig') return t('Advanced Config');
  if (step === 'review') return t('Review');
  return '';
}

function resolveDocumentationUrl(
  config: ProviderConfig,
  baseUrl: string,
): string | undefined {
  if (!config.documentationUrl) return undefined;
  return typeof config.documentationUrl === 'function'
    ? config.documentationUrl(baseUrl)
    : config.documentationUrl;
}

const NAV_HINT_SELECT = t('Enter to select, ↑↓ to navigate, Esc to go back');
const NAV_HINT_INPUT = t('Enter to submit, Esc to go back');

// ---------------------------------------------------------------------------
// Shared view primitives
// ---------------------------------------------------------------------------

function RadioList({ items, cursor }: { items: RadioItem[]; cursor: number }) {
  return (
    <box flexDirection="column" marginTop={1}>
      {items.map((item, i) => {
        const selected = i === cursor;
        return (
          <box
            key={item.key}
            flexDirection="column"
            marginTop={i === 0 ? 0 : 1}
          >
            <box flexDirection="row">
              <text fg={selected ? C.accent : C.dim}>
                {selected ? '● ' : '○ '}
              </text>
              <text
                fg={selected ? C.text : C.dim}
                attributes={selected ? 1 : 0}
              >
                {item.label}
              </text>
            </box>
            {item.description ? (
              <box flexDirection="row" paddingLeft={2}>
                <text fg={C.dim}>{item.description}</text>
              </box>
            ) : null}
          </box>
        );
      })}
    </box>
  );
}

function InputLine({
  value,
  placeholder,
  active,
}: {
  value: string;
  placeholder?: string;
  active?: boolean;
}) {
  const empty = value.length === 0;
  return (
    <box flexDirection="row" marginTop={1} paddingLeft={1}>
      <text fg={empty ? C.dim : C.text}>
        {empty ? (placeholder ?? '') : value}
      </text>
      {active && <text fg={C.accent}>{'█'}</text>}
    </box>
  );
}

/** Shared single-line text-input key handling (backend ask-user parity). */
function useLineInputKeys(
  value: string,
  onChange: (next: string) => void,
  onSubmit: () => void,
) {
  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (o.name === 'return' || o.name === 'enter') {
      onSubmit();
      return;
    }
    if (o.name === 'backspace' || o.name === 'delete') {
      onChange(value.slice(0, -1));
      return;
    }
    if (isPrintableKeyInput(key)) {
      onChange(value + key.sequence);
    }
  });
  // Bracketed pastes arrive as one PasteEvent with no keypress per character
  // (ink parity: its keypress state machine broadcasts the buffered paste as a
  // single `paste` key, which TextInput's buffer inserts verbatim). The main
  // composer's editor is unfocused while a dialog owns input, so consume the
  // paste here instead of letting it drop.
  usePaste((event: PasteEvent) => {
    const text = normalizePastedText(decodePasteBytes(event.bytes));
    if (!text) return;
    event.preventDefault();
    onChange(value + text);
  });
}

// ---------------------------------------------------------------------------
// Setup steps (ProviderSetupSteps parity)
// ---------------------------------------------------------------------------

function ProtocolStep({ flow }: { flow: ProviderSetupFlow }) {
  const provider = flow.state.provider!;
  const items = useMemo(() => {
    const protocolOpts = provider.protocolOptions ?? [provider.protocol];
    return PROTOCOL_ITEMS.filter((p) =>
      protocolOpts.includes(p.value as AuthType),
    );
  }, [provider]);
  const [cursor, setCursor] = useState(0);
  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (o.name === 'up') {
      setCursor((c) => Math.max(0, c - 1));
    } else if (o.name === 'down') {
      setCursor((c) => Math.min(items.length - 1, c + 1));
    } else if (o.name === 'return') {
      const item = items[cursor];
      if (item) flow.selectProtocol(item.value as AuthType);
    }
  });
  return (
    <>
      <RadioList items={items} cursor={cursor} />
      <box marginTop={1}>
        <text fg={C.dim}>{NAV_HINT_SELECT}</text>
      </box>
    </>
  );
}

function BaseUrlSelectStep({
  provider,
  flow,
}: {
  provider: ProviderConfig;
  flow: ProviderSetupFlow;
}) {
  const options = provider.baseUrl as BaseUrlOption[];
  const items: RadioItem[] = options.map((opt) => ({
    key: opt.id,
    label: t(opt.label),
    description: opt.url,
    value: opt.url,
  }));
  const [cursor, setCursor] = useState(flow.state.baseUrlOptionIndex);
  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (o.name === 'up' || o.name === 'down') {
      const next =
        o.name === 'up'
          ? Math.max(0, cursor - 1)
          : Math.min(items.length - 1, cursor + 1);
      setCursor(next);
      // ink onHighlight parity: remember the highlighted option so a
      // go-back later restores the cursor.
      const item = items[next];
      if (item) flow.highlightBaseUrl(item.value);
    } else if (o.name === 'return') {
      const item = items[cursor];
      if (item) flow.selectBaseUrl(item.value);
    }
  });
  return (
    <>
      <RadioList items={items} cursor={cursor} />
      <box marginTop={1}>
        <text fg={C.dim}>{NAV_HINT_SELECT}</text>
      </box>
    </>
  );
}

function BaseUrlInputStep({
  flow,
  documentationUrl,
}: {
  flow: ProviderSetupFlow;
  documentationUrl?: string;
}) {
  useLineInputKeys(flow.state.baseUrl, flow.changeBaseUrl, () =>
    flow.submitBaseUrl(),
  );
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={C.text}>{t('Enter the API endpoint for this protocol.')}</text>
      <InputLine
        value={flow.state.baseUrl}
        placeholder={
          flow.state.baseUrlPlaceholder || 'https://api.openai.com/v1'
        }
        active
      />
      {flow.state.baseUrlError && (
        <box marginTop={1}>
          <text fg={C.red}>{flow.state.baseUrlError}</text>
        </box>
      )}
      {documentationUrl && (
        <box marginTop={1}>
          <text
            fg={C.purple}
          >{`${t('Documentation')}: ${documentationUrl}`}</text>
        </box>
      )}
      <box marginTop={1}>
        <text fg={C.dim}>{NAV_HINT_INPUT}</text>
      </box>
    </box>
  );
}

function ApiKeyStep({
  provider,
  flow,
}: {
  provider: ProviderConfig;
  flow: ProviderSetupFlow;
}) {
  const docUrl = resolveDocumentationUrl(provider, flow.state.baseUrl);
  useLineInputKeys(flow.state.apiKey, flow.changeApiKey, () =>
    flow.submitApiKey(flow.state.apiKey),
  );
  return (
    <box flexDirection="column" marginTop={1}>
      {docUrl && (
        <box marginTop={1}>
          <text fg={C.purple}>{`${t('Documentation')}: ${docUrl}`}</text>
        </box>
      )}
      <InputLine
        value={flow.state.apiKey}
        placeholder={provider.apiKeyPlaceholder ?? 'sk-...'}
        active
      />
      {flow.state.apiKeyError && (
        <box marginTop={1}>
          <text fg={C.red}>{flow.state.apiKeyError}</text>
        </box>
      )}
      <box marginTop={1}>
        <text fg={C.dim}>{NAV_HINT_INPUT}</text>
      </box>
    </box>
  );
}

const MODEL_CUSTOM_INPUT_FOCUS_INDEX = -2;

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Model IDs step. Simplified vs ink: no search box over the recommended
 * list; custom IDs and recommended multi-select both feed the shared
 * flow.state.modelIds like the ink ModelIdsStep.
 */
function ModelsStep({
  provider,
  flow,
}: {
  provider: ProviderConfig;
  flow: ProviderSetupFlow;
}) {
  const modelOptions = useMemo(
    () => provider.models?.map((m) => m.id) ?? [],
    [provider.models],
  );
  const hasSelectableModels = modelOptions.length > 0;
  const selectedModelIds = useMemo(
    () => normalizeModelIds(flow.state.modelIds),
    [flow.state.modelIds],
  );
  const recommendedIds = useMemo(() => new Set(modelOptions), [modelOptions]);
  const [focus, setFocus] = useState(MODEL_CUSTOM_INPUT_FOCUS_INDEX);
  const [customText, setCustomText] = useState(() =>
    selectedModelIds.filter((id) => !recommendedIds.has(id)).join(', '),
  );
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(selectedModelIds.filter((id) => recommendedIds.has(id))),
  );

  const syncModelIds = useCallback(
    (custom: string, keys: ReadonlySet<string>) => {
      flow.changeModelIds(
        uniqueIds([...normalizeModelIds(custom), ...keys]).join(', '),
      );
    },
    [flow],
  );

  const updateCustom = useCallback(
    (next: string) => {
      setCustomText(next);
      syncModelIds(next, checked);
    },
    [checked, syncModelIds],
  );

  const toggleRecommended = useCallback(
    (id: string) => {
      const next = new Set(checked);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setChecked(next);
      syncModelIds(customText, next);
    },
    [checked, customText, syncModelIds],
  );

  const submit = useCallback(() => {
    flow.submitModelIds({
      modelIds: uniqueIds([...normalizeModelIds(customText), ...checked]),
    });
  }, [customText, checked, flow]);

  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (focus >= 0) {
      if (o.name === 'tab') {
        setFocus(MODEL_CUSTOM_INPUT_FOCUS_INDEX);
      } else if (o.name === 'up') {
        setFocus((f) => (f <= 0 ? MODEL_CUSTOM_INPUT_FOCUS_INDEX : f - 1));
      } else if (o.name === 'down') {
        setFocus((f) => Math.min(f + 1, modelOptions.length - 1));
      } else if (o.name === 'space') {
        const id = modelOptions[focus];
        if (id) toggleRecommended(id);
      } else if (o.name === 'return') {
        submit();
      }
      return;
    }
    // Custom-ID input focus.
    if (o.name === 'tab' || o.name === 'down') {
      if (hasSelectableModels) setFocus(0);
      return;
    }
    if (o.name === 'return' || o.name === 'enter') {
      submit();
      return;
    }
    if (o.name === 'backspace' || o.name === 'delete') {
      updateCustom(customText.slice(0, -1));
      return;
    }
    if (isPrintableKeyInput(key)) {
      updateCustom(customText + key.sequence);
    }
  });
  // Pastes land in the custom-ID input only when it owns focus; while the
  // recommended list is focused there is no text field to receive them.
  usePaste((event: PasteEvent) => {
    if (focus >= 0) return;
    const text = normalizePastedText(decodePasteBytes(event.bytes));
    if (!text) return;
    event.preventDefault();
    updateCustom(customText + text);
  });

  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={C.text}>
        {t(
          'Enter model IDs directly. Use commas to configure multiple models.',
        )}
      </text>
      <InputLine value={customText} placeholder="model-id" active={focus < 0} />
      {flow.state.modelIdsError && (
        <box marginTop={1}>
          <text fg={C.red}>{flow.state.modelIdsError}</text>
        </box>
      )}
      {hasSelectableModels ? (
        <>
          <box marginTop={1}>
            <text fg={C.dim}>{t('Recommended models')}</text>
          </box>
          <box flexDirection="column" marginTop={1}>
            {modelOptions.map((id, i) => {
              const isChecked = checked.has(id);
              const focused = i === focus;
              return (
                <box key={id} flexDirection="row">
                  <text fg={focused ? C.accent : C.dim}>
                    {focused ? '› ' : '  '}
                  </text>
                  <text fg={focused ? C.accent : C.dim}>
                    {isChecked ? '◉ ' : '○ '}
                  </text>
                  <text fg={focused ? C.text : C.dim}>{id}</text>
                </box>
              );
            })}
          </box>
          <box marginTop={1}>
            <text fg={C.dim}>
              {t(
                'Tab toggles input/list, Space toggles a model, Enter to continue, Esc to go back',
              )}
            </text>
          </box>
        </>
      ) : (
        <box marginTop={1}>
          <text fg={C.dim}>{NAV_HINT_INPUT}</text>
        </box>
      )}
    </box>
  );
}

function AdvancedConfigStep({ flow }: { flow: ProviderSetupFlow }) {
  const {
    thinkingEnabled,
    modalityEnabled,
    modalityImage,
    modalityVideo,
    modalityAudio,
    modalityPdf,
    contextWindowSize,
    focusedConfigIndex,
  } = flow.state;
  const ctxIdx = modalityEnabled ? 6 : 2;
  const onCtxRow = focusedConfigIndex === ctxIdx;
  useKeyboard((key) => {
    const o = toOriginalKey(key);
    // Focus-row navigation restricted to unambiguous shortcuts (ink parity:
    // a letter typed into the context-window field must not move the row).
    if (o.name === 'up' || (o.ctrl && o.name === 'p')) {
      flow.moveAdvancedFocusUp();
      return;
    }
    if (o.name === 'down' || (o.ctrl && o.name === 'n')) {
      flow.moveAdvancedFocusDown();
      return;
    }
    if (o.name === 'space') {
      // On the context row Space inserts a space into the field; the flow's
      // toggleFocusedAdvancedOption has no case for ctxIdx (ink parity).
      if (onCtxRow) flow.changeContextWindowSize(contextWindowSize + ' ');
      else flow.toggleFocusedAdvancedOption();
      return;
    }
    if (o.name === 'return') {
      flow.submitAdvancedConfig();
      return;
    }
    if (onCtxRow) {
      if (o.name === 'backspace' || o.name === 'delete') {
        flow.changeContextWindowSize(contextWindowSize.slice(0, -1));
        return;
      }
      if (isPrintableKeyInput(key)) {
        flow.changeContextWindowSize(contextWindowSize + key.sequence);
      }
    }
  });
  // Only the context-window field accepts text; a paste while another row is
  // focused should not move any toggle.
  usePaste((event: PasteEvent) => {
    if (!onCtxRow) return;
    const text = normalizePastedText(decodePasteBytes(event.bytes));
    if (!text) return;
    event.preventDefault();
    flow.changeContextWindowSize(contextWindowSize + text);
  });
  const checkmark = (v: boolean) => (v ? '◉' : '○');
  const cursor = (index: number) => (focusedConfigIndex === index ? '›' : ' ');
  const rowFg = (index: number) =>
    focusedConfigIndex === index ? C.green : undefined;
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={C.text}>
        {t('Optional: configure advanced generation settings.')}
      </text>
      <box flexDirection="row" marginTop={1} paddingLeft={2}>
        <text fg={rowFg(0)}>
          {`${cursor(0)} ${checkmark(thinkingEnabled)} ${t('Enable thinking')}`}
        </text>
      </box>
      <box paddingLeft={4}>
        <text fg={C.dim}>
          {t(
            'Allows the model to perform extended reasoning before responding.',
          )}
        </text>
      </box>
      <box flexDirection="row" marginTop={1} paddingLeft={2}>
        <text fg={rowFg(1)}>
          {`${cursor(1)} ${checkmark(modalityEnabled)} ${t('Enable modality')}`}
        </text>
      </box>
      <box paddingLeft={4}>
        <text fg={C.dim}>
          {t('Enables multimodal input capabilities (image, video, etc.).')}
        </text>
      </box>
      {modalityEnabled && (
        <box flexDirection="row" paddingLeft={6}>
          <text
            fg={rowFg(2)}
          >{`${cursor(2)} ${checkmark(modalityImage)} Image  `}</text>
          <text
            fg={rowFg(3)}
          >{`${cursor(3)} ${checkmark(modalityVideo)} Video  `}</text>
          <text
            fg={rowFg(4)}
          >{`${cursor(4)} ${checkmark(modalityAudio)} Audio  `}</text>
          <text
            fg={rowFg(5)}
          >{`${cursor(5)} ${checkmark(modalityPdf)} PDF`}</text>
        </box>
      )}
      <box flexDirection="row" marginTop={1} paddingLeft={2}>
        <text
          fg={rowFg(ctxIdx)}
        >{`${cursor(ctxIdx)} ${t('Context window')}: `}</text>
        <text fg={onCtxRow ? C.text : C.dim}>
          {contextWindowSize || 'auto'}
        </text>
        {onCtxRow && <text fg={C.accent}>{'█'}</text>}
      </box>
      <box paddingLeft={4}>
        <text fg={C.dim}>
          {t('Max input tokens (leave empty to auto-detect from model name).')}
        </text>
      </box>
      <box marginTop={1}>
        <text fg={C.dim}>
          {t(
            '↑↓ to navigate, Space to toggle, Enter to continue, Esc to go back',
          )}
        </text>
      </box>
    </box>
  );
}

function ReviewStep({ flow }: { flow: ProviderSetupFlow }) {
  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (o.name === 'return') flow.submit();
  });
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={C.text}>
        {t('The following JSON will be saved to settings.json:')}
      </text>
      <box marginTop={1}>
        <text fg={C.text}>{flow.state.previewJson}</text>
      </box>
      <box marginTop={1}>
        <text fg={C.dim}>{t('Enter to save, Esc to go back')}</text>
      </box>
    </box>
  );
}

function SetupSteps({ flow }: { flow: ProviderSetupFlow }) {
  const { provider, step } = flow.state;
  if (!provider || !step) return null;
  switch (step) {
    case 'protocol':
      return <ProtocolStep flow={flow} />;
    case 'baseUrl':
      return Array.isArray(provider.baseUrl) ? (
        <BaseUrlSelectStep provider={provider} flow={flow} />
      ) : (
        <BaseUrlInputStep
          flow={flow}
          documentationUrl={resolveDocumentationUrl(
            provider,
            flow.state.baseUrl,
          )}
        />
      );
    case 'apiKey':
      return <ApiKeyStep provider={provider} flow={flow} />;
    case 'models':
      return <ModelsStep provider={provider} flow={flow} />;
    case 'advancedConfig':
      return <AdvancedConfigStep flow={flow} />;
    case 'review':
      return <ReviewStep flow={flow} />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// AuthDialog
// ---------------------------------------------------------------------------

type AuthDialogProps = {
  config?: Config;
  settings: LoadedSettings;
  onClose: () => void;
  /** Append a command-style message to the chat history (success feedback). */
  notify?: (text: string) => void;
};

export function OpenTuiAuthDialog(props: AuthDialogProps) {
  // Without a live config (settings-only mount) there is nothing to connect:
  // keep the pre-flow read-only summary instead of a broken wizard.
  if (!props.config) {
    return (
      <Shell title={t('Auth')} onClose={props.onClose}>
        <box flexDirection="column" marginTop={1}>
          <text fg={C.dim}>
            {t('Credentials resolved from settings/env; use /model to switch.')}
          </text>
        </box>
      </Shell>
    );
  }
  return <AuthDialogFlow {...props} config={props.config} />;
}

function AuthDialogFlow({
  config,
  settings,
  onClose,
  notify,
}: AuthDialogProps & { config: Config }) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [viewLevel, setViewLevel] = useState<ViewLevel>('main');
  const [_viewStack, setViewStack] = useState<ViewLevel[]>([]);
  const [mainIndex, setMainIndex] = useState<number | null>(null);
  const [subMenuIndex, setSubMenuIndex] = useState<Record<string, number>>({});

  // -- Submit (useAuth.handleProviderSubmit parity: same install-plan write
  // path, feedback message and auth telemetry; dialog-local error surface) --

  const handleProviderSubmit = useCallback(
    async (providerConfig: ProviderConfig, inputs: ProviderSetupInputs) => {
      const protocol = inputs.protocol ?? providerConfig.protocol;
      try {
        const plan = buildInstallPlan(providerConfig, inputs);
        await applyProviderInstallPlan(plan, {
          settings: createLoadedSettingsAdapter(settings),
          reloadModelProviders: (mp) => config.reloadModelProvidersConfig(mp),
          syncAuthState: (authType, modelId, baseUrl) =>
            config
              .getModelsConfig()
              .syncAfterAuthRefresh(authType, modelId, baseUrl),
          refreshAuth: (authType) => config.refreshAuth(authType),
        });
        notify?.(
          t(
            'Successfully configured {{provider}}. Use /model to switch models.',
            {
              provider: providerConfig.label,
            },
          ),
        );
        logAuth(config, new AuthEvent(protocol, 'manual', 'success'));
        onClose();
      } catch (error) {
        const msg = t('Failed to authenticate. Message: {{message}}', {
          message: getErrorMessage(error),
        });
        setErrorMessage(msg);
        logAuth(config, new AuthEvent(protocol, 'manual', 'error', msg));
      }
    },
    [settings, config, notify, onClose],
  );

  const setupFlow = useProviderSetupFlow(handleProviderSubmit);

  // -- Navigation (AuthDialog parity) ---------------------------------------

  const clearErrors = useCallback(() => setErrorMessage(null), []);

  const pushView = useCallback(
    (view: ViewLevel) => {
      setViewStack((prev) => [...prev, viewLevel]);
      setViewLevel(view);
    },
    [viewLevel],
  );

  const goBack = useCallback(() => {
    clearErrors();
    if (viewLevel === 'provider-setup') {
      if (setupFlow.goBack()) return;
    }
    setViewStack((prev) => {
      const next = [...prev];
      const parent = next.pop() ?? 'main';
      setViewLevel(parent);
      return next;
    });
  }, [viewLevel, setupFlow, clearErrors]);

  // -- Sub-menu items ---------------------------------------------------------

  const alibabaItems = useMemo(() => ALIBABA_PROVIDERS.map(providerToItem), []);
  const thirdPartyItems = useMemo(
    () => THIRD_PARTY_PROVIDERS.map(providerToItem),
    [],
  );

  const existingEnv = (settings.merged.env ?? {}) as Record<string, string>;

  const getExistingModelIds = (providerConfig: ProviderConfig): string[] => {
    const saved = findExistingProviderModels(
      providerConfig,
      settings.merged.modelProviders as Record<string, unknown> | undefined,
    );
    if (!saved) return [];
    const builtinIds = new Set(getDefaultModelIds(providerConfig));
    return saved.models.map((m) => m.id).filter((id) => !builtinIds.has(id));
  };

  const handleProviderSelect = useCallback(
    (providerId: string) => {
      clearErrors();
      const providerConfig = findProviderById(providerId);
      if (!providerConfig) return;
      setupFlow.start(
        providerConfig,
        undefined,
        existingEnv,
        getExistingModelIds(providerConfig),
      );
      pushView('provider-setup');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clearErrors, setupFlow, pushView, settings],
  );

  const subMenus: Record<string, RadioItem[]> = {
    'alibaba-select': alibabaItems,
    'thirdparty-select': thirdPartyItems,
  };
  const activeSubMenu = subMenus[viewLevel];

  // -- Default main index from current auth state ---------------------------

  const contentGenConfig = config.getContentGeneratorConfig();
  const matchedProvider = findProviderByCredentials(
    contentGenConfig?.baseUrl,
    contentGenConfig?.apiKeyEnvKey,
  );
  // Land on the tab matching the active provider's uiGroup (ink parity).
  const defaultMainIndex = useMemo(() => {
    if (matchedProvider?.uiGroup === 'third-party') return 1;
    if (matchedProvider?.uiGroup === 'custom') return 2;
    return 0;
  }, [matchedProvider]);

  // -- Main menu select -------------------------------------------------------

  const handleMainSelect = useCallback(
    (value: MainOption) => {
      clearErrors();
      switch (value) {
        case 'ALIBABA_MODELSTUDIO':
          pushView('alibaba-select');
          break;
        case 'THIRD_PARTY_PROVIDERS':
          pushView('thirdparty-select');
          break;
        case 'CUSTOM_PROVIDER':
          setupFlow.start(
            customProvider,
            undefined,
            existingEnv,
            getExistingModelIds(customProvider),
          );
          pushView('provider-setup');
          break;
        default:
          break;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clearErrors, pushView, setupFlow, settings],
  );

  // -- Keyboard: main / sub-menu lists --------------------------------------

  const mainCursor = mainIndex ?? defaultMainIndex;
  const subCursor = activeSubMenu ? (subMenuIndex[viewLevel] ?? 0) : 0;

  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (viewLevel === 'main') {
      if (o.name === 'up') {
        setMainIndex(Math.max(0, mainCursor - 1));
      } else if (o.name === 'down') {
        setMainIndex(Math.min(MAIN_ITEMS.length - 1, mainCursor + 1));
      } else if (o.name === 'return') {
        const item = MAIN_ITEMS[mainCursor];
        if (item) handleMainSelect(item.value as MainOption);
      }
      return;
    }
    if (activeSubMenu) {
      const items = activeSubMenu;
      if (o.name === 'up') {
        setSubMenuIndex((prev) => ({
          ...prev,
          [viewLevel]: Math.max(0, subCursor - 1),
        }));
      } else if (o.name === 'down') {
        setSubMenuIndex((prev) => ({
          ...prev,
          [viewLevel]: Math.min(items.length - 1, subCursor + 1),
        }));
      } else if (o.name === 'return') {
        const item = items[subCursor];
        if (item) handleProviderSelect(item.value);
      }
    }
  });

  // -- Esc (raw input, consumed before parsed-key dispatch) -----------------

  const renderer = useRenderer();
  useLayoutEffect(() => {
    const onRaw = (seq: string): boolean => {
      if (seq !== '\x1b') return false;
      if (viewLevel !== 'main') {
        goBack();
        return true;
      }
      if (errorMessage) return true;
      if (config.getAuthType() === undefined) {
        setErrorMessage(
          t(
            'You must connect a provider to proceed. Press Ctrl+C again to exit.',
          ),
        );
        return true;
      }
      onClose();
      return true;
    };
    renderer.addInputHandler(onRaw);
    return () => renderer.removeInputHandler(onRaw);
  }, [renderer, viewLevel, goBack, errorMessage, config, onClose]);

  // -- View title -------------------------------------------------------------

  const viewTitle = useMemo(() => {
    if (viewLevel !== 'provider-setup') {
      return VIEW_TITLES[viewLevel] ?? VIEW_TITLES['main'];
    }
    const p = setupFlow.state.provider;
    if (!p) return t('Provider Setup');
    const flowTitle = p.uiLabels?.flowTitle ?? p.label;
    const { stepIndex, totalSteps, step } = setupFlow.state;
    return t('{{flowTitle}} · Step {{step}}/{{total}} · {{stepLabel}}', {
      flowTitle,
      step: String(stepIndex),
      total: String(totalSteps),
      stepLabel: getStepLabel(step, p),
    });
  }, [viewLevel, setupFlow.state]);

  // -- Render -------------------------------------------------------------------

  return (
    <Shell title={viewTitle} onClose={onClose}>
      {viewLevel === 'main' && (
        <>
          <RadioList items={MAIN_ITEMS} cursor={mainCursor} />
          <box marginTop={2}>
            <text fg={C.dim}>{'─'.repeat(60)}</text>
          </box>
          <box marginTop={1}>
            <text
              fg={C.text}
            >{`${t('Terms of Services and Privacy Notice')}:`}</text>
          </box>
          <box>
            <text fg={C.purple}>
              {
                'https://qwenlm.github.io/qwen-code-docs/en/users/support/tos-privacy/'
              }
            </text>
          </box>
        </>
      )}

      {activeSubMenu && (
        <>
          <RadioList items={activeSubMenu} cursor={subCursor} />
          <box marginTop={1}>
            <text fg={C.dim}>{NAV_HINT_SELECT}</text>
          </box>
        </>
      )}

      {viewLevel === 'provider-setup' && <SetupSteps flow={setupFlow} />}

      {errorMessage && (
        <box marginTop={1}>
          <text fg={C.red}>{errorMessage}</text>
        </box>
      )}
    </Shell>
  );
}
