// Force strict mode and setup for ESM
"use strict";
import {
  BaseMediaPolicyTool,
  BaseMediaPolicyToolInvocation,
  MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
  assertMediaPolicyIo,
  ffmpegFailureMessage,
  mediaPolicyToolError,
  mediaPolicyToolFailure,
  mediaPolicyToolSuccess,
  policyOutputFileName,
  resolvePolicyToolTimeoutMs
} from "./chunk-UXEI7POA.js";
import {
  probeMediaMetadata,
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

// packages/core/src/omni/policy/tools/clip-audio.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";
var OMNI_CLIP_AUDIO_TOOL_NAME = ToolNames.OMNI_CLIP_AUDIO;
var CLIP_AUDIO_DEFAULTS = {
  bitrateKbps: 128
};
var OUTPUT_FORMATS = {
  wav: {
    extension: ".wav",
    mimeType: "audio/wav",
    label: "WAV",
    codecArgs: /* @__PURE__ */ __name(() => ["-c:a", "pcm_s16le"], "codecArgs")
  },
  mp3: {
    extension: ".mp3",
    mimeType: "audio/mpeg",
    label: "MP3",
    codecArgs: /* @__PURE__ */ __name((kbps) => ["-c:a", "libmp3lame", "-b:a", `${kbps}k`], "codecArgs")
  },
  m4a: {
    extension: ".m4a",
    mimeType: "audio/mp4",
    label: "M4A",
    codecArgs: /* @__PURE__ */ __name((kbps) => ["-c:a", "aac", "-b:a", `${kbps}k`], "codecArgs")
  }
};
var MIN_DURATION_MS = 1e3;
var TUNABLE_SCHEMA_PROPERTIES = {
  startMs: {
    type: "number",
    description: "Clip start position in milliseconds. Default 0.",
    minimum: 0
  },
  durationMs: {
    type: "number",
    description: "Clip duration in milliseconds (minimum 1000). Default: from startMs to the end.",
    exclusiveMinimum: 0
  },
  format: {
    type: "string",
    enum: ["wav", "mp3", "m4a"],
    description: "Output format: 'wav' (16-bit PCM), 'mp3', or 'm4a' (AAC). Default 'm4a'."
  },
  bitrateKbps: {
    type: "number",
    description: "Output bit rate in kbit/s for mp3/m4a (ignored for wav). Default 128.",
    minimum: 8
  }
};
var DESCRIPTOR = {
  kind: "media_policy",
  // Same versioning rationale as omni_clip_video '2': outputs carry
  // `metadata.omniRole: 'clip'` → memory maps them to `partial` coverage.
  version: "1",
  inputMediaTypes: ["audio"],
  outputs: [
    {
      kind: "media",
      mimeTypes: ["audio/wav", "audio/mpeg", "audio/mp4"],
      required: true,
      lossy: true
    },
    { kind: "text", role: "disclosure", required: true }
  ],
  settingsSchema: {
    type: "object",
    properties: TUNABLE_SCHEMA_PROPERTIES,
    additionalProperties: false
  }
};
function formatMs(ms) {
  return `${Math.round(ms / 100) / 10}s`;
}
__name(formatMs, "formatMs");
var ClipAudioInvocation = class extends BaseMediaPolicyToolInvocation {
  constructor(params, timeoutMs) {
    super(params);
    this.timeoutMs = timeoutMs;
  }
  static {
    __name(this, "ClipAudioInvocation");
  }
  getDescription() {
    const start = this.params.startMs ?? 0;
    const span = this.params.durationMs !== void 0 ? `${formatMs(start)}\u2013${formatMs(start + this.params.durationMs)}` : `${formatMs(start)}\u2013end`;
    return `Clip ${path.basename(this.params.inputPath)} to [${span}]`;
  }
  async execute(signal) {
    const startMs = this.params.startMs ?? 0;
    const durationMs = this.params.durationMs;
    const format = this.params.format ?? "m4a";
    const bitrateKbps = this.params.bitrateKbps ?? CLIP_AUDIO_DEFAULTS.bitrateKbps;
    const output = OUTPUT_FORMATS[format];
    try {
      await assertMediaPolicyIo(this.params);
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        "audio",
        signal
      );
      const totalMs = probe.durationMs;
      if (totalMs !== void 0 && startMs >= totalMs) {
        return mediaPolicyToolError(
          `startMs (${formatMs(startMs)}) is at or beyond the end of the audio (${formatMs(totalMs)})`
        );
      }
      if (totalMs !== void 0 && startMs === 0 && durationMs !== void 0 && durationMs >= totalMs) {
        return mediaPolicyToolError(
          `the requested span [0\u2013${formatMs(durationMs)}] covers the entire audio (${formatMs(totalMs)}) \u2014 a no-op clip that would only re-encode (and damage) the input`
        );
      }
      const outputFileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: "clip",
        variant: durationMs !== void 0 ? `${Math.round(startMs)}ms+${Math.round(durationMs)}ms` : `${Math.round(startMs)}ms-end`,
        extension: output.extension
      });
      const outputPath = path.join(this.params.outputDir, outputFileName);
      const run = await runFfmpeg(
        [
          "-y",
          "-ss",
          (startMs / 1e3).toFixed(3),
          ...durationMs !== void 0 ? ["-t", (durationMs / 1e3).toFixed(3)] : [],
          "-i",
          this.params.inputPath,
          "-vn",
          ...output.codecArgs(bitrateKbps),
          outputPath
        ],
        { signal, timeoutMs: this.timeoutMs }
      );
      if (signal.aborted) {
        return mediaPolicyToolError("audio clipping aborted");
      }
      if (run.code !== 0) {
        return mediaPolicyToolError(
          ffmpegFailureMessage(run, "clipping", this.params.inputPath)
        );
      }
      const outputSizeBytes = (await fs.stat(outputPath)).size;
      const endMs = durationMs !== void 0 ? totalMs !== void 0 ? Math.min(startMs + durationMs, totalMs) : startMs + durationMs : totalMs;
      const original = totalMs !== void 0 ? formatMs(totalMs) : "\u672A\u77E5\u65F6\u957F";
      const endText = endMs !== void 0 ? formatMs(endMs) : "\u7ED3\u5C3E";
      const spanText = endMs !== void 0 ? ` ${formatMs(endMs - startMs)}` : "";
      const disclosure = `\u539F ${original} \u2192 \u7247\u6BB5 [${formatMs(startMs)}\u2013${endText}]${spanText} ${output.label}\uFF0C\u7247\u6BB5\u5916\u5185\u5BB9\u5168\u90E8\u4E22\u5F03`;
      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName,
        artifactKind: "audio",
        title: "Clipped audio",
        mimeType: output.mimeType,
        sizeBytes: outputSizeBytes,
        disclosure,
        // Marks the artifact as a temporal excerpt for downstream role
        // consumers (output routing selectors, memory coverage).
        role: "clip"
      });
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }
};
var OmniClipAudioTool = class extends BaseMediaPolicyTool {
  static {
    __name(this, "OmniClipAudioTool");
  }
  constructor(config) {
    super(
      OMNI_CLIP_AUDIO_TOOL_NAME,
      "ClipAudio",
      "Cuts a time span out of an audio file (sample-accurate re-encode), discarding everything outside the span, with a disclosure of the cut.",
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
  validateToolParamValues(params) {
    const ioError = super.validateToolParamValues(params);
    if (ioError) return ioError;
    if (params.startMs === void 0 && params.durationMs === void 0) {
      return "at least one of startMs / durationMs must be provided";
    }
    if (params.startMs === 0 && params.durationMs === void 0) {
      return "startMs: 0 without durationMs selects the whole audio \u2014 a no-op clip that would only re-encode (and damage) the input";
    }
    if (params.durationMs !== void 0 && params.durationMs < MIN_DURATION_MS) {
      return `durationMs must be at least ${MIN_DURATION_MS} (got ${params.durationMs})`;
    }
    return null;
  }
  createInvocation(params) {
    return new ClipAudioInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.configView, this.name)
    );
  }
};
export {
  CLIP_AUDIO_DEFAULTS,
  OMNI_CLIP_AUDIO_TOOL_NAME,
  OmniClipAudioTool
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
