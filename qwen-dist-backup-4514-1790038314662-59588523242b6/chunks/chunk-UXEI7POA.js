// Force strict mode and setup for ESM
"use strict";
import {
  projectMediaPolicyToolDeclaration
} from "./chunk-MNU36NGH.js";
import {
  isPlainRecord
} from "./chunk-BQMSZSG6.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  SchemaValidator
} from "./chunk-ERIBG3BX.js";
import {
  getErrorMessage
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/policy/tools/media-policy-tool.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";
var DEFAULT_POLICY_TOOL_TIMEOUT_MS = 6e5;
var MEDIA_POLICY_IO_SCHEMA_PROPERTIES = {
  inputPath: {
    type: "string",
    description: "Absolute path of the source media file \u2014 including the path shown in a \u3010\u5A92\u4F53\u8DEF\u5F84\u3011 annotation for a local file you read. Provide exactly one of inputPath or resourceId."
  },
  resourceId: {
    type: "string",
    description: "Opaque session media handle (the media-<n>-<hex> form from a \u3010\u5A92\u4F53\u8D44\u6E90\u3011 annotation or a recall result) naming the source media. When the annotation instead shows an absolute path, pass that path as inputPath. Provide exactly one of inputPath or resourceId."
  },
  outputDir: {
    type: "string",
    description: "Absolute path of an existing directory the output file is written into; it is not created automatically."
  }
};
function resolvePolicyToolTimeoutMs(config, toolName) {
  const entry = config.getOmniPolicyToolsSettings?.()?.[toolName];
  const runtime = isPlainRecord(entry) && isPlainRecord(entry["runtime"]) ? entry["runtime"] : void 0;
  const timeoutMs = runtime?.["timeoutMs"];
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_POLICY_TOOL_TIMEOUT_MS;
}
__name(resolvePolicyToolTimeoutMs, "resolvePolicyToolTimeoutMs");
function resolvePolicyToolSettings(config, toolName) {
  const entry = config.getOmniPolicyToolsSettings?.()?.[toolName];
  const settings = isPlainRecord(entry) ? entry["settings"] : void 0;
  return isPlainRecord(settings) ? settings : {};
}
__name(resolvePolicyToolSettings, "resolvePolicyToolSettings");
function createPolicyToolTimeoutBudget(totalMs) {
  let deadline;
  return () => {
    const now = Date.now();
    deadline ??= now + totalMs;
    return Math.max(1, deadline - now);
  };
}
__name(createPolicyToolTimeoutBudget, "createPolicyToolTimeoutBudget");
function sharpTimeoutSeconds(timeoutMs) {
  return Math.max(1, Math.ceil(timeoutMs / 1e3));
}
__name(sharpTimeoutSeconds, "sharpTimeoutSeconds");
var BaseMediaPolicyToolInvocation = class extends BaseToolInvocation {
  static {
    __name(this, "BaseMediaPolicyToolInvocation");
  }
  getDefaultPermission() {
    return Promise.resolve("ask");
  }
};
var BaseMediaPolicyTool = class extends BaseDeclarativeTool {
  constructor(name, displayName, description, kind, parameterSchema, configView = {}) {
    super(name, displayName, description, kind, parameterSchema);
    this.configView = configView;
  }
  static {
    __name(this, "BaseMediaPolicyTool");
  }
  /** Memoized projection result, keyed on the settings-object identity it
   * was computed from ({@link schema}). */
  projectedSchema;
  /**
   * Model-visible declaration (decision D6): the single projection point
   * every declaration surface reads — the native schema minus
   * `modelAccess.lockedArguments` keys, narrowed to
   * `modelAccess.parameterSchema` when configured, with the optional
   * description override applied. Validation deliberately does NOT use
   * this projection (see {@link validateToolParams}).
   *
   * The projection is pure over (native schema, settings object), and the
   * config stores one normalized settings object per initialize() — so the
   * result is memoized on that object's identity, and a re-initialize
   * (which swaps the object) recomputes naturally.
   */
  get schema() {
    const settings = this.configView.getOmniPolicyToolsSettings?.();
    if (!this.projectedSchema || this.projectedSchema.settings !== settings) {
      this.projectedSchema = {
        settings,
        declaration: projectMediaPolicyToolDeclaration(this.configView, {
          name: this.name,
          description: this.description,
          parametersJsonSchema: this.parameterSchema,
          operatorOnlyParams: this.mediaPolicyDescriptor.operatorOnlyParams
        })
      };
    }
    return this.projectedSchema.declaration;
  }
  /**
   * Validate against the tool's NATIVE parameter schema, never the
   * model-visible `schema` getter: Stage B's modelAccess projection makes
   * `schema` a narrowed view (lockedArguments removed), while validation
   * must keep accepting the harness-injected arguments the projection
   * hides (policy design §9.4).
   */
  validateToolParams(params) {
    const errors = SchemaValidator.validate(this.parameterSchema, params);
    if (errors) {
      return errors;
    }
    return this.validateToolParamValues(params);
  }
  /** Every media-policy tool shares the io params; tools with extra
   * value-level rules override this and layer them on top. */
  validateToolParamValues(params) {
    return validateMediaPolicyIoParams(params);
  }
  /**
   * The other half of the Write/Edit permission posture these tools adopt:
   * without this override, the AUTO-mode classifier sees the empty-string
   * sentinel (`Arguments: {}`) and its path-based block rules can never
   * fire on a model-origin call. Project exactly the fields those rules
   * key on — the two filesystem paths carry no secrets.
   */
  toAutoClassifierInput(params) {
    return { inputPath: params.inputPath, outputDir: params.outputDir };
  }
};
var MAX_OUTPUT_STEM_LENGTH = 48;
function policyOutputStem(inputPath) {
  const raw = path.basename(inputPath, path.extname(inputPath));
  return raw.replace(/[^A-Za-z0-9._+-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_OUTPUT_STEM_LENGTH) || "media";
}
__name(policyOutputStem, "policyOutputStem");
function policyOutputFileName(params) {
  const stem = policyOutputStem(params.inputPath);
  const variant = params.variant ? `-${params.variant}` : "";
  return `${stem}-${params.operation}${variant}${params.extension}`;
}
__name(policyOutputFileName, "policyOutputFileName");
function validateMediaPolicyIoParams(params) {
  if (params.inputPath === void 0) {
    return "provide exactly one of inputPath (absolute path) or resourceId (opaque session media handle)";
  }
  if (!path.isAbsolute(params.inputPath)) {
    return `inputPath must be an absolute path (got ${JSON.stringify(params.inputPath)})`;
  }
  if (!path.isAbsolute(params.outputDir)) {
    return `outputDir must be an absolute path (got ${JSON.stringify(params.outputDir)})`;
  }
  return null;
}
__name(validateMediaPolicyIoParams, "validateMediaPolicyIoParams");
async function assertMediaPolicyIo(params) {
  let inputStat;
  try {
    inputStat = await fs.lstat(params.inputPath);
  } catch {
    throw new Error(`input file not found: ${path.basename(params.inputPath)}`);
  }
  if (!inputStat.isFile()) {
    throw new Error(
      `input is not a regular file: ${path.basename(params.inputPath)}`
    );
  }
  let outStat;
  try {
    outStat = await fs.lstat(params.outputDir);
  } catch {
    throw new Error(`output directory not found: ${params.outputDir}`);
  }
  if (!outStat.isDirectory()) {
    throw new Error(`output path is not a real directory: ${params.outputDir}`);
  }
  return { inputSizeBytes: inputStat.size };
}
__name(assertMediaPolicyIo, "assertMediaPolicyIo");
function formatBytesShort(bytes) {
  const trim = /* @__PURE__ */ __name((n) => (Math.round(n * 10) / 10).toString().replace(/\.0$/, ""), "trim");
  if (bytes >= 1024 ** 3) return `${trim(bytes / 1024 ** 3)}GB`;
  if (bytes >= 1024 ** 2) return `${trim(bytes / 1024 ** 2)}MB`;
  if (bytes >= 1024) return `${trim(bytes / 1024)}KB`;
  return `${bytes}B`;
}
__name(formatBytesShort, "formatBytesShort");
function describeChannels(channels) {
  if (channels === void 0) return "";
  if (channels === 1) return " \u5355\u58F0\u9053";
  if (channels === 2) return " \u7ACB\u4F53\u58F0";
  return ` ${channels}\u58F0\u9053`;
}
__name(describeChannels, "describeChannels");
function mediaPolicyToolError(message) {
  return {
    llmContent: `Error: ${message}`,
    returnDisplay: message,
    error: { message, type: "execution_failed" /* EXECUTION_FAILED */ }
  };
}
__name(mediaPolicyToolError, "mediaPolicyToolError");
function mediaPolicyToolFailure(error) {
  return mediaPolicyToolError(getErrorMessage(error));
}
__name(mediaPolicyToolFailure, "mediaPolicyToolFailure");
function ffmpegFailureMessage(run, action, inputPath) {
  return `ffmpeg failed (exit ${run.code}) ${action} ${path.basename(inputPath)}: ${run.stderr.slice(-500)}`;
}
__name(ffmpegFailureMessage, "ffmpegFailureMessage");
function mediaPolicyToolSuccess(args) {
  const outputPath = path.join(args.outputDir, args.outputFileName);
  const artifact = {
    kind: args.artifactKind,
    storage: "workspace",
    title: args.title,
    // Relative to the invocation's staging directory — the orchestrator
    // resolves and re-validates containment before promotion.
    workspacePath: args.outputFileName,
    mimeType: args.mimeType,
    sizeBytes: args.sizeBytes,
    metadata: args.role === void 0 ? { omniDisclosure: args.disclosure } : { omniDisclosure: args.disclosure, omniRole: args.role }
  };
  return {
    llmContent: `${args.title}: ${args.disclosure}
Output file: ${outputPath}
Use read_file with this absolute path to inspect the result.`,
    returnDisplay: args.disclosure,
    artifacts: [artifact]
  };
}
__name(mediaPolicyToolSuccess, "mediaPolicyToolSuccess");

export {
  MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
  resolvePolicyToolTimeoutMs,
  resolvePolicyToolSettings,
  createPolicyToolTimeoutBudget,
  sharpTimeoutSeconds,
  BaseMediaPolicyToolInvocation,
  BaseMediaPolicyTool,
  policyOutputStem,
  policyOutputFileName,
  assertMediaPolicyIo,
  formatBytesShort,
  describeChannels,
  mediaPolicyToolError,
  mediaPolicyToolFailure,
  ffmpegFailureMessage,
  mediaPolicyToolSuccess
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
