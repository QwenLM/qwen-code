// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";

// packages/core/src/utils/promptIdContext.ts
init_esbuild_shims();
import { AsyncLocalStorage } from "node:async_hooks";
var promptIdContext = new AsyncLocalStorage();
var todoWorkChainContext = new AsyncLocalStorage();

export {
  promptIdContext,
  todoWorkChainContext
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
