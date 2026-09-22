// Force strict mode and setup for ESM
"use strict";
import {
  registerCleanup
} from "./chunk-FR7RJHJR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/cpuProfiler.ts
init_esbuild_shims();
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
var MAX_PROFILES = 5;
var RATE_LIMIT_MS = 3e4;
var MIN_FREE_BYTES_AFTER_WRITE = 256 * 1024 * 1024;
var DEFAULT_SAMPLING_INTERVAL_US = 1e3;
var ESTIMATED_PROFILE_BYTES = 10 * 1024 * 1024;
var state = "idle";
var session = null;
var initialized = false;
var signalHandlerRegistered = false;
var lastWriteByDir = /* @__PURE__ */ new Map();
function initCpuProfiler() {
  if (initialized) return;
  initialized = true;
  registerSignalHandler();
  registerCleanup(async () => {
    if (state === "recording") {
      const result = await stopCpuProfile();
      if (result.ok) {
        process.stderr.write(
          `[cpu-profiler] Profile written: ${result.filePath}
`
        );
      }
    }
  });
  const enabled = process.env["QWEN_CODE_CPU_PROFILE"] === "1";
  if (!enabled) return;
  void startCpuProfile().then((result) => {
    if (!result.ok) {
      process.stderr.write(`[cpu-profiler] Failed to start: ${result.error}
`);
    }
  });
}
__name(initCpuProfiler, "initCpuProfiler");
async function startCpuProfile(opts) {
  if (state !== "idle") {
    return {
      ok: false,
      error: state === "recording" ? "CPU profiling is already in progress." : "CPU profiler is currently stopping. Please wait a moment and try again."
    };
  }
  state = "recording";
  try {
    const inspectorSession = await getOrCreateSession();
    await inspectorSession.post("Profiler.enable");
    await inspectorSession.post("Profiler.setSamplingInterval", {
      interval: opts?.samplingInterval ?? DEFAULT_SAMPLING_INTERVAL_US
    });
    await inspectorSession.post("Profiler.start");
    return { ok: true };
  } catch (error) {
    state = "idle";
    disconnectSession();
    return { ok: false, error: formatError(error) };
  }
}
__name(startCpuProfile, "startCpuProfile");
async function stopCpuProfile(options) {
  if (state !== "recording") {
    return {
      ok: false,
      error: state === "idle" ? "CPU profiler is not recording." : "CPU profiler is already stopping."
    };
  }
  const outputDir = options?.outputDir ?? defaultOutputDir();
  const now = options?.now ?? /* @__PURE__ */ new Date();
  const rateLimitMs = options?.rateLimitMs ?? RATE_LIMIT_MS;
  const maxProfiles = options?.maxProfiles ?? MAX_PROFILES;
  try {
    enforceRateLimit(outputDir, now, rateLimitMs);
  } catch (error) {
    state = "idle";
    if (session) {
      session.post("Profiler.stop").catch(() => {
      });
      session.post("Profiler.disable").catch(() => {
      });
    }
    disconnectSession();
    return { ok: false, error: formatError(error) };
  }
  state = "stopping";
  try {
    if (!session) {
      throw new Error(
        "Inspector session lost unexpectedly during Profiler.stop; the profile data could not be retrieved."
      );
    }
    const result = await session.post("Profiler.stop");
    if (!result.profile) {
      throw new Error(
        "V8 Profiler.stop returned an empty profile; recording may have been interrupted."
      );
    }
    await session.post("Profiler.disable");
    fs.mkdirSync(outputDir, { recursive: true, mode: 448 });
    try {
      fs.chmodSync(outputDir, 448);
    } catch {
    }
    checkDiskSpace(outputDir);
    const filePath = path.join(
      outputDir,
      `qwen-code-cpu-${process.pid}-${formatTimestamp(now)}.cpuprofile`
    );
    try {
      fs.writeFileSync(filePath, JSON.stringify(result.profile), {
        mode: 384
      });
    } catch (writeError) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
      }
      throw writeError;
    }
    recordWrite(outputDir, now);
    cleanupOldProfiles(outputDir, maxProfiles);
    state = "idle";
    return { ok: true, filePath };
  } catch (error) {
    state = "idle";
    disconnectSession();
    return { ok: false, error: formatError(error) };
  }
}
__name(stopCpuProfile, "stopCpuProfile");
function isCpuProfileRecording() {
  return state === "recording";
}
__name(isCpuProfileRecording, "isCpuProfileRecording");
function registerSignalHandler() {
  if (signalHandlerRegistered) return;
  if (process.platform === "win32") return;
  signalHandlerRegistered = true;
  process.on("SIGUSR1", handleSigusr1);
}
__name(registerSignalHandler, "registerSignalHandler");
function defaultOutputDir() {
  return path.join(os.homedir(), ".qwen", "cpu-profiles");
}
__name(defaultOutputDir, "defaultOutputDir");
function formatTimestamp(now) {
  return now.toISOString().replace(/[:.]/g, "-");
}
__name(formatTimestamp, "formatTimestamp");
function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
__name(formatError, "formatError");
var sessionFactory = null;
async function getOrCreateSession() {
  if (session) return session;
  if (sessionFactory) {
    session = await sessionFactory();
    return session;
  }
  const inspectorModule = await import("node:inspector/promises");
  const newSession = new inspectorModule.Session();
  newSession.connect();
  session = newSession;
  return session;
}
__name(getOrCreateSession, "getOrCreateSession");
function disconnectSession() {
  if (session) {
    try {
      session.disconnect();
    } catch {
    }
    session = null;
  }
}
__name(disconnectSession, "disconnectSession");
function handleSigusr1() {
  if (state === "idle") {
    void startCpuProfile().then((result) => {
      if (result.ok) {
        process.stderr.write(
          `[cpu-profiler] Recording started (PID ${process.pid}). Send SIGUSR1 again to stop.
`
        );
      } else {
        process.stderr.write(
          `[cpu-profiler] Failed to start: ${result.error}
`
        );
      }
    });
  } else if (state === "recording") {
    void stopCpuProfile().then((result) => {
      if (result.ok) {
        process.stderr.write(
          `[cpu-profiler] Profile written: ${result.filePath}
`
        );
      } else {
        process.stderr.write(
          `[cpu-profiler] Failed to stop: ${result.error}
`
        );
      }
    });
  }
}
__name(handleSigusr1, "handleSigusr1");
function enforceRateLimit(outputDir, now, rateLimitMs) {
  if (rateLimitMs <= 0) return;
  const key = path.resolve(outputDir);
  const nowMs = now.getTime();
  const lastWriteMs = lastWriteByDir.get(key);
  if (lastWriteMs !== void 0 && nowMs - lastWriteMs < rateLimitMs) {
    const waitSeconds = Math.ceil((rateLimitMs - (nowMs - lastWriteMs)) / 1e3);
    throw new Error(
      `CPU profile rate limit: wait ${waitSeconds}s before writing another profile.`
    );
  }
}
__name(enforceRateLimit, "enforceRateLimit");
function recordWrite(outputDir, now) {
  lastWriteByDir.set(path.resolve(outputDir), now.getTime());
}
__name(recordWrite, "recordWrite");
function checkDiskSpace(outputDir) {
  try {
    const stats = fs.statfsSync(outputDir);
    const available = stats.bavail * stats.bsize;
    if (available - ESTIMATED_PROFILE_BYTES < MIN_FREE_BYTES_AFTER_WRITE) {
      throw new Error(
        "Insufficient free disk space for CPU profile; skipping to avoid filling the disk."
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("Insufficient free disk")) {
      throw error;
    }
    process.stderr.write(
      "[cpu-profiler] Disk space check unavailable on this platform; skipping.\n"
    );
  }
}
__name(checkDiskSpace, "checkDiskSpace");
function cleanupOldProfiles(outputDir, maxProfiles) {
  if (maxProfiles < 1) return;
  let profiles;
  try {
    profiles = fs.readdirSync(outputDir).filter(
      (name) => name.startsWith("qwen-code-cpu-") && name.endsWith(".cpuprofile")
    ).map((name) => path.join(outputDir, name)).sort((a, b) => {
      try {
        return fs.lstatSync(b).mtimeMs - fs.lstatSync(a).mtimeMs || path.basename(b).localeCompare(path.basename(a));
      } catch {
        return path.basename(b).localeCompare(path.basename(a));
      }
    });
  } catch {
    return;
  }
  for (const filePath of profiles.slice(maxProfiles)) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
    }
  }
}
__name(cleanupOldProfiles, "cleanupOldProfiles");

export {
  initCpuProfiler,
  startCpuProfile,
  stopCpuProfile,
  isCpuProfileRecording
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
