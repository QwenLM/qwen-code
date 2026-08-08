/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  MediaPolicyToolDescriptor,
  ToolInvocation,
  ToolResult,
} from '../../../tools/tools.js';
import { Kind } from '../../../tools/tools.js';
import { recognizeMediaFile } from '../../recognition.js';
import {
  assertMediaPolicyIo,
  BaseMediaPolicyTool,
  BaseMediaPolicyToolInvocation,
  MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
  mediaPolicyToolError,
  mediaPolicyToolSuccess,
  resolvePolicyToolTimeoutMs,
  validateMediaPolicyIoParams,
  type MediaPolicyIoParams,
  type MediaPolicyToolConfigView,
} from './media-policy-tool.js';

export const OMNI_TRANSCRIBE_AUDIO_TOOL_NAME = 'omni_transcribe_audio';

/**
 * Backend defaults (mapping doc §6.1): the qwen3.5-omni ASR backend over
 * the DashScope OpenAI-compatible endpoint. Every value is overridable —
 * per call via tool arguments, per deployment via
 * `policyTools.omni_transcribe_audio.settings` (the orchestrator merges
 * settings underneath fixed-policy arguments; model-origin calls fall
 * back to the same settings here).
 */
export const TRANSCRIBE_AUDIO_DEFAULTS = {
  model: 'qwen3.5-omni-plus',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  maxInputBytes: 10 * 1024 * 1024,
} as const;

/** Output file the transcript artifact is written to (staging-relative). */
const OUTPUT_FILE_NAME = 'transcript.txt';

/** Detected MIME → the `input_audio.format` token DashScope expects. */
const INPUT_AUDIO_FORMATS: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
};

export interface TranscribeAudioParams extends MediaPolicyIoParams {
  /** Optional language hint passed to the ASR model (e.g. "zh", "en"). */
  language?: string;
  /** ASR model id. */
  model?: string;
  /** OpenAI-compatible endpoint base URL. */
  baseUrl?: string;
  /** Name of the environment variable holding the API key. */
  apiKeyEnv?: string;
  /** Maximum input audio size in bytes. */
  maxInputBytes?: number;
}

const TUNABLE_SCHEMA_PROPERTIES = {
  language: {
    type: 'string',
    description:
      'Optional language hint for the transcription (e.g. "zh", "en").',
  },
  model: {
    type: 'string',
    description: "ASR model id. Default 'qwen3.5-omni-plus'.",
  },
  baseUrl: {
    type: 'string',
    description:
      'OpenAI-compatible endpoint base URL the transcription request is sent to. Defaults to the DashScope compatible-mode endpoint.',
  },
  apiKeyEnv: {
    type: 'string',
    description:
      "Environment variable holding the API key for the endpoint. Default 'DASHSCOPE_API_KEY'.",
  },
  maxInputBytes: {
    type: 'number',
    description: 'Maximum input audio size in bytes. Default 10485760 (10MiB).',
    minimum: 1,
  },
} as const;

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  version: '1',
  inputMediaTypes: ['audio'],
  outputs: [
    {
      // Transcript protocol (policy design §6.2): a non-media file
      // artifact — strict UTF-8 text/plain with
      // `metadata.omniRole: 'transcript'` — delivered as a text Part.
      kind: 'file',
      role: 'transcript',
      mimeTypes: ['text/plain'],
      required: true,
      // Uniform lossy declaration (mapping doc §6.1): tone, timbre and
      // non-speech information are lost, and recognition may err.
      lossy: true,
    },
    { kind: 'text', role: 'disclosure', required: true },
  ],
  settingsSchema: {
    type: 'object',
    properties: TUNABLE_SCHEMA_PROPERTIES,
    additionalProperties: false,
  },
};

const readString = (
  settings: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = settings[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const readNumber = (
  settings: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = settings[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
};

/** Read `policyTools.omni_transcribe_audio.settings` leniently — anything
 * absent or malformed resolves to undefined (the code default applies). */
function resolveTranscribeSettings(
  config: MediaPolicyToolConfigView,
): Record<string, unknown> {
  const entry =
    config.getOmniPolicyToolsSettings?.()?.[OMNI_TRANSCRIBE_AUDIO_TOOL_NAME];
  const settings = entry?.settings;
  return settings && typeof settings === 'object' && !Array.isArray(settings)
    ? settings
    : {};
}

/** One SSE `data:` chunk of an OpenAI-compatible streaming response. */
interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
}

/** Concatenate `choices[0].delta.content` across SSE lines. Exported for
 * tests. */
export function parseSseTranscript(body: string): string {
  let transcript = '';
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (payload === '[DONE]') break;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(payload) as StreamChunk;
    } catch {
      continue; // tolerate keep-alive/malformed frames
    }
    const content = chunk.choices?.[0]?.delta?.content;
    if (typeof content === 'string') transcript += content;
  }
  return transcript;
}

class TranscribeAudioInvocation extends BaseMediaPolicyToolInvocation<TranscribeAudioParams> {
  constructor(
    params: TranscribeAudioParams,
    private readonly settingsDefaults: Record<string, unknown>,
    private readonly timeoutMs: number,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Transcribe ${path.basename(this.params.inputPath)} to text`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const settings = this.settingsDefaults;
    const model =
      this.params.model ??
      readString(settings, 'model') ??
      TRANSCRIBE_AUDIO_DEFAULTS.model;
    const baseUrl =
      this.params.baseUrl ??
      readString(settings, 'baseUrl') ??
      TRANSCRIBE_AUDIO_DEFAULTS.baseUrl;
    const apiKeyEnv =
      this.params.apiKeyEnv ??
      readString(settings, 'apiKeyEnv') ??
      TRANSCRIBE_AUDIO_DEFAULTS.apiKeyEnv;
    const maxInputBytes =
      this.params.maxInputBytes ??
      readNumber(settings, 'maxInputBytes') ??
      TRANSCRIBE_AUDIO_DEFAULTS.maxInputBytes;
    const language = this.params.language ?? readString(settings, 'language');

    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      if (inputSizeBytes > maxInputBytes) {
        return mediaPolicyToolError(
          `input audio is ${inputSizeBytes} bytes, over the ${maxInputBytes}-byte transcription limit`,
        );
      }

      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) {
        return mediaPolicyToolError(
          `environment variable ${apiKeyEnv} is not set; transcription is unavailable`,
        );
      }

      // Content recognition (sniff + probe): the detected MIME feeds the
      // request's audio format and the probed duration feeds the
      // disclosure. Non-audio input is refused here.
      const recognized = await recognizeMediaFile(this.params.inputPath, {
        expectedModality: 'audio',
        signal,
      });
      const format = INPUT_AUDIO_FORMATS[recognized.detectedMimeType];
      if (!format) {
        return mediaPolicyToolError(
          `audio container ${recognized.detectedMimeType} is not supported by ${OMNI_TRANSCRIBE_AUDIO_TOOL_NAME}`,
        );
      }

      const bytes = await fs.readFile(this.params.inputPath);
      const dataUri = `data:${recognized.detectedMimeType};base64,${bytes.toString('base64')}`;
      const prompt =
        '请逐字转写这段音频的内容，只输出转写文本，不要添加任何解释。' +
        (language ? `音频语言：${language}。` : '');

      // DashScope compatible-mode omni models only support streaming —
      // stream:true and SSE assembly of delta.content (mapping doc §6.1).
      const requestSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(this.timeoutMs),
      ]);
      const response = await fetch(
        `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            modalities: ['text'],
            stream: true,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'input_audio',
                    input_audio: { data: dataUri, format },
                  },
                  { type: 'text', text: prompt },
                ],
              },
            ],
          }),
          signal: requestSignal,
        },
      );
      if (!response.ok) {
        // Raw upstream bodies must not reach model-visible content — name
        // only the HTTP status.
        return mediaPolicyToolError(
          `transcription request failed: HTTP ${response.status}`,
        );
      }
      const transcript = parseSseTranscript(await response.text()).trim();
      if (!transcript) {
        return mediaPolicyToolError('transcription returned empty text');
      }

      const outputPath = path.join(this.params.outputDir, OUTPUT_FILE_NAME);
      const encoded = Buffer.from(transcript, 'utf-8');
      await fs.writeFile(outputPath, encoded);

      const durationPart =
        recognized.metadata.durationMs !== undefined
          ? `${Math.round(recognized.metadata.durationMs / 1000)}s `
          : '';
      const disclosure = `原 ${durationPart}音频 → 转写文本 ${[...transcript].length} 字，语气/音色/非语音信息丢失，识别可能有误`;

      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName: OUTPUT_FILE_NAME,
        artifactKind: 'file',
        title: 'Audio transcript',
        mimeType: 'text/plain',
        sizeBytes: encoded.length,
        disclosure,
        role: 'transcript',
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'TimeoutError' &&
        !signal.aborted
      ) {
        return mediaPolicyToolError(
          `transcription timed out after ${this.timeoutMs}ms`,
        );
      }
      return mediaPolicyToolError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/**
 * `omni_transcribe_audio` — speech-to-text over the qwen3.5-omni ASR
 * backend (mapping doc §6.1): OpenAI-compatible chat.completions with an
 * `input_audio` content part (base64 data URI), streamed SSE response.
 * Produces a transcript-protocol file artifact (policy design §6.2) plus
 * the mandatory disclosure.
 */
export class OmniTranscribeAudioTool extends BaseMediaPolicyTool<TranscribeAudioParams> {
  constructor(private readonly config: MediaPolicyToolConfigView = {}) {
    super(
      OMNI_TRANSCRIBE_AUDIO_TOOL_NAME,
      'TranscribeAudio',
      'Transcribes an audio file to text via the qwen3.5-omni ASR backend, discarding tone, timbre and non-speech information, with a disclosure of the loss.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          ...MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
          ...TUNABLE_SCHEMA_PROPERTIES,
        },
        required: ['inputPath', 'outputDir'],
        additionalProperties: false,
      },
      config,
    );
  }

  override get mediaPolicyDescriptor(): MediaPolicyToolDescriptor {
    return DESCRIPTOR;
  }

  protected override validateToolParamValues(
    params: TranscribeAudioParams,
  ): string | null {
    return validateMediaPolicyIoParams(params);
  }

  protected createInvocation(
    params: TranscribeAudioParams,
  ): ToolInvocation<TranscribeAudioParams, ToolResult> {
    return new TranscribeAudioInvocation(
      params,
      resolveTranscribeSettings(this.config),
      resolvePolicyToolTimeoutMs(this.config, this.name),
    );
  }
}
