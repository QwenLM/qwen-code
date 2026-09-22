// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/stdioHelpers.ts
init_esbuild_shims();
var writeStdoutLine = /* @__PURE__ */ __name((message) => {
  process.stdout.write(message.endsWith("\n") ? message : `${message}
`);
}, "writeStdoutLine");
var writeStderrLine = /* @__PURE__ */ __name((message) => {
  process.stderr.write(message.endsWith("\n") ? message : `${message}
`);
}, "writeStderrLine");
var writeStdoutLineSafe = /* @__PURE__ */ __name((message) => {
  try {
    writeStdoutLine(message);
  } catch {
  }
}, "writeStdoutLineSafe");
var writeStderrLineSafe = /* @__PURE__ */ __name((message) => {
  try {
    writeStderrLine(message);
  } catch {
  }
}, "writeStderrLineSafe");
var clearScreen = /* @__PURE__ */ __name(() => {
  console.clear();
}, "clearScreen");
var ignoreBrokenPipe = /* @__PURE__ */ __name(() => {
  process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") process.stdout.destroy();
  });
  process.stderr.on("error", (err) => {
    if (err.code === "EPIPE") process.stderr.destroy();
  });
}, "ignoreBrokenPipe");

export {
  writeStdoutLine,
  writeStderrLine,
  writeStdoutLineSafe,
  writeStderrLineSafe,
  clearScreen,
  ignoreBrokenPipe
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
