// Force strict mode and setup for ESM
"use strict";
import {
  themeManager
} from "./chunk-S7BE3FMA.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";

// packages/cli/src/ui/semantic-colors.ts
init_esbuild_shims();
var theme = {
  get text() {
    return themeManager.getSemanticColors().text;
  },
  get background() {
    return themeManager.getSemanticColors().background;
  },
  get border() {
    return themeManager.getSemanticColors().border;
  },
  get ui() {
    return themeManager.getSemanticColors().ui;
  },
  get status() {
    return themeManager.getSemanticColors().status;
  }
};

export {
  theme
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
