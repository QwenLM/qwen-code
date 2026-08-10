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

export function defaultModelIds(
  provider: QwenProviderSummary,
  baseUrl: string,
): string[] {
  if (Array.isArray(provider.baseUrl)) {
    const option = provider.baseUrl.find((item) => item.url === baseUrl);
    if (option?.models) return option.models.map((model) => model.id);
  }
  return provider.defaultModelIds;
}

export function initialModelIds(
  provider: QwenProviderSummary,
  baseUrl: string,
): string[] {
  const existingModelIds = provider.existingConfig?.modelIds ?? [];
  return existingModelIds.length > 0
    ? existingModelIds
    : defaultModelIds(provider, baseUrl);
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
 * They always survive switches; classifying the field against a provider-wide
 * built-in union instead silently dropped ids colliding with a sibling
 * endpoint's built-in, and the next submit's prepend-and-remove-owned merge
 * then deleted those models from settings.
 */
export function modelIdsAfterBaseUrlChange(
  provider: QwenProviderSummary,
  previousBaseUrl: string,
  nextBaseUrl: string,
  currentModelIds: string,
  customModelIds: readonly string[] = [],
  trimmedNextDefaultModelIds: readonly string[] = [],
): { modelIds: string[]; customModelIds: string[] } {
  const previousDefaults = new Set(defaultModelIds(provider, previousBaseUrl));
  const nextDefaults = defaultModelIds(provider, nextBaseUrl);
  const trimmedNextDefaults = new Set(trimmedNextDefaultModelIds);
  const fieldIds = parseModelIds(currentModelIds);
  const fieldSet = new Set(fieldIds);
  const nextCustomModelIds = [
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
  return {
    modelIds: [
      ...new Set([
        ...nextDefaults.filter((id) => !trimmedNextDefaults.has(id)),
        ...nextCustomModelIds,
      ]),
    ],
    customModelIds: nextCustomModelIds,
  };
}

export function selectedBaseUrlEnvKey(
  provider: QwenProviderSummary,
  baseUrl: string,
): string | undefined {
  if (!Array.isArray(provider.baseUrl)) return undefined;
  return provider.baseUrl.find((option) => option.url === baseUrl)?.envKey;
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
