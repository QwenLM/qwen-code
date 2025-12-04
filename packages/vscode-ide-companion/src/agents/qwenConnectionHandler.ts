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

import * as vscode from 'vscode';
import type { AcpConnection } from '../acp/acpConnection.js';
import type { QwenSessionReader } from '../services/qwenSessionReader.js';
import type { AuthStateManager } from '../auth/authStateManager.js';
import { CliVersionManager } from '../cli/cliVersionManager.js';
import { CliContextManager } from '../cli/cliContextManager.js';

/**
 * Qwen Connection Handler class
 * Handles connection, authentication, and session initialization
 */
export class QwenConnectionHandler {
  /**
   * Connect to Qwen service and establish session
   *
   * @param connection - ACP connection instance
   * @param sessionReader - Session reader instance
   * @param workingDir - Working directory
   * @param authStateManager - Authentication state manager (optional)
   * @param cliPath - CLI path (optional, if provided will override the path in configuration)
   */
  async connect(
    connection: AcpConnection,
    sessionReader: QwenSessionReader,
    workingDir: string,
    authStateManager?: AuthStateManager,
    cliPath?: string,
  ): Promise<void> {
    const connectId = Date.now();
    console.log(`[QwenAgentManager] 🚀 CONNECT() CALLED - ID: ${connectId}`);

    // Check CLI version and features
    const cliVersionManager = CliVersionManager.getInstance();
    const versionInfo = await cliVersionManager.detectCliVersion();
    console.log('[QwenAgentManager] CLI version info:', versionInfo);

    // Store CLI context
    const cliContextManager = CliContextManager.getInstance();
    cliContextManager.setCurrentVersionInfo(versionInfo);

    // Show warning if CLI version is below minimum requirement
    if (!versionInfo.isSupported) {
      console.warn(
        `[QwenAgentManager] CLI version ${versionInfo.version} is below minimum required version ${'0.2.4'}`,
      );

      // TODO: Wait to determine release version number
      // vscode.window.showWarningMessage(
      //   `Qwen Code CLI version ${versionInfo.version} is below the minimum required version. Some features may not work properly. Please upgrade to version 0.2.4 or later.`,
      // );
    }

    const config = vscode.workspace.getConfiguration('qwenCode');
    // Use the provided CLI path if available, otherwise use the configured path
    const effectiveCliPath =
      cliPath || config.get<string>('qwen.cliPath', 'qwen');
    const openaiApiKey = config.get<string>('qwen.openaiApiKey', '');
    const openaiBaseUrl = config.get<string>('qwen.openaiBaseUrl', '');
    const model = config.get<string>('qwen.model', '');
    const proxy = config.get<string>('qwen.proxy', '');

    // Build extra CLI arguments
    const extraArgs: string[] = [];
    if (openaiApiKey) {
      extraArgs.push('--openai-api-key', openaiApiKey);
    }
    if (openaiBaseUrl) {
      extraArgs.push('--openai-base-url', openaiBaseUrl);
    }
    if (model) {
      extraArgs.push('--model', model);
    }
    if (proxy) {
      extraArgs.push('--proxy', proxy);
      console.log('[QwenAgentManager] Using proxy:', proxy);
    }

    await connection.connect('qwen', effectiveCliPath, workingDir, extraArgs);

    // Determine authentication method
    const authMethod = openaiApiKey ? 'openai' : 'qwen-oauth';

    // Check if we have valid cached authentication
    if (authStateManager) {
      console.log('[QwenAgentManager] Checking for cached authentication...');
      console.log('[QwenAgentManager] Working dir:', workingDir);
      console.log('[QwenAgentManager] Auth method:', authMethod);
      const hasValidAuth = await authStateManager.hasValidAuth(
        workingDir,
        authMethod,
      );
      console.log('[QwenAgentManager] Has valid auth:', hasValidAuth);
      if (hasValidAuth) {
        console.log('[QwenAgentManager] Using cached authentication');
      } else {
        console.log('[QwenAgentManager] No valid cached authentication found');
      }
    } else {
      console.log('[QwenAgentManager] No authStateManager provided');
    }

    // Try to restore existing session or create new session
    let sessionRestored = false;

    // Try to get session from local files
    console.log('[QwenAgentManager] Reading local session files...');
    try {
      const sessions = await sessionReader.getAllSessions(workingDir);

      if (sessions.length > 0) {
        console.log(
          '[QwenAgentManager] Found existing sessions:',
          sessions.length,
        );
        const lastSession = sessions[0]; // Already sorted by lastUpdated

        try {
          await connection.switchSession(lastSession.sessionId);
          console.log(
            '[QwenAgentManager] Restored session:',
            lastSession.sessionId,
          );
          sessionRestored = true;

          // Save auth state after successful session restore
          if (authStateManager) {
            console.log(
              '[QwenAgentManager] Saving auth state after successful session restore',
            );
            await authStateManager.saveAuthState(workingDir, authMethod);
          }
        } catch (switchError) {
          console.log(
            '[QwenAgentManager] session/switch not supported or failed:',
            switchError instanceof Error
              ? switchError.message
              : String(switchError),
          );
        }
      } else {
        console.log('[QwenAgentManager] No existing sessions found');
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.log(
        '[QwenAgentManager] Failed to read local sessions:',
        errorMessage,
      );
    }

    // Create new session if unable to restore
    if (!sessionRestored) {
      console.log(
        '[QwenAgentManager] no sessionRestored, Creating new session...',
      );

      // Check if we have valid cached authentication
      let hasValidAuth = false;
      if (authStateManager) {
        hasValidAuth = await authStateManager.hasValidAuth(
          workingDir,
          authMethod,
        );
      }

      // Only authenticate if we don't have valid cached auth
      if (!hasValidAuth) {
        console.log(
          '[QwenAgentManager] Authenticating before creating session...',
        );
        try {
          await connection.authenticate(authMethod);
          console.log('[QwenAgentManager] Authentication successful');

          // Save auth state
          if (authStateManager) {
            console.log(
              '[QwenAgentManager] Saving auth state after successful authentication',
            );
            console.log('[QwenAgentManager] Working dir for save:', workingDir);
            console.log('[QwenAgentManager] Auth method for save:', authMethod);
            await authStateManager.saveAuthState(workingDir, authMethod);
            console.log('[QwenAgentManager] Auth state save completed');
          }
        } catch (authError) {
          console.error('[QwenAgentManager] Authentication failed:', authError);
          // Clear potentially invalid cache
          if (authStateManager) {
            console.log(
              '[QwenAgentManager] Clearing auth cache due to authentication failure',
            );
            await authStateManager.clearAuthState();
          }
          throw authError;
        }
      } else {
        console.log(
          '[QwenAgentManager] Skipping authentication - using valid cached auth',
        );
      }

      try {
        console.log(
          '[QwenAgentManager] Creating new session after authentication...',
        );
        await this.newSessionWithRetry(
          connection,
          workingDir,
          3,
          authMethod,
          authStateManager,
        );
        console.log('[QwenAgentManager] New session created successfully');

        // Ensure auth state is saved (prevent repeated authentication)
        if (authStateManager && !hasValidAuth) {
          console.log(
            '[QwenAgentManager] Saving auth state after successful session creation',
          );
          await authStateManager.saveAuthState(workingDir, authMethod);
        }
      } catch (sessionError) {
        console.log(`\n⚠️ [SESSION FAILED] newSessionWithRetry threw error\n`);
        console.log(`[QwenAgentManager] Error details:`, sessionError);

        // Clear cache
        if (authStateManager) {
          console.log('[QwenAgentManager] Clearing auth cache due to failure');
          await authStateManager.clearAuthState();
        }

        throw sessionError;
      }
    }

    console.log(`\n========================================`);
    console.log(`[QwenAgentManager] ✅ CONNECT() COMPLETED SUCCESSFULLY`);
    console.log(`========================================\n`);
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
    authStateManager?: AuthStateManager,
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

        // If the backend reports that authentication is required, try to
        // authenticate on-the-fly once and retry without waiting.
        const requiresAuth =
          errorMessage.includes('Authentication required') ||
          errorMessage.includes('(code: -32000)');
        if (requiresAuth) {
          console.log(
            '[QwenAgentManager] Backend requires authentication. Authenticating and retrying session/new...',
          );
          try {
            await connection.authenticate(authMethod);
            if (authStateManager) {
              await authStateManager.saveAuthState(workingDir, authMethod);
            }
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
            if (authStateManager) {
              await authStateManager.clearAuthState();
            }
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
