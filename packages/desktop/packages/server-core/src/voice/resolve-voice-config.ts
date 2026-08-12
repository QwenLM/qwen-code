/**
 * Resolve the ASR endpoint + credentials for desktop voice dictation.
 *
 * The desktop drives Qwen over ACP and stores no voice baseUrl/apiKey of its
 * own — the real credentials live in Qwen's trusted configuration. We resolve
 * them from, in order:
 *   1. Exact model provider — the trusted-settings provider whose `id` matches
 *                           the selected voice model; authoritative (resolved
 *                           before OAuth, failing closed when incomplete) only
 *                           when its baseUrl needs a network-policy decision —
 *                           allowlisted, cleartext, private-network, or
 *                           loopback. Public HTTPS entries fall through to keep
 *                           the legacy credential precedence.
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
import {
  isAlwaysBlockedVoiceAddress,
  isLoopbackHost,
  isLoopbackVoiceAddress,
  isPrivateNetworkIp,
} from './net-guard';
import type { VoiceConfig } from './transcribe';

const DEFAULT_DASHSCOPE_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';
const NO_CREDENTIALS_ERROR =
  'Voice dictation needs Qwen credentials. Sign in to Qwen Code (or set a DashScope API key), then try again.';
const LOOPBACK_SPELLINGS = 'http://localhost, http://127.0.0.1, or http://[::1]';
const voiceConfigLogger = createScopedLogger(CONSOLE_LOGGER, 'VOICE_CONFIG');

interface ResolvedCredentials {
  baseUrl: string;
  apiKey?: string;
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

// dotenv@17's LINE grammar, copied verbatim: the CLI parses the same
// ~/.qwen/.env with dotenv.parse (loadEnvironment / getHomeEnvFallbackVars),
// so one file must yield identical values on both surfaces. Keep in sync.
const DOTENV_LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

/** Parse home .env content exactly like dotenv@17. Exported for tests. */
export function parseEnvFileContent(content: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  const lines = content.replace(/\r\n?/g, '\n');
  // Fresh instance per call: the grammar regex carries shared lastIndex state.
  const linePattern = new RegExp(DOTENV_LINE.source, DOTENV_LINE.flags);
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(lines)) !== null) {
    let value = match[2] ?? '';
    value = value.trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, '$2');
    if (quote === '"') {
      value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    }
    result[match[1]!] = value;
  }
  return result;
}

// Home-.env fallback shared by credential lookup and settings interpolation:
// <qwen dir>/.env first, ~/.env only when QWEN_HOME is unset, the first
// definition of a key wins, and the process env wins over file values —
// except an empty-string env var, which the CLI treats as "effectively unset"
// and fills from .env. This adopts the CLI's narrower getHomeEnvFallbackVars
// candidate set on purpose, not loadEnvironment's broader fill (which also
// reads ~/.env under a redirected QWEN_HOME, the legacy ~/.qwen/.env, and
// workspace .env files): a user who redirects QWEN_HOME isolates their Qwen
// configuration, desktop has no workspace context to mirror loadEnvironment
// fully, and credential lookup fails closed rather than pulling from a shared
// home .env.
async function getHomeEnvFallback(
  env: NodeJS.ProcessEnv,
  readHomeEnvFile: (file: string) => Promise<string | undefined>,
): Promise<Record<string, string>> {
  const qwenDir = getQwenConfigDir();
  const candidates = [join(qwenDir, '.env')];
  if (!env.QWEN_HOME) {
    candidates.push(join(dirname(qwenDir), '.env'));
  }
  const result: Record<string, string> = Object.create(null);
  for (const candidate of candidates) {
    const content = await readHomeEnvFile(candidate);
    if (content === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(parseEnvFileContent(content))) {
      if (!Object.hasOwn(env, key) || env[key] === '') {
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
    baseUrl: normalizeBaseUrl(
      creds?.resource_url?.trim() || DEFAULT_DASHSCOPE_BASE_URL,
    ),
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

// Mirrors the CLI's resolveEnvVarsInObject ladder (settings interpolation via
// getHomeEnvFallbackVars): the process env wins even when its value is an
// empty string, the home .env fallback only fills keys the env does not
// define at all, and anything else keeps its placeholder.
function resolveSettingsEnvVars<T>(
  value: T,
  env: NodeJS.ProcessEnv,
  homeEnvFallback: Record<string, string>,
): T {
  const resolveValue = (input: unknown): unknown => {
    if (typeof input === 'string') {
      return input.replace(
        /\$(?:(\w+)|{([^}]+)})/g,
        (
          placeholder: string,
          plainName: string | undefined,
          bracedName: string | undefined,
        ) => {
          const name = plainName ?? bracedName;
          if (!name) return placeholder;
          const envValue = env[name];
          if (typeof envValue === 'string') return envValue;
          const fallbackValue = homeEnvFallback[name];
          if (typeof fallbackValue === 'string') return fallbackValue;
          return placeholder;
        },
      );
    }
    if (Array.isArray(input)) {
      return input.map(resolveValue);
    }
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input).map(([key, nested]) => [
          key,
          resolveValue(nested),
        ]),
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

// The CLI's customDeepMerge skips these keys at every merge level; object
// spread would keep them as own properties (JSON.parse defines them as own),
// so drop them to keep one settings file resolving identically on both
// surfaces.
const UNSAFE_SETTINGS_KEYS = ['__proto__', 'constructor', 'prototype'];

function omitUnsafeKeys<V>(
  source: Record<string, V> | undefined,
): Record<string, V> | undefined {
  if (!source) {
    return source;
  }
  if (!UNSAFE_SETTINGS_KEYS.some((key) => Object.hasOwn(source, key))) {
    return source;
  }
  const filtered: Record<string, V> = {};
  for (const key of Object.keys(source)) {
    if (!UNSAFE_SETTINGS_KEYS.includes(key)) {
      filtered[key] = source[key]!;
    }
  }
  return filtered;
}

// The CLI's customDeepMerge has no REPLACE branch — two plain objects always
// recurse — so the CLI deep-merges modelProviders per provider-group key: the
// same key takes the highest scope's array, and disjoint keys all survive.
// Mirror that so a managed System scope overrides user entries per key instead
// of discarding the user's whole provider set. settingsSchema declares
// mergeStrategy REPLACE for modelProviders; if customDeepMerge ever implements
// it, this mirror must change in lockstep.
function mergeModelProviders(
  ...scopes: Array<Record<string, QwenProvider[]> | undefined>
): Record<string, QwenProvider[]> | undefined {
  let merged: Record<string, QwenProvider[]> | undefined;
  for (const scope of scopes) {
    const unwrapped = unwrapWrappedProviderConfigs(omitUnsafeKeys(scope));
    if (!unwrapped) continue;
    merged = { ...(merged ?? {}), ...unwrapped };
  }
  return merged;
}

function mergeTrustedQwenSettings(
  systemDefaults: QwenSettings | undefined,
  user: QwenSettings | undefined,
  system: QwenSettings | undefined,
): QwenSettings {
  return {
    env: {
      ...(omitUnsafeKeys(systemDefaults?.env) ?? {}),
      ...(omitUnsafeKeys(user?.env) ?? {}),
      ...(omitUnsafeKeys(system?.env) ?? {}),
    },
    modelProviders: mergeModelProviders(
      systemDefaults?.modelProviders,
      user?.modelProviders,
      system?.modelProviders,
    ),
    security: {
      ...(omitUnsafeKeys(systemDefaults?.security) ?? {}),
      ...(omitUnsafeKeys(user?.security) ?? {}),
      ...(omitUnsafeKeys(system?.security) ?? {}),
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
  if (typeof provider.envKey !== 'string') return undefined;
  const envKey = provider.envKey.trim();
  if (!envKey) return undefined;
  const settingsEnvValue = settings?.env?.[envKey];
  // Object.hasOwn keeps an envKey naming an inherited Object.prototype member
  // (e.g. "constructor") from reaching .trim() as a function.
  const envValue = Object.hasOwn(envSource, envKey)
    ? envSource[envKey]
    : undefined;
  return (
    envValue?.trim() ||
    (typeof settingsEnvValue === 'string'
      ? settingsEnvValue.trim()
      : undefined) ||
    undefined
  );
}

const PROVIDER_ENTRY_REMEDY =
  'Remove or complete this provider entry to fall back to your Qwen sign-in.';

interface ClassifiedVoiceProviderEntry {
  provider: QwenProvider;
  parsedBaseUrl: URL;
  baseUrl: string;
  allowInsecureBaseUrl: boolean;
  isLoopback: boolean;
  isPublicHttps: boolean;
}

/**
 * Validate and classify one id-matching provider entry. Malformed entries
 * (non-string baseUrl, embedded credentials) throw and fail closed no matter
 * what other entries exist; entries too incomplete to classify (missing or
 * unparseable baseUrl) are ignored with a warning and keep the legacy
 * fall-through.
 */
function classifyVoiceProviderEntry(
  provider: QwenProvider,
  settings: QwenSettings,
  voiceModel: string,
): ClassifiedVoiceProviderEntry | undefined {
  if (provider.baseUrl != null && typeof provider.baseUrl !== 'string') {
    throw new Error(
      `Voice model '${voiceModel}' baseUrl must be a string. ${PROVIDER_ENTRY_REMEDY}`,
    );
  }
  const rawBaseUrl = provider.baseUrl?.trim();
  if (!rawBaseUrl) {
    // Too incomplete to classify; keep the legacy fall-through.
    return undefined;
  }
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(rawBaseUrl);
  } catch {
    // Never fall through silently: shipping audio to a different endpoint
    // than configured is exactly what the operator must be able to see.
    voiceConfigLogger.warn(
      `[voice] Provider baseUrl for voice model '${voiceModel}' is not a valid URL (${rawBaseUrl}); ignoring the entry and falling back to the next credential source.`,
    );
    return undefined;
  }
  if (parsedBaseUrl.username || parsedBaseUrl.password) {
    throw new Error(
      `Voice model '${voiceModel}' baseUrl must not contain embedded credentials. ${PROVIDER_ENTRY_REMEDY}`,
    );
  }
  const normalizedBaseUrl = parsedBaseUrl.toString().replace(/\/+$/, '');
  // Preserve the legacy /v1 inference only for the official DashScope
  // compatible-mode endpoint. Custom and regional gateway paths remain
  // authoritative and are never rewritten. Compute the final URL before any
  // policy check so the allowlist is matched against the same string here
  // and in the top-level recheck of resolveDesktopVoiceConfig.
  const baseUrl = isDashscopeCompatible(normalizedBaseUrl)
    ? normalizeBaseUrl(normalizedBaseUrl)
    : normalizedBaseUrl;
  const allowInsecureBaseUrl = isInsecureVoiceBaseUrlAllowed(settings, baseUrl);
  const isLoopback = isLoopbackHost(parsedBaseUrl.hostname);
  const isPublicHttps =
    parsedBaseUrl.protocol === 'https:' &&
    !isLoopback &&
    !isAlwaysBlockedVoiceAddress(parsedBaseUrl.hostname) &&
    !isPrivateNetworkIp(parsedBaseUrl.hostname);
  return {
    provider,
    parsedBaseUrl,
    baseUrl,
    allowInsecureBaseUrl,
    isLoopback,
    isPublicHttps,
  };
}

// A public HTTPS entry needs no policy decision; leave it to the legacy
// chain unless the operator explicitly allowlisted its exact URL.
function needsVoicePolicyDecision(
  entry: ClassifiedVoiceProviderEntry,
): boolean {
  return !(entry.isPublicHttps && !entry.allowInsecureBaseUrl);
}

/**
 * 1) The provider whose `id` matches the selected voice model.
 *
 * Authoritative only when the entry needs a network-policy decision — an
 * allowlisted, cleartext, private-network, or loopback baseUrl. Those resolve
 * before OAuth so a managed gateway wins for OAuth-signed-in users, and fail
 * closed when incomplete or unlisted instead of silently falling back to a
 * different endpoint or region. Public HTTPS entries keep the legacy
 * fall-through (OAuth → DashScope provider → environment), preserving the
 * pre-allowlist credential precedence for existing installs — including
 * duplicates: a set of same-ID matches is ambiguous only when at least one
 * entry needs a policy decision, so duplicate public HTTPS entries fall
 * through exactly like a single one.
 */
function fromExactModelProvider(
  settings: QwenSettings | undefined,
  envSource: NodeJS.ProcessEnv,
  voiceModel: string,
): ResolvedCredentials | undefined {
  if (!settings) return undefined;
  const providers = Object.values(settings.modelProviders ?? {}).flat();
  // Trusted settings are hand-editable JSON; ignore elements that are not
  // provider objects instead of crashing on their missing shape.
  const matches = providers.filter(
    (provider): provider is QwenProvider =>
      provider !== null &&
      typeof provider === 'object' &&
      provider.id === voiceModel,
  );
  // The CLI registry keys models by (id, baseUrl) and keeps the first
  // registration of a duplicate — even when envKey differs, matching the
  // registry's warn-and-skip (envKey is not part of the composite key); only
  // differing baseUrls conflict. (An empty baseUrl folds into the bare-id
  // key, as in modelRegistryKey.)
  const distinct: QwenProvider[] = [];
  for (const match of matches) {
    const matchKey = match.baseUrl || '';
    if (!distinct.some((kept) => (kept.baseUrl || '') === matchKey)) {
      distinct.push(match);
    }
  }
  const classified = distinct
    .map((provider) =>
      classifyVoiceProviderEntry(provider, settings, voiceModel),
    )
    .filter(
      (entry): entry is ClassifiedVoiceProviderEntry => entry !== undefined,
    );
  if (classified.length === 0) return undefined;
  // Classify before deciding: duplicates that all keep the legacy
  // fall-through need no policy decision and must not break configs that
  // resolved through the legacy chain before the allowlist existed.
  if (classified.length > 1 && classified.some(needsVoicePolicyDecision)) {
    throw new Error(
      `Voice model '${voiceModel}' is ambiguous. ${PROVIDER_ENTRY_REMEDY}`,
    );
  }
  const entry = classified[0]!;
  if (!needsVoicePolicyDecision(entry)) {
    return undefined;
  }
  const { provider, parsedBaseUrl, baseUrl, allowInsecureBaseUrl, isLoopback } =
    entry;
  if (
    parsedBaseUrl.protocol !== 'http:' &&
    parsedBaseUrl.protocol !== 'https:'
  ) {
    throw new Error(
      `Voice model '${voiceModel}' must use an http or https baseUrl. ${PROVIDER_ENTRY_REMEDY}`,
    );
  }
  if (!isLoopback && isAlwaysBlockedVoiceAddress(parsedBaseUrl.hostname)) {
    throw new Error(
      isLoopbackVoiceAddress(parsedBaseUrl.hostname)
        ? `Voice model '${voiceModel}' uses a loopback address outside the accepted spellings. To use a local ASR endpoint, set the baseUrl to ${LOOPBACK_SPELLINGS}. ${PROVIDER_ENTRY_REMEDY}`
        : `Voice model '${voiceModel}' must not use a private-network baseUrl. ${PROVIDER_ENTRY_REMEDY}`,
    );
  }
  if (
    parsedBaseUrl.protocol === 'http:' &&
    !isLoopback &&
    !allowInsecureBaseUrl
  ) {
    throw new Error(
      `Voice model '${voiceModel}' must use an https baseUrl. Voice audio must not be transmitted in cleartext. To trust this managed endpoint, add its exact complete normalized URL (${baseUrl}) to security.allowedInsecureVoiceBaseUrls. ${PROVIDER_ENTRY_REMEDY}`,
    );
  }
  if (
    !isLoopback &&
    !allowInsecureBaseUrl &&
    isPrivateNetworkIp(parsedBaseUrl.hostname)
  ) {
    throw new Error(
      `Voice model '${voiceModel}' must not use a private-network baseUrl. To trust this managed endpoint, add its exact complete normalized URL (${baseUrl}) to security.allowedInsecureVoiceBaseUrls. ${PROVIDER_ENTRY_REMEDY}`,
    );
  }
  if (provider.envKey != null && typeof provider.envKey !== 'string') {
    throw new Error(
      `Voice model '${voiceModel}' envKey must be a string. ${PROVIDER_ENTRY_REMEDY}`,
    );
  }
  const envKey = provider.envKey?.trim();
  if (!envKey) {
    // CLI parity: an entry without envKey resolves keyless (for example a
    // local gateway that injects its own credentials) instead of failing.
    return { baseUrl };
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
    if (
      fallback !== null &&
      typeof fallback === 'object' &&
      // A non-string baseUrl (hand-edited settings) must fall through like a
      // missing one instead of crashing normalizeBaseUrl on raw.trim().
      typeof fallback.baseUrl === 'string' &&
      isDashscopeCompatible(fallback.baseUrl)
    ) {
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
  // Credential lookup mirrors the CLI's loadEnvironment: the process env wins,
  // except an empty-string env var is "effectively unset" and filled from the
  // home .env fallback. (Settings interpolation above applies the stricter
  // getHomeEnvFallbackVars precedence, where an empty env value wins.)
  const lookupEnv: NodeJS.ProcessEnv = { ...homeEnvFallback };
  for (const [key, value] of Object.entries(resolvedDeps.env)) {
    if (value !== '' || !Object.hasOwn(homeEnvFallback, key)) {
      lookupEnv[key] = value;
    }
  }
  const systemDefaults = resolveSettingsEnvVars(
    rawSystemDefaults,
    resolvedDeps.env,
    homeEnvFallback,
  );
  const userSettings = resolveSettingsEnvVars(
    rawUserSettings,
    resolvedDeps.env,
    homeEnvFallback,
  );
  const systemSettings = resolveSettingsEnvVars(
    rawSystemSettings,
    resolvedDeps.env,
    homeEnvFallback,
  );
  const qwenSettings = mergeTrustedQwenSettings(
    systemDefaults,
    userSettings,
    systemSettings,
  );
  const creds =
    fromExactModelProvider(qwenSettings, lookupEnv, voiceModel) ??
    (await fromOAuth(resolvedDeps)) ??
    fromLegacyDashscopeProvider(qwenSettings, lookupEnv) ??
    fromEnv(lookupEnv);
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
    throw new Error(
      isLoopbackVoiceAddress(parsed.hostname)
        ? `Voice endpoint uses a loopback address outside the accepted spellings. To use a local ASR endpoint, set the baseUrl to ${LOOPBACK_SPELLINGS}.`
        : 'Voice endpoint must not use a private-network baseUrl.',
    );
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
  if (
    !isLoopbackHost(parsed.hostname) &&
    !allowInsecureBaseUrl &&
    isPrivateNetworkIp(parsed.hostname)
  ) {
    throw new Error(
      `Voice endpoint must not use a private-network baseUrl. To trust this managed endpoint, add its exact complete normalized URL (${creds.baseUrl}) to security.allowedInsecureVoiceBaseUrls.`,
    );
  }
  return {
    model: voiceModel,
    baseUrl: creds.baseUrl,
    ...(creds.apiKey ? { apiKey: creds.apiKey } : {}),
    ...(allowInsecureBaseUrl ? { allowInsecureBaseUrl: true } : {}),
  };
}
