// Force strict mode and setup for ESM
"use strict";
import {
  SessionOrganizationService
} from "./chunk-MRTRBONQ.js";
import {
  writeStderrLine
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/session-organization-helpers.ts
init_esbuild_shims();
function createSessionOrganizationService(workspaceCwd) {
  return new SessionOrganizationService(workspaceCwd, (message) => {
    writeStderrLine(`qwen serve: session-org: ${message}`);
  });
}
__name(createSessionOrganizationService, "createSessionOrganizationService");

export {
  createSessionOrganizationService
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
