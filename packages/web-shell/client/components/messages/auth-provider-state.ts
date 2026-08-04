import type {
  DaemonAuthProviderBaseUrlOption,
  DaemonAuthProviderDescriptor,
} from '@qwen-code/webui/daemon-react-sdk';

export function normalizeModelIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ];
}

function modelIds(provider: DaemonAuthProviderDescriptor | null): string {
  return provider?.models?.map((model) => model.id).join(', ') ?? '';
}

export function baseUrlOptionModelIds(
  option: DaemonAuthProviderBaseUrlOption,
  provider: DaemonAuthProviderDescriptor,
  currentModelIds = '',
): string {
  const builtInIds = new Set([
    ...(provider.models?.map((model) => model.id) ?? []),
    ...(Array.isArray(provider.baseUrl)
      ? provider.baseUrl.flatMap(
          (item) => item.models?.map((model) => model.id) ?? [],
        )
      : []),
  ]);
  const defaults =
    option.models?.map((model) => model.id) ??
    provider.models?.map((model) => model.id) ??
    [];
  const customIds = normalizeModelIds(currentModelIds).filter(
    (id) => !builtInIds.has(id),
  );
  return [...new Set([...defaults, ...customIds])].join(', ');
}

export function selectedBaseUrlModelIds(
  provider: DaemonAuthProviderDescriptor,
  baseUrl: string,
): string {
  if (Array.isArray(provider.baseUrl)) {
    const option = provider.baseUrl.find((item) => item.url === baseUrl);
    if (option) return baseUrlOptionModelIds(option, provider);
  }
  return modelIds(provider);
}

export function selectedBaseUrlOptionIndex(
  provider: DaemonAuthProviderDescriptor,
  baseUrl: string,
): number {
  if (!Array.isArray(provider.baseUrl)) return 0;
  const index = provider.baseUrl.findIndex((option) => option.url === baseUrl);
  return index >= 0 ? index : 0;
}

export function selectedBaseUrlEnvKey(
  provider: DaemonAuthProviderDescriptor,
  baseUrl: string,
  protocol: string,
): string {
  if (Array.isArray(provider.baseUrl)) {
    const option = provider.baseUrl.find((item) => item.url === baseUrl);
    if (option?.envKey) return option.envKey;
  }
  return provider.envKey ?? `${protocol.toUpperCase()}_API_KEY`;
}

export function shouldResetApiKeyAfterBaseUrlChange(
  provider: DaemonAuthProviderDescriptor,
  currentBaseUrl: string,
  nextBaseUrl: string,
  protocol: string,
): boolean {
  return (
    selectedBaseUrlEnvKey(provider, currentBaseUrl, protocol) !==
    selectedBaseUrlEnvKey(provider, nextBaseUrl, protocol)
  );
}

/**
 * Computes the API key to show after an endpoint switch while keeping
 * per-credential-domain drafts in `drafts`, so a key typed for one endpoint
 * survives a round trip through another endpoint's key domain.
 */
export function apiKeyAfterBaseUrlChange(
  provider: DaemonAuthProviderDescriptor,
  currentBaseUrl: string,
  nextBaseUrl: string,
  currentApiKey: string,
  protocol: string,
  drafts: Map<string, string>,
): string {
  if (
    !shouldResetApiKeyAfterBaseUrlChange(
      provider,
      currentBaseUrl,
      nextBaseUrl,
      protocol,
    )
  ) {
    return currentApiKey;
  }
  const currentDomain = selectedBaseUrlEnvKey(
    provider,
    currentBaseUrl,
    protocol,
  );
  const nextDomain = selectedBaseUrlEnvKey(provider, nextBaseUrl, protocol);
  drafts.set(currentDomain, currentApiKey);
  return drafts.get(nextDomain) ?? '';
}
