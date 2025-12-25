/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Qwen Connection Handler
 *
 * Handles Qwen Agent connection establishment, authentication, and session creation
 */

import type { AcpConnection } from './acpConnection.js';
import { isAuthenticationRequiredError } from '../utils/authErrors.js';
import { authMethod } from '../types/acpTypes.js';

export interface QwenConnectionResult {
  sessionCreated: boolean;
  requiresAuth: boolean;
}

/**
 * Qwen Connection Handler class
 * Handles connection, authentication, and session initialization
 */
export class QwenConnectionHandler {
  /**
   * Connect to Qwen service and establish session
   *
   * @param connection - ACP connection instance
   * @param workingDir - Working directory
   * @param cliPath - CLI path (optional, if provided will override the path in configuration)
   */
  async connect(
    connection: AcpConnection,
    workingDir: string,
    cliEntryPath: string,
    options?: {
      autoAuthenticate?: boolean;
    },
  ): Promise<QwenConnectionResult> {
    const connectId = Date.now();
    console.log(`[QwenAgentManager] 🚀 CONNECT() CALLED - ID: ${connectId}`);
    const autoAuthenticate = options?.autoAuthenticate ?? true;
    let sessionCreated = false;
    let requiresAuth = false;

    // Build extra CLI arguments (only essential parameters)
    const extraArgs: string[] = [];

    await connection.connect(cliEntryPath!, workingDir, extraArgs);

    // Try to restore existing session or create new session
    // Note: Auto-restore on connect is disabled to avoid surprising loads
    // when user opens a "New Chat" tab. Restoration is now an explicit action
    // (session selector → session/load) or handled by higher-level flows.
    const sessionRestored = false;

    // Create new session if unable to restore
    if (!sessionRestored) {
      console.log(
        '[QwenAgentManager] no sessionRestored, Creating new session...',
      );

      try {
        console.log(
          '[QwenAgentManager] Creating new session (letting CLI handle authentication)...',
        );
        await this.newSessionWithRetry(
          connection,
          workingDir,
          3,
          authMethod,
          autoAuthenticate,
        );
        console.log('[QwenAgentManager] New session created successfully');
        sessionCreated = true;
      } catch (sessionError) {
        const needsAuth =
          autoAuthenticate === false &&
          isAuthenticationRequiredError(sessionError);
        if (needsAuth) {
          requiresAuth = true;
          console.log(
            '[QwenAgentManager] Session creation requires authentication; waiting for user-triggered login.',
          );
        } else {
          console.log(
            `\n⚠️ [SESSION FAILED] newSessionWithRetry threw error\n`,
          );
          console.log(`[QwenAgentManager] Error details:`, sessionError);
          throw sessionError;
        }
      }
    } else {
      sessionCreated = true;
    }

    console.log(`\n========================================`);
    console.log(`[QwenAgentManager] ✅ CONNECT() COMPLETED SUCCESSFULLY`);
    console.log(`========================================\n`);
    return { sessionCreated, requiresAuth };
  }

  /**
   * Create new session (with retry)
   *
   * @param connection - ACP connection instance
   * @param workingDir - Working directory
   * @param maxRetries - Maximum number of retries
   */
  private async newSessionWithRetry(
    connection: AcpConnection,
    workingDir: string,
    maxRetries: number,
    authMethod: string,
    autoAuthenticate: boolean,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(
          `[QwenAgentManager] Creating session (attempt ${attempt}/${maxRetries})...`,
        );
        await connection.newSession(workingDir);
        console.log('[QwenAgentManager] Session created successfully');
        return;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error(
          `[QwenAgentManager] Session creation attempt ${attempt} failed:`,
          errorMessage,
        );

        // If Qwen reports that authentication is required, try to
        // authenticate on-the-fly once and retry without waiting.
        const requiresAuth = isAuthenticationRequiredError(error);
        if (requiresAuth) {
          if (!autoAuthenticate) {
            console.log(
              '[QwenAgentManager] Authentication required but auto-authentication is disabled. Propagating error.',
            );
            throw error;
          }
          console.log(
            '[QwenAgentManager] Qwen requires authentication. Authenticating and retrying session/new...',
          );
          try {
            await connection.authenticate(authMethod);
            // FIXME: @yiliang114 If there is no delay for a while, immediately executing
            // newSession may cause the cli authorization jump to be triggered again
            // Add a slight delay to ensure auth state is settled
            await new Promise((resolve) => setTimeout(resolve, 300));
            console.log(
              '[QwenAgentManager] newSessionWithRetry Authentication successful',
            );
            // Retry immediately after successful auth
            await connection.newSession(workingDir);
            console.log(
              '[QwenAgentManager] Session created successfully after auth',
            );
            return;
          } catch (authErr) {
            console.error(
              '[QwenAgentManager] Re-authentication failed:',
              authErr,
            );
            // Fall through to retry logic below
          }
        }

        if (attempt === maxRetries) {
          throw new Error(
            `Session creation failed after ${maxRetries} attempts: ${errorMessage}`,
          );
        }

        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.log(`[QwenAgentManager] Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
