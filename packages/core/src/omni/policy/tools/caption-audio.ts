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
import { ToolNames } from '../../../tools/tool-names.js';
import { recognizeMediaFile } from '../../recognition.js';
import { runFfmpeg } from '../../ffmpeg.js';
import {
  assertMediaPolicyIo,
  BaseMediaPolicyTool,
  BaseMediaPolicyToolInvocation,
  createPolicyToolTimeoutBudget,
  MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
  mediaPolicyToolError,
  mediaPolicyToolFailure,
  mediaPolicyToolSuccess,
  policyOutputFileName,
  resolvePolicyToolSettings,
  resolvePolicyToolTimeoutMs,
  type MediaPolicyIoParams,
  type MediaPolicyToolConfigView,
} from './media-policy-tool.js';
import { requestOmniChatCompletion } from './omni-chat-request.js';
import { collapseRepetitionDegeneration } from './transcribe-audio.js';

export const OMNI_CAPTION_AUDIO_TOOL_NAME = ToolNames.OMNI_CAPTION_AUDIO;

/**
 * Backend defaults: the same DashScope OpenAI-compatible omni endpoint
 * the ASR tool uses (omni models accept audio inputs natively), with the
 * same override surfaces (tool arguments / policyTools settings).
 */
export const CAPTION_AUDIO_DEFAULTS = {
  model: 'qwen3.5-omni-plus',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  maxInputBytes: 10 * 1024 * 1024,
  chunkSeconds: 180,
  prompt:
    '请描述这段音频的内容，包括语音大意、说话人音色、背景声音事件与情绪氛围。',
} as const;

/** How many chunk caption requests run concurrently. */
const CHUNK_CONCURRENCY = 3;

/** Hard ceiling on chunked-caption segments (same attacker-controlled
 * duration rationale as omni_transcribe_audio). */
const MAX_SEGMENT_COUNT = 512;

/** Chunk re-encode target: 16kHz mono AAC (same as the ASR tool's —
 * small payloads, speech-and-ambience sufficient). */
const CHUNK_AUDIO_ARGS = [
  '-vn',
  '-c:a',
  'aac',
  '-b:a',
  '32k',
  '-ar',
  '16000',
  '-ac',
  '1',
] as const;

/** Detected MIME → the `input_audio.format` token DashScope expects. */
const INPUT_AUDIO_FORMATS: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
};

export interface CaptionAudioParams extends MediaPolicyIoParams {
  /** Understanding instruction the caption is written to. */
  prompt?: string;
  /** Omni understanding model id. */
  model?: string;
  /** OpenAI-compatible endpoint base URL. */
  baseUrl?: string;
  /** Name of the environment variable holding the API key. */
  apiKeyEnv?: string;
  /** Maximum input audio size in bytes. */
  maxInputBytes?: number;
  /** Segment length in seconds for chunked understanding of long audio. */
  chunkSeconds?: number;
}

const TUNABLE_SCHEMA_PROPERTIES = {
  prompt: {
    type: 'string',
    description:
      'Understanding instruction the caption is written to (e.g. what aspects to describe: speech gist, timbre, sound events, mood). Default: a general semantic description.',
  },
  model: {
    type: 'string',
    description: "Omni understanding model id. Default 'qwen3.5-omni-plus'.",
  },
  baseUrl: {
    type: 'string',
    description:
      'OpenAI-compatible endpoint base URL the request is sent to. Defaults to the DashScope compatible-mode endpoint.',
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
  chunkSeconds: {
    type: 'number',
    description:
      'Audio longer than this is split into segments of this length and each segment is described separately (per-segment time ranges are prefixed to the text). Default 180.',
    minimum: 30,
    maximum: 1800,
  },
} as const;

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  version: '1',
  inputMediaTypes: ['audio'],
  outputs: [
    {
      // Text-product protocol, role 'caption' (memory role enum预留,
      // M §5.5). Unlike a transcript this is NOT verbatim speech: it is
      // the model's semantic description (timbre, events, mood included).
      kind: 'file',
      role: 'caption',
      mimeTypes: ['text/plain'],
      required: true,
      lossy: true,
    },
    { kind: 'text', role: 'disclosure', required: true },
  ],
  settingsSchema: {
    type: 'object',
    properties: TUNABLE_SCHEMA_PROPERTIES,
    additionalProperties: false,
  },
  // Endpoint + credential selection stays operator-controlled (same
  // rationale as omni_transcribe_audio).
  operatorOnlyParams: ['baseUrl', 'apiKeyEnv'],
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

/** `MM:SS` (or `H:MM:SS` when `withHours`) clock label for segment
 * ranges in the assembled caption. */
function formatClock(totalSeconds: number, withHours: boolean): string {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return withHours ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Outcome of captioning one audio segment. */
interface ChunkOutcome {
  text?: string;
  failure?: string;
  degenerated: boolean;
}

class CaptionAudioInvocation extends BaseMediaPolicyToolInvocation<CaptionAudioParams> {
  constructor(
    params: CaptionAudioParams,
    private readonly settingsDefaults: Record<string, unknown>,
    private readonly timeoutMs: number,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Describe ${path.basename(this.params.inputPath)} with an omni model`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const settings = this.settingsDefaults;
    const model =
      this.params.model ??
      readString(settings, 'model') ??
      CAPTION_AUDIO_DEFAULTS.model;
    const baseUrl =
      this.params.baseUrl ??
      readString(settings, 'baseUrl') ??
      CAPTION_AUDIO_DEFAULTS.baseUrl;
    const apiKeyEnv =
      this.params.apiKeyEnv ??
      readString(settings, 'apiKeyEnv') ??
      CAPTION_AUDIO_DEFAULTS.apiKeyEnv;
    const maxInputBytes =
      this.params.maxInputBytes ??
      readNumber(settings, 'maxInputBytes') ??
      CAPTION_AUDIO_DEFAULTS.maxInputBytes;
    const chunkSeconds =
      this.params.chunkSeconds ??
      readNumber(settings, 'chunkSeconds') ??
      CAPTION_AUDIO_DEFAULTS.chunkSeconds;
    const prompt =
      this.params.prompt ??
      readString(settings, 'prompt') ??
      CAPTION_AUDIO_DEFAULTS.prompt;

    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      if (inputSizeBytes > maxInputBytes) {
        return mediaPolicyToolError(
          `input audio is ${inputSizeBytes} bytes, over the ${maxInputBytes}-byte caption limit`,
        );
      }

      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) {
        return mediaPolicyToolError(
          `environment variable ${apiKeyEnv} is not set; audio captioning is unavailable`,
        );
      }

      const recognized = await recognizeMediaFile(this.params.inputPath, {
        expectedModality: 'audio',
        signal,
      });
      const format = INPUT_AUDIO_FORMATS[recognized.detectedMimeType];
      if (!format) {
        return mediaPolicyToolError(
          `audio container ${recognized.detectedMimeType} is not supported by ${OMNI_CAPTION_AUDIO_TOOL_NAME}`,
        );
      }
      const durationSeconds =
        recognized.metadata.durationMs !== undefined &&
        recognized.metadata.durationMs > 0
          ? recognized.metadata.durationMs / 1000
          : undefined;

      const backend = { model, baseUrl, apiKey, prompt };
      // Same chunking rationale as the ASR tool: a single request over
      // long audio truncates early and degenerates. Segment count > 1 →
      // split the timeline evenly, caption every segment independently,
      // label each with its time range.
      const segmentCount =
        durationSeconds !== undefined
          ? Math.ceil(durationSeconds / chunkSeconds)
          : 1;
      if (segmentCount > MAX_SEGMENT_COUNT) {
        return mediaPolicyToolError(
          `container claims ${Math.round(durationSeconds ?? 0)}s of audio (${segmentCount} segments of ${chunkSeconds}s, over the ${MAX_SEGMENT_COUNT}-segment ceiling) — implausible for a ${inputSizeBytes}-byte input`,
        );
      }

      let caption: string;
      let degeneratedSegments = 0;
      let failedSegments = 0;

      if (durationSeconds !== undefined && segmentCount > 1) {
        const chunked = await this.captionChunked({
          backend,
          durationSeconds,
          segmentCount,
          signal,
        });
        if (!Array.isArray(chunked)) {
          return chunked;
        }
        const withHours = Math.round(durationSeconds) >= 3600;
        const lines: string[] = [];
        const segmentLength = durationSeconds / segmentCount;
        for (const [index, outcome] of chunked.entries()) {
          const range = `[${formatClock(index * segmentLength, withHours)}-${formatClock(Math.min((index + 1) * segmentLength, durationSeconds), withHours)}]`;
          if (outcome.text !== undefined) {
            lines.push(`${range} ${outcome.text}`);
            if (outcome.degenerated) degeneratedSegments++;
          } else {
            lines.push(`${range} （该段理解失败：${outcome.failure}）`);
            failedSegments++;
          }
        }
        caption = lines.join('\n');
      } else {
        const bytes = await fs.readFile(this.params.inputPath);
        const dataUri = `data:${recognized.detectedMimeType};base64,${bytes.toString('base64')}`;
        const response = await requestOmniChatCompletion({
          ...backend,
          media: [{ type: 'input_audio', data: dataUri, format }],
          timeoutMs: this.timeoutMs,
          signal,
        });
        if (!response.ok) {
          return mediaPolicyToolError(
            `caption request failed: ${response.error}`,
          );
        }
        const collapsed = collapseRepetitionDegeneration(response.text);
        caption = collapsed.text;
        if (collapsed.degenerated) degeneratedSegments = 1;
        if (!caption) {
          return mediaPolicyToolError('caption request returned empty text');
        }
      }

      const outputFileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: 'caption',
        extension: '.txt',
      });
      const outputPath = path.join(this.params.outputDir, outputFileName);
      const encoded = Buffer.from(caption, 'utf-8');
      await fs.writeFile(outputPath, encoded);

      const durationPart =
        durationSeconds !== undefined ? `${Math.round(durationSeconds)}s ` : '';
      const segmentPart =
        segmentCount > 1 ? `分 ${segmentCount} 段语义描述` : '语义描述';
      const failurePart =
        failedSegments > 0 ? `（${failedSegments} 段失败）` : '';
      const degenerationPart =
        degeneratedSegments > 0
          ? `，${segmentCount > 1 ? `${degeneratedSegments} 段` : ''}检测到重复退化已截断`
          : '';
      const disclosure = `原 ${durationPart}音频 → ${segmentPart} ${[...caption].length} 字（${model}）${failurePart}${degenerationPart}，为模型理解而非逐字内容，细节可能有误`;

      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName,
        artifactKind: 'file',
        title: 'Audio caption',
        mimeType: 'text/plain',
        sizeBytes: encoded.length,
        disclosure,
        role: 'caption',
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'TimeoutError' &&
        !signal.aborted
      ) {
        return mediaPolicyToolError(
          `caption request timed out after ${this.timeoutMs}ms`,
        );
      }
      return mediaPolicyToolFailure(error);
    }
  }

  /**
   * Chunked understanding: cut the audio into `segmentCount` equal
   * segments (16kHz mono AAC) and caption them with bounded concurrency.
   * Same failure stance as the ASR tool: individual segment failures
   * become inline markers; the run only errors when EVERY segment
   * failed. All cuts and requests share one wall-clock budget.
   */
  private async captionChunked(options: {
    backend: { model: string; baseUrl: string; apiKey: string; prompt: string };
    durationSeconds: number;
    segmentCount: number;
    signal: AbortSignal;
  }): Promise<ToolResult | ChunkOutcome[]> {
    const { backend, durationSeconds, segmentCount, signal } = options;
    const segmentLength = durationSeconds / segmentCount;
    const remainingTimeoutMs = createPolicyToolTimeoutBudget(this.timeoutMs);
    const outcomes: ChunkOutcome[] = new Array(segmentCount);

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const index = nextIndex++;
        if (index >= segmentCount) return;
        if (remainingTimeoutMs() <= 1) {
          outcomes[index] = { failure: '时间预算耗尽', degenerated: false };
          continue;
        }
        outcomes[index] = await this.captionChunk({
          backend,
          index,
          startSeconds: index * segmentLength,
          lengthSeconds: segmentLength,
          remainingTimeoutMs,
          signal,
        });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CHUNK_CONCURRENCY, segmentCount) }, worker),
    );
    if (signal.aborted) {
      return mediaPolicyToolError('audio captioning aborted');
    }

    if (outcomes.every((o) => o.text === undefined)) {
      const lastFailure = outcomes[outcomes.length - 1]?.failure ?? 'unknown';
      return mediaPolicyToolError(
        `captioning failed for all ${segmentCount} segments (last: ${lastFailure})`,
      );
    }
    return outcomes;
  }

  /** Cut one segment with ffmpeg, caption it, collapse repetition
   * degeneration, and clean the temporary cut up. Never throws for
   * per-segment problems — they come back as `failure`. */
  private async captionChunk(options: {
    backend: { model: string; baseUrl: string; apiKey: string; prompt: string };
    index: number;
    startSeconds: number;
    lengthSeconds: number;
    remainingTimeoutMs: () => number;
    signal: AbortSignal;
  }): Promise<ChunkOutcome> {
    const {
      backend,
      index,
      startSeconds,
      lengthSeconds,
      remainingTimeoutMs,
      signal,
    } = options;
    const chunkPath = path.join(
      this.params.outputDir,
      `chunk_${String(index + 1).padStart(4, '0')}.m4a`,
    );
    try {
      const cut = await runFfmpeg(
        [
          '-y',
          '-ss',
          startSeconds.toFixed(3),
          '-t',
          lengthSeconds.toFixed(3),
          '-i',
          this.params.inputPath,
          ...CHUNK_AUDIO_ARGS,
          chunkPath,
        ],
        { signal, timeoutMs: remainingTimeoutMs() },
      );
      if (signal.aborted) {
        return { failure: 'aborted', degenerated: false };
      }
      if (cut.code !== 0) {
        return {
          failure: `切片失败（ffmpeg exit ${cut.code}）`,
          degenerated: false,
        };
      }

      const bytes = await fs.readFile(chunkPath);
      const dataUri = `data:audio/mp4;base64,${bytes.toString('base64')}`;
      const response = await requestOmniChatCompletion({
        ...backend,
        media: [{ type: 'input_audio', data: dataUri, format: 'm4a' }],
        timeoutMs: remainingTimeoutMs(),
        signal,
      });
      if (!response.ok) {
        return { failure: response.error, degenerated: false };
      }
      const collapsed = collapseRepetitionDegeneration(response.text);
      if (!collapsed.text) {
        return { failure: '返回空文本', degenerated: false };
      }
      return { text: collapsed.text, degenerated: collapsed.degenerated };
    } catch (error) {
      if (signal.aborted) {
        return { failure: 'aborted', degenerated: false };
      }
      if (error instanceof Error && error.name === 'TimeoutError') {
        return { failure: '请求超时', degenerated: false };
      }
      return {
        failure: error instanceof Error ? error.message : String(error),
        degenerated: false,
      };
    } finally {
      await fs.rm(chunkPath, { force: true }).catch(() => {});
    }
  }
}

/**
 * `omni_caption_audio` — omni audio understanding (design doc §3.2): an
 * OpenAI-compatible omni model describes the audio under the caller's
 * prompt — speech gist, timbre, sound events, mood — NOT a verbatim
 * transcript (that is omni_transcribe_audio's job). Long audio is split
 * into time-labeled segments (same chunking machinery as the ASR tool).
 * Produces a caption-protocol file artifact (`metadata.omniRole:
 * 'caption'`) plus the mandatory disclosure.
 */
export class OmniCaptionAudioTool extends BaseMediaPolicyTool<CaptionAudioParams> {
  constructor(config: MediaPolicyToolConfigView = {}) {
    super(
      OMNI_CAPTION_AUDIO_TOOL_NAME,
      'CaptionAudio',
      "Generates a semantic text description of an audio file with an omni model under the caller's prompt — speech gist, timbre, sound events, mood (long audio is split into time-labeled segments) — with a disclosure that it is an interpretation, not verbatim content.",
      Kind.Other,
      {
        type: 'object',
        properties: {
          ...MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
          ...TUNABLE_SCHEMA_PROPERTIES,
        },
        required: ['outputDir'],
        additionalProperties: false,
      },
      config,
    );
  }

  override get mediaPolicyDescriptor(): MediaPolicyToolDescriptor {
    return DESCRIPTOR;
  }

  protected createInvocation(
    params: CaptionAudioParams,
  ): ToolInvocation<CaptionAudioParams, ToolResult> {
    return new CaptionAudioInvocation(
      params,
      resolvePolicyToolSettings(this.configView, this.name),
      resolvePolicyToolTimeoutMs(this.configView, this.name),
    );
  }
}
