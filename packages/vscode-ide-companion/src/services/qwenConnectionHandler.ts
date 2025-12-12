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
import type { AcpConnection } from './acpConnection.js';
import type { QwenSessionReader } from '../services/qwenSessionReader.js';
import {
  CliVersionManager,
  MIN_CLI_VERSION_FOR_SESSION_METHODS,
} from '../cli/cliVersionManager.js';
import { CliContextManager } from '../cli/cliContextManager.js';
import { authMethod } from '../types/acpTypes.js';

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
   * @param cliPath - CLI path (optional, if provided will override the path in configuration)
   */
  async connect(
    connection: AcpConnection,
    sessionReader: QwenSessionReader,
    workingDir: string,
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
      // Wait to determine release version number
      vscode.window.showWarningMessage(
        `Qwen Code CLI version ${versionInfo.version} is below the minimum required version. Some features may not work properly. Please upgrade to version ${MIN_CLI_VERSION_FOR_SESSION_METHODS} or later.`,
      );
    }

    const config = vscode.workspace.getConfiguration('qwenCode');
    // Use the provided CLI path if available, otherwise use the configured path
    const effectiveCliPath =
      cliPath || config.get<string>('qwen.cliPath', 'qwen');

    // Build extra CLI arguments (only essential parameters)
    const extraArgs: string[] = [];

    await connection.connect(effectiveCliPath, workingDir, extraArgs);

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
        await this.newSessionWithRetry(connection, workingDir, 3, authMethod);
        console.log('[QwenAgentManager] New session created successfully');
      } catch (sessionError) {
        console.log(`\n⚠️ [SESSION FAILED] newSessionWithRetry threw error\n`);
        console.log(`[QwenAgentManager] Error details:`, sessionError);
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
        const requiresAuth =
          errorMessage.includes('Authentication required') ||
          errorMessage.includes('(code: -32000)');
        if (requiresAuth) {
          console.log(
            '[QwenAgentManager] Qwen requires authentication. Authenticating and retrying session/new...',
          );
          try {
            await connection.authenticate(authMethod);
            // FIXME: @yiliang114 If there is no delay for a while, immediately executing
            // newSession may cause the cli authorization jump to be triggered again
            // Add a slight delay to ensure auth state is settled
            await new Promise((resolve) => setTimeout(resolve, 300));
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
