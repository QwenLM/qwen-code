/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';
import type { AvailableModel, Config } from '@qwen-code/qwen-code-core';
import { getGitBranch } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import type { RecordedVoiceAudio } from '../hooks/useVoiceInput.js';
import { buildVoiceKeyterms } from './voiceKeyterms.js';
import type { VoiceStreamConfig } from './voiceStreamSession.js';
import {
  formatUnsupportedVoiceModelMessage,
  isTranscribableVoiceModel,
} from './voiceModel.js';

const DEFAULT_OPENAI_API_KEY = 'OPENAI_API_KEY';
const INFERENCE_TIMEOUT_MS = 60_000;

export type VoiceTransport =
  | 'qwen-asr-chat'
  | 'qwen-asr-realtime'
  | 'dashscope-task-realtime'
  | 'unsupported';

export type VoiceStreamingTransport =
  | 'qwen-asr-realtime'
  | 'dashscope-task-realtime';

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
  const isLocalhost =
    parsedBaseUrl.hostname === 'localhost' ||
    parsedBaseUrl.hostname === '127.0.0.1' ||
    parsedBaseUrl.hostname === '[::1]';
  if (parsedBaseUrl.protocol !== 'https:' && !isLocalhost) {
    throw new Error(
      `Voice model '${voiceModel}' must use an https baseUrl. Voice audio must not be transmitted in cleartext.`,
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

export function resolveVoiceTransport(model: string): VoiceTransport {
  const id = model.toLowerCase();
  if (/^qwen3-asr-flash-realtime(?:-|$)/.test(id)) {
    return 'qwen-asr-realtime';
  }
  if (/^qwen3-asr-flash(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) {
    return 'qwen-asr-chat';
  }
  if (/^(fun-asr|paraformer).*realtime(?:-|$)/.test(id)) {
    return 'dashscope-task-realtime';
  }
  return 'unsupported';
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
    const projectRoot =
      typeof args.config.getProjectRoot === 'function'
        ? args.config.getProjectRoot()
        : undefined;
    const keyterms = buildVoiceKeyterms({
      projectRoot,
      gitBranch: projectRoot ? getGitBranch(projectRoot) : undefined,
    });
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
  return overlap / tokens.length >= 0.9;
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
      { type: 'input_audio', input_audio: { data: dataUrl, format: 'wav' } },
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
