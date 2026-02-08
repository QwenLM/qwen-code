/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type definitions for settings schema versions.
 *
 * This module defines explicit types for each settings schema version
 * to ensure type safety during migrations.
 */

// ============================================================================
// V1 Schema - Flat structure with legacy field names
// ============================================================================

export interface SettingsV1 {
  // Legacy flat fields
  theme?: string;
  disableAutoUpdate?: boolean;
  disableUpdateNag?: boolean;
  disableLoadingPhrases?: boolean;
  disableFuzzySearch?: boolean;
  disableCacheControl?: boolean;

  // Other flat fields from MIGRATION_MAP
  accessibility?: unknown;
  allowedTools?: unknown;
  allowMCPServers?: unknown;
  autoAccept?: unknown;
  autoConfigureMaxOldSpaceSize?: unknown;
  bugCommand?: unknown;
  chatCompression?: unknown;
  checkpointing?: unknown;
  coreTools?: unknown;
  contextFileName?: unknown;
  customThemes?: unknown;
  customWittyPhrases?: unknown;
  debugKeystrokeLogging?: unknown;
  dnsResolutionOrder?: unknown;
  enforcedAuthType?: unknown;
  excludeTools?: unknown;
  excludeMCPServers?: unknown;
  excludedProjectEnvVars?: unknown;
  extensions?: unknown;
  fileFiltering?: unknown;
  folderTrustFeature?: unknown;
  folderTrust?: unknown;
  hasSeenIdeIntegrationNudge?: unknown;
  hideWindowTitle?: unknown;
  showStatusInTitle?: unknown;
  hideTips?: unknown;
  showLineNumbers?: unknown;
  showCitations?: unknown;
  ideMode?: unknown;
  includeDirectories?: unknown;
  loadMemoryFromIncludeDirectories?: unknown;
  maxSessionTurns?: unknown;
  mcpServers?: unknown;
  mcpServerCommand?: unknown;
  memoryImportFormat?: unknown;
  model?: unknown;
  preferredEditor?: unknown;
  sandbox?: unknown;
  selectedAuthType?: unknown;
  shouldUseNodePtyShell?: unknown;
  shellPager?: unknown;
  shellShowColor?: unknown;
  skipNextSpeakerCheck?: unknown;
  summarizeToolOutput?: unknown;
  telemetry?: unknown;
  toolDiscoveryCommand?: unknown;
  toolCallCommand?: unknown;
  usageStatisticsEnabled?: unknown;
  useExternalAuth?: unknown;
  useRipgrep?: unknown;
  vimMode?: unknown;

  // Additional V1 fields
  enableWelcomeBack?: unknown;
  approvalMode?: unknown;
  sessionTokenLimit?: unknown;
  contentGenerator?: unknown;
  skipLoopDetection?: unknown;
  skipStartupContext?: unknown;
  enableOpenAILogging?: unknown;
  tavilyApiKey?: unknown;
  vlmSwitchMode?: unknown;
  visionModelPreview?: unknown;

  // Allow unknown fields for forward compatibility
  [key: string]: unknown;
}

// ============================================================================
// V2 Schema - Nested structure with disable* boolean naming
// ============================================================================

export interface SettingsV2 {
  $version: 2;

  ui?: {
    theme?: string;
    hideWindowTitle?: boolean;
    showStatusInTitle?: boolean;
    hideTips?: boolean;
    showLineNumbers?: boolean;
    showCitations?: boolean;
    customThemes?: unknown;
    customWittyPhrases?: unknown;
    enableWelcomeBack?: boolean;
    enableUserFeedback?: boolean;
    accessibility?: {
      disableLoadingPhrases?: boolean;
      screenReader?: boolean;
    };
    feedbackLastShownTimestamp?: number;
  };

  general?: {
    preferredEditor?: string;
    vimMode?: boolean;
    disableAutoUpdate?: boolean;
    disableUpdateNag?: boolean;
    gitCoAuthor?: boolean;
    checkpointing?: {
      enabled?: boolean;
    };
    debugKeystrokeLogging?: boolean;
    language?: string;
    outputLanguage?: string;
    terminalBell?: boolean;
    chatRecording?: boolean;
    defaultFileEncoding?: string;
  };

  output?: {
    format?: string;
  };

  ide?: {
    enabled?: boolean;
    hasSeenNudge?: boolean;
  };

  privacy?: {
    usageStatisticsEnabled?: boolean;
  };

  telemetry?: unknown;

  model?: {
    name?: string;
    maxSessionTurns?: number;
    summarizeToolOutput?: unknown;
    chatCompression?: unknown;
    sessionTokenLimit?: number;
    skipNextSpeakerCheck?: boolean;
    skipLoopDetection?: boolean;
    skipStartupContext?: boolean;
    enableOpenAILogging?: boolean;
    openAILoggingDir?: string;
    generationConfig?: {
      timeout?: number;
      maxRetries?: number;
      disableCacheControl?: boolean;
      schemaCompliance?: string;
      contextWindowSize?: number;
    };
  };

  context?: {
    fileName?: unknown;
    importFormat?: string;
    includeDirectories?: string[];
    loadFromIncludeDirectories?: boolean;
    fileFiltering?: {
      respectGitIgnore?: boolean;
      respectQwenIgnore?: boolean;
      enableRecursiveFileSearch?: boolean;
      disableFuzzySearch?: boolean;
    };
  };

  tools?: {
    sandbox?: unknown;
    shell?: {
      enableInteractiveShell?: boolean;
      pager?: string;
      showColor?: boolean;
    };
    core?: unknown;
    allowed?: unknown;
    autoAccept?: unknown;
    exclude?: unknown;
    useRipgrep?: boolean;
    approvalMode?: unknown;
    discoveryCommand?: unknown;
    callCommand?: unknown;
  };

  mcp?: {
    allowed?: unknown;
    excluded?: unknown;
    serverCommand?: unknown;
  };

  security?: {
    auth?: {
      enforcedType?: unknown;
      selectedType?: unknown;
      useExternal?: boolean;
    };
    folderTrust?: {
      featureEnabled?: boolean;
      enabled?: boolean;
    };
  };

  advanced?: {
    autoConfigureMemory?: unknown;
    bugCommand?: unknown;
    dnsResolutionOrder?: unknown;
    excludedEnvVars?: string[];
    tavilyApiKey?: string;
  };

  experimental?: {
    vlmSwitchMode?: unknown;
    visionModelPreview?: unknown;
  };

  modelProviders?: unknown;
  extensions?: unknown;
  mcpServers?: unknown;

  // Allow unknown fields for forward compatibility
  [key: string]: unknown;
}

// ============================================================================
// V3 Schema - Nested structure with enable* boolean naming (current)
// ============================================================================

export interface SettingsV3 {
  $version: 3;

  ui?: {
    theme?: string;
    hideWindowTitle?: boolean;
    showStatusInTitle?: boolean;
    hideTips?: boolean;
    showLineNumbers?: boolean;
    showCitations?: boolean;
    customThemes?: unknown;
    customWittyPhrases?: unknown;
    enableWelcomeBack?: boolean;
    enableUserFeedback?: boolean;
    accessibility?: {
      enableLoadingPhrases?: boolean;
      screenReader?: boolean;
    };
    feedbackLastShownTimestamp?: number;
  };

  general?: {
    preferredEditor?: string;
    vimMode?: boolean;
    enableAutoUpdate?: boolean;
    gitCoAuthor?: boolean;
    checkpointing?: {
      enabled?: boolean;
    };
    debugKeystrokeLogging?: boolean;
    language?: string;
    outputLanguage?: string;
    terminalBell?: boolean;
    chatRecording?: boolean;
    defaultFileEncoding?: string;
  };

  output?: {
    format?: string;
  };

  ide?: {
    enabled?: boolean;
    hasSeenNudge?: boolean;
  };

  privacy?: {
    usageStatisticsEnabled?: boolean;
  };

  telemetry?: unknown;

  model?: {
    name?: string;
    maxSessionTurns?: number;
    summarizeToolOutput?: unknown;
    chatCompression?: unknown;
    sessionTokenLimit?: number;
    skipNextSpeakerCheck?: boolean;
    skipLoopDetection?: boolean;
    skipStartupContext?: boolean;
    enableOpenAILogging?: boolean;
    openAILoggingDir?: string;
    generationConfig?: {
      timeout?: number;
      maxRetries?: number;
      enableCacheControl?: boolean;
      schemaCompliance?: string;
      contextWindowSize?: number;
    };
  };

  context?: {
    fileName?: unknown;
    importFormat?: string;
    includeDirectories?: string[];
    loadFromIncludeDirectories?: boolean;
    fileFiltering?: {
      respectGitIgnore?: boolean;
      respectQwenIgnore?: boolean;
      enableRecursiveFileSearch?: boolean;
      enableFuzzySearch?: boolean;
    };
  };

  tools?: {
    sandbox?: unknown;
    shell?: {
      enableInteractiveShell?: boolean;
      pager?: string;
      showColor?: boolean;
    };
    core?: unknown;
    allowed?: unknown;
    autoAccept?: unknown;
    exclude?: unknown;
    useRipgrep?: boolean;
    approvalMode?: unknown;
    discoveryCommand?: unknown;
    callCommand?: unknown;
  };

  mcp?: {
    allowed?: unknown;
    excluded?: unknown;
    serverCommand?: unknown;
  };

  security?: {
    auth?: {
      enforcedType?: unknown;
      selectedType?: unknown;
      useExternal?: boolean;
    };
    folderTrust?: {
      featureEnabled?: boolean;
      enabled?: boolean;
    };
  };

  advanced?: {
    autoConfigureMemory?: unknown;
    bugCommand?: unknown;
    dnsResolutionOrder?: unknown;
    excludedEnvVars?: string[];
    tavilyApiKey?: string;
  };

  experimental?: {
    vlmSwitchMode?: unknown;
    visionModelPreview?: unknown;
  };

  modelProviders?: unknown;
  extensions?: unknown;
  mcpServers?: unknown;

  // Allow unknown fields for forward compatibility
  [key: string]: unknown;
}

// ============================================================================
// Migration Types
// ============================================================================

export type SettingsVersion = 1 | 2 | 3;

export interface MigrationChange {
  /** Type of change performed */
  type: 'move' | 'rename' | 'transform' | 'delete' | 'add' | 'preserve';
  /** Path to the field that was changed */
  path: string;
  /** Old value (if applicable) */
  oldValue?: unknown;
  /** New value (if applicable) */
  newValue?: unknown;
  /** Human-readable reason for the change */
  reason: string;
}

export interface MigrationResult<T> {
  /** Whether the migration succeeded */
  success: boolean;
  /** The migrated data */
  data: T;
  /** The resulting version number */
  version: number;
  /** List of changes made during migration */
  changes: MigrationChange[];
  /** Warnings encountered during migration */
  warnings: string[];
}

export type Migration<VFrom, VTo> = (from: VFrom) => MigrationResult<VTo>;

// Latest settings type (alias for V3)
export type Settings = SettingsV3;

// ============================================================================
// Constants
// ============================================================================

export const LATEST_VERSION = 3;
export const SETTINGS_VERSION_KEY = '$version';
