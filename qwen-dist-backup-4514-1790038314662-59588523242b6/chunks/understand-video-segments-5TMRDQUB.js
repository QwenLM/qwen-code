// Force strict mode and setup for ESM
"use strict";
import {
  requestOmniChatCompletion
} from "./chunk-WL2V7PTE.js";
import {
  collapseRepetitionDegeneration
} from "./chunk-IVPSLX4P.js";
import {
  BaseMediaPolicyTool,
  BaseMediaPolicyToolInvocation,
  MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
  assertMediaPolicyIo,
  createPolicyToolTimeoutBudget,
  mediaPolicyToolError,
  mediaPolicyToolFailure,
  mediaPolicyToolSuccess,
  policyOutputFileName,
  resolvePolicyToolSettings,
  resolvePolicyToolTimeoutMs
} from "./chunk-UXEI7POA.js";
import {
  recognizeMediaFile
} from "./chunk-S5BHLTHK.js";
import {
  runFfmpeg
} from "./chunk-KSEKRQJO.js";
import "./chunk-MNU36NGH.js";
import "./chunk-BQMSZSG6.js";
import "./chunk-VPGRGNNH.js";
import {
  ToolNames
} from "./chunk-ERIBG3BX.js";
import "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/policy/tools/understand-video-segments.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";
var OMNI_UNDERSTAND_VIDEO_SEGMENTS_TOOL_NAME = ToolNames.OMNI_UNDERSTAND_VIDEO_SEGMENTS;
var UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS = {
  model: "qwen3.5-omni-plus",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKeyEnv: "DASHSCOPE_API_KEY",
  segmentSeconds: 30,
  maxParallelSegments: 8,
  maxSegmentBytes: 10 * 1024 * 1024,
  prompt: "\u8BF7\u63CF\u8FF0\u8FD9\u6BB5\u89C6\u9891\u7247\u6BB5\u7684\u5185\u5BB9\uFF0C\u5305\u62EC\u753B\u9762\u4E8B\u4EF6\u3001\u4EBA\u7269\u52A8\u4F5C\u4E0E\u8BED\u97F3\u5927\u610F\u3002"
};
var MAX_SEGMENT_COUNT = 512;
var SEGMENT_HEIGHT = 360;
var SEGMENT_VIDEO_BITRATE_KBPS = 450;
var DURATION_SLACK_SECONDS = 0.25;
var TUNABLE_SCHEMA_PROPERTIES = {
  prompt: {
    type: "string",
    description: "Understanding instruction applied to every segment (what to describe: visual events, actions, speech gist). Default: a general segment description."
  },
  model: {
    type: "string",
    description: "Omni understanding model id. Default 'qwen3.5-omni-plus'."
  },
  baseUrl: {
    type: "string",
    description: "OpenAI-compatible endpoint base URL the requests are sent to. Defaults to the DashScope compatible-mode endpoint."
  },
  apiKeyEnv: {
    type: "string",
    description: "Environment variable holding the API key for the endpoint. Default 'DASHSCOPE_API_KEY'."
  },
  segmentSeconds: {
    type: "number",
    description: "Fixed segment length in seconds: the video is cut into segments of this length and each is understood separately. Default 30.",
    minimum: 5,
    maximum: 60
  },
  maxParallelSegments: {
    type: "number",
    description: "Maximum segments understood concurrently. Default 8.",
    minimum: 1,
    maximum: 8
  },
  maxSegmentBytes: {
    type: "number",
    description: "Maximum size in bytes of one re-encoded segment sent to the model. Default 10485760 (10MiB).",
    minimum: 1
  }
};
var DESCRIPTOR = {
  kind: "media_policy",
  version: "1",
  inputMediaTypes: ["video"],
  outputs: [
    {
      // Text-product protocol, role 'summary': the aggregated
      // time-labeled understanding of the whole video.
      kind: "file",
      role: "summary",
      mimeTypes: ["text/plain"],
      required: true,
      lossy: true
    },
    { kind: "text", role: "disclosure", required: true }
  ],
  settingsSchema: {
    type: "object",
    properties: TUNABLE_SCHEMA_PROPERTIES,
    additionalProperties: false
  },
  // Endpoint + credential selection stays operator-controlled (same
  // rationale as omni_transcribe_audio).
  operatorOnlyParams: ["baseUrl", "apiKeyEnv"]
};
var readString = /* @__PURE__ */ __name((settings, key) => {
  const value = settings[key];
  return typeof value === "string" && value.length > 0 ? value : void 0;
}, "readString");
var readNumber = /* @__PURE__ */ __name((settings, key) => {
  const value = settings[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}, "readNumber");
function formatClock(totalSeconds, withHours) {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return withHours ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
__name(formatClock, "formatClock");
var UnderstandVideoSegmentsInvocation = class extends BaseMediaPolicyToolInvocation {
  constructor(params, settingsDefaults, timeoutMs) {
    super(params);
    this.settingsDefaults = settingsDefaults;
    this.timeoutMs = timeoutMs;
  }
  static {
    __name(this, "UnderstandVideoSegmentsInvocation");
  }
  getDescription() {
    const segmentSeconds = this.params.segmentSeconds ?? UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.segmentSeconds;
    return `Understand ${path.basename(this.params.inputPath)} in ${segmentSeconds}s segments`;
  }
  async execute(signal) {
    const settings = this.settingsDefaults;
    const model = this.params.model ?? readString(settings, "model") ?? UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.model;
    const baseUrl = this.params.baseUrl ?? readString(settings, "baseUrl") ?? UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.baseUrl;
    const apiKeyEnv = this.params.apiKeyEnv ?? readString(settings, "apiKeyEnv") ?? UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.apiKeyEnv;
    const segmentSeconds = this.params.segmentSeconds ?? readNumber(settings, "segmentSeconds") ?? UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.segmentSeconds;
    const maxParallelSegments = Math.min(
      Math.floor(
        this.params.maxParallelSegments ?? readNumber(settings, "maxParallelSegments") ?? UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.maxParallelSegments
      ),
      UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.maxParallelSegments
    );
    const maxSegmentBytes = this.params.maxSegmentBytes ?? readNumber(settings, "maxSegmentBytes") ?? UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.maxSegmentBytes;
    const prompt = this.params.prompt ?? readString(settings, "prompt") ?? UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.prompt;
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) {
        return mediaPolicyToolError(
          `environment variable ${apiKeyEnv} is not set; video understanding is unavailable`
        );
      }
      const recognized = await recognizeMediaFile(this.params.inputPath, {
        expectedModality: "video",
        signal
      });
      const durationSeconds = recognized.metadata.durationMs !== void 0 && recognized.metadata.durationMs > 0 ? recognized.metadata.durationMs / 1e3 : void 0;
      if (durationSeconds === void 0) {
        return mediaPolicyToolError(
          "video duration could not be determined; segmented understanding requires a known duration"
        );
      }
      const segmentCount = Math.ceil(durationSeconds / segmentSeconds);
      if (segmentCount > MAX_SEGMENT_COUNT) {
        return mediaPolicyToolError(
          `container claims ${Math.round(durationSeconds)}s of video (${segmentCount} segments of ${segmentSeconds}s, over the ${MAX_SEGMENT_COUNT}-segment ceiling) \u2014 implausible for a ${inputSizeBytes}-byte input`
        );
      }
      const outcomes = await this.understandSegments({
        backend: { model, baseUrl, apiKey, prompt },
        durationSeconds,
        segmentSeconds,
        segmentCount,
        maxParallelSegments,
        maxSegmentBytes,
        signal
      });
      if (!Array.isArray(outcomes)) {
        return outcomes;
      }
      const withHours = Math.round(durationSeconds) >= 3600;
      const lines = [];
      let degeneratedSegments = 0;
      let failedSegments = 0;
      for (const [index, outcome] of outcomes.entries()) {
        const start = index * segmentSeconds;
        const end = Math.min(start + segmentSeconds, durationSeconds);
        const range = `[${formatClock(start, withHours)}-${formatClock(end, withHours)}]`;
        if (outcome.text !== void 0) {
          lines.push(`${range} ${outcome.text}`);
          if (outcome.degenerated) degeneratedSegments++;
        } else {
          lines.push(`${range} \uFF08\u8BE5\u6BB5\u7406\u89E3\u5931\u8D25\uFF1A${outcome.failure}\uFF09`);
          failedSegments++;
        }
      }
      const summary = lines.join("\n");
      const outputFileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: "segments",
        extension: ".txt"
      });
      const outputPath = path.join(this.params.outputDir, outputFileName);
      const encoded = Buffer.from(summary, "utf-8");
      await fs.writeFile(outputPath, encoded);
      const failurePart = failedSegments > 0 ? `\uFF08${failedSegments} \u6BB5\u5931\u8D25\uFF09` : "";
      const degenerationPart = degeneratedSegments > 0 ? `\uFF0C${degeneratedSegments} \u6BB5\u68C0\u6D4B\u5230\u91CD\u590D\u9000\u5316\u5DF2\u622A\u65AD` : "";
      const disclosure = `\u539F ${Math.round(durationSeconds)}s \u89C6\u9891 \u2192 \u6309 ${segmentSeconds}s \u5206 ${segmentCount} \u6BB5\u5E76\u884C\u7406\u89E3\uFF0C\u6C47\u603B ${[...summary].length} \u5B57\uFF08${model}\uFF09${failurePart}${degenerationPart}\uFF0C\u5206\u6BB5\u4E3A\u6A21\u578B\u7406\u89E3\u800C\u975E\u9010\u5E27/\u9010\u5B57\u5185\u5BB9\uFF0C\u7EC6\u8282\u53EF\u80FD\u6709\u8BEF`;
      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName,
        artifactKind: "file",
        title: "Video segment understanding",
        mimeType: "text/plain",
        sizeBytes: encoded.length,
        disclosure,
        role: "summary"
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError" && !signal.aborted) {
        return mediaPolicyToolError(
          `video understanding timed out after ${this.timeoutMs}ms`
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
  async understandSegments(options) {
    const { segmentCount, maxParallelSegments, signal } = options;
    const remainingTimeoutMs = createPolicyToolTimeoutBudget(this.timeoutMs);
    const outcomes = new Array(segmentCount);
    let nextIndex = 0;
    const worker = /* @__PURE__ */ __name(async () => {
      while (!signal.aborted) {
        const index = nextIndex++;
        if (index >= segmentCount) return;
        if (remainingTimeoutMs() <= 1) {
          outcomes[index] = { failure: "\u65F6\u95F4\u9884\u7B97\u8017\u5C3D", degenerated: false };
          continue;
        }
        outcomes[index] = await this.understandSegment({
          ...options,
          index,
          remainingTimeoutMs
        });
      }
    }, "worker");
    await Promise.all(
      Array.from(
        { length: Math.min(maxParallelSegments, segmentCount) },
        worker
      )
    );
    if (signal.aborted) {
      return mediaPolicyToolError("video understanding aborted");
    }
    if (outcomes.every((o) => o.text === void 0)) {
      const lastFailure = outcomes[outcomes.length - 1]?.failure ?? "unknown";
      return mediaPolicyToolError(
        `understanding failed for all ${segmentCount} segments (last: ${lastFailure})`
      );
    }
    return outcomes;
  }
  /** Cut one segment with ffmpeg, understand it, collapse repetition
   * degeneration, and clean the temporary cut up. Never throws for
   * per-segment problems — they come back as `failure`. */
  async understandSegment(options) {
    const {
      backend,
      durationSeconds,
      segmentSeconds,
      maxSegmentBytes,
      index,
      remainingTimeoutMs,
      signal
    } = options;
    const startSeconds = index * segmentSeconds;
    const lengthSeconds = Math.min(
      segmentSeconds,
      durationSeconds - startSeconds + DURATION_SLACK_SECONDS
    );
    const segmentPath = path.join(
      this.params.outputDir,
      `segment_${String(index + 1).padStart(4, "0")}.mp4`
    );
    try {
      const cut = await runFfmpeg(
        [
          "-y",
          "-ss",
          startSeconds.toFixed(3),
          "-t",
          lengthSeconds.toFixed(3),
          "-i",
          this.params.inputPath,
          "-vf",
          `scale=-2:${SEGMENT_HEIGHT}`,
          "-c:v",
          "libx264",
          "-b:v",
          `${SEGMENT_VIDEO_BITRATE_KBPS}k`,
          "-preset",
          "veryfast",
          "-c:a",
          "aac",
          "-b:a",
          "32k",
          "-ar",
          "16000",
          "-ac",
          "1",
          "-movflags",
          "+faststart",
          segmentPath
        ],
        { signal, timeoutMs: remainingTimeoutMs() }
      );
      if (signal.aborted) {
        return { failure: "aborted", degenerated: false };
      }
      if (cut.code !== 0) {
        return {
          failure: `\u5207\u7247\u5931\u8D25\uFF08ffmpeg exit ${cut.code}\uFF09`,
          degenerated: false
        };
      }
      const segmentBytes = await fs.readFile(segmentPath);
      if (segmentBytes.length > maxSegmentBytes) {
        return {
          failure: `\u5206\u6BB5\u91CD\u7F16\u7801\u540E ${segmentBytes.length} \u5B57\u8282\u8D85\u8FC7 ${maxSegmentBytes} \u4E0A\u9650`,
          degenerated: false
        };
      }
      const dataUri = `data:video/mp4;base64,${segmentBytes.toString("base64")}`;
      const response = await requestOmniChatCompletion({
        ...backend,
        media: [{ type: "video_url", url: dataUri }],
        timeoutMs: remainingTimeoutMs(),
        signal,
        tool: "omni_understand_video_segments"
      });
      if (!response.ok) {
        return { failure: response.error, degenerated: false };
      }
      const collapsed = collapseRepetitionDegeneration(response.text);
      if (!collapsed.text) {
        return { failure: "\u8FD4\u56DE\u7A7A\u6587\u672C", degenerated: false };
      }
      return { text: collapsed.text, degenerated: collapsed.degenerated };
    } catch (error) {
      if (signal.aborted) {
        return { failure: "aborted", degenerated: false };
      }
      if (error instanceof Error && error.name === "TimeoutError") {
        return { failure: "\u8BF7\u6C42\u8D85\u65F6", degenerated: false };
      }
      return {
        failure: error instanceof Error ? error.message : String(error),
        degenerated: false
      };
    } finally {
      await fs.rm(segmentPath, { force: true }).catch(() => {
      });
    }
  }
};
var OmniUnderstandVideoSegmentsTool = class extends BaseMediaPolicyTool {
  static {
    __name(this, "OmniUnderstandVideoSegmentsTool");
  }
  constructor(config = {}) {
    super(
      OMNI_UNDERSTAND_VIDEO_SEGMENTS_TOOL_NAME,
      "UnderstandVideoSegments",
      "Understands a long video by cutting it into fixed-length segments (default 30s), re-encoding each under the inline size ceiling, and asking an omni model to describe every segment under the caller's prompt (bounded parallelism), assembling a time-labeled text summary with a disclosure.",
      "other" /* Other */,
      {
        type: "object",
        properties: {
          ...MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
          ...TUNABLE_SCHEMA_PROPERTIES
        },
        required: ["outputDir"],
        additionalProperties: false
      },
      config
    );
  }
  get mediaPolicyDescriptor() {
    return DESCRIPTOR;
  }
  createInvocation(params) {
    return new UnderstandVideoSegmentsInvocation(
      params,
      resolvePolicyToolSettings(this.configView, this.name),
      resolvePolicyToolTimeoutMs(this.configView, this.name)
    );
  }
};
export {
  OMNI_UNDERSTAND_VIDEO_SEGMENTS_TOOL_NAME,
  OmniUnderstandVideoSegmentsTool,
  UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
