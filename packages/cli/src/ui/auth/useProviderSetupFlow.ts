/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  AuthType,
  shouldShowStep,
  resolveBaseUrl,
  getDefaultBaseUrlForProtocol,
  getDefaultModelIds,
  fetchProviderModelIds,
  mergeDiscoveredModels,
} from '@qwen-code/qwen-code-core';
import type {
  InputModalities,
  ModelSpec,
  ProviderConfig,
  ProviderSetupInputs,
} from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import { normalizeModelIds, maskApiKey } from './useAuth.js';

// ---------------------------------------------------------------------------
// Setup step names (generic, config-driven)
// ---------------------------------------------------------------------------

export type SetupStep =
  | 'protocol'
  | 'baseUrl'
  | 'apiKey'
  | 'models'
  | 'advancedConfig'
  | 'review';

const STEP_ORDER: SetupStep[] = [
  'protocol',
  'baseUrl',
  'apiKey',
  'models',
  'advancedConfig',
  'review',
];

/**
 * Lifecycle of the optional `GET {baseUrl}/models` lookup that backs the
 * recommendation list. `failed` covers every reason the endpoint did not
 * answer usefully — the wizard treats them all the same way, by showing the
 * built-in list — and is never fatal to the flow.
 */
export type ModelDiscoveryStatus = 'idle' | 'loading' | 'success' | 'failed';

function getVisibleSteps(config: ProviderConfig): SetupStep[] {
  return STEP_ORDER.filter((step) => {
    if (step === 'review') return config.showAdvancedConfig === true;
    return shouldShowStep(config, step);
  });
}

// ---------------------------------------------------------------------------
// State type
// ---------------------------------------------------------------------------

export interface ProviderSetupState {
  provider: ProviderConfig | null;
  step: SetupStep | null;
  stepIndex: number;
  totalSteps: number;

  // Protocol (for custom provider)
  protocol: AuthType;

  // BaseUrl
  baseUrl: string;
  baseUrlPlaceholder: string;
  baseUrlOptionIndex: number;
  baseUrlError: string | null;

  // API Key
  apiKey: string;
  apiKeyError: string | null;

  // Model IDs
  modelIds: string;
  modelIdsError: string | null;

  /**
   * Models to offer as recommendations — the live list when discovery
   * succeeded, the provider's built-in list otherwise.
   */
  recommendedModels: ModelSpec[];
  discoveryStatus: ModelDiscoveryStatus;
  /**
   * Bumped whenever `recommendedModels` is replaced, so the model step can
   * re-derive its local checkbox state from the new list.
   */
  recommendedModelsRevision: number;

  // Advanced config
  thinkingEnabled: boolean;
  modalityEnabled: boolean;
  modalityImage: boolean;
  modalityVideo: boolean;
  modalityAudio: boolean;
  modalityPdf: boolean;
  contextWindowSize: string;
  focusedConfigIndex: number;

  // Preview
  previewJson: string;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useProviderSetupFlow(
  onSubmit: (
    config: ProviderConfig,
    inputs: ProviderSetupInputs,
  ) => Promise<void>,
) {
  const [provider, setProvider] = useState<ProviderConfig | null>(null);
  const [visibleSteps, setVisibleSteps] = useState<SetupStep[]>([]);
  const [stepIndex, setStepIndex] = useState(0);

  const [protocol, setProtocol] = useState<AuthType>(AuthType.USE_OPENAI);
  const [baseUrl, setBaseUrl] = useState('');
  const [baseUrlPlaceholder, setBaseUrlPlaceholder] = useState('');
  const [baseUrlOptionIndex, setBaseUrlOptionIndex] = useState(0);
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [modelIds, setModelIds] = useState('');
  const [modelIdsError, setModelIdsError] = useState<string | null>(null);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [modalityEnabled, setModalityEnabled] = useState(false);
  const [modalityImage, setModalityImage] = useState(true);
  const [modalityVideo, setModalityVideo] = useState(true);
  const [modalityAudio, setModalityAudio] = useState(false);
  const [modalityPdf, setModalityPdf] = useState(false);
  const [contextWindowSize, setContextWindowSize] = useState('');
  const [focusedConfigIndex, setFocusedConfigIndex] = useState(0);
  const [discoveredModels, setDiscoveredModels] = useState<ModelSpec[] | null>(
    null,
  );
  const [discoveryStatus, setDiscoveryStatus] =
    useState<ModelDiscoveryStatus>('idle');
  const [recommendedModelsRevision, setRecommendedModelsRevision] = useState(0);
  // Discovery runs once per (baseUrl, apiKey) pair per wizard session: the
  // model step is cheap to re-enter (Esc, then Enter) and the answer cannot
  // change in between.
  const discoveryCacheRef = useRef(new Map<string, ModelSpec[]>());
  const discoveryKeyRef = useRef<string | null>(null);
  const discoveryAbortRef = useRef<AbortController | null>(null);
  // Mirrors `discoveredModels` so the discovery effect can tell whether the
  // displayed list actually changes without taking the state as a dependency
  // (which would re-run the effect on its own result).
  const discoveredModelsRef = useRef<ModelSpec[] | null>(null);

  const currentStep = visibleSteps[stepIndex] ?? null;

  // -- Model discovery ------------------------------------------------------

  const resetDiscovery = useCallback(() => {
    discoveryAbortRef.current?.abort();
    discoveryAbortRef.current = null;
    discoveryKeyRef.current = null;
    discoveredModelsRef.current = null;
    setDiscoveredModels(null);
    setDiscoveryStatus('idle');
  }, []);

  /**
   * Swap the recommendation list the model step renders. The revision bump is
   * what remounts `ModelIdsStep` so its checkbox and custom-input state is
   * re-derived; it is skipped when the list is unchanged, because a spurious
   * remount would wipe the user's in-progress search and focus for nothing.
   */
  const replaceRecommendations = useCallback((models: ModelSpec[] | null) => {
    const previous = discoveredModelsRef.current;
    discoveredModelsRef.current = models;
    setDiscoveredModels(models);
    if (previous !== models) {
      setRecommendedModelsRevision((revision) => revision + 1);
    }
  }, []);

  // Abort an in-flight lookup when the dialog goes away — nothing is left to
  // render its result into.
  useEffect(() => () => discoveryAbortRef.current?.abort(), []);

  const applyDiscoveredModels = useCallback(
    (config: ProviderConfig, models: ModelSpec[]) => {
      replaceRecommendations(models);
      setDiscoveryStatus('success');

      // Drop built-in ids the endpoint no longer serves from the pending
      // selection — leaving them checked would install exactly the stale
      // entries discovery exists to avoid. Ids the user typed are left alone;
      // they may be legitimately unlisted (private deployments, aliases).
      const served = new Set(models.map((model) => model.id));
      const builtIn = new Set(getDefaultModelIds(config));
      setModelIds((previous) => {
        const kept = normalizeModelIds(previous).filter(
          (id) => served.has(id) || !builtIn.has(id),
        );
        // Pruning everything would leave the step with nothing checked and no
        // way to submit; fall back to the provider's first live model.
        if (kept.length === 0 && models[0]) kept.push(models[0].id);
        return kept.join(', ');
      });
    },
    [replaceRecommendations],
  );

  useEffect(() => {
    if (currentStep !== 'models') return;
    if (!provider?.supportsModelDiscovery) return;

    const resolvedBaseUrl = baseUrl.trim();
    const resolvedApiKey = apiKey.trim();
    if (!resolvedBaseUrl) return;

    const discoveryKey = JSON.stringify([resolvedBaseUrl, resolvedApiKey]);
    if (discoveryKeyRef.current === discoveryKey) return;
    discoveryKeyRef.current = discoveryKey;

    // The pair changed, so any lookup still in flight is for a pair the user
    // has moved off. Abort before either branch below: a cache hit that
    // returned early used to leave it running, and it would then apply the
    // abandoned pair's result over the current one.
    discoveryAbortRef.current?.abort();
    discoveryAbortRef.current = null;

    const cached = discoveryCacheRef.current.get(discoveryKey);
    if (cached) {
      applyDiscoveredModels(provider, cached);
      return;
    }

    const controller = new AbortController();
    discoveryAbortRef.current = controller;
    // Until this pair answers, the previous pair's list is not an answer for
    // it — keep the notice ("fetching…") honest by falling back to the
    // built-ins, and bump the revision so the mounted step re-derives its
    // checkbox state against what is actually on screen.
    replaceRecommendations(null);
    setDiscoveryStatus('loading');

    void (async () => {
      const result = await fetchProviderModelIds({
        baseUrl: resolvedBaseUrl,
        apiKey: resolvedApiKey,
        signal: controller.signal,
      });
      // `aborted` covers unmount; the key check covers a pair change that
      // raced this continuation — the abort above happens on the next effect
      // run, which can land after this await resolved.
      if (controller.signal.aborted) return;
      if (discoveryKeyRef.current !== discoveryKey) return;
      if (!result.ok) {
        // Every failure mode lands here on purpose: the built-in list is a
        // working answer, so the step stays usable and says so quietly.
        // The list on screen changes back to the built-ins, so the mounted
        // step must re-derive rather than keep checkbox state pointing at ids
        // the built-in list does not offer.
        replaceRecommendations(null);
        setDiscoveryStatus('failed');
        // A failure caches nothing, so releasing the pair key lets a later
        // re-entry retry it. Claiming the key for the session would freeze a
        // transient 429/timeout into "built-ins only" with no way back.
        discoveryKeyRef.current = null;
        return;
      }
      const merged = mergeDiscoveredModels(provider.models, result.ids);
      discoveryCacheRef.current.set(discoveryKey, merged);
      applyDiscoveredModels(provider, merged);
    })();
  }, [
    currentStep,
    provider,
    baseUrl,
    apiKey,
    applyDiscoveredModels,
    replaceRecommendations,
  ]);

  // -- Lifecycle ------------------------------------------------------------

  const start = useCallback(
    (
      config: ProviderConfig,
      initialProtocol?: AuthType,
      existingEnv?: Record<string, string>,
      existingModelIds?: string[],
    ) => {
      setProvider(config);
      const steps = getVisibleSteps(config);
      setVisibleSteps(steps);
      setStepIndex(0);

      const proto = initialProtocol ?? config.protocol;
      setProtocol(proto);
      // For presets the baseUrl is fixed (string) or selected from options;
      // for the custom provider it's empty and the placeholder hints at the
      // default endpoint for the chosen protocol.
      const resolved = resolveBaseUrl(config);
      setBaseUrl(resolved);
      setBaseUrlPlaceholder(
        resolved ? '' : getDefaultBaseUrlForProtocol(proto),
      );
      setBaseUrlOptionIndex(0);
      setBaseUrlError(null);

      let prefillKey = '';
      if (existingEnv) {
        const envKeyName =
          typeof config.envKey === 'function'
            ? config.envKey(proto, resolved)
            : config.envKey;
        prefillKey = existingEnv[envKeyName] ?? '';
      }
      setApiKey(prefillKey);

      setApiKeyError(null);
      // Built-in defaults go to the recommended list (checked), user-added
      // custom IDs go to the input box. The ModelIdsStep component splits
      // flow.state.modelIds automatically based on config.models.
      const defaultIds = getDefaultModelIds(config);
      const customIds = existingModelIds ?? [];
      setModelIds([...defaultIds, ...customIds].join(', '));
      setModelIdsError(null);
      setThinkingEnabled(false);
      setModalityEnabled(false);
      setModalityImage(true);
      setModalityVideo(true);
      setModalityAudio(false);
      setModalityPdf(false);
      setContextWindowSize('');
      setFocusedConfigIndex(0);
      resetDiscovery();
    },
    [resetDiscovery],
  );

  const reset = useCallback(() => {
    setProvider(null);
    setVisibleSteps([]);
    setStepIndex(0);
    resetDiscovery();
  }, [resetDiscovery]);

  const goBack = useCallback((): boolean => {
    if (stepIndex > 0) {
      setStepIndex((i) => i - 1);
      return true;
    }
    reset();
    return false;
  }, [stepIndex, reset]);

  const goNext = useCallback(() => {
    setStepIndex((i) => Math.min(i + 1, visibleSteps.length - 1));
  }, [visibleSteps]);

  // -- Step handlers --------------------------------------------------------

  const selectProtocol = useCallback(
    (selectedProtocol: AuthType) => {
      setProtocol(selectedProtocol);
      // Clear baseUrl so the user types fresh; show the protocol's default
      // endpoint as a placeholder (used if they submit blank).
      setBaseUrl('');
      setBaseUrlPlaceholder(getDefaultBaseUrlForProtocol(selectedProtocol));
      setApiKey('');
      setApiKeyError(null);
      goNext();
    },
    [goNext],
  );

  const selectBaseUrl = useCallback(
    (selectedUrl: string) => {
      setBaseUrl(selectedUrl);
      setBaseUrlError(null);
      goNext();
    },
    [goNext],
  );

  const submitBaseUrl = useCallback((): boolean => {
    // Empty input falls back to the placeholder default so the visible hint
    // matches what gets written.
    const effective = baseUrl.trim() || baseUrlPlaceholder.trim();
    if (!effective) {
      setBaseUrlError(t('Base URL cannot be empty.'));
      return false;
    }
    if (!/^https?:\/\//i.test(effective)) {
      setBaseUrlError(t('Base URL must start with http:// or https://.'));
      return false;
    }
    if (!baseUrl.trim()) {
      setBaseUrl(effective);
    }
    setBaseUrlError(null);
    goNext();
    return true;
  }, [baseUrl, baseUrlPlaceholder, goNext]);

  const changeBaseUrl = useCallback((value: string) => {
    setBaseUrl(value);
    setBaseUrlError(null);
  }, []);

  const changeApiKey = useCallback((value: string) => {
    setApiKey(value);
    setApiKeyError(null);
  }, []);

  // Shared helper: assemble ProviderSetupInputs from current form state
  const buildCurrentInputs = useCallback(
    (overrides?: Partial<ProviderSetupInputs>): ProviderSetupInputs => ({
      protocol: provider?.protocolOptions ? protocol : undefined,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      modelIds: normalizeModelIds(modelIds),
      ...overrides,
    }),
    [provider, protocol, baseUrl, apiKey, modelIds],
  );

  const submitOrNext = useCallback(
    (overrides?: Partial<ProviderSetupInputs>) => {
      if (stepIndex >= visibleSteps.length - 1) {
        if (provider) void onSubmit(provider, buildCurrentInputs(overrides));
      } else {
        goNext();
      }
    },
    [stepIndex, visibleSteps, provider, onSubmit, buildCurrentInputs, goNext],
  );

  const submitApiKey = useCallback(
    (keyOverride?: string): boolean => {
      const trimmed = (keyOverride ?? apiKey).trim();
      if (!trimmed) {
        setApiKeyError(t('API key cannot be empty.'));
        return false;
      }
      if (provider?.validateApiKey) {
        const err = provider.validateApiKey(trimmed, baseUrl);
        if (err) {
          setApiKeyError(err);
          return false;
        }
      }
      setApiKeyError(null);
      setApiKey(trimmed);
      submitOrNext({ apiKey: trimmed });
      return true;
    },
    [apiKey, provider, baseUrl, submitOrNext],
  );

  const highlightBaseUrl = useCallback(
    (url: string) => {
      if (provider && Array.isArray(provider.baseUrl)) {
        const idx = provider.baseUrl.findIndex((o) => o.url === url);
        setBaseUrlOptionIndex(idx >= 0 ? idx : 0);
      }
    },
    [provider],
  );

  const changeModelIds = useCallback((value: string) => {
    setModelIds(value);
    setModelIdsError(null);
  }, []);

  const submitModelIds = useCallback(
    (overrides?: Partial<ProviderSetupInputs>): boolean => {
      const normalized = overrides?.modelIds ?? normalizeModelIds(modelIds);
      if (normalized.length === 0) {
        setModelIdsError(t('Model IDs cannot be empty.'));
        return false;
      }
      setModelIds(normalized.join(', '));
      setModelIdsError(null);
      submitOrNext({ ...overrides, modelIds: normalized });
      return true;
    },
    [modelIds, submitOrNext],
  );

  const advancedOptionCount = modalityEnabled ? 7 : 3;

  const moveAdvancedFocusUp = useCallback(() => {
    setFocusedConfigIndex((v) => (v <= 0 ? advancedOptionCount - 1 : v - 1));
  }, [advancedOptionCount]);

  const moveAdvancedFocusDown = useCallback(() => {
    setFocusedConfigIndex((v) => (v >= advancedOptionCount - 1 ? 0 : v + 1));
  }, [advancedOptionCount]);

  const toggleFocusedAdvancedOption = useCallback(() => {
    switch (focusedConfigIndex) {
      case 0:
        setThinkingEnabled((v) => !v);
        break;
      case 1:
        setModalityEnabled((v) => !v);
        break;
      case 2:
        setModalityImage((v) => !v);
        break;
      case 3:
        setModalityVideo((v) => !v);
        break;
      case 4:
        setModalityAudio((v) => !v);
        break;
      case 5:
        setModalityPdf((v) => !v);
        break;
      default:
        break;
    }
  }, [focusedConfigIndex]);

  const submitAdvancedConfig = useCallback(() => {
    goNext();
  }, [goNext]);

  // -- Final submit ---------------------------------------------------------

  const changeContextWindowSize = useCallback((value: string) => {
    setContextWindowSize(value.replace(/[^0-9]/g, ''));
  }, []);

  const submit = useCallback(() => {
    if (!provider) return;
    const multimodal: InputModalities | undefined = modalityEnabled
      ? {
          image: modalityImage || undefined,
          video: modalityVideo || undefined,
          audio: modalityAudio || undefined,
          pdf: modalityPdf || undefined,
        }
      : undefined;
    const ctxSize = parseInt(contextWindowSize, 10);
    // TODO: add maxTokens input field — type and buildInstallPlan support it but UI is deferred
    const hasAdvanced =
      thinkingEnabled || modalityEnabled || (ctxSize > 0 && !isNaN(ctxSize));
    const advancedConfig = hasAdvanced
      ? {
          enableThinking: thinkingEnabled || undefined,
          multimodal,
          contextWindowSize:
            ctxSize > 0 && !isNaN(ctxSize) ? ctxSize : undefined,
        }
      : undefined;
    void onSubmit(provider, buildCurrentInputs({ advancedConfig }));
  }, [
    provider,
    thinkingEnabled,
    modalityEnabled,
    modalityImage,
    modalityVideo,
    modalityAudio,
    modalityPdf,
    contextWindowSize,
    onSubmit,
    buildCurrentInputs,
  ]);

  // -- Preview JSON (for review step) ---------------------------------------

  const getPreviewJson = useCallback((): string => {
    if (!provider) return '';
    const envKey =
      typeof provider.envKey === 'function'
        ? provider.envKey(protocol, baseUrl.trim())
        : provider.envKey;
    const normalizedIds = normalizeModelIds(modelIds);
    const masked = maskApiKey(apiKey);

    const genConfig: Record<string, unknown> = {};
    if (thinkingEnabled) genConfig['extra_body'] = { enable_thinking: true };
    if (modalityEnabled) {
      const mod: Record<string, boolean> = {};
      if (modalityImage) mod['image'] = true;
      if (modalityVideo) mod['video'] = true;
      if (modalityAudio) mod['audio'] = true;
      if (modalityPdf) mod['pdf'] = true;
      if (Object.keys(mod).length > 0) genConfig['modalities'] = mod;
    }
    const ctxSize = parseInt(contextWindowSize, 10);
    if (ctxSize > 0 && !isNaN(ctxSize))
      genConfig['contextWindowSize'] = ctxSize;
    const hasGenConfig = Object.keys(genConfig).length > 0;

    const models = normalizedIds.map((id) => {
      const entry: Record<string, unknown> = {
        id,
        name: id,
        baseUrl: baseUrl.trim(),
        envKey,
      };
      if (hasGenConfig) entry['generationConfig'] = genConfig;
      return entry;
    });

    return JSON.stringify(
      {
        env: { [envKey]: masked },
        modelProviders: { [protocol]: models },
        security: { auth: { selectedType: protocol } },
        model: { name: normalizedIds[0] },
      },
      null,
      2,
    );
  }, [
    provider,
    protocol,
    baseUrl,
    apiKey,
    modelIds,
    thinkingEnabled,
    modalityEnabled,
    modalityImage,
    modalityVideo,
    modalityAudio,
    modalityPdf,
    contextWindowSize,
  ]);

  // -- State ----------------------------------------------------------------

  const state: ProviderSetupState = {
    provider,
    step: currentStep,
    stepIndex: stepIndex + 1, // 1-based for display
    totalSteps: visibleSteps.length,
    protocol,
    baseUrl,
    baseUrlPlaceholder,
    baseUrlOptionIndex,
    baseUrlError,
    apiKey,
    apiKeyError,
    modelIds,
    modelIdsError,
    recommendedModels: discoveredModels ?? provider?.models ?? [],
    discoveryStatus,
    recommendedModelsRevision,
    thinkingEnabled,
    modalityEnabled,
    modalityImage,
    modalityVideo,
    modalityAudio,
    modalityPdf,
    contextWindowSize,
    focusedConfigIndex,
    previewJson: currentStep === 'review' ? getPreviewJson() : '',
  };

  return {
    state,
    start,
    reset,
    goBack,
    selectProtocol,
    selectBaseUrl,
    highlightBaseUrl,
    submitBaseUrl,
    changeBaseUrl,
    changeApiKey,
    submitApiKey,
    changeModelIds,
    submitModelIds,
    moveAdvancedFocusUp,
    moveAdvancedFocusDown,
    toggleFocusedAdvancedOption,
    changeContextWindowSize,
    submitAdvancedConfig,
    submit,
  };
}

export type ProviderSetupFlow = ReturnType<typeof useProviderSetupFlow>;
