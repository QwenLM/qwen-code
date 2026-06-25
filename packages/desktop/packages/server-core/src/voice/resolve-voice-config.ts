/**
 * Resolve the ASR endpoint + credentials for desktop voice dictation.
 *
 * The desktop drives Qwen over ACP and stores no DashScope baseUrl/apiKey of its
 * own — the real credentials live in the qwen CLI's config (`~/.qwen`). We resolve
 * them from, in order:
 *   1. OAuth login        — `~/.qwen/oauth_creds.json` (access_token + resource_url)
 *   2. API-key login      — `~/.qwen/settings.json` (a DashScope compatible-mode
 *                           modelProvider, with its key from settings `env`)
 *   3. Environment        — DASHSCOPE_API_KEY / OPENAI_API_KEY (+ OPENAI_BASE_URL)
 *
 * The voice model is the user-selected one persisted in desktop settings
 * (defaults to qwen3-asr-flash); its transport (batch vs realtime) is derived
 * downstream from the model id.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { getVoiceModel } from '@craft-agent/shared/config';
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
  return withProto.endsWith('/v1') ? withProto : `${withProto}/v1`;
}

async function readQwenJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(
      await readFile(join(homedir(), '.qwen', file), 'utf-8'),
    ) as T;
  } catch {
    return undefined;
  }
}

/** 1) Qwen OAuth device-flow credentials. */
async function fromOAuth(): Promise<ResolvedCredentials | undefined> {
  const creds = await readQwenJson<{
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
    creds.expiry_date <= Date.now() + 30_000
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
async function fromQwenSettings(): Promise<ResolvedCredentials | undefined> {
  const settings = await readQwenJson<QwenSettings>('settings.json');
  if (!settings) return undefined;
  const env = settings.env ?? {};
  const keyFor = (p: QwenProvider): string | undefined => {
    if (!p.envKey) return undefined;
    return process.env[p.envKey]?.trim() || env[p.envKey]?.trim() || undefined;
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
function fromEnv(): ResolvedCredentials | undefined {
  const apiKey =
    process.env['DASHSCOPE_API_KEY']?.trim() ||
    process.env['OPENAI_API_KEY']?.trim();
  if (!apiKey) return undefined;
  return {
    apiKey,
    baseUrl: normalizeBaseUrl(
      process.env['OPENAI_BASE_URL']?.trim() || DEFAULT_DASHSCOPE_BASE_URL,
    ),
  };
}

export async function resolveDesktopVoiceConfig(): Promise<VoiceConfig> {
  const creds = (await fromOAuth()) ?? (await fromQwenSettings()) ?? fromEnv();
  if (!creds) {
    throw new Error(NO_CREDENTIALS_ERROR);
  }
  // Voice audio must not travel in cleartext.
  const parsed = new URL(creds.baseUrl);
  if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
    throw new Error('Voice endpoint must use an https baseUrl.');
  }
  return { model: getVoiceModel(), baseUrl: creds.baseUrl, apiKey: creds.apiKey };
}
