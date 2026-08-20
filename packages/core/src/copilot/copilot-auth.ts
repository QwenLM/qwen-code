// packages/core/src/copilot/copilot-auth.ts
import { randomUUID } from 'node:crypto';
import {
  open,
  writeFile,
  readFile,
  mkdir,
  unlink,
  rename,
} from 'node:fs/promises';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { inspect } from 'node:util';
import lockfile from 'proper-lockfile';
import { createDebugLogger } from '../utils/debugLogger.js';

export interface CopilotAuthSnapshot {
  readonly bearer: string;
  readonly endpointsApi: string;
  readonly expiresAtMs: number;
}

export interface CopilotTokenManager {
  getSnapshot(): Promise<CopilotAuthSnapshot>;
  forceRefresh(): Promise<void>;
}

export interface DiscoveredToken {
  token: string;
  source: string;
}

export class CopilotTokenNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CopilotTokenNotFoundError';
  }
}

function isCopilotToken(t: string): boolean {
  return t.startsWith('ghu_') || t.startsWith('gho_');
}

function extractGhuFromJson(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;

  // hosts.json: { "github.com:Iv1.xxx": { oauth_token | token } }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      const tok = (v['oauth_token'] ?? v['token']) as string | undefined;
      if (typeof tok === 'string' && isCopilotToken(tok)) return tok;
    }
  }
  // VS Code: { accounts: [{ token }] }
  if (Array.isArray(obj['accounts'])) {
    for (const acc of obj['accounts']) {
      if (
        acc &&
        typeof acc === 'object' &&
        typeof (acc as Record<string, unknown>)['token'] === 'string'
      ) {
        const tok = (acc as Record<string, string>)['token'];
        if (isCopilotToken(tok)) return tok;
      }
    }
  }
  // flat: { token | oauth_token }
  const flatTok = (obj['oauth_token'] ?? obj['token']) as string | undefined;
  if (typeof flatTok === 'string' && isCopilotToken(flatTok)) return flatTok;

  // Copilot CLI: { copilotTokens: { "https://github.com:login": "gho_..." } }
  if (obj['copilotTokens'] && typeof obj['copilotTokens'] === 'object') {
    for (const v of Object.values(
      obj['copilotTokens'] as Record<string, unknown>,
    )) {
      if (typeof v === 'string' && isCopilotToken(v)) return v;
    }
  }
  return null;
}

function defaultSearchPaths(): string[] {
  const home = homedir();
  const paths = [
    join(home, '.config', 'github-copilot', 'hosts.json'),
    join(home, '.config', 'github-copilot', 'apps.json'),
    join(home, '.copilot', 'config.json'),
  ];
  // VS Code paths (platform-aware)
  if (process.platform === 'darwin') {
    paths.push(
      join(
        home,
        'Library',
        'Application Support',
        'Code',
        'User',
        'globalStorage',
        'github.copilot',
        'hosts.json',
      ),
    );
  } else if (process.platform === 'win32') {
    const appdata = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming');
    paths.push(
      join(
        appdata,
        'Code',
        'User',
        'globalStorage',
        'github.copilot',
        'hosts.json',
      ),
    );
  } else {
    paths.push(
      join(
        home,
        '.config',
        'Code',
        'User',
        'globalStorage',
        'github.copilot',
        'hosts.json',
      ),
    );
  }
  return paths;
}

export async function discoverGithubToken(opts?: {
  overridePath?: string;
}): Promise<DiscoveredToken> {
  // 1. $GITHUB_TOKEN env (only ghu_/gho_ prefix)
  const envToken = process.env['GITHUB_TOKEN'];
  if (envToken && isCopilotToken(envToken)) {
    return { token: envToken, source: 'GITHUB_TOKEN env' };
  }

  // 2. override path or $COPILOT_GITHUB_TOKEN_PATH
  const overridePath =
    opts?.overridePath ?? process.env['COPILOT_GITHUB_TOKEN_PATH'];
  const paths = overridePath ? [overridePath] : defaultSearchPaths();

  for (const p of paths) {
    try {
      const raw = await readFile(p, 'utf-8');
      const tok = extractGhuFromJson(JSON.parse(raw));
      if (tok) return { token: tok, source: p };
    } catch {
      // file missing or invalid — try next
    }
  }

  throw new CopilotTokenNotFoundError(
    'No GitHub Copilot token (ghu_/gho_) found. Run /auth to start device flow, or install gh/VS Code Copilot.',
  );
}

const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const COPILOT_SCOPE = 'read:user';
const DEFAULT_COPILOT_DOMAIN = 'github.com';
const COPILOT_HOSTS_KEY = `github.com:${COPILOT_CLIENT_ID}`;

const debugLogger = createDebugLogger('COPILOT_AUTH');

interface HostsFilePreimage {
  readonly bytes: Buffer | null;
  readonly existing: Record<string, unknown>;
}

const githubTokenPersistenceTails = new Map<string, Promise<void>>();

const GITHUB_TOKEN_PERSISTENCE_LOCK_OPTIONS: lockfile.LockOptions = {
  realpath: false,
  retries: {
    retries: 8,
    minTimeout: 25,
    maxTimeout: 500,
    factor: 2,
    randomize: true,
  },
  stale: 10_000,
  onCompromised: (error) => {
    debugLogger.warn('GitHub token persistence lock compromised:', error);
  },
};

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function makeGithubTokenTempPath(filePath: string): string {
  return `${filePath}.tmp.${process.pid}.${randomUUID()}`;
}

function serializeGithubTokenPersistence<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous =
    githubTokenPersistenceTails.get(filePath) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  githubTokenPersistenceTails.set(filePath, tail);
  void tail.then(() => {
    if (githubTokenPersistenceTails.get(filePath) === tail) {
      githubTokenPersistenceTails.delete(filePath);
    }
  });
  return result;
}

async function readHostsFilePreimage(
  filePath: string,
): Promise<HostsFilePreimage> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (isNotFound(error)) {
      return { bytes: null, existing: {} };
    }
    throw error;
  }

  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // file invalid — start fresh
  }
  return { bytes, existing };
}

async function matchesPostImage(
  filePath: string,
  postImage: Buffer,
): Promise<boolean> {
  try {
    return (await readFile(filePath)).equals(postImage);
  } catch {
    return false;
  }
}

async function restoreHostsFilePreimage(
  filePath: string,
  preimage: Buffer | null,
  postImage: Buffer,
): Promise<boolean> {
  if (!(await matchesPostImage(filePath, postImage))) {
    return false;
  }

  if (preimage === null) {
    try {
      await unlink(filePath);
      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      throw error;
    }
  }

  const tmp = makeGithubTokenTempPath(filePath);
  try {
    await writeFile(tmp, preimage, { mode: 0o600 });
    if (!(await matchesPostImage(filePath, postImage))) {
      return false;
    }
    await rename(tmp, filePath);
    return true;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

function attachLockReleaseError(
  error: unknown,
  releaseError: unknown,
): boolean {
  if (!(error instanceof Error) || 'cause' in error) {
    return false;
  }

  try {
    Object.defineProperty(error, 'cause', {
      value: releaseError,
      configurable: true,
      writable: true,
    });
    return true;
  } catch {
    return false;
  }
}

export async function persistGithubToken(
  token: string,
  opts?: { hostsFilePath?: string; signal?: AbortSignal },
): Promise<void> {
  const filePath = resolve(
    opts?.hostsFilePath ??
      join(homedir(), '.config', 'github-copilot', 'hosts.json'),
  );
  const signal = opts?.signal;
  throwIfAborted(signal);

  return serializeGithubTokenPersistence(filePath, async () => {
    throwIfAborted(signal);
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(
      filePath,
      GITHUB_TOKEN_PERSISTENCE_LOCK_OPTIONS,
    );
    let persistenceError: unknown;
    let persistenceFailed = false;
    try {
      throwIfAborted(signal);
      const preimage = await readHostsFilePreimage(filePath);
      throwIfAborted(signal);

      const postImage = Buffer.from(
        JSON.stringify(
          {
            ...preimage.existing,
            [COPILOT_HOSTS_KEY]: { oauth_token: token },
          },
          null,
          2,
        ),
      );

      throwIfAborted(signal);
      const tmp = makeGithubTokenTempPath(filePath);
      let renamed = false;
      try {
        await writeFile(tmp, postImage, { mode: 0o600, signal });
        throwIfAborted(signal);
        await rename(tmp, filePath);
        renamed = true;
        throwIfAborted(signal);
      } catch (error) {
        await unlink(tmp).catch(() => undefined);
        if (
          renamed &&
          signal?.aborted &&
          !(await restoreHostsFilePreimage(filePath, preimage.bytes, postImage))
        ) {
          throw new Error('Login cancelled; hosts.json recovery conflict');
        }
        throw error;
      }
    } catch (error) {
      persistenceError = error;
      persistenceFailed = true;
    }

    let releaseError: unknown;
    let releaseFailed = false;
    try {
      await release();
    } catch (error) {
      releaseError = error;
      releaseFailed = true;
    }

    if (persistenceFailed) {
      if (
        releaseFailed &&
        !attachLockReleaseError(persistenceError, releaseError)
      ) {
        throw new AggregateError(
          [persistenceError, releaseError],
          'GitHub token persistence and lock release both failed',
        );
      }
      throw persistenceError;
    }
    if (releaseFailed) {
      throw releaseError;
    }
  });
}

export class CopilotExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CopilotExchangeError';
  }
}

const DEFAULT_GITHUB_API_BASE = 'https://api.github.com';

interface CopilotTokenEnvelope {
  token: string;
  expires_at: number;
  refresh_in?: number;
  endpoints?: { api?: string; proxy?: string; telemetry?: string };
}

export async function exchangeGhuForCapi(
  ghu: string,
  opts?: { fetchImpl?: typeof fetch; githubApiBase?: string },
): Promise<{ bearer: string; endpointsApi: string; expiresAtMs: number }> {
  if (!ghu.startsWith('ghu_')) {
    throw new CopilotExchangeError(
      'Token must have ghu_ prefix for CAPI exchange',
    );
  }
  const f = opts?.fetchImpl ?? fetch;
  const base = opts?.githubApiBase ?? DEFAULT_GITHUB_API_BASE;
  const url = `${base}/copilot_internal/v2/token`;

  const res = await f(url, {
    headers: {
      Authorization: `token ${ghu}`,
      Accept: 'application/json',
      'User-Agent': 'qwen-code-copilot/0.1',
    },
  });

  if (res.status >= 400 && res.status < 500) {
    const body = await res.text();
    throw new CopilotExchangeError(
      `CAPI exchange failed: HTTP ${res.status} ${body}`,
    );
  }
  if (!res.ok) {
    throw new CopilotExchangeError(`CAPI exchange failed: HTTP ${res.status}`);
  }

  const envelope = (await res.json()) as CopilotTokenEnvelope;
  const proxyEp = parseProxyEp(envelope.token);
  const endpointsApi = proxyEp ?? envelope.endpoints?.api ?? '';
  if (!endpointsApi) {
    throw new CopilotExchangeError(
      'CAPI envelope missing endpoints.api and token has no proxy-ep',
    );
  }
  return {
    bearer: envelope.token,
    endpointsApi,
    expiresAtMs: envelope.expires_at * 1000,
  };
}

export function parseProxyEp(bearer: string): string | null {
  const match = bearer.match(/proxy-ep=([^;]+)/);
  if (!match) return null;
  const host = match[1].replace(/^proxy\./, 'api.');
  return `https://${host}`;
}

const REFRESH_BUFFER_MS = 60_000;
const LOCK_TIMEOUT_MS = 8_000;
const LOCK_POLL_MS = 100;
const LOCK_STALE_MS = 30_000;

class RedactedString extends String {
  [inspect.custom]() {
    return '[redacted]';
  }
  override toString() {
    return '[redacted]';
  }
  toJSON() {
    return '[redacted]';
  }
}

interface CacheData {
  bearer: string;
  endpointsApi: string;
  expiresAtMs: number;
  cachedAtMs: number;
  ghuSource?: string;
}

function isCacheData(data: unknown): data is CacheData {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const value = data as Record<string, unknown>;
  return (
    typeof value['bearer'] === 'string' &&
    value['bearer'].length > 0 &&
    typeof value['endpointsApi'] === 'string' &&
    value['endpointsApi'].length > 0 &&
    typeof value['expiresAtMs'] === 'number' &&
    Number.isFinite(value['expiresAtMs']) &&
    typeof value['cachedAtMs'] === 'number' &&
    Number.isFinite(value['cachedAtMs']) &&
    (value['ghuSource'] === undefined || typeof value['ghuSource'] === 'string')
  );
}

function cacheFingerprint(data: CacheData | null): string | null {
  if (!data) return null;
  return JSON.stringify([
    data.bearer,
    data.endpointsApi,
    data.expiresAtMs,
    data.cachedAtMs,
    data.ghuSource,
  ]);
}

async function acquireMintLock(lockFile: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const fh = await open(lockFile, 'wx', 0o600);
      await fh.writeFile(String(process.pid));
      await fh.close();
      return async () => {
        try {
          await unlink(lockFile);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // stale-steal
      try {
        const st = statSync(lockFile);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockFile);
        }
      } catch {
        // race — file gone
      }
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }
  throw new Error(`Copilot cache lock timeout after ${LOCK_TIMEOUT_MS}ms`);
}

async function readDiskCache(cacheFile: string): Promise<CacheData | null> {
  try {
    const raw = await readFile(cacheFile, 'utf-8');
    const data: unknown = JSON.parse(raw);
    return isCacheData(data) ? data : null;
  } catch {
    return null;
  }
}

async function writeDiskCache(
  cacheFile: string,
  data: CacheData,
): Promise<void> {
  await mkdir(dirname(cacheFile), { recursive: true, mode: 0o700 });
  const tmp = `${cacheFile}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
  await rename(tmp, cacheFile);
}

function isFresh(data: CacheData | null): data is CacheData {
  return !!data && data.expiresAtMs - REFRESH_BUFFER_MS > Date.now();
}

function snapshotFor(data: CacheData): CopilotAuthSnapshot {
  return Object.freeze({
    bearer: new RedactedString(data.bearer) as unknown as string,
    endpointsApi: data.endpointsApi,
    expiresAtMs: data.expiresAtMs,
  });
}

export function createCopilotTokenManager(opts?: {
  cacheFile?: string | false;
  fetchImpl?: typeof fetch;
}): CopilotTokenManager {
  const cacheFile =
    opts?.cacheFile ?? join(homedir(), '.config', 'qwen-code', 'copilot.json');
  const lockFile = typeof cacheFile === 'string' ? `${cacheFile}.lock` : null;
  const f = opts?.fetchImpl ?? fetch;

  let inMemory: CacheData | null = null;
  let mintInFlight: Promise<CacheData> | null = null;
  let forceRefreshInFlight: Promise<void> | null = null;

  async function mint(): Promise<CacheData> {
    const discovered = await discoverGithubToken();
    if (discovered.token.startsWith('gho_')) {
      const proxyEp = parseProxyEp(discovered.token);
      return {
        bearer: discovered.token,
        endpointsApi: proxyEp ?? 'https://api.githubcopilot.com',
        expiresAtMs: Date.now() + 3_600_000,
        cachedAtMs: Date.now(),
        ghuSource: discovered.source,
      };
    }

    const exchanged = await exchangeGhuForCapi(discovered.token, {
      fetchImpl: f,
    });
    return {
      bearer: exchanged.bearer,
      endpointsApi: exchanged.endpointsApi,
      expiresAtMs: exchanged.expiresAtMs,
      cachedAtMs: Date.now(),
      ghuSource: discovered.source,
    };
  }

  async function loadOrMint(): Promise<CacheData> {
    if (typeof cacheFile !== 'string' || !lockFile) {
      const data = await mint();
      inMemory = data;
      return data;
    }

    const diskCache = await readDiskCache(cacheFile);
    if (isFresh(diskCache)) {
      inMemory = diskCache;
      return diskCache;
    }

    const release = await acquireMintLock(lockFile);
    try {
      const lockedDiskCache = await readDiskCache(cacheFile);
      if (isFresh(lockedDiskCache)) {
        inMemory = lockedDiskCache;
        return lockedDiskCache;
      }
      const data = await mint();
      await writeDiskCache(cacheFile, data);
      inMemory = data;
      return data;
    } finally {
      await release();
    }
  }

  async function refresh(observedFingerprint: string | null): Promise<void> {
    if (typeof cacheFile !== 'string' || !lockFile) {
      inMemory = await mint();
      return;
    }

    const release = await acquireMintLock(lockFile);
    try {
      const diskCache = await readDiskCache(cacheFile);
      if (
        isFresh(diskCache) &&
        cacheFingerprint(diskCache) !== observedFingerprint
      ) {
        inMemory = diskCache;
        return;
      }
      const data = await mint();
      await writeDiskCache(cacheFile, data);
      inMemory = data;
    } finally {
      await release();
    }
  }

  async function getSnapshot(): Promise<CopilotAuthSnapshot> {
    if (forceRefreshInFlight) await forceRefreshInFlight;
    if (isFresh(inMemory)) return snapshotFor(inMemory);

    if (!mintInFlight) {
      mintInFlight = loadOrMint().finally(() => {
        mintInFlight = null;
      });
    }
    return snapshotFor(await mintInFlight);
  }

  async function forceRefresh(): Promise<void> {
    if (!forceRefreshInFlight) {
      forceRefreshInFlight = (async () => {
        const observed =
          inMemory ??
          (typeof cacheFile === 'string'
            ? await readDiskCache(cacheFile)
            : null);
        inMemory = null;
        await refresh(cacheFingerprint(observed));
      })().finally(() => {
        forceRefreshInFlight = null;
      });
    }
    await forceRefreshInFlight;
  }

  return { getSnapshot, forceRefresh };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Login cancelled');
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Login cancelled'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('Login cancelled'));
      },
      { once: true },
    );
  });
}

export async function runCopilotDeviceFlow(opts?: {
  signal?: AbortSignal;
  domain?: string;
  fetchImpl?: typeof fetch;
  notify?: (event: CopilotDeviceFlowEvent) => void;
}): Promise<{ token: string }> {
  const domain = opts?.domain ?? DEFAULT_COPILOT_DOMAIN;
  const f = opts?.fetchImpl ?? fetch;
  const signal = opts?.signal;
  const notify = opts?.notify;

  // 1. Request device code
  const codeRes = await f(`https://${domain}/login/device/code`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `client_id=${COPILOT_CLIENT_ID}&scope=${COPILOT_SCOPE}`,
    signal,
  });
  throwIfAborted(signal);
  if (!codeRes.ok)
    throw new Error(`Device code request failed: HTTP ${codeRes.status}`);
  const codeBody = (await codeRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
    expires_in: number;
  };
  throwIfAborted(signal);

  // Validate verification_uri is http(s)
  const parsed = new URL(codeBody.verification_uri);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Invalid verification_uri protocol: ${parsed.protocol}`);
  }

  notify?.({
    type: 'device_code',
    userCode: codeBody.user_code,
    verificationUri: parsed.href,
    intervalSeconds: codeBody.interval,
    expiresInSeconds: codeBody.expires_in,
  });

  // 2. Poll for access token
  let interval = codeBody.interval;
  const deadline = Date.now() + codeBody.expires_in * 1000;
  await abortableSleep(interval * 1000, signal); // waitBeforeFirstPoll

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Login cancelled');

    const tokenRes = await f(`https://${domain}/login/oauth/access_token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `client_id=${COPILOT_CLIENT_ID}&device_code=${codeBody.device_code}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
      signal,
    });
    throwIfAborted(signal);
    const tokenBody = (await tokenRes.json()) as {
      access_token?: string;
      error?: string;
      interval?: number;
    };
    throwIfAborted(signal);

    if (tokenBody.access_token) {
      return { token: tokenBody.access_token };
    }
    if (tokenBody.error === 'expired_token') {
      throw new Error(
        'Device code expired. Please re-run /auth and try again.',
      );
    }
    if (tokenBody.error === 'access_denied') {
      throw new Error('Authorization was denied. Re-run /auth to start over.');
    }
    if (tokenBody.error === 'slow_down') {
      if (typeof tokenBody.interval === 'number') interval = tokenBody.interval;
      else interval += 5;
    }
    await abortableSleep(interval * 1000, signal);
  }
  throw new Error('Device flow timed out waiting for authorization');
}

export type CopilotDeviceFlowEvent =
  | {
      type: 'device_code';
      userCode: string;
      verificationUri: string;
      intervalSeconds: number;
      expiresInSeconds: number;
    }
  | { type: 'progress'; message: string }
  | { type: 'error'; message: string };
