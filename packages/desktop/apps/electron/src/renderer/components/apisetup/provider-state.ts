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

export function modelIdsAfterBaseUrlChange(
  provider: QwenProviderSummary,
  baseUrl: string,
  currentModelIds: string,
): string[] {
  const builtInIds = new Set([
    ...provider.models.map((model) => model.id),
    ...(Array.isArray(provider.baseUrl)
      ? provider.baseUrl.flatMap(
          (option) => option.models?.map((model) => model.id) ?? [],
        )
      : []),
  ]);
  const customIds = parseModelIds(currentModelIds).filter(
    (id) => !builtInIds.has(id),
  );
  return [...defaultModelIds(provider, baseUrl), ...customIds];
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
