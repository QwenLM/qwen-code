// Force strict mode and setup for ESM
"use strict";
import {
  lookupSkillDisablement
} from "./chunk-PXA6DGTN.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/runtime/workspace-skills-mapping.ts
init_esbuild_shims();
function mapSkillConfigToStatus(skill, disablements = /* @__PURE__ */ new Map(), opts = {}) {
  const disablement = lookupSkillDisablement(disablements, skill);
  const disabledReason = opts.disabled ? "inactive_extension" : disablement?.reason ?? (opts.enabled === false ? "default" : void 0);
  const modelInvocable = skill.disableModelInvocation !== true;
  return {
    kind: "skill",
    status: disabledReason ? "disabled" : "ok",
    name: skill.name,
    description: skill.description,
    level: skill.level,
    modelInvocable,
    ...disabledReason ? { disabledReason } : {},
    ...!opts.disabled && disablement?.lockedScope ? { lockedScope: disablement.lockedScope } : {},
    ...skill.userInvocable === false ? { userInvocable: false } : {},
    installedPath: skill.filePath,
    ...skill.argumentHint ? { argumentHint: skill.argumentHint } : {},
    ...skill.model ? { model: skill.model } : {},
    ...skill.level === "extension" && skill.extensionName ? { extensionName: skill.extensionName } : {},
    ...skill.level === "extension" && skill.extensionDisplayName ? { extensionDisplayName: skill.extensionDisplayName } : {}
  };
}
__name(mapSkillConfigToStatus, "mapSkillConfigToStatus");

export {
  mapSkillConfigToStatus
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
