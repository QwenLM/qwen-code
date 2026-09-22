// Force strict mode and setup for ESM
"use strict";
import {
  execCommand,
  isCommandAvailable
} from "./chunk-QPTE6BKL.js";
import {
  resolveBundleDir
} from "./chunk-ACHCT36C.js";
import {
  fileExists
} from "./chunk-25FMWESU.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/ripgrepUtils.ts
init_esbuild_shims();
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
var debugLogger = createDebugLogger("RIPGREP");
var RIPGREP_COMMAND = "rg";
var RIPGREP_BUFFER_LIMIT = 2e7;
var RIPGREP_TEST_TIMEOUT_MS = 5e3;
var RIPGREP_RUN_TIMEOUT_MS = 1e4;
var RIPGREP_WSL_TIMEOUT_MS = 6e4;
var cachedSelections = /* @__PURE__ */ new Map();
var cachedHealth = null;
function wslTimeout() {
  return process.platform === "linux" && process.env["WSL_INTEROP"] ? RIPGREP_WSL_TIMEOUT_MS : RIPGREP_RUN_TIMEOUT_MS;
}
__name(wslTimeout, "wslTimeout");
var __filename = fileURLToPath(import.meta.url);
var __dirname = resolveBundleDir(import.meta.url);
function getPlatformString(platform) {
  switch (platform) {
    case "darwin":
    case "linux":
    case "win32":
      return platform;
    default:
      return void 0;
  }
}
__name(getPlatformString, "getPlatformString");
function getArchitectureString(arch) {
  switch (arch) {
    case "x64":
    case "arm64":
      return arch;
    default:
      return void 0;
  }
}
__name(getArchitectureString, "getArchitectureString");
function getBuiltinRipgrep() {
  const platform = getPlatformString(process.platform);
  const arch = getArchitectureString(process.arch);
  if (!platform || !arch) {
    return null;
  }
  const binaryName = platform === "win32" ? "rg.exe" : "rg";
  const inSrcUtils = __filename.includes(path.join("src", "utils"));
  const levelsUp = !inSrcUtils ? 0 : __filename.endsWith(".ts") ? 2 : 3;
  return path.join(
    __dirname,
    ...Array(levelsUp).fill(".."),
    "vendor",
    "ripgrep",
    `${arch}-${platform}`,
    binaryName
  );
}
__name(getBuiltinRipgrep, "getBuiltinRipgrep");
async function resolveRipgrep(useBuiltin = true) {
  const cachedSelection = cachedSelections.get(useBuiltin);
  if (cachedSelection) return cachedSelection;
  if (useBuiltin) {
    const rgPath = getBuiltinRipgrep();
    if (rgPath && await fileExists(rgPath)) {
      const selection = { mode: "builtin", command: rgPath };
      cachedSelections.set(useBuiltin, selection);
      return selection;
    }
  }
  const { available, error } = isCommandAvailable(RIPGREP_COMMAND);
  if (available) {
    const selection = { mode: "system", command: RIPGREP_COMMAND };
    cachedSelections.set(useBuiltin, selection);
    return selection;
  }
  if (error) {
    throw error;
  }
  return null;
}
__name(resolveRipgrep, "resolveRipgrep");
async function ensureRipgrepHealthy(selection) {
  if (cachedHealth && cachedHealth.selection.command === selection.command && cachedHealth.working)
    return;
  let working = false;
  let probeOutput = "";
  let probeCode = -1;
  try {
    const { stdout, code } = await execCommand(
      selection.command,
      ["--version"],
      {
        timeout: RIPGREP_TEST_TIMEOUT_MS
      }
    );
    probeOutput = stdout;
    probeCode = code;
    working = code === 0 && stdout.startsWith("ripgrep");
    cachedHealth = { working, lastTested: Date.now(), selection };
  } catch (error) {
    cachedHealth = { working: false, lastTested: Date.now(), selection };
    throw error;
  }
  if (!working) {
    throw new Error(
      `${selection.command} is not a working ripgrep binary (exit ${probeCode}): ${probeOutput.trim() || "(no output)"}`
    );
  }
}
__name(ensureRipgrepHealthy, "ensureRipgrepHealthy");
async function resolveHealthyRipgrep(useBuiltin) {
  const selection = await resolveRipgrep(useBuiltin);
  if (!selection) {
    return null;
  }
  try {
    await ensureRipgrepHealthy(selection);
    return selection;
  } catch (error) {
    if (selection.mode !== "builtin") {
      throw error;
    }
    debugLogger.warn(
      `Bundled ripgrep at ${selection.command} is unusable (${error}); trying system rg.`
    );
    let fallback = null;
    try {
      fallback = await resolveRipgrep(false);
      if (fallback) {
        await ensureRipgrepHealthy(fallback);
      }
    } catch (fallbackError) {
      debugLogger.warn(`System rg is unusable as well: ${fallbackError}`);
      throw error;
    }
    if (!fallback) {
      throw error;
    }
    cachedSelections.set(true, fallback);
    return fallback;
  }
}
__name(resolveHealthyRipgrep, "resolveHealthyRipgrep");
async function canUseRipgrep(useBuiltin = true) {
  const selection = await resolveHealthyRipgrep(useBuiltin);
  return selection !== null;
}
__name(canUseRipgrep, "canUseRipgrep");
function errorCodeOf(error) {
  return error.code;
}
__name(errorCodeOf, "errorCodeOf");
function isCanceledRipgrepExecution(error, signal) {
  return signal?.aborted === true || error.name === "AbortError" || errorCodeOf(error) === "ABORT_ERR";
}
__name(isCanceledRipgrepExecution, "isCanceledRipgrepExecution");
function isRipgrepThreadEagain(stderr) {
  const lower = stderr.toLowerCase();
  if (lower.includes("os error 11")) {
    return true;
  }
  const mentionsThread = lower.includes("thread") || lower.includes("worker");
  const mentionsEagain = lower.includes("resource temporarily unavailable") || lower.includes("eagain");
  return mentionsThread && mentionsEagain;
}
__name(isRipgrepThreadEagain, "isRipgrepThreadEagain");
function withSingleRipgrepThread(args) {
  const threadsIndex = args.findIndex(
    (arg, index) => arg === "--threads" && args[index + 1] === "4"
  );
  if (threadsIndex === -1) {
    return null;
  }
  const retryArgs = [...args];
  retryArgs[threadsIndex + 1] = "1";
  return retryArgs;
}
__name(withSingleRipgrepThread, "withSingleRipgrepThread");
function dropPossiblyIncompleteLastLine(stdout) {
  if (stdout.length === 0) return stdout;
  const lines = stdout.split("\n");
  lines.pop();
  return lines.join("\n");
}
__name(dropPossiblyIncompleteLastLine, "dropPossiblyIncompleteLastLine");
function classifyRipgrepError(error, stderr, signal) {
  const canceled = isCanceledRipgrepExecution(error, signal);
  if (canceled) {
    return { canceled };
  }
  const errorCode = errorCodeOf(error);
  if (isRipgrepThreadEagain(stderr)) {
    return { failureKind: "eagain", canceled: false };
  }
  if (errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { failureKind: "max_buffer", canceled: false };
  }
  if (error.signal === "SIGTERM") {
    return { failureKind: "timeout", canceled: false };
  }
  if (typeof errorCode === "string") {
    return { failureKind: "spawn", canceled: false };
  }
  return { failureKind: "exit", canceled: false };
}
__name(classifyRipgrepError, "classifyRipgrepError");
function shouldDropLastLine(failureKind, canceled) {
  return canceled || failureKind === "timeout" || failureKind === "max_buffer";
}
__name(shouldDropLastLine, "shouldDropLastLine");
function createRecoveryMetadata(selection, options) {
  const recovery = {
    selectionMode: selection.mode,
    retryTriggered: options.retryTriggered
  };
  if (options.retrySucceeded !== void 0) {
    recovery.retrySucceeded = options.retrySucceeded;
  }
  if (options.failureKind !== void 0) {
    recovery.failureKind = options.failureKind;
  }
  return recovery;
}
__name(createRecoveryMetadata, "createRecoveryMetadata");
function toRunResult(attempt, recovery) {
  const result = {
    stdout: attempt.stdout,
    incomplete: attempt.incomplete,
    recovery
  };
  if (attempt.error !== void 0) {
    result.error = attempt.error;
  }
  return result;
}
__name(toRunResult, "toRunResult");
async function runRipgrepOnce(selection, args, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = /* @__PURE__ */ __name((result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    }, "settle");
    let child;
    try {
      child = execFile(
        selection.command,
        args,
        {
          maxBuffer: RIPGREP_BUFFER_LIMIT,
          timeout: wslTimeout(),
          signal
        },
        (error, stdout = "", stderr = "") => {
          const stdoutText = stdout.toString();
          const stderrText = stderr.toString();
          if (!error) {
            settle({
              stdout: stdoutText,
              incomplete: false,
              canceled: false
            });
            return;
          }
          const errorCode = errorCodeOf(error);
          if (errorCode === 1 && stderrText.trim() === "") {
            settle({
              stdout: stdoutText,
              incomplete: false,
              canceled: false
            });
            return;
          }
          const { failureKind, canceled } = classifyRipgrepError(
            error,
            stderrText,
            signal
          );
          const incomplete = (shouldDropLastLine(failureKind, canceled) || failureKind === "eagain" || failureKind === "exit") && stdoutText.trim().length > 0;
          const partialOutput = shouldDropLastLine(failureKind, canceled) ? dropPossiblyIncompleteLastLine(stdoutText) : stdoutText;
          if (failureKind === "timeout" || failureKind === "max_buffer") {
            debugLogger.warn(
              `ripgrep exited abnormally (signal=${error.signal} code=${error.code}) with stderr:
${stderrText.trim() || "(empty)"}`
            );
          }
          settle({
            stdout: partialOutput,
            incomplete,
            canceled,
            error,
            ...failureKind !== void 0 ? { failureKind } : {}
          });
        }
      );
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      settle({
        stdout: "",
        incomplete: false,
        canceled: false,
        error: normalizedError,
        failureKind: "spawn"
      });
      return;
    }
    child.on("error", (error) => {
      const canceled = isCanceledRipgrepExecution(error, signal);
      const result = {
        stdout: "",
        incomplete: false,
        canceled,
        error
      };
      if (!canceled) {
        result.failureKind = "spawn";
      }
      settle(result);
    });
  });
}
__name(runRipgrepOnce, "runRipgrepOnce");
async function runRipgrep(args, signal, useBuiltin = true) {
  const selection = await resolveHealthyRipgrep(useBuiltin);
  if (!selection) {
    throw new Error("ripgrep not found.");
  }
  const firstAttempt = await runRipgrepOnce(selection, args, signal);
  if (firstAttempt.failureKind === "eagain" && !firstAttempt.canceled && signal?.aborted !== true) {
    const retryArgs = withSingleRipgrepThread(args);
    if (retryArgs !== null) {
      const retryAttempt = await runRipgrepOnce(selection, retryArgs, signal);
      const retryRecoveryOptions = {
        retryTriggered: true,
        retrySucceeded: retryAttempt.error === void 0
      };
      const retryFailureKind = retryAttempt.error === void 0 ? "eagain" : retryAttempt.failureKind;
      if (retryFailureKind !== void 0) {
        retryRecoveryOptions.failureKind = retryFailureKind;
      }
      return toRunResult(
        retryAttempt,
        createRecoveryMetadata(selection, retryRecoveryOptions)
      );
    }
  }
  const recoveryOptions = {
    retryTriggered: false
  };
  if (firstAttempt.failureKind !== void 0) {
    recoveryOptions.failureKind = firstAttempt.failureKind;
  }
  return toRunResult(
    firstAttempt,
    createRecoveryMetadata(selection, recoveryOptions)
  );
}
__name(runRipgrep, "runRipgrep");

export {
  canUseRipgrep,
  runRipgrep
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
