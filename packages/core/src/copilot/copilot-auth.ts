// packages/core/src/copilot/copilot-auth.ts
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
import { join, dirname } from 'node:path';
import { inspect } from 'node:util';

export interface CopilotAuthSnapshot {
  readonly bearer: string;
  readonly endpointsApi: string;
  readonly expiresAtMs: number;
}

export interface CopilotTokenManager {
  getSnapshot(): Promise<CopilotAuthSnapshot>;
  forceRefresh(): Promise<void>;
  getAvailableModelIds(): Promise<string[] | null>;
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
    return JSON.parse(raw) as CacheData;
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

  async function mint(): Promise<CacheData> {
    const discovered = await discoverGithubToken();
    let data: CacheData;
    if (discovered.token.startsWith('gho_')) {
      const proxyEp = parseProxyEp(discovered.token);
      data = {
        bearer: discovered.token,
        endpointsApi: proxyEp ?? 'https://api.githubcopilot.com',
        expiresAtMs: Date.now() + 3_600_000,
        cachedAtMs: Date.now(),
        ghuSource: discovered.source,
      };
    } else {
      const exchanged = await exchangeGhuForCapi(discovered.token, {
        fetchImpl: f,
      });
      data = {
        bearer: exchanged.bearer,
        endpointsApi: exchanged.endpointsApi,
        expiresAtMs: exchanged.expiresAtMs,
        cachedAtMs: Date.now(),
        ghuSource: discovered.source,
      };
    }
    if (typeof cacheFile === 'string' && lockFile) {
      const release = await acquireMintLock(lockFile);
      try {
        // double-check under lock
        const diskCheck = await readDiskCache(cacheFile);
        if (isFresh(diskCheck)) {
          inMemory = diskCheck;
          return diskCheck;
        }
        await writeDiskCache(cacheFile, data);
      } finally {
        await release();
      }
    }
    inMemory = data;
    return data;
  }

  async function getSnapshot(): Promise<CopilotAuthSnapshot> {
    if (isFresh(inMemory)) {
      const d = inMemory!;
      return Object.freeze({
        bearer: new RedactedString(d.bearer) as unknown as string,
        endpointsApi: d.endpointsApi,
        expiresAtMs: d.expiresAtMs,
      });
    }
    if (!mintInFlight) {
      mintInFlight = mint().finally(() => {
        mintInFlight = null;
      });
    }
    const data = await mintInFlight;
    return Object.freeze({
      bearer: new RedactedString(data.bearer) as unknown as string,
      endpointsApi: data.endpointsApi,
      expiresAtMs: data.expiresAtMs,
    });
  }

  async function forceRefresh(): Promise<void> {
    inMemory = null;
    if (typeof cacheFile === 'string') {
      try {
        await unlink(cacheFile);
      } catch {
        // ok
      }
    }
    await getSnapshot();
  }

  async function getAvailableModelIds(): Promise<string[] | null> {
    return null; // populated by Task 4.1 via modelsList; stub for now
  }

  return { getSnapshot, forceRefresh, getAvailableModelIds };
}

const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const COPILOT_SCOPE = 'read:user';
const DEFAULT_COPILOT_DOMAIN = 'github.com';

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
  });
  if (!codeRes.ok)
    throw new Error(`Device code request failed: HTTP ${codeRes.status}`);
  const codeBody = (await codeRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
    expires_in: number;
  };

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
    });
    const tokenBody = (await tokenRes.json()) as {
      access_token?: string;
      error?: string;
      interval?: number;
    };

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
