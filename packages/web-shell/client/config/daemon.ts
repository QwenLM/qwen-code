import { buildSessionPathname } from '../utils/sessionPath';

export function getDaemonBaseUrl(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  const raw = new URLSearchParams(window.location.search).get('daemon') || '';
  if (!raw) return '';
  return getAllowedDaemonOrigin(raw);
}

function isLoopbackHostname(hostname: string): boolean {
  const ipv4 = hostname.split('.');
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    (ipv4.length === 4 &&
      ipv4[0] === '127' &&
      ipv4.slice(1).every((part) => /^\d+$/u.test(part) && Number(part) <= 255))
  );
}

/**
 * Whether the browser and the daemon are on the same machine. Host-local
 * affordances (e.g. opening a folder in the OS file manager) only make sense
 * then; a LAN-paired client must not see them.
 */
export function isLocalDaemon(): boolean {
  if (typeof window === 'undefined') return false;
  const base = getDaemonBaseUrl();
  if (base && base !== window.location.origin) return false;
  return isLoopbackHostname(window.location.hostname);
}

const cachedDaemonTokens = new Map<string, string>();
const DAEMON_AUTH_MESSAGE_TYPE = 'qwen-daemon-auth';
const DEFAULT_TOKEN_MESSAGE_TIMEOUT_MS = 2500;
const DAEMON_TOKEN_STORAGE_KEY = 'qwen-daemon-token';

function daemonTokenStorageKey(baseUrl?: string): string {
  const pageOrigin = new URL(window.location.href).origin;
  const daemonOrigin = new URL(
    baseUrl || getDaemonBaseUrl() || pageOrigin,
    pageOrigin,
  ).origin;
  return daemonOrigin === pageOrigin
    ? DAEMON_TOKEN_STORAGE_KEY
    : `${DAEMON_TOKEN_STORAGE_KEY}:${daemonOrigin}`;
}

// sessionStorage access can throw (privacy modes, storage-disabled
// embeds); the token flow must degrade to the pre-persistence behavior
// rather than break page load.
function readStoredDaemonToken(key: string): string | undefined {
  try {
    return window.sessionStorage.getItem(key) || undefined;
  } catch {
    return undefined;
  }
}

export function persistDaemonToken(token: string, baseUrl?: string): void {
  const key = daemonTokenStorageKey(baseUrl);
  if (!token) {
    cachedDaemonTokens.delete(key);
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // Storage unavailable; the in-memory copy is already cleared.
    }
    return;
  }
  cachedDaemonTokens.set(key, token);
  try {
    window.sessionStorage.setItem(key, token);
  } catch {
    // Storage unavailable — the token still works for this load via the
    // in-memory cache; a refresh will lose it, matching the old behavior.
  }
}

export function getDaemonToken(baseUrl?: string): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const key = daemonTokenStorageKey(baseUrl);
  const cached = cachedDaemonTokens.get(key);
  if (cached) return cached;
  // Prefer the URL fragment (#token=) — unlike a ?token= query it is never
  // sent to the server, so it stays out of access logs and Referer headers
  // (this is what `qwen serve --open` now uses). Fall back to ?token= for
  // backward compatibility (e.g. the dev launcher / hand-built URLs).
  const fromHash = new URLSearchParams(
    window.location.hash.replace(/^#/, ''),
  ).get('token');
  const fromUrl =
    fromHash || new URLSearchParams(window.location.search).get('token') || '';
  if (fromUrl) {
    // Persist per-tab so the token survives navigations that do not carry it.
    // sessionStorage (not localStorage) keeps the token scoped to this tab and
    // cleared when the tab closes.
    persistDaemonToken(fromUrl, baseUrl);
    return fromUrl;
  }
  // Refresh path: the URL was already cleaned on the first load — fall
  // back to the per-tab persisted copy.
  const stored = readStoredDaemonToken(key);
  if (stored) cachedDaemonTokens.set(key, stored);
  return stored;
}

export function waitForDaemonTokenMessage(
  timeoutMs = DEFAULT_TOKEN_MESSAGE_TIMEOUT_MS,
): Promise<string | undefined> {
  if (typeof window === 'undefined' || window.parent === window) {
    return Promise.resolve(undefined);
  }
  const key = daemonTokenStorageKey();
  if (key !== DAEMON_TOKEN_STORAGE_KEY) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (token: string | undefined): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      if (token) cachedDaemonTokens.set(key, token);
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

export function getDaemonAuthHeaders(
  baseUrl?: string,
): HeadersInit | undefined {
  const token = getDaemonToken(baseUrl);
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

export function getAllowedDaemonOrigin(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return '';
    }
    return parsed.origin;
  } catch {
    return '';
  }
}

export function buildDaemonConnectionUrl(
  raw: string,
  currentHref: string,
): string | undefined {
  const daemonOrigin = getAllowedDaemonOrigin(raw);
  if (!daemonOrigin) return undefined;
  const url = new URL(currentHref);
  url.pathname = buildSessionPathname(url.pathname, undefined);
  url.searchParams.delete('workspace');
  url.searchParams.delete('context');
  url.searchParams.delete('addWorkspace');
  url.searchParams.delete('workspaceReturn');
  url.searchParams.delete('token');
  if (daemonOrigin === url.origin) {
    url.searchParams.delete('daemon');
  } else {
    url.searchParams.set('daemon', daemonOrigin);
  }
  url.hash = '';
  return url.toString();
}

export function navigateToDaemon(raw: string, token?: string): void {
  const daemonOrigin = getAllowedDaemonOrigin(raw);
  const nextUrl = buildDaemonConnectionUrl(raw, window.location.href);
  if (!daemonOrigin || !nextUrl) return;
  if (token !== undefined) persistDaemonToken(token.trim(), daemonOrigin);
  window.location.assign(nextUrl);
}
