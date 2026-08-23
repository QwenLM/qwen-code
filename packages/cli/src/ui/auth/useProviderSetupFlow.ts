/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useRef } from 'react';
import {
  AuthType,
  shouldShowStep,
  resolveBaseUrl,
  getDefaultBaseUrlForProtocol,
  getDefaultModelIds,
  normalizeBaseUrlForMatching,
} from '@qwen-code/qwen-code-core';
import type {
  InputModalities,
  ProviderConfig,
  ProviderModelConfig,
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

function getVisibleSteps(config: ProviderConfig): SetupStep[] {
  return STEP_ORDER.filter((step) => {
    if (step === 'review') return config.showAdvancedConfig === true;
    return shouldShowStep(config, step);
  });
}

function providerEnvKey(
  config: ProviderConfig,
  protocol: AuthType,
  baseUrl: string,
): string {
  return typeof config.envKey === 'function'
    ? config.envKey(protocol, baseUrl)
    : config.envKey;
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
  const [existingProviderEnv, setExistingProviderEnv] = useState<
    Record<string, string>
  >({});
  const apiKeyDraftsRef = useRef(new Map<string, string>());
  // Protocol changes must restore the endpoint and key together. Keying only
  // by env var loses custom-provider drafts because their env key includes
  // the user-entered endpoint.
  const protocolDraftsRef = useRef(
    new Map<
      AuthType,
      {
        baseUrl: string;
        committedBaseUrl: string;
        apiKey: string;
        modelIds: string;
      }
    >(),
  );
  const committedBaseUrlRef = useRef('');
  const preserveModelsRef = useRef<ProviderModelConfig[]>([]);
  const [modelIds, setModelIds] = useState('');
  const [modelIdsError, setModelIdsError] = useState<string | null>(null);
  const customModelIdsByBaseUrlRef = useRef(new Map<string, string[]>());
  const trimmedDefaultModelIdsRef = useRef(new Map<string, string[]>());
  // Per-protocol stash of the endpoint-keyed maps above, swapped in
  // selectProtocol so model ids typed under one protocol never pre-fill
  // another protocol's models field at the same endpoint.
  const endpointModelStateByProtocolRef = useRef(
    new Map<
      AuthType,
      {
        customModelIds: Map<string, string[]>;
        trimmedDefaultModelIds: Map<string, string[]>;
      }
    >(),
  );
  // Saved-state views per protocol (from the settings buckets), used by
  // selectProtocol to re-seed the endpoint maps, the models field, and
  // preserveModels when the user switches protocol — so each protocol
  // bucket's own saved models are displayed and preserved instead of the
  // first non-empty bucket's (R34-2/R35-12).
  const savedModelStateByProtocolRef = useRef(
    new Map<
      AuthType,
      {
        baseUrl: string;
        preserveModels: readonly ProviderModelConfig[];
      }
    >(),
  );
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
      initialBaseUrl?: string,
      initialTrimmedDefaultModelIds?: string[],
      existingModelIdsByBaseUrl?: ReadonlyMap<string, readonly string[]>,
      preserveModels?: ProviderModelConfig[],
      modelIdsByBaseUrlByProtocol?: ReadonlyMap<
        AuthType,
        ReadonlyMap<string, readonly string[]>
      >,
      preserveModelsByProtocol?: ReadonlyMap<
        AuthType,
        readonly ProviderModelConfig[]
      >,
      baseUrlByProtocol?: ReadonlyMap<AuthType, string>,
    ) => {
      apiKeyDraftsRef.current.clear();
      protocolDraftsRef.current.clear();
      endpointModelStateByProtocolRef.current.clear();
      savedModelStateByProtocolRef.current.clear();
      setProvider(config);
      const steps = getVisibleSteps(config);
      setVisibleSteps(steps);
      setStepIndex(0);

      const proto = initialProtocol ?? config.protocol;
      setProtocol(proto);
      // For presets the baseUrl is fixed (string) or selected from options;
      // for the custom provider it's empty and the placeholder hints at the
      // default endpoint for the chosen protocol.
      const resolved = resolveBaseUrl(config, initialBaseUrl);
      setBaseUrl(resolved);
      setBaseUrlPlaceholder(
        resolved ? '' : getDefaultBaseUrlForProtocol(proto),
      );
      const initialOptionIndex = Array.isArray(config.baseUrl)
        ? config.baseUrl.findIndex((option) => option.url === resolved)
        : 0;
      setBaseUrlOptionIndex(initialOptionIndex >= 0 ? initialOptionIndex : 0);
      setBaseUrlError(null);

      let prefillKey = '';
      if (existingEnv) {
        const envKeyName = providerEnvKey(config, proto, resolved);
        prefillKey = existingEnv[envKeyName] ?? '';
      }
      setApiKey(prefillKey);
      setExistingProviderEnv(existingEnv ?? {});
      committedBaseUrlRef.current = resolved;
      preserveModelsRef.current = [
        ...(preserveModelsByProtocol?.get(proto) ?? preserveModels ?? []),
      ];

      setApiKeyError(null);
      // Built-in defaults go to the recommended list (checked), user-added
      // custom IDs go to the input box. The ModelIdsStep component splits
      // flow.state.modelIds automatically based on the selected endpoint.
      const defaultIds = getDefaultModelIds(config, resolved);
      const customIds = existingModelIds ?? [];
      const trimmedDefaultIds = new Set(initialTrimmedDefaultModelIds ?? []);
      customModelIdsByBaseUrlRef.current.clear();
      trimmedDefaultModelIdsRef.current.clear();
      for (const [endpoint, savedIds] of existingModelIdsByBaseUrl ?? []) {
        const normalizedEndpoint = normalizeBaseUrlForMatching(endpoint);
        const endpointDefaults = getDefaultModelIds(config, normalizedEndpoint);
        const endpointDefaultSet = new Set(endpointDefaults);
        const savedIdSet = new Set(savedIds);
        customModelIdsByBaseUrlRef.current.set(
          normalizedEndpoint,
          savedIds.filter((id) => !endpointDefaultSet.has(id)),
        );
        trimmedDefaultModelIdsRef.current.set(
          normalizedEndpoint,
          endpointDefaults.filter((id) => !savedIdSet.has(id)),
        );
      }
      const normalizedResolved = normalizeBaseUrlForMatching(resolved);
      customModelIdsByBaseUrlRef.current.set(normalizedResolved, customIds);
      trimmedDefaultModelIdsRef.current.set(normalizedResolved, [
        ...trimmedDefaultIds,
      ]);
      // Seed the per-protocol stashes from the settings buckets so switching
      // protocol restores that protocol's own saved endpoint model maps,
      // models field, and preserveModels (R34-2/R35-12) instead of the first
      // non-empty bucket's.
      for (const [protoKey, idsByBaseUrl] of modelIdsByBaseUrlByProtocol ??
        []) {
        const customByBaseUrl = new Map<string, string[]>();
        const trimmedByBaseUrl = new Map<string, string[]>();
        for (const [endpoint, savedIds] of idsByBaseUrl) {
          const normalizedEndpoint = normalizeBaseUrlForMatching(endpoint);
          const endpointDefaultSet = new Set(
            getDefaultModelIds(config, normalizedEndpoint),
          );
          const savedIdSet = new Set(savedIds);
          customByBaseUrl.set(
            normalizedEndpoint,
            savedIds.filter((id) => !endpointDefaultSet.has(id)),
          );
          trimmedByBaseUrl.set(
            normalizedEndpoint,
            [...endpointDefaultSet].filter((id) => !savedIdSet.has(id)),
          );
        }
        endpointModelStateByProtocolRef.current.set(protoKey, {
          customModelIds: customByBaseUrl,
          trimmedDefaultModelIds: trimmedByBaseUrl,
        });
        savedModelStateByProtocolRef.current.set(protoKey, {
          baseUrl: baseUrlByProtocol?.get(protoKey) ?? '',
          preserveModels: preserveModelsByProtocol?.get(protoKey) ?? [],
        });
      }
      const initialModelIds = [
        ...defaultIds.filter((id) => !trimmedDefaultIds.has(id)),
        ...customIds,
      ].join(', ');
      setModelIds(initialModelIds);
      protocolDraftsRef.current.set(proto, {
        baseUrl: resolved,
        committedBaseUrl: resolved,
        apiKey: prefillKey,
        modelIds: initialModelIds,
      });
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
    apiKeyDraftsRef.current.clear();
    protocolDraftsRef.current.clear();
    committedBaseUrlRef.current = '';
    preserveModelsRef.current = [];
    customModelIdsByBaseUrlRef.current.clear();
    trimmedDefaultModelIdsRef.current.clear();
    endpointModelStateByProtocolRef.current.clear();
    savedModelStateByProtocolRef.current.clear();
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
      setProtocol(selectedProtocol);
      if (selectedProtocol !== protocol) {
        protocolDraftsRef.current.set(protocol, {
          baseUrl,
          committedBaseUrl: committedBaseUrlRef.current,
          apiKey,
          modelIds,
        });
        // Swap the endpoint-keyed model-id maps alongside the field drafts:
        // they are keyed by endpoint URL only, so without the swap ids
        // typed under the outgoing protocol would pre-fill the incoming
        // protocol's models field at the same endpoint.
        endpointModelStateByProtocolRef.current.set(protocol, {
          customModelIds: new Map(
            [...customModelIdsByBaseUrlRef.current].map(([k, v]) => [
              k,
              [...v],
            ]),
          ),
          trimmedDefaultModelIds: new Map(
            [...trimmedDefaultModelIdsRef.current].map(([k, v]) => [k, [...v]]),
          ),
        });
        const stashedEndpointState =
          endpointModelStateByProtocolRef.current.get(selectedProtocol);
        customModelIdsByBaseUrlRef.current = new Map(
          stashedEndpointState?.customModelIds,
        );
        trimmedDefaultModelIdsRef.current = new Map(
          stashedEndpointState?.trimmedDefaultModelIds,
        );
        // Switch preservation to the selected protocol's own bucket: its
        // saved models must survive the submit, not the first bucket's
        // (R34-2/R35-12).
        preserveModelsRef.current = [
          ...(savedModelStateByProtocolRef.current.get(selectedProtocol)
            ?.preserveModels ?? []),
        ];
        const draft = protocolDraftsRef.current.get(selectedProtocol);
        if (draft) {
          setBaseUrl(draft.baseUrl);
          setBaseUrlPlaceholder(
            draft.baseUrl ? '' : getDefaultBaseUrlForProtocol(selectedProtocol),
          );
          setApiKey(draft.apiKey);
          setModelIds(draft.modelIds);
          committedBaseUrlRef.current = draft.committedBaseUrl;
        } else {
          const savedState =
            savedModelStateByProtocolRef.current.get(selectedProtocol);
          if (provider && savedState && savedState.baseUrl) {
            // Restore this protocol's saved endpoint, key, and models so the
            // field shows the bucket's own models instead of being blank.
            const savedBaseUrl = savedState.baseUrl;
            setBaseUrl(savedBaseUrl);
            setBaseUrlPlaceholder('');
            const envKeyName = providerEnvKey(
              provider,
              selectedProtocol,
              savedBaseUrl,
            );
            setApiKey(existingProviderEnv[envKeyName] ?? '');
            const normalizedSavedBaseUrl =
              normalizeBaseUrlForMatching(savedBaseUrl);
            const savedCustomIds =
              customModelIdsByBaseUrlRef.current.get(normalizedSavedBaseUrl) ??
              [];
            const trimmedSet = new Set(
              trimmedDefaultModelIdsRef.current.get(normalizedSavedBaseUrl) ??
                [],
            );
            setModelIds(
              [
                ...getDefaultModelIds(provider, savedBaseUrl).filter(
                  (id) => !trimmedSet.has(id),
                ),
                ...savedCustomIds,
              ].join(', '),
            );
            committedBaseUrlRef.current = savedBaseUrl;
          } else {
            // No saved state for this protocol: clear baseUrl so the user
            // types fresh; show the protocol's default endpoint as a
            // placeholder (used if they submit blank).
            setBaseUrl('');
            setBaseUrlPlaceholder(
              getDefaultBaseUrlForProtocol(selectedProtocol),
            );
            setApiKey('');
            setModelIds('');
            committedBaseUrlRef.current = '';
          }
        }
        setApiKeyError(null);
        setModelIdsError(null);
      }
      goNext();
    },
    [
      apiKey,
      baseUrl,
      existingProviderEnv,
      goNext,
      modelIds,
      protocol,
      provider,
    ],
  );

  const switchEndpointModelState = useCallback(
    (previousUrl: string, selectedUrl: string): string => {
      if (!provider) return modelIds;
      const previousEndpoint = normalizeBaseUrlForMatching(previousUrl);
      const destinationEndpoint = normalizeBaseUrlForMatching(selectedUrl);
      if (previousEndpoint === destinationEndpoint) return modelIds;

      const currentIds = normalizeModelIds(modelIds);
      const previousDefaults = getDefaultModelIds(provider, previousUrl);
      // Only the source and destination endpoints' defaults are replaceable:
      // a typed id colliding with some other sibling endpoint's built-in is
      // user input for the current endpoint and must survive the switch.
      const previousDefaultSet = new Set(previousDefaults);
      const trimmedNextDefaults = new Set(
        trimmedDefaultModelIdsRef.current.get(destinationEndpoint) ?? [],
      );
      const fieldSet = new Set(currentIds);
      const editedCustomIds = [
        ...new Set([
          ...(
            customModelIdsByBaseUrlRef.current.get(previousEndpoint) ?? []
          ).filter((id) => fieldSet.has(id) || previousDefaultSet.has(id)),
          ...currentIds.filter((id) => !previousDefaultSet.has(id)),
        ]),
      ];
      customModelIdsByBaseUrlRef.current.set(previousEndpoint, editedCustomIds);
      const destinationDefaults = getDefaultModelIds(provider, selectedUrl);
      const destinationCustomIds =
        customModelIdsByBaseUrlRef.current.get(destinationEndpoint);
      const customIds = destinationCustomIds ?? editedCustomIds;
      if (destinationCustomIds === undefined) {
        customModelIdsByBaseUrlRef.current.set(destinationEndpoint, customIds);
      }
      const nextModelIds = [
        ...new Set([
          ...destinationDefaults.filter((id) => !trimmedNextDefaults.has(id)),
          ...customIds.filter((id) => !trimmedNextDefaults.has(id)),
        ]),
      ].join(', ');
      setModelIds(nextModelIds);
      setModelIdsError(null);
      return nextModelIds;
    },
    [modelIds, provider],
  );

  const selectBaseUrl = useCallback(
    (selectedUrl: string) => {
      setBaseUrl(selectedUrl);
      setBaseUrlError(null);
      if (provider && selectedUrl !== baseUrl) {
        setApiKeyError(null);
        switchEndpointModelState(baseUrl, selectedUrl);
        const previousEnvKey = providerEnvKey(provider, protocol, baseUrl);
        const nextEnvKey = providerEnvKey(provider, protocol, selectedUrl);
        if (nextEnvKey !== previousEnvKey) {
          apiKeyDraftsRef.current.set(previousEnvKey, apiKey);
          setApiKey(
            apiKeyDraftsRef.current.get(nextEnvKey) ??
              existingProviderEnv[nextEnvKey] ??
              '',
          );
        }
        committedBaseUrlRef.current = selectedUrl;
      }
      goNext();
    },
    [
      apiKey,
      baseUrl,
      existingProviderEnv,
      goNext,
      protocol,
      provider,
      switchEndpointModelState,
    ],
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
    // Always sync the visible state to the committed (trimmed) endpoint. The
    // per-endpoint model-state maps key off this state (changeModelIds) while
    // the committed endpoint is the trimmed value; if the state kept a
    // whitespace-padded paste, writes landed under one key and reads on
    // endpoint return used the other — orphaning trim state and resurrecting
    // deselected defaults (R41-5).
    setBaseUrl(effective);
    if (provider) {
      const previousCommittedBaseUrl = committedBaseUrlRef.current;
      const nextModelIds = switchEndpointModelState(
        previousCommittedBaseUrl,
        effective,
      );
      const previousEnvKey = providerEnvKey(
        provider,
        protocol,
        previousCommittedBaseUrl,
      );
      const nextEnvKey = providerEnvKey(provider, protocol, effective);
      let nextApiKey = apiKey;
      if (nextEnvKey !== previousEnvKey) {
        apiKeyDraftsRef.current.set(previousEnvKey, apiKey);
        nextApiKey =
          apiKeyDraftsRef.current.get(nextEnvKey) ??
          existingProviderEnv[nextEnvKey] ??
          '';
        setApiKey(nextApiKey);
      }
      committedBaseUrlRef.current = effective;
      protocolDraftsRef.current.set(protocol, {
        baseUrl: effective,
        committedBaseUrl: effective,
        apiKey: nextApiKey,
        modelIds: nextModelIds,
      });
    }
    setBaseUrlError(null);
    goNext();
    return true;
  }, [
    apiKey,
    baseUrl,
    baseUrlPlaceholder,
    existingProviderEnv,
    goNext,
    protocol,
    provider,
    switchEndpointModelState,
  ]);

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
    (overrides?: Partial<ProviderSetupInputs>): ProviderSetupInputs => {
      const resolvedBaseUrl = (overrides?.baseUrl ?? baseUrl).trim();
      const resolvedModelIds =
        overrides?.modelIds ?? normalizeModelIds(modelIds);
      const selectedModelIdSet = new Set(resolvedModelIds);
      const selectedEndpoint = normalizeBaseUrlForMatching(resolvedBaseUrl);
      const defaultModelIdSet = new Set(
        provider ? getDefaultModelIds(provider, resolvedBaseUrl) : [],
      );
      const preserveModels = preserveModelsRef.current.filter((model) => {
        if (!provider) return true;
        const belongsToAnotherEndpoint =
          model.baseUrl !== undefined &&
          normalizeBaseUrlForMatching(model.baseUrl) !== selectedEndpoint;
        if (!provider.mergeModelsByIdentity && belongsToAnotherEndpoint) {
          // Non-merge providers own every endpoint, so sibling-endpoint
          // models must be carried or the remove-owned merge deletes them.
          // Merge providers own only the submitted endpoint — sibling
          // entries are not removed there and carrying them would duplicate
          // them (the preserved existing copy survives too).
          //
          // Carry a sibling entry only if its id is still part of that
          // endpoint's live model set: preserveModelsRef is the dialog-open
          // snapshot and is never updated by changeModelIds or
          // switchEndpointModelState, so carrying it unconditionally revived
          // a custom model the user explicitly deleted from the sibling
          // endpoint's models field (R42-2). Reconstruct the set the way
          // the field is seeded — the endpoint's defaults minus deselected
          // defaults, plus its live custom ids. An endpoint with no live
          // state at all (never visited, nothing seeded) fails closed
          // toward preservation, as before R42-2.
          const siblingEndpoint = normalizeBaseUrlForMatching(model.baseUrl);
          const liveCustomIds =
            customModelIdsByBaseUrlRef.current.get(siblingEndpoint);
          const liveTrimmedDefaults =
            trimmedDefaultModelIdsRef.current.get(siblingEndpoint);
          if (
            liveCustomIds === undefined &&
            liveTrimmedDefaults === undefined
          ) {
            return true;
          }
          const trimmedSet = new Set(liveTrimmedDefaults ?? []);
          const liveSiblingIds = new Set([
            ...(liveCustomIds ?? []),
            ...getDefaultModelIds(provider, siblingEndpoint).filter(
              (id) => !trimmedSet.has(id),
            ),
          ]);
          return liveSiblingIds.has(model.id);
        }
        const belongsToSelectedMergeEndpoint =
          !provider.mergeModelsByIdentity ||
          (model.baseUrl !== undefined && !belongsToAnotherEndpoint);
        return (
          belongsToSelectedMergeEndpoint &&
          !defaultModelIdSet.has(model.id) &&
          selectedModelIdSet.has(model.id)
        );
      });
      return {
        protocol: provider?.protocolOptions ? protocol : undefined,
        baseUrl: resolvedBaseUrl,
        apiKey: apiKey.trim(),
        modelIds: resolvedModelIds,
        ...(preserveModels.length > 0 ? { preserveModels } : {}),
        ...overrides,
      };
    },
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

  const changeModelIds = useCallback(
    (value: string) => {
      setModelIds(value);
      setModelIdsError(null);
      const normalized = normalizeModelIds(value);
      const defaults = provider ? getDefaultModelIds(provider, baseUrl) : [];
      const defaultSet = new Set(defaults);
      const fieldSet = new Set(normalized);
      const endpoint = normalizeBaseUrlForMatching(baseUrl);
      customModelIdsByBaseUrlRef.current.set(endpoint, [
        ...new Set([
          // An id that is this endpoint's built-in leaves the field when the
          // user deselects the recommendation; its custom provenance (possibly
          // a sibling endpoint's saved custom sharing the id) must survive.
          ...(customModelIdsByBaseUrlRef.current.get(endpoint) ?? []).filter(
            (id) => fieldSet.has(id) || defaultSet.has(id),
          ),
          ...normalized.filter((id) => !defaultSet.has(id)),
        ]),
      ]);
      trimmedDefaultModelIdsRef.current.set(
        endpoint,
        defaults.filter((id) => !fieldSet.has(id)),
      );
    },
    [baseUrl, provider],
  );

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
    const envKey = providerEnvKey(provider, protocol, baseUrl.trim());
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
