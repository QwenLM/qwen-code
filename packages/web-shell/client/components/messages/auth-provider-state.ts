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
): string {
  const defaults =
    option.models?.map((model) => model.id) ??
    provider.models?.map((model) => model.id) ??
    [];
  return defaults.join(', ');
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

// The daemon derives the custom provider's install-time key from the
// submitted protocol+baseUrl and never publishes it in the catalog, so for
// such providers this returns undefined. Fabricating a protocol-scoped key
// here would show the wrong environment variable in the review preview.
export function selectedBaseUrlEnvKey(
  provider: DaemonAuthProviderDescriptor,
  baseUrl: string,
): string | undefined {
  if (Array.isArray(provider.baseUrl)) {
    const option = provider.baseUrl.find((item) => item.url === baseUrl);
    if (option?.envKey) return option.envKey;
  }
  return provider.envKey;
}

export function selectedBaseUrlDocumentationUrl(
  provider: DaemonAuthProviderDescriptor,
  baseUrl: string,
): string | undefined {
  if (Array.isArray(provider.baseUrl)) {
    const option = provider.baseUrl.find((item) => item.url === baseUrl);
    if (option?.documentationUrl) return option.documentationUrl;
  }
  return provider.documentationUrl;
}

export function shouldResetApiKeyAfterBaseUrlChange(
  provider: DaemonAuthProviderDescriptor,
  currentBaseUrl: string,
  nextBaseUrl: string,
): boolean {
  return (
    selectedBaseUrlEnvKey(provider, currentBaseUrl) !==
    selectedBaseUrlEnvKey(provider, nextBaseUrl)
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
  drafts: Map<string, string>,
): string {
  if (
    !shouldResetApiKeyAfterBaseUrlChange(provider, currentBaseUrl, nextBaseUrl)
  ) {
    return currentApiKey;
  }
  const currentDomain = selectedBaseUrlEnvKey(provider, currentBaseUrl);
  const nextDomain = selectedBaseUrlEnvKey(provider, nextBaseUrl);
  // A baseUrl without a known key domain has nothing to stash against — keep
  // the typed key rather than wiping it unrecoverably.
  if (!currentDomain || !nextDomain) return currentApiKey;
  drafts.set(currentDomain, currentApiKey);
  return drafts.get(nextDomain) ?? '';
}
