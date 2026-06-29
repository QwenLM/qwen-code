/**
 * Unified Auth State Management
 *
 * Qwen Code is the only built-in backend and does not require app-managed LLM
 * credentials. Source and workspace OAuth still use their dedicated auth flows.
 */

import { getActiveWorkspace } from '../config/storage.ts';
import type { AuthType, Workspace } from '../config/types.ts';

export interface MigrationInfo {
  reason: 'legacy_token';
  message: string;
}

export interface AuthState {
  billing: {
    type: AuthType | null;
    hasCredentials: boolean;
    apiKey: string | null;
    migrationRequired?: MigrationInfo;
  };
  workspace: {
    hasWorkspace: boolean;
    active: Workspace | null;
  };
}

export interface SetupNeeds {
  needsBillingConfig: boolean;
  needsCredentials: boolean;
  isFullyConfigured: boolean;
  needsMigration?: MigrationInfo;
}

export async function getAuthState(): Promise<AuthState> {
  const activeWorkspace = getActiveWorkspace();

  return {
    billing: {
      type: null,
      hasCredentials: true,
      apiKey: null,
    },
    workspace: {
      hasWorkspace: !!activeWorkspace,
      active: activeWorkspace,
    },
  };
}

export function getSetupNeeds(_state: AuthState, _setupDeferred?: boolean): SetupNeeds {
  return {
    needsBillingConfig: false,
    needsCredentials: false,
    isFullyConfigured: true,
  };
}

export function _resetRefreshMutex(): void {
  // Kept for test compatibility.
}
