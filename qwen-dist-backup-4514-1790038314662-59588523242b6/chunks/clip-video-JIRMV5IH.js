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
  policyOutputStem,
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

// packages/core/src/omni/policy/tools/clip-video.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";
var OMNI_CLIP_VIDEO_TOOL_NAME = ToolNames.OMNI_CLIP_VIDEO;
var DEFAULT_CLIP_SOFT_BUDGET = 3;
var CLIP_VIDEO_DEFAULTS = {
  crf: 23,
  preset: "veryfast"
};
var TUNABLE_SCHEMA_PROPERTIES = {
  startSec: {
    type: "number",
    description: "Clip start position in seconds. Default 0.",
    minimum: 0
  },
  durationSec: {
    type: "number",
    description: "Clip duration in seconds. Default: from startSec to the end.",
    exclusiveMinimum: 0
  },
  softClipBudget: {
    type: "number",
    description: "Positive integer clip count that triggers the soft stop reminder. Default 3.",
    minimum: 1,
    multipleOf: 1
  }
};
var DESCRIPTOR = {
  kind: "media_policy",
  // '3': clips retain their source audio. Pre-'3' cached clips are
  // video-only and cannot be reused under the new media contract.
  version: "3",
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
  },
  operatorOnlyParams: ["softClipBudget"]
};
function formatSeconds(seconds) {
  return `${Math.round(seconds * 10) / 10}s`;
}
__name(formatSeconds, "formatSeconds");
var ClipVideoInvocation = class extends BaseMediaPolicyToolInvocation {
  constructor(params, timeoutMs, softBudget) {
    super(params);
    this.timeoutMs = timeoutMs;
    this.softBudget = softBudget;
  }
  static {
    __name(this, "ClipVideoInvocation");
  }
  getDescription() {
    const start = this.params.startSec ?? 0;
    const span = this.params.durationSec !== void 0 ? `${formatSeconds(start)}\u2013${formatSeconds(start + this.params.durationSec)}` : `${formatSeconds(start)}\u2013end`;
    return `Clip ${path.basename(this.params.inputPath)} to [${span}]`;
  }
  async execute(signal) {
    const startSec = this.params.startSec ?? 0;
    const durationSec = this.params.durationSec;
    try {
      await assertMediaPolicyIo(this.params);
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        "video",
        signal
      );
      const totalSeconds = probe.durationMs !== void 0 ? probe.durationMs / 1e3 : void 0;
      if (totalSeconds !== void 0 && startSec >= totalSeconds) {
        return mediaPolicyToolError(
          `startSec (${formatSeconds(startSec)}) is at or beyond the end of the video (${formatSeconds(totalSeconds)})`
        );
      }
      if (totalSeconds !== void 0 && startSec === 0 && durationSec !== void 0 && durationSec >= totalSeconds) {
        return mediaPolicyToolError(
          `the requested span [0\u2013${formatSeconds(durationSec)}] covers the entire video (${formatSeconds(totalSeconds)}) \u2014 a no-op clip that would only re-encode (and damage) the input`
        );
      }
      const outputFileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: "clip",
        variant: durationSec !== void 0 ? `${Math.round(startSec)}s+${Math.round(durationSec)}s` : `${Math.round(startSec)}s-end`,
        extension: ".mp4"
      });
      const outputPath = path.join(this.params.outputDir, outputFileName);
      const run = await runFfmpeg(
        [
          "-y",
          "-ss",
          String(startSec),
          ...durationSec !== void 0 ? ["-t", String(durationSec)] : [],
          "-i",
          this.params.inputPath,
          "-vf",
          "scale=trunc(iw/2)*2:trunc(ih/2)*2",
          "-c:v",
          "libx264",
          "-crf",
          String(CLIP_VIDEO_DEFAULTS.crf),
          "-preset",
          CLIP_VIDEO_DEFAULTS.preset,
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-movflags",
          "+faststart",
          outputPath
        ],
        { signal, timeoutMs: this.timeoutMs }
      );
      if (signal.aborted) {
        return mediaPolicyToolError("video clipping aborted");
      }
      if (run.code !== 0) {
        return mediaPolicyToolError(
          ffmpegFailureMessage(run, "clipping", this.params.inputPath)
        );
      }
      const outputSizeBytes = (await fs.stat(outputPath)).size;
      const endSec = durationSec !== void 0 ? totalSeconds !== void 0 ? Math.min(startSec + durationSec, totalSeconds) : startSec + durationSec : totalSeconds;
      const original = totalSeconds !== void 0 ? formatSeconds(totalSeconds) : "\u672A\u77E5\u65F6\u957F";
      const endText = endSec !== void 0 ? formatSeconds(endSec) : "\u7ED3\u5C3E";
      const spanText = endSec !== void 0 ? ` ${formatSeconds(endSec - startSec)}` : "";
      const disclosure = `\u539F ${original} \u2192 \u7247\u6BB5 [${formatSeconds(startSec)}\u2013${endText}]${spanText}\uFF0C\u4FDD\u7559\u753B\u9762\uFF0C\u6E90\u97F3\u8F68\u5982\u5B58\u5728\u5219\u4E00\u5E76\u4FDD\u7559\uFF0C\u7247\u6BB5\u5916\u5185\u5BB9\u5168\u90E8\u4E22\u5F03`;
      const success = mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName,
        artifactKind: "video",
        title: "Clipped video",
        mimeType: "video/mp4",
        sizeBytes: outputSizeBytes,
        disclosure,
        // Marks the artifact as a temporal excerpt for downstream role
        // consumers (output routing selectors, memory coverage).
        role: "clip"
      });
      let clipBrake = "";
      try {
        const prefix = `${policyOutputStem(this.params.inputPath)}-clip-`;
        const clipCount = (await fs.readdir(this.params.outputDir)).filter(
          (f) => f.startsWith(prefix) && f.endsWith(".mp4")
        ).length;
        if (clipCount >= this.softBudget) {
          clipBrake = `\u3002\u5DF2\u5BF9\u8BE5\u89C6\u9891\u5207\u4E86 ${clipCount} \u6BB5\uFF1A\u7EE7\u7EED\u9010\u6BB5\u76F2\u626B\u901A\u5E38\u4E0D\u518D\u63D0\u5347\u5224\u65AD\u3001\u53EA\u589E\u5F00\u9500\u3002\u8BF7\u57FA\u4E8E\u5DF2\u770B\u7247\u6BB5\u4F5C\u7B54\uFF1B\u82E5\u4ECD\u9700\u5B9A\u4F4D\u67D0\u4E2A\u753B\u9762\uFF0C\u5148\u7528 omni_extract_keyframes\uFF08strategy='uniform'\u3001startSec\u3001endSec\uFF09\u5728\u7591\u4F3C\u533A\u95F4\u52A0\u5BC6\u62BD\u5E27\u9501\u5B9A\uFF0C\u518D\u7CBE\u51C6\u5207 1 \u6BB5\uFF0C\u4E0D\u8981\u7EE7\u7EED\u8BD5\u5207`;
        }
      } catch {
      }
      return {
        ...success,
        llmContent: `${success.llmContent}\u3002\u7528 read_file \u6253\u5F00 ${outputPath} \u67E5\u770B\u8BE5\u7247\u6BB5${clipBrake}`
      };
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }
};
var OmniClipVideoTool = class extends BaseMediaPolicyTool {
  static {
    __name(this, "OmniClipVideoTool");
  }
  constructor(config) {
    super(
      OMNI_CLIP_VIDEO_TOOL_NAME,
      "ClipVideo",
      "Cuts a time span out of a video (frame-accurate re-encode), discarding everything outside the span, with a disclosure of the cut.",
      "other" /* Other */,
      {
        type: "object",
        properties: {
          ...MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
          // outputDir is optional for clip: when omitted it defaults to the
          // source video's own directory (see validateToolParamValues). The
          // model was otherwise guessing a path — a wrong guess like
          // `<dir>/clips` failed the call with "output directory not found"
          // and burned a turn.
          outputDir: {
            type: "string",
            description: "Optional absolute directory to write the clip into; when provided it must already exist (it is not created automatically). Defaults to the source video's own directory when omitted."
          },
          ...TUNABLE_SCHEMA_PROPERTIES
        },
        additionalProperties: false
      },
      config
    );
  }
  get mediaPolicyDescriptor() {
    return DESCRIPTOR;
  }
  validateToolParamValues(params) {
    if (params.outputDir === void 0 && typeof params.inputPath === "string" && params.inputPath.length > 0) {
      params.outputDir = path.dirname(params.inputPath);
    }
    const ioError = super.validateToolParamValues(params);
    if (ioError) return ioError;
    if (params.startSec === void 0 && params.durationSec === void 0) {
      return "at least one of startSec / durationSec must be provided";
    }
    if (params.startSec === 0 && params.durationSec === void 0) {
      return "startSec: 0 without durationSec selects the whole video \u2014 a no-op clip that would only re-encode (and damage) the input";
    }
    return null;
  }
  createInvocation(params) {
    return new ClipVideoInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.configView, this.name),
      params.softClipBudget ?? this.resolveSoftBudget()
    );
  }
  /** `policyTools.omni_clip_video.settings.softClipBudget` (positive int),
   * else {@link DEFAULT_CLIP_SOFT_BUDGET}. */
  resolveSoftBudget() {
    const entry = this.configView.getOmniPolicyToolsSettings?.()?.[this.name];
    const settings = entry && typeof entry === "object" ? entry["settings"] : void 0;
    const raw = settings && typeof settings === "object" ? settings["softClipBudget"] : void 0;
    return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_CLIP_SOFT_BUDGET;
  }
};
export {
  CLIP_VIDEO_DEFAULTS,
  DEFAULT_CLIP_SOFT_BUDGET,
  OMNI_CLIP_VIDEO_TOOL_NAME,
  OmniClipVideoTool
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
