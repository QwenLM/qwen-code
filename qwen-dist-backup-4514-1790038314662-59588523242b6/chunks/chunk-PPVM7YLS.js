// Force strict mode and setup for ESM
"use strict";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/earlyInputCapture.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("EARLY_INPUT");
var MAX_BUFFER_SIZE = 64 * 1024;
var inputBuffer = {
  chunks: [],
  totalBytes: 0,
  captured: false
};
var captureHandler = null;
var captureStdin = null;
var isCapturing = false;
var pendingTerminalResponse = Buffer.alloc(0);
function classifyEscapeSequence(data, startIdx) {
  if (startIdx >= data.length || data[startIdx] !== 27) {
    return "user";
  }
  const nextIdx = startIdx + 1;
  if (nextIdx >= data.length) {
    return "incomplete";
  }
  const nextByte = data[nextIdx];
  if (nextByte === 80 || // P (DCS)
  nextByte === 95 || // _ (APC)
  nextByte === 94 || // ^ (PM)
  nextByte === 93) {
    return "terminal";
  }
  if (nextByte === 91) {
    const thirdIdx = startIdx + 2;
    if (thirdIdx >= data.length) {
      return "incomplete";
    }
    const thirdByte = data[thirdIdx];
    if (thirdByte === 63 || thirdByte === 62 || thirdByte === 60) {
      return "terminal";
    }
    return "user";
  }
  return "user";
}
__name(classifyEscapeSequence, "classifyEscapeSequence");
function skipTerminalResponse(data, startIdx) {
  if (startIdx >= data.length || data[startIdx] !== 27) {
    return { nextIndex: startIdx + 1, complete: true };
  }
  const nextIdx = startIdx + 1;
  if (nextIdx >= data.length) {
    return { nextIndex: nextIdx, complete: false };
  }
  const nextByte = data[nextIdx];
  if (nextByte === 93) {
    let i = startIdx + 2;
    while (i < data.length) {
      if (data[i] === 7) {
        return { nextIndex: i + 1, complete: true };
      }
      if (data[i] === 27 && i + 1 < data.length && data[i + 1] === 92) {
        return { nextIndex: i + 2, complete: true };
      }
      i++;
    }
    return { nextIndex: data.length, complete: false };
  }
  if (nextByte === 80 || nextByte === 95 || nextByte === 94) {
    let i = startIdx + 2;
    while (i < data.length) {
      if (data[i] === 27 && i + 1 < data.length && data[i + 1] === 92) {
        return { nextIndex: i + 2, complete: true };
      }
      i++;
    }
    return { nextIndex: data.length, complete: false };
  }
  if (nextByte === 91) {
    let i = startIdx + 2;
    while (i < data.length) {
      const byte = data[i];
      if (byte >= 64 && byte <= 126) {
        return { nextIndex: i + 1, complete: true };
      }
      i++;
    }
    return { nextIndex: data.length, complete: false };
  }
  return { nextIndex: startIdx + 1, complete: true };
}
__name(skipTerminalResponse, "skipTerminalResponse");
function filterTerminalResponses(data) {
  const result = Buffer.allocUnsafe(data.length);
  let writeIdx = 0;
  let i = 0;
  while (i < data.length) {
    if (data[i] === 27) {
      const sequenceType = classifyEscapeSequence(data, i);
      if (sequenceType === "incomplete") {
        return {
          filtered: result.subarray(0, writeIdx),
          trailingPartialTerminalResponse: data.subarray(i)
        };
      }
      if (sequenceType === "terminal") {
        const skipResult = skipTerminalResponse(data, i);
        if (!skipResult.complete) {
          return {
            filtered: result.subarray(0, writeIdx),
            trailingPartialTerminalResponse: data.subarray(i)
          };
        }
        i = skipResult.nextIndex;
        continue;
      }
    }
    result[writeIdx++] = data[i];
    i++;
  }
  return {
    filtered: result.subarray(0, writeIdx),
    trailingPartialTerminalResponse: Buffer.alloc(0)
  };
}
__name(filterTerminalResponses, "filterTerminalResponses");
function shouldReplayPendingAtStop(pending) {
  if (pending.length === 0) {
    return false;
  }
  if (pending.length === 1 && pending[0] === 27) {
    return true;
  }
  return classifyEscapeSequence(pending, 0) === "user";
}
__name(shouldReplayPendingAtStop, "shouldReplayPendingAtStop");
function startEarlyInputCapture() {
  if (isCapturing || !process.stdin.isTTY) {
    if (!process.stdin.isTTY) {
      debugLogger.debug("Early input capture skipped: stdin is not a TTY");
    }
    return;
  }
  if (process.env["QWEN_CODE_DISABLE_EARLY_CAPTURE"] === "1") {
    debugLogger.debug("Early input capture disabled by environment variable");
    return;
  }
  isCapturing = true;
  inputBuffer = {
    chunks: [],
    totalBytes: 0,
    captured: false
  };
  pendingTerminalResponse = Buffer.alloc(0);
  debugLogger.debug("Starting early input capture");
  captureHandler = /* @__PURE__ */ __name((data) => {
    if (inputBuffer.captured) {
      return;
    }
    if (inputBuffer.totalBytes >= MAX_BUFFER_SIZE) {
      debugLogger.warn(
        `Early input capture buffer full (${MAX_BUFFER_SIZE} bytes). Stopping capture; additional keystrokes during startup will be lost.`
      );
      stopEarlyInputCapture();
      return;
    }
    const dataToFilter = pendingTerminalResponse.length > 0 ? Buffer.concat([pendingTerminalResponse, data]) : data;
    pendingTerminalResponse = Buffer.alloc(0);
    const { filtered, trailingPartialTerminalResponse } = filterTerminalResponses(dataToFilter);
    if (trailingPartialTerminalResponse.length > 0) {
      pendingTerminalResponse = Buffer.from(trailingPartialTerminalResponse);
    }
    if (filtered.length > 0) {
      const newLength = inputBuffer.totalBytes + filtered.length;
      if (newLength > MAX_BUFFER_SIZE) {
        const truncated = filtered.subarray(
          0,
          MAX_BUFFER_SIZE - inputBuffer.totalBytes
        );
        inputBuffer.chunks.push(Buffer.from(truncated));
        inputBuffer.totalBytes += truncated.length;
        debugLogger.debug(`Buffer truncated at ${MAX_BUFFER_SIZE} bytes`);
      } else {
        inputBuffer.chunks.push(Buffer.from(filtered));
        inputBuffer.totalBytes += filtered.length;
        debugLogger.debug(
          `Captured ${filtered.length} bytes (total: ${inputBuffer.totalBytes})`
        );
      }
    }
  }, "captureHandler");
  captureStdin = process.stdin;
  captureStdin.on("data", captureHandler);
}
__name(startEarlyInputCapture, "startEarlyInputCapture");
function stopEarlyInputCapture() {
  if (!isCapturing || !captureHandler || !captureStdin) {
    return;
  }
  captureStdin.removeListener("data", captureHandler);
  captureStdin = null;
  captureHandler = null;
  isCapturing = false;
  inputBuffer.captured = true;
  debugLogger.debug(
    `Stopped early input capture: ${inputBuffer.totalBytes} bytes`
  );
}
__name(stopEarlyInputCapture, "stopEarlyInputCapture");
function getAndClearCapturedInput() {
  const parts = [...inputBuffer.chunks];
  if (shouldReplayPendingAtStop(pendingTerminalResponse)) {
    parts.push(Buffer.from(pendingTerminalResponse));
  }
  const buffer = parts.length > 0 ? Buffer.concat(parts) : Buffer.alloc(0);
  inputBuffer.chunks = [];
  inputBuffer.totalBytes = 0;
  pendingTerminalResponse = Buffer.alloc(0);
  return buffer;
}
__name(getAndClearCapturedInput, "getAndClearCapturedInput");
function stopAndGetCapturedInput() {
  stopEarlyInputCapture();
  return getAndClearCapturedInput();
}
__name(stopAndGetCapturedInput, "stopAndGetCapturedInput");
function hasCapturedInput() {
  return inputBuffer.totalBytes > 0;
}
__name(hasCapturedInput, "hasCapturedInput");
function resetCaptureState() {
  if (captureHandler && captureStdin) {
    captureStdin.removeListener("data", captureHandler);
  } else if (captureHandler) {
    process.stdin.removeListener("data", captureHandler);
  }
  captureStdin = null;
  captureHandler = null;
  isCapturing = false;
  inputBuffer = {
    chunks: [],
    totalBytes: 0,
    captured: false
  };
  pendingTerminalResponse = Buffer.alloc(0);
}
__name(resetCaptureState, "resetCaptureState");

export {
  startEarlyInputCapture,
  stopEarlyInputCapture,
  getAndClearCapturedInput,
  stopAndGetCapturedInput,
  hasCapturedInput,
  resetCaptureState
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
