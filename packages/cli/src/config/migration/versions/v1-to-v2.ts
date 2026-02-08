/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * V1 to V2 migration.
 *
 * Transforms flat V1 settings structure to nested V2 structure.
 * V2 uses `disable*` naming for boolean fields.
 */

import type { SettingsV1, SettingsV2, MigrationResult } from '../types.js';
import { preserveUnknownFields, deepClone, setNestedValue } from '../utils.js';
import { createMigrationStep } from '../pipeline.js';

/**
 * Mapping of V1 flat field names to V2 nested paths.
 * Fields not in this map will be preserved as unknown fields.
 */
export const V1_TO_V2_MAP: Record<string, string> = {
  // UI settings
  theme: 'ui.theme',
  hideWindowTitle: 'ui.hideWindowTitle',
  showStatusInTitle: 'ui.showStatusInTitle',
  hideTips: 'ui.hideTips',
  showLineNumbers: 'ui.showLineNumbers',
  showCitations: 'ui.showCitations',
  customThemes: 'ui.customThemes',
  customWittyPhrases: 'ui.customWittyPhrases',
  enableWelcomeBack: 'ui.enableWelcomeBack',
  enableUserFeedback: 'ui.enableUserFeedback',

  // Accessibility (V2 uses disable* naming)
  disableLoadingPhrases: 'ui.accessibility.disableLoadingPhrases',

  // General settings
  preferredEditor: 'general.preferredEditor',
  vimMode: 'general.vimMode',
  gitCoAuthor: 'general.gitCoAuthor',
  debugKeystrokeLogging: 'general.debugKeystrokeLogging',
  language: 'general.language',
  outputLanguage: 'general.outputLanguage',
  terminalBell: 'general.terminalBell',
  chatRecording: 'general.chatRecording',
  defaultFileEncoding: 'general.defaultFileEncoding',

  // General - disable* naming
  disableAutoUpdate: 'general.disableAutoUpdate',
  disableUpdateNag: 'general.disableUpdateNag',

  // Output settings
  outputFormat: 'output.format',

  // IDE settings
  ideMode: 'ide.enabled',
  hasSeenIdeIntegrationNudge: 'ide.hasSeenNudge',

  // Privacy settings
  usageStatisticsEnabled: 'privacy.usageStatisticsEnabled',

  // Model settings
  model: 'model.name',
  maxSessionTurns: 'model.maxSessionTurns',
  summarizeToolOutput: 'model.summarizeToolOutput',
  chatCompression: 'model.chatCompression',
  sessionTokenLimit: 'model.sessionTokenLimit',
  skipNextSpeakerCheck: 'model.skipNextSpeakerCheck',
  skipLoopDetection: 'model.skipLoopDetection',
  skipStartupContext: 'model.skipStartupContext',
  enableOpenAILogging: 'model.enableOpenAILogging',
  openAILoggingDir: 'model.openAILoggingDir',
  contentGenerator: 'model.generationConfig',

  // Model generation config (V2 uses disable* naming)
  disableCacheControl: 'model.generationConfig.disableCacheControl',

  // Context settings
  contextFileName: 'context.fileName',
  memoryImportFormat: 'context.importFormat',
  includeDirectories: 'context.includeDirectories',
  loadMemoryFromIncludeDirectories: 'context.loadFromIncludeDirectories',

  // File filtering (V2 uses disable* naming)
  disableFuzzySearch: 'context.fileFiltering.disableFuzzySearch',

  // Other context fields
  fileFilteringRespectGitIgnore: 'context.fileFiltering.respectGitIgnore',
  fileFilteringRespectQwenIgnore: 'context.fileFiltering.respectQwenIgnore',
  fileFilteringEnableRecursive:
    'context.fileFiltering.enableRecursiveFileSearch',

  // Tools settings
  sandbox: 'tools.sandbox',
  coreTools: 'tools.core',
  allowedTools: 'tools.allowed',
  autoAccept: 'tools.autoAccept',
  excludeTools: 'tools.exclude',
  useRipgrep: 'tools.useRipgrep',
  approvalMode: 'tools.approvalMode',
  toolDiscoveryCommand: 'tools.discoveryCommand',
  toolCallCommand: 'tools.callCommand',

  // Shell settings
  shouldUseNodePtyShell: 'tools.shell.enableInteractiveShell',
  shellPager: 'tools.shell.pager',
  shellShowColor: 'tools.shell.showColor',

  // MCP settings
  allowMCPServers: 'mcp.allowed',
  excludeMCPServers: 'mcp.excluded',
  mcpServerCommand: 'mcp.serverCommand',

  // Security settings
  enforcedAuthType: 'security.auth.enforcedType',
  selectedAuthType: 'security.auth.selectedType',
  useExternalAuth: 'security.auth.useExternal',
  folderTrustFeature: 'security.folderTrust.featureEnabled',
  folderTrust: 'security.folderTrust.enabled',

  // Advanced settings
  autoConfigureMaxOldSpaceSize: 'advanced.autoConfigureMemory',
  bugCommand: 'advanced.bugCommand',
  dnsResolutionOrder: 'advanced.dnsResolutionOrder',
  excludedProjectEnvVars: 'advanced.excludedEnvVars',
  tavilyApiKey: 'advanced.tavilyApiKey',

  // Telemetry
  telemetry: 'telemetry',

  // Extensions
  extensions: 'extensions',
  modelProviders: 'modelProviders',

  // Experimental
  vlmSwitchMode: 'experimental.vlmSwitchMode',
  visionModelPreview: 'experimental.visionModelPreview',

  // Checkpointing
  checkpointing: 'general.checkpointing',
};

/**
 * Known V1 field names for preservation check.
 */
const KNOWN_V1_FIELDS = new Set([
  ...Object.keys(V1_TO_V2_MAP),
  'mcpServers', // Special: preserved at top level
  'accessibility', // Handled separately
  'screenReader', // V1 field that maps to ui.accessibility.screenReader
]);

/**
 * Known V2 container names for safety check.
 * These are fields that exist as both V1 keys and V2 container names.
 */
const KNOWN_V2_CONTAINERS = new Set([
  'ui',
  'general',
  'model',
  'context',
  'tools',
  'mcp',
  'security',
  'advanced',
  'output',
  'ide',
  'privacy',
  'telemetry',
  'extensions',
  'experimental',
  'modelProviders',
  'mcpServers',
]);

/**
 * Migrates V1 (flat) settings to V2 (nested) structure.
 *
 * @param v1 - V1 settings object
 * @returns Migration result with V2 settings
 */
export function migrateV1ToV2(v1: SettingsV1): MigrationResult<SettingsV2> {
  return createMigrationStep<SettingsV1, SettingsV2>(
    1,
    2,
    (data, addChange, addWarning) => {
      const result: SettingsV2 = { $version: 2 };
      const source = deepClone(data);
      const processedKeys = new Set<string>();

      // Handle field mappings
      for (const [v1Key, v2Path] of Object.entries(V1_TO_V2_MAP)) {
        if (v1Key in source) {
          const value = source[v1Key];

          // Safety check: If this key is a V2 container and already an object,
          // it's likely already in V2 format. Skip to prevent double-nesting.
          if (
            KNOWN_V2_CONTAINERS.has(v1Key) &&
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value)
          ) {
            result[v1Key] = value as Record<string, unknown>;
            processedKeys.add(v1Key);
            addWarning(
              `Key '${v1Key}' appears to already be in V2 format, carried over as-is`,
            );
            continue;
          }

          // Set the value at the nested path
          setNestedValue(result, v2Path, value);
          processedKeys.add(v1Key);

          addChange({
            type: 'move',
            path: v2Path,
            oldValue: value,
            newValue: value,
            reason: `Moved from ${v1Key} to ${v2Path}`,
          });
        }
      }

      // Handle special: screenReader in V1 -> ui.accessibility.screenReader in V2
      if ('screenReader' in source) {
        const value = source['screenReader'];
        setNestedValue(result, 'ui.accessibility.screenReader', value);
        processedKeys.add('screenReader');
        addChange({
          type: 'move',
          path: 'ui.accessibility.screenReader',
          oldValue: value,
          newValue: value,
          reason: 'Moved from screenReader to ui.accessibility.screenReader',
        });
      }

      // Handle accessibility object in V1 (legacy)
      if (
        'accessibility' in source &&
        typeof source.accessibility === 'object'
      ) {
        const acc = source.accessibility as Record<string, unknown>;
        if (acc['screenReader'] !== undefined) {
          const screenReaderValue = acc['screenReader'];
          setNestedValue(
            result,
            'ui.accessibility.screenReader',
            screenReaderValue,
          );
          addChange({
            type: 'move',
            path: 'ui.accessibility.screenReader',
            oldValue: screenReaderValue,
            newValue: screenReaderValue,
            reason:
              'Moved from accessibility.screenReader to ui.accessibility.screenReader',
          });
        }
        processedKeys.add('accessibility');
      }

      // Preserve mcpServers at top level (special case)
      if ('mcpServers' in source) {
        result.mcpServers = source.mcpServers;
        processedKeys.add('mcpServers');
      }

      // Handle unknown fields
      const unknownWarnings = preserveUnknownFields(
        source,
        result,
        KNOWN_V1_FIELDS,
      );
      for (const warning of unknownWarnings) {
        addWarning(warning);
      }

      return result;
    },
  )(v1);
}
