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

export const OMNI_UNDERSTAND_VIDEO_SEGMENTS_TOOL_NAME =
  ToolNames.OMNI_UNDERSTAND_VIDEO_SEGMENTS;

/**
 * Backend defaults (design doc §3.3): the same DashScope
 * OpenAI-compatible omni endpoint the other model-call tools use, with
 * the same override surfaces. `segmentSeconds` is the doc's 默认 30s
 * (5000–60000ms → 5–60s); `maxParallelSegments` is the doc's 锁定 8;
 * `maxSegmentBytes` is the doc's 锁定 10MB (DashScope inline ceiling).
 */
export const UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS = {
  model: 'qwen3.5-omni-plus',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  segmentSeconds: 30,
  maxParallelSegments: 8,
  maxSegmentBytes: 10 * 1024 * 1024,
  prompt: '请描述这段视频片段的内容，包括画面事件、人物动作与语音大意。',
} as const;

/** Hard ceiling on segments (same attacker-controlled duration
 * rationale as omni_transcribe_audio): 512 × the 5s floor ≈ 42min at
 * the tightest segmentation; looser segmentations cap out far earlier
 * in wall-clock terms. */
const MAX_SEGMENT_COUNT = 512;

/** Segment re-encode target: a self-contained low-spec mp4 whose size
 * stays far under the 10MB inline ceiling at any supported segment
 * length (360p / ~450kbps video + 32kbps mono AAC ≈ 60KB/s → a 60s
 * segment lands near 3.6MB). */
const SEGMENT_HEIGHT = 360;
const SEGMENT_VIDEO_BITRATE_KBPS = 450;

/** Duration probe tolerance: a segment count derived from container
 * metadata may overrun the real media length by a rounding sliver —
 * clamp, don't fail. */
const DURATION_SLACK_SECONDS = 0.25;

export interface UnderstandVideoSegmentsParams extends MediaPolicyIoParams {
  /** Understanding instruction applied to every segment. */
  prompt?: string;
  /** Omni understanding model id. */
  model?: string;
  /** OpenAI-compatible endpoint base URL. */
  baseUrl?: string;
  /** Name of the environment variable holding the API key. */
  apiKeyEnv?: string;
  /** Fixed segment length in seconds (design doc: 默认 30, 5–60). */
  segmentSeconds?: number;
  /** Parallel segment understanding cap (design doc: 锁定 8). */
  maxParallelSegments?: number;
  /** Per-segment inline size ceiling in bytes (design doc: 锁定 10MB). */
  maxSegmentBytes?: number;
}

const TUNABLE_SCHEMA_PROPERTIES = {
  prompt: {
    type: 'string',
    description:
      'Understanding instruction applied to every segment (what to describe: visual events, actions, speech gist). Default: a general segment description.',
  },
  model: {
    type: 'string',
    description: "Omni understanding model id. Default 'qwen3.5-omni-plus'.",
  },
  baseUrl: {
    type: 'string',
    description:
      'OpenAI-compatible endpoint base URL the requests are sent to. Defaults to the DashScope compatible-mode endpoint.',
  },
  apiKeyEnv: {
    type: 'string',
    description:
      "Environment variable holding the API key for the endpoint. Default 'DASHSCOPE_API_KEY'.",
  },
  segmentSeconds: {
    type: 'number',
    description:
      'Fixed segment length in seconds: the video is cut into segments of this length and each is understood separately. Default 30.',
    minimum: 5,
    maximum: 60,
  },
  maxParallelSegments: {
    type: 'number',
    description: 'Maximum segments understood concurrently. Default 8.',
    minimum: 1,
    maximum: 8,
  },
  maxSegmentBytes: {
    type: 'number',
    description:
      'Maximum size in bytes of one re-encoded segment sent to the model. Default 10485760 (10MiB).',
    minimum: 1,
  },
} as const;

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  version: '1',
  inputMediaTypes: ['video'],
  outputs: [
    {
      // Text-product protocol, role 'summary': the aggregated
      // time-labeled understanding of the whole video.
      kind: 'file',
      role: 'summary',
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
 * ranges in the assembled understanding. */
function formatClock(totalSeconds: number, withHours: boolean): string {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return withHours ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Outcome of understanding one video segment. */
interface SegmentOutcome {
  text?: string;
  failure?: string;
  degenerated: boolean;
}

class UnderstandVideoSegmentsInvocation extends BaseMediaPolicyToolInvocation<UnderstandVideoSegmentsParams> {
  constructor(
    params: UnderstandVideoSegmentsParams,
    private readonly settingsDefaults: Record<string, unknown>,
    private readonly timeoutMs: number,
  ) {
    super(params);
  }

  getDescription(): string {
    const segmentSeconds =
      this.params.segmentSeconds ??
      UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.segmentSeconds;
    return `Understand ${path.basename(this.params.inputPath)} in ${segmentSeconds}s segments`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const settings = this.settingsDefaults;
    const model =
      this.params.model ??
      readString(settings, 'model') ??
      UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.model;
    const baseUrl =
      this.params.baseUrl ??
      readString(settings, 'baseUrl') ??
      UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.baseUrl;
    const apiKeyEnv =
      this.params.apiKeyEnv ??
      readString(settings, 'apiKeyEnv') ??
      UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.apiKeyEnv;
    const segmentSeconds =
      this.params.segmentSeconds ??
      readNumber(settings, 'segmentSeconds') ??
      UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.segmentSeconds;
    const maxParallelSegments = Math.min(
      Math.floor(
        this.params.maxParallelSegments ??
          readNumber(settings, 'maxParallelSegments') ??
          UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.maxParallelSegments,
      ),
      UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.maxParallelSegments,
    );
    const maxSegmentBytes =
      this.params.maxSegmentBytes ??
      readNumber(settings, 'maxSegmentBytes') ??
      UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.maxSegmentBytes;
    const prompt =
      this.params.prompt ??
      readString(settings, 'prompt') ??
      UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.prompt;

    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) {
        return mediaPolicyToolError(
          `environment variable ${apiKeyEnv} is not set; video understanding is unavailable`,
        );
      }

      // Content recognition (sniff + probe): refuses non-video input and
      // yields the duration the segmentation is planned from. Unlike the
      // ASR/caption tools there is no single-shot fallback here: the tool
      // exists for long video, and a video whose duration cannot be
      // determined cannot be segmented at all.
      const recognized = await recognizeMediaFile(this.params.inputPath, {
        expectedModality: 'video',
        signal,
      });
      const durationSeconds =
        recognized.metadata.durationMs !== undefined &&
        recognized.metadata.durationMs > 0
          ? recognized.metadata.durationMs / 1000
          : undefined;
      if (durationSeconds === undefined) {
        return mediaPolicyToolError(
          'video duration could not be determined; segmented understanding requires a known duration',
        );
      }

      const segmentCount = Math.ceil(durationSeconds / segmentSeconds);
      if (segmentCount > MAX_SEGMENT_COUNT) {
        return mediaPolicyToolError(
          `container claims ${Math.round(durationSeconds)}s of video (${segmentCount} segments of ${segmentSeconds}s, over the ${MAX_SEGMENT_COUNT}-segment ceiling) — implausible for a ${inputSizeBytes}-byte input`,
        );
      }

      const outcomes = await this.understandSegments({
        backend: { model, baseUrl, apiKey, prompt },
        durationSeconds,
        segmentSeconds,
        segmentCount,
        maxParallelSegments,
        maxSegmentBytes,
        signal,
      });
      if (!Array.isArray(outcomes)) {
        return outcomes;
      }

      const withHours = Math.round(durationSeconds) >= 3600;
      const lines: string[] = [];
      let degeneratedSegments = 0;
      let failedSegments = 0;
      for (const [index, outcome] of outcomes.entries()) {
        const start = index * segmentSeconds;
        const end = Math.min(start + segmentSeconds, durationSeconds);
        const range = `[${formatClock(start, withHours)}-${formatClock(end, withHours)}]`;
        if (outcome.text !== undefined) {
          lines.push(`${range} ${outcome.text}`);
          if (outcome.degenerated) degeneratedSegments++;
        } else {
          lines.push(`${range} （该段理解失败：${outcome.failure}）`);
          failedSegments++;
        }
      }
      const summary = lines.join('\n');

      const outputFileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: 'segments',
        extension: '.txt',
      });
      const outputPath = path.join(this.params.outputDir, outputFileName);
      const encoded = Buffer.from(summary, 'utf-8');
      await fs.writeFile(outputPath, encoded);

      const failurePart =
        failedSegments > 0 ? `（${failedSegments} 段失败）` : '';
      const degenerationPart =
        degeneratedSegments > 0
          ? `，${degeneratedSegments} 段检测到重复退化已截断`
          : '';
      const disclosure = `原 ${Math.round(durationSeconds)}s 视频 → 按 ${segmentSeconds}s 分 ${segmentCount} 段并行理解，汇总 ${[...summary].length} 字（${model}）${failurePart}${degenerationPart}，分段为模型理解而非逐帧/逐字内容，细节可能有误`;

      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName,
        artifactKind: 'file',
        title: 'Video segment understanding',
        mimeType: 'text/plain',
        sizeBytes: encoded.length,
        disclosure,
        role: 'summary',
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'TimeoutError' &&
        !signal.aborted
      ) {
        return mediaPolicyToolError(
          `video understanding timed out after ${this.timeoutMs}ms`,
        );
      }
      return mediaPolicyToolFailure(error);
    }
  }

  /**
   * Cut the video into `segmentCount` fixed-length segments and
   * understand them with bounded concurrency (design doc: 并行上限 8).
   * Same failure stance as the ASR/caption tools: individual segment
   * failures become inline markers; the run only errors when EVERY
   * segment failed. All cuts and requests share one wall-clock budget.
   */
  private async understandSegments(options: {
    backend: { model: string; baseUrl: string; apiKey: string; prompt: string };
    durationSeconds: number;
    segmentSeconds: number;
    segmentCount: number;
    maxParallelSegments: number;
    maxSegmentBytes: number;
    signal: AbortSignal;
  }): Promise<ToolResult | SegmentOutcome[]> {
    const { segmentCount, maxParallelSegments, signal } = options;
    const remainingTimeoutMs = createPolicyToolTimeoutBudget(this.timeoutMs);
    const outcomes: SegmentOutcome[] = new Array(segmentCount);

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const index = nextIndex++;
        if (index >= segmentCount) return;
        if (remainingTimeoutMs() <= 1) {
          outcomes[index] = { failure: '时间预算耗尽', degenerated: false };
          continue;
        }
        outcomes[index] = await this.understandSegment({
          ...options,
          index,
          remainingTimeoutMs,
        });
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(maxParallelSegments, segmentCount) },
        worker,
      ),
    );
    if (signal.aborted) {
      return mediaPolicyToolError('video understanding aborted');
    }

    if (outcomes.every((o) => o.text === undefined)) {
      const lastFailure = outcomes[outcomes.length - 1]?.failure ?? 'unknown';
      return mediaPolicyToolError(
        `understanding failed for all ${segmentCount} segments (last: ${lastFailure})`,
      );
    }
    return outcomes;
  }

  /** Cut one segment with ffmpeg, understand it, collapse repetition
   * degeneration, and clean the temporary cut up. Never throws for
   * per-segment problems — they come back as `failure`. */
  private async understandSegment(options: {
    backend: { model: string; baseUrl: string; apiKey: string; prompt: string };
    durationSeconds: number;
    segmentSeconds: number;
    maxSegmentBytes: number;
    index: number;
    remainingTimeoutMs: () => number;
    signal: AbortSignal;
  }): Promise<SegmentOutcome> {
    const {
      backend,
      durationSeconds,
      segmentSeconds,
      maxSegmentBytes,
      index,
      remainingTimeoutMs,
      signal,
    } = options;
    const startSeconds = index * segmentSeconds;
    // Clamp the final segment against the probed duration: container
    // metadata can round up past the real end.
    const lengthSeconds = Math.min(
      segmentSeconds,
      durationSeconds - startSeconds + DURATION_SLACK_SECONDS,
    );
    const segmentPath = path.join(
      this.params.outputDir,
      `segment_${String(index + 1).padStart(4, '0')}.mp4`,
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
          '-vf',
          `scale=-2:${SEGMENT_HEIGHT}`,
          '-c:v',
          'libx264',
          '-b:v',
          `${SEGMENT_VIDEO_BITRATE_KBPS}k`,
          '-preset',
          'veryfast',
          '-c:a',
          'aac',
          '-b:a',
          '32k',
          '-ar',
          '16000',
          '-ac',
          '1',
          '-movflags',
          '+faststart',
          segmentPath,
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

      // Design doc §3.3: 单段大小锁定 ≤10MB — a segment over the inline
      // ceiling is marked failed rather than sent (an oversized base64
      // payload would fail the whole request anyway).
      const segmentBytes = await fs.readFile(segmentPath);
      if (segmentBytes.length > maxSegmentBytes) {
        return {
          failure: `分段重编码后 ${segmentBytes.length} 字节超过 ${maxSegmentBytes} 上限`,
          degenerated: false,
        };
      }
      const dataUri = `data:video/mp4;base64,${segmentBytes.toString('base64')}`;
      const response = await requestOmniChatCompletion({
        ...backend,
        media: [{ type: 'video_url', url: dataUri }],
        timeoutMs: remainingTimeoutMs(),
        signal,
        tool: 'omni_understand_video_segments',
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
      await fs.rm(segmentPath, { force: true }).catch(() => {});
    }
  }
}

/**
 * `omni_understand_video_segments` — long-video segmented understanding
 * (design doc §3.3): the video is cut into fixed-length segments
 * (默认 30s, 5–60s), each re-encoded under the 10MB inline ceiling, and
 * understood by an omni model under the caller's prompt with bounded
 * parallelism (上限 8). The per-segment captions are assembled into one
 * time-labeled summary file artifact (`metadata.omniRole: 'summary'`)
 * plus the mandatory disclosure.
 */
export class OmniUnderstandVideoSegmentsTool extends BaseMediaPolicyTool<UnderstandVideoSegmentsParams> {
  constructor(config: MediaPolicyToolConfigView = {}) {
    super(
      OMNI_UNDERSTAND_VIDEO_SEGMENTS_TOOL_NAME,
      'UnderstandVideoSegments',
      "Understands a long video by cutting it into fixed-length segments (default 30s), re-encoding each under the inline size ceiling, and asking an omni model to describe every segment under the caller's prompt (bounded parallelism), assembling a time-labeled text summary with a disclosure.",
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
    params: UnderstandVideoSegmentsParams,
  ): ToolInvocation<UnderstandVideoSegmentsParams, ToolResult> {
    return new UnderstandVideoSegmentsInvocation(
      params,
      resolvePolicyToolSettings(this.configView, this.name),
      resolvePolicyToolTimeoutMs(this.configView, this.name),
    );
  }
}
