/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ACP Session Manager
 *
 * Responsible for managing ACP protocol session operations, including initialization, authentication, session creation, and switching
 */

import { JSONRPC_VERSION } from '../constants/acpTypes.js';
import type {
  AcpRequest,
  AcpNotification,
  AcpResponse,
} from '../constants/acpTypes.js';
import { AGENT_METHODS, CUSTOM_METHODS } from '../constants/acpSchema.js';
import type { PendingRequest } from './connectionTypes.js';
import type { ChildProcess } from 'child_process';

/**
 * ACP Session Manager Class
 * Provides session initialization, authentication, creation, loading, and switching functionality
 */
export class AcpSessionManager {
  private sessionId: string | null = null;
  private isInitialized = false;

  /**
   * Send request to ACP server
   *
   * @param method - Request method name
   * @param params - Request parameters
   * @param child - Child process instance
   * @param pendingRequests - Pending requests map
   * @param nextRequestId - Request ID counter
   * @returns Request response
   */
  private sendRequest<T = unknown>(
    method: string,
    params: Record<string, unknown> | undefined,
    child: ChildProcess | null,
    pendingRequests: Map<number, PendingRequest<unknown>>,
    nextRequestId: { value: number },
  ): Promise<T> {
    const id = nextRequestId.value++;
    const message: AcpRequest = {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      ...(params && { params }),
    };

    return new Promise((resolve, reject) => {
      const timeoutDuration =
        method === AGENT_METHODS.session_prompt ? 120000 : 60000;

      const timeoutId = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, timeoutDuration);

      const pendingRequest: PendingRequest<T> = {
        resolve: (value: T) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        reject: (error: Error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
        timeoutId,
        method,
      };

      pendingRequests.set(id, pendingRequest as PendingRequest<unknown>);
      this.sendMessage(message, child);
    });
  }

  /**
   * Send message to child process
   *
   * @param message - Request or notification message
   * @param child - Child process instance
   */
  private sendMessage(
    message: AcpRequest | AcpNotification,
    child: ChildProcess | null,
  ): void {
    if (child?.stdin) {
      const jsonString = JSON.stringify(message);
      const lineEnding = process.platform === 'win32' ? '\r\n' : '\n';
      child.stdin.write(jsonString + lineEnding);
    }
  }

  /**
   * Initialize ACP protocol connection
   *
   * @param child - Child process instance
   * @param pendingRequests - Pending requests map
   * @param nextRequestId - Request ID counter
   * @returns Initialization response
   */
  async initialize(
    child: ChildProcess | null,
    pendingRequests: Map<number, PendingRequest<unknown>>,
    nextRequestId: { value: number },
  ): Promise<AcpResponse> {
    const initializeParams = {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    };

    console.log('[ACP] Sending initialize request...');
    const response = await this.sendRequest<AcpResponse>(
      AGENT_METHODS.initialize,
      initializeParams,
      child,
      pendingRequests,
      nextRequestId,
    );
    this.isInitialized = true;

    console.log('[ACP] Initialize successful');
    return response;
  }

  /**
   * Perform authentication
   *
   * @param methodId - Authentication method ID
   * @param child - Child process instance
   * @param pendingRequests - Pending requests map
   * @param nextRequestId - Request ID counter
   * @returns Authentication response
   */
  async authenticate(
    methodId: string | undefined,
    child: ChildProcess | null,
    pendingRequests: Map<number, PendingRequest<unknown>>,
    nextRequestId: { value: number },
  ): Promise<AcpResponse> {
    const authMethodId = methodId || 'default';
    console.log(
      '[ACP] Sending authenticate request with methodId:',
      authMethodId,
    );
    const response = await this.sendRequest<AcpResponse>(
      AGENT_METHODS.authenticate,
      {
        methodId: authMethodId,
      },
      child,
      pendingRequests,
      nextRequestId,
    );
    console.log('[ACP] Authenticate successful');
    return response;
  }

  /**
   * Create new session
   *
   * @param cwd - Working directory
   * @param child - Child process instance
   * @param pendingRequests - Pending requests map
   * @param nextRequestId - Request ID counter
   * @returns New session response
   */
  async newSession(
    cwd: string,
    child: ChildProcess | null,
    pendingRequests: Map<number, PendingRequest<unknown>>,
    nextRequestId: { value: number },
  ): Promise<AcpResponse> {
    console.log('[ACP] Sending session/new request with cwd:', cwd);
    const response = await this.sendRequest<
      AcpResponse & { sessionId?: string }
    >(
      AGENT_METHODS.session_new,
      {
        cwd,
        mcpServers: [],
      },
      child,
      pendingRequests,
      nextRequestId,
    );

    this.sessionId = response.sessionId || null;
    console.log('[ACP] Session created with ID:', this.sessionId);
    return response;
  }

  /**
   * Send prompt message
   *
   * @param prompt - Prompt content
   * @param child - Child process instance
   * @param pendingRequests - Pending requests map
   * @param nextRequestId - Request ID counter
   * @returns Response
   * @throws Error when there is no active session
   */
  async sendPrompt(
    prompt: string,
    child: ChildProcess | null,
    pendingRequests: Map<number, PendingRequest<unknown>>,
    nextRequestId: { value: number },
  ): Promise<AcpResponse> {
    if (!this.sessionId) {
      throw new Error('No active ACP session');
    }

    return await this.sendRequest(
      AGENT_METHODS.session_prompt,
      {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: prompt }],
      },
      child,
      pendingRequests,
      nextRequestId,
    );
  }

  /**
   * Load existing session
   *
   * @param sessionId - Session ID
   * @param child - Child process instance
   * @param pendingRequests - Pending requests map
   * @param nextRequestId - Request ID counter
   * @returns Load response
   */
  async loadSession(
    sessionId: string,
    child: ChildProcess | null,
    pendingRequests: Map<number, PendingRequest<unknown>>,
    nextRequestId: { value: number },
  ): Promise<AcpResponse> {
    console.log('[ACP] Sending session/load request for session:', sessionId);
    console.log('[ACP] Request parameters:', {
      sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    });

    try {
      const response = await this.sendRequest<AcpResponse>(
        AGENT_METHODS.session_load,
        {
          sessionId,
          cwd: process.cwd(),
          mcpServers: [],
        },
        child,
        pendingRequests,
        nextRequestId,
      );

      console.log(
        '[ACP] Session load response:',
        JSON.stringify(response).substring(0, 500),
      );

      // Check if response contains an error
      if (response.error) {
        console.error('[ACP] Session load returned error:', response.error);
      } else {
        console.log('[ACP] Session load succeeded');
      }

      return response;
    } catch (error) {
      console.error(
        '[ACP] Session load request failed with exception:',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  /**
   * Get session list
   *
   * @param child - Child process instance
   * @param pendingRequests - Pending requests map
   * @param nextRequestId - Request ID counter
   * @returns Session list response
   */
  async listSessions(
    child: ChildProcess | null,
    pendingRequests: Map<number, PendingRequest<unknown>>,
    nextRequestId: { value: number },
  ): Promise<AcpResponse> {
    console.log('[ACP] Requesting session list...');
    try {
      const response = await this.sendRequest<AcpResponse>(
        CUSTOM_METHODS.session_list,
        {},
        child,
        pendingRequests,
        nextRequestId,
      );
      console.log(
        '[ACP] Session list response:',
        JSON.stringify(response).substring(0, 200),
      );
      return response;
    } catch (error) {
      console.error('[ACP] Failed to get session list:', error);
      throw error;
    }
  }

  /**
   * Switch to specified session
   *
   * @param sessionId - Session ID
   * @param nextRequestId - Request ID counter
   * @returns Switch response
   */
  async switchSession(
    sessionId: string,
    nextRequestId: { value: number },
  ): Promise<AcpResponse> {
    console.log('[ACP] Switching to session:', sessionId);
    this.sessionId = sessionId;

    const mockResponse: AcpResponse = {
      jsonrpc: JSONRPC_VERSION,
      id: nextRequestId.value++,
      result: { sessionId },
    };
    console.log(
      '[ACP] Session ID updated locally (switch not supported by CLI)',
    );
    return mockResponse;
  }

  /**
   * Cancel prompt generation for current session
   *
   * @param child - Child process instance
   */
  async cancelSession(child: ChildProcess | null): Promise<void> {
    if (!this.sessionId) {
      console.warn('[ACP] No active session to cancel');
      return;
    }

    console.log('[ACP] Cancelling session:', this.sessionId);

    const cancelParams = {
      sessionId: this.sessionId,
    };

    const message: AcpNotification = {
      jsonrpc: JSONRPC_VERSION,
      method: AGENT_METHODS.session_cancel,
      params: cancelParams,
    };

    this.sendMessage(message, child);
    console.log('[ACP] Cancel notification sent');
  }

  /**
   * Save current session
   *
   * @param tag - Save tag
   * @param child - Child process instance
   * @param pendingRequests - Pending requests map
   * @param nextRequestId - Request ID counter
   * @returns Save response
   */
  async saveSession(
    tag: string,
    child: ChildProcess | null,
    pendingRequests: Map<number, PendingRequest<unknown>>,
    nextRequestId: { value: number },
  ): Promise<AcpResponse> {
    if (!this.sessionId) {
      throw new Error('No active ACP session');
    }

    console.log('[ACP] Saving session with tag:', tag);
    const response = await this.sendRequest<AcpResponse>(
      AGENT_METHODS.session_save,
      {
        sessionId: this.sessionId,
        tag,
      },
      child,
      pendingRequests,
      nextRequestId,
    );
    console.log('[ACP] Session save response:', response);
    return response;
  }

  /**
   * Reset session manager state
   */
  reset(): void {
    this.sessionId = null;
    this.isInitialized = false;
  }

  /**
   * Get current session ID
   */
  getCurrentSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Check if initialized
   */
  getIsInitialized(): boolean {
    return this.isInitialized;
  }
}
