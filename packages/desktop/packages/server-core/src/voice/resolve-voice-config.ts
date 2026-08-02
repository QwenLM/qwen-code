/**
 * Resolve the ASR endpoint + credentials for desktop voice dictation.
 *
 * The desktop drives Qwen over ACP and stores no voice baseUrl/apiKey of its
 * own — the real credentials live in Qwen's trusted configuration. We resolve
 * them from, in order:
 *   1. OAuth login        — `~/.qwen/oauth_creds.json` (access_token + resource_url)
 *   2. API-key login      — SystemDefaults → User → System settings (the selected
 *                           modelProvider, or the legacy shared DashScope provider)
 *   3. Environment        — DASHSCOPE_API_KEY, or OPENAI_API_KEY with OPENAI_BASE_URL
 *
 * The voice model is the user-selected one persisted in desktop settings
 * (defaults to qwen3-asr-flash); its transport (batch vs realtime) is derived
 * downstream from the model id.
 */

import { homedir, platform, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { readFile } from 'node:fs/promises';
import stripJsonComments from 'strip-json-comments';
import { CONSOLE_LOGGER, createScopedLogger } from '../runtime/platform';
import { isLoopbackHost } from './net-guard';
import type { VoiceConfig } from './transcribe';

const DEFAULT_DASHSCOPE_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';
const NO_CREDENTIALS_ERROR =
  'Voice dictation needs Qwen credentials. Sign in to Qwen Code (or set a DashScope API key), then try again.';
const voiceConfigLogger = createScopedLogger(CONSOLE_LOGGER, 'VOICE_CONFIG');

interface ResolvedCredentials {
  baseUrl: string;
  apiKey: string;
}

interface ResolveDesktopVoiceConfigDeps {
  readQwenJson?: <T>(file: string) => Promise<T | undefined>;
  readSystemJson?: <T>(file: string) => Promise<T | undefined>;
  systemSettingsPath?: string;
  systemDefaultsPath?: string;
  getVoiceModel?: () => string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  platform?: NodeJS.Platform;
}

/**
 * Normalize a base URL: prepend `https://` when no authority scheme is present,
 * preserve explicit schemes for protocol validation later, strip trailing
 * slashes, and ensure a `/v1` suffix. Throws on embedded credentials
 * (`user:pass@host`), which a legitimate endpoint never carries. Exported for tests.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : 'https://' + trimmed;
  let url: URL;
  try {
    url = new URL(withProto);
  } catch {
    return withProto.includes('/v1') ? withProto : `${withProto}/v1`;
  }
  // Reject embedded credentials rather than stripping them: for
  // `https://real-host@evil.com/...` the parser has already resolved `evil.com`
  // as the host, so clearing userinfo afterward would silently proceed with the
  // attacker-controlled host. A legitimate voice base URL never carries creds.
  if (url.username || url.password) {
    throw new Error('Voice base URL must not contain embedded credentials.');
  }
  if (!url.pathname.split('/').includes('v1')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/v1`;
  }
  return url.toString().replace(/\/$/, '');
}

/**
 * Resolve the global qwen config dir, mirroring core's
 * `Storage.getGlobalQwenDir()` so desktop voice reads the SAME `~/.qwen`
 * credentials the qwen CLI writes. QWEN_HOME is normalized exactly as core does:
 * a leading `~`/`~/` expands to homedir() and a relative value resolves to an
 * absolute path; an unset/empty value falls back to `~/.qwen`. Reading the raw
 * env value would point voice at a different dir than the rest of Qwen.
 * Exported for tests.
 */
export function getQwenConfigDir(): string {
  const envDir = process.env.QWEN_HOME;
  if (envDir) {
    let resolved = envDir;
    if (
      resolved === '~' ||
      resolved.startsWith('~/') ||
      resolved.startsWith('~\\')
    ) {
      const segments =
        resolved === '~'
          ? []
          : resolved.slice(2).split(/[/\\]+/).filter(Boolean);
      resolved = join(homedir(), ...segments);
    }
    return isAbsolute(resolved) ? resolved : resolve(resolved);
  }
  const home = homedir();
  return home ? join(home, '.qwen') : join(tmpdir(), '.qwen');
}

async function readQwenJsonFromDisk<T>(file: string): Promise<T | undefined> {
  return readJsonFileFromDisk(join(getQwenConfigDir(), file));
}

async function readJsonFileFromDisk<T>(file: string): Promise<T | undefined> {
  try {
    const content = await readFile(file, 'utf-8');
    return JSON.parse(stripJsonComments(content)) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      voiceConfigLogger.warn(
        `[voice] Failed to parse trusted settings file ${file}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    return undefined;
  }
}

async function readNoJson<T>(): Promise<T | undefined> {
  return undefined;
}

function getSystemSettingsPath(
  env: NodeJS.ProcessEnv,
  currentPlatform: NodeJS.Platform,
): string {
  const override = env['QWEN_CODE_SYSTEM_SETTINGS_PATH'];
  if (override) return override;
  if (currentPlatform === 'darwin') {
    return '/Library/Application Support/QwenCode/settings.json';
  }
  if (currentPlatform === 'win32') {
    return 'C:\\ProgramData\\qwen-code\\settings.json';
  }
  return '/etc/qwen-code/settings.json';
}

function getSystemDefaultsPath(
  env: NodeJS.ProcessEnv,
  systemSettingsPath: string,
  currentPlatform: NodeJS.Platform,
): string {
  const override = env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'];
  if (override) return override;
  return currentPlatform === 'win32'
    ? win32.join(win32.dirname(systemSettingsPath), 'system-defaults.json')
    : join(dirname(systemSettingsPath), 'system-defaults.json');
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

// Provider shape in trusted Qwen settings: the key is referenced by `envKey`
// (the env-var name), never stored inline.
interface QwenProvider {
  id?: string;
  baseUrl?: string;
  envKey?: string;
}

interface QwenSettings {
  env?: Record<string, string>;
  modelProviders?: Record<string, QwenProvider[]>;
  security?: {
    allowedInsecureVoiceBaseUrls?: string[];
  };
}

function resolveSettingsEnvVars<T>(value: T, env: NodeJS.ProcessEnv): T {
  const resolveValue = (input: unknown): unknown => {
    if (typeof input === 'string') {
      return input.replace(
        /\$(?:(\w+)|{([^}]+)})/g,
        (placeholder, plainName: string | undefined, bracedName: string | undefined) => {
          const name = plainName ?? bracedName;
          return name && typeof env[name] === 'string'
            ? env[name]
            : placeholder;
        },
      );
    }
    if (Array.isArray(input)) {
      return input.map(resolveValue);
    }
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input).map(([key, nested]) => [key, resolveValue(nested)]),
      );
    }
    return input;
  };

  return resolveValue(value) as T;
}

function mergeTrustedQwenSettings(
  systemDefaults: QwenSettings | undefined,
  user: QwenSettings | undefined,
  system: QwenSettings | undefined,
): QwenSettings {
  const scopes = [systemDefaults, user, system];
  const hasModelProviders = scopes.some(
    (scope) =>
      scope &&
      Object.prototype.hasOwnProperty.call(scope, 'modelProviders'),
  );
  const modelProviders = {
    ...(systemDefaults?.modelProviders ?? {}),
    ...(user?.modelProviders ?? {}),
    ...(system?.modelProviders ?? {}),
  };

  return {
    env: {
      ...(systemDefaults?.env ?? {}),
      ...(user?.env ?? {}),
      ...(system?.env ?? {}),
    },
    ...(hasModelProviders ? { modelProviders } : {}),
    security: {
      ...(systemDefaults?.security ?? {}),
      ...(user?.security ?? {}),
      ...(system?.security ?? {}),
    },
  };
}

function normalizeAllowedVoiceBaseUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    if (url.username || url.password) {
      return undefined;
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function isInsecureVoiceBaseUrlAllowed(
  settings: QwenSettings | undefined,
  normalizedBaseUrl: string,
): boolean {
  const allowed = settings?.security?.allowedInsecureVoiceBaseUrls;
  return (
    Array.isArray(allowed) &&
    allowed.some(
      (candidate) =>
        typeof candidate === 'string' &&
        normalizeAllowedVoiceBaseUrl(candidate) === normalizedBaseUrl,
    )
  );
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
function fromQwenSettings(
  settings: QwenSettings | undefined,
  envSource: NodeJS.ProcessEnv,
  voiceModel: string,
): ResolvedCredentials | undefined {
  if (!settings) return undefined;
  const settingsEnv = settings.env ?? {};
  const keyFor = (p: QwenProvider): string | undefined => {
    const envKey = p.envKey?.trim();
    if (!envKey) return undefined;
    return (
      envSource[envKey]?.trim() ||
      settingsEnv[envKey]?.trim() ||
      undefined
    );
  };
  const providers = Object.values(settings.modelProviders ?? {}).flat();
  const matches = providers.filter((provider) => provider.id === voiceModel);
  if (matches.length > 1) {
    throw new Error(`Voice model '${voiceModel}' is ambiguous.`);
  }
  const provider = matches[0];
  if (provider) {
    if (!provider.baseUrl?.trim()) {
      throw new Error(
        `Voice model '${voiceModel}' does not define a baseUrl.`,
      );
    }
    const normalizedBaseUrl = normalizeAllowedVoiceBaseUrl(provider.baseUrl);
    if (!normalizedBaseUrl) {
      throw new Error(`Voice model '${voiceModel}' has an invalid baseUrl.`);
    }
    // Preserve the legacy /v1 inference only for the official DashScope
    // compatible-mode endpoint. Custom and regional gateway paths remain
    // authoritative and are never rewritten.
    const baseUrl = isDashscopeCompatible(normalizedBaseUrl)
      ? normalizeBaseUrl(normalizedBaseUrl)
      : normalizedBaseUrl;
    const envKey = provider.envKey?.trim();
    if (!envKey) {
      throw new Error(`Voice model '${voiceModel}' does not define an envKey.`);
    }
    const apiKey = keyFor(provider);
    if (!apiKey) {
      throw new Error(`Voice model '${voiceModel}' requires ${envKey}.`);
    }
    return { baseUrl, apiKey };
  }

  // Preserve the pre-existing API-key flow for settings that provide a shared
  // DashScope endpoint rather than a model-specific voice entry. Custom
  // endpoints never use this fallback because selecting one for an unrelated
  // model could cross a region or trust boundary.
  for (const fallback of providers) {
    if (fallback.baseUrl && isDashscopeCompatible(fallback.baseUrl)) {
      const apiKey = keyFor(fallback);
      if (apiKey) {
        return { baseUrl: normalizeBaseUrl(fallback.baseUrl), apiKey };
      }
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
  // An OPENAI_API_KEY alone is never sent to DashScope; tell the user the
  // base URL is required rather than failing with a generic credentials error.
  if (openaiKey) {
    throw new Error(
      'Set OPENAI_BASE_URL alongside OPENAI_API_KEY to use it for voice dictation.',
    );
  }
  return undefined;
}

export async function resolveDesktopVoiceConfig(
  deps: ResolveDesktopVoiceConfigDeps = {},
): Promise<VoiceConfig> {
  const resolvedDeps = {
    readQwenJson: deps.readQwenJson ?? readQwenJsonFromDisk,
    // Supplying a user-settings reader is test dependency injection; do not
    // unexpectedly fall through to the host machine's real system settings.
    readSystemJson:
      deps.readSystemJson ??
      (deps.readQwenJson ? readNoJson : readJsonFileFromDisk),
    env: deps.env ?? process.env,
    now: deps.now ?? Date.now,
    platform: deps.platform ?? platform(),
  };
  const voiceModel = deps.getVoiceModel
    ? deps.getVoiceModel()
    : await getStoredVoiceModel();
  const systemSettingsPath =
    deps.systemSettingsPath ??
    getSystemSettingsPath(resolvedDeps.env, resolvedDeps.platform);
  const systemDefaultsPath =
    deps.systemDefaultsPath ??
    getSystemDefaultsPath(
      resolvedDeps.env,
      systemSettingsPath,
      resolvedDeps.platform,
    );
  const [rawSystemDefaults, rawUserSettings, rawSystemSettings] =
    await Promise.all([
    resolvedDeps.readSystemJson<QwenSettings>(systemDefaultsPath),
    resolvedDeps.readQwenJson<QwenSettings>('settings.json'),
    resolvedDeps.readSystemJson<QwenSettings>(systemSettingsPath),
    ]);
  const systemDefaults = resolveSettingsEnvVars(
    rawSystemDefaults,
    resolvedDeps.env,
  );
  const userSettings = resolveSettingsEnvVars(
    rawUserSettings,
    resolvedDeps.env,
  );
  const systemSettings = resolveSettingsEnvVars(
    rawSystemSettings,
    resolvedDeps.env,
  );
  const qwenSettings = mergeTrustedQwenSettings(
    systemDefaults,
    userSettings,
    systemSettings,
  );
  const creds =
    (await fromOAuth(resolvedDeps)) ??
    fromQwenSettings(qwenSettings, resolvedDeps.env, voiceModel) ??
    fromEnv(resolvedDeps.env);
  if (!creds) {
    throw new Error(NO_CREDENTIALS_ERROR);
  }
  const allowInsecureBaseUrl = isInsecureVoiceBaseUrlAllowed(
    qwenSettings,
    creds.baseUrl,
  );
  const parsed = new URL(creds.baseUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Voice endpoint must use an http or https baseUrl.');
  }
  if (
    parsed.protocol === 'http:' &&
    !isLoopbackHost(parsed.hostname) &&
    !allowInsecureBaseUrl
  ) {
    throw new Error(
      `Voice endpoint must use an https baseUrl, or its exact complete normalized URL (${creds.baseUrl}) must be listed in security.allowedInsecureVoiceBaseUrls.`,
    );
  }
  return {
    model: voiceModel,
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    ...(allowInsecureBaseUrl ? { allowInsecureBaseUrl: true } : {}),
  };
}
