// Force strict mode and setup for ESM
"use strict";
import {
  skillRestrictionNames
} from "./chunk-IMV5DBIP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/config/skill-settings.ts
init_esbuild_shims();
function normalizeSkillNames(value) {
  if (!Array.isArray(value)) return /* @__PURE__ */ new Set();
  return new Set(
    value.filter((name) => typeof name === "string").map((name) => name.trim().toLowerCase()).filter(Boolean)
  );
}
__name(normalizeSkillNames, "normalizeSkillNames");
function skillSettingStrings(settings, scope, key) {
  const value = settings.forScope(scope).settings.skills?.[key];
  return Array.isArray(value) ? value.filter((name) => typeof name === "string") : [];
}
__name(skillSettingStrings, "skillSettingStrings");
function resolveSkillSettings(settings) {
  const hardDisabled = normalizeSkillNames(settings.merged.skills?.disabled);
  const defaultDisabled = normalizeSkillNames(
    settings.merged.skills?.defaultDisabled
  );
  const enabled = normalizeSkillNames(settings.merged.skills?.enabled);
  const disablements = /* @__PURE__ */ new Map();
  for (const name of defaultDisabled) {
    if (!enabled.has(name)) disablements.set(name, { reason: "default" });
  }
  const lockedScopes = [
    ["SystemDefaults" /* SystemDefaults */, "systemDefaults"],
    ["User" /* User */, "user"],
    ["System" /* System */, "system"]
  ];
  const lockedByName = /* @__PURE__ */ new Map();
  for (const [scope, label] of lockedScopes) {
    for (const name of normalizeSkillNames(
      skillSettingStrings(settings, scope, "disabled")
    )) {
      lockedByName.set(name, label);
    }
  }
  for (const name of hardDisabled) {
    const lockedScope = lockedByName.get(name);
    disablements.set(name, {
      reason: "hard",
      ...lockedScope ? { lockedScope } : {}
    });
  }
  return {
    disabledNames: new Set(disablements.keys()),
    defaultDisabledNames: defaultDisabled,
    enabledNames: enabled,
    disablements
  };
}
__name(resolveSkillSettings, "resolveSkillSettings");
function lookupSkillSetting(entries, skill) {
  for (const name of skillRestrictionNames(skill)) {
    const found = entries.get(name);
    if (found !== void 0) return found;
  }
  return void 0;
}
__name(lookupSkillSetting, "lookupSkillSetting");
function lookupSkillDisablement(disablements, skill) {
  let fallback;
  let hard;
  for (const name of skillRestrictionNames(skill)) {
    const found = disablements.get(name);
    if (found?.reason === "hard") {
      if (found.lockedScope) return found;
      hard ??= found;
      continue;
    }
    fallback ??= found;
  }
  return hard ?? fallback;
}
__name(lookupSkillDisablement, "lookupSkillDisablement");
function buildHigherDisabled(settings) {
  const scopeOfEntry = /* @__PURE__ */ new Map();
  for (const [scope, label] of [
    ["SystemDefaults" /* SystemDefaults */, "SystemDefaults"],
    ["User" /* User */, "User"],
    ["System" /* System */, "System"]
  ]) {
    for (const name of normalizeSkillNames(
      skillSettingStrings(settings, scope, "disabled")
    )) {
      scopeOfEntry.set(name, label);
    }
  }
  const hardEntries = /* @__PURE__ */ new Map();
  const defaultEntries = /* @__PURE__ */ new Map();
  for (const [scope, label] of [
    ["SystemDefaults" /* SystemDefaults */, "SystemDefaults"],
    ["User" /* User */, "User"],
    ["Workspace" /* Workspace */, "Workspace"],
    ["System" /* System */, "System"]
  ]) {
    if (scope === "Workspace" /* Workspace */ && !settings.isTrusted) continue;
    for (const name of normalizeSkillNames(
      skillSettingStrings(settings, scope, "disabled")
    )) {
      hardEntries.set(name, label);
    }
    for (const name of normalizeSkillNames(
      skillSettingStrings(settings, scope, "defaultDisabled")
    )) {
      defaultEntries.set(name, label);
    }
  }
  const enabledEntries = new Set(
    [
      "SystemDefaults" /* SystemDefaults */,
      "User" /* User */,
      "System" /* System */,
      ...settings.isTrusted ? ["Workspace" /* Workspace */] : []
    ].flatMap((scope) => [
      ...normalizeSkillNames(skillSettingStrings(settings, scope, "enabled"))
    ])
  );
  const workspaceDisabled = new Set(
    settings.isTrusted ? normalizeSkillNames(
      skillSettingStrings(settings, "Workspace" /* Workspace */, "disabled")
    ) : []
  );
  const blockIn = /* @__PURE__ */ __name((skill) => {
    const registry = skill.name.trim().toLowerCase();
    const spellings = skillRestrictionNames(skill);
    for (const spelling of spellings) {
      const scope = scopeOfEntry.get(spelling);
      if (scope) {
        return { reason: "hard", list: "disabled", entry: spelling, scope };
      }
    }
    for (const spelling of spellings) {
      const hard = hardEntries.get(spelling);
      if (hard) {
        if (spelling === registry && workspaceDisabled.has(spelling)) {
          continue;
        }
        return {
          reason: "hard",
          list: "disabled",
          entry: spelling,
          scope: hard
        };
      }
      const def = defaultEntries.get(spelling);
      if (def) {
        if (spelling === registry || enabledEntries.has(spelling)) continue;
        return {
          reason: "default",
          list: "defaultDisabled",
          entry: spelling,
          scope: def
        };
      }
    }
    return null;
  }, "blockIn");
  return {
    blockIn,
    lockedIn: /* @__PURE__ */ __name((skill) => {
      const block = blockIn(skill);
      if (!block) return null;
      if (block.reason === "hard" && block.scope !== "Workspace") {
        return block.scope;
      }
      return `skills.${block.list} '${block.entry}' (${block.scope})`;
    }, "lockedIn")
  };
}
__name(buildHigherDisabled, "buildHigherDisabled");
function skillToggleBlockForName(settings, skill) {
  return buildHigherDisabled(settings).blockIn(skill);
}
__name(skillToggleBlockForName, "skillToggleBlockForName");
function updateTarget(names, skillName, include) {
  const normalizedName = skillName.trim().toLowerCase();
  const next = [];
  let found = false;
  for (const name of names) {
    if (name.trim().toLowerCase() !== normalizedName) {
      next.push(name);
    } else if (include && !found) {
      next.push(skillName);
      found = true;
    }
  }
  if (include && !found) next.push(skillName);
  return next;
}
__name(updateTarget, "updateTarget");
function updateWorkspaceSkillSettingLists(lists, skillName, enabled) {
  if (enabled) {
    return {
      disabled: updateTarget(lists.disabled, skillName, false),
      enabled: updateTarget(lists.enabled, skillName, true)
    };
  }
  return {
    disabled: updateTarget(lists.disabled, skillName, true),
    enabled: updateTarget(lists.enabled, skillName, false)
  };
}
__name(updateWorkspaceSkillSettingLists, "updateWorkspaceSkillSettingLists");
function computeWorkspaceSkillListUpdates(workspaceDisabled, workspaceEnabled, toggles) {
  const previousDisabled = [...workspaceDisabled];
  const previousEnabled = [...workspaceEnabled];
  let next = {
    disabled: previousDisabled,
    enabled: previousEnabled
  };
  for (const toggle of toggles) {
    if (toggle.wasEnabled === toggle.isEnabled) continue;
    next = updateWorkspaceSkillSettingLists(
      next,
      toggle.name,
      toggle.isEnabled
    );
  }
  return {
    disabled: next.disabled,
    enabled: next.enabled,
    disabledChanged: JSON.stringify(previousDisabled) !== JSON.stringify(next.disabled),
    enabledChanged: JSON.stringify(previousEnabled) !== JSON.stringify(next.enabled)
  };
}
__name(computeWorkspaceSkillListUpdates, "computeWorkspaceSkillListUpdates");

export {
  normalizeSkillNames,
  skillSettingStrings,
  resolveSkillSettings,
  lookupSkillSetting,
  lookupSkillDisablement,
  buildHigherDisabled,
  skillToggleBlockForName,
  updateWorkspaceSkillSettingLists,
  computeWorkspaceSkillListUpdates
};
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
