// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/workspace-service/types.ts
init_esbuild_shims();
var WorkspaceSettingsPartialPersistError = class extends Error {
  static {
    __name(this, "WorkspaceSettingsPartialPersistError");
  }
  committedWrites;
  cause;
  constructor(message, committedWrites, cause) {
    super(message);
    this.name = "WorkspaceSettingsPartialPersistError";
    this.committedWrites = committedWrites;
    this.cause = cause;
  }
};
var WorkspacePermissionRulesSessionRequiredError = class extends Error {
  static {
    __name(this, "WorkspacePermissionRulesSessionRequiredError");
  }
  constructor() {
    super(
      "setWorkspacePermissionRules requires a live ACP session to update active permission rules"
    );
    this.name = "WorkspacePermissionRulesSessionRequiredError";
  }
};
var WorkspaceSkillNotFoundError = class extends Error {
  constructor(skillName) {
    super(`Skill not found: ${skillName}`);
    this.skillName = skillName;
    this.name = "WorkspaceSkillNotFoundError";
  }
  static {
    __name(this, "WorkspaceSkillNotFoundError");
  }
};
function mapWorkspaceSkillToggleError(error) {
  if (error instanceof WorkspaceSkillNotFoundError) {
    return {
      skillName: error.skillName,
      code: "skill_not_found",
      error: error.message
    };
  }
  return void 0;
}
__name(mapWorkspaceSkillToggleError, "mapWorkspaceSkillToggleError");

export {
  WorkspaceSettingsPartialPersistError,
  WorkspacePermissionRulesSessionRequiredError,
  WorkspaceSkillNotFoundError,
  mapWorkspaceSkillToggleError
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
