import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { normalizeProxyUrl } from '@qwen-code/qwen-code-core';

/**
 * Resolve and apply proxy settings for channel service processes.
 *
 * The normal CLI path applies proxy via loadCliConfig -> Config constructor ->
 * setGlobalDispatcher, but channel runtimes do not call loadCliConfig. This
 * mirrors that resolution logic and also returns the resolved URL so channel
 * adapters can configure non-fetch HTTP clients.
 */
export function resolveProxy(
  cliProxy?: string,
  settingsProxy?: string,
): string | undefined {
  const proxyUrl = resolveProxyUrl(cliProxy, settingsProxy);
  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  }
  return proxyUrl;
}

export function resolveProxyUrl(
  cliProxy?: string,
  settingsProxy?: string,
): string | undefined {
  return normalizeProxyUrl(
    cliProxy ||
      settingsProxy ||
      process.env['HTTPS_PROXY'] ||
      process.env['https_proxy'] ||
      process.env['HTTP_PROXY'] ||
      process.env['http_proxy'],
  );
}
