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
import {
  isAuthenticationRequiredError,
  extractAuthMethodsFromError,
} from '../utils/authErrors.js';
import {
  extractModelInfoFromNewSessionResult,
  extractSessionModeState,
  extractSessionModelState,
} from '../utils/acpModelInfo.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import type { ModelInfo } from '@agentclientprotocol/sdk';
import type { ApprovalModeValue } from '../types/approvalModeValueTypes.js';

export interface QwenConnectionResult {
  sessionCreated: boolean;
  requiresAuth: boolean;
  modelInfo?: ModelInfo;
  availableModels?: ModelInfo[];
  currentModeId?: ApprovalModeValue;
  availableModes?: Array<{
    id: ApprovalModeValue;
    name: string;
    description: string;
  }>;
  authMethods?: Array<Record<string, unknown>>;
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
    let authMethods: Array<Record<string, unknown>> | undefined;
    let modelInfo: ModelInfo | undefined;
    let availableModels: ModelInfo[] | undefined;
    let currentModeId: ApprovalModeValue | undefined;
    let availableModes:
      | Array<{
          id: ApprovalModeValue;
          name: string;
          description: string;
        }>
      | undefined;

    // Build extra CLI arguments (only essential parameters)
    const extraArgs: string[] = [];
    const httpConfig = vscode.workspace.getConfiguration('http');
    const proxyUrl =
      httpConfig.get<string>('proxy') || httpConfig.get<string>('https.proxy');
    if (proxyUrl) {
      extraArgs.push('--proxy', proxyUrl);
      console.log(
        '[QwenAgentManager] Using proxy from VSCode settings:',
        proxyUrl,
      );
    }

    // Retry loop for connection.connect() to handle transient spawn failures
    // (e.g., SIGTERM during the 1-second startup grace period)
    const maxConnectAttempts = 3;
    for (let attempt = 1; attempt <= maxConnectAttempts; attempt++) {
      try {
        console.log(
          `[QwenAgentManager] Connecting to ACP process (attempt ${attempt}/${maxConnectAttempts})...`,
        );
        await connection.connect(cliEntryPath!, workingDir, extraArgs);
        console.log('[QwenAgentManager] ACP process connected successfully');
        break;
      } catch (connectError) {
        console.error(
          `[QwenAgentManager] Connect attempt ${attempt} failed:`,
          getErrorMessage(connectError),
        );
        if (attempt === maxConnectAttempts) {
          throw connectError;
        }
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
        console.log(`[QwenAgentManager] Retrying connect in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

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
        const newSessionResult = await this.newSessionWithRetry(
          connection,
          workingDir,
          3,
          autoAuthenticate,
        );
        modelInfo =
          extractModelInfoFromNewSessionResult(newSessionResult) || undefined;

        // Extract available models from session/new response
        const modelState = extractSessionModelState(newSessionResult);
        if (
          modelState?.availableModels &&
          modelState.availableModels.length > 0
        ) {
          availableModels = modelState.availableModels;
          console.log(
            '[QwenAgentManager] Extracted availableModels from session/new:',
            availableModels.map((m) => m.modelId),
          );
        }
        const modeState = extractSessionModeState(newSessionResult);
        currentModeId = modeState?.currentModeId;
        availableModes = modeState?.availableModes;

        console.log('[QwenAgentManager] New session created successfully');
        sessionCreated = true;
      } catch (sessionError) {
        const needsAuth =
          autoAuthenticate === false &&
          isAuthenticationRequiredError(sessionError);
        if (needsAuth) {
          requiresAuth = true;
          authMethods = extractAuthMethodsFromError(sessionError) || undefined;
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
    return {
      sessionCreated,
      requiresAuth,
      authMethods,
      modelInfo,
      availableModels,
      currentModeId,
      availableModes,
    };
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
    autoAuthenticate: boolean,
  ): Promise<unknown> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(
          `[QwenAgentManager] Creating session (attempt ${attempt}/${maxRetries})...`,
        );
        const res = await connection.newSession(workingDir);
        console.log('[QwenAgentManager] Session created successfully');
        return res;
      } catch (error) {
        lastError = error;
        const errorMessage = getErrorMessage(error);
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
            '[QwenAgentManager] Qwen requires authentication but autoAuthenticate is true. Cannot pick method automatically, skipping inline auth.',
          );
          throw error;
        }

        if (attempt === maxRetries) {
          throw error;
        }

        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.log(`[QwenAgentManager] Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    if (lastError !== undefined) {
      throw lastError;
    }

    throw new Error('Session creation failed unexpectedly');
  }
}
