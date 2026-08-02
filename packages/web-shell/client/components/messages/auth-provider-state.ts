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
