/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types, helpers, and constants for the PluginBrowser components.
 */

import type { LoadedPlugin } from '@qwen-code/core';

// ---------------------------------------------------------------------------
// Scope ordering — determines visual sort in the installed list
// ---------------------------------------------------------------------------

/**
 * Display label for each plugin source/scope.
 */
export const SCOPE_LABELS: Record<string, string> = {
  local: 'Local',
  project: 'Project',
  user: 'User',
  builtin: 'Built-in',
  flag: 'Flag',
};

/** Scope sort priority — lower numbers sort first. */
export const SCOPE_ORDER: Record<string, number> = {
  flag: 0,
  local: 1,
  project: 2,
  user: 3,
  builtin: 4,
};

/**
 * Classify a plugin into a tab-friendly scope bucket.
 * Marketplace plugins go into 'user' unless they came from project config.
 */
export function getPluginScope(plugin: LoadedPlugin): string {
  const src = plugin.source;
  if (src === 'builtin') return 'builtin';
  if (src === 'local') return 'local';
  if (src === 'flag') return 'flag';
  // Marketplace-sourced plugins are treated as 'user' by default
  return 'user';
}

// ---------------------------------------------------------------------------
// Detail view helpers
// ---------------------------------------------------------------------------

/** Actions available in the plugin detail view. */
export type PluginDetailAction =
  | 'toggle'
  | 'uninstall'
  | 'open-homepage'
  | 'view-repository';

export interface PluginDetailField {
  kind: 'info' | 'toggle' | 'action';
  label: string;
  value: string;
  action?: PluginDetailAction;
  disabled?: boolean;
}

/**
 * Build the list of detail fields for a plugin.
 */
export function buildPluginDetailFields(
  plugin: LoadedPlugin,
  isEnabledOverride?: boolean,
  installScope?: string,
  canToggle: boolean = true,
): PluginDetailField[] {
  const fields: PluginDetailField[] = [];
  const isEnabled = isEnabledOverride ?? plugin.enabled !== false;

  // A read-only field has no action, so it cannot trigger a mutation.
  const statusText = isEnabled ? '✓ Enabled' : '○ Disabled';
  fields.push(
    canToggle
      ? { kind: 'toggle', label: 'Status', value: statusText, action: 'toggle' }
      : {
          kind: 'info',
          label: 'Status',
          value: statusText,
        },
  );

  // Info fields
  if (plugin.manifest.version) {
    fields.push({
      kind: 'info',
      label: 'Version',
      value: `v${plugin.manifest.version}`,
    });
  }

  const scope = installScope ?? getPluginScope(plugin);
  fields.push({
    kind: 'info',
    label: 'Scope',
    value: SCOPE_LABELS[scope] ?? scope,
  });

  if (plugin.manifest.description) {
    fields.push({
      kind: 'info',
      label: 'Description',
      value: plugin.manifest.description,
    });
  }

  if (plugin.manifest.author) {
    const author = plugin.manifest.author;
    const authorStr = author.name + (author.email ? ` <${author.email}>` : '');
    fields.push({
      kind: 'info',
      label: 'Author',
      value: authorStr,
    });
  }

  fields.push({
    kind: 'info',
    label: 'Source',
    value: plugin.source,
  });
  fields.push({ kind: 'info', label: 'Path', value: plugin.path });

  // Components: detailed display is handled by PluginComponentsDisplay.
  // See ManagePlugins.tsx plugin-details view for integration.

  // Actions
  if (plugin.manifest.homepage) {
    fields.push({
      kind: 'action',
      label: 'Homepage',
      value: plugin.manifest.homepage,
      action: 'open-homepage',
    });
  }

  if (plugin.manifest.repository) {
    fields.push({
      kind: 'action',
      label: 'Repository',
      value: plugin.manifest.repository,
      action: 'view-repository',
    });
  }

  // Built-in and flag-loaded plugins are not removable installations.
  if (!plugin.isBuiltin && plugin.source !== 'flag') {
    fields.push({
      kind: 'action',
      label: 'Uninstall',
      value: 'Remove this plugin',
      action: 'uninstall',
    });
  }

  return fields;
}
