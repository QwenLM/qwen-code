// Force strict mode and setup for ESM
"use strict";
import {
  BaseMediaPolicyTool,
  BaseMediaPolicyToolInvocation,
  MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
  assertMediaPolicyIo,
  describeChannels,
  ffmpegFailureMessage,
  formatBytesShort,
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

// packages/core/src/omni/policy/tools/extract-audio.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";
var OMNI_EXTRACT_AUDIO_TOOL_NAME = ToolNames.OMNI_EXTRACT_AUDIO;
var EXTRACT_AUDIO_DEFAULTS = {
  format: "wav",
  sampleRateHz: 16e3,
  channels: 1,
  bitrateKbps: 64
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
var TUNABLE_SCHEMA_PROPERTIES = {
  format: {
    type: "string",
    enum: ["wav", "mp3", "m4a"],
    description: "Output format: 'wav' (16-bit PCM), 'mp3', or 'm4a' (AAC). Default 'wav'."
  },
  sampleRateHz: {
    type: "number",
    description: "Output sample rate in Hz. Default 16000.",
    minimum: 8e3
  },
  channels: {
    type: "number",
    description: "Output channel count. Default 1 (mono).",
    minimum: 1,
    maximum: 2
  },
  bitrateKbps: {
    type: "number",
    description: "Output bit rate in kbit/s for mp3/m4a (ignored for wav). Default 64.",
    minimum: 8
  }
};
var DESCRIPTOR = {
  kind: "media_policy",
  version: "1",
  inputMediaTypes: ["video"],
  outputs: [
    {
      kind: "media",
      // One spec, three possible containers: the orchestrator matches the
      // recognized mime against this list (mapping doc §6.1).
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
var ExtractAudioInvocation = class extends BaseMediaPolicyToolInvocation {
  constructor(params, timeoutMs) {
    super(params);
    this.timeoutMs = timeoutMs;
  }
  static {
    __name(this, "ExtractAudioInvocation");
  }
  getDescription() {
    const format = this.params.format ?? EXTRACT_AUDIO_DEFAULTS.format;
    return `Extract ${format.toUpperCase()} audio track from ${path.basename(this.params.inputPath)}`;
  }
  async execute(signal) {
    const format = this.params.format ?? EXTRACT_AUDIO_DEFAULTS.format;
    const sampleRateHz = this.params.sampleRateHz ?? EXTRACT_AUDIO_DEFAULTS.sampleRateHz;
    const channels = this.params.channels ?? EXTRACT_AUDIO_DEFAULTS.channels;
    const bitrateKbps = this.params.bitrateKbps ?? EXTRACT_AUDIO_DEFAULTS.bitrateKbps;
    const output = OUTPUT_FORMATS[format];
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        "video",
        signal
      );
      const outputFileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: "audio",
        extension: output.extension
      });
      const outputPath = path.join(this.params.outputDir, outputFileName);
      const run = await runFfmpeg(
        [
          "-y",
          "-i",
          this.params.inputPath,
          // Drop the video stream entirely — the audio track is the output.
          "-vn",
          ...output.codecArgs(bitrateKbps),
          "-ar",
          String(sampleRateHz),
          "-ac",
          String(channels),
          outputPath
        ],
        { signal, timeoutMs: this.timeoutMs }
      );
      if (signal.aborted) {
        return mediaPolicyToolError("audio extraction aborted");
      }
      if (run.code !== 0) {
        return mediaPolicyToolError(
          ffmpegFailureMessage(
            run,
            "extracting audio from",
            this.params.inputPath
          )
        );
      }
      const outputSizeBytes = (await fs.stat(outputPath)).size;
      const originalDuration = probe.durationMs !== void 0 ? `${Math.round(probe.durationMs / 1e3)}s/` : "";
      const disclosure = `\u539F\u89C6\u9891 ${originalDuration}${formatBytesShort(inputSizeBytes)} \u2192 \u97F3\u8F68 ${output.label}/${Math.round(sampleRateHz / 1e3)}kHz${describeChannels(channels)}\uFF0C\u89C6\u89C9\u4FE1\u606F\u5168\u90E8\u4E22\u5F03`;
      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName,
        artifactKind: "audio",
        title: "Extracted audio track",
        mimeType: output.mimeType,
        sizeBytes: outputSizeBytes,
        disclosure
      });
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }
};
var OmniExtractAudioTool = class extends BaseMediaPolicyTool {
  static {
    __name(this, "OmniExtractAudioTool");
  }
  constructor(config) {
    super(
      OMNI_EXTRACT_AUDIO_TOOL_NAME,
      "ExtractAudio",
      "Extracts the audio track from a video into WAV/MP3/M4A, discarding the visual stream, with a disclosure of the loss.",
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
    return new ExtractAudioInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.configView, this.name)
    );
  }
};
export {
  EXTRACT_AUDIO_DEFAULTS,
  OMNI_EXTRACT_AUDIO_TOOL_NAME,
  OmniExtractAudioTool
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
