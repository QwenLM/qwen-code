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
import { appendOmniUsageLog, type OpenAiUsage } from './usage-log.js';

export const OMNI_TRANSCRIBE_AUDIO_TOOL_NAME = ToolNames.OMNI_TRANSCRIBE_AUDIO;

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
  chunkSeconds: 180,
} as const;

/** Output file the transcript artifact is written to (staging-relative). */

/** How many chunk transcription requests run concurrently. */
const CHUNK_CONCURRENCY = 3;

/** Hard ceiling on chunked-transcription segments. The claimed duration
 * comes from container metadata, which a crafted file controls freely: an
 * absurd duration must not translate into millions of outcome slots and
 * queued ffmpeg cuts. 512 × the 30s chunkSeconds floor ≈ 4h16m — far past
 * anything the 10MiB default input cap plausibly holds. */
const MAX_SEGMENT_COUNT = 512;

/** Chunk re-encode target: 16kHz mono AAC — small enough that a chunk's
 * base64 payload stays far under request limits, and speech-sufficient. */
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
  /** Segment length in seconds for chunked transcription of long audio. */
  chunkSeconds?: number;
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
  chunkSeconds: {
    type: 'number',
    description:
      'Audio longer than this is split into segments of this length and each segment is transcribed separately (per-segment time ranges are prefixed to the text). Default 180.',
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
  // Endpoint + credential selection must stay operator-controlled: a
  // gated caller choosing both `apiKeyEnv` and `baseUrl` could point any
  // environment secret (e.g. OPENAI_API_KEY) at an attacker-controlled
  // host. They remain configurable via policyTools settings and
  // modelAccess default/lockedArguments (operator surfaces), and stay in
  // the params schema because fixed-policy `arguments` and settings
  // defaults are merged into tool args under
  // `additionalProperties: false`.
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

/** One SSE `data:` chunk of an OpenAI-compatible streaming response. The
 * final chunk (when stream_options.include_usage is set) carries `usage`
 * and an empty `choices` array. */
interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
  usage?: OpenAiUsage | null;
}

/**
 * Assemble `choices[0].delta.content` across SSE lines and capture the
 * final `usage` block (present only when the request set
 * stream_options.include_usage). Exported for tests.
 */
export function parseSseCompletion(body: string): {
  text: string;
  usage?: OpenAiUsage;
} {
  let transcript = '';
  let usage: OpenAiUsage | undefined;
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
    if (chunk.usage) usage = chunk.usage;
  }
  return { text: transcript, usage };
}

/** Concatenate `choices[0].delta.content` across SSE lines. Exported for
 * tests. */
export function parseSseTranscript(body: string): string {
  return parseSseCompletion(body).text;
}

/** Repetition-degeneration thresholds: a transcript tail counts as
 * degenerated when one unit (≤64 chars, non-whitespace) repeats at least
 * 8 consecutive times spanning at least 24 characters. */
const REPETITION_MIN_REPS = 8;
const REPETITION_MIN_SPAN = 24;
const REPETITION_MAX_UNIT = 64;

/**
 * Detect and collapse ASR repetition degeneration: long inputs make the
 * autoregressive decoder fall into a loop that pads the transcript tail
 * with one endlessly repeated token ("Hej! Hej! Hej! …"). When the text
 * ends in ≥8 consecutive copies of the same unit spanning ≥24 chars, all
 * but the first copy are dropped and the collapse is reported so the
 * caller can disclose it. Exported for tests.
 */
export function collapseRepetitionDegeneration(text: string): {
  text: string;
  degenerated: boolean;
} {
  let best: { unitLen: number; reps: number } | undefined;
  for (let unitLen = 1; unitLen <= REPETITION_MAX_UNIT; unitLen++) {
    if (unitLen * REPETITION_MIN_REPS > text.length) break;
    const unit = text.slice(text.length - unitLen);
    if (unit.trim().length === 0) continue; // whitespace runs are not loops
    let reps = 1;
    while (
      (reps + 1) * unitLen <= text.length &&
      text.startsWith(unit, text.length - (reps + 1) * unitLen)
    ) {
      reps++;
    }
    if (
      reps >= REPETITION_MIN_REPS &&
      reps * unitLen >= REPETITION_MIN_SPAN &&
      (best === undefined || reps * unitLen > best.reps * best.unitLen)
    ) {
      best = { unitLen, reps };
    }
  }
  if (best === undefined) {
    return { text, degenerated: false };
  }
  return {
    text: text.slice(0, text.length - best.unitLen * (best.reps - 1)).trimEnd(),
    degenerated: true,
  };
}

/** `MM:SS` (or `H:MM:SS` when `withHours`) clock label for segment
 * ranges in the assembled transcript. */
function formatClock(totalSeconds: number, withHours: boolean): string {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return withHours ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Outcome of transcribing one audio segment. */
interface ChunkOutcome {
  text?: string;
  failure?: string;
  degenerated: boolean;
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
    const chunkSeconds =
      this.params.chunkSeconds ??
      readNumber(settings, 'chunkSeconds') ??
      TRANSCRIBE_AUDIO_DEFAULTS.chunkSeconds;
    const language = this.params.language ?? readString(settings, 'language');
    const prompt =
      '请逐字转写这段音频的内容，只输出转写文本，不要添加任何解释。' +
      (language ? `音频语言：${language}。` : '');

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
      // disclosure and the chunking decision. Non-audio input is refused
      // here.
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
      const durationSeconds =
        recognized.metadata.durationMs !== undefined &&
        recognized.metadata.durationMs > 0
          ? recognized.metadata.durationMs / 1000
          : undefined;

      const backend = { model, baseUrl, apiKey, prompt };
      // Long audio degrades single-request ASR twice over: the decoder
      // truncates well before the end and falls into repetition loops
      // ("Hej!" × 48). Segment count > 1 → chunked transcription: split
      // the timeline evenly, transcribe every segment independently, and
      // label each with its time range.
      const segmentCount =
        durationSeconds !== undefined
          ? Math.ceil(durationSeconds / chunkSeconds)
          : 1;
      if (segmentCount > MAX_SEGMENT_COUNT) {
        // Fail closed: the duration is attacker-influenced metadata, and
        // the size gate above already bounds what REAL audio can be here.
        return mediaPolicyToolError(
          `container claims ${Math.round(durationSeconds ?? 0)}s of audio (${segmentCount} segments of ${chunkSeconds}s, over the ${MAX_SEGMENT_COUNT}-segment ceiling) — implausible for a ${inputSizeBytes}-byte input`,
        );
      }

      let transcript: string;
      let degeneratedSegments = 0;
      let failedSegments = 0;

      if (durationSeconds !== undefined && segmentCount > 1) {
        const chunked = await this.transcribeChunked({
          backend,
          durationSeconds,
          segmentCount,
          signal,
        });
        if (!Array.isArray(chunked)) {
          return chunked;
        }
        // Match formatClock's Math.round: a 3599.6s duration rounds to
        // 3600 inside the clock label, which without the hours field
        // would render as "00:00" instead of "1:00:00".
        const withHours = Math.round(durationSeconds) >= 3600;
        const lines: string[] = [];
        const segmentLength = durationSeconds / segmentCount;
        for (const [index, outcome] of chunked.entries()) {
          const range = `[${formatClock(index * segmentLength, withHours)}-${formatClock(Math.min((index + 1) * segmentLength, durationSeconds), withHours)}]`;
          if (outcome.text !== undefined) {
            lines.push(`${range} ${outcome.text}`);
            if (outcome.degenerated) degeneratedSegments++;
          } else {
            lines.push(`${range} （该段转写失败：${outcome.failure}）`);
            failedSegments++;
          }
        }
        transcript = lines.join('\n');
      } else {
        const bytes = await fs.readFile(this.params.inputPath);
        const dataUri = `data:${recognized.detectedMimeType};base64,${bytes.toString('base64')}`;
        const response = await this.requestTranscription({
          ...backend,
          dataUri,
          format,
          timeoutMs: this.timeoutMs,
          signal,
        });
        if (!response.ok) {
          return mediaPolicyToolError(
            `transcription request failed: ${response.error}`,
          );
        }
        const collapsed = collapseRepetitionDegeneration(response.text);
        transcript = collapsed.text;
        if (collapsed.degenerated) degeneratedSegments = 1;
        if (!transcript) {
          return mediaPolicyToolError('transcription returned empty text');
        }
      }

      const outputPath = path.join(
        this.params.outputDir,
        policyOutputFileName({
          inputPath: this.params.inputPath,
          operation: 'transcript',
          extension: '.txt',
        }),
      );
      const encoded = Buffer.from(transcript, 'utf-8');
      await fs.writeFile(outputPath, encoded);

      const durationPart =
        durationSeconds !== undefined ? `${Math.round(durationSeconds)}s ` : '';
      const segmentPart =
        segmentCount > 1 ? `分 ${segmentCount} 段转写文本` : '转写文本';
      const failurePart =
        failedSegments > 0 ? `（${failedSegments} 段失败）` : '';
      const degenerationPart =
        degeneratedSegments > 0
          ? `，${segmentCount > 1 ? `${degeneratedSegments} 段` : ''}检测到重复退化已截断`
          : '';
      const disclosure = `原 ${durationPart}音频 → ${segmentPart} ${[...transcript].length} 字${failurePart}${degenerationPart}，语气/音色/非语音信息丢失，识别可能有误`;

      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName: policyOutputFileName({
          inputPath: this.params.inputPath,
          operation: 'transcript',
          extension: '.txt',
        }),
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
      return mediaPolicyToolFailure(error);
    }
  }

  /**
   * Chunked transcription: cut the audio into `segmentCount` equal
   * segments (16kHz mono AAC — small payloads, speech-sufficient) and
   * transcribe them with bounded concurrency. Individual segment
   * failures become inline markers instead of failing the whole run; the
   * run only errors when EVERY segment failed. All cuts and requests
   * share one wall-clock budget.
   */
  private async transcribeChunked(options: {
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
        outcomes[index] = await this.transcribeChunk({
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
      return mediaPolicyToolError('transcription aborted');
    }

    if (outcomes.every((o) => o.text === undefined)) {
      const lastFailure = outcomes[outcomes.length - 1]?.failure ?? 'unknown';
      return mediaPolicyToolError(
        `transcription failed for all ${segmentCount} segments (last: ${lastFailure})`,
      );
    }
    return outcomes;
  }

  /** Cut one segment with ffmpeg, transcribe it, collapse repetition
   * degeneration, and clean the temporary cut up. Never throws for
   * per-segment problems — they come back as `failure`. */
  private async transcribeChunk(options: {
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
      const response = await this.requestTranscription({
        ...backend,
        dataUri,
        format: 'm4a',
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

  /** One streaming chat.completions ASR request. DashScope
   * compatible-mode omni models only support streaming — stream:true and
   * SSE assembly of delta.content (mapping doc §6.1). Non-2xx statuses
   * come back as `HTTP <status>` only: raw upstream bodies must not
   * reach model-visible content. */
  private async requestTranscription(options: {
    model: string;
    baseUrl: string;
    apiKey: string;
    prompt: string;
    dataUri: string;
    format: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const requestSignal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(options.timeoutMs),
    ]);
    const response = await fetch(
      `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model,
          modalities: ['text'],
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_audio',
                  input_audio: {
                    data: options.dataUri,
                    format: options.format,
                  },
                },
                { type: 'text', text: options.prompt },
              ],
            },
          ],
        }),
        signal: requestSignal,
      },
    );
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const { text, usage } = parseSseCompletion(await response.text());
    appendOmniUsageLog(options.model, usage, 'omni_transcribe_audio');
    return { ok: true, text: text.trim() };
  }
}

/**
 * `omni_transcribe_audio` — speech-to-text over the qwen3.5-omni ASR
 * backend (mapping doc §6.1): OpenAI-compatible chat.completions with an
 * `input_audio` content part (base64 data URI), streamed SSE response.
 * Audio longer than `chunkSeconds` is split into equal segments that are
 * transcribed independently and labeled with their time ranges — a
 * single request over long audio truncates early and degenerates into
 * repetition loops. Repetition degeneration is detected and collapsed in
 * every (segment) transcript. Produces a transcript-protocol file
 * artifact (policy design §6.2) plus the mandatory disclosure.
 */
export class OmniTranscribeAudioTool extends BaseMediaPolicyTool<TranscribeAudioParams> {
  constructor(config: MediaPolicyToolConfigView = {}) {
    super(
      OMNI_TRANSCRIBE_AUDIO_TOOL_NAME,
      'TranscribeAudio',
      'Transcribes an audio file to text via the qwen3.5-omni ASR backend (long audio is split into time-labeled segments), discarding tone, timbre and non-speech information, with a disclosure of the loss.',
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
    params: TranscribeAudioParams,
  ): ToolInvocation<TranscribeAudioParams, ToolResult> {
    return new TranscribeAudioInvocation(
      params,
      resolvePolicyToolSettings(this.configView, this.name),
      resolvePolicyToolTimeoutMs(this.configView, this.name),
    );
  }
}
