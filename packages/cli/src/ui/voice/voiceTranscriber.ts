/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { AvailableModel, Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import type { RecordedVoiceAudio } from '../hooks/useVoiceInput.js';
import { buildVoiceKeyterms } from './voiceKeyterms.js';
import type { VoiceStreamConfig } from './voiceStreamSession.js';
import {
  formatUnsupportedVoiceModelMessage,
  isTranscribableVoiceModel,
  resolveVoiceTransport,
} from './voiceModel.js';

const DEFAULT_OPENAI_API_KEY = 'OPENAI_API_KEY';
const INFERENCE_TIMEOUT_MS = 60_000;
const MIN_KEYTERM_ECHO_TOKENS = 8;
const MIN_HAN_KEYTERM_ECHO_TOKENS = 4;

export { resolveVoiceTransport };
export type { VoiceTransport } from './voiceModel.js';

export type VoiceStreamingTransport =
  | 'qwen-asr-realtime'
  | 'dashscope-task-realtime';

type VoiceHostLookup = (
  hostname: string,
) => Promise<{ address: string } | Array<{ address: string }>>;

function readVoiceLanguage(settings: LoadedSettings): string | undefined {
  const language = (
    settings.merged.general as { voice?: { language?: unknown } } | undefined
  )?.voice?.language;
  if (typeof language !== 'string') {
    return undefined;
  }
  const trimmed = language.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface VoiceTranscriptionConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
}

export interface ResolvedVoiceStreamConfig extends VoiceStreamConfig {
  transport: VoiceStreamingTransport;
}

interface ResolveVoiceTranscriptionConfigArgs {
  config: Config;
  settings: LoadedSettings;
  voiceModel: string;
}

interface TranscribeVoiceAudioArgs extends ResolveVoiceTranscriptionConfigArgs {
  fetchFn?: typeof fetch;
  lookupHost?: VoiceHostLookup;
}

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
  url.username = '';
  url.password = '';
  return trimTrailingSlashes(url.toString());
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

// Blocks IP-literal private networks only. Hostname DNS resolution and
// rebinding protection require an async lookup or socket-level remoteAddress check.
function isPrivateNetworkIp(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (isLoopbackHost(host)) {
    return false;
  }
  const ipv4Mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Mapped) {
    return isPrivateNetworkIp(ipv4Mapped[1]!);
  }
  if (host.startsWith('::ffff:')) {
    return true;
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
    return (
      host === '::' ||
      host.startsWith('fe80:') ||
      host.startsWith('fc') ||
      host.startsWith('fd')
    );
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
): Promise<void> {
  const hostname = new URL(voiceConfig.baseUrl).hostname;
  if (isLoopbackHost(hostname) || isIP(normalizeHostname(hostname)) !== 0) {
    return;
  }
  let result: { address: string } | Array<{ address: string }>;
  try {
    result = await (lookupHost ?? defaultLookupHost)(hostname);
  } catch {
    return;
  }
  const records = Array.isArray(result) ? result : [result];
  if (records.some((record) => isPrivateNetworkIp(record.address))) {
    throw new Error(
      `Voice model '${voiceConfig.model}' resolved to a private-network address.`,
    );
  }
}

function readApiKey(
  settings: LoadedSettings,
  model: AvailableModel,
  baseUrl: string,
): string | undefined {
  if (!model.envKey && !isQwenBaseUrl(baseUrl)) {
    return undefined;
  }
  const envKey = model.envKey ?? DEFAULT_OPENAI_API_KEY;
  const envValue = process.env[envKey];
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
  if (parsedBaseUrl.protocol !== 'https:' && !isLocalhost) {
    throw new Error(
      `Voice model '${voiceModel}' must use an https baseUrl. Voice audio must not be transmitted in cleartext.`,
    );
  }
  if (isPrivateNetworkIp(parsedBaseUrl.hostname)) {
    throw new Error(
      `Voice model '${voiceModel}' must not use a private-network baseUrl.`,
    );
  }

  const apiKey = readApiKey(settings, model, normalizedBaseUrl);
  if (model.envKey && !apiKey) {
    throw new Error(`Voice model '${voiceModel}' requires ${model.envKey}.`);
  }

  return {
    model: voiceModel,
    baseUrl: normalizedBaseUrl,
    ...(apiKey ? { apiKey } : {}),
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
    transport === 'qwen-asr-realtime' ? buildKeytermsContext(args) : undefined;
  return {
    transport,
    baseUrl: base.baseUrl,
    model: base.model,
    ...(base.apiKey ? { apiKey: base.apiKey } : {}),
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

function buildKeytermsContext(
  args: ResolveVoiceTranscriptionConfigArgs,
): string | undefined {
  try {
    void args;
    const keyterms = buildVoiceKeyterms();
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

function compactLettersAndNumbers(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function hasHan(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

function isUnsegmentedHanKeytermEcho(
  transcript: string,
  keyterms: string[],
): boolean {
  const transcriptText = compactLettersAndNumbers(transcript);
  if (!hasHan(transcriptText)) {
    return false;
  }

  const hanKeyterms = keyterms.filter(hasHan);
  if (hanKeyterms.length < MIN_HAN_KEYTERM_ECHO_TOKENS) {
    return false;
  }

  const matched = hanKeyterms.filter((term) => transcriptText.includes(term));
  const matchedChars = matched.reduce((sum, term) => sum + term.length, 0);
  return (
    matched.length >= MIN_HAN_KEYTERM_ECHO_TOKENS &&
    matchedChars / transcriptText.length >= 0.9
  );
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
  const keyterms = tokenize(keytermsContext);
  const keyset = new Set(keyterms);
  if (tokens.length < 4) {
    return isUnsegmentedHanKeytermEcho(transcript, keyterms);
  }
  const overlap = tokens.filter((t) => keyset.has(t)).length;
  return overlap >= MIN_KEYTERM_ECHO_TOKENS && overlap / tokens.length >= 0.9;
}

// Qwen-ASR caps each audio file at 10 MB / 5 minutes. Our 16 kHz mono 16-bit WAV
// is ~32 KB/s, so guard before encoding to give a clear error on overlong holds.
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeResponseDetails(raw: string, apiKey?: string): string {
  let redacted = raw.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  if (apiKey) {
    redacted = redacted.replace(
      new RegExp(escapeRegExp(apiKey), 'g'),
      '[REDACTED]',
    );
  }
  return redacted.length > 200 ? `${redacted.slice(0, 200)}...` : redacted;
}

function inputAudioFormat(mimeType: string): string {
  return mimeType.split(';', 1)[0]?.replace(/^audio\//, '') || 'wav';
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
  options: { language?: string; keytermsContext?: string },
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
    response = await fetchFn(
      `${trimTrailingSlashes(voiceConfig.baseUrl)}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: voiceConfig.model,
          messages,
          asr_options: asrOptions,
        }),
        signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
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

  if (!response.ok) {
    let details = '';
    try {
      details = sanitizeResponseDetails(
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
  await assertVoiceBaseUrlNetworkAllowed(voiceConfig, args.lookupHost);
  const fetchFn = args.fetchFn ?? fetch;
  const language = resolveLanguageCode(readVoiceLanguage(args.settings));
  const keytermsContext = buildKeytermsContext(args);

  const transport = resolveVoiceTransport(voiceConfig.model);
  switch (transport) {
    case 'qwen-asr-chat':
      return transcribeViaQwenAsr(
        audio,
        voiceConfig,
        { language, keytermsContext },
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
