import type { QwenProviderSummary } from '../../../shared/types';

export function parseModelIds(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

export function defaultBaseUrl(provider: QwenProviderSummary): string {
  if (typeof provider.baseUrl === 'string') return provider.baseUrl;
  if (Array.isArray(provider.baseUrl)) return provider.baseUrl[0]?.url ?? '';
  return provider.baseUrlPlaceholder ?? '';
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function canonicalBaseUrl(
  provider: QwenProviderSummary,
  baseUrl: string,
): string {
  if (!Array.isArray(provider.baseUrl)) {
    // Free-form providers: the per-endpoint state maps are seeded from the
    // ACP list response, whose keys the producer slash-strips
    // (normalizeBaseUrlForMatching). Lookups must normalize the form-state
    // URL the same way, or a spelling variance (trailing slash) makes an
    // endpoint switch miss the destination's saved state — the exact
    // failure this module exists to prevent.
    return normalizeBaseUrl(baseUrl);
  }
  const normalized = normalizeBaseUrl(baseUrl);
  return (
    provider.baseUrl.find(
      (option) => normalizeBaseUrl(option.url) === normalized,
    )?.url ?? normalized
  );
}

export function defaultModelIds(
  provider: QwenProviderSummary,
  baseUrl: string,
): string[] {
  if (Array.isArray(provider.baseUrl)) {
    const option = provider.baseUrl.find(
      (item) => normalizeBaseUrl(item.url) === normalizeBaseUrl(baseUrl),
    );
    if (option?.models) return option.models.map((model) => model.id);
  }
  return provider.defaultModelIds;
}

export function initialModelIds(
  provider: QwenProviderSummary,
  baseUrl: string,
): string[] {
  const endpointModelIds =
    Object.entries(provider.existingConfig?.modelIdsByBaseUrl ?? {}).find(
      ([endpoint]) => normalizeBaseUrl(endpoint) === normalizeBaseUrl(baseUrl),
    )?.[1] ?? [];
  if (endpointModelIds.length > 0) return endpointModelIds;
  const existingModelIds = provider.existingConfig?.modelIds ?? [];
  return existingModelIds.length > 0
    ? existingModelIds
    : defaultModelIds(provider, baseUrl);
}

export type ProviderModelSeed = {
  modelIds: string[];
  customModelIds: string[];
  customModelIdsByBaseUrl: Map<string, string[]>;
  trimmedDefaultModelIds: Map<string, string[]>;
};

function buildModelStateFromEntries(
  provider: QwenProviderSummary,
  baseUrl: string,
  modelIds: string[],
  endpointEntries: Array<[string, string[]]>,
): ProviderModelSeed {
  const savedEntries: Array<[string, string[]]> =
    endpointEntries.length > 0 ? endpointEntries : [[baseUrl, modelIds]];
  const customModelIds = new Set<string>();
  const customsByBaseUrl = new Map<string, string[]>();
  const trims = new Map<string, string[]>();

  for (const [endpoint, savedModelIds] of savedEntries) {
    const canonicalEndpoint = canonicalBaseUrl(provider, endpoint);
    const defaults = new Set(defaultModelIds(provider, canonicalEndpoint));
    const endpointCustoms = savedModelIds.filter((id) => !defaults.has(id));
    customsByBaseUrl.set(canonicalEndpoint, endpointCustoms);
    for (const id of endpointCustoms) customModelIds.add(id);
    trims.set(
      canonicalEndpoint,
      trimmedDefaultModelIds(provider, canonicalEndpoint, savedModelIds),
    );
  }

  return {
    modelIds,
    customModelIds: [...customModelIds],
    customModelIdsByBaseUrl: customsByBaseUrl,
    trimmedDefaultModelIds: trims,
  };
}

export function seedProviderModelState(
  provider: QwenProviderSummary,
  baseUrl: string,
): ProviderModelSeed {
  const modelIds = initialModelIds(provider, baseUrl);
  const endpointEntries = Object.entries(
    provider.existingConfig?.modelIdsByBaseUrl ?? {},
  );
  return buildModelStateFromEntries(provider, baseUrl, modelIds, endpointEntries);
}

/** The saved baseUrl for a protocol bucket, if the provider was connected under it. */
export function protocolBaseUrl(
  provider: QwenProviderSummary,
  protocol: string,
): string | undefined {
  return provider.existingConfig?.baseUrlByProtocol?.[protocol];
}

/**
 * Resolves the endpoint to show after switching the protocol Select: the
 * saved bucket's canonical baseUrl when the protocol was connected before,
 * or `undefined` to signal that the form must keep the user's current
 * endpoint and model state untouched. The producer only populates
 * `baseUrlByProtocol` for protocols that already have saved models, so an
 * `undefined` bucket means "not yet connected" — substituting the provider
 * default there would overwrite the typed endpoint with the DEFAULT
 * protocol's URL (multi-protocol setups on one server share the endpoint).
 */
export function baseUrlAfterProtocolChange(
  provider: QwenProviderSummary,
  nextProtocol: string,
): string | undefined {
  const savedBaseUrl = protocolBaseUrl(provider, nextProtocol);
  return savedBaseUrl === undefined
    ? undefined
    : canonicalBaseUrl(provider, savedBaseUrl);
}

/**
 * Seeds the model state for a SPECIFIC protocol bucket (R35-12). The form
 * seeds from the first bucket by default; when the user flips the protocol
 * Select it must re-seed from the selected bucket's own saved models, else
 * submitting rebuilds that bucket from the wrong protocol's ids.
 */
export function seedProtocolModelState(
  provider: QwenProviderSummary,
  protocol: string,
  baseUrl: string,
): ProviderModelSeed {
  const byProtocol =
    provider.existingConfig?.modelIdsByBaseUrlByProtocol?.[protocol];
  if (!byProtocol) {
    // No saved state for this protocol: seed the endpoint's defaults.
    return buildModelStateFromEntries(
      provider,
      baseUrl,
      defaultModelIds(provider, baseUrl),
      [],
    );
  }
  const endpointEntries = Object.entries(byProtocol);
  const modelIds =
    endpointEntries.find(
      ([endpoint]) => normalizeBaseUrl(endpoint) === normalizeBaseUrl(baseUrl),
    )?.[1] ?? defaultModelIds(provider, baseUrl);
  return buildModelStateFromEntries(provider, baseUrl, modelIds, endpointEntries);
}

export function customModelIdsAfterEdit(
  defaultIds: readonly string[],
  currentCustomModelIds: readonly string[],
  modelIds: readonly string[],
): string[] {
  const defaults = new Set(defaultIds);
  const field = new Set(modelIds);
  return [
    ...new Set([
      // An id that is this endpoint's built-in leaves the field when the user
      // deselects the recommendation; its custom provenance (possibly a saved
      // custom from a sibling endpoint sharing the id) must survive.
      ...currentCustomModelIds.filter(
        (id) => field.has(id) || defaults.has(id),
      ),
      ...modelIds.filter((id) => !defaults.has(id)),
    ]),
  ];
}

export function trimmedDefaultModelIds(
  provider: QwenProviderSummary,
  baseUrl: string,
  modelIds: readonly string[],
): string[] {
  const field = new Set(modelIds);
  return defaultModelIds(provider, baseUrl).filter((id) => !field.has(id));
}

export function resetTrimmedDefaultModelIds(
  trims: Map<string, string[]>,
  provider: QwenProviderSummary,
  baseUrl: string,
  modelIds: readonly string[],
): void {
  trims.clear();
  trims.set(baseUrl, trimmedDefaultModelIds(provider, baseUrl, modelIds));
}

/**
 * Clears per-credential-domain drafts so a draft typed for one provider is
 * never restored into another provider's field under a shared env key.
 * Stored keys never ride along on the catalog wire — the ACP list response
 * exposes only `hasApiKey` — so the field always starts empty.
 */
export function initialApiKey(drafts: Map<string, string>): string {
  drafts.clear();
  return '';
}

/**
 * Recomputes the models field when switching endpoints.
 *
 * `customModelIds` carries the user-owned ids tracked by the form (seeded
 * saved models that are not the seeded endpoint's defaults, plus typed ids).
 * An unseen destination inherits the edited custom ids. A destination with
 * saved state restores its own custom ids instead, so sibling-only models are
 * not re-homed under the selected endpoint on submit. Classifying the field
 * against a provider-wide built-in union instead silently dropped ids
 * colliding with a sibling endpoint's built-in, and the next submit's
 * prepend-and-remove-owned merge then deleted those models from settings.
 */
export function modelIdsAfterBaseUrlChange(
  provider: QwenProviderSummary,
  previousBaseUrl: string,
  nextBaseUrl: string,
  currentModelIds: string,
  customModelIds: readonly string[] = [],
  trimmedNextDefaultModelIds: readonly string[] = [],
  savedNextCustomModelIds?: readonly string[],
): { modelIds: string[]; customModelIds: string[] } {
  const previousDefaults = new Set(defaultModelIds(provider, previousBaseUrl));
  const nextDefaults = defaultModelIds(provider, nextBaseUrl);
  const trimmedNextDefaults = new Set(trimmedNextDefaultModelIds);
  const fieldIds = parseModelIds(currentModelIds);
  const fieldSet = new Set(fieldIds);
  const editedCustomModelIds = [
    ...new Set([
      // Ids the user deleted from the field stay deleted — except an id that
      // is the previous endpoint's built-in: it can be absent from the field
      // only because it was shown as a (deselected) recommendation, and its
      // provenance may belong to a sibling endpoint.
      ...customModelIds.filter(
        (id) => fieldSet.has(id) || previousDefaults.has(id),
      ),
      ...fieldIds.filter((id) => !previousDefaults.has(id)),
    ]),
  ];
  const nextCustomModelIds = [
    ...new Set(savedNextCustomModelIds ?? editedCustomModelIds),
  ];
  return {
    modelIds: [
      ...new Set([
        ...nextDefaults.filter((id) => !trimmedNextDefaults.has(id)),
        ...nextCustomModelIds.filter((id) => !trimmedNextDefaults.has(id)),
      ]),
    ],
    customModelIds: nextCustomModelIds,
  };
}

export function switchEndpointModelState(
  provider: QwenProviderSummary,
  previousBaseUrl: string,
  nextBaseUrl: string,
  currentModelIds: string,
  currentCustomModelIds: readonly string[],
  customModelIdsByBaseUrl: Map<string, string[]>,
  trimmedDefaultModelIdsByBaseUrl: Map<string, string[]>,
): { modelIds: string[]; customModelIds: string[] } {
  const previousEndpoint = canonicalBaseUrl(provider, previousBaseUrl);
  const nextEndpoint = canonicalBaseUrl(provider, nextBaseUrl);
  const previousCustomModelIds = customModelIdsAfterEdit(
    defaultModelIds(provider, previousEndpoint),
    customModelIdsByBaseUrl.get(previousEndpoint) ?? currentCustomModelIds,
    parseModelIds(currentModelIds),
  );
  customModelIdsByBaseUrl.set(previousEndpoint, previousCustomModelIds);
  const nextState = modelIdsAfterBaseUrlChange(
    provider,
    previousEndpoint,
    nextEndpoint,
    currentModelIds,
    previousCustomModelIds,
    trimmedDefaultModelIdsByBaseUrl.get(nextEndpoint),
    customModelIdsByBaseUrl.get(nextEndpoint),
  );
  customModelIdsByBaseUrl.set(nextEndpoint, nextState.customModelIds);
  return nextState;
}

export function selectedBaseUrlEnvKey(
  provider: QwenProviderSummary,
  baseUrl: string,
): string | undefined {
  if (!Array.isArray(provider.baseUrl)) return undefined;
  return provider.baseUrl.find(
    (option) => normalizeBaseUrl(option.url) === normalizeBaseUrl(baseUrl),
  )?.envKey;
}

export function shouldResetApiKeyAfterBaseUrlChange(
  provider: QwenProviderSummary,
  currentBaseUrl: string,
  nextBaseUrl: string,
): boolean {
  const currentEnvKey = selectedBaseUrlEnvKey(provider, currentBaseUrl);
  const nextEnvKey = selectedBaseUrlEnvKey(provider, nextBaseUrl);
  return !currentEnvKey || !nextEnvKey || currentEnvKey !== nextEnvKey;
}

/**
 * Computes the API key to show after an endpoint switch while keeping
 * per-credential-domain drafts in `drafts`, so a key typed for one endpoint
 * survives a round trip through another endpoint's key domain.
 */
export function apiKeyAfterBaseUrlChange(
  provider: QwenProviderSummary,
  currentBaseUrl: string,
  nextBaseUrl: string,
  currentApiKey: string,
  drafts: Map<string, string>,
): string {
  if (
    !shouldResetApiKeyAfterBaseUrlChange(provider, currentBaseUrl, nextBaseUrl)
  ) {
    return currentApiKey;
  }
  const currentDomain = selectedBaseUrlEnvKey(provider, currentBaseUrl);
  const nextDomain = selectedBaseUrlEnvKey(provider, nextBaseUrl);
  // A baseUrl that matches no option has no draft domain — keep the typed
  // key rather than wiping it unrecoverably.
  if (!currentDomain || !nextDomain) return currentApiKey;
  drafts.set(currentDomain, currentApiKey);
  return drafts.get(nextDomain) ?? '';
}
