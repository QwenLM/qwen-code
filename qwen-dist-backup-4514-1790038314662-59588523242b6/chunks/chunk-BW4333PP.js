// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";

// packages/cli/src/config/migration/versions/v1-to-v2-shared.ts
init_esbuild_shims();
var V1_TO_V2_MIGRATION_MAP = {
  accessibility: "ui.accessibility",
  allowedTools: "tools.allowed",
  allowMCPServers: "mcp.allowed",
  autoAccept: "tools.autoAccept",
  autoConfigureMaxOldSpaceSize: "advanced.autoConfigureMemory",
  bugCommand: "advanced.bugCommand",
  chatCompression: "model.chatCompression",
  checkpointing: "general.checkpointing",
  coreTools: "tools.core",
  contextFileName: "context.fileName",
  customThemes: "ui.customThemes",
  customWittyPhrases: "ui.customWittyPhrases",
  debugKeystrokeLogging: "general.debugKeystrokeLogging",
  dnsResolutionOrder: "advanced.dnsResolutionOrder",
  enforcedAuthType: "security.auth.enforcedType",
  excludeTools: "tools.exclude",
  excludeMCPServers: "mcp.excluded",
  excludedProjectEnvVars: "advanced.excludedEnvVars",
  extensions: "extensions",
  fileFiltering: "context.fileFiltering",
  folderTrustFeature: "security.folderTrust.featureEnabled",
  folderTrust: "security.folderTrust.enabled",
  hasSeenIdeIntegrationNudge: "ide.hasSeenNudge",
  hideWindowTitle: "ui.hideWindowTitle",
  showStatusInTitle: "ui.showStatusInTitle",
  hideTips: "ui.hideTips",
  showLineNumbers: "ui.showLineNumbers",
  showCitations: "ui.showCitations",
  ideMode: "ide.enabled",
  includeDirectories: "context.includeDirectories",
  loadMemoryFromIncludeDirectories: "context.loadFromIncludeDirectories",
  maxSessionTurns: "model.maxSessionTurns",
  mcpServers: "mcpServers",
  mcpServerCommand: "mcp.serverCommand",
  memoryImportFormat: "context.importFormat",
  model: "model.name",
  preferredEditor: "general.preferredEditor",
  sandbox: "tools.sandbox",
  selectedAuthType: "security.auth.selectedType",
  shouldUseNodePtyShell: "tools.shell.enableInteractiveShell",
  shellPager: "tools.shell.pager",
  shellShowColor: "tools.shell.showColor",
  skipNextSpeakerCheck: "model.skipNextSpeakerCheck",
  telemetry: "telemetry",
  theme: "ui.theme",
  toolDiscoveryCommand: "tools.discoveryCommand",
  toolCallCommand: "tools.callCommand",
  usageStatisticsEnabled: "privacy.usageStatisticsEnabled",
  useExternalAuth: "security.auth.useExternal",
  useRipgrep: "tools.useRipgrep",
  vimMode: "general.vimMode",
  enableWelcomeBack: "ui.enableWelcomeBack",
  approvalMode: "tools.approvalMode",
  sessionTokenLimit: "model.sessionTokenLimit",
  contentGenerator: "model.generationConfig",
  skipLoopDetection: "model.skipLoopDetection",
  skipStartupContext: "model.skipStartupContext",
  enableOpenAILogging: "model.enableOpenAILogging",
  tavilyApiKey: "advanced.tavilyApiKey"
};
var V2_CONTAINER_KEYS = /* @__PURE__ */ new Set([
  "ui",
  "tools",
  "mcp",
  "advanced",
  "model",
  "general",
  "context",
  "security",
  "ide",
  "privacy",
  "telemetry",
  "extensions"
]);
var V1_TO_V2_PRESERVE_DISABLE_MAP = {
  disableAutoUpdate: "general.disableAutoUpdate",
  disableUpdateNag: "general.disableUpdateNag",
  disableLoadingPhrases: "ui.accessibility.disableLoadingPhrases",
  disableFuzzySearch: "context.fileFiltering.disableFuzzySearch",
  disableCacheControl: "model.generationConfig.disableCacheControl"
};
var CONSOLIDATED_DISABLE_KEYS = /* @__PURE__ */ new Set([
  "disableAutoUpdate",
  "disableUpdateNag"
]);
var V1_INDICATOR_KEYS = [
  // From V1_TO_V2_MIGRATION_MAP - keys that map to different paths in V2
  "theme",
  "model",
  "autoAccept",
  "hideTips",
  "vimMode",
  "checkpointing",
  "accessibility",
  "allowedTools",
  "allowMCPServers",
  "autoConfigureMaxOldSpaceSize",
  "bugCommand",
  "chatCompression",
  "coreTools",
  "contextFileName",
  "customThemes",
  "customWittyPhrases",
  "debugKeystrokeLogging",
  "dnsResolutionOrder",
  "enforcedAuthType",
  "excludeTools",
  "excludeMCPServers",
  "excludedProjectEnvVars",
  "fileFiltering",
  "folderTrustFeature",
  "folderTrust",
  "hasSeenIdeIntegrationNudge",
  "hideWindowTitle",
  "showStatusInTitle",
  "showLineNumbers",
  "showCitations",
  "ideMode",
  "includeDirectories",
  "loadMemoryFromIncludeDirectories",
  "maxSessionTurns",
  "mcpServerCommand",
  "memoryImportFormat",
  "preferredEditor",
  "sandbox",
  "selectedAuthType",
  "shouldUseNodePtyShell",
  "shellPager",
  "shellShowColor",
  "skipNextSpeakerCheck",
  "toolDiscoveryCommand",
  "toolCallCommand",
  "usageStatisticsEnabled",
  "useExternalAuth",
  "useRipgrep",
  "enableWelcomeBack",
  "approvalMode",
  "sessionTokenLimit",
  "contentGenerator",
  "skipLoopDetection",
  "skipStartupContext",
  "enableOpenAILogging",
  "tavilyApiKey",
  // From V1_TO_V2_PRESERVE_DISABLE_MAP - disable* keys that get nested in V2
  "disableAutoUpdate",
  "disableUpdateNag",
  "disableLoadingPhrases",
  "disableFuzzySearch",
  "disableCacheControl"
];

export {
  V1_TO_V2_MIGRATION_MAP,
  V2_CONTAINER_KEYS,
  V1_TO_V2_PRESERVE_DISABLE_MAP,
  CONSOLIDATED_DISABLE_KEYS,
  V1_INDICATOR_KEYS
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
