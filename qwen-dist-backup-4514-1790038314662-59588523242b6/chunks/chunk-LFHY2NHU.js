// Force strict mode and setup for ESM
"use strict";
import {
  parseRule
} from "./chunk-MRTRBONQ.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/config/permission-settings.ts
init_esbuild_shims();
var PERMISSION_RULE_TYPES = ["allow", "ask", "deny"];
var MAX_PERMISSION_RULES_COUNT = 500;
var MAX_PERMISSION_RULE_LENGTH = 512;
var PermissionRulesValidationError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "PermissionRulesValidationError";
  }
  static {
    __name(this, "PermissionRulesValidationError");
  }
};
function isPermissionRuleType(value) {
  return typeof value === "string" && PERMISSION_RULE_TYPES.includes(value);
}
__name(isPermissionRuleType, "isPermissionRuleType");
function readPermissionRuleSet(settings) {
  const permissions = settings && typeof settings === "object" ? settings.permissions : void 0;
  const readRules = /* @__PURE__ */ __name((type) => {
    const value = permissions?.[type];
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  }, "readRules");
  return {
    allow: readRules("allow"),
    ask: readRules("ask"),
    deny: readRules("deny")
  };
}
__name(readPermissionRuleSet, "readPermissionRuleSet");
function normalizePermissionRules(value, opts) {
  const inputRules = normalizePermissionRuleInputs(value);
  const result = [];
  const seen = /* @__PURE__ */ new Set();
  const existingRules = new Set(
    (opts?.existingRules ?? []).map((rule) => rule.trim())
  );
  for (const rule of inputRules) {
    if (parseRule(rule).invalid) {
      if (existingRules.has(rule)) {
        if (!seen.has(rule)) {
          seen.add(rule);
          result.push(rule);
        }
        continue;
      }
      throw new PermissionRulesValidationError(
        `Malformed permission rule: ${rule}`,
        "invalid_rules"
      );
    }
    if (!seen.has(rule)) {
      seen.add(rule);
      result.push(rule);
    }
  }
  return result;
}
__name(normalizePermissionRules, "normalizePermissionRules");
function normalizePermissionRuleInputs(value) {
  if (!Array.isArray(value)) {
    throw new PermissionRulesValidationError(
      "rules must be an array",
      "invalid_rules"
    );
  }
  if (value.length > MAX_PERMISSION_RULES_COUNT) {
    throw new PermissionRulesValidationError(
      `rules array exceeds ${MAX_PERMISSION_RULES_COUNT} entries`,
      "invalid_rules"
    );
  }
  const result = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new PermissionRulesValidationError(
        "rules must contain only non-empty strings",
        "invalid_rules"
      );
    }
    const rule = item.trim();
    if (rule.length > MAX_PERMISSION_RULE_LENGTH) {
      throw new PermissionRulesValidationError(
        `rule exceeds ${MAX_PERMISSION_RULE_LENGTH}-character limit`,
        "invalid_rules"
      );
    }
    result.push(rule);
  }
  return result;
}
__name(normalizePermissionRuleInputs, "normalizePermissionRuleInputs");
function buildPermissionSettings(settings) {
  return {
    v: 1,
    user: {
      path: settings.user.path,
      rules: readPermissionRuleSet(settings.user.settings)
    },
    workspace: {
      path: settings.workspace.path,
      rules: readPermissionRuleSet(settings.workspace.settings)
    },
    merged: readPermissionRuleSet(settings.merged),
    isTrusted: settings.isTrusted
  };
}
__name(buildPermissionSettings, "buildPermissionSettings");

export {
  PERMISSION_RULE_TYPES,
  PermissionRulesValidationError,
  isPermissionRuleType,
  readPermissionRuleSet,
  normalizePermissionRules,
  buildPermissionSettings
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
