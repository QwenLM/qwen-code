/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PluginErrors — Error formatting and guidance utilities.
 *
 * Pure functions that format PluginError instances for display in the
 * Errors Tab and other error surfaces. No React components — just
 * string formatters.
 */

import {
  type PluginError,
  getPluginErrorMessage,
  getPluginErrorHint,
} from '@qwen-code/core';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a PluginError into a concise, user-friendly one-line message.
 * Delegates to getPluginErrorMessage for the base message but adds
 * source context when available.
 */
export function formatErrorMessage(error: PluginError): string {
  const base = getPluginErrorMessage(error);
  const source = error.source ? ` [${error.source}]` : '';
  const plugin =
    'plugin' in error && error.plugin ? ` (plugin: ${error.plugin})` : '';
  return `${base}${source}${plugin}`;
}

// ---------------------------------------------------------------------------
// Error guidance — actionable hints for each error type
// ---------------------------------------------------------------------------

/**
 * Returns user-actionable guidance for a given error, or null if no
 * specific guidance is available.
 */
export function getErrorGuidance(error: PluginError): string | null {
  switch (error.type) {
    case 'path-not-found':
      return 'Check that the plugin path exists and is accessible.';
    case 'git-auth-failed':
      return error.authType === 'ssh'
        ? 'Check your SSH keys and agent. Try: ssh -T git@github.com'
        : 'Check your HTTPS credentials or personal access token.';
    case 'git-timeout':
      return 'The git operation timed out. Check your network connection and try again.';
    case 'network-error':
      return 'Check your internet connection and try again.';
    case 'manifest-parse-error':
    case 'manifest-validation-error':
      return getPluginErrorHint(error);
    case 'plugin-not-found':
      return `Plugin "${error.pluginId}" was not found in marketplace "${error.marketplace}". Check the plugin name and marketplace.`;
    case 'marketplace-not-found':
      return `Add the marketplace first using /plugins marketplace add. Available: ${error.availableMarketplaces.join(', ') || '(none)'}`;
    case 'marketplace-load-failed':
      return 'The marketplace could not be loaded. Try refreshing or removing and re-adding it.';
    case 'mcp-config-invalid':
      return 'The MCP server configuration in this plugin is invalid. Contact the plugin author.';
    case 'mcp-server-suppressed-duplicate':
      return 'This MCP server was skipped because another server with the same command/URL is already configured.';
    case 'hook-load-failed':
      return 'A hook in this plugin failed to load. Try reinstalling or contact the plugin author.';
    case 'component-load-failed':
      return 'A plugin component failed to load. Try reinstalling or contact the plugin author.';
    case 'dependency-unsatisfied':
      return error.reason === 'not-enabled'
        ? `Enable the dependency "${error.dependency}" or remove it from this plugin's requirements.`
        : `Install the dependency "${error.dependency}" from a configured marketplace.`;
    case 'plugin-cache-miss':
      return 'The plugin cache is stale. Run /plugins to refresh.';
    case 'generic-error':
      return getPluginErrorHint(error);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Error categorization
// ---------------------------------------------------------------------------

export type ErrorCategory = 'transient' | 'marketplace' | 'plugin' | 'config';

/**
 * Categorize an error for grouping in the Errors Tab UI.
 */
export function categorizeError(error: PluginError): ErrorCategory {
  switch (error.type) {
    case 'git-auth-failed':
    case 'git-timeout':
    case 'network-error':
    case 'plugin-cache-miss':
      return 'transient';
    case 'marketplace-not-found':
    case 'marketplace-load-failed':
      return 'marketplace';
    case 'mcp-config-invalid':
    case 'mcp-server-suppressed-duplicate':
    case 'hook-load-failed':
    case 'component-load-failed':
      return 'config';
    default:
      return 'plugin';
  }
}

/**
 * Human-readable label for each error category.
 */
export const CATEGORY_LABELS: Record<ErrorCategory, string> = {
  transient: 'Transient Errors (retry may fix)',
  marketplace: 'Marketplace Errors',
  plugin: 'Plugin Errors',
  config: 'Configuration Errors',
};
