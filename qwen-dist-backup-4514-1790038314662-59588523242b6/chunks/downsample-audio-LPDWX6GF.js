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

// packages/core/src/omni/policy/tools/downsample-audio.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";
var OMNI_DOWNSAMPLE_AUDIO_TOOL_NAME = ToolNames.OMNI_DOWNSAMPLE_AUDIO;
var DOWNSAMPLE_AUDIO_DEFAULTS = {
  bitrateKbps: 64,
  sampleRateHz: 16e3,
  channels: 1
};
var TUNABLE_SCHEMA_PROPERTIES = {
  bitrateKbps: {
    type: "number",
    description: "Output bit rate in kbit/s. Default 64.",
    minimum: 8
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
  }
};
var DESCRIPTOR = {
  kind: "media_policy",
  version: "1",
  inputMediaTypes: ["audio"],
  outputs: [
    {
      kind: "media",
      mimeTypes: ["audio/mp4"],
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
var DownsampleAudioInvocation = class extends BaseMediaPolicyToolInvocation {
  constructor(params, timeoutMs) {
    super(params);
    this.timeoutMs = timeoutMs;
  }
  static {
    __name(this, "DownsampleAudioInvocation");
  }
  getDescription() {
    const bitrateKbps = this.params.bitrateKbps ?? DOWNSAMPLE_AUDIO_DEFAULTS.bitrateKbps;
    return `Downsample ${path.basename(this.params.inputPath)} to ${bitrateKbps}kbps`;
  }
  async execute(signal) {
    const requestedBitrateKbps = this.params.bitrateKbps ?? DOWNSAMPLE_AUDIO_DEFAULTS.bitrateKbps;
    const requestedSampleRateHz = this.params.sampleRateHz ?? DOWNSAMPLE_AUDIO_DEFAULTS.sampleRateHz;
    const requestedChannels = this.params.channels ?? DOWNSAMPLE_AUDIO_DEFAULTS.channels;
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        "audio",
        signal
      );
      const bitrateKbps = probe.bitRate !== void 0 ? Math.min(requestedBitrateKbps, Math.ceil(probe.bitRate / 1e3)) : requestedBitrateKbps;
      const sampleRateHz = probe.sampleRateHz !== void 0 ? Math.min(requestedSampleRateHz, probe.sampleRateHz) : requestedSampleRateHz;
      const channels = probe.channels !== void 0 ? Math.min(requestedChannels, probe.channels) : requestedChannels;
      const outputPath = path.join(
        this.params.outputDir,
        policyOutputFileName({
          inputPath: this.params.inputPath,
          operation: "downsampled",
          extension: ".m4a"
        })
      );
      const run = await runFfmpeg(
        [
          "-y",
          "-i",
          this.params.inputPath,
          // Audio-only output: a cover-art video stream would otherwise be
          // carried along (and can even fail the m4a mux).
          "-vn",
          "-c:a",
          "aac",
          "-b:a",
          `${bitrateKbps}k`,
          "-ar",
          String(sampleRateHz),
          "-ac",
          String(channels),
          outputPath
        ],
        { signal, timeoutMs: this.timeoutMs }
      );
      if (signal.aborted) {
        return mediaPolicyToolError("audio downsampling aborted");
      }
      if (run.code !== 0) {
        return mediaPolicyToolError(
          ffmpegFailureMessage(run, "downsampling", this.params.inputPath)
        );
      }
      const outputSizeBytes = (await fs.stat(outputPath)).size;
      const originalBitrate = probe.bitRate !== void 0 ? `${Math.round(probe.bitRate / 1e3)}kbps` : formatBytesShort(inputSizeBytes);
      const originalRate = probe.sampleRateHz !== void 0 ? `/${Math.round(probe.sampleRateHz / 1e3)}kHz` : "";
      const drops = [];
      if (probe.bitRate !== void 0 && bitrateKbps < Math.ceil(probe.bitRate / 1e3) || probe.sampleRateHz !== void 0 && sampleRateHz < probe.sampleRateHz) {
        drops.push("\u9AD8\u9891\u7EC6\u8282\u4E22\u5931");
      }
      if (probe.channels !== void 0 && channels < probe.channels) {
        drops.push("\u58F0\u9053\u5408\u5E76");
      }
      const lossNote = drops.length > 0 ? drops.join("\uFF0C") : "\u91CD\u65B0\u7F16\u7801\u538B\u7F29";
      const disclosure = `\u539F ${originalBitrate}${originalRate}${describeChannels(probe.channels)} \u2192 ${bitrateKbps}kbps/${Math.round(sampleRateHz / 1e3)}kHz${describeChannels(channels)}\uFF0C${lossNote}`;
      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName: policyOutputFileName({
          inputPath: this.params.inputPath,
          operation: "downsampled",
          extension: ".m4a"
        }),
        artifactKind: "audio",
        title: "Downsampled audio",
        mimeType: "audio/mp4",
        sizeBytes: outputSizeBytes,
        disclosure
      });
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }
};
var OmniDownsampleAudioTool = class extends BaseMediaPolicyTool {
  static {
    __name(this, "OmniDownsampleAudioTool");
  }
  constructor(config) {
    super(
      OMNI_DOWNSAMPLE_AUDIO_TOOL_NAME,
      "DownsampleAudio",
      "Downsamples an audio file to a lower bit rate, sample rate, and channel count, producing a smaller lossy derivative with a disclosure of the degradation.",
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
    return new DownsampleAudioInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.configView, this.name)
    );
  }
};
export {
  DOWNSAMPLE_AUDIO_DEFAULTS,
  OMNI_DOWNSAMPLE_AUDIO_TOOL_NAME,
  OmniDownsampleAudioTool
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
