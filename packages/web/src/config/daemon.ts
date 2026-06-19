export interface WebDaemonConfig {
  baseUrl: string;
  token?: string;
  initialSessionId?: string;
  clientId?: string;
}

export function getWebDaemonConfig(): WebDaemonConfig {
  if (typeof window === 'undefined') return { baseUrl: '' };

  const params = new URLSearchParams(window.location.search);
  const baseUrl = resolveBaseUrl(params.get('daemon') ?? undefined);
  const token = params.get('token') ?? undefined;
  const initialSessionId =
    params.get('session') ||
    readSessionIdFromPathname(window.location.pathname);
  const clientId = params.get('clientId') ?? undefined;

  return {
    baseUrl,
    ...(token ? { token } : {}),
    ...(initialSessionId ? { initialSessionId } : {}),
    ...(clientId ? { clientId } : {}),
  };
}

export function readSessionIdFromPathname(
  pathname: string,
): string | undefined {
  const match = /^\/session\/([^/]+)$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function resolveBaseUrl(input: string | undefined): string {
  if (!input) return window.location.origin;
  const allowed = getAllowedDaemonOrigin(input);
  return allowed ?? window.location.origin;
}

function getAllowedDaemonOrigin(input: string): string | undefined {
  try {
    const url = new URL(input, window.location.origin);
    const current = new URL(window.location.origin);
    if (url.origin === current.origin) return url.origin;

    const isLocalhost =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]';
    if (isLocalhost && url.protocol === current.protocol) {
      return url.origin;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
