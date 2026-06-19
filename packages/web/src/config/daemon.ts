export interface WebDaemonConfig {
  baseUrl: string;
  token?: string;
  initialSessionId?: string;
  clientId?: string;
}

export interface WebDaemonLocation {
  origin: string;
  pathname: string;
  search: string;
}

export function getWebDaemonConfig(): WebDaemonConfig {
  if (typeof window === 'undefined') return { baseUrl: '' };
  return getWebDaemonConfigFromLocation(window.location);
}

export function getWebDaemonConfigFromLocation(
  location: WebDaemonLocation,
): WebDaemonConfig {
  const params = new URLSearchParams(location.search);
  const baseUrl = resolveBaseUrl(
    params.get('daemon') ?? undefined,
    location.origin,
  );
  const token = params.get('token') ?? undefined;
  const initialSessionId =
    params.get('session') || readSessionIdFromPathname(location.pathname);
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

function resolveBaseUrl(input: string | undefined, origin: string): string {
  if (!input) return origin;
  const allowed = getAllowedDaemonOrigin(input, origin);
  return allowed ?? origin;
}

function getAllowedDaemonOrigin(
  input: string,
  origin: string,
): string | undefined {
  try {
    const url = new URL(input, origin);
    const current = new URL(origin);
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
