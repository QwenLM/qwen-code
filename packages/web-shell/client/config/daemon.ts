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
    const isAllowedHost =
      parsed.origin === window.location.origin ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1' ||
      parsed.hostname === '[::1]';
    return isAllowedHost ? parsed.origin : '';
  } catch {
    return '';
  }
}
