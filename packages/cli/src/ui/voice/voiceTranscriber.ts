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

// Streaming needs a *-realtime model; the configured (batch) model only
// provides the provider baseUrl + key.
const DEFAULT_REALTIME_MODEL = 'fun-asr-realtime';

const DEFAULT_OPENAI_API_KEY = 'OPENAI_API_KEY';

/**
 * Voice transcription transport protocols. The axis is API *shape*, not vendor:
 * DashScope alone spans three (see voiceTranscriber notes). Only 'qwen-asr-chat'
 * is implemented today; the rest are reserved extension points.
 */
export type VoiceProtocol =
  // DashScope OpenAI-compatible: POST chat/completions + input_audio, sync. (impl)
  | 'qwen-asr-chat'
  // OpenAI/Whisper: POST /audio/transcriptions multipart, sync.
  | 'openai-whisper'
  // DashScope native async file transcription: submit task + poll. (Fun-ASR/Paraformer)
  | 'dashscope-filetrans'
  // DashScope WebSocket streaming ASR (paraformer-realtime / fun-asr-realtime / qwen-realtime).
  | 'dashscope-realtime';

const VOICE_PROTOCOLS: readonly VoiceProtocol[] = [
  'qwen-asr-chat',
  'openai-whisper',
  'dashscope-filetrans',
  'dashscope-realtime',
];

const DEFAULT_VOICE_PROTOCOL: VoiceProtocol = 'qwen-asr-chat';

/**
 * Resolve which transport to use. Default is the DashScope Qwen3-ASR-Flash sync
 * chat protocol. An explicit `general.voice.protocol` override is honored when
 * present (the future home for per-provider selection); unknown values fall back
 * to the default. Behavior is unchanged until other protocols are implemented.
 */
function resolveVoiceProtocol(settings: LoadedSettings): VoiceProtocol {
  const explicit = (
    settings.merged.general as { voice?: { protocol?: unknown } } | undefined
  )?.voice?.protocol;
  return VOICE_PROTOCOLS.includes(explicit as VoiceProtocol)
    ? (explicit as VoiceProtocol)
    : DEFAULT_VOICE_PROTOCOL;
}

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

function readApiKey(
  settings: LoadedSettings,
  model: AvailableModel,
): string | undefined {
  const envKey = model.envKey ?? DEFAULT_OPENAI_API_KEY;
  const envValue = process.env[envKey];
  if (envValue && envValue.trim().length > 0) {
    return envValue.trim();
  }
  const settingsEnvValue = readSettingsEnv(settings, envKey);
  if (settingsEnvValue) {
    return settingsEnvValue;
  }
  if (!model.envKey) {
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

  const apiKey = readApiKey(settings, model);
  if (model.envKey && !apiKey) {
    throw new Error(`Voice model '${voiceModel}' requires ${model.envKey}.`);
  }

  return {
    model: voiceModel,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
  };
}

// Map a configured (possibly batch/file) model id to a Protocol-A realtime
// model. qwen3-asr-flash has no Protocol-A realtime variant, so it falls back
// to the fun-asr-realtime default.
function toRealtimeModel(model: string): string {
  const id = model.toLowerCase();
  if (id.includes('realtime')) return model;
  if (id.startsWith('paraformer')) return 'paraformer-realtime-v2';
  if (id.startsWith('fun-asr')) return 'fun-asr-realtime';
  return DEFAULT_REALTIME_MODEL;
}

/** Build a streaming (WebSocket) config from the configured voice provider. */
export function resolveVoiceStreamConfig(
  args: ResolveVoiceTranscriptionConfigArgs,
): VoiceStreamConfig {
  const base = resolveVoiceTranscriptionConfig(args);
  const model = toRealtimeModel(base.model);
  const language = resolveLanguageCode(readVoiceLanguage(args.settings));
  return {
    baseUrl: base.baseUrl,
    model,
    ...(base.apiKey ? { apiKey: base.apiKey } : {}),
    ...(language ? { language } : {}),
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
  args: TranscribeVoiceAudioArgs,
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
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * On non-speech audio (silence/noise) Qwen-ASR can hallucinate the keyterm
 * context back as the transcript. Detect that — a multi-word result whose tokens
 * are almost entirely keyterms — so the bias list never lands in the prompt.
 * Short results are left alone so genuine terse utterances ("grep regex") pass.
 */
function isKeytermEcho(transcript: string, keytermsContext?: string): boolean {
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

  const response = await fetchFn(
    `${trimTrailingSlashes(voiceConfig.baseUrl)}/chat/completions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: voiceConfig.model,
        messages,
        asr_options: asrOptions,
      }),
    },
  );

  if (!response.ok) {
    let details = '';
    try {
      details = await response.text();
    } catch {
      details = '';
    }
    if (/model_not_supported|unsupported model/i.test(details)) {
      throw new Error(
        'This voice model cannot be used for batch transcription. Use qwen3-asr-flash for batch, or enable streaming (set general.voice.protocol to "dashscope-realtime") for realtime models like fun-asr-realtime / paraformer-realtime-v2.',
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

  const protocol = resolveVoiceProtocol(args.settings);
  switch (protocol) {
    case 'qwen-asr-chat':
      return transcribeViaQwenAsr(
        audio,
        voiceConfig,
        { language, keytermsContext },
        fetchFn,
      );
    // Extension points — add a transcribeVia* handler and wire it here:
    //   'openai-whisper'      → multipart POST /audio/transcriptions
    //   'dashscope-filetrans' → native async submit + poll
    //   'dashscope-realtime'  → WebSocket streaming
    case 'openai-whisper':
    case 'dashscope-filetrans':
    case 'dashscope-realtime':
    default:
      throw new Error(
        `Voice protocol '${protocol}' is not implemented yet; only 'qwen-asr-chat' is supported.`,
      );
  }
}
