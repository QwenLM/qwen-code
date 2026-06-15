export function getDaemonBaseUrl(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  const raw = new URLSearchParams(window.location.search).get('daemon') || '';
  if (!raw) return '';
  return getAllowedDaemonOrigin(raw);
}

let cachedDaemonToken: string | undefined;

export function getDaemonToken(): string | undefined {
  if (cachedDaemonToken) return cachedDaemonToken;
  if (typeof window === 'undefined') {
    return undefined;
  }
  cachedDaemonToken =
    new URLSearchParams(window.location.search).get('token') || undefined;
  return cachedDaemonToken;
}

export function removeDaemonTokenFromUrl(): void {
  if (typeof window === 'undefined') return;
  if (import.meta.env.DEV) return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has('token')) return;
  url.searchParams.delete('token');
  window.history.replaceState(null, '', url);
}

export function getDaemonAuthHeaders(): HeadersInit | undefined {
  const token = getDaemonToken();
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

function getAllowedDaemonOrigin(raw: string): string {
  try {
    const parsed = new URL(raw, window.location.origin);
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    if (!isHttp) return '';
    if (parsed.origin === window.location.origin) return parsed.origin;
    const isLocalhost =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1' ||
      parsed.hostname === '[::1]';
    if (!isLocalhost) return '';
    const pagePort =
      window.location.port ||
      (window.location.protocol === 'https:' ? '443' : '80');
    const daemonPort =
      parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    if (daemonPort !== pagePort) return '';
    return parsed.origin;
  } catch {
    return '';
  }
}
