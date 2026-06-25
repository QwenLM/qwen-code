/**
 * Resolve the ASR endpoint + credentials for desktop voice dictation.
 *
 * The desktop drives Qwen over ACP and stores no DashScope baseUrl/apiKey of its
 * own — the real credentials live in the qwen CLI's config (`~/.qwen`). We resolve
 * them from, in order:
 *   1. OAuth login        — `~/.qwen/oauth_creds.json` (access_token + resource_url)
 *   2. API-key login      — `~/.qwen/settings.json` (a DashScope compatible-mode
 *                           modelProvider, with its key from settings `env`)
 *   3. Environment        — DASHSCOPE_API_KEY, or OPENAI_API_KEY with OPENAI_BASE_URL
 *
 * The voice model is the user-selected one persisted in desktop settings
 * (defaults to qwen3-asr-flash); its transport (batch vs realtime) is derived
 * downstream from the model id.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { isLoopbackHost } from './net-guard';
import type { VoiceConfig } from './transcribe';

const DEFAULT_DASHSCOPE_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';
const NO_CREDENTIALS_ERROR =
  'Voice dictation needs Qwen credentials. Sign in to Qwen Code (or set a DashScope API key), then try again.';

interface ResolvedCredentials {
  baseUrl: string;
  apiKey: string;
}

interface ResolveDesktopVoiceConfigDeps {
  readQwenJson?: <T>(file: string) => Promise<T | undefined>;
  getVoiceModel?: () => string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/**
 * Normalize a base URL: prepend `https://` when no scheme is present (an explicit
 * `http://` is preserved here and rejected later by the cleartext guard), strip
 * trailing slashes, and ensure a `/v1` suffix. Exported for tests.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  const withProto = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withProto);
    if (!url.pathname.split('/').includes('v1')) {
      url.pathname = `${url.pathname.replace(/\/$/, '')}/v1`;
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return withProto.includes('/v1') ? withProto : `${withProto}/v1`;
  }
}

async function readQwenJsonFromDisk<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(
      await readFile(join(homedir(), '.qwen', file), 'utf-8'),
    ) as T;
  } catch {
    return undefined;
  }
}

async function getStoredVoiceModel(): Promise<string> {
  const { getVoiceModel } = await import('@craft-agent/shared/config');
  return getVoiceModel();
}

/** 1) Qwen OAuth device-flow credentials. */
async function fromOAuth(
  deps: Required<Pick<ResolveDesktopVoiceConfigDeps, 'readQwenJson' | 'now'>>,
): Promise<ResolvedCredentials | undefined> {
  const creds = await deps.readQwenJson<{
    access_token?: string;
    resource_url?: string;
    expiry_date?: number;
  }>('oauth_creds.json');
  const apiKey = creds?.access_token?.trim();
  if (!apiKey) return undefined;
  // Skip an expired token so resolution falls through to a working API key
  // instead of selecting a stale OAuth token that will 401.
  if (
    typeof creds?.expiry_date === 'number' &&
    creds.expiry_date <= deps.now() + 30_000
  ) {
    return undefined;
  }
  return {
    apiKey,
    baseUrl: normalizeBaseUrl(creds?.resource_url?.trim() || DEFAULT_DASHSCOPE_BASE_URL),
  };
}

// Provider shape in ~/.qwen/settings.json: the key is referenced by `envKey`
// (the env-var name), never stored inline.
interface QwenProvider {
  baseUrl?: string;
  envKey?: string;
}
interface QwenSettings {
  env?: Record<string, string>;
  modelProviders?: Record<string, QwenProvider[]>;
}

/** qwen3-asr models live on the DashScope OpenAI-compatible endpoint. Exported for tests. */
export function isDashscopeCompatible(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      /(^|\.)dashscope(-intl|-us)?\.aliyuncs\.com$/.test(u.hostname) &&
      u.pathname.includes('/compatible-mode')
    );
  } catch {
    return false;
  }
}

/** 2) API-key login: a DashScope compatible-mode provider in settings.json. */
async function fromQwenSettings(
  deps: Required<Pick<ResolveDesktopVoiceConfigDeps, 'readQwenJson' | 'env'>>,
): Promise<ResolvedCredentials | undefined> {
  const settings = await deps.readQwenJson<QwenSettings>('settings.json');
  if (!settings) return undefined;
  const env = settings.env ?? {};
  const keyFor = (p: QwenProvider): string | undefined => {
    if (!p.envKey) return undefined;
    return deps.env[p.envKey]?.trim() || env[p.envKey]?.trim() || undefined;
  };
  const providers = Object.values(settings.modelProviders ?? {}).flat();
  for (const provider of providers) {
    if (provider.baseUrl && isDashscopeCompatible(provider.baseUrl)) {
      const apiKey = keyFor(provider);
      if (apiKey) return { baseUrl: normalizeBaseUrl(provider.baseUrl), apiKey };
    }
  }
  return undefined;
}

/** 3) Explicit environment override. */
function fromEnv(env: NodeJS.ProcessEnv): ResolvedCredentials | undefined {
  const dashscopeKey = env['DASHSCOPE_API_KEY']?.trim();
  if (dashscopeKey) {
    return {
      apiKey: dashscopeKey,
      baseUrl: normalizeBaseUrl(
        env['DASHSCOPE_PROXY_BASE_URL']?.trim() || DEFAULT_DASHSCOPE_BASE_URL,
      ),
    };
  }
  const openaiKey = env['OPENAI_API_KEY']?.trim();
  const openaiBaseUrl = env['OPENAI_BASE_URL']?.trim();
  if (openaiKey && openaiBaseUrl) {
    return { apiKey: openaiKey, baseUrl: normalizeBaseUrl(openaiBaseUrl) };
  }
  return undefined;
}

export async function resolveDesktopVoiceConfig(
  deps: ResolveDesktopVoiceConfigDeps = {},
): Promise<VoiceConfig> {
  const resolvedDeps = {
    readQwenJson: deps.readQwenJson ?? readQwenJsonFromDisk,
    env: deps.env ?? process.env,
    now: deps.now ?? Date.now,
  };
  const creds =
    (await fromOAuth(resolvedDeps)) ??
    (await fromQwenSettings(resolvedDeps)) ??
    fromEnv(resolvedDeps.env);
  if (!creds) {
    throw new Error(NO_CREDENTIALS_ERROR);
  }
  // Voice audio must not travel in cleartext.
  const parsed = new URL(creds.baseUrl);
  if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
    throw new Error('Voice endpoint must use an https baseUrl.');
  }
  return {
    model: deps.getVoiceModel ? deps.getVoiceModel() : await getStoredVoiceModel(),
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
  };
}
