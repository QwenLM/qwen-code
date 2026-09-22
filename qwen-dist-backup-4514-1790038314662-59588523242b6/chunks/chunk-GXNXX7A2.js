// Force strict mode and setup for ESM
"use strict";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/xml.ts
init_esbuild_shims();
function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
__name(escapeXml, "escapeXml");
function escapeXmlElementText(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
__name(escapeXmlElementText, "escapeXmlElementText");
var XML_TAG_CANDIDATE_RE = /<[^<>]*>/g;
function isXmlWhitespace(char) {
  return char !== void 0 && /\s/.test(char);
}
__name(isXmlWhitespace, "isXmlWhitespace");
function isSystemReminderTagIgnorable(char) {
  const codePoint = char.codePointAt(0);
  if (codePoint === void 0) return false;
  return codePoint === 173 || codePoint === 1564 || codePoint === 12644 || codePoint === 65279 || codePoint === 65440 || codePoint >= 0 && codePoint <= 31 || codePoint >= 127 && codePoint <= 159 || codePoint >= 4447 && codePoint <= 4448 || codePoint >= 6068 && codePoint <= 6069 || codePoint >= 6155 && codePoint <= 6159 || codePoint >= 8203 && codePoint <= 8207 || codePoint >= 8234 && codePoint <= 8238 || codePoint >= 8288 && codePoint <= 8303 || codePoint >= 65024 && codePoint <= 65039 || codePoint >= 65520 && codePoint <= 65528 || codePoint >= 113824 && codePoint <= 113827 || codePoint >= 119155 && codePoint <= 119162 || codePoint >= 917504 && codePoint <= 921599;
}
__name(isSystemReminderTagIgnorable, "isSystemReminderTagIgnorable");
function normalizeSystemReminderCandidateTag(tag) {
  let normalized = "";
  for (const char of tag) {
    if (!isSystemReminderTagIgnorable(char)) {
      normalized += char;
    }
  }
  return normalized.toLowerCase();
}
__name(normalizeSystemReminderCandidateTag, "normalizeSystemReminderCandidateTag");
function getSystemReminderTagKind(tag) {
  const normalized = normalizeSystemReminderCandidateTag(tag);
  const len = normalized.length;
  if (len < 2 || normalized[0] !== "<" || normalized[len - 1] !== ">") {
    return void 0;
  }
  let i = 1;
  while (i < len && isXmlWhitespace(normalized[i])) i++;
  let closing = false;
  if (normalized[i] === "/") {
    closing = true;
    i++;
  }
  while (i < len && isXmlWhitespace(normalized[i])) i++;
  const TAG_NAME = "system-reminder";
  if (normalized.slice(i, i + TAG_NAME.length) !== TAG_NAME) {
    return void 0;
  }
  i += TAG_NAME.length;
  if (i < len - 1 && isXmlWhitespace(normalized[i])) {
    while (i < len && isXmlWhitespace(normalized[i])) i++;
    while (i < len && normalized[i] !== ">") i++;
  }
  while (i < len && isXmlWhitespace(normalized[i])) i++;
  if (normalized[i] === "/") i++;
  while (i < len && isXmlWhitespace(normalized[i])) i++;
  if (i !== len - 1 || normalized[i] !== ">") {
    return void 0;
  }
  return closing ? "closing" : "other";
}
__name(getSystemReminderTagKind, "getSystemReminderTagKind");
function escapeSystemReminderTag(tag) {
  const tagKind = getSystemReminderTagKind(tag);
  if (tagKind === "closing") {
    return "<\\/system-reminder>";
  }
  if (tagKind === "other") {
    return escapeXml(tag);
  }
  return tag;
}
__name(escapeSystemReminderTag, "escapeSystemReminderTag");
function escapeSystemReminderTags(text) {
  return text.replace(XML_TAG_CANDIDATE_RE, escapeSystemReminderTag);
}
__name(escapeSystemReminderTags, "escapeSystemReminderTags");

// packages/core/src/hooks/types.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("TRUSTED_HOOKS");
var HookEventName = /* @__PURE__ */ ((HookEventName2) => {
  HookEventName2["PreToolUse"] = "PreToolUse";
  HookEventName2["PostToolUse"] = "PostToolUse";
  HookEventName2["PostToolUseFailure"] = "PostToolUseFailure";
  HookEventName2["PostToolBatch"] = "PostToolBatch";
  HookEventName2["Notification"] = "Notification";
  HookEventName2["UserPromptSubmit"] = "UserPromptSubmit";
  HookEventName2["UserPromptExpansion"] = "UserPromptExpansion";
  HookEventName2["SessionStart"] = "SessionStart";
  HookEventName2["Stop"] = "Stop";
  HookEventName2["MessageDisplay"] = "MessageDisplay";
  HookEventName2["SubagentStart"] = "SubagentStart";
  HookEventName2["SubagentStop"] = "SubagentStop";
  HookEventName2["PreCompact"] = "PreCompact";
  HookEventName2["PostCompact"] = "PostCompact";
  HookEventName2["SessionEnd"] = "SessionEnd";
  HookEventName2["SessionDelete"] = "SessionDelete";
  HookEventName2["PermissionRequest"] = "PermissionRequest";
  HookEventName2["PermissionDenied"] = "PermissionDenied";
  HookEventName2["StopFailure"] = "StopFailure";
  HookEventName2["TodoCreated"] = "TodoCreated";
  HookEventName2["TodoCompleted"] = "TodoCompleted";
  HookEventName2["InstructionsLoaded"] = "InstructionsLoaded";
  return HookEventName2;
})(HookEventName || {});
var HOOKS_CONFIG_FIELDS = ["enabled", "disabled", "notifications"];
function getHookKey(hook) {
  const name = hook.name ?? "";
  switch (hook.type) {
    case "command" /* Command */:
      return name ? `${name}:${hook.command}` : hook.command;
    case "http" /* Http */:
      return name ? `${name}:${hook.url}` : hook.url;
    case "function" /* Function */:
      return name ? `${name}:${hook.id ?? "function"}` : hook.id ?? "function";
    case "prompt" /* Prompt */:
      return name ? `${name}:${hook.prompt}` : hook.prompt;
    default:
      return name || "unknown";
  }
}
__name(getHookKey, "getHookKey");
function isToolArtifactLike(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const artifact = value;
  return typeof artifact["title"] === "string" && isOptionalString(artifact, "kind") && isOptionalString(artifact, "storage") && isOptionalString(artifact, "description") && isOptionalString(artifact, "workspacePath") && isOptionalString(artifact, "managedId") && isOptionalString(artifact, "url") && isOptionalString(artifact, "mimeType") && (artifact["sizeBytes"] === void 0 || typeof artifact["sizeBytes"] === "number" && Number.isSafeInteger(artifact["sizeBytes"]) && artifact["sizeBytes"] >= 0) && (artifact["metadata"] === void 0 || isToolArtifactMetadataLike(artifact["metadata"]));
}
__name(isToolArtifactLike, "isToolArtifactLike");
function isToolArtifactMetadataLike(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (item) => item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)
  );
}
__name(isToolArtifactMetadataLike, "isToolArtifactMetadataLike");
function isOptionalString(value, key) {
  return value[key] === void 0 || typeof value[key] === "string";
}
__name(isOptionalString, "isOptionalString");
var MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH = 1e4;
function sanitizeUserPromptExpansionAdditionalContext(raw) {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH).replace(/&(?:a(?:mp?)?|lt?|gt?)?$/, "");
}
__name(sanitizeUserPromptExpansionAdditionalContext, "sanitizeUserPromptExpansionAdditionalContext");
function createHookOutput(eventName, data) {
  switch (eventName) {
    case "PreToolUse" /* PreToolUse */:
      return new PreToolUseHookOutput(data);
    case "PostToolUse" /* PostToolUse */:
      return new PostToolUseHookOutput(data);
    case "PostToolUseFailure" /* PostToolUseFailure */:
      return new PostToolUseFailureHookOutput(data);
    case "UserPromptExpansion" /* UserPromptExpansion */:
      return new UserPromptExpansionHookOutput(data);
    case "PostToolBatch" /* PostToolBatch */:
      return new PostToolBatchHookOutput(data);
    case "Stop" /* Stop */:
    case "SubagentStop" /* SubagentStop */:
      return new StopHookOutput(data);
    case "PermissionRequest" /* PermissionRequest */:
      return new PermissionRequestHookOutput(data);
    default:
      return new DefaultHookOutput(data);
  }
}
__name(createHookOutput, "createHookOutput");
function isBlockingHookOutput(eventName, data) {
  const output = createHookOutput(eventName, data);
  return output instanceof PreToolUseHookOutput ? output.isDenied() : output.isBlockingDecision();
}
__name(isBlockingHookOutput, "isBlockingHookOutput");
var DefaultHookOutput = class {
  static {
    __name(this, "DefaultHookOutput");
  }
  continue;
  stopReason;
  suppressOutput;
  systemMessage;
  terminalSequence;
  decision;
  reason;
  hookSpecificOutput;
  constructor(data = {}) {
    this.continue = data.continue;
    this.stopReason = data.stopReason;
    this.suppressOutput = data.suppressOutput;
    this.systemMessage = data.systemMessage;
    this.terminalSequence = data.terminalSequence;
    this.decision = data.decision;
    this.reason = data.reason;
    this.hookSpecificOutput = data.hookSpecificOutput;
  }
  /**
   * Check if this output represents a blocking decision
   */
  isBlockingDecision() {
    return this.decision === "block" || this.decision === "deny";
  }
  /**
   * Check if this output requests to stop execution
   */
  shouldStopExecution() {
    return this.continue === false;
  }
  /**
   * Get the effective reason for blocking or stopping
   */
  getEffectiveReason() {
    return this.stopReason || this.reason || "No reason provided";
  }
  getRawAdditionalContext() {
    if (this.hookSpecificOutput && "additionalContext" in this.hookSpecificOutput) {
      const context = this.hookSpecificOutput["additionalContext"];
      return typeof context === "string" ? context : void 0;
    }
    return void 0;
  }
  /**
   * Get sanitized additional context for adding to responses.
   */
  getAdditionalContext() {
    const context = this.getRawAdditionalContext();
    if (context !== void 0) {
      return context.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    return void 0;
  }
  getArtifacts() {
    const artifacts = this.hookSpecificOutput?.["artifacts"];
    if (!Array.isArray(artifacts)) {
      return [];
    }
    return artifacts.filter(isToolArtifactLike);
  }
  /**
   * Check if execution should be blocked and return error info
   */
  getBlockingError() {
    if (this.isBlockingDecision()) {
      return {
        blocked: true,
        reason: this.getEffectiveReason()
      };
    }
    return { blocked: false, reason: "" };
  }
  /**
   * Check if context clearing was requested by hook.
   */
  shouldClearContext() {
    return false;
  }
};
var PreToolUseHookOutput = class extends DefaultHookOutput {
  static {
    __name(this, "PreToolUseHookOutput");
  }
  /**
   * Get permission decision from hook output
   * @returns 'allow' | 'deny' | 'ask' | undefined
   */
  getPermissionDecision() {
    if (this.hookSpecificOutput && "permissionDecision" in this.hookSpecificOutput) {
      const decision = this.hookSpecificOutput["permissionDecision"];
      if (decision === "allow" || decision === "deny" || decision === "ask") {
        return decision;
      }
    }
    if (this.decision === "allow" || this.decision === "approve") {
      return "allow";
    }
    if (this.decision === "deny" || this.decision === "block") {
      return "deny";
    }
    if (this.decision === "ask") {
      return "ask";
    }
    return void 0;
  }
  /**
   * Get permission decision reason
   */
  getPermissionDecisionReason() {
    if (this.hookSpecificOutput && "permissionDecisionReason" in this.hookSpecificOutput) {
      const reason = this.hookSpecificOutput["permissionDecisionReason"];
      if (typeof reason === "string") {
        return reason;
      }
    }
    return this.reason;
  }
  /**
   * Check if permission was denied
   */
  isDenied() {
    return this.getPermissionDecision() === "deny";
  }
  /**
   * Check if user confirmation is required
   */
  isAsk() {
    return this.getPermissionDecision() === "ask";
  }
  /**
   * Check if permission was allowed
   */
  isAllowed() {
    return this.getPermissionDecision() === "allow";
  }
};
var PostToolUseHookOutput = class extends DefaultHookOutput {
  static {
    __name(this, "PostToolUseHookOutput");
  }
  decision;
  reason;
  constructor(data = {}) {
    super(data);
    this.decision = data.decision ?? "allow";
    this.reason = data.reason ?? "No reason provided";
    if (data.decision === void 0) {
      debugLogger.debug(
        'PostToolUseHookOutput: No explicit decision set, defaulting to "allow"'
      );
    }
    if (data.reason === void 0) {
      debugLogger.debug(
        'PostToolUseHookOutput: No explicit reason set, defaulting to "No reason provided"'
      );
    }
  }
};
var PostToolUseFailureHookOutput = class extends DefaultHookOutput {
  static {
    __name(this, "PostToolUseFailureHookOutput");
  }
  /**
   * Get additional context to provide error handling information
   */
  getAdditionalContext() {
    return super.getAdditionalContext();
  }
};
var UserPromptExpansionHookOutput = class extends DefaultHookOutput {
  static {
    __name(this, "UserPromptExpansionHookOutput");
  }
  getAdditionalContext() {
    const raw = this.getRawAdditionalContext();
    if (raw === void 0) {
      return void 0;
    }
    return sanitizeUserPromptExpansionAdditionalContext(raw);
  }
};
var PostToolBatchHookOutput = class extends DefaultHookOutput {
  static {
    __name(this, "PostToolBatchHookOutput");
  }
  /**
   * Check if batch processing should stop after the resolved tool calls.
   */
  shouldStopExecution() {
    return super.shouldStopExecution() || this.isBlockingDecision();
  }
};
var StopHookOutput = class extends DefaultHookOutput {
  static {
    __name(this, "StopHookOutput");
  }
  stopReason;
  constructor(data = {}) {
    super(data);
    this.stopReason = data.stopReason;
  }
  /**
   * Get the stop reason if provided
   */
  getStopReason() {
    if (!this.stopReason) {
      return void 0;
    }
    return `Stop hook feedback:
${this.stopReason}`;
  }
};
var PermissionRequestHookOutput = class extends DefaultHookOutput {
  static {
    __name(this, "PermissionRequestHookOutput");
  }
  /**
   * Get the permission decision if provided by hook
   */
  getPermissionDecision() {
    if (this.hookSpecificOutput && "decision" in this.hookSpecificOutput) {
      const decision = this.hookSpecificOutput["decision"];
      if (typeof decision === "object" && decision !== null && !Array.isArray(decision)) {
        return decision;
      }
    }
    return void 0;
  }
  /**
   * Check if the permission was denied
   */
  isPermissionDenied() {
    const decision = this.getPermissionDecision();
    return decision?.behavior === "deny";
  }
  /**
   * Get the deny message if permission was denied
   */
  getDenyMessage() {
    const decision = this.getPermissionDecision();
    return decision?.message;
  }
  /**
   * Check if execution should be interrupted after denial
   */
  shouldInterrupt() {
    const decision = this.getPermissionDecision();
    return decision?.interrupt === true;
  }
  /**
   * Get updated tool input if permission was allowed with modifications
   */
  getUpdatedToolInput() {
    const decision = this.getPermissionDecision();
    return decision?.updatedInput;
  }
  /**
   * Get updated permissions if permission was allowed with permission updates
   */
  getUpdatedPermissions() {
    const decision = this.getPermissionDecision();
    return decision?.updatedPermissions;
  }
};
function detectTodoChanges(oldTodos, newTodos) {
  const oldTodosMap = new Map(oldTodos.map((t) => [t.id, t]));
  const changes = {
    created: [],
    completed: []
  };
  for (const newTodo of newTodos) {
    const oldTodo = oldTodosMap.get(newTodo.id);
    if (!oldTodo) {
      changes.created.push(newTodo);
    } else if (oldTodo.status !== "completed" && newTodo.status === "completed") {
      changes.completed.push(newTodo);
    }
  }
  return changes;
}
__name(detectTodoChanges, "detectTodoChanges");

export {
  escapeXml,
  escapeXmlElementText,
  escapeSystemReminderTags,
  HookEventName,
  HOOKS_CONFIG_FIELDS,
  getHookKey,
  isToolArtifactLike,
  sanitizeUserPromptExpansionAdditionalContext,
  createHookOutput,
  isBlockingHookOutput,
  DefaultHookOutput,
  PreToolUseHookOutput,
  PostToolUseHookOutput,
  PostToolUseFailureHookOutput,
  UserPromptExpansionHookOutput,
  PostToolBatchHookOutput,
  StopHookOutput,
  PermissionRequestHookOutput,
  detectTodoChanges
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
