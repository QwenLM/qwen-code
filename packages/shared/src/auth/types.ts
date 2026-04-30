/**
 * Auth Types (Browser-safe)
 *
 * Pure type definitions for authentication state.
 * No runtime dependencies - safe for browser bundling.
 */

import type { AuthType, Workspace } from '../config/types.ts';

/**
 * Unified authentication state
 */
/** Migration info when user needs to re-authenticate */
export interface MigrationInfo {
  reason: 'legacy_token';
  message: string;
}

export interface AuthState {
  /** Built-in backend configuration status */
  billing: {
    /** Configured billing type, or null if not yet configured */
    type: AuthType | null;
    /** True if we have the required credentials for the configured billing type */
    hasCredentials: boolean;
    /** Reserved for legacy API-key UI compatibility */
    apiKey: string | null;
    /** Migration info if user needs to re-authenticate */
    migrationRequired?: MigrationInfo;
  };

  /** Workspace/MCP configuration */
  workspace: {
    hasWorkspace: boolean;
    active: Workspace | null;
  };
}

/**
 * What setup steps are needed
 */
export interface SetupNeeds {
  /** No backend configured -> show setup */
  needsBillingConfig: boolean;
  /** Backend configured but unavailable -> show credential entry */
  needsCredentials: boolean;
  /** Everything complete -> go straight to App */
  isFullyConfigured: boolean;
  /** User has legacy tokens that need migration */
  needsMigration?: MigrationInfo;
}

/**
 * Session context for OAuth flows.
 * Used to build deeplinks that return users to their active chat session
 * after completing OAuth authentication.
 */
export interface OAuthSessionContext {
  /** The session ID to return to after OAuth completes */
  sessionId?: string;
  /** The app's deeplink scheme (e.g., 'craftagents') */
  deeplinkScheme?: string;
}

/**
 * Build a deeplink URL to return to a chat session after OAuth.
 * Returns undefined if session context is incomplete.
 */
export function buildOAuthDeeplinkUrl(ctx?: OAuthSessionContext): string | undefined {
  if (!ctx?.sessionId || !ctx?.deeplinkScheme) return undefined;
  return `${ctx.deeplinkScheme}://allSessions/session/${ctx.sessionId}`;
}
