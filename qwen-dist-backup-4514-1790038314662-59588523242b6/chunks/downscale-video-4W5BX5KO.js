// Force strict mode and setup for ESM
"use strict";
import {
  BaseMediaPolicyTool,
  BaseMediaPolicyToolInvocation,
  MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
  assertMediaPolicyIo,
  createPolicyToolTimeoutBudget,
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

// packages/core/src/omni/policy/tools/downscale-video.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";
var OMNI_DOWNSCALE_VIDEO_TOOL_NAME = ToolNames.OMNI_DOWNSCALE_VIDEO;
var DOWNSCALE_VIDEO_DEFAULTS = {
  maxHeight: 480,
  fps: 10,
  crf: 28,
  preset: "veryfast"
};
var X264_PRESETS = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow"
];
var TUNABLE_SCHEMA_PROPERTIES = {
  maxHeight: {
    type: "number",
    description: "Output height ceiling in pixels (width follows aspect ratio). Default 480.",
    minimum: 2
  },
  fps: {
    type: "number",
    description: "Output frame rate. Fractional rates (e.g. 0.5 = one frame every 2s) are supported. Default 10.",
    // Fractional floor: the server-side billing of omni video is per
    // SAMPLED FRAME, so sub-1fps rates are the effective degradation
    // lever for long clips (reactive server-limit fallback ladder).
    minimum: 0.01
  },
  crf: {
    type: "number",
    description: "x264 constant rate factor, 0-51 (higher = smaller/lossier). Default 28.",
    minimum: 0,
    maximum: 51
  },
  preset: {
    type: "string",
    description: 'x264 encoding preset. Default "veryfast".',
    enum: [...X264_PRESETS]
  }
};
var DESCRIPTOR = {
  kind: "media_policy",
  version: "1",
  inputMediaTypes: ["video"],
  outputs: [
    {
      kind: "media",
      mimeTypes: ["video/mp4"],
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
var DownscaleVideoInvocation = class extends BaseMediaPolicyToolInvocation {
  constructor(params, timeoutMs) {
    super(params);
    this.timeoutMs = timeoutMs;
  }
  static {
    __name(this, "DownscaleVideoInvocation");
  }
  getDescription() {
    const maxHeight = this.params.maxHeight ?? DOWNSCALE_VIDEO_DEFAULTS.maxHeight;
    return `Downscale ${path.basename(this.params.inputPath)} to ${maxHeight}p`;
  }
  async execute(signal) {
    const maxHeight = this.params.maxHeight ?? DOWNSCALE_VIDEO_DEFAULTS.maxHeight;
    const fps = this.params.fps ?? DOWNSCALE_VIDEO_DEFAULTS.fps;
    const crf = this.params.crf ?? DOWNSCALE_VIDEO_DEFAULTS.crf;
    const preset = this.params.preset ?? DOWNSCALE_VIDEO_DEFAULTS.preset;
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        "video",
        signal
      );
      if (probe.height === void 0) {
        return mediaPolicyToolError(
          `could not determine video height of ${path.basename(this.params.inputPath)}`
        );
      }
      const targetHeight = Math.max(
        2,
        Math.floor(Math.min(maxHeight, probe.height) / 2) * 2
      );
      const outputPath = path.join(
        this.params.outputDir,
        policyOutputFileName({
          inputPath: this.params.inputPath,
          operation: "downscaled",
          extension: ".mp4"
        })
      );
      const argsFor = /* @__PURE__ */ __name((audio) => [
        "-y",
        "-i",
        this.params.inputPath,
        "-vf",
        `scale=-2:${targetHeight},fps=${fps}`,
        "-c:v",
        "libx264",
        "-crf",
        String(crf),
        "-preset",
        preset,
        ...audio,
        outputPath
      ], "argsFor");
      const remainingTimeoutMs = createPolicyToolTimeoutBudget(this.timeoutMs);
      let run = await runFfmpeg(argsFor(["-c:a", "copy"]), {
        signal,
        timeoutMs: remainingTimeoutMs()
      });
      if (signal.aborted) {
        return mediaPolicyToolError("video downscaling aborted");
      }
      if (run.code !== 0) {
        run = await runFfmpeg(argsFor(["-c:a", "aac", "-b:a", "64k"]), {
          signal,
          timeoutMs: remainingTimeoutMs()
        });
        if (signal.aborted) {
          return mediaPolicyToolError("video downscaling aborted");
        }
        if (run.code !== 0) {
          return mediaPolicyToolError(
            ffmpegFailureMessage(run, "downscaling", this.params.inputPath)
          );
        }
      }
      const outputSizeBytes = (await fs.stat(outputPath)).size;
      const originalRate = probe.frameRate !== void 0 ? Math.round(probe.frameRate) : "?";
      const drops = [
        ...targetHeight < probe.height ? ["\u5206\u8FA8\u7387\u4E0B\u964D"] : [],
        ...probe.frameRate !== void 0 && fps < probe.frameRate ? ["\u5E27\u7387\u4E0B\u964D"] : []
      ];
      const lossClause = drops.length === 2 ? "\u5206\u8FA8\u7387\u4E0E\u5E27\u7387\u4E0B\u964D" : drops[0] ?? "\u91CD\u65B0\u7F16\u7801\u538B\u7F29";
      const disclosure = `\u539F ${probe.height}p${originalRate}/${formatBytesShort(inputSizeBytes)} \u2192 ${targetHeight}p${fps}/${formatBytesShort(outputSizeBytes)}\uFF0C${lossClause}\uFF0C\u7EC6\u8282\u53D7\u635F`;
      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName: policyOutputFileName({
          inputPath: this.params.inputPath,
          operation: "downscaled",
          extension: ".mp4"
        }),
        artifactKind: "video",
        title: "Downscaled video",
        mimeType: "video/mp4",
        sizeBytes: outputSizeBytes,
        disclosure
      });
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }
};
var OmniDownscaleVideoTool = class extends BaseMediaPolicyTool {
  static {
    __name(this, "OmniDownscaleVideoTool");
  }
  constructor(config) {
    super(
      OMNI_DOWNSCALE_VIDEO_TOOL_NAME,
      "DownscaleVideo",
      "Downscales a video to a maximum height and frame rate and re-encodes it, producing a smaller lossy derivative with a disclosure of the degradation.",
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
    return new DownscaleVideoInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.configView, this.name)
    );
  }
};
export {
  DOWNSCALE_VIDEO_DEFAULTS,
  OMNI_DOWNSCALE_VIDEO_TOOL_NAME,
  OmniDownscaleVideoTool
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
