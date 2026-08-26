/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import {
  createDebugLogger,
  DEFAULT_MAX_AUDIO_BRIDGE_BYTES,
} from '@qwen-code/qwen-code-core';
import type { AvailableModel } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import { buildVoiceKeyterms } from './voice-keyterms.js';
import {
  formatUnsupportedVoiceModelMessage,
  isTranscribableVoiceModel,
  resolveVoiceTransport,
} from './voice-model.js';
import { readVoiceLanguage } from './voice-settings.js';

const DEFAULT_OPENAI_API_KEY = 'OPENAI_API_KEY';
const INFERENCE_TIMEOUT_MS = 60_000;
const MIN_KEYTERM_ECHO_TOKENS = 8;
const MIN_ABSOLUTE_KEYTERM_ECHO_TOKENS = 10;
const MIN_KEYTERM_SET_ECHO_RATIO = 0.3;
const debugLogger = createDebugLogger('VOICE_TRANSCRIBER');
const BLOCKED_TRANSITION_IPV6_ADDRESSES = new BlockList();
for (const [address, prefix] of [
  ['64:ff9b:1::', 48],
  ['2001::', 23],
  ['2002::', 16],
] as const) {
  BLOCKED_TRANSITION_IPV6_ADDRESSES.addSubnet(address, prefix, 'ipv6');
}

export { resolveVoiceTransport };
export type { VoiceTransport } from './voice-model.js';

export type VoiceStreamingTransport =
  | 'qwen-asr-realtime'
  | 'dashscope-task-realtime';

export interface RecordedVoiceAudio {
  data: Uint8Array;
  mimeType: string;
}

export interface VoiceTranscriptionConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
  allowInsecureBaseUrl?: boolean;
}

export interface VoiceStreamConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  language?: string;
  keytermsContext?: string;
  allowInsecureBaseUrl?: boolean;
}

export interface ResolvedVoiceStreamConfig extends VoiceStreamConfig {
  transport: VoiceStreamingTransport;
}

export interface VoiceModelSource {
  getAllConfiguredModels(): AvailableModel[];
}

export type VoiceModelLookup = VoiceModelSource;

interface ResolveVoiceTranscriptionConfigArgs {
  config: VoiceModelSource;
  settings: LoadedSettings;
  voiceModel: string;
  env?: Readonly<Record<string, string | undefined>>;
}

interface TranscribeVoiceAudioArgs extends ResolveVoiceTranscriptionConfigArgs {
  fetchFn?: typeof fetch;
  lookupHost?: VoiceHostLookup;
  abortSignal?: AbortSignal;
  onEgress?: () => void;
}

type VoiceHostLookup = (
  hostname: string,
) => Promise<{ address: string } | Array<{ address: string }>>;

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function readSettingsEnv(
  settings: LoadedSettings,
  envKey: string,
): string | undefined {
  const env = settings.merged.env as Record<string, unknown> | undefined;
  const value = env?.[envKey];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isQwenBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      hostname === 'dashscope.aliyuncs.com' ||
      hostname === 'dashscope-intl.aliyuncs.com' ||
      hostname === 'dashscope-us.aliyuncs.com' ||
      hostname.endsWith('.dashscope.aliyuncs.com') ||
      hostname.endsWith('.dashscope-intl.aliyuncs.com') ||
      hostname.endsWith('.dashscope-us.aliyuncs.com')
    );
  } catch {
    return false;
  }
}

function normalizeBaseUrl(baseUrl: string, modelName: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Voice model '${modelName}' has an invalid baseUrl.`);
  }
  if (url.username || url.password) {
    throw new Error(
      `Voice model '${modelName}' baseUrl must not contain embedded credentials.`,
    );
  }
  return trimTrailingSlashes(url.toString());
}

function normalizeAllowedVoiceBaseUrl(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl.trim());
    if (url.username || url.password) {
      return undefined;
    }
    return trimTrailingSlashes(url.toString());
  } catch {
    return undefined;
  }
}

function isInsecureVoiceBaseUrlAllowed(
  settings: LoadedSettings,
  normalizedBaseUrl: string,
): boolean {
  const allowed = settings.merged.security?.allowedInsecureVoiceBaseUrls;
  return (
    Array.isArray(allowed) &&
    allowed.some(
      (candidate) =>
        typeof candidate === 'string' &&
        normalizeAllowedVoiceBaseUrl(candidate) === normalizedBaseUrl,
    )
  );
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

function normalizeIpAddress(address: string): string {
  const host = normalizeHostname(address);
  if (isIP(host) !== 6) {
    return host;
  }
  try {
    return normalizeHostname(new URL(`http://[${host}]/`).hostname);
  } catch {
    return host;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isAwsIpv6MetadataAddress(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (isIP(host) !== 6) {
    return false;
  }
  try {
    return (
      normalizeHostname(new URL(`http://[${host}]/`).hostname) ===
      'fd00:ec2::254'
    );
  } catch {
    return false;
  }
}

function readIpv4CompatibleIpv6(host: string): string | undefined {
  if (!host.startsWith('::') || host.startsWith('::ffff:')) {
    return undefined;
  }
  const parts = host.slice(2).split(':');
  if (parts.length === 0 || parts.length > 2 || parts.some((part) => !part)) {
    return undefined;
  }
  if (parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) {
    return undefined;
  }
  const hextets = parts.map((part) => Number.parseInt(part, 16));
  const value =
    hextets.length === 1 ? hextets[0]! : (hextets[0]! << 16) | hextets[1]!;
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join('.');
}

function readIpv4MappedIpv6(host: string): string | undefined {
  // The dotted-quad branch is unreachable once normalizeIpAddress has
  // canonicalized IPv6 literals to hex form; kept defensively.
  const dotted = host.match(/^::ffff:(\d+(?:\.\d+){3})$/i);
  if (dotted && isIP(dotted[1]!) === 4) {
    return dotted[1];
  }
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) {
    return undefined;
  }
  return readIpv4HexPair(hex[1]!, hex[2]!);
}

function readIpv4HexPair(highHex: string, lowHex: string): string {
  const high = Number.parseInt(highHex, 16);
  const low = Number.parseInt(lowHex, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join('.');
}

function readWellKnownNat64Ipv6(host: string): string | undefined {
  const prefix = '64:ff9b::';
  if (!host.startsWith(prefix)) {
    return undefined;
  }
  const suffix = host.slice(prefix.length);
  if (!suffix) {
    return '0.0.0.0';
  }
  const groups = suffix.split(':');
  if (
    groups.length > 2 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))
  ) {
    return undefined;
  }
  return groups.length === 1
    ? readIpv4HexPair('0', groups[0]!)
    : readIpv4HexPair(groups[0]!, groups[1]!);
}

function isBlockedTransitionIpv6Address(host: string): boolean {
  return (
    isIP(host) === 6 && BLOCKED_TRANSITION_IPV6_ADDRESSES.check(host, 'ipv6')
  );
}

function unwrapIpv6TransitionStep(
  host: string,
): { address: string } | 'blocked' | undefined {
  const ipv4Mapped = readIpv4MappedIpv6(host);
  if (ipv4Mapped) {
    return { address: ipv4Mapped };
  }
  const ipv4Compatible = readIpv4CompatibleIpv6(host);
  if (ipv4Compatible) {
    return { address: ipv4Compatible };
  }
  const nat64 = readWellKnownNat64Ipv6(host);
  if (nat64) {
    return { address: nat64 };
  }
  if (host.startsWith('::ffff:')) {
    return 'blocked';
  }
  return undefined;
}

// Blocks IP-literal private networks only. Hostname DNS resolution and
// rebinding protection require an async lookup or socket-level remoteAddress check.
function isPrivateNetworkIp(hostname: string): boolean {
  const host = normalizeIpAddress(hostname);
  if (isBlockedTransitionIpv6Address(host)) {
    return true;
  }
  if (isLoopbackHost(host)) {
    return false;
  }
  const step = unwrapIpv6TransitionStep(host);
  if (step === 'blocked') {
    return true;
  }
  if (step) {
    return isPrivateNetworkIp(step.address);
  }
  if (isIP(host) === 4) {
    const [first = 0, second = 0] = host.split('.').map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127)
    );
  }
  if (isIP(host) === 6) {
    const firstHextet = Number.parseInt(host.split(':', 1)[0] || '0', 16);
    return (
      host === '::' ||
      (firstHextet & 0xffc0) === 0xfe80 ||
      (firstHextet & 0xfe00) === 0xfc00
    );
  }
  return false;
}

function isAlwaysBlockedVoiceAddress(address: string): boolean {
  const host = normalizeIpAddress(address);
  if (isBlockedTransitionIpv6Address(host)) {
    return true;
  }
  if (isLoopbackHost(host)) {
    return true;
  }
  const step = unwrapIpv6TransitionStep(host);
  if (step === 'blocked') {
    return true;
  }
  if (step) {
    return isAlwaysBlockedVoiceAddress(step.address);
  }
  if (isIP(host) === 4) {
    const [first = 0, second = 0] = host.split('.').map(Number);
    return (
      first === 0 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      host === '100.100.100.200'
    );
  }
  if (isIP(host) === 6) {
    const firstHextet = Number.parseInt(host.split(':', 1)[0] || '0', 16);
    return (
      host === '::' ||
      isAwsIpv6MetadataAddress(host) ||
      (firstHextet & 0xffc0) === 0xfe80
    );
  }
  return false;
}

function isLoopbackVoiceAddress(address: string): boolean {
  const host = normalizeIpAddress(address);
  if (isLoopbackHost(host)) {
    return true;
  }
  const step = unwrapIpv6TransitionStep(host);
  if (step && step !== 'blocked') {
    return isLoopbackVoiceAddress(step.address);
  }
  if (isIP(host) === 4) {
    return host.startsWith('127.');
  }
  return false;
}

async function defaultLookupHost(
  hostname: string,
): Promise<Array<{ address: string }>> {
  return dnsLookup(hostname, { all: true });
}

export async function assertVoiceBaseUrlNetworkAllowed(
  voiceConfig: VoiceTranscriptionConfig,
  lookupHost?: VoiceHostLookup,
  abortSignal?: AbortSignal,
): Promise<void> {
  const hostname = normalizeHostname(new URL(voiceConfig.baseUrl).hostname);
  if (isLoopbackHost(hostname)) {
    return;
  }
  if (isIP(hostname) !== 0) {
    if (
      isAlwaysBlockedVoiceAddress(hostname) ||
      (!voiceConfig.allowInsecureBaseUrl && isPrivateNetworkIp(hostname))
    ) {
      throw new Error(
        isLoopbackVoiceAddress(hostname)
          ? `Voice model '${voiceConfig.model}' uses a loopback address outside the accepted spellings. To use a local ASR endpoint, set the baseUrl to http://localhost, http://127.0.0.1, or http://[::1].`
          : `Voice model '${voiceConfig.model}' resolved to a private-network address.`,
      );
    }
    return;
  }
  let result: { address: string } | Array<{ address: string }>;
  let onAbort: (() => void) | undefined;
  try {
    if (abortSignal?.aborted) {
      throw abortSignal.reason;
    }
    const lookup = (lookupHost ?? defaultLookupHost)(hostname);
    result = abortSignal
      ? await Promise.race([
          lookup,
          new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(abortSignal.reason);
            if (abortSignal.aborted) onAbort();
            else abortSignal.addEventListener('abort', onAbort, { once: true });
          }),
        ])
      : await lookup;
  } catch {
    if (abortSignal?.aborted) {
      throw abortSignal.reason instanceof Error
        ? abortSignal.reason
        : new Error('Voice request was aborted.');
    }
    throw new Error(
      `Voice model '${voiceConfig.model}': DNS lookup failed for ${hostname}. Cannot verify network safety.`,
    );
  } finally {
    if (onAbort) abortSignal?.removeEventListener('abort', onAbort);
  }
  const records = Array.isArray(result) ? result : [result];
  if (
    records.some(
      (record) =>
        isAlwaysBlockedVoiceAddress(record.address) ||
        (!voiceConfig.allowInsecureBaseUrl &&
          isPrivateNetworkIp(record.address)),
    )
  ) {
    throw new Error(
      records.some((record) => isLoopbackVoiceAddress(record.address))
        ? `Voice model '${voiceConfig.model}' resolved to a loopback address. Loopback DNS results are always blocked; to use a local ASR endpoint, configure an explicit loopback baseUrl: http://localhost, http://127.0.0.1, or http://[::1].`
        : voiceConfig.allowInsecureBaseUrl &&
            records.some((record) =>
              isAlwaysBlockedVoiceAddress(record.address),
            )
          ? `Voice model '${voiceConfig.model}' resolved to an address that is always blocked (metadata, link-local, or transition range), even when the baseUrl is listed in security.allowedInsecureVoiceBaseUrls.`
          : `Voice model '${voiceConfig.model}' resolved to a private-network address.`,
    );
  }
}

function readApiKey(
  settings: LoadedSettings,
  model: AvailableModel,
  baseUrl: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
): string | undefined {
  if (!model.envKey && !isQwenBaseUrl(baseUrl)) {
    return undefined;
  }
  const envKey = model.envKey ?? DEFAULT_OPENAI_API_KEY;
  const envSource = env ?? process.env;
  // Object.hasOwn keeps an envKey naming an inherited Object.prototype member
  // (e.g. "constructor") from reaching .trim() as a function.
  const envValue = Object.hasOwn(envSource, envKey)
    ? envSource[envKey]
    : undefined;
  if (envValue && envValue.trim().length > 0) {
    return envValue.trim();
  }
  const settingsEnvValue = readSettingsEnv(settings, envKey);
  if (settingsEnvValue) {
    return settingsEnvValue;
  }
  if (!model.envKey && isQwenBaseUrl(baseUrl)) {
    const authApiKey = settings.merged.security?.auth?.apiKey;
    return typeof authApiKey === 'string' && authApiKey.trim().length > 0
      ? authApiKey.trim()
      : undefined;
  }
  return undefined;
}

export function resolveVoiceTranscriptionConfig({
  config,
  settings,
  voiceModel,
  env,
}: ResolveVoiceTranscriptionConfigArgs): VoiceTranscriptionConfig {
  const matches = config
    .getAllConfiguredModels()
    .filter((model) => model.id === voiceModel);

  if (matches.length === 0) {
    throw new Error(
      `Voice model '${voiceModel}' is not configured. Run /model --voice to choose a configured model.`,
    );
  }

  if (matches.length > 1) {
    throw new Error(`Voice model '${voiceModel}' is ambiguous.`);
  }

  const model = matches[0];
  if (!isTranscribableVoiceModel(model)) {
    throw new Error(formatUnsupportedVoiceModelMessage(voiceModel));
  }

  const baseUrl = model.baseUrl?.trim();
  if (!baseUrl) {
    throw new Error(`Voice model '${voiceModel}' does not define a baseUrl.`);
  }
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl, voiceModel);
  const parsedBaseUrl = new URL(normalizedBaseUrl);
  const isLocalhost = isLoopbackHost(parsedBaseUrl.hostname);
  const allowInsecureBaseUrl = isInsecureVoiceBaseUrlAllowed(
    settings,
    normalizedBaseUrl,
  );
  if (
    parsedBaseUrl.protocol !== 'http:' &&
    parsedBaseUrl.protocol !== 'https:'
  ) {
    throw new Error(
      `Voice model '${voiceModel}' must use an http or https baseUrl.`,
    );
  }
  if (!isLocalhost && isAlwaysBlockedVoiceAddress(parsedBaseUrl.hostname)) {
    throw new Error(
      isLoopbackVoiceAddress(parsedBaseUrl.hostname)
        ? `Voice model '${voiceModel}' uses a loopback address outside the accepted spellings. To use a local ASR endpoint, set the baseUrl to http://localhost, http://127.0.0.1, or http://[::1].`
        : `Voice model '${voiceModel}' must not use a private-network baseUrl.`,
    );
  }
  if (
    parsedBaseUrl.protocol !== 'https:' &&
    !isLocalhost &&
    !allowInsecureBaseUrl
  ) {
    throw new Error(
      `Voice model '${voiceModel}' must use an https baseUrl. Voice audio must not be transmitted in cleartext. To trust this managed endpoint, add its exact complete normalized URL (${normalizedBaseUrl}) to security.allowedInsecureVoiceBaseUrls. This setting is only honored from User, System, or SystemDefaults scope settings; Workspace entries are ignored.`,
    );
  }
  if (
    !isLocalhost &&
    !allowInsecureBaseUrl &&
    isPrivateNetworkIp(parsedBaseUrl.hostname)
  ) {
    throw new Error(
      `Voice model '${voiceModel}' must not use a private-network baseUrl. To trust this managed endpoint, add its exact complete normalized URL (${normalizedBaseUrl}) to security.allowedInsecureVoiceBaseUrls. This setting is only honored from User, System, or SystemDefaults scope settings; Workspace entries are ignored.`,
    );
  }

  const apiKey = readApiKey(settings, model, normalizedBaseUrl, env);
  if (model.envKey && !apiKey) {
    throw new Error(`Voice model '${voiceModel}' requires ${model.envKey}.`);
  }

  return {
    model: voiceModel,
    baseUrl: normalizedBaseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(allowInsecureBaseUrl ? { allowInsecureBaseUrl: true } : {}),
  };
}

export function isStreamingVoiceModel(model: string): boolean {
  const transport = resolveVoiceTransport(model);
  return (
    transport === 'qwen-asr-realtime' || transport === 'dashscope-task-realtime'
  );
}

/** Build a streaming (WebSocket) config from the configured voice provider. */
export function resolveVoiceStreamConfig(
  args: ResolveVoiceTranscriptionConfigArgs,
): ResolvedVoiceStreamConfig {
  const base = resolveVoiceTranscriptionConfig(args);
  const transport = resolveVoiceTransport(base.model);
  if (
    transport !== 'qwen-asr-realtime' &&
    transport !== 'dashscope-task-realtime'
  ) {
    throw new Error(
      `Voice model '${base.model}' does not support streaming transcription.`,
    );
  }
  const language = resolveLanguageCode(readVoiceLanguage(args.settings));
  const keytermsContext =
    transport === 'qwen-asr-realtime'
      ? buildKeytermsContext(args.settings)
      : undefined;
  return {
    transport,
    baseUrl: base.baseUrl,
    model: base.model,
    ...(base.apiKey ? { apiKey: base.apiKey } : {}),
    ...(base.allowInsecureBaseUrl ? { allowInsecureBaseUrl: true } : {}),
    ...(language ? { language } : {}),
    ...(keytermsContext ? { keytermsContext } : {}),
  };
}

// Common spoken-language names → the codes Qwen-ASR's asr_options.language wants.
const LANGUAGE_CODES: Record<string, string> = {
  english: 'en',
  chinese: 'zh',
  mandarin: 'zh',
  cantonese: 'yue',
  japanese: 'ja',
  korean: 'ko',
  french: 'fr',
  german: 'de',
  spanish: 'es',
  italian: 'it',
  portuguese: 'pt',
  russian: 'ru',
  arabic: 'ar',
};

function resolveLanguageCode(language: string | undefined): string | undefined {
  if (!language) {
    return undefined;
  }
  const lower = language.toLowerCase();
  if (LANGUAGE_CODES[lower]) {
    return LANGUAGE_CODES[lower];
  }
  // Already a short code (en / zh / yue). Unknown free text → let it auto-detect.
  return /^[a-z]{2,3}$/.test(lower) ? lower : undefined;
}

function buildKeytermsContext(settings: LoadedSettings): string | undefined {
  try {
    const keyterms = buildVoiceKeyterms(settings);
    return keyterms.length > 0 ? keyterms.join(' ') : undefined;
  } catch {
    return undefined;
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * On non-speech audio (silence/noise) Qwen-ASR can hallucinate the keyterm
 * context back as the transcript. Detect that — a multi-word result whose tokens
 * are almost entirely keyterms — so the bias list never lands in the prompt.
 * Short results are left alone so genuine terse utterances ("grep regex") pass.
 */
export function isKeytermEcho(
  transcript: string,
  keytermsContext?: string,
): boolean {
  if (!keytermsContext) {
    return false;
  }
  const tokens = tokenize(transcript);
  if (tokens.length < 4) {
    return false;
  }
  const keyset = new Set(tokenize(keytermsContext));
  const overlap = tokens.filter((t) => keyset.has(t)).length;
  const transcriptRatio = overlap / tokens.length;
  const keytermRatio = overlap / keyset.size;
  const isEcho =
    overlap >= MIN_KEYTERM_ECHO_TOKENS &&
    transcriptRatio >= 0.9 &&
    (keytermRatio >= MIN_KEYTERM_SET_ECHO_RATIO ||
      overlap >= MIN_ABSOLUTE_KEYTERM_ECHO_TOKENS);
  if (isEcho) {
    const branch =
      keytermRatio >= MIN_KEYTERM_SET_ECHO_RATIO ? 'ratio' : 'absolute';
    debugLogger.debug(
      `[voice] dropped likely keyterm echo (${branch}): overlap=${overlap} keysetSize=${keyset.size} transcriptRatio=${transcriptRatio.toFixed(2)} keytermRatio=${keytermRatio.toFixed(2)} text="${transcript}"`,
    );
  }
  return isEcho;
}

// Qwen-ASR caps each audio file at 10 MB / 5 minutes. Our 16 kHz mono 16-bit WAV
// is ~32 KB/s, so guard before encoding to give a clear error on overlong holds.
export const MAX_AUDIO_BYTES = DEFAULT_MAX_AUDIO_BRIDGE_BYTES;
const MAX_TRANSCRIPTION_ERROR_LENGTH = 200;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizeVoiceErrorMessage(
  raw: string,
  apiKey?: string,
): string {
  let redacted = raw
    .replace(
      /Authorization:\s*(?:Bearer|ApiKey|Basic|Token)?\s*\S+/gi,
      'Authorization: [REDACTED]',
    )
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:api[-_ ]?key|token|secret)=\S+/gi, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9._-]{4,}\b/g, '[REDACTED]');
  if (apiKey) {
    redacted = redacted.replace(
      new RegExp(escapeRegExp(apiKey), 'g'),
      '[REDACTED]',
    );
  }
  return redacted.length > MAX_TRANSCRIPTION_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_TRANSCRIPTION_ERROR_LENGTH)}...`
    : redacted;
}

const AUDIO_FORMAT_ALIASES: Record<string, string> = {
  mpeg: 'mp3',
  wave: 'wav',
  'vnd.wave': 'wav',
  'x-wav': 'wav',
  'x-m4a': 'm4a',
  'x-aac': 'aac',
  'x-aiff': 'aiff',
  'x-flac': 'flac',
  'x-ogg': 'ogg',
  'x-mpeg': 'mp3',
  'x-ms-wma': 'wma',
};

function inputAudioFormat(mimeType: string): string {
  const subtype = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const raw = subtype.startsWith('audio/')
    ? subtype.slice('audio/'.length) || 'wav'
    : 'wav';
  // hasOwn guard: the subtype is attacker-influenceable (ACP clients supply
  // mimeType), and inherited prototype keys would otherwise leak as formats.
  return Object.hasOwn(AUDIO_FORMAT_ALIASES, raw)
    ? AUDIO_FORMAT_ALIASES[raw]
    : raw;
}

// mime/lite resolves `.m4a` to `audio/mp4` (no extension maps to the `x-m4a`
// alias), and qwen3-asr-flash's documented format list includes neither
// `mp4` nor `m4a`, so fail closed instead of sending an undocumented format.
// If the endpoint is ever verified to accept `m4a`, replace this with an
// `mp4: 'm4a'` entry in AUDIO_FORMAT_ALIASES.
const UNSUPPORTED_INPUT_AUDIO_FORMATS: ReadonlySet<string> = new Set([
  'm4a',
  'mp4',
]);

export function unsupportedAudioFormat(mimeType: string): string | undefined {
  const format = inputAudioFormat(mimeType);
  return UNSUPPORTED_INPUT_AUDIO_FORMATS.has(format) ? format : undefined;
}

function transcriptionAbortSignal(abortSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(INFERENCE_TIMEOUT_MS);
  return abortSignal
    ? AbortSignal.any([abortSignal, timeoutSignal])
    : timeoutSignal;
}

/**
 * Transcribe via the DashScope/Qwen-ASR OpenAI-compatible protocol: the audio
 * is sent as an `input_audio` chat message and the transcript comes back as the
 * assistant message content. (DashScope does NOT serve the Whisper-style
 * `/audio/transcriptions` endpoint — it 404s.) Keyterm biasing goes in a leading
 * system message with structured content; language/itn go in `asr_options`.
 */
async function transcribeViaQwenAsr(
  audio: RecordedVoiceAudio,
  voiceConfig: VoiceTranscriptionConfig,
  options: {
    language?: string;
    keytermsContext?: string;
    abortSignal?: AbortSignal;
    onEgress?: () => void;
  },
  fetchFn: typeof fetch,
): Promise<string> {
  if (audio.data.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(
      'Recording is too long for transcription (max ~5 minutes / 10 MB). Try a shorter dictation.',
    );
  }
  const dataUrl = `data:${audio.mimeType};base64,${Buffer.from(audio.data).toString('base64')}`;

  const messages: unknown[] = [];
  if (options.keytermsContext) {
    messages.push({
      role: 'system',
      content: [{ type: 'text', text: options.keytermsContext }],
    });
  }
  messages.push({
    role: 'user',
    content: [
      {
        type: 'input_audio',
        input_audio: {
          data: dataUrl,
          format: inputAudioFormat(audio.mimeType),
        },
      },
    ],
  });

  const asrOptions: Record<string, unknown> = { enable_itn: true };
  if (options.language) {
    asrOptions['language'] = options.language;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (voiceConfig.apiKey) {
    headers['Authorization'] = `Bearer ${voiceConfig.apiKey}`;
  }

  let response: Response;
  try {
    options.onEgress?.();
    response = await fetchFn(
      `${trimTrailingSlashes(voiceConfig.baseUrl)}/chat/completions`,
      {
        method: 'POST',
        headers,
        redirect: 'manual',
        body: JSON.stringify({
          model: voiceConfig.model,
          messages,
          asr_options: asrOptions,
        }),
        signal: transcriptionAbortSignal(options.abortSignal),
      },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error(
        `Voice transcription timed out after ${INFERENCE_TIMEOUT_MS / 1000}s. Check ASR service health and retry.`,
      );
    }
    throw error;
  }

  if (response.status >= 300 && response.status < 400) {
    throw new Error('Voice transcription request redirected.');
  }

  if (!response.ok) {
    let details = '';
    try {
      details = sanitizeVoiceErrorMessage(
        await response.text(),
        voiceConfig.apiKey,
      );
    } catch {
      details = '';
    }
    if (/model_not_supported|unsupported model/i.test(details)) {
      throw new Error(
        'This voice model cannot be used for batch transcription. Use qwen3-asr-flash for batch or choose a realtime voice model such as qwen3-asr-flash-realtime / fun-asr-realtime / paraformer-realtime-v2.',
      );
    }
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Voice transcription request failed (${response.status} ${response.statusText})${suffix}`,
    );
  }

  const json = (await response.json()) as ChatCompletionResponse;
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('Voice transcription response did not include text.');
  }
  const text = content.trim();
  // Drop the result if the model just echoed our keyterm bias back (happens on
  // non-speech audio) so the term list never gets inserted into the prompt.
  if (isKeytermEcho(text, options.keytermsContext)) {
    return '';
  }
  return text;
}

export async function transcribeVoiceAudio(
  audio: RecordedVoiceAudio,
  args: TranscribeVoiceAudioArgs,
): Promise<string> {
  const voiceConfig = resolveVoiceTranscriptionConfig(args);
  await assertVoiceBaseUrlNetworkAllowed(
    voiceConfig,
    args.lookupHost,
    args.abortSignal,
  );
  const fetchFn = args.fetchFn ?? fetch;
  const language = resolveLanguageCode(readVoiceLanguage(args.settings));
  const keytermsContext = buildKeytermsContext(args.settings);

  const transport = resolveVoiceTransport(voiceConfig.model);
  switch (transport) {
    case 'qwen-asr-chat':
      return transcribeViaQwenAsr(
        audio,
        voiceConfig,
        {
          language,
          keytermsContext,
          abortSignal: args.abortSignal,
          ...(args.onEgress ? { onEgress: args.onEgress } : {}),
        },
        fetchFn,
      );
    case 'qwen-asr-realtime':
    case 'dashscope-task-realtime':
      throw new Error(
        `Voice model '${voiceConfig.model}' requires streaming transcription.`,
      );
    case 'unsupported':
    default:
      throw new Error(
        `Voice model '${voiceConfig.model}' is not a supported transcription model.`,
      );
  }
}
