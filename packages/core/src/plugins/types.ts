/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookDefinition, HookEventName } from '../hooks/types.js';
import type { MCPServerConfig } from '../config/config.js';
import type {
  PluginManifest,
  PluginAuthor,
  CommandMetadata,
  PluginScope,
  PluginSource,
  MarketplaceSource,
} from './schemas.js';

// Re-export schema-derived types for convenience
export type {
  PluginManifest,
  PluginAuthor,
  CommandMetadata,
  PluginScope,
  PluginSource,
  MarketplaceSource,
};

/**
 * Hooks configuration for a plugin.
 * Maps hook event names to arrays of hook definitions.
 */
export type PluginHooksConfig = {
  [K in HookEventName]?: HookDefinition[];
};

/**
 * A fully loaded and resolved plugin.
 *
 * Created by PluginLoader after reading and validating plugin.json,
 * discovering convention directories (commands/, agents/, skills/, etc.),
 * and merging manifest-declared paths.
 */
export interface LoadedPlugin {
  /** Plugin name (from manifest or marketplace entry) */
  name: string;

  /** Human-readable display name for UI surfaces. */
  displayName?: string;

  /** Parsed and validated plugin manifest */
  manifest: PluginManifest;

  /** Absolute path to the plugin root directory */
  path: string;

  /**
   * Where this plugin was loaded from.
   * - For marketplace plugins: "marketplace-name"
   * - For local plugins: "local"
   * - For flag plugins (--plugin-dir): "flag"
   * - For built-in plugins: "builtin"
   */
  source: string;

  /**
   * Repository / marketplace identifier.
   * Usually same as source for marketplace plugins.
   */
  repository: string;

  /** Whether this plugin is enabled */
  enabled?: boolean;

  /** True for built-in plugins that ship with the CLI */
  isBuiltin?: boolean;

  /** Git commit SHA for version pinning */
  sha?: string;

  // --- Discovered component paths ---

  /** Path to conventional commands/ directory (if exists) */
  commandsPath?: string;

  /** Additional command paths declared in manifest */
  commandsPaths?: string[];

  /** Metadata for named commands from object-mapping format */
  commandsMetadata?: Record<string, CommandMetadata>;

  /** Path to conventional agents/ directory (if exists) */
  agentsPath?: string;

  /** Additional agent paths declared in manifest */
  agentsPaths?: string[];

  /** Path to conventional skills/ directory (if exists) */
  skillsPath?: string;

  /** Additional skill paths declared in manifest */
  skillsPaths?: string[];

  /** Path to conventional output-styles/ directory (if exists) */
  outputStylesPath?: string;

  /** Additional output style paths declared in manifest */
  outputStylesPaths?: string[];

  /** Path to conventional workflows/ directory (if exists) */
  workflowsPath?: string;

  /** Additional workflow paths declared in manifest */
  workflowsPaths?: string[];

  /**
   * Path to conventional bin/ directory (if exists). Executables here are
   * added to the Bash tool's PATH while the plugin is enabled, so they can
   * be invoked as bare commands.
   */
  binPath?: string;

  // --- Resolved component configurations ---

  /** Merged hooks configuration from hooks/hooks.json and manifest declarations */
  hooksConfig?: PluginHooksConfig;

  /** MCP servers from .mcp.json and manifest declarations */
  mcpServers?: Record<string, MCPServerConfig>;

  /** Plugin settings to merge when enabled */
  settings?: Record<string, unknown>;

  /** Non-fatal errors encountered during loading (e.g. manifest paths not found) */
  warnings?: PluginError[];
}

/**
 * Plugin component types for error reporting and discovery.
 */
export type PluginComponent =
  | 'commands'
  | 'agents'
  | 'skills'
  | 'hooks'
  | 'mcp-servers'
  | 'output-styles'
  | 'workflows';

/**
 * Discriminated union of plugin error types.
 * Each error type has specific contextual data for debugging and user guidance.
 */
export type PluginError =
  | {
      type: 'path-not-found';
      source: string;
      plugin?: string;
      path: string;
      component: PluginComponent;
    }
  | {
      type: 'git-auth-failed';
      source: string;
      plugin?: string;
      gitUrl: string;
      authType: 'ssh' | 'https';
    }
  | {
      type: 'git-timeout';
      source: string;
      plugin?: string;
      gitUrl: string;
      operation: 'clone' | 'pull';
    }
  | {
      type: 'network-error';
      source: string;
      plugin?: string;
      url: string;
      details?: string;
    }
  | {
      type: 'manifest-parse-error';
      source: string;
      plugin?: string;
      manifestPath: string;
      parseError: string;
    }
  | {
      type: 'manifest-validation-error';
      source: string;
      plugin?: string;
      manifestPath: string;
      validationErrors: string[];
    }
  | {
      type: 'plugin-not-found';
      source: string;
      pluginId: string;
      marketplace: string;
    }
  | {
      type: 'marketplace-not-found';
      source: string;
      marketplace: string;
      availableMarketplaces: string[];
    }
  | {
      type: 'marketplace-load-failed';
      source: string;
      marketplace: string;
      reason: string;
    }
  | {
      type: 'mcp-config-invalid';
      source: string;
      plugin: string;
      serverName: string;
      validationError: string;
    }
  | {
      type: 'mcp-server-suppressed-duplicate';
      source: string;
      plugin: string;
      serverName: string;
      duplicateOf: string;
    }
  | {
      type: 'hook-load-failed';
      source: string;
      plugin: string;
      hookPath: string;
      reason: string;
    }
  | {
      type: 'component-load-failed';
      source: string;
      plugin: string;
      component: PluginComponent;
      path: string;
      reason: string;
    }
  | {
      type: 'marketplace-blocked-by-policy';
      source: string;
      plugin?: string;
      marketplace: string;
      blockedByBlocklist?: boolean;
      allowedSources: string[];
    }
  | {
      type: 'dependency-unsatisfied';
      source: string;
      plugin: string;
      dependency: string;
      reason: 'not-enabled' | 'not-found';
    }
  | {
      type: 'plugin-cache-miss';
      source: string;
      plugin: string;
      installPath: string;
    }
  | {
      type: 'generic-error';
      source: string;
      plugin?: string;
      /** Canonical identity used to group errors with their plugin. */
      pluginId?: string;
      error: string;
      /** Recovery guidance supplied by the error producer. */
      hint?: string;
    };

/**
 * Result of loading plugins from all sources.
 */
export interface PluginLoadResult {
  enabled: LoadedPlugin[];
  disabled: LoadedPlugin[];
  errors: PluginError[];
}

/**
 * Events emitted during plugin loading and unloading.
 */
export interface PluginEvents {
  pluginsStarting: PluginProgressEvent[];
  pluginsStopping: PluginProgressEvent[];
}

export interface PluginProgressEvent {
  total: number;
  completed: number;
}

/**
 * Helper function to get a display message from any PluginError.
 */
export function getPluginErrorMessage(error: PluginError): string {
  switch (error.type) {
    case 'generic-error':
      return error.error;
    case 'path-not-found':
      return `Path not found: ${error.path} (${error.component})`;
    case 'git-auth-failed':
      return `Git authentication failed (${error.authType}): ${error.gitUrl}`;
    case 'git-timeout':
      return `Git ${error.operation} timeout: ${error.gitUrl}`;
    case 'network-error':
      return `Network error: ${error.url}${error.details ? ` - ${error.details}` : ''}`;
    case 'manifest-parse-error':
      return `Manifest parse error at ${error.manifestPath}: ${error.parseError}`;
    case 'manifest-validation-error':
      return `Manifest validation failed: ${error.validationErrors.join(', ')}`;
    case 'plugin-not-found':
      return `Plugin ${error.pluginId} not found in marketplace ${error.marketplace}`;
    case 'marketplace-not-found':
      return `Marketplace ${error.marketplace} not found`;
    case 'marketplace-load-failed':
      return `Marketplace ${error.marketplace} failed to load: ${error.reason}`;
    case 'mcp-config-invalid':
      return `MCP server ${error.serverName} invalid: ${error.validationError}`;
    case 'mcp-server-suppressed-duplicate': {
      const dup = error.duplicateOf.startsWith('plugin:')
        ? `server provided by plugin "${error.duplicateOf.split(':')[1] ?? '?'}"`
        : `already-configured "${error.duplicateOf}"`;
      return `MCP server "${error.serverName}" skipped - same command/URL as ${dup}`;
    }
    case 'hook-load-failed':
      return `Hook load failed: ${error.reason}`;
    case 'component-load-failed':
      return `${error.component} load failed from ${error.path}: ${error.reason}`;
    case 'marketplace-blocked-by-policy':
      if (error.blockedByBlocklist) {
        return `Marketplace '${error.marketplace}' is blocked by marketplace policy`;
      }
      return `Marketplace '${error.marketplace}' is not in the allowed marketplace list`;
    case 'dependency-unsatisfied': {
      const hint =
        error.reason === 'not-enabled'
          ? 'disabled - enable it or remove the dependency'
          : 'not found in any configured marketplace';
      return `Dependency "${error.dependency}" is ${hint}`;
    }
    case 'plugin-cache-miss':
      return `Plugin "${error.plugin}" not cached at ${error.installPath} - run /plugins to refresh`;
    default: {
      const _exhaustive: never = error;
      return `Unknown plugin error: ${(_exhaustive as PluginError).type}`;
    }
  }
}

/**
 * Returns shared recovery guidance or the hint supplied by an error producer.
 */
export function getPluginErrorHint(error: PluginError): string | null {
  switch (error.type) {
    case 'manifest-parse-error':
    case 'manifest-validation-error':
      return 'Fix the manifest, or delete it to fall back to convention-based loading (folder name becomes the plugin name).';
    case 'generic-error':
      return error.hint ?? null;
    default:
      return null;
  }
}
