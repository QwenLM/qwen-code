// Force strict mode and setup for ESM
"use strict";
import {
  isPlainRecord
} from "./chunk-BQMSZSG6.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/services/media-memory/registry.ts
init_esbuild_shims();
import { randomBytes } from "node:crypto";
var MediaResourceRegistry = class {
  static {
    __name(this, "MediaResourceRegistry");
  }
  byResourceId = /* @__PURE__ */ new Map();
  byVersionId = /* @__PURE__ */ new Map();
  counter = 0;
  /** Bind (or return the existing binding of) one file version. */
  bind(input) {
    const existing = this.byVersionId.get(input.fileVersionId);
    if (existing) {
      this.byVersionId.delete(input.fileVersionId);
      this.byVersionId.set(input.fileVersionId, existing);
      return existing;
    }
    const resourceId = `media-${++this.counter}-${randomBytes(4).toString("hex")}`;
    const binding = { resourceId, ...input };
    this.byResourceId.set(resourceId, binding);
    this.byVersionId.set(input.fileVersionId, binding);
    return binding;
  }
  /** Resolve a model-supplied handle. Undefined = never issued in this
   * session (an unauthorized or fabricated id — callers must reject). */
  resolve(resourceId) {
    return this.byResourceId.get(resourceId);
  }
  /** Look up the binding already issued for a version, if any. */
  resolveVersion(fileVersionId) {
    return this.byVersionId.get(fileVersionId);
  }
  /** Look up a binding by its harness-side locator. Lets collection paths
   * that only hold a resolved `inputPath` (a gated model call, where the
   * gate already turned the handle back into a path) recover the memory
   * identity without re-hashing the file, and lets recall reverse a
   * path-form annotation back to its handle.
   *
   * When the same locator has been bound more than once this session (the
   * same file re-read after its bytes changed, minting a distinct version),
   * the LATEST-DELIVERED binding wins: a path names "the file at this path",
   * and the most recently delivered version is the one the model is
   * currently looking at — including after a revert to previously-seen bytes,
   * because `bind` refreshes a re-delivered version's position. A path cannot
   * name an older version — that ambiguity is the price of showing the path
   * instead of the version-specific handle, and two path annotations for two
   * versions in ONE request collapse to the latest. */
  resolveByFileRef(fileRef) {
    let latest;
    for (const binding of this.byVersionId.values()) {
      if (binding.fileRef === fileRef) latest = binding;
    }
    return latest;
  }
  /** Every locator this session currently has a handle for. GC treats
   * these as roots alongside the memory snapshot: a resource delivered
   * THIS turn may be bound here before its memory commit lands, and the
   * sweep must not win that race. */
  activeFileRefs() {
    const refs = /* @__PURE__ */ new Set();
    for (const binding of this.byVersionId.values()) {
      refs.add(binding.fileRef);
    }
    return [...refs];
  }
};
function resolveMediaReference(registry, reference) {
  return registry.resolve(reference) ?? registry.resolveByFileRef(reference);
}
__name(resolveMediaReference, "resolveMediaReference");

// packages/core/src/omni/policy/model-access.ts
init_esbuild_shims();
function resolveMediaPolicyModelAccess(config, toolName) {
  const entry = config.getOmniPolicyToolsSettings?.()?.[toolName];
  const modelAccess = isPlainRecord(entry) && isPlainRecord(entry["modelAccess"]) ? entry["modelAccess"] : void 0;
  return {
    enabled: modelAccess?.enabled === true,
    defaultArguments: isPlainRecord(modelAccess?.defaultArguments) ? modelAccess.defaultArguments : {},
    lockedArguments: isPlainRecord(modelAccess?.lockedArguments) ? modelAccess.lockedArguments : {},
    description: typeof modelAccess?.description === "string" && modelAccess.description !== "" ? modelAccess.description : void 0,
    parameterSchema: isPlainRecord(modelAccess?.parameterSchema) ? modelAccess.parameterSchema : void 0
  };
}
__name(resolveMediaPolicyModelAccess, "resolveMediaPolicyModelAccess");
function projectMediaPolicyToolDeclaration(config, native) {
  const access = resolveMediaPolicyModelAccess(config, native.name);
  const description = access.description ?? native.description;
  const schema = isPlainRecord(native.parametersJsonSchema) ? native.parametersJsonSchema : void 0;
  const nativeProps = schema && isPlainRecord(schema["properties"]) ? schema["properties"] : void 0;
  if (!schema || !nativeProps) {
    return {
      name: native.name,
      description,
      parametersJsonSchema: native.parametersJsonSchema
    };
  }
  const lockedKeys = /* @__PURE__ */ new Set([
    ...Object.keys(access.lockedArguments),
    ...native.operatorOnlyParams ?? []
  ]);
  const narrowProps = access.parameterSchema && isPlainRecord(access.parameterSchema["properties"]) ? access.parameterSchema["properties"] : void 0;
  const properties = {};
  for (const [key, value] of Object.entries(nativeProps)) {
    if (lockedKeys.has(key)) continue;
    if (narrowProps && !(key in narrowProps)) continue;
    const override = narrowProps?.[key];
    properties[key] = isPlainRecord(override) && isPlainRecord(value) ? { ...value, ...override } : value;
  }
  const required = Array.isArray(schema["required"]) ? schema["required"].filter(
    (key) => typeof key === "string" && key in properties
  ) : void 0;
  return {
    name: native.name,
    description,
    parametersJsonSchema: {
      ...schema,
      properties,
      ...required !== void 0 ? { required } : {}
    }
  };
}
__name(projectMediaPolicyToolDeclaration, "projectMediaPolicyToolDeclaration");
function isMediaPolicyToolHiddenFromModel(config, tool) {
  if (!tool.mediaPolicyDescriptor) return false;
  return !resolveMediaPolicyModelAccess(config, tool.name).enabled;
}
__name(isMediaPolicyToolHiddenFromModel, "isMediaPolicyToolHiddenFromModel");
function evaluateMediaPolicyToolCall(params) {
  const { config, tool } = params;
  let args = params.args;
  const origin = params.executionOrigin ?? { kind: "model" };
  if (origin.kind === "fixed_policy") {
    if (!tool.mediaPolicyDescriptor) {
      return {
        outcome: "reject",
        reason: "execution_denied",
        message: `Tool "${tool.name}" cannot run with a fixed-policy execution origin: it is not a media policy tool.`
      };
    }
    return { outcome: "pass", args };
  }
  if (!tool.mediaPolicyDescriptor) {
    return { outcome: "pass", args };
  }
  const access = resolveMediaPolicyModelAccess(config, tool.name);
  if (!access.enabled) {
    return {
      outcome: "reject",
      reason: "execution_denied",
      message: `Tool "${tool.name}" is an omni media policy tool reserved for fixed-policy orchestration. Direct calls require "omni.processing.policyTools.${tool.name}.modelAccess.enabled": true.`
    };
  }
  if (typeof args["resourceId"] === "string") {
    if (args["inputPath"] !== void 0) {
      return {
        outcome: "reject",
        reason: "invalid_params",
        message: `Invalid parameters for tool "${tool.name}": provide exactly one of "inputPath" or "resourceId", not both.`
      };
    }
    const registry = config.getOmniMediaResourceRegistry?.();
    const binding = registry ? resolveMediaReference(registry, args["resourceId"]) : void 0;
    if (!binding) {
      return {
        outcome: "reject",
        reason: "invalid_params",
        message: `Invalid parameters for tool "${tool.name}": resourceId "${args["resourceId"]}" matches no media delivered this session. Use a handle or the absolute path from a \u3010\u5A92\u4F53\u8D44\u6E90\u3011 annotation or a recall result.`
      };
    }
    const accepted = tool.mediaPolicyDescriptor.inputMediaTypes;
    if (accepted !== void 0 && !accepted.includes(binding.mediaType)) {
      return {
        outcome: "reject",
        reason: "invalid_params",
        message: `Invalid parameters for tool "${tool.name}": resourceId "${args["resourceId"]}" names ${binding.mediaType} media, but this tool accepts ${accepted.join(", ")}. Pass a handle whose media type matches.`
      };
    }
    const { resourceId: _resourceId, ...rest } = args;
    args = { ...rest, inputPath: binding.fileRef };
  }
  const lockedKeys = Object.keys(access.lockedArguments);
  const violations = lockedKeys.filter(
    (key) => Object.prototype.hasOwnProperty.call(args, key)
  );
  if (violations.length > 0) {
    return {
      outcome: "reject",
      reason: "invalid_params",
      message: `Invalid parameters for tool "${tool.name}": ${violations.map((k) => `"${k}"`).join(", ")} ${violations.length === 1 ? "is" : "are"} locked by configuration and must not be provided. Remove ${violations.length === 1 ? "it" : "them"} and retry.`
    };
  }
  const operatorViolations = (tool.mediaPolicyDescriptor.operatorOnlyParams ?? []).filter((key) => Object.prototype.hasOwnProperty.call(args, key));
  if (operatorViolations.length > 0) {
    return {
      outcome: "reject",
      reason: "invalid_params",
      message: `Invalid parameters for tool "${tool.name}": ${operatorViolations.map((k) => `"${k}"`).join(", ")} ${operatorViolations.length === 1 ? "is" : "are"} operator-only (set via omni.processing.policyTools.${tool.name} configuration) and must not be provided by the caller. Remove ${operatorViolations.length === 1 ? "it" : "them"} and retry.`
    };
  }
  return {
    outcome: "pass",
    args: { ...access.defaultArguments, ...args, ...access.lockedArguments }
  };
}
__name(evaluateMediaPolicyToolCall, "evaluateMediaPolicyToolCall");

export {
  MediaResourceRegistry,
  resolveMediaReference,
  resolveMediaPolicyModelAccess,
  projectMediaPolicyToolDeclaration,
  isMediaPolicyToolHiddenFromModel,
  evaluateMediaPolicyToolCall
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
