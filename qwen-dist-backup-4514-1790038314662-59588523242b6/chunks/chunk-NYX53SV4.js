// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/utils/kittyProtocolDetector.ts
init_esbuild_shims();
var detectionComplete = false;
var protocolSupported = false;
var protocolEnabled = false;
var KITTY_KEYBOARD_PUSH = "\x1B[>1u";
var KITTY_KEYBOARD_POP = "\x1B[<u";
function enableProtocol() {
  process.stdout.write(KITTY_KEYBOARD_PUSH);
  protocolEnabled = true;
}
__name(enableProtocol, "enableProtocol");
async function detectAndEnableKittyProtocol() {
  if (detectionComplete) {
    return protocolSupported;
  }
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      detectionComplete = true;
      resolve(false);
      return;
    }
    const originalRawMode = process.stdin.isRaw;
    if (!originalRawMode) {
      process.stdin.setRawMode(true);
    }
    let responseBuffer = "";
    let progressiveEnhancementReceived = false;
    let timeoutId;
    const onTimeout = /* @__PURE__ */ __name(() => {
      timeoutId = void 0;
      process.stdin.removeListener("data", handleData);
      const drainHandler = /* @__PURE__ */ __name(() => {
      }, "drainHandler");
      process.stdin.on("data", drainHandler);
      setTimeout(() => {
        process.stdin.removeListener("data", drainHandler);
        if (!originalRawMode) {
          process.stdin.setRawMode(false);
        }
        detectionComplete = true;
        resolve(false);
      }, 100);
    }, "onTimeout");
    const handleData = /* @__PURE__ */ __name((data) => {
      if (timeoutId === void 0) {
        return;
      }
      responseBuffer += data.toString();
      if (responseBuffer.includes("\x1B[?") && responseBuffer.includes("u")) {
        progressiveEnhancementReceived = true;
        clearTimeout(timeoutId);
        timeoutId = setTimeout(onTimeout, 1e3);
      }
      if (responseBuffer.includes("\x1B[?") && responseBuffer.includes("c")) {
        clearTimeout(timeoutId);
        timeoutId = void 0;
        process.stdin.removeListener("data", handleData);
        if (!originalRawMode) {
          process.stdin.setRawMode(false);
        }
        if (progressiveEnhancementReceived) {
          protocolSupported = true;
          enableProtocol();
          process.on("exit", disableProtocol);
        }
        detectionComplete = true;
        resolve(protocolSupported);
      }
    }, "handleData");
    process.stdin.on("data", handleData);
    process.stdout.write("\x1B[?u");
    process.stdout.write("\x1B[c");
    timeoutId = setTimeout(onTimeout, 200);
  });
}
__name(detectAndEnableKittyProtocol, "detectAndEnableKittyProtocol");
function disableProtocol() {
  if (protocolEnabled) {
    process.stdout.write(KITTY_KEYBOARD_POP);
    protocolEnabled = false;
  }
}
__name(disableProtocol, "disableProtocol");
function pushKittyProtocolFlags() {
  if (protocolSupported) {
    enableProtocol();
  }
}
__name(pushKittyProtocolFlags, "pushKittyProtocolFlags");
function disableKittyProtocol() {
  disableProtocol();
}
__name(disableKittyProtocol, "disableKittyProtocol");
function isKittyProtocolEnabled() {
  return protocolEnabled;
}
__name(isKittyProtocolEnabled, "isKittyProtocolEnabled");
function isKittyProtocolSupported() {
  return protocolSupported;
}
__name(isKittyProtocolSupported, "isKittyProtocolSupported");

export {
  detectAndEnableKittyProtocol,
  pushKittyProtocolFlags,
  disableKittyProtocol,
  isKittyProtocolEnabled,
  isKittyProtocolSupported
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
