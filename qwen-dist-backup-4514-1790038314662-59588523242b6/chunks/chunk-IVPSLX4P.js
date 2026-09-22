// Force strict mode and setup for ESM
"use strict";
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
import {
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/policy/tools/transcribe-audio.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";

// packages/core/src/omni/policy/tools/usage-log.ts
init_esbuild_shims();
import { appendFileSync } from "node:fs";
function appendOmniUsageLog(model, usage, tool) {
  const usageLogPath = process.env["OMNI_USAGE_LOG"];
  if (!usageLogPath || !usage) return;
  const cachedInputTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? null;
  try {
    appendFileSync(
      usageLogPath,
      JSON.stringify({
        model,
        ...tool !== void 0 ? { tool } : {},
        inputTokens: usage.prompt_tokens ?? null,
        outputTokens: usage.completion_tokens ?? null,
        totalTokens: usage.total_tokens ?? null,
        cachedInputTokens,
        ts: Date.now()
      }) + "\n"
    );
  } catch {
  }
}
__name(appendOmniUsageLog, "appendOmniUsageLog");

// packages/core/src/omni/policy/tools/transcribe-audio.ts
var OMNI_TRANSCRIBE_AUDIO_TOOL_NAME = ToolNames.OMNI_TRANSCRIBE_AUDIO;
var TRANSCRIBE_AUDIO_DEFAULTS = {
  model: "qwen3.5-omni-plus",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKeyEnv: "DASHSCOPE_API_KEY",
  maxInputBytes: 10 * 1024 * 1024,
  chunkSeconds: 180
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
  language: {
    type: "string",
    description: 'Optional language hint for the transcription (e.g. "zh", "en").'
  },
  model: {
    type: "string",
    description: "ASR model id. Default 'qwen3.5-omni-plus'."
  },
  baseUrl: {
    type: "string",
    description: "OpenAI-compatible endpoint base URL the transcription request is sent to. Defaults to the DashScope compatible-mode endpoint."
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
    description: "Audio longer than this is split into segments of this length and each segment is transcribed separately (per-segment time ranges are prefixed to the text). Default 180.",
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
      // Transcript protocol (policy design §6.2): a non-media file
      // artifact — strict UTF-8 text/plain with
      // `metadata.omniRole: 'transcript'` — delivered as a text Part.
      kind: "file",
      role: "transcript",
      mimeTypes: ["text/plain"],
      required: true,
      // Uniform lossy declaration (mapping doc §6.1): tone, timbre and
      // non-speech information are lost, and recognition may err.
      lossy: true
    },
    { kind: "text", role: "disclosure", required: true }
  ],
  settingsSchema: {
    type: "object",
    properties: TUNABLE_SCHEMA_PROPERTIES,
    additionalProperties: false
  },
  // Endpoint + credential selection must stay operator-controlled: a
  // gated caller choosing both `apiKeyEnv` and `baseUrl` could point any
  // environment secret (e.g. OPENAI_API_KEY) at an attacker-controlled
  // host. They remain configurable via policyTools settings and
  // modelAccess default/lockedArguments (operator surfaces), and stay in
  // the params schema because fixed-policy `arguments` and settings
  // defaults are merged into tool args under
  // `additionalProperties: false`.
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
function parseSseCompletion(body) {
  let transcript = "";
  let usage;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "[DONE]") break;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    const content = chunk.choices?.[0]?.delta?.content;
    if (typeof content === "string") transcript += content;
    if (chunk.usage) usage = chunk.usage;
  }
  return { text: transcript, usage };
}
__name(parseSseCompletion, "parseSseCompletion");
function parseSseTranscript(body) {
  return parseSseCompletion(body).text;
}
__name(parseSseTranscript, "parseSseTranscript");
var REPETITION_MIN_REPS = 8;
var REPETITION_MIN_SPAN = 24;
var REPETITION_MAX_UNIT = 64;
function collapseRepetitionDegeneration(text) {
  let best;
  for (let unitLen = 1; unitLen <= REPETITION_MAX_UNIT; unitLen++) {
    if (unitLen * REPETITION_MIN_REPS > text.length) break;
    const unit = text.slice(text.length - unitLen);
    if (unit.trim().length === 0) continue;
    let reps = 1;
    while ((reps + 1) * unitLen <= text.length && text.startsWith(unit, text.length - (reps + 1) * unitLen)) {
      reps++;
    }
    if (reps >= REPETITION_MIN_REPS && reps * unitLen >= REPETITION_MIN_SPAN && (best === void 0 || reps * unitLen > best.reps * best.unitLen)) {
      best = { unitLen, reps };
    }
  }
  if (best === void 0) {
    return { text, degenerated: false };
  }
  return {
    text: text.slice(0, text.length - best.unitLen * (best.reps - 1)).trimEnd(),
    degenerated: true
  };
}
__name(collapseRepetitionDegeneration, "collapseRepetitionDegeneration");
function formatClock(totalSeconds, withHours) {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return withHours ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
__name(formatClock, "formatClock");
var TranscribeAudioInvocation = class extends BaseMediaPolicyToolInvocation {
  constructor(params, settingsDefaults, timeoutMs) {
    super(params);
    this.settingsDefaults = settingsDefaults;
    this.timeoutMs = timeoutMs;
  }
  static {
    __name(this, "TranscribeAudioInvocation");
  }
  getDescription() {
    return `Transcribe ${path.basename(this.params.inputPath)} to text`;
  }
  async execute(signal) {
    const settings = this.settingsDefaults;
    const model = this.params.model ?? readString(settings, "model") ?? TRANSCRIBE_AUDIO_DEFAULTS.model;
    const baseUrl = this.params.baseUrl ?? readString(settings, "baseUrl") ?? TRANSCRIBE_AUDIO_DEFAULTS.baseUrl;
    const apiKeyEnv = this.params.apiKeyEnv ?? readString(settings, "apiKeyEnv") ?? TRANSCRIBE_AUDIO_DEFAULTS.apiKeyEnv;
    const maxInputBytes = this.params.maxInputBytes ?? readNumber(settings, "maxInputBytes") ?? TRANSCRIBE_AUDIO_DEFAULTS.maxInputBytes;
    const chunkSeconds = this.params.chunkSeconds ?? readNumber(settings, "chunkSeconds") ?? TRANSCRIBE_AUDIO_DEFAULTS.chunkSeconds;
    const language = this.params.language ?? readString(settings, "language");
    const prompt = "\u8BF7\u9010\u5B57\u8F6C\u5199\u8FD9\u6BB5\u97F3\u9891\u7684\u5185\u5BB9\uFF0C\u53EA\u8F93\u51FA\u8F6C\u5199\u6587\u672C\uFF0C\u4E0D\u8981\u6DFB\u52A0\u4EFB\u4F55\u89E3\u91CA\u3002" + (language ? `\u97F3\u9891\u8BED\u8A00\uFF1A${language}\u3002` : "");
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      if (inputSizeBytes > maxInputBytes) {
        return mediaPolicyToolError(
          `input audio is ${inputSizeBytes} bytes, over the ${maxInputBytes}-byte transcription limit`
        );
      }
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) {
        return mediaPolicyToolError(
          `environment variable ${apiKeyEnv} is not set; transcription is unavailable`
        );
      }
      const recognized = await recognizeMediaFile(this.params.inputPath, {
        expectedModality: "audio",
        signal
      });
      const format = INPUT_AUDIO_FORMATS[recognized.detectedMimeType];
      if (!format) {
        return mediaPolicyToolError(
          `audio container ${recognized.detectedMimeType} is not supported by ${OMNI_TRANSCRIBE_AUDIO_TOOL_NAME}`
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
      let transcript;
      let degeneratedSegments = 0;
      let failedSegments = 0;
      if (durationSeconds !== void 0 && segmentCount > 1) {
        const chunked = await this.transcribeChunked({
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
            lines.push(`${range} \uFF08\u8BE5\u6BB5\u8F6C\u5199\u5931\u8D25\uFF1A${outcome.failure}\uFF09`);
            failedSegments++;
          }
        }
        transcript = lines.join("\n");
      } else {
        const bytes = await fs.readFile(this.params.inputPath);
        const dataUri = `data:${recognized.detectedMimeType};base64,${bytes.toString("base64")}`;
        const response = await this.requestTranscription({
          ...backend,
          dataUri,
          format,
          timeoutMs: this.timeoutMs,
          signal
        });
        if (!response.ok) {
          return mediaPolicyToolError(
            `transcription request failed: ${response.error}`
          );
        }
        const collapsed = collapseRepetitionDegeneration(response.text);
        transcript = collapsed.text;
        if (collapsed.degenerated) degeneratedSegments = 1;
        if (!transcript) {
          return mediaPolicyToolError("transcription returned empty text");
        }
      }
      const outputPath = path.join(
        this.params.outputDir,
        policyOutputFileName({
          inputPath: this.params.inputPath,
          operation: "transcript",
          extension: ".txt"
        })
      );
      const encoded = Buffer.from(transcript, "utf-8");
      await fs.writeFile(outputPath, encoded);
      const durationPart = durationSeconds !== void 0 ? `${Math.round(durationSeconds)}s ` : "";
      const segmentPart = segmentCount > 1 ? `\u5206 ${segmentCount} \u6BB5\u8F6C\u5199\u6587\u672C` : "\u8F6C\u5199\u6587\u672C";
      const failurePart = failedSegments > 0 ? `\uFF08${failedSegments} \u6BB5\u5931\u8D25\uFF09` : "";
      const degenerationPart = degeneratedSegments > 0 ? `\uFF0C${segmentCount > 1 ? `${degeneratedSegments} \u6BB5` : ""}\u68C0\u6D4B\u5230\u91CD\u590D\u9000\u5316\u5DF2\u622A\u65AD` : "";
      const disclosure = `\u539F ${durationPart}\u97F3\u9891 \u2192 ${segmentPart} ${[...transcript].length} \u5B57${failurePart}${degenerationPart}\uFF0C\u8BED\u6C14/\u97F3\u8272/\u975E\u8BED\u97F3\u4FE1\u606F\u4E22\u5931\uFF0C\u8BC6\u522B\u53EF\u80FD\u6709\u8BEF`;
      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName: policyOutputFileName({
          inputPath: this.params.inputPath,
          operation: "transcript",
          extension: ".txt"
        }),
        artifactKind: "file",
        title: "Audio transcript",
        mimeType: "text/plain",
        sizeBytes: encoded.length,
        disclosure,
        role: "transcript"
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError" && !signal.aborted) {
        return mediaPolicyToolError(
          `transcription timed out after ${this.timeoutMs}ms`
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
  async transcribeChunked(options) {
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
        outcomes[index] = await this.transcribeChunk({
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
      return mediaPolicyToolError("transcription aborted");
    }
    if (outcomes.every((o) => o.text === void 0)) {
      const lastFailure = outcomes[outcomes.length - 1]?.failure ?? "unknown";
      return mediaPolicyToolError(
        `transcription failed for all ${segmentCount} segments (last: ${lastFailure})`
      );
    }
    return outcomes;
  }
  /** Cut one segment with ffmpeg, transcribe it, collapse repetition
   * degeneration, and clean the temporary cut up. Never throws for
   * per-segment problems — they come back as `failure`. */
  async transcribeChunk(options) {
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
      const response = await this.requestTranscription({
        ...backend,
        dataUri,
        format: "m4a",
        timeoutMs: remainingTimeoutMs(),
        signal
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
  /** One streaming chat.completions ASR request. DashScope
   * compatible-mode omni models only support streaming — stream:true and
   * SSE assembly of delta.content (mapping doc §6.1). Non-2xx statuses
   * come back as `HTTP <status>` only: raw upstream bodies must not
   * reach model-visible content. */
  async requestTranscription(options) {
    const requestSignal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(options.timeoutMs)
    ]);
    const response = await fetch(
      `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: options.model,
          modalities: ["text"],
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "input_audio",
                  input_audio: {
                    data: options.dataUri,
                    format: options.format
                  }
                },
                { type: "text", text: options.prompt }
              ]
            }
          ]
        }),
        signal: requestSignal
      }
    );
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const { text, usage } = parseSseCompletion(await response.text());
    appendOmniUsageLog(options.model, usage, "omni_transcribe_audio");
    return { ok: true, text: text.trim() };
  }
};
var OmniTranscribeAudioTool = class extends BaseMediaPolicyTool {
  static {
    __name(this, "OmniTranscribeAudioTool");
  }
  constructor(config = {}) {
    super(
      OMNI_TRANSCRIBE_AUDIO_TOOL_NAME,
      "TranscribeAudio",
      "Transcribes an audio file to text via the qwen3.5-omni ASR backend (long audio is split into time-labeled segments), discarding tone, timbre and non-speech information, with a disclosure of the loss.",
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
    return new TranscribeAudioInvocation(
      params,
      resolvePolicyToolSettings(this.configView, this.name),
      resolvePolicyToolTimeoutMs(this.configView, this.name)
    );
  }
};

export {
  appendOmniUsageLog,
  OMNI_TRANSCRIBE_AUDIO_TOOL_NAME,
  TRANSCRIBE_AUDIO_DEFAULTS,
  parseSseCompletion,
  parseSseTranscript,
  collapseRepetitionDegeneration,
  OmniTranscribeAudioTool
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
