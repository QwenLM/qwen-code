// Force strict mode and setup for ESM
"use strict";
import {
  videoFrameDimensionsForTokenBudget
} from "./chunk-PF3RVYRK.js";
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
  policyOutputFileName,
  resolvePolicyToolSettings,
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

// packages/core/src/omni/policy/tools/extract-keyframes.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";
var OMNI_EXTRACT_KEYFRAMES_TOOL_NAME = ToolNames.OMNI_EXTRACT_KEYFRAMES;
var EXTRACT_KEYFRAMES_DEFAULTS = {
  maxFrames: 8,
  sceneThreshold: 0.2,
  maxDimension: 768,
  strategy: "scene",
  fps: 1
};
function readTier(settings) {
  const value = settings["frameTokenBudget"];
  return value === "small" || value === "normal" || value === "large" ? value : void 0;
}
__name(readTier, "readTier");
function readStrategy(settings) {
  const value = settings["strategy"];
  return value === "scene" || value === "uniform" ? value : void 0;
}
__name(readStrategy, "readStrategy");
function readNumber(settings, key) {
  const value = settings[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
__name(readNumber, "readNumber");
function readNonNegativeNumber(settings, key) {
  const value = settings[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
__name(readNonNegativeNumber, "readNonNegativeNumber");
function frameFileMatcher(nameTemplate) {
  const escaped = nameTemplate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace("%04d", "(\\d{4})")}$`);
}
__name(frameFileMatcher, "frameFileMatcher");
var TUNABLE_SCHEMA_PROPERTIES = {
  maxFrames: {
    type: "number",
    description: "Maximum number of frames to extract. Default 8.",
    minimum: 1,
    maximum: 64
  },
  sceneThreshold: {
    type: "number",
    description: "Scene-change threshold (0-1) for keyframe selection. Default 0.2.",
    minimum: 0,
    maximum: 1
  },
  maxDimension: {
    type: "number",
    description: "Longest-edge ceiling in pixels for the extracted frames (aspect ratio preserved, never enlarged). Default 768.",
    minimum: 16
  },
  strategy: {
    type: "string",
    enum: ["scene", "uniform"],
    description: "Frame-selection strategy: 'scene' (default; per-bucket scene detection with midpoint fallback) or 'uniform' (duration-adaptive even sampling at a dynamic fps \u2014 the lever for long videos, whose metered cost is frames\xD7pixels)."
  },
  fps: {
    type: "number",
    description: "Uniform strategy only: target frames per second; the frame count is clamp(duration \xD7 fps, 1, maxFrames). Default 1.",
    exclusiveMinimum: 0,
    maximum: 10
  },
  startSec: {
    type: "number",
    description: "Uniform strategy only: sampling window start in seconds. Default 0.",
    minimum: 0
  },
  endSec: {
    type: "number",
    description: "Uniform strategy only: sampling window end in seconds. Default: the video's end.",
    exclusiveMinimum: 0
  },
  frameTokenBudget: {
    type: "string",
    enum: ["small", "normal", "large"],
    description: "Per-frame token-budget tier ('small'/'normal'/'large' = 80/256/1024 visual tokens): frames are resized onto the model patch grid inside the tier's pixel budget. Overrides maxDimension for frame sizing."
  }
};
var DESCRIPTOR = {
  kind: "media_policy",
  // '2': outputs now carry `metadata.omniRole: 'keyframe'`, which memory
  // maps to `sampled` coverage. Pre-'2' cache entries and recorded
  // executions hold role-less outputs whose coverage was derived as
  // `complete`; sharing a version would let them converge onto the same
  // fingerprint and keep reporting sampled frames as complete visual
  // coverage — the model would answer about footage it never saw.
  version: "2",
  inputMediaTypes: ["video"],
  outputs: [
    {
      kind: "media",
      mimeTypes: ["image/jpeg"],
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
function scaleFilter(maxDimension) {
  return `scale='min(${maxDimension},iw)':'min(${maxDimension},ih)':force_original_aspect_ratio=decrease`;
}
__name(scaleFilter, "scaleFilter");
function parseShowinfoTimestamps(stderr) {
  const timestamps = [];
  const pattern = /\bn:\s*\d+.*?\bpts_time:(-?[\d.]+)/g;
  for (const match of stderr.matchAll(pattern)) {
    const t = Number(match[1]);
    timestamps.push(Number.isFinite(t) && t >= 0 ? t : NaN);
  }
  return timestamps;
}
__name(parseShowinfoTimestamps, "parseShowinfoTimestamps");
async function listFrameFiles(outputDir, nameTemplate) {
  const matcher = frameFileMatcher(nameTemplate);
  const entries = await fs.readdir(outputDir);
  return entries.filter((name) => matcher.test(name)).sort();
}
__name(listFrameFiles, "listFrameFiles");
var SCENE_SEARCH_WINDOW_SECONDS = 30;
function formatSeconds(seconds) {
  return seconds.toFixed(3);
}
__name(formatSeconds, "formatSeconds");
function formatClock(totalSeconds, withHours) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return withHours ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
__name(formatClock, "formatClock");
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
__name(fileExists, "fileExists");
var SEEK_CONCURRENCY = 4;
var ExtractKeyframesInvocation = class extends BaseMediaPolicyToolInvocation {
  constructor(params, settingsDefaults, timeoutMs) {
    super(params);
    this.settingsDefaults = settingsDefaults;
    this.timeoutMs = timeoutMs;
  }
  static {
    __name(this, "ExtractKeyframesInvocation");
  }
  getDescription() {
    const maxFrames = this.params.maxFrames ?? EXTRACT_KEYFRAMES_DEFAULTS.maxFrames;
    return `Extract up to ${maxFrames} keyframes from ${path.basename(this.params.inputPath)}`;
  }
  async execute(signal) {
    const settings = this.settingsDefaults;
    const maxFrames = Math.floor(
      this.params.maxFrames ?? readNumber(settings, "maxFrames") ?? EXTRACT_KEYFRAMES_DEFAULTS.maxFrames
    );
    const sceneThreshold = this.params.sceneThreshold ?? readNonNegativeNumber(settings, "sceneThreshold") ?? EXTRACT_KEYFRAMES_DEFAULTS.sceneThreshold;
    const maxDimension = this.params.maxDimension ?? readNumber(settings, "maxDimension") ?? EXTRACT_KEYFRAMES_DEFAULTS.maxDimension;
    const strategy = this.params.strategy ?? readStrategy(settings) ?? EXTRACT_KEYFRAMES_DEFAULTS.strategy;
    const fps = this.params.fps ?? readNumber(settings, "fps") ?? EXTRACT_KEYFRAMES_DEFAULTS.fps;
    const startSec = this.params.startSec ?? readNonNegativeNumber(settings, "startSec");
    const endSec = this.params.endSec ?? readNumber(settings, "endSec");
    const frameTokenBudget = this.params.frameTokenBudget ?? readTier(settings);
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        "video",
        signal
      );
      const durationSeconds = probe.durationMs !== void 0 && probe.durationMs > 0 ? probe.durationMs / 1e3 : void 0;
      let scaleVf = scaleFilter(maxDimension);
      const sourceDimsKnown = probe.width !== void 0 && probe.height !== void 0 && probe.width > 0 && probe.height > 0;
      let deliveredResolution = "";
      if (frameTokenBudget && sourceDimsKnown) {
        const target = videoFrameDimensionsForTokenBudget(
          probe.width,
          probe.height,
          frameTokenBudget
        );
        scaleVf = `scale=${target.width}:${target.height}`;
        deliveredResolution = `${target.width}\xD7${target.height}`;
      } else if (sourceDimsKnown) {
        const factor = Math.min(
          1,
          maxDimension / Math.max(probe.width, probe.height)
        );
        deliveredResolution = `${Math.round(probe.width * factor)}\xD7${Math.round(probe.height * factor)}`;
      }
      const remainingTimeoutMs = createPolicyToolTimeoutBudget(this.timeoutMs);
      const context = {
        maxFrames,
        sceneThreshold,
        maxDimension,
        scaleVf,
        remainingTimeoutMs,
        signal
      };
      const extraction = strategy === "uniform" && durationSeconds !== void 0 ? await this.extractUniform(context, durationSeconds, {
        fps,
        startSec,
        endSec
      }) : durationSeconds !== void 0 && maxFrames > 1 ? await this.extractBucketed(context, durationSeconds) : await this.extractSinglePass(context);
      if (!Array.isArray(extraction)) {
        return extraction;
      }
      const frames = extraction;
      const bucketed = strategy !== "uniform" && durationSeconds !== void 0 && maxFrames > 1;
      const originalDuration = durationSeconds !== void 0 ? `${Math.round(durationSeconds)}s` : formatBytesShort(inputSizeBytes);
      const originalResolution = probe.width !== void 0 && probe.height !== void 0 ? `/${probe.width}\xD7${probe.height}` : "";
      const samplingNote = strategy === "uniform" ? `\u5747\u5300\u62BD\u5E27\uFF08\u52A8\u6001\u5E27\u7387 ${fps}fps \u76EE\u6807\uFF0C\u5171 ${frames.length} \u5E27\uFF09` : bucketed ? frames.length < maxFrames ? `\u9759\u6001\u62BD\u5E27\uFF08\u5168\u7247\u5206\u6876\u91C7\u6837\uFF0C\u4EC5\u8986\u76D6 ${frames.length}/${maxFrames} \u4E2A\u5206\u6876\uFF0C\u5176\u4F59\u65F6\u6BB5\u672A\u91C7\u6837\uFF09` : "\u9759\u6001\u62BD\u5E27\uFF08\u5168\u7247\u5206\u6876\u91C7\u6837\uFF09" : "\u9759\u6001\u62BD\u5E27";
      const header = `\u539F\u89C6\u9891 ${originalDuration}${originalResolution} \u2192 \u5173\u952E\u5E27${deliveredResolution ? `\uFF0C\u7F29\u653E\u81F3 ${deliveredResolution}` : ""}\uFF0C${samplingNote}\uFF0C\u65F6\u95F4\u8FDE\u7EED\u6027\u4E22\u5931\u3002\u964D\u8D28\u5E27\u4E0D\u8DB3\u4EE5\u8FA8\u8BC6\u6587\u5B57/\u5C0F\u7269\u4F53/\u7CBE\u786E\u8BA1\u6570\uFF1A\u5148\u7528 omni_extract_keyframes\uFF08strategy=uniform\u3001startSec\u3001endSec\uFF09\u5728\u7591\u4F3C\u533A\u95F4\u52A0\u5BC6\u62BD\u5E27\u5B9A\u4F4D\uFF0C\u518D\u7528 omni_clip_video \u622A\u53D6 \u226420s \u540E read_file \u770B\u539F\u751F\u89C6\u9891\u3002\u770B\u4E0D\u6E05\u7684\u7EC6\u8282\u4E0D\u8981\u51ED\u731C\u6D4B\u4F5C\u7B54`;
      const withHours = (durationSeconds ?? 0) >= 3600;
      const artifacts = [];
      for (const [index, frame] of frames.entries()) {
        const sizeBytes = (await fs.stat(path.join(this.params.outputDir, frame.fileName))).size;
        const t = frame.timeSeconds;
        const marker = t !== void 0 && Number.isFinite(t) ? `<${formatClock(t, withHours)}>` : `<\u5173\u952E\u5E27 ${index + 1}/${frames.length}>`;
        artifacts.push({
          kind: "image",
          storage: "workspace",
          title: `Keyframe ${index + 1}/${frames.length}`,
          workspacePath: frame.fileName,
          mimeType: "image/jpeg",
          sizeBytes,
          metadata: {
            // First frame: header + its marker; the rest: marker only. D8 is
            // still satisfied — every lossy frame carries a non-empty
            // disclosure.
            omniDisclosure: index === 0 ? `${header}
${marker}` : marker,
            // Marks the artifact as a sampled excerpt for downstream role
            // consumers (output routing selectors, memory coverage).
            omniRole: "keyframe"
          }
        });
      }
      const summary = `Extracted ${frames.length} keyframe(s) from ${path.basename(this.params.inputPath)} (${originalDuration}${originalResolution})`;
      const outputPaths = frames.map((frame) => path.join(this.params.outputDir, frame.fileName)).join("\n");
      return {
        llmContent: `${summary}
Output files:
${outputPaths}
Use read_file with these absolute paths to inspect the results.`,
        returnDisplay: summary,
        artifacts
      };
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }
  /**
   * Full-duration coverage: split the timeline into `maxFrames` equal
   * buckets and extract one frame per bucket — a scene change from the
   * bucket's opening window when one exists, the bucket midpoint
   * otherwise. Input seeking (`-ss` before `-i`) jumps straight to each
   * bucket without decoding the preceding footage; it also resets
   * pts to ~0, so the absolute timestamp is bucketStart + showinfo
   * pts_time. Individual bucket failures are tolerated (the last one is
   * kept for the zero-frames diagnostic); the loop stops early when the
   * shared budget is exhausted.
   */
  async extractBucketed(context, durationSeconds) {
    const { maxFrames, sceneThreshold, scaleVf, remainingTimeoutMs, signal } = context;
    const bucket = durationSeconds / maxFrames;
    const window = Math.min(bucket, SCENE_SEARCH_WINDOW_SECONDS);
    const frames = [];
    let lastFailure;
    for (let i = 0; i < maxFrames; i++) {
      if (remainingTimeoutMs() <= 1) {
        break;
      }
      const bucketStart = i * bucket;
      const fileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: "keyframe",
        variant: String(i + 1).padStart(4, "0"),
        extension: ".jpg"
      });
      const outputPath = path.join(this.params.outputDir, fileName);
      const sceneRun = await runFfmpeg(
        [
          "-y",
          "-ss",
          formatSeconds(bucketStart),
          "-t",
          formatSeconds(window),
          "-i",
          this.params.inputPath,
          "-vf",
          `select='gt(scene,${sceneThreshold})',${scaleVf},showinfo`,
          "-vsync",
          "vfr",
          "-frames:v",
          "1",
          "-q:v",
          "4",
          "-update",
          "1",
          outputPath
        ],
        { signal, timeoutMs: remainingTimeoutMs() }
      );
      if (signal.aborted) {
        return mediaPolicyToolError("keyframe extraction aborted");
      }
      if (sceneRun.code === 0 && await fileExists(outputPath)) {
        const pts = parseShowinfoTimestamps(sceneRun.stderr)[0];
        frames.push({
          fileName,
          timeSeconds: bucketStart + (pts !== void 0 && Number.isFinite(pts) ? pts : window / 2)
        });
        continue;
      }
      if (sceneRun.code !== 0) {
        lastFailure = sceneRun;
      }
      const midpoint = bucketStart + bucket / 2;
      const midpointRun = await runFfmpeg(
        [
          "-y",
          "-ss",
          formatSeconds(midpoint),
          "-i",
          this.params.inputPath,
          "-vf",
          scaleVf,
          "-frames:v",
          "1",
          "-q:v",
          "4",
          "-update",
          "1",
          outputPath
        ],
        { signal, timeoutMs: remainingTimeoutMs() }
      );
      if (signal.aborted) {
        return mediaPolicyToolError("keyframe extraction aborted");
      }
      if (midpointRun.code === 0 && await fileExists(outputPath)) {
        frames.push({ fileName, timeSeconds: midpoint });
      } else if (midpointRun.code !== 0) {
        lastFailure = midpointRun;
      }
    }
    if (frames.length === 0) {
      return mediaPolicyToolError(
        lastFailure !== void 0 ? ffmpegFailureMessage(
          lastFailure,
          "extracting keyframes from",
          this.params.inputPath
        ) : `no keyframes could be extracted from ${path.basename(this.params.inputPath)}`
      );
    }
    return frames;
  }
  /**
   * Uniform strategy (⓫, ported from the plugin's
   * `compute_dynamic_fps` + `extract_frames_by_seeking`): the frame
   * count adapts to the window length — clamp(window × fps, 1,
   * maxFrames) — so long videos automatically thin out (the effective
   * fps is nframes/window, capped at the native frame rate), and every
   * timestamp is extracted by its own input-side seek (`-ss` before
   * `-i`: no decode of the preceding footage) with bounded concurrency.
   * `startSec`/`endSec` bound the sampling window (clip-and-sample in
   * one pass). Per-frame timestamps are exact by construction.
   */
  async extractUniform(context, durationSeconds, options) {
    const { maxFrames, scaleVf, remainingTimeoutMs, signal } = context;
    const { fps } = options;
    const windowStart = Math.max(0, options.startSec ?? 0);
    if (windowStart >= durationSeconds) {
      return mediaPolicyToolError(
        `startSec (${windowStart}) is at or beyond the end of the video (${Math.round(durationSeconds)}s)`
      );
    }
    const windowEnd = Math.min(
      options.endSec ?? durationSeconds,
      durationSeconds
    );
    if (windowEnd <= windowStart) {
      return mediaPolicyToolError(
        `the sampling window [${windowStart}\u2013${windowEnd}] is empty`
      );
    }
    const windowSeconds = windowEnd - windowStart;
    const nframes = Math.max(
      1,
      Math.min(maxFrames, Math.floor(windowSeconds * fps))
    );
    const slice = windowSeconds / nframes;
    const timestamps = Array.from(
      { length: nframes },
      (_, i) => windowStart + (i + 0.5) * slice
    );
    const outcomes = new Array(nframes);
    let nextIndex = 0;
    const worker = /* @__PURE__ */ __name(async () => {
      while (!signal.aborted) {
        const index = nextIndex++;
        if (index >= nframes) return;
        if (remainingTimeoutMs() <= 1) return;
        const timestamp = timestamps[index];
        const fileName = policyOutputFileName({
          inputPath: this.params.inputPath,
          operation: "keyframe",
          variant: String(index + 1).padStart(4, "0"),
          extension: ".jpg"
        });
        const outputPath = path.join(this.params.outputDir, fileName);
        const run = await runFfmpeg(
          [
            "-y",
            "-ss",
            formatSeconds(timestamp),
            "-i",
            this.params.inputPath,
            "-vf",
            scaleVf,
            "-frames:v",
            "1",
            "-q:v",
            "4",
            "-update",
            "1",
            outputPath
          ],
          { signal, timeoutMs: remainingTimeoutMs() }
        );
        if (signal.aborted) return;
        if (run.code === 0 && await fileExists(outputPath)) {
          outcomes[index] = { fileName, timeSeconds: timestamp };
        }
      }
    }, "worker");
    await Promise.all(
      Array.from({ length: Math.min(SEEK_CONCURRENCY, nframes) }, worker)
    );
    if (signal.aborted) {
      return mediaPolicyToolError("keyframe extraction aborted");
    }
    const frames = outcomes.filter((f) => f !== void 0);
    if (frames.length === 0) {
      return mediaPolicyToolError(
        `no keyframes could be extracted from ${path.basename(this.params.inputPath)}`
      );
    }
    return frames;
  }
  /**
   * Single-pass scene detection (legacy path): frame 0 always selected,
   * then every frame whose scene score exceeds the threshold, capped at
   * maxFrames. Only used when the duration is unknown (buckets cannot
   * be placed) or a single frame was requested. showinfo (after select)
   * logs one stderr line per KEPT frame with its pts_time — the
   * timestamps feed the per-frame disclosures.
   */
  async extractSinglePass(context) {
    const { maxFrames, sceneThreshold, scaleVf, remainingTimeoutMs, signal } = context;
    const frameNameTemplate = policyOutputFileName({
      inputPath: this.params.inputPath,
      operation: "keyframe",
      variant: "%04d",
      extension: ".jpg"
    });
    const outputPattern = path.join(this.params.outputDir, frameNameTemplate);
    const staleFrames = await listFrameFiles(
      this.params.outputDir,
      frameNameTemplate
    );
    await Promise.all(
      staleFrames.map(
        (name) => fs.rm(path.join(this.params.outputDir, name), { force: true }).catch(() => {
        })
      )
    );
    const scenePass = await runFfmpeg(
      [
        "-y",
        "-i",
        this.params.inputPath,
        "-vf",
        `select='eq(n,0)+gt(scene,${sceneThreshold})',${scaleVf},showinfo`,
        "-vsync",
        "vfr",
        "-frames:v",
        String(maxFrames),
        "-q:v",
        "4",
        outputPattern
      ],
      { signal, timeoutMs: remainingTimeoutMs() }
    );
    if (signal.aborted) {
      return mediaPolicyToolError("keyframe extraction aborted");
    }
    if (scenePass.code !== 0) {
      return mediaPolicyToolError(
        ffmpegFailureMessage(
          scenePass,
          "extracting keyframes from",
          this.params.inputPath
        )
      );
    }
    const frameFiles = await listFrameFiles(
      this.params.outputDir,
      frameNameTemplate
    );
    if (frameFiles.length === 0) {
      return mediaPolicyToolError(
        `no keyframes could be extracted from ${path.basename(this.params.inputPath)}`
      );
    }
    const timestamps = parseShowinfoTimestamps(scenePass.stderr);
    return frameFiles.map((fileName, index) => {
      const t = timestamps[index];
      return {
        fileName,
        timeSeconds: t !== void 0 && Number.isFinite(t) ? t : void 0
      };
    });
  }
};
var OmniExtractKeyframesTool = class extends BaseMediaPolicyTool {
  static {
    __name(this, "OmniExtractKeyframesTool");
  }
  constructor(config) {
    super(
      OMNI_EXTRACT_KEYFRAMES_TOOL_NAME,
      "ExtractKeyframes",
      "Extracts representative still frames spread across the full video duration (per-segment scene detection with midpoint fallback), producing JPEG keyframes with per-frame timestamps and a disclosure of the temporal loss.",
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
    return new ExtractKeyframesInvocation(
      params,
      resolvePolicyToolSettings(this.configView, this.name),
      resolvePolicyToolTimeoutMs(this.configView, this.name)
    );
  }
};
export {
  EXTRACT_KEYFRAMES_DEFAULTS,
  OMNI_EXTRACT_KEYFRAMES_TOOL_NAME,
  OmniExtractKeyframesTool,
  parseShowinfoTimestamps
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
