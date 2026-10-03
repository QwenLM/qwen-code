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
 * Known simplification vs ink (recorded in the gap tracker):
 *  - documentation/TOS links render as plain text (no OSC 8 in dialogs).
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard, usePaste, useRenderer } from '@opentui/react';
import type { PasteEvent } from '@opentui/core';
import { decodePasteBytes } from '@opentui/core';
import type {
  BaseUrlOption,
  Config,
  ProviderConfig,
  ProviderSetupInputs,
  ModelWireApi,
} from '@qwen-code/qwen-code-core';
import {
  ALIBABA_PROVIDERS,
  THIRD_PARTY_PROVIDERS,
  AuthEvent,
  AuthType,
  applyProviderInstallPlan,
  buildInstallPlan,
  getModelsForProviderProtocol,
  customProvider,
  findExistingProviderModels,
  findProviderByCredentials,
  findProviderById,
  getDefaultModelIds,
  getErrorMessage,
  logAuth,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import {
  createLoadedSettingsAdapter,
  getRawModelProviders,
} from '../../config/loadedSettingsAdapter.js';
import { t } from '../../i18n/index.js';
import { ICON } from '../constants.js';
import {
  useProviderSetupFlow,
  type ProviderSetupFlow,
  type SetupStep,
} from '../auth/useProviderSetupFlow.js';
import { normalizeModelIds } from '../auth/useAuth.js';
import {
  MAX_MODELS_TO_SHOW,
  MODEL_CUSTOM_INPUT_FOCUS_INDEX,
  MODEL_SEARCH_INPUT_FOCUS_INDEX,
  formatModelOptionLabel,
  modelOptionSearchText,
  type ModelOption,
} from '../auth/ProviderSetupSteps.js';
import { toOriginalKey } from './key-map.js';
import { isPrintableKeyInput } from './input-prompt-key.js';
import { normalizePastedText } from './input-prompt-model.js';
import { sanitizeTerminalText } from '../utils/textUtils.js';
import { caretSpans, useLineEdit } from './line-edit.js';
import { Shell } from './dialogs-misc.js';
import { findNextEnabledIndex } from './dialogs-core.js';
import { C } from './theme.js';
import { useBatchSafeCursor, useBatchSafeState } from './batch-cursor.js';

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
  if (step === 'wireApi') return t('API');
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
            <box flexDirection="row" alignItems="flex-start">
              <box minWidth={2} flexShrink={0}>
                <text fg={selected ? C.green : C.text}>
                  {selected ? '›' : ' '}
                </text>
              </box>
              <box flexDirection="column" flexGrow={1}>
                <text fg={selected ? C.green : C.text}>{item.label}</text>
                {item.description ? (
                  <text fg={C.dim}>{item.description}</text>
                ) : null}
              </box>
            </box>
          </box>
        );
      })}
    </box>
  );
}

/**
 * A dialog field's text with ink's software cursor: the cell under the caret
 * drawn on a background, and an empty field putting that cell on its
 * placeholder's first character so it still shows where text will start.
 */
function FieldText({
  value,
  caret,
  placeholder,
  active,
}: {
  value: string;
  caret: number;
  placeholder?: string;
  active?: boolean;
}) {
  if (value.length === 0 && placeholder) {
    if (!active) return <text fg={C.dim}>{placeholder}</text>;
    return (
      <>
        <text bg={C.accent}>{placeholder.slice(0, 1)}</text>
        <text fg={C.dim}>{placeholder.slice(1)}</text>
      </>
    );
  }
  const spans = caretSpans({ text: value, cursor: caret });
  return (
    <>
      <text fg={C.text}>{sanitizeTerminalText(spans.before)}</text>
      {/* The character belongs to the value whatever owns the focus; only the
          highlight says which field the caret is in. Dropping it while inactive
          would print a value one character shorter than the one held. */}
      {active ? (
        <text bg={C.accent}>{sanitizeTerminalText(spans.at) || ' '}</text>
      ) : (
        <text fg={C.text}>{sanitizeTerminalText(spans.at)}</text>
      )}
      <text fg={C.text}>{sanitizeTerminalText(spans.after)}</text>
    </>
  );
}

function InputLine({
  value,
  caret,
  placeholder,
  active,
  marginTop = 1,
}: {
  value: string;
  caret: number;
  placeholder?: string;
  active?: boolean;
  marginTop?: number;
}) {
  return (
    <box flexDirection="row" marginTop={marginTop}>
      <text fg={C.accent}>{'> '}</text>
      <FieldText
        value={value}
        caret={caret}
        placeholder={placeholder}
        active={active}
      />
    </box>
  );
}

/**
 * Shared single-line text-input key handling (backend ask-user parity). Returns
 * the caret offset so the row can put its cursor cell where ink's would be. The
 * submit's own verdict is what settles the field, so a step that reports nothing
 * cannot leave the latch unarmed. `retrySeq` re-arms it: on the last step a
 * `true` only means the install was fired, and when that install fails the same
 * step stays mounted for the rest of the dialog's life.
 */
function useLineInputKeys(
  value: string,
  onChange: (next: string) => void,
  onSubmit: (text: string) => boolean,
  retrySeq: number,
): number {
  const line = useLineEdit(value, onChange, retrySeq);
  useKeyboard((key) => {
    if (line.settled) return;
    const o = toOriginalKey(key);
    if (o.name === 'return' || o.name === 'enter') {
      if (onSubmit(line.text)) line.settle();
      return;
    }
    if (!line.handleKey(o) && isPrintableKeyInput(key)) {
      line.insert(key.sequence);
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
    line.insert(text);
  });
  return line.caret;
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
  const { cursor, cursorRef, setCursor } = useBatchSafeCursor(() =>
    Math.max(
      0,
      items.findIndex((item) => item.value === flow.state.protocol),
    ),
  );
  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (o.name === 'up' || o.name === 'down') {
      setCursor(findNextEnabledIndex(items, cursorRef.current, o.name));
    } else if (o.name === 'return') {
      const item = items[cursorRef.current];
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

function ApiStep({ flow }: { flow: ProviderSetupFlow }) {
  const items: RadioItem[] = [
    {
      key: 'chat-completions',
      label: t('Chat Completions'),
      value: 'chat-completions',
    },
    { key: 'responses', label: t('Responses'), value: 'responses' },
  ];
  const { cursor, cursorRef, setCursor } = useBatchSafeCursor(
    flow.state.wireApi === 'responses' ? 1 : 0,
  );
  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (o.name === 'up') setCursor(0);
    else if (o.name === 'down') setCursor(1);
    else if (o.name === 'return')
      flow.selectWireApi(items[cursorRef.current]!.value as ModelWireApi);
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
  const { cursor, cursorRef, setCursor } = useBatchSafeCursor(
    flow.state.baseUrlOptionIndex,
  );
  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (o.name === 'up' || o.name === 'down') {
      const next = findNextEnabledIndex(items, cursorRef.current, o.name);
      setCursor(next);
      // ink onHighlight parity: remember the highlighted option so a
      // go-back later restores the cursor.
      const item = items[next];
      if (item) flow.highlightBaseUrl(item.value);
    } else if (o.name === 'return') {
      const item = items[cursorRef.current];
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
  retrySeq,
}: {
  flow: ProviderSetupFlow;
  documentationUrl?: string;
  retrySeq: number;
}) {
  const caret = useLineInputKeys(
    flow.state.baseUrl,
    flow.changeBaseUrl,
    (text) => flow.submitBaseUrl(text),
    retrySeq,
  );
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={C.text}>{t('Enter the API endpoint for this protocol.')}</text>
      <InputLine
        value={flow.state.baseUrl}
        caret={caret}
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
  retrySeq,
}: {
  provider: ProviderConfig;
  flow: ProviderSetupFlow;
  retrySeq: number;
}) {
  const docUrl = resolveDocumentationUrl(provider, flow.state.baseUrl);
  const caret = useLineInputKeys(
    flow.state.apiKey,
    flow.changeApiKey,
    (text) => flow.submitApiKey(text),
    retrySeq,
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
        caret={caret}
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

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Model IDs step. Custom IDs and the recommended multi-select both feed the
 * shared flow.state.modelIds, exactly like the ink ModelIdsStep this mirrors.
 */
function ModelsStep({
  provider,
  flow,
  retrySeq,
}: {
  provider: ProviderConfig;
  flow: ProviderSetupFlow;
  retrySeq: number;
}) {
  // ink ModelIdsStep parity: rows carry the formatted label (id padded to the
  // description column plus context/thinking/modality details), the list is a
  // search-filtered window of MAX_MODELS_TO_SHOW rows, and focus is conveyed by
  // colour alone — ink draws no cursor glyph here.
  const modelOptions = useMemo<ModelOption[]>(
    () =>
      provider.models?.map((model) => ({
        key: model.id,
        value: model.id,
        label: formatModelOptionLabel(model),
      })) ?? [],
    [provider.models],
  );
  const hasSelectableModels = modelOptions.length > 0;
  const selectedModelIds = useMemo(
    () => normalizeModelIds(flow.state.modelIds),
    [flow.state.modelIds],
  );
  const recommendedIds = useMemo(
    () => new Set(modelOptions.map((item) => item.key)),
    [modelOptions],
  );
  // The handler below reads the mirror, not this value: arrows and the Space
  // that follows them arrive in one stdin read, against the render that
  // registered the handler.
  const {
    cursor: focus,
    cursorRef: focusRef,
    setCursor: setFocus,
  } = useBatchSafeCursor(MODEL_CUSTOM_INPUT_FOCUS_INDEX);
  const [customText, setCustomText] = useState(() =>
    selectedModelIds.filter((id) => !recommendedIds.has(id)).join(', '),
  );
  // Keystrokes of one burst are handled against the render that registered the
  // handler, whose `checked` set is already stale by the second Space. The
  // mirror is written synchronously so each tick sees the previous one.
  const {
    value: checked,
    ref: checkedRef,
    setValue: setChecked,
  } = useBatchSafeState<ReadonlySet<string>>(
    () => new Set(selectedModelIds.filter((id) => recommendedIds.has(id))),
  );
  const [searchText, setSearchText] = useState('');

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
      syncModelIds(next, checkedRef.current);
    },
    [syncModelIds, checkedRef],
  );

  // ink keeps this field in a TextInput whose buffer survives the list taking
  // focus, so the caret is still where it was left when Tab comes back. The
  // retry counter is the mount key: models is the last step of every preset
  // flow, so its Enter only fires the install, and a rejected install leaves
  // this very step mounted with the latch that Enter armed.
  const custom = useLineEdit(customText, updateCustom, retrySeq);
  const search = useLineEdit(searchText, setSearchText, retrySeq);

  const filtered = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    if (!query) return modelOptions;
    return modelOptions.filter((item) =>
      modelOptionSearchText(item).includes(query),
    );
  }, [modelOptions, searchText]);

  const scrollOffset =
    focus < 0
      ? 0
      : Math.max(
          0,
          Math.min(
            focus - MAX_MODELS_TO_SHOW + 1,
            filtered.length - MAX_MODELS_TO_SHOW,
          ),
        );
  const visible = filtered.slice(
    scrollOffset,
    scrollOffset + MAX_MODELS_TO_SHOW,
  );

  const toggleRecommended = useCallback(
    (id: string) => {
      const next = new Set(checkedRef.current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setChecked(next);
      syncModelIds(custom.text, next);
    },
    [custom, syncModelIds, checkedRef, setChecked],
  );

  const submit = useCallback(() => {
    if (
      flow.submitModelIds({
        modelIds: uniqueIds([
          ...normalizeModelIds(custom.text),
          ...checkedRef.current,
        ]),
      })
    ) {
      custom.settle();
    }
  }, [custom, flow, checkedRef]);

  useKeyboard((key) => {
    if (custom.settled) return;
    const o = toOriginalKey(key);
    const focused = focusRef.current;
    if (focused >= 0) {
      if (o.name === 'tab') {
        setFocus(MODEL_CUSTOM_INPUT_FOCUS_INDEX);
      } else if (o.name === 'up') {
        setFocus(focused <= 0 ? MODEL_SEARCH_INPUT_FOCUS_INDEX : focused - 1);
      } else if (o.name === 'down') {
        setFocus(Math.max(0, Math.min(focused + 1, filtered.length - 1)));
      } else if (o.name === 'space') {
        const item = filtered[focused];
        if (item) toggleRecommended(item.key);
      } else if (o.name === 'return') {
        submit();
      }
      return;
    }
    if (focused === MODEL_SEARCH_INPUT_FOCUS_INDEX) {
      if (o.name === 'up') {
        setFocus(MODEL_CUSTOM_INPUT_FOCUS_INDEX);
      } else if (o.name === 'tab' || o.name === 'down') {
        if (filtered.length > 0) setFocus(0);
      } else if (o.name === 'return' || o.name === 'enter') {
        submit();
      } else if (!search.handleKey(o) && isPrintableKeyInput(key)) {
        search.insert(key.sequence);
      }
      return;
    }
    // Custom-ID input focus.
    if (o.name === 'tab' || o.name === 'down') {
      if (hasSelectableModels) setFocus(MODEL_SEARCH_INPUT_FOCUS_INDEX);
      return;
    }
    if (o.name === 'return' || o.name === 'enter') {
      submit();
      return;
    }
    if (!custom.handleKey(o) && isPrintableKeyInput(key)) {
      custom.insert(key.sequence);
    }
  });
  // Pastes land in whichever text field owns focus; while the recommended list
  // is focused there is no text field to receive them.
  usePaste((event: PasteEvent) => {
    const focused = focusRef.current;
    const target =
      focused === MODEL_CUSTOM_INPUT_FOCUS_INDEX
        ? custom
        : focused === MODEL_SEARCH_INPUT_FOCUS_INDEX
          ? search
          : null;
    if (!target) return;
    const text = normalizePastedText(decodePasteBytes(event.bytes));
    if (!text) return;
    event.preventDefault();
    target.insert(text);
  });

  if (!hasSelectableModels) {
    const defaultIds = (provider.models ?? [])
      .map((model) => model.id)
      .join(', ');
    return (
      <box flexDirection="column" marginTop={1}>
        <box marginTop={1}>
          <text fg={C.dim}>
            {defaultIds
              ? t(
                  'Enter model IDs separated by commas. Examples: {{modelIds}}',
                  {
                    modelIds: defaultIds,
                  },
                )
              : t('Enter model IDs separated by commas.')}
          </text>
        </box>
        <InputLine
          value={customText}
          caret={custom.caret}
          placeholder={defaultIds || 'model-id-1, model-id-2'}
          active
        />
        {flow.state.modelIdsError && (
          <box marginTop={1}>
            <text fg={C.red}>{flow.state.modelIdsError}</text>
          </box>
        )}
        <box marginTop={1}>
          <text fg={C.dim}>{NAV_HINT_INPUT}</text>
        </box>
      </box>
    );
  }

  return (
    <box flexDirection="column" marginTop={1}>
      <box marginTop={1}>
        <text fg={C.dim}>
          {t(
            'Enter model IDs directly. Use commas to configure multiple models.',
          )}
        </text>
      </box>
      <InputLine
        value={customText}
        caret={custom.caret}
        placeholder="model-id"
        active={focus === MODEL_CUSTOM_INPUT_FOCUS_INDEX}
      />
      <box>
        <text fg={C.dim}>
          {t(
            'Checked recommended models are applied on submit but not copied into the input.',
          )}
        </text>
      </box>
      <box marginTop={1}>
        <text fg={C.dim}>{t('Recommended models')}</text>
      </box>
      <box flexDirection="column">
        <text fg={C.dim}>{t('Search')}</text>
        <InputLine
          value={searchText}
          caret={search.caret}
          placeholder="search"
          active={focus === MODEL_SEARCH_INPUT_FOCUS_INDEX}
          marginTop={0}
        />
      </box>
      <box flexDirection="column" marginTop={1}>
        {visible.length > 0 ? (
          visible.map((item, visibleIndex) => {
            const modelIndex = scrollOffset + visibleIndex;
            const isFocused = focus === modelIndex;
            const isSelected = checked.has(item.key);
            const color = isFocused ? C.green : isSelected ? C.accent : C.text;
            return (
              <box key={item.key} flexDirection="row" alignItems="flex-start">
                <box minWidth={4} flexShrink={0}>
                  <text fg={color}>
                    {isSelected ? ICON.RADIO_FILLED : ICON.CIRCLE_EMPTY}
                  </text>
                </box>
                <box flexGrow={1}>
                  <text fg={color}>{item.label}</text>
                </box>
              </box>
            );
          })
        ) : (
          <text fg={C.dim}>{t('No recommended models match.')}</text>
        )}
      </box>
      {flow.state.modelIdsError && (
        <box marginTop={1}>
          <text fg={C.red}>{flow.state.modelIdsError}</text>
        </box>
      )}
      <box marginTop={1}>
        <text fg={C.dim}>
          {t(
            'Enter to submit, ↑↓/Tab to switch input, search, and recommendations, Space to toggle recommendations, Esc to go back',
          )}
        </text>
      </box>
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
  const ctxField = useLineEdit(contextWindowSize, flow.changeContextWindowSize);
  useKeyboard((key) => {
    if (ctxField.settled) return;
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
      if (onCtxRow) ctxField.insert(' ');
      else flow.toggleFocusedAdvancedOption();
      return;
    }
    if (o.name === 'return') {
      flow.submitAdvancedConfig();
      ctxField.settle();
      return;
    }
    if (onCtxRow && !ctxField.handleKey(o) && isPrintableKeyInput(key)) {
      ctxField.insert(key.sequence);
    }
  });
  // Only the context-window field accepts text; a paste while another row is
  // focused should not move any toggle.
  usePaste((event: PasteEvent) => {
    if (!onCtxRow) return;
    const text = normalizePastedText(decodePasteBytes(event.bytes));
    if (!text) return;
    event.preventDefault();
    ctxField.insert(text);
  });
  const checkmark = (v: boolean) => (v ? ICON.RADIO_FILLED : ICON.CIRCLE_EMPTY);
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
        <FieldText
          value={contextWindowSize}
          caret={ctxField.caret}
          placeholder="auto"
          active={onCtxRow}
        />
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
        {flow.state.previewError ? (
          <text fg={C.red}>{flow.state.previewError}</text>
        ) : (
          <text fg={C.text}>{flow.state.previewJson}</text>
        )}
      </box>
      <box marginTop={1}>
        <text fg={C.dim}>{t('Enter to save, Esc to go back')}</text>
      </box>
    </box>
  );
}

function SetupSteps({
  flow,
  retrySeq,
}: {
  flow: ProviderSetupFlow;
  retrySeq: number;
}) {
  const { provider, step } = flow.state;
  if (!provider || !step) return null;
  switch (step) {
    case 'protocol':
      return <ProtocolStep flow={flow} />;
    case 'wireApi':
      return <ApiStep flow={flow} />;
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
          retrySeq={retrySeq}
        />
      );
    case 'apiKey':
      return <ApiKeyStep provider={provider} flow={flow} retrySeq={retrySeq} />;
    case 'models':
      return <ModelsStep provider={provider} flow={flow} retrySeq={retrySeq} />;
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
  /** Startup auth failure surfaced by the auto-open (U-6); null when the
   * dialog opened because no auth type is configured. */
  initialError?: string;
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
  initialError,
}: AuthDialogProps & { config: Config }) {
  const [errorMessage, setErrorMessage] = useState<string | null>(
    initialError ?? null,
  );
  // Every text field latches itself shut on the Enter that submits it, and only
  // a mount-key change clears that latch. On the last step the submit is async,
  // so a rejected install — or one that saved service models without a
  // conversation model — leaves the very same step on screen with every key
  // dead. Bumping this hands the field back.
  const [retrySeq, setRetrySeq] = useState(0);
  // The verdict lands whenever the install finishes, which can be after the user
  // has Esc'd back to an earlier field. Re-arming there would re-seed a field
  // that never submitted and discard the caret parked in it, so only the step
  // that fired the install may bump.
  const stepRef = useRef<SetupStep | null>(null);
  const [viewLevel, setViewLevel] = useState<ViewLevel>('main');
  const [_viewStack, setViewStack] = useState<ViewLevel[]>([]);
  const [mainIndex, setMainIndex] = useState<number | null>(null);
  const [subMenuIndex, setSubMenuIndex] = useState<Record<string, number>>({});

  // -- Submit (useAuth.handleProviderSubmit parity: same install-plan write
  // path, feedback message and auth telemetry; dialog-local error surface) --

  const handleProviderSubmit = useCallback(
    async (providerConfig: ProviderConfig, inputs: ProviderSetupInputs) => {
      let protocol = inputs.protocol ?? providerConfig.protocol;
      const stepAtSubmit = stepRef.current;
      const reArmField = () => {
        if (stepRef.current === stepAtSubmit) setRetrySeq((n) => n + 1);
      };
      try {
        const plan = buildInstallPlan(
          providerConfig,
          inputs,
          getModelsForProviderProtocol(
            settings.merged.modelProviders,
            inputs.protocol ?? providerConfig.protocol,
            settings.merged.providerProtocol,
          ),
          {
            authType: settings.merged.security?.auth?.selectedType,
            id: settings.merged.model?.name,
            baseUrl: settings.merged.model?.baseUrl,
          },
        );
        protocol = plan.authType;
        await applyProviderInstallPlan(plan, {
          settings: createLoadedSettingsAdapter(settings),
          reloadModelProviders: (mp) => config.reloadModelProvidersConfig(mp),
          syncAuthState: (authType, modelId, baseUrl) =>
            config.syncModelSelection(authType, modelId, baseUrl),
          refreshAuth: (authType) => config.refreshAuth(authType),
        });
        if (!plan.modelSelection && !config.getAuthType()) {
          setErrorMessage(
            t(
              'Service models saved. Configure a conversation model to start chatting.',
            ),
          );
          reArmField();
          return;
        }
        notify?.(
          !plan.modelSelection
            ? t('Service models saved.')
            : t(
                'Successfully configured {{provider}}. Use /model to switch models.',
                {
                  provider: providerConfig.label,
                },
              ),
        );
        if (plan.modelSelection)
          logAuth(config, new AuthEvent(protocol, 'manual', 'success'));
        onClose();
      } catch (error) {
        const msg = t('Failed to authenticate. Message: {{message}}', {
          message: getErrorMessage(error),
        });
        setErrorMessage(msg);
        reArmField();
        logAuth(config, new AuthEvent(protocol, 'manual', 'error', msg));
      }
    },
    [settings, config, notify, onClose],
  );

  const setupFlow = useProviderSetupFlow(
    handleProviderSubmit,
    settings.merged.modelProviders,
    settings.merged.providerProtocol,
    {
      authType: settings.merged.security?.auth?.selectedType,
      id: settings.merged.model?.name,
      baseUrl: settings.merged.model?.baseUrl,
    },
    getRawModelProviders(settings),
  );
  stepRef.current = setupFlow.state.step;

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

  // The saved route and ids the wizard reopens with. Both must come from the
  // same lookup: seeding the ids of a Responses install while the API step
  // defaults to Chat Completions would restamp them onto the other wire.
  const findSavedModels = (providerConfig: ProviderConfig) =>
    findExistingProviderModels(
      providerConfig,
      settings.merged.modelProviders,
      settings.merged.providerProtocol,
      {
        authType: settings.merged.security?.auth?.selectedType,
        id: settings.merged.model?.name,
        baseUrl: settings.merged.model?.baseUrl,
      },
    );

  const getExistingModelIds = (providerConfig: ProviderConfig): string[] => {
    const saved = findSavedModels(providerConfig);
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
        findSavedModels(providerConfig)?.protocol,
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
            findSavedModels(customProvider)?.protocol,
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
  // A burst of keys reaches the handler registered by the last render, so the
  // cursors it reads must be written synchronously by the movers below.
  const mainCursorRef = useRef(mainCursor);
  mainCursorRef.current = mainCursor;
  const subCursorRef = useRef(subCursor);
  subCursorRef.current = subCursor;
  const moveMain = (index: number) => {
    mainCursorRef.current = index;
    setMainIndex(index);
  };
  const moveSub = (index: number) => {
    subCursorRef.current = index;
    setSubMenuIndex((prev) => ({ ...prev, [viewLevel]: index }));
  };

  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (viewLevel === 'main') {
      if (o.name === 'up' || o.name === 'down') {
        moveMain(
          findNextEnabledIndex(MAIN_ITEMS, mainCursorRef.current, o.name),
        );
      } else if (o.name === 'return') {
        const item = MAIN_ITEMS[mainCursorRef.current];
        if (item) handleMainSelect(item.value as MainOption);
      }
      return;
    }
    if (activeSubMenu) {
      const items = activeSubMenu;
      if (o.name === 'up' || o.name === 'down') {
        moveSub(findNextEnabledIndex(items, subCursorRef.current, o.name));
      } else if (o.name === 'return') {
        const item = items[subCursorRef.current];
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
      // The swallow is for an error the dialog armed itself; a boot-seeded
      // initialError must fall through, or the auto-opened dialog could never
      // be dismissed with Esc.
      if (initialError && errorMessage === initialError) {
        // ...and falling through means reaching the unauthenticated arm when
        // no auth type exists yet, which would overwrite the boot diagnostic
        // with the must-connect message and wedge the dialog shut (R2-1).
        onClose();
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
  }, [
    renderer,
    viewLevel,
    goBack,
    errorMessage,
    initialError,
    config,
    onClose,
  ]);

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
    <Shell title={viewTitle} onClose={onClose} borderStyle="single">
      {viewLevel === 'main' && (
        <>
          <RadioList items={MAIN_ITEMS} cursor={mainCursor} />
          <box marginTop={1}>
            <text fg={C.borderDefault}>{'─'.repeat(80)}</text>
          </box>
          <box marginTop={1}>
            <text
              fg={C.text}
            >{`${t('Terms of Services and Privacy Notice')}:`}</text>
          </box>
          <box>
            <text fg={C.dim} attributes={8}>
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

      {viewLevel === 'provider-setup' && (
        <SetupSteps flow={setupFlow} retrySeq={retrySeq} />
      )}

      {errorMessage && (
        <box marginTop={1}>
          <text fg={C.red}>{errorMessage}</text>
        </box>
      )}
    </Shell>
  );
}
