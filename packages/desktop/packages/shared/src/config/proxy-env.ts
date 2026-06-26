import { getNetworkProxySettings } from './storage.ts';

/**
 * Convert stored proxy settings into environment variables for subprocesses.
 * Returns an empty object when proxy is disabled or not configured.
 */
export function getProxyEnvVars(): Record<string, string> {
  const settings = getNetworkProxySettings();
  if (!settings?.enabled) return {};

  const env: Record<string, string> = {};
  if (settings.httpProxy) {
    env.HTTP_PROXY = settings.httpProxy;
    env.http_proxy = settings.httpProxy;
  }
  if (settings.httpsProxy) {
    env.HTTPS_PROXY = settings.httpsProxy;
    env.https_proxy = settings.httpsProxy;
  }
  if (settings.noProxy) {
    env.NO_PROXY = settings.noProxy;
    env.no_proxy = settings.noProxy;
  }
  return env;
}
