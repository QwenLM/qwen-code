/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * External import approval system for AGENTS.md files.
 *
 * When AGENTS.md files contain @import references that point outside
 * the project root, those imports are blocked by default. This module
 * provides persistence for user approval decisions:
 *
 * - Per-project approval (stored in User-scope settings)
 * - Global enable-all flag
 * - Approval status checks
 */

import { coreEvents } from '@qwen-code/core';
import type { MergedSettings } from './settingsSchema.js';
import { SettingScope, type LoadedSettings } from './settings.js';

/**
 * Check whether external imports are approved for the given project directory.
 *
 * Returns true if:
 * 1. The global enableAllExternalImports flag is set, OR
 * 2. The project directory is in the approvedExternalImportProjects list.
 */
export function isExternalImportApprovedForProject(
  projectDir: string,
  securitySettings: MergedSettings['security'],
): boolean {
  if (securitySettings?.enableAllExternalImports) {
    return true;
  }

  const approvedProjects =
    securitySettings?.approvedExternalImportProjects ?? [];
  return approvedProjects.some((approved) => approved === projectDir);
}

function canPersistUserApproval(loaded: LoadedSettings): boolean {
  if (!loaded.user.readOnly && loaded.user.path) return true;
  coreEvents.emitFeedback(
    'error',
    'Cannot save permanent approval because User settings are not writable. Choose allow for this session instead.',
  );
  return false;
}

/**
 * Approve external imports for a specific project directory.
 * Adds the project to the approvedExternalImportProjects list in User scope.
 */
export function approveExternalImportsForProject(
  projectDir: string,
  loaded: LoadedSettings,
): boolean {
  if (!canPersistUserApproval(loaded)) return false;
  return loaded.updateValue(
    SettingScope.User,
    'security.approvedExternalImportProjects',
    (current) => {
      const approved = Array.isArray(current)
        ? current.filter((entry): entry is string => typeof entry === 'string')
        : [];
      return approved.includes(projectDir)
        ? approved
        : [...approved, projectDir];
    },
  );
}

/**
 * Enable all external imports globally (for all projects).
 * Sets enableAllExternalImports to true in User scope.
 */
export function enableAllExternalImports(loaded: LoadedSettings): boolean {
  if (!canPersistUserApproval(loaded)) return false;
  return loaded.setValue(
    SettingScope.User,
    'security.enableAllExternalImports',
    true,
  );
}
