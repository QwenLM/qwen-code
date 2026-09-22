// Force strict mode and setup for ESM
"use strict";
import {
  FatalConfigError
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/ffmpeg.ts
init_esbuild_shims();
import { execFile } from "node:child_process";
import path from "node:path";
function execCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", ...options },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            code: typeof error.code === "number" ? error.code : 1
          });
          return;
        }
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code: 0
        });
      }
    );
  });
}
__name(execCommand, "execCommand");
var availabilityCache = /* @__PURE__ */ new Map();
async function probeBinary(binary) {
  const cached = availabilityCache.get(binary);
  if (typeof cached === "boolean") return cached;
  if (cached) return cached;
  const probe = (async () => {
    try {
      const { code } = await execCommand(binary, ["-version"], {
        timeout: 5e3
      });
      return code === 0;
    } catch {
      return false;
    }
  })().then(
    (result) => {
      availabilityCache.set(binary, result);
      return result;
    },
    () => {
      availabilityCache.delete(binary);
      return false;
    }
  );
  availabilityCache.set(binary, probe);
  return probe;
}
__name(probeBinary, "probeBinary");
async function isFfmpegAvailable() {
  return probeBinary("ffmpeg");
}
__name(isFfmpegAvailable, "isFfmpegAvailable");
async function isFfprobeAvailable() {
  return probeBinary("ffprobe");
}
__name(isFfprobeAvailable, "isFfprobeAvailable");
function resetFfmpegCachesForTests() {
  availabilityCache.clear();
}
__name(resetFfmpegCachesForTests, "resetFfmpegCachesForTests");
async function assertOmniRuntimeDependencies() {
  const [ffmpeg, ffprobe] = await Promise.all([
    isFfmpegAvailable(),
    isFfprobeAvailable()
  ]);
  if (ffmpeg && ffprobe) return;
  const missing = [
    ...ffmpeg ? [] : ["ffmpeg"],
    ...ffprobe ? [] : ["ffprobe"]
  ].join(" and ");
  throw new FatalConfigError(
    `Omni multimodal support is enabled (omni.enabled / QWEN_CODE_ENABLE_OMNI=1) but ${missing} was not found on PATH. Install ffmpeg (e.g. "brew install ffmpeg" on macOS, "apt-get install ffmpeg" on Debian/Ubuntu) or disable omni support.`
  );
}
__name(assertOmniRuntimeDependencies, "assertOmniRuntimeDependencies");
async function runFfmpeg(args, options) {
  const { code, stderr } = await execCommand("ffmpeg", args, {
    // Transcodes are long-running; stderr carries progress lines, so give
    // it more headroom than the probe calls.
    maxBuffer: 16 * 1024 * 1024,
    ...options?.timeoutMs !== void 0 && { timeout: options.timeoutMs },
    ...options?.signal && { signal: options.signal }
  });
  return { code, stderr };
}
__name(runFfmpeg, "runFfmpeg");
function parseFrameRate(raw) {
  if (!raw) return void 0;
  const parts = raw.split("/");
  const num = Number(parts[0]);
  const den = parts.length > 1 ? Number(parts[1]) : 1;
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return void 0;
  }
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : void 0;
}
__name(parseFrameRate, "parseFrameRate");
function isAnimationCapableImage(formatName, codecName) {
  const tokens = /* @__PURE__ */ new Set([
    ...formatName?.split(",").map((t) => t.trim()) ?? [],
    ...codecName ? [codecName] : []
  ]);
  return ["gif", "webp", "png", "apng"].some((t) => tokens.has(t));
}
__name(isAnimationCapableImage, "isAnimationCapableImage");
async function countImageFrames(filePath, signal) {
  try {
    const { stdout, code } = await execCommand(
      "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=nb_read_frames",
        "-print_format",
        "json",
        filePath
      ],
      {
        timeout: 15e3,
        maxBuffer: 4 * 1024 * 1024,
        ...signal && { signal }
      }
    );
    if (signal?.aborted || code !== 0) return NaN;
    const parsed = JSON.parse(stdout);
    return Number(parsed.streams?.[0]?.nb_read_frames);
  } catch {
    return NaN;
  }
}
__name(countImageFrames, "countImageFrames");
async function probeMediaMetadata(filePath, modality, signal) {
  const { stdout, code, stderr } = await execCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath
    ],
    { timeout: 15e3, maxBuffer: 4 * 1024 * 1024, ...signal && { signal } }
  );
  if (signal?.aborted) {
    throw new Error(`ffprobe aborted for ${path.basename(filePath)}`);
  }
  if (code !== 0) {
    throw new Error(
      `ffprobe failed (exit ${code}) for ${path.basename(filePath)}: ${stderr.slice(0, 300)}`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `ffprobe produced unparseable output for ${path.basename(filePath)}`
    );
  }
  const videoStream = parsed.streams?.find((s) => s.codec_type === "video");
  const audioStream = parsed.streams?.find((s) => s.codec_type === "audio");
  const durationSeconds = Number(parsed.format?.duration);
  const durationMs = Number.isFinite(durationSeconds) && durationSeconds >= 0 ? Math.round(durationSeconds * 1e3) : void 0;
  const parsePositiveInt = /* @__PURE__ */ __name((raw) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : void 0;
  }, "parsePositiveInt");
  const bitRateFor = /* @__PURE__ */ __name((stream) => parsePositiveInt(parsed.format?.bit_rate) ?? parsePositiveInt(stream?.bit_rate), "bitRateFor");
  const base = { formatName: parsed.format?.format_name };
  switch (modality) {
    case "image": {
      let nbFrames = Number(videoStream?.nb_frames);
      if (!(Number.isFinite(nbFrames) && nbFrames > 0) && isAnimationCapableImage(
        parsed.format?.format_name,
        videoStream?.codec_name
      )) {
        nbFrames = await countImageFrames(filePath, signal);
      }
      return {
        ...base,
        width: videoStream?.width,
        height: videoStream?.height,
        codec: videoStream?.codec_name,
        ...Number.isFinite(nbFrames) && nbFrames > 0 ? { frameCount: nbFrames } : {}
      };
    }
    case "audio": {
      const channels = audioStream?.channels;
      return {
        ...base,
        durationMs,
        codec: audioStream?.codec_name,
        bitRate: bitRateFor(audioStream),
        sampleRateHz: parsePositiveInt(audioStream?.sample_rate),
        ...typeof channels === "number" && channels > 0 ? { channels } : {}
      };
    }
    case "video":
    default:
      return {
        ...base,
        durationMs,
        width: videoStream?.width,
        height: videoStream?.height,
        frameRate: parseFrameRate(videoStream?.avg_frame_rate) ?? parseFrameRate(videoStream?.r_frame_rate),
        codec: videoStream?.codec_name,
        bitRate: bitRateFor(videoStream)
      };
  }
}
__name(probeMediaMetadata, "probeMediaMetadata");

export {
  isFfmpegAvailable,
  isFfprobeAvailable,
  resetFfmpegCachesForTests,
  assertOmniRuntimeDependencies,
  runFfmpeg,
  probeMediaMetadata
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
