/**
 * Resolve the ASR endpoint + credentials for desktop voice dictation.
 *
 * The desktop drives Qwen over ACP and stores no voice baseUrl/apiKey of its
 * own — the real credentials live in Qwen's trusted configuration. We resolve
 * them from, in order:
 *   1. Exact model provider — the trusted-settings provider whose `id` matches
 *                           the selected voice model (authoritative; an
 *                           incomplete entry fails instead of falling through)
 *   2. OAuth login        — `~/.qwen/oauth_creds.json` (access_token + resource_url)
 *   3. Legacy DashScope provider — a shared DashScope compatible-mode provider
 *                           in trusted settings
 *   4. Environment        — DASHSCOPE_API_KEY, or OPENAI_API_KEY with OPENAI_BASE_URL
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
import { isAlwaysBlockedVoiceAddress, isLoopbackHost } from './net-guard';
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
  readHomeEnvFile?: (file: string) => Promise<string | undefined>;
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
    : `https://${trimmed}`;
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

async function readEnvFileFromDisk(
  file: string,
): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      voiceConfigLogger.warn(
        `[voice] Failed to read home .env file ${file}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    return undefined;
  }
}

// Minimal dotenv-compatible parser for the home .env fallback: KEY=VALUE lines
// with an optional `export` prefix, quoted values, and inline comments.
function parseEnvFileContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match) {
      continue;
    }
    let value = match[2] ?? '';
    const quote = value[0];
    if (
      value.length >= 2 &&
      (quote === '"' || quote === "'") &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(
          /\\(n|r|t|\\)/g,
          (_all, escaped: string) =>
            escaped === 'n'
              ? '\n'
              : escaped === 'r'
                ? '\r'
                : escaped === 't'
                  ? '\t'
                  : '\\',
        );
      }
    } else {
      const commentStart = value.startsWith('#') ? 0 : value.search(/\s#/);
      if (commentStart !== -1) {
        value = value.slice(0, commentStart);
      }
      value = value.trim();
    }
    result[match[1]!] = value;
  }
  return result;
}

// Mirrors the CLI's getHomeEnvFallbackVars: <qwen dir>/.env first, ~/.env only
// when QWEN_HOME is unset, the first definition of a key wins, and the process
// env always takes precedence over file values.
async function getHomeEnvFallback(
  env: NodeJS.ProcessEnv,
  readHomeEnvFile: (file: string) => Promise<string | undefined>,
): Promise<Record<string, string>> {
  const qwenDir = getQwenConfigDir();
  const candidates = [join(qwenDir, '.env')];
  if (!process.env.QWEN_HOME) {
    candidates.push(join(dirname(qwenDir), '.env'));
  }
  const result: Record<string, string> = {};
  for (const candidate of candidates) {
    const content = await readHomeEnvFile(candidate);
    if (content === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(parseEnvFileContent(content))) {
      if (!Object.hasOwn(env, key)) {
        result[key] ??= value;
      }
    }
  }
  return result;
}

// Duplicates packages/cli/src/config/storage-paths-lite.ts; the bun workspace
// boundary prevents sharing, and env/platform are injectable here for tests.
// Keep the two implementations in sync.
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

/** 2) Qwen OAuth device-flow credentials. */
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

// Legacy v5 settings wrap each modelProviders entry as `{ protocol, models }`;
// the CLI migrates that shape back to plain arrays on load. Unwrap at read
// time so the same settings file resolves identically on both surfaces.
function unwrapWrappedProviderConfigs(
  modelProviders: Record<string, QwenProvider[]> | undefined,
): Record<string, QwenProvider[]> | undefined {
  if (!modelProviders) {
    return modelProviders;
  }
  let unwrapped: Record<string, QwenProvider[]> | undefined;
  for (const [key, value] of Object.entries(modelProviders)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue;
    }
    const models = (value as unknown as { models?: unknown }).models;
    unwrapped ??= { ...modelProviders };
    unwrapped[key] = Array.isArray(models) ? (models as QwenProvider[]) : [];
  }
  return unwrapped ?? modelProviders;
}

function mergeTrustedQwenSettings(
  systemDefaults: QwenSettings | undefined,
  user: QwenSettings | undefined,
  system: QwenSettings | undefined,
): QwenSettings {
  return {
    env: {
      ...(systemDefaults?.env ?? {}),
      ...(user?.env ?? {}),
      ...(system?.env ?? {}),
    },
    // The CLI declares modelProviders with MergeStrategy.REPLACE: the
    // highest-precedence scope that defines it supplies the whole object.
    // Mirror that so a managed System scope can fully override a user's
    // provider set instead of unioning with it.
    modelProviders: unwrapWrappedProviderConfigs(
      system?.modelProviders ??
        user?.modelProviders ??
        systemDefaults?.modelProviders,
    ),
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

function readProviderApiKey(
  provider: QwenProvider,
  settings: QwenSettings | undefined,
  envSource: NodeJS.ProcessEnv,
): string | undefined {
  const envKey = provider.envKey?.trim();
  if (!envKey) return undefined;
  return (
    envSource[envKey]?.trim() ||
    settings?.env?.[envKey]?.trim() ||
    undefined
  );
}

const PROVIDER_ENTRY_REMEDY =
  'Remove or complete this provider entry to fall back to your Qwen sign-in.';

/**
 * 1) The provider whose `id` matches the selected voice model. Authoritative:
 * resolves before OAuth so a managed gateway wins for OAuth-signed-in users,
 * and an incomplete entry fails instead of silently falling through.
 */
function fromExactModelProvider(
  settings: QwenSettings | undefined,
  envSource: NodeJS.ProcessEnv,
  voiceModel: string,
): ResolvedCredentials | undefined {
  if (!settings) return undefined;
  const providers = Object.values(settings.modelProviders ?? {}).flat();
  const matches = providers.filter((provider) => provider.id === voiceModel);
  if (matches.length > 1) {
    throw new Error(`Voice model '${voiceModel}' is ambiguous.`);
  }
  const provider = matches[0];
  if (!provider) return undefined;
  if (!provider.baseUrl?.trim()) {
    throw new Error(
      `Voice model '${voiceModel}' does not define a baseUrl. ${PROVIDER_ENTRY_REMEDY}`,
    );
  }
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(provider.baseUrl.trim());
  } catch {
    throw new Error(
      `Voice model '${voiceModel}' has an invalid baseUrl. ${PROVIDER_ENTRY_REMEDY}`,
    );
  }
  if (parsedBaseUrl.username || parsedBaseUrl.password) {
    throw new Error(
      `Voice model '${voiceModel}' baseUrl must not contain embedded credentials. ${PROVIDER_ENTRY_REMEDY}`,
    );
  }
  const normalizedBaseUrl = parsedBaseUrl.toString().replace(/\/+$/, '');
  // Preserve the legacy /v1 inference only for the official DashScope
  // compatible-mode endpoint. Custom and regional gateway paths remain
  // authoritative and are never rewritten.
  const baseUrl = isDashscopeCompatible(normalizedBaseUrl)
    ? normalizeBaseUrl(normalizedBaseUrl)
    : normalizedBaseUrl;
  const envKey = provider.envKey?.trim();
  if (!envKey) {
    throw new Error(
      `Voice model '${voiceModel}' does not define an envKey. ${PROVIDER_ENTRY_REMEDY}`,
    );
  }
  const apiKey = readProviderApiKey(provider, settings, envSource);
  if (!apiKey) {
    throw new Error(
      `Voice model '${voiceModel}' requires ${envKey}. ${PROVIDER_ENTRY_REMEDY}`,
    );
  }
  return { baseUrl, apiKey };
}

/**
 * 3) Legacy API-key flow for settings that provide a shared DashScope
 * endpoint rather than a model-specific voice entry. Custom endpoints never
 * use this fallback because selecting one for an unrelated model could cross
 * a region or trust boundary.
 */
function fromLegacyDashscopeProvider(
  settings: QwenSettings | undefined,
  envSource: NodeJS.ProcessEnv,
): ResolvedCredentials | undefined {
  if (!settings) return undefined;
  const providers = Object.values(settings.modelProviders ?? {}).flat();
  for (const fallback of providers) {
    if (fallback.baseUrl && isDashscopeCompatible(fallback.baseUrl)) {
      const apiKey = readProviderApiKey(fallback, settings, envSource);
      if (apiKey) {
        return { baseUrl: normalizeBaseUrl(fallback.baseUrl), apiKey };
      }
    }
  }
  return undefined;
}

/** 4) Explicit environment override. */
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
    readSystemJson: deps.readSystemJson ?? readJsonFileFromDisk,
    readHomeEnvFile: deps.readHomeEnvFile ?? readEnvFileFromDisk,
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
  const homeEnvFallback = await getHomeEnvFallback(
    resolvedDeps.env,
    resolvedDeps.readHomeEnvFile,
  );
  // Same precedence as the CLI: the process env wins; the home .env only fills
  // keys the process env does not define.
  const effectiveEnv: NodeJS.ProcessEnv = {
    ...homeEnvFallback,
    ...resolvedDeps.env,
  };
  const systemDefaults = resolveSettingsEnvVars(rawSystemDefaults, effectiveEnv);
  const userSettings = resolveSettingsEnvVars(rawUserSettings, effectiveEnv);
  const systemSettings = resolveSettingsEnvVars(rawSystemSettings, effectiveEnv);
  const qwenSettings = mergeTrustedQwenSettings(
    systemDefaults,
    userSettings,
    systemSettings,
  );
  const creds =
    fromExactModelProvider(qwenSettings, effectiveEnv, voiceModel) ??
    (await fromOAuth(resolvedDeps)) ??
    fromLegacyDashscopeProvider(qwenSettings, effectiveEnv) ??
    fromEnv(effectiveEnv);
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
    !isLoopbackHost(parsed.hostname) &&
    isAlwaysBlockedVoiceAddress(parsed.hostname)
  ) {
    throw new Error('Voice endpoint must not use a private-network baseUrl.');
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
