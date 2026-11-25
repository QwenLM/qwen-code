/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PermissionRuleSource } from '@qwen-code/core';
import { ToolConfirmationOutcome } from '@qwen-code/core';
import { theme } from '../semantic-colors.js';

/**
 * Shape of the coloured origin tag rendered next to a workspace directory
 * entry. The `color` is read from the runtime semantic-colour theme so the
 * visual stays consistent across light / dark / no-colour themes without
 * hard-coding hex values at the call site.
 */
export interface ScopeTag {
  label: string;
  color: string;
}

/**
 * Maps a directory's WorkingDirectorySource to a human-readable scope label
 * plus a semantic theme colour that signals the scope at a glance:
 *
 *   - session / command            → yellow  ("session")
 *   - localSettings                → link    ("project (local)")
 *   - projectSettings              → cyan    ("project")
 *   - userSettings                 → green   ("user")
 *   - cliArg / flagSettings        → purple  ("cli" / "--settings")
 *   - policySettings               → red     ("policy")
 *
 * Returns null only when the source is unknown.
 *
 * Shared between the Trust tab listing (TrustTab.tsx) and the Add-directory
 * candidate dropdown (DirectoryPathInput.tsx) so both surfaces describe the
 * same entry with identical wording and colouring.
 */
export function formatScopeTag(
  source: PermissionRuleSource | undefined,
): ScopeTag | null {
  switch (source) {
    case 'session':
    case 'command':
      return { label: 'session', color: theme.status.warning };
    case 'localSettings':
      return { label: 'local', color: theme.status.success };
    case 'projectSettings':
      return { label: 'project', color: theme.status.success };
    case 'userSettings':
      return { label: 'user', color: theme.status.success };
    case 'cliArg':
      return { label: '--allowed-tools', color: theme.text.accent };
    case 'flagSettings':
      return { label: '--settings', color: theme.text.accent };
    case 'policySettings':
      return { label: 'policy', color: theme.status.error };
    default:
      return null;
  }
}

/** Sources that cannot be added/deleted through the UI. */
const READ_ONLY_SOURCES: ReadonlySet<PermissionRuleSource> = new Set([
  'policySettings',
  'flagSettings',
  'cliArg',
]);

/**
 * Returns true when a permission rule source is read-only (not editable
 * through the /permissions UI).
 */
export function isReadOnlySource(source: PermissionRuleSource): boolean {
  return READ_ONLY_SOURCES.has(source);
}

/**
 * Maps a ToolConfirmationOutcome to a scope tag indicating where the
 * resulting rule will be stored. Used in permission prompt options.
 */
export function formatOutcomeScopeTag(
  outcome: ToolConfirmationOutcome,
): ScopeTag | null {
  switch (outcome) {
    case ToolConfirmationOutcome.ProceedSession:
      return { label: 'session', color: theme.status.warning };
    case ToolConfirmationOutcome.ProceedPersist:
      return { label: 'local', color: theme.status.success };
    default:
      return null;
  }
}
