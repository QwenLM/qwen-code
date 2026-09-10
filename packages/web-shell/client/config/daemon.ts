export function getDaemonBaseUrl(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  const raw = new URLSearchParams(window.location.search).get('daemon') || '';
  if (!raw) return '';
  return getAllowedDaemonOrigin(raw);
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
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
  const hostname = base ? new URL(base).hostname : window.location.hostname;
  return isLoopbackHostname(hostname);
}

let cachedDaemonToken: string | undefined;
const DAEMON_AUTH_MESSAGE_TYPE = 'qwen-daemon-auth';
const DEFAULT_TOKEN_MESSAGE_TIMEOUT_MS = 2500;
const DAEMON_TOKEN_STORAGE_KEY = 'qwen-daemon-token';

// sessionStorage access can throw (privacy modes, storage-disabled
// embeds); the token flow must degrade to the pre-persistence behavior
// rather than break page load.
function readStoredDaemonToken(): string | undefined {
  try {
    return window.sessionStorage.getItem(DAEMON_TOKEN_STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function persistDaemonToken(token: string): void {
  cachedDaemonToken = token;
  try {
    window.sessionStorage.setItem(DAEMON_TOKEN_STORAGE_KEY, token);
  } catch {
    // Storage unavailable — the token still works for this load via the
    // in-memory cache; a refresh will lose it, matching the old behavior.
  }
}

/**
 * The one parse of the URL token grammar: `#token=` (preferred — unlike a
 * query param it is never sent to the server, so it stays out of access logs
 * and Referer headers; this is what `qwen serve --open` uses) with `?token=`
 * as legacy fallback (the dev launcher, hand-built URLs). Shared by
 * `getDaemonToken()` (which caches and persists the result) and
 * `hasReloadSurvivableDaemonToken()` (which must not touch the cache), so the
 * accepted spellings can never drift apart.
 */
function readTokenFromLocation(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const fromHash = new URLSearchParams(
    window.location.hash.replace(/^#/, ''),
  ).get('token');
  return (
    fromHash ||
    new URLSearchParams(window.location.search).get('token') ||
    undefined
  );
}

/**
 * Whether a fresh load of this page could still authenticate: a token in the
 * URL or in the per-tab persisted copy survives a reload. Retry affordances
 * that reload the page must check this first — when the token lives only in
 * this module's memory (URL stripped at boot, persist threw), a reload
 * strands the shell unauthenticated. Must not consult `getDaemonToken()`:
 * its in-memory cache always reports a token after boot.
 */
export function hasReloadSurvivableDaemonToken(): boolean {
  return (
    readTokenFromLocation() !== undefined ||
    readStoredDaemonToken() !== undefined
  );
}

export function getDaemonToken(): string | undefined {
  if (cachedDaemonToken) return cachedDaemonToken;
  if (typeof window === 'undefined') {
    return undefined;
  }
  const fromUrl = readTokenFromLocation();
  if (fromUrl) {
    // Persist per-tab so the token survives navigations that do not carry it.
    // sessionStorage (not localStorage) keeps the token scoped to this tab and
    // cleared when the tab closes.
    persistDaemonToken(fromUrl);
    return fromUrl;
  }
  // Refresh path: the URL was already cleaned on the first load — fall
  // back to the per-tab persisted copy.
  cachedDaemonToken = readStoredDaemonToken();
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
    if (!isLoopbackHostname(parsed.hostname)) return '';
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
