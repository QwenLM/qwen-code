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

// packages/core/src/omni/policy/tools/caption-audio.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";
var OMNI_CAPTION_AUDIO_TOOL_NAME = ToolNames.OMNI_CAPTION_AUDIO;
var CAPTION_AUDIO_DEFAULTS = {
  model: "qwen3.5-omni-plus",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKeyEnv: "DASHSCOPE_API_KEY",
  maxInputBytes: 10 * 1024 * 1024,
  chunkSeconds: 180,
  prompt: "\u8BF7\u63CF\u8FF0\u8FD9\u6BB5\u97F3\u9891\u7684\u5185\u5BB9\uFF0C\u5305\u62EC\u8BED\u97F3\u5927\u610F\u3001\u8BF4\u8BDD\u4EBA\u97F3\u8272\u3001\u80CC\u666F\u58F0\u97F3\u4E8B\u4EF6\u4E0E\u60C5\u7EEA\u6C1B\u56F4\u3002"
};
var CHUNK_CONCURRENCY = 3;
var MAX_SEGMENT_COUNT = 512;
var CHUNK_AUDIO_ARGS = [
  "-vn",
  "-c:a",
  "aac",
  "-b:a",
  "32k",
  "-ar",
  "16000",
  "-ac",
  "1"
];
var INPUT_AUDIO_FORMATS = {
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a"
};
var TUNABLE_SCHEMA_PROPERTIES = {
  prompt: {
    type: "string",
    description: "Understanding instruction the caption is written to (e.g. what aspects to describe: speech gist, timbre, sound events, mood). Default: a general semantic description."
  },
  model: {
    type: "string",
    description: "Omni understanding model id. Default 'qwen3.5-omni-plus'."
  },
  baseUrl: {
    type: "string",
    description: "OpenAI-compatible endpoint base URL the request is sent to. Defaults to the DashScope compatible-mode endpoint."
  },
  apiKeyEnv: {
    type: "string",
    description: "Environment variable holding the API key for the endpoint. Default 'DASHSCOPE_API_KEY'."
  },
  maxInputBytes: {
    type: "number",
    description: "Maximum input audio size in bytes. Default 10485760 (10MiB).",
    minimum: 1
  },
  chunkSeconds: {
    type: "number",
    description: "Audio longer than this is split into segments of this length and each segment is described separately (per-segment time ranges are prefixed to the text). Default 180.",
    minimum: 30,
    maximum: 1800
  }
};
var DESCRIPTOR = {
  kind: "media_policy",
  version: "1",
  inputMediaTypes: ["audio"],
  outputs: [
    {
      // Text-product protocol, role 'caption' (memory role enum预留,
      // M §5.5). Unlike a transcript this is NOT verbatim speech: it is
      // the model's semantic description (timbre, events, mood included).
      kind: "file",
      role: "caption",
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
var CaptionAudioInvocation = class extends BaseMediaPolicyToolInvocation {
  constructor(params, settingsDefaults, timeoutMs) {
    super(params);
    this.settingsDefaults = settingsDefaults;
    this.timeoutMs = timeoutMs;
  }
  static {
    __name(this, "CaptionAudioInvocation");
  }
  getDescription() {
    return `Describe ${path.basename(this.params.inputPath)} with an omni model`;
  }
  async execute(signal) {
    const settings = this.settingsDefaults;
    const model = this.params.model ?? readString(settings, "model") ?? CAPTION_AUDIO_DEFAULTS.model;
    const baseUrl = this.params.baseUrl ?? readString(settings, "baseUrl") ?? CAPTION_AUDIO_DEFAULTS.baseUrl;
    const apiKeyEnv = this.params.apiKeyEnv ?? readString(settings, "apiKeyEnv") ?? CAPTION_AUDIO_DEFAULTS.apiKeyEnv;
    const maxInputBytes = this.params.maxInputBytes ?? readNumber(settings, "maxInputBytes") ?? CAPTION_AUDIO_DEFAULTS.maxInputBytes;
    const chunkSeconds = this.params.chunkSeconds ?? readNumber(settings, "chunkSeconds") ?? CAPTION_AUDIO_DEFAULTS.chunkSeconds;
    const prompt = this.params.prompt ?? readString(settings, "prompt") ?? CAPTION_AUDIO_DEFAULTS.prompt;
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      if (inputSizeBytes > maxInputBytes) {
        return mediaPolicyToolError(
          `input audio is ${inputSizeBytes} bytes, over the ${maxInputBytes}-byte caption limit`
        );
      }
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) {
        return mediaPolicyToolError(
          `environment variable ${apiKeyEnv} is not set; audio captioning is unavailable`
        );
      }
      const recognized = await recognizeMediaFile(this.params.inputPath, {
        expectedModality: "audio",
        signal
      });
      const format = INPUT_AUDIO_FORMATS[recognized.detectedMimeType];
      if (!format) {
        return mediaPolicyToolError(
          `audio container ${recognized.detectedMimeType} is not supported by ${OMNI_CAPTION_AUDIO_TOOL_NAME}`
        );
      }
      const durationSeconds = recognized.metadata.durationMs !== void 0 && recognized.metadata.durationMs > 0 ? recognized.metadata.durationMs / 1e3 : void 0;
      const backend = { model, baseUrl, apiKey, prompt };
      const segmentCount = durationSeconds !== void 0 ? Math.ceil(durationSeconds / chunkSeconds) : 1;
      if (segmentCount > MAX_SEGMENT_COUNT) {
        return mediaPolicyToolError(
          `container claims ${Math.round(durationSeconds ?? 0)}s of audio (${segmentCount} segments of ${chunkSeconds}s, over the ${MAX_SEGMENT_COUNT}-segment ceiling) \u2014 implausible for a ${inputSizeBytes}-byte input`
        );
      }
      let caption;
      let degeneratedSegments = 0;
      let failedSegments = 0;
      if (durationSeconds !== void 0 && segmentCount > 1) {
        const chunked = await this.captionChunked({
          backend,
          durationSeconds,
          segmentCount,
          signal
        });
        if (!Array.isArray(chunked)) {
          return chunked;
        }
        const withHours = Math.round(durationSeconds) >= 3600;
        const lines = [];
        const segmentLength = durationSeconds / segmentCount;
        for (const [index, outcome] of chunked.entries()) {
          const range = `[${formatClock(index * segmentLength, withHours)}-${formatClock(Math.min((index + 1) * segmentLength, durationSeconds), withHours)}]`;
          if (outcome.text !== void 0) {
            lines.push(`${range} ${outcome.text}`);
            if (outcome.degenerated) degeneratedSegments++;
          } else {
            lines.push(`${range} \uFF08\u8BE5\u6BB5\u7406\u89E3\u5931\u8D25\uFF1A${outcome.failure}\uFF09`);
            failedSegments++;
          }
        }
        caption = lines.join("\n");
      } else {
        const bytes = await fs.readFile(this.params.inputPath);
        const dataUri = `data:${recognized.detectedMimeType};base64,${bytes.toString("base64")}`;
        const response = await requestOmniChatCompletion({
          ...backend,
          media: [{ type: "input_audio", data: dataUri, format }],
          timeoutMs: this.timeoutMs,
          signal,
          tool: "omni_caption_audio"
        });
        if (!response.ok) {
          return mediaPolicyToolError(
            `caption request failed: ${response.error}`
          );
        }
        const collapsed = collapseRepetitionDegeneration(response.text);
        caption = collapsed.text;
        if (collapsed.degenerated) degeneratedSegments = 1;
        if (!caption) {
          return mediaPolicyToolError("caption request returned empty text");
        }
      }
      const outputFileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: "caption",
        extension: ".txt"
      });
      const outputPath = path.join(this.params.outputDir, outputFileName);
      const encoded = Buffer.from(caption, "utf-8");
      await fs.writeFile(outputPath, encoded);
      const durationPart = durationSeconds !== void 0 ? `${Math.round(durationSeconds)}s ` : "";
      const segmentPart = segmentCount > 1 ? `\u5206 ${segmentCount} \u6BB5\u8BED\u4E49\u63CF\u8FF0` : "\u8BED\u4E49\u63CF\u8FF0";
      const failurePart = failedSegments > 0 ? `\uFF08${failedSegments} \u6BB5\u5931\u8D25\uFF09` : "";
      const degenerationPart = degeneratedSegments > 0 ? `\uFF0C${segmentCount > 1 ? `${degeneratedSegments} \u6BB5` : ""}\u68C0\u6D4B\u5230\u91CD\u590D\u9000\u5316\u5DF2\u622A\u65AD` : "";
      const disclosure = `\u539F ${durationPart}\u97F3\u9891 \u2192 ${segmentPart} ${[...caption].length} \u5B57\uFF08${model}\uFF09${failurePart}${degenerationPart}\uFF0C\u4E3A\u6A21\u578B\u7406\u89E3\u800C\u975E\u9010\u5B57\u5185\u5BB9\uFF0C\u7EC6\u8282\u53EF\u80FD\u6709\u8BEF`;
      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName,
        artifactKind: "file",
        title: "Audio caption",
        mimeType: "text/plain",
        sizeBytes: encoded.length,
        disclosure,
        role: "caption"
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError" && !signal.aborted) {
        return mediaPolicyToolError(
          `caption request timed out after ${this.timeoutMs}ms`
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
  async captionChunked(options) {
    const { backend, durationSeconds, segmentCount, signal } = options;
    const segmentLength = durationSeconds / segmentCount;
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
        outcomes[index] = await this.captionChunk({
          backend,
          index,
          startSeconds: index * segmentLength,
          lengthSeconds: segmentLength,
          remainingTimeoutMs,
          signal
        });
      }
    }, "worker");
    await Promise.all(
      Array.from({ length: Math.min(CHUNK_CONCURRENCY, segmentCount) }, worker)
    );
    if (signal.aborted) {
      return mediaPolicyToolError("audio captioning aborted");
    }
    if (outcomes.every((o) => o.text === void 0)) {
      const lastFailure = outcomes[outcomes.length - 1]?.failure ?? "unknown";
      return mediaPolicyToolError(
        `captioning failed for all ${segmentCount} segments (last: ${lastFailure})`
      );
    }
    return outcomes;
  }
  /** Cut one segment with ffmpeg, caption it, collapse repetition
   * degeneration, and clean the temporary cut up. Never throws for
   * per-segment problems — they come back as `failure`. */
  async captionChunk(options) {
    const {
      backend,
      index,
      startSeconds,
      lengthSeconds,
      remainingTimeoutMs,
      signal
    } = options;
    const chunkPath = path.join(
      this.params.outputDir,
      `chunk_${String(index + 1).padStart(4, "0")}.m4a`
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
          ...CHUNK_AUDIO_ARGS,
          chunkPath
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
      const bytes = await fs.readFile(chunkPath);
      const dataUri = `data:audio/mp4;base64,${bytes.toString("base64")}`;
      const response = await requestOmniChatCompletion({
        ...backend,
        media: [{ type: "input_audio", data: dataUri, format: "m4a" }],
        timeoutMs: remainingTimeoutMs(),
        signal,
        tool: "omni_caption_audio"
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
      await fs.rm(chunkPath, { force: true }).catch(() => {
      });
    }
  }
};
var OmniCaptionAudioTool = class extends BaseMediaPolicyTool {
  static {
    __name(this, "OmniCaptionAudioTool");
  }
  constructor(config = {}) {
    super(
      OMNI_CAPTION_AUDIO_TOOL_NAME,
      "CaptionAudio",
      "Generates a semantic text description of an audio file with an omni model under the caller's prompt \u2014 speech gist, timbre, sound events, mood (long audio is split into time-labeled segments) \u2014 with a disclosure that it is an interpretation, not verbatim content.",
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
    return new CaptionAudioInvocation(
      params,
      resolvePolicyToolSettings(this.configView, this.name),
      resolvePolicyToolTimeoutMs(this.configView, this.name)
    );
  }
};
export {
  CAPTION_AUDIO_DEFAULTS,
  OMNI_CAPTION_AUDIO_TOOL_NAME,
  OmniCaptionAudioTool
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
