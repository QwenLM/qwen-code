/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import Link from 'ink-link';
import { DescriptiveRadioButtonSelect } from '../components/shared/DescriptiveRadioButtonSelect.js';
import { TextInput } from '../components/shared/TextInput.js';
import { theme } from '../semantic-colors.js';
import { ICON } from '../constants.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { t } from '../../i18n/index.js';
import { AuthType, getDefaultModelIds } from '@qwen-code/qwen-code-core';
import type {
  ProviderConfig,
  BaseUrlOption,
  ModelSpec,
} from '@qwen-code/qwen-code-core';
import type {
  ModelDiscoveryStatus,
  ProviderSetupFlow,
} from './useProviderSetupFlow.js';
import { normalizeModelIds } from './useAuth.js';
import { cpLen } from '../utils/textUtils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NAV_HINT_SELECT = () => (
  <Box marginTop={1}>
    <Text color={theme?.text?.secondary}>
      {t('Enter to select, ↑↓ to navigate, Esc to go back')}
    </Text>
  </Box>
);

const NAV_HINT_INPUT = () => (
  <Box marginTop={1}>
    <Text color={theme.text.secondary}>
      {t('Enter to submit, Esc to go back')}
    </Text>
  </Box>
);

function resolveDocumentationUrl(
  config: ProviderConfig,
  baseUrl: string,
): string | undefined {
  if (!config.documentationUrl) return undefined;
  return typeof config.documentationUrl === 'function'
    ? config.documentationUrl(baseUrl)
    : config.documentationUrl;
}

// ---------------------------------------------------------------------------
// Step: Select BaseURL from options
// ---------------------------------------------------------------------------

function BaseUrlSelectStep({
  config,
  flow,
}: {
  config: ProviderConfig;
  flow: ProviderSetupFlow;
}): React.JSX.Element {
  const options = config.baseUrl as BaseUrlOption[];
  const items = options.map((opt) => ({
    key: opt.id,
    title: t(opt.label),
    label: t(opt.label),
    description: <Text color={theme.text.secondary}>{opt.url}</Text>,
    value: opt.url,
  }));

  return (
    <>
      <Box marginTop={1}>
        <DescriptiveRadioButtonSelect
          items={items}
          initialIndex={flow.state.baseUrlOptionIndex}
          onSelect={flow.selectBaseUrl}
          onHighlight={flow.highlightBaseUrl}
          itemGap={1}
        />
      </Box>
      <NAV_HINT_SELECT />
    </>
  );
}

// ---------------------------------------------------------------------------
// Step: Free-form BaseURL input (custom provider)
// ---------------------------------------------------------------------------

function BaseUrlInputStep({
  flow,
  documentationUrl,
}: {
  flow: ProviderSetupFlow;
  documentationUrl?: string;
}): React.JSX.Element {
  return (
    <Box marginTop={1} flexDirection="column">
      <Box marginTop={1}>
        <Text color={theme.text.primary}>
          {t('Enter the API endpoint for this protocol.')}
        </Text>
      </Box>
      <Box marginTop={1}>
        <TextInput
          key="base-url-input"
          value={flow.state.baseUrl}
          onChange={flow.changeBaseUrl}
          onSubmit={flow.submitBaseUrl}
          placeholder={
            flow.state.baseUrlPlaceholder || 'https://api.openai.com/v1'
          }
        />
      </Box>
      {flow.state.baseUrlError && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{flow.state.baseUrlError}</Text>
        </Box>
      )}
      {documentationUrl && (
        <Box marginTop={1}>
          <Link url={documentationUrl} fallback={false}>
            <Text color={theme.text.link}>{t('Documentation')}</Text>
          </Link>
        </Box>
      )}
      <NAV_HINT_INPUT />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step: API Key input
// ---------------------------------------------------------------------------

function ApiKeyStep({
  config,
  flow,
}: {
  config: ProviderConfig;
  flow: ProviderSetupFlow;
}): React.JSX.Element {
  const docUrl = resolveDocumentationUrl(config, flow.state.baseUrl);

  return (
    <Box marginTop={1} flexDirection="column">
      {docUrl && (
        <Box marginTop={1}>
          <Link url={docUrl} fallback={false}>
            <Text color={theme.text.link}>
              {t('Documentation')}: {docUrl}
            </Text>
          </Link>
        </Box>
      )}
      <Box marginTop={1}>
        <TextInput
          key="api-key-input"
          value={flow.state.apiKey}
          onChange={flow.changeApiKey}
          onSubmit={() => flow.submitApiKey(flow.state.apiKey)}
          placeholder={config.apiKeyPlaceholder ?? 'sk-...'}
        />
      </Box>
      {flow.state.apiKeyError && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{flow.state.apiKeyError}</Text>
        </Box>
      )}
      <NAV_HINT_INPUT />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step: Model IDs input
// ---------------------------------------------------------------------------

const MODEL_DESCRIPTION_COLUMN = 28;
const MODALITY_DISPLAY_ORDER = ['image', 'video', 'audio', 'pdf'] as const;
const MODEL_CUSTOM_INPUT_FOCUS_INDEX = -2;
const MODEL_SEARCH_INPUT_FOCUS_INDEX = -1;
const MAX_RECOMMENDED_MODELS_TO_SHOW = 8;

interface ModelOption {
  key: string;
  value: string;
  label: string;
}

function formatModelOptionLabel(model: ModelSpec): string {
  const details: string[] = [];
  if (model.contextWindowSize) {
    details.push(`${model.contextWindowSize.toLocaleString('en-US')} tokens`);
  }
  if (model.enableThinking) {
    details.push('thinking');
  }
  const modalities = MODALITY_DISPLAY_ORDER.filter(
    (name) => model.modalities?.[name],
  );
  details.push(['text', ...modalities].join('/'));
  const suffix = details.length > 0 ? ` ${details.join(', ')}` : '';
  return `${model.id.padEnd(MODEL_DESCRIPTION_COLUMN)}${suffix}`;
}

function modelOptionSearchText(item: ModelOption): string {
  return `${item.key} ${item.label} ${item.value}`.toLowerCase();
}

function uniqueModelIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

function mergeModelIds(
  customModelIdsText: string,
  selectedRecommendationKeys: string[],
): string[] {
  return uniqueModelIds([
    ...normalizeModelIds(customModelIdsText),
    ...selectedRecommendationKeys,
  ]);
}

function getRecommendedSelections(
  selectedModelIds: string[],
  modelOptions: ModelOption[],
): string[] {
  const selectedSet = new Set(selectedModelIds);
  return modelOptions
    .filter((item) => selectedSet.has(item.key))
    .map((item) => item.key);
}

function getCustomModelIdsText(
  selectedModelIds: string[],
  recommendedModelIds: Set<string>,
): string {
  return selectedModelIds
    .filter((id) => !recommendedModelIds.has(id))
    .join(', ');
}

/**
 * Re-split the custom-ids input after the recommendation list was replaced,
 * working from the raw buffer text rather than the normalized flow state.
 *
 * Re-deriving from `flow.state.modelIds` round-trips the text through
 * `normalizeModelIds`, which drops a bare trailing segment. A user who had
 * typed `id1,` on the way to the second id therefore got the comma eaten by a
 * lookup resolving mid-typing, and the next character glued onto `id1` — Enter
 * then installed one concatenated id where two were meant. The separator the
 * user just typed carries no id, so no filter can drop it; only ids move.
 *
 * Ids the new list now offers move out to their checkbox, and ids that were
 * checked recommendations but are no longer on offer fall back in here, where
 * they stay visible and removable. Segments that survive are kept verbatim, so
 * a re-derive that changes no id leaves the buffer byte-identical and the
 * caller can skip the remount entirely.
 *
 * R6-2: keeping every unoffered segment verbatim would defeat the prune
 * `applyDiscoveredModels` just performed. That prune drops a built-in id the
 * endpoint does not serve "whether it was checked by default or typed" — but a
 * typed one also sits in this buffer, and the submit path never prunes again,
 * so Enter would reinstall the stale id into the provider config and every
 * later call against that endpoint would fail with model-not-found. Mirror the
 * rule here: a built-in id the new list no longer offers goes, and only
 * segments outside the built-in list (private deployments, aliases) survive
 * verbatim — exactly the ids the prune deliberately leaves alone.
 */
function resplitCustomModelIdsText(
  customModelIdsText: string,
  selectedModelIds: string[],
  recommendedModelIds: Set<string>,
  builtInModelIds: Set<string>,
): string {
  const segments = customModelIdsText.split(',');
  const hasTrailingSeparator =
    segments.length > 1 && segments[segments.length - 1].trim() === '';
  const bodySegments = hasTrailingSeparator ? segments.slice(0, -1) : segments;

  const keptIds = new Set<string>();
  const parts: string[] = [];
  for (const segment of bodySegments) {
    const id = segment.trim();
    if (id.length === 0 || recommendedModelIds.has(id) || keptIds.has(id)) {
      continue;
    }
    if (builtInModelIds.has(id)) {
      continue;
    }
    keptIds.add(id);
    parts.push(segment);
  }
  for (const id of selectedModelIds) {
    if (recommendedModelIds.has(id) || keptIds.has(id)) {
      continue;
    }
    keptIds.add(id);
    parts.push(parts.length > 0 ? ` ${id}` : id);
  }

  const body = parts.join(',');
  if (body.length === 0) {
    // Nothing is left to separate: the ids in front of the trailing comma all
    // moved to checkboxes, so an empty input is what the user should see.
    return '';
  }
  return hasTrailingSeparator
    ? `${body},${segments[segments.length - 1]}`
    : body;
}

/**
 * Inline note about where the recommendations came from. Discovery is a
 * best-effort enrichment, so a failure reads as a footnote, not an error —
 * the list below it works either way.
 */
function ModelDiscoveryNotice({
  status,
}: {
  status?: ModelDiscoveryStatus;
}): React.JSX.Element | null {
  if (status === 'loading') {
    return <Text> · {t('fetching the provider model list…')}</Text>;
  }
  if (status === 'success') {
    return <Text> · {t('from the provider')}</Text>;
  }
  if (status === 'failed') {
    return <Text> · {t('provider list unavailable, showing built-ins')}</Text>;
  }
  return null;
}

function ModelIdsStep({
  config,
  flow,
}: {
  config: ProviderConfig;
  flow: ProviderSetupFlow;
}): React.JSX.Element {
  // Recommendations come from the live endpoint when discovery succeeded and
  // from the built-in list otherwise; `recommendedModels` is undefined only
  // for callers that build flow state by hand (tests).
  const recommendedModels = flow.state.recommendedModels ?? config.models;
  const defaultIds = recommendedModels?.map((m) => m.id).join(', ') ?? '';
  const hasSelectableModels = (recommendedModels?.length ?? 0) > 0;
  const selectedModelIds = useMemo(
    () => normalizeModelIds(flow.state.modelIds),
    [flow.state.modelIds],
  );
  const modelOptions = useMemo<ModelOption[]>(
    () =>
      recommendedModels?.map((model) => ({
        key: model.id,
        value: model.id,
        label: formatModelOptionLabel(model),
      })) ?? [],
    [recommendedModels],
  );
  const recommendedModelIds = useMemo(
    () => new Set(modelOptions.map((item) => item.key)),
    [modelOptions],
  );
  // The prune in `applyDiscoveredModels` is keyed on the provider's built-in
  // list, not on whatever is currently recommended, so the re-derive below
  // needs the same key to mirror it.
  const builtInModelIds = useMemo(
    () => new Set(getDefaultModelIds(config)),
    [config],
  );
  const [focusedModelIndex, setFocusedModelIndex] = useState(
    MODEL_CUSTOM_INPUT_FOCUS_INDEX,
  );
  const [customModelIdsText, setCustomModelIdsText] = useState(() =>
    getCustomModelIdsText(selectedModelIds, recommendedModelIds),
  );
  const [selectedRecommendationKeys, setSelectedRecommendationKeys] = useState(
    () => getRecommendedSelections(selectedModelIds, modelOptions),
  );
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const filteredModelOptions = useMemo(() => {
    const normalizedQuery = modelSearchQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return modelOptions;
    }
    return modelOptions.filter((item) =>
      modelOptionSearchText(item).includes(normalizedQuery),
    );
  }, [modelOptions, modelSearchQuery]);

  // R4-6: this used to be a `key={models-${revision}}` remount at the call
  // site. That did re-derive the selection split, but it also re-ran every
  // one-shot `useState` initializer above — so a lookup that resolved while
  // the user was typing a search (a window up to the 5s discovery timeout)
  // cleared the query, snapped the list to the top and left focus on the
  // custom-ids input. The remaining keystrokes then merged into the custom
  // model IDs field, and the Enter meant for the search box submitted the
  // provider with a junk id appended. Re-derive only what the swap
  // invalidates, and leave the interaction state alone.
  const recommendedModelsRevision = flow.state.recommendedModelsRevision ?? 0;
  const [derivedModelsRevision, setDerivedModelsRevision] = useState(
    recommendedModelsRevision,
  );
  // `TextInput` seeds its buffer from `value` at mount only, so a re-derived
  // split reaches the screen only by remounting the input. Remounting also
  // sends the cursor to offset 0, which is destructive when the text did not
  // actually change — hence a key that moves only on a real edit, rather than
  // one that tracks the revision.
  const [modelIdsInputKey, setModelIdsInputKey] = useState(0);
  // R6-1 / R7-1: the remount above reseeds the caret at offset 0, and the
  // re-derive deliberately leaves focus where it was — so a swap that lands
  // while the user is mid-id sends the rest of their keystrokes to the FRONT
  // of the buffer, and Enter installs the garble. R6-1 anchored the reseed at
  // the end of the re-derived text on the premise that what is left is the
  // segment still being typed; that premise fails the moment the user arrows
  // back to fix an earlier segment. Carry the live caret out of the input
  // instead and reinstate it, clamped to the shorter text.
  const modelIdsCaretRef = useRef(0);
  const handleModelIdsCursorChange = useCallback((offset: number) => {
    modelIdsCaretRef.current = offset;
  }, []);
  const [modelIdsInputCursorOffset, setModelIdsInputCursorOffset] = useState(0);
  if (derivedModelsRevision !== recommendedModelsRevision) {
    setDerivedModelsRevision(recommendedModelsRevision);
    const nextCustomModelIdsText = resplitCustomModelIdsText(
      customModelIdsText,
      selectedModelIds,
      recommendedModelIds,
      builtInModelIds,
    );
    if (nextCustomModelIdsText !== customModelIdsText) {
      setCustomModelIdsText(nextCustomModelIdsText);
      setModelIdsInputKey((key) => key + 1);
      setModelIdsInputCursorOffset(
        Math.min(modelIdsCaretRef.current, cpLen(nextCustomModelIdsText)),
      );
    }
    setSelectedRecommendationKeys(
      getRecommendedSelections(selectedModelIds, modelOptions),
    );
    // The new list can be shorter than the old focus index. Clamp rather than
    // reset: an empty result lands on the search input the query lives in.
    setFocusedModelIndex((index) =>
      index < 0 ? index : Math.min(index, filteredModelOptions.length - 1),
    );
  }

  const recommendedScrollOffset =
    focusedModelIndex < 0
      ? 0
      : Math.max(
          0,
          Math.min(
            focusedModelIndex - MAX_RECOMMENDED_MODELS_TO_SHOW + 1,
            filteredModelOptions.length - MAX_RECOMMENDED_MODELS_TO_SHOW,
          ),
        );
  const visibleModelOptions = filteredModelOptions.slice(
    recommendedScrollOffset,
    recommendedScrollOffset + MAX_RECOMMENDED_MODELS_TO_SHOW,
  );

  const syncModelIds = useCallback(
    (customText: string, recommendationKeys: string[]) => {
      flow.changeModelIds(
        mergeModelIds(customText, recommendationKeys).join(', '),
      );
    },
    [flow],
  );

  const handleSubmitModelIds = useCallback(() => {
    flow.submitModelIds({
      modelIds: mergeModelIds(customModelIdsText, selectedRecommendationKeys),
    });
  }, [customModelIdsText, flow, selectedRecommendationKeys]);

  const handleCustomModelIdsChange = useCallback(
    (value: string) => {
      setCustomModelIdsText(value);
      syncModelIds(value, selectedRecommendationKeys);
    },
    [selectedRecommendationKeys, syncModelIds],
  );

  const toggleRecommendationAtIndex = useCallback(
    (index: number) => {
      const item = filteredModelOptions[index];
      if (!item) {
        return;
      }

      const nextSet = new Set(selectedRecommendationKeys);
      if (nextSet.has(item.key)) {
        nextSet.delete(item.key);
      } else {
        nextSet.add(item.key);
      }
      const nextKeys = modelOptions
        .filter((option) => nextSet.has(option.key))
        .map((option) => option.key);
      setSelectedRecommendationKeys(nextKeys);
      syncModelIds(customModelIdsText, nextKeys);
    },
    [
      customModelIdsText,
      filteredModelOptions,
      modelOptions,
      selectedRecommendationKeys,
      syncModelIds,
    ],
  );

  useKeypress(
    (key) => {
      if (focusedModelIndex < 0) {
        return;
      }

      if (key.name === 'tab') {
        setFocusedModelIndex(MODEL_CUSTOM_INPUT_FOCUS_INDEX);
        return;
      }

      if (key.name === 'up') {
        setFocusedModelIndex((index) =>
          index <= 0 ? MODEL_SEARCH_INPUT_FOCUS_INDEX : index - 1,
        );
        return;
      }

      if (key.name === 'down') {
        setFocusedModelIndex((index) =>
          Math.max(0, Math.min(index + 1, filteredModelOptions.length - 1)),
        );
        return;
      }

      if (key.name === 'space' || key.sequence === ' ') {
        toggleRecommendationAtIndex(focusedModelIndex);
        return;
      }

      if (key.name === 'return') {
        handleSubmitModelIds();
        return;
      }
    },
    { isActive: hasSelectableModels && focusedModelIndex >= 0 },
  );

  if (hasSelectableModels) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t(
              'Enter model IDs directly. Use commas to configure multiple models.',
            )}
          </Text>
        </Box>
        <Box marginTop={1}>
          <TextInput
            // `TextInput` seeds an uncontrolled buffer from `value` at mount,
            // so the re-derived split above only reaches the screen if this
            // one input remounts. Keying it on an edit counter does that
            // without taking the search query and focus down with it (which is
            // what remounting the whole step used to do) and without resetting
            // the cursor on a swap that left the text alone.
            key={`model-ids-input-${modelIdsInputKey}`}
            value={customModelIdsText}
            initialCursorOffset={modelIdsInputCursorOffset}
            onCursorChange={handleModelIdsCursorChange}
            onChange={handleCustomModelIdsChange}
            onSubmit={handleSubmitModelIds}
            onDown={() => {
              setFocusedModelIndex(MODEL_SEARCH_INPUT_FOCUS_INDEX);
            }}
            onTab={() => {
              setFocusedModelIndex(MODEL_SEARCH_INPUT_FOCUS_INDEX);
            }}
            placeholder="model-id"
            height={3}
            isActive={focusedModelIndex === MODEL_CUSTOM_INPUT_FOCUS_INDEX}
          />
        </Box>
        <Box marginTop={0}>
          <Text color={theme.text.secondary}>
            {t(
              'Checked recommended models are applied on submit but not copied into the input.',
            )}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t('Recommended models')}
            <ModelDiscoveryNotice status={flow.state.discoveryStatus} />
          </Text>
        </Box>
        <Box marginTop={0} flexDirection="column">
          <Text color={theme.text.secondary}>{t('Search')}</Text>
          <TextInput
            key="model-search-input"
            value={modelSearchQuery}
            onChange={setModelSearchQuery}
            onSubmit={handleSubmitModelIds}
            onUp={() => setFocusedModelIndex(MODEL_CUSTOM_INPUT_FOCUS_INDEX)}
            onDown={() => {
              if (filteredModelOptions.length > 0) {
                setFocusedModelIndex(0);
              }
            }}
            onTab={() => {
              if (filteredModelOptions.length > 0) {
                setFocusedModelIndex(0);
              }
            }}
            placeholder="search"
            isActive={focusedModelIndex === MODEL_SEARCH_INPUT_FOCUS_INDEX}
          />
        </Box>
        <Box marginTop={1} flexDirection="column">
          {visibleModelOptions.length > 0 ? (
            visibleModelOptions.map((item, visibleIndex) => {
              const modelIndex = recommendedScrollOffset + visibleIndex;
              const isFocused = focusedModelIndex === modelIndex;
              const isSelected = selectedRecommendationKeys.includes(item.key);
              const textColor = isFocused
                ? theme.status.success
                : isSelected
                  ? theme.text.accent
                  : theme.text.primary;
              return (
                <Box key={item.key} alignItems="flex-start">
                  <Box minWidth={4} flexShrink={0}>
                    <Text color={textColor}>
                      {isSelected ? ICON.RADIO_FILLED : ICON.CIRCLE_EMPTY}
                    </Text>
                  </Box>
                  <Box flexGrow={1}>
                    <Text color={textColor}>{item.label}</Text>
                  </Box>
                </Box>
              );
            })
          ) : (
            <Text color={theme.text.secondary}>
              {t('No recommended models match.')}
            </Text>
          )}
        </Box>
        {flow.state.modelIdsError && (
          <Box marginTop={1}>
            <Text color={theme.status.error}>{flow.state.modelIdsError}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t(
              'Enter to submit, ↑↓/Tab to switch input, search, and recommendations, Space to toggle recommendations, Esc to go back',
            )}
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box marginTop={1} flexDirection="column">
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {defaultIds
            ? t('Enter model IDs separated by commas. Examples: {{modelIds}}', {
                modelIds: defaultIds,
              })
            : t('Enter model IDs separated by commas.')}
        </Text>
      </Box>
      <Box marginTop={1}>
        <TextInput
          key="model-ids-input"
          value={flow.state.modelIds}
          onChange={flow.changeModelIds}
          onSubmit={() => flow.submitModelIds()}
          placeholder={defaultIds || 'model-id-1, model-id-2'}
        />
      </Box>
      {flow.state.modelIdsError && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{flow.state.modelIdsError}</Text>
        </Box>
      )}
      <NAV_HINT_INPUT />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step: Advanced config
// ---------------------------------------------------------------------------

function AdvancedConfigStep({
  flow,
}: {
  flow: ProviderSetupFlow;
}): React.JSX.Element {
  const {
    focusedConfigIndex,
    thinkingEnabled,
    modalityEnabled,
    modalityImage,
    modalityVideo,
    modalityAudio,
    modalityPdf,
    contextWindowSize,
  } = flow.state;
  const checkmark = (v: boolean) => (v ? ICON.RADIO_FILLED : ICON.CIRCLE_EMPTY);
  const cursor = (index: number) => (focusedConfigIndex === index ? '›' : ' ');

  const ctxIdx = modalityEnabled ? 6 : 2;

  return (
    <Box marginTop={1} flexDirection="column">
      <Box marginTop={1}>
        <Text color={theme.text.primary}>
          {t('Optional: configure advanced generation settings.')}
        </Text>
      </Box>
      <Box marginTop={1} marginLeft={2}>
        <Text
          color={focusedConfigIndex === 0 ? theme.status.success : undefined}
        >
          {cursor(0)} {checkmark(thinkingEnabled)} {t('Enable thinking')}
        </Text>
      </Box>
      <Box marginTop={0} marginLeft={4}>
        <Text color={theme.text.secondary}>
          {t(
            'Allows the model to perform extended reasoning before responding.',
          )}
        </Text>
      </Box>
      <Box marginTop={1} marginLeft={2}>
        <Text
          color={focusedConfigIndex === 1 ? theme.status.success : undefined}
        >
          {cursor(1)} {checkmark(modalityEnabled)} {t('Enable modality')}
        </Text>
      </Box>
      <Box marginTop={0} marginLeft={4}>
        <Text color={theme.text.secondary}>
          {t('Enables multimodal input capabilities (image, video, etc.).')}
        </Text>
      </Box>
      {modalityEnabled && (
        <Box marginTop={0} marginLeft={6}>
          <Text
            color={focusedConfigIndex === 2 ? theme.status.success : undefined}
          >
            {cursor(2)} {checkmark(modalityImage)} {'Image  '}
          </Text>
          <Text
            color={focusedConfigIndex === 3 ? theme.status.success : undefined}
          >
            {cursor(3)} {checkmark(modalityVideo)} {'Video  '}
          </Text>
          <Text
            color={focusedConfigIndex === 4 ? theme.status.success : undefined}
          >
            {cursor(4)} {checkmark(modalityAudio)} {'Audio  '}
          </Text>
          <Text
            color={focusedConfigIndex === 5 ? theme.status.success : undefined}
          >
            {cursor(5)} {checkmark(modalityPdf)} {'PDF'}
          </Text>
        </Box>
      )}
      <Box marginTop={1} marginLeft={2}>
        <Text
          color={
            focusedConfigIndex === ctxIdx ? theme.status.success : undefined
          }
        >
          {cursor(ctxIdx)} {t('Context window')}:{' '}
        </Text>
        <TextInput
          value={contextWindowSize}
          onChange={flow.changeContextWindowSize}
          placeholder="auto"
          isActive={focusedConfigIndex === ctxIdx}
        />
      </Box>
      <Box marginTop={0} marginLeft={4}>
        <Text color={theme.text.secondary}>
          {t('Max input tokens (leave empty to auto-detect from model name).')}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t(
            '↑↓ to navigate, Space to toggle, Enter to continue, Esc to go back',
          )}
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step: Review JSON
// ---------------------------------------------------------------------------

function ReviewStep({ flow }: { flow: ProviderSetupFlow }): React.JSX.Element {
  return (
    <Box marginTop={1} flexDirection="column">
      <Box marginTop={1}>
        <Text color={theme.text.primary}>
          {t('The following JSON will be saved to settings.json:')}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>{flow.state.previewJson}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t('Enter to save, Esc to go back')}
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Protocol options
// ---------------------------------------------------------------------------

const PROTOCOL_ITEMS = [
  {
    key: AuthType.USE_OPENAI,
    title: t('OpenAI-compatible'),
    label: t('OpenAI-compatible'),
    description: t('Standard OpenAI API format (most common)'),
    value: AuthType.USE_OPENAI,
  },
  {
    key: AuthType.USE_ANTHROPIC,
    title: t('Anthropic-compatible'),
    label: t('Anthropic-compatible'),
    description: t('Anthropic Messages API format'),
    value: AuthType.USE_ANTHROPIC,
  },
  {
    key: AuthType.USE_GEMINI,
    title: t('Gemini-compatible'),
    label: t('Gemini-compatible'),
    description: t('Google Gemini API format'),
    value: AuthType.USE_GEMINI,
  },
];

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface ProviderSetupStepsProps {
  flow: ProviderSetupFlow;
}

export function ProviderSetupSteps({
  flow,
}: ProviderSetupStepsProps): React.JSX.Element | null {
  const { provider, step } = flow.state;

  // Keyboard handling for steps that need it (advancedConfig, review)
  useKeypress(
    (key) => {
      if (step === 'advancedConfig') {
        // The context-window row has an embedded TextInput that's conditionally
        // active. Restrict the focus-row navigation to unambiguous shortcuts —
        // arrow keys and the readline-style Ctrl+P/Ctrl+N — so typing a letter
        // into the context-window field never simultaneously moves the focus.
        const isFocusUp = key.name === 'up' || (key.ctrl && key.name === 'p');
        const isFocusDown =
          key.name === 'down' || (key.ctrl && key.name === 'n');
        if (isFocusUp) {
          flow.moveAdvancedFocusUp();
          return;
        }
        if (isFocusDown) {
          flow.moveAdvancedFocusDown();
          return;
        }
        if (key.name === 'space') {
          flow.toggleFocusedAdvancedOption();
          return;
        }
        if (key.name === 'return') {
          flow.submitAdvancedConfig();
          return;
        }
      }

      if (step === 'review' && key.name === 'return') {
        flow.submit();
      }
    },
    { isActive: step === 'advancedConfig' || step === 'review' },
  );

  if (!provider || !step) return null;

  switch (step) {
    case 'protocol': {
      const protocolOpts = provider.protocolOptions ?? [provider.protocol];
      const items = PROTOCOL_ITEMS.filter((p) =>
        protocolOpts.includes(p.value as AuthType),
      );
      return (
        <>
          <Box marginTop={1}>
            <DescriptiveRadioButtonSelect
              items={items}
              initialIndex={0}
              onSelect={flow.selectProtocol}
              itemGap={1}
            />
          </Box>
          <NAV_HINT_SELECT />
        </>
      );
    }

    case 'baseUrl':
      if (Array.isArray(provider.baseUrl)) {
        return <BaseUrlSelectStep config={provider} flow={flow} />;
      }
      return (
        <BaseUrlInputStep
          flow={flow}
          documentationUrl={resolveDocumentationUrl(
            provider,
            flow.state.baseUrl,
          )}
        />
      );

    case 'apiKey':
      return <ApiKeyStep config={provider} flow={flow} />;

    case 'models':
      // The checkbox and custom-input split re-derives against a replaced
      // recommendation list inside the step (see `derivedModelsRevision`),
      // not by remounting it from here: a remount also wiped the in-progress
      // search query and dropped focus onto the custom-ids input.
      return <ModelIdsStep config={provider} flow={flow} />;

    case 'advancedConfig':
      return <AdvancedConfigStep flow={flow} />;

    case 'review':
      return <ReviewStep flow={flow} />;

    default:
      return null;
  }
}
