// Force strict mode and setup for ESM
"use strict";
import {
  writeStderrLine
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/uncaught-exception-handler.ts
init_esbuild_shims();
function getErrnoCode(error) {
  if (!error || typeof error !== "object") {
    return void 0;
  }
  const code = error.code;
  return typeof code === "string" ? code : void 0;
}
__name(getErrnoCode, "getErrnoCode");
function isExpectedPtyRaceError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message;
  const code = getErrnoCode(error);
  if (code === "EIO" && message.includes("read") || message.includes("read EIO") || code === "EIO" && message.includes("write") || message.includes("write EIO")) {
    return true;
  }
  if (code === "EAGAIN" && message.includes("read") || message.includes("read EAGAIN")) {
    return true;
  }
  return message.includes("ioctl(2) failed, EBADF") || message.includes("Cannot resize a pty that has already exited");
}
__name(isExpectedPtyRaceError, "isExpectedPtyRaceError");
function handleUncaughtException(error) {
  if (isExpectedPtyRaceError(error)) {
    return;
  }
  if (error instanceof Error) {
    writeStderrLine(error.stack ?? error.message);
  } else {
    writeStderrLine(String(error));
  }
  process.exit(1);
}
__name(handleUncaughtException, "handleUncaughtException");

export {
  isExpectedPtyRaceError,
  handleUncaughtException
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
