import { buildSessionPathname } from '../utils/sessionPath';
import { clearSplitSessions } from '../utils/splitUrl';

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
 * Whether host-local affordances are safe to offer here: true only when this
 * page was served from a loopback host AND the shell is not pointed at a
 * different daemon origin. Deliberately narrower than "the browser and the
 * daemon are on the same machine": it is the same-origin form of that question.
 * A remote browser reaching a forwarded loopback daemon is excluded because its
 * page host is not loopback, and an explicit `?daemon=` naming another origin
 * is treated as remote even when that origin is loopback too — the shell cannot
 * prove a same-machine pair from a different origin.
 */
export function isLocalDaemon(): boolean {
  if (typeof window === 'undefined') return false;
  const base = getDaemonBaseUrl();
  if (base && base !== window.location.origin) return false;
  return isLoopbackHostname(window.location.hostname);
}

/**
 * Whether the connected daemon is the page's own origin. This gates the
 * browser-local file bridge: widening `?daemon=` past loopback made a
 * cross-origin target reachable for every consumer, and handing a client
 * directory to a remote daemon contradicts the bridge's "files stay on your
 * computer" promise. Keyed on the daemon's identity relative to the page —
 * never on loopback-ness — so the documented same-origin SSH-tunnel
 * deployment keeps working.
 */
export function isPageOriginDaemon(baseUrl: string | undefined): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return (
      new URL(baseUrl || window.location.origin, window.location.origin)
        .origin === window.location.origin
    );
  } catch {
    return false;
  }
}

const cachedDaemonTokens = new Map<string, string>();
const DAEMON_AUTH_MESSAGE_TYPE = 'qwen-daemon-auth';
const DEFAULT_TOKEN_MESSAGE_TIMEOUT_MS = 2500;
const DAEMON_TOKEN_STORAGE_KEY = 'qwen-daemon-token';

function daemonTokenStorageKey(baseUrl?: string): string {
  // Total by contract: callers include the boot path, and the module must
  // degrade rather than throw. An opaque-origin document (file://, srcdoc,
  // about:blank) has origin 'null' and window.location.href is not a usable
  // base; a window-less caller has no location at all. Both fall back to the
  // single (page-origin) key, which is the pre-persistence behavior.
  if (typeof window === 'undefined') return DAEMON_TOKEN_STORAGE_KEY;
  try {
    const pageOrigin = new URL(window.location.href).origin;
    // baseUrl / getDaemonBaseUrl() are absolute origins by construction (see
    // getAllowedDaemonOrigin), so no base argument is needed here.
    const daemonOrigin = new URL(baseUrl || getDaemonBaseUrl() || pageOrigin)
      .origin;
    return daemonOrigin === pageOrigin
      ? DAEMON_TOKEN_STORAGE_KEY
      : `${DAEMON_TOKEN_STORAGE_KEY}:${daemonOrigin}`;
  } catch {
    return DAEMON_TOKEN_STORAGE_KEY;
  }
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
  if (typeof window === 'undefined') return false;
  return (
    readTokenFromLocation() !== undefined ||
    readStoredDaemonToken(daemonTokenStorageKey()) !== undefined
  );
}

export function getDaemonToken(baseUrl?: string): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const key = daemonTokenStorageKey(baseUrl);
  const cached = cachedDaemonTokens.get(key);
  if (cached) return cached;
  const fromUrl =
    key === daemonTokenStorageKey() ? readTokenFromLocation() : undefined;
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

export function getDaemonAuthHeaders(): HeadersInit | undefined {
  const token = getDaemonToken();
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
      parsed.hash ||
      !/^[a-z0-9._\-[\]:]+$/iu.test(parsed.hostname)
    ) {
      return '';
    }
    // A bracketed IPv6 literal is not a valid CSP host-source (CSP3 host-part
    // excludes '[', ']' and ':'), so a remote http://[::1]:4170 target would
    // be served a connect-src every browser drops, and the gate would loop on
    // "unreachable" with only a console violation as evidence. Exempt the
    // page's own origin: 'self' covers it, and qwen serve --hostname '[::1]'
    // is a documented deployment.
    if (
      parsed.hostname.startsWith('[') &&
      typeof window !== 'undefined' &&
      parsed.origin !== window.location.origin
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
  // Session-scoped like the rest: a `?split=` deep link names sessions of the
  // daemon being left behind.
  url.searchParams.delete('split');
  if (daemonOrigin === url.origin) {
    url.searchParams.delete('daemon');
  } else {
    url.searchParams.set('daemon', daemonOrigin);
  }
  url.hash = '';
  return url.toString();
}

// ponytail: remember one target in this tab; no persistent host catalog.
const DAEMON_TARGET_CONFIRMATION_KEY = 'qwen-daemon-target-confirmed';

export function confirmDaemonTarget(origin: string): void {
  try {
    window.sessionStorage.setItem(DAEMON_TARGET_CONFIRMATION_KEY, origin);
  } catch {
    // Without storage the next load asks for confirmation again.
  }
}

export function isKnownDaemonTarget(origin: string): boolean {
  if (origin === window.location.origin) return true;
  try {
    return (
      window.sessionStorage.getItem(DAEMON_TARGET_CONFIRMATION_KEY) === origin
    );
  } catch {
    return false;
  }
}

export function navigateToDaemon(raw: string, token?: string): boolean {
  const daemonOrigin = getAllowedDaemonOrigin(raw);
  const nextUrl = buildDaemonConnectionUrl(raw, window.location.href);
  if (!daemonOrigin || !nextUrl) return false;
  // Read before the assign: getDaemonBaseUrl() follows the live URL.
  const previousDaemonOrigin = getDaemonBaseUrl() || window.location.origin;
  if (token !== undefined) persistDaemonToken(token.trim(), daemonOrigin);
  confirmDaemonTarget(daemonOrigin);
  // A `?daemon=` that does not resolve still has to be rewritten away. Without
  // this the gate's "return to local workspaces" escape hatch — which targets
  // the page origin, and `getDaemonBaseUrl()` reports the page origin for an
  // unresolvable override — would reload the same invalid URL and loop.
  const requestedOverride = new URLSearchParams(window.location.search).get(
    'daemon',
  );
  const urlAlreadyNamesTarget =
    requestedOverride === null ||
    getAllowedDaemonOrigin(requestedOverride) === daemonOrigin;
  if (daemonOrigin === previousDaemonOrigin && urlAlreadyNamesTarget) {
    // Reconnecting to the target already in use. `nextUrl` is built for a
    // target CHANGE: it resets the pathname and drops `?workspace=`,
    // `?context=`, `?split=` and the hash, so assigning it would reboot the
    // shell out of the open session that a plain refresh keeps. The current URL
    // already names this target, and boot has already scrubbed any `?token=`
    // from it — so reloading is exactly the plain refresh this case means.
    // Unless the credential cannot outlive it: with storage disabled the
    // reloaded page would boot with no token at all, so stay on this one.
    if (token !== undefined && !hasReloadSurvivableDaemonToken()) return false;
    window.location.reload();
    return true;
  }
  // The per-tab split set (App.tsx's refresh restore) is session-scoped state
  // for the daemon being left, and a switch back to the page origin leaves one
  // just the same: this navigation stays in the same tab, so the entry would
  // survive and boot the next daemon into a split of sessions it has never had.
  clearSplitSessions();
  // `nextUrl` drops `?token=` and clears the hash, so a credential that lives
  // only in the URL cannot survive this navigation — and the invalid-target
  // boot path deliberately leaves one there for recovery, with this escape
  // hatch as its only exit. Salvage it under the page origin's key, but only
  // when the address bar names no other daemon: a URL token belongs to the
  // target it was issued for, never to a replacement.
  //
  // `previousDaemonOrigin` cannot carry that test alone. This block is
  // reachable only when the override was rejected, and rejection makes
  // `getDaemonBaseUrl()` return '', collapsing `previousDaemonOrigin` onto the
  // page origin exactly where a foreign target was named. Read provenance off
  // the raw override instead: one still spelling http(s) had a real daemon
  // behind it — a path, query, hash, credentials or cross-origin bracketed
  // IPv6 host is what got it rejected — so its fragment credential belongs to
  // that origin and must not be re-filed here. A non-http override never named
  // a daemon, which keeps #12010's own `?daemon=ftp://…` recovery salvageable.
  if (
    token === undefined &&
    daemonOrigin === window.location.origin &&
    daemonOrigin === previousDaemonOrigin &&
    (requestedOverride === null ||
      !/^https?:/iu.test(requestedOverride.trim()))
  ) {
    const fromUrl = readTokenFromLocation();
    if (fromUrl) persistDaemonToken(fromUrl, daemonOrigin);
  }
  // Past this point the credential rides on storage alone, so ask the key this
  // navigation lands on — not hasReloadSurvivableDaemonToken(), which answers
  // for the target being left. With the write refused the switch would land
  // unauthenticated while reporting success. An empty token means the daemon
  // needs none, so there is nothing to lose.
  if (
    token?.trim() &&
    readStoredDaemonToken(daemonTokenStorageKey(daemonOrigin)) === undefined
  ) {
    return false;
  }
  window.location.assign(nextUrl);
  return true;
}
