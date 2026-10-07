/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import {
  AuthType,
  shouldShowStep,
  resolveBaseUrl,
  getDefaultBaseUrlForProtocol,
  getDefaultModelIds,
  buildInstallPlan,
  getModelsForProviderProtocol,
} from '@qwen-code/qwen-code-core';
import type {
  InputModalities,
  ModelWireApi,
  ModelProvidersConfig,
  ProviderModelConfig,
  ProviderProtocolConfig,
  ProviderConfig,
  ProviderSetupInputs,
} from '@qwen-code/qwen-code-core';
import { preserveModelProviderPlaceholders } from '@qwen-code/qwen-code-core/providers/model-config-serialization.js';
import { t } from '../../i18n/index.js';
import { normalizeModelIds, maskApiKey } from './useAuth.js';

// ---------------------------------------------------------------------------
// Setup step names (generic, config-driven)
// ---------------------------------------------------------------------------

export type SetupStep =
  | 'protocol'
  | 'wireApi'
  | 'baseUrl'
  | 'apiKey'
  | 'models'
  | 'advancedConfig'
  | 'review';

const STEP_ORDER: SetupStep[] = [
  'protocol',
  'wireApi',
  'baseUrl',
  'apiKey',
  'models',
  'advancedConfig',
  'review',
];

function getVisibleSteps(
  config: ProviderConfig,
  protocol: AuthType,
): SetupStep[] {
  return STEP_ORDER.filter((step) => {
    if (step === 'review') return config.showAdvancedConfig === true;
    return shouldShowStep(config, step, protocol);
  });
}

// The effective wire route of an OpenAI-family selection: a `responses` API
// rides the Responses wire even though the provider bucket stays `openai`.
const routeProtocol = (proto: AuthType, wireApi: ModelWireApi): AuthType =>
  wireApi === 'responses' ? AuthType.USE_OPENAI_RESPONSES : proto;

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
  wireApi: ModelWireApi;

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
  // The planner's refusal, shown in place of the JSON. Always set by the
  // hook; optional so hand-built state fixtures keep compiling.
  previewError?: string;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useProviderSetupFlow(
  onSubmit: (
    config: ProviderConfig,
    inputs: ProviderSetupInputs,
  ) => Promise<void>,
  modelProviders?: ModelProvidersConfig,
  providerProtocol?: ProviderProtocolConfig,
  selection?: Parameters<typeof buildInstallPlan>[3],
  rawModelProviders?: ModelProvidersConfig,
) {
  const [provider, setProvider] = useState<ProviderConfig | null>(null);
  const [visibleSteps, setVisibleSteps] = useState<SetupStep[]>([]);
  const [stepIndex, setStepIndex] = useState(0);

  const [protocol, setProtocol] = useState<AuthType>(AuthType.USE_OPENAI);
  const [wireApi, setWireApi] = useState<ModelWireApi>('chat-completions');
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

  const currentStep = visibleSteps[stepIndex] ?? null;

  // -- Lifecycle ------------------------------------------------------------

  const start = useCallback(
    (
      config: ProviderConfig,
      initialProtocol?: AuthType,
      existingEnv?: Record<string, string>,
      existingModelIds?: string[],
    ) => {
      setProvider(config);
      const initial = initialProtocol ?? config.protocol;
      const proto =
        initial === AuthType.USE_OPENAI_RESPONSES
          ? AuthType.USE_OPENAI
          : initial;
      const steps = getVisibleSteps(config, proto);
      setVisibleSteps(steps);
      setStepIndex(0);

      setProtocol(proto);
      setWireApi(
        initial === AuthType.USE_OPENAI_RESPONSES
          ? 'responses'
          : 'chat-completions',
      );
      // For presets the baseUrl is fixed (string) or selected from options;
      // for the custom provider it's empty and the placeholder hints at the
      // default endpoint for the effective route.
      const resolved = resolveBaseUrl(config);
      setBaseUrl(resolved);
      setBaseUrlPlaceholder(
        resolved ? '' : getDefaultBaseUrlForProtocol(initial),
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
    },
    [],
  );

  const reset = useCallback(() => {
    setProvider(null);
    setVisibleSteps([]);
    setStepIndex(0);
  }, []);

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
      const proto =
        selectedProtocol === AuthType.USE_OPENAI_RESPONSES
          ? AuthType.USE_OPENAI
          : selectedProtocol;
      const nextWireApi: ModelWireApi =
        selectedProtocol === AuthType.USE_OPENAI_RESPONSES
          ? 'responses'
          : proto === protocol
            ? wireApi
            : 'chat-completions';
      setProtocol(proto);
      setWireApi(nextWireApi);
      if (provider) setVisibleSteps(getVisibleSteps(provider, proto));
      // Clear baseUrl so the user types fresh; show the default endpoint of
      // the effective route as a placeholder (used if they submit blank).
      setBaseUrl('');
      setBaseUrlPlaceholder(
        getDefaultBaseUrlForProtocol(routeProtocol(proto, nextWireApi)),
      );
      setApiKey('');
      setApiKeyError(null);
      goNext();
    },
    [goNext, provider, protocol, wireApi],
  );

  const selectWireApi = useCallback(
    (selectedApi: ModelWireApi) => {
      setWireApi(selectedApi);
      const nextPlaceholder = getDefaultBaseUrlForProtocol(
        routeProtocol(protocol, selectedApi),
      );
      if (baseUrl === baseUrlPlaceholder) setBaseUrl(nextPlaceholder);
      setBaseUrlPlaceholder(nextPlaceholder);
      goNext();
    },
    [goNext, protocol, baseUrl, baseUrlPlaceholder],
  );

  const selectBaseUrl = useCallback(
    (selectedUrl: string) => {
      setBaseUrl(selectedUrl);
      setBaseUrlError(null);
      goNext();
    },
    [goNext],
  );

  const submitBaseUrl = useCallback(
    (valueOverride?: string): boolean => {
      // The caller's live field text, when it has one: a keystroke burst can leave
      // `baseUrl` a whole batch behind.
      const current = valueOverride ?? baseUrl;
      // Empty input falls back to the placeholder default so the visible hint
      // matches what gets written.
      const effective = current.trim() || baseUrlPlaceholder.trim();
      if (!effective) {
        setBaseUrlError(t('Base URL cannot be empty.'));
        return false;
      }
      if (!/^https?:\/\//i.test(effective)) {
        setBaseUrlError(t('Base URL must start with http:// or https://.'));
        return false;
      }
      if (!current.trim()) {
        setBaseUrl(effective);
      }
      setBaseUrlError(null);
      goNext();
      return true;
    },
    [baseUrl, baseUrlPlaceholder, goNext],
  );

  const changeBaseUrl = useCallback((value: string) => {
    setBaseUrl(value);
    setBaseUrlError(null);
  }, []);

  const changeApiKey = useCallback((value: string) => {
    setApiKey(value);
    setApiKeyError(null);
  }, []);

  // Shared by the preview and submission so the persisted model shape agrees.
  const buildCurrentInputs = useCallback(
    (overrides?: Partial<ProviderSetupInputs>): ProviderSetupInputs => {
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
      const hasAdvanced = thinkingEnabled || modalityEnabled || ctxSize > 0;
      return {
        protocol: provider?.protocolOptions ? protocol : undefined,
        ...(provider && shouldShowStep(provider, 'wireApi', protocol)
          ? { wireApi }
          : {}),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        modelIds: normalizeModelIds(modelIds),
        advancedConfig: hasAdvanced
          ? {
              enableThinking: thinkingEnabled || undefined,
              multimodal,
              contextWindowSize: ctxSize > 0 ? ctxSize : undefined,
            }
          : undefined,
        ...overrides,
      };
    },
    [
      provider,
      protocol,
      wireApi,
      baseUrl,
      apiKey,
      modelIds,
      modalityEnabled,
      modalityImage,
      modalityVideo,
      modalityAudio,
      modalityPdf,
      contextWindowSize,
      thinkingEnabled,
    ],
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

  const clearModelIdsError = useCallback(() => {
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
    if (provider) void onSubmit(provider, buildCurrentInputs());
  }, [provider, onSubmit, buildCurrentInputs]);

  // Display copy only: preserved models come from the env-resolved merged
  // settings, so a stored `${TOKEN}` reference reaches the hook as the real
  // secret — in any string field, not just `customHeaders`. Render the form
  // the writer persists (placeholders restored from the raw file), then mask
  // whatever header value is still a literal; `submit` builds its own plan
  // from the raw inputs.
  const holdsReference = (value: unknown) =>
    typeof value === 'string' && /\$\{[^}]+\}/.test(value);
  const maskCustomHeaders = (
    model: ProviderModelConfig,
  ): ProviderModelConfig => {
    const headers = model.generationConfig?.customHeaders;
    if (!headers) return model;
    return {
      ...model,
      generationConfig: {
        ...model.generationConfig,
        customHeaders: Object.fromEntries(
          Object.entries(headers).map(([name, value]) => [
            name,
            holdsReference(value) ? value : '***',
          ]),
        ),
      },
    };
  };
  const previewModels = (patch: {
    authType: AuthType;
    models: ProviderModelConfig[];
  }): ProviderModelConfig[] =>
    (rawModelProviders && modelProviders
      ? preserveModelProviderPlaceholders(
          patch.models,
          patch.authType,
          modelProviders,
          rawModelProviders,
          providerProtocol,
        )
      : patch.models
    ).map(maskCustomHeaders);

  // Computed during render on the review step, so it must stay total:
  // buildInstallPlan refuses reachable inputs (e.g. two same-endpoint models
  // holding different credential references) and that refusal is surfaced
  // as `previewError` instead of escaping into React and unmounting the CLI.
  const buildPreview = (): { json: string; error: string } => {
    if (!provider) return { json: '', error: '' };
    try {
      const inputs = buildCurrentInputs();
      const plan = buildInstallPlan(
        provider,
        { ...inputs, apiKey: maskApiKey(inputs.apiKey) },
        getModelsForProviderProtocol(
          modelProviders,
          inputs.protocol ?? provider.protocol,
          providerProtocol,
        ),
        selection,
      );
      return {
        json: JSON.stringify(
          {
            env: plan.env,
            modelProviders: Object.fromEntries(
              (plan.modelProviders ?? []).map((patch) => [
                patch.authType,
                previewModels(patch),
              ]),
            ),
            security: { auth: { selectedType: plan.authType } },
            model: {
              name: plan.modelSelection?.modelId,
              baseUrl: plan.modelSelection?.baseUrl ?? '',
            },
          },
          null,
          2,
        ),
        error: '',
      };
    } catch (error) {
      return {
        json: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const preview =
    currentStep === 'review' ? buildPreview() : { json: '', error: '' };

  // -- State ----------------------------------------------------------------

  const state: ProviderSetupState = {
    provider,
    step: currentStep,
    stepIndex: stepIndex + 1, // 1-based for display
    totalSteps: visibleSteps.length,
    protocol,
    wireApi,
    baseUrl,
    baseUrlPlaceholder,
    baseUrlOptionIndex,
    baseUrlError,
    apiKey,
    apiKeyError,
    modelIds,
    modelIdsError,
    thinkingEnabled,
    modalityEnabled,
    modalityImage,
    modalityVideo,
    modalityAudio,
    modalityPdf,
    contextWindowSize,
    focusedConfigIndex,
    previewJson: preview.json,
    previewError: preview.error,
  };

  return {
    state,
    start,
    reset,
    goBack,
    selectProtocol,
    selectWireApi,
    selectBaseUrl,
    highlightBaseUrl,
    submitBaseUrl,
    changeBaseUrl,
    changeApiKey,
    submitApiKey,
    changeModelIds,
    clearModelIdsError,
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
