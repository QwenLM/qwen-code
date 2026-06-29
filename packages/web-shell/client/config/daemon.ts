export function getDaemonBaseUrl(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  const raw = new URLSearchParams(window.location.search).get('daemon') || '';
  if (!raw) return '';
  return getAllowedDaemonOrigin(raw);
}

let cachedDaemonToken: string | undefined;
const DAEMON_AUTH_MESSAGE_TYPE = 'qwen-daemon-auth';
const DEFAULT_TOKEN_MESSAGE_TIMEOUT_MS = 2500;

export function getDaemonToken(): string | undefined {
  if (cachedDaemonToken) return cachedDaemonToken;
  if (typeof window === 'undefined') {
    return undefined;
  }
  // Prefer the URL fragment (#token=) — unlike a ?token= query it is never
  // sent to the server, so it stays out of access logs and Referer headers
  // (this is what `qwen serve --open` now uses). Fall back to ?token= for
  // backward compatibility (e.g. the dev launcher / hand-built URLs).
  const fromHash = new URLSearchParams(
    window.location.hash.replace(/^#/, ''),
  ).get('token');
  cachedDaemonToken =
    fromHash ||
    new URLSearchParams(window.location.search).get('token') ||
    undefined;
  return cachedDaemonToken;
}

export function waitForDaemonTokenMessage(
  timeoutMs = DEFAULT_TOKEN_MESSAGE_TIMEOUT_MS,
): Promise<string | undefined> {
  if (typeof window === 'undefined' || window.parent === window) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (token: string | undefined): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      cachedDaemonToken = token;
      resolve(token);
    };
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== window.parent) return;
      if (
        !event.origin.startsWith('chrome-extension://') &&
        !event.origin.startsWith('moz-extension://')
      ) {
        return;
      }
      const data = event.data as { type?: unknown; token?: unknown };
      if (data?.type !== DAEMON_AUTH_MESSAGE_TYPE) return;
      const token = typeof data.token === 'string' ? data.token : '';
      finish(token.trim() || undefined);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    window.addEventListener('message', onMessage);
  });
}

export function removeDaemonTokenFromUrl(): void {
  if (typeof window === 'undefined') return;
  if (import.meta.env.DEV) return;
  const url = new URL(window.location.href);
  let changed = false;
  if (url.searchParams.has('token')) {
    url.searchParams.delete('token');
    changed = true;
  }
  if (url.hash) {
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
    if (hashParams.has('token')) {
      hashParams.delete('token');
      const rest = hashParams.toString();
      url.hash = rest ? `#${rest}` : '';
      changed = true;
    }
  }
  if (changed) window.history.replaceState(null, '', url);
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
