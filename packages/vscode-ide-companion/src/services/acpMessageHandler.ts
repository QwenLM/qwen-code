/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ACP Message Handler
 *
 * Responsible for receiving, parsing, and distributing messages in the ACP protocol
 */

import type {
  AcpMessage,
  AcpRequest,
  AcpNotification,
  AcpResponse,
  AcpSessionUpdate,
  AcpPermissionRequest,
  AuthenticateUpdateNotification,
} from '../types/acpTypes.js';
import { CLIENT_METHODS } from '../constants/acpSchema.js';
import type {
  PendingRequest,
  AcpConnectionCallbacks,
} from '../types/connectionTypes.js';
import { AcpFileHandler } from '../services/acpFileHandler.js';
import type { ChildProcess } from 'child_process';

/**
 * ACP Message Handler Class
 * Responsible for receiving, parsing, and processing messages
 */
export class AcpMessageHandler {
  private fileHandler: AcpFileHandler;

  constructor() {
    this.fileHandler = new AcpFileHandler();
  }

  /**
   * Send response message to child process
   *
   * @param child - Child process instance
   * @param response - Response message
   */
  sendResponseMessage(child: ChildProcess | null, response: AcpResponse): void {
    if (child?.stdin) {
      const jsonString = JSON.stringify(response);
      const lineEnding = process.platform === 'win32' ? '\r\n' : '\n';
      child.stdin.write(jsonString + lineEnding);
    }
  }

  /**
   * Handle received messages
   *
   * @param message - ACP message
   * @param pendingRequests - Pending requests map
   * @param callbacks - Callback functions collection
   */
  handleMessage(
    message: AcpMessage,
    pendingRequests: Map<number, PendingRequest<unknown>>,
    callbacks: AcpConnectionCallbacks,
  ): void {
    try {
      if ('method' in message) {
        // Request or notification
        this.handleIncomingRequest(message, callbacks).catch(() => {});
      } else if (
        'id' in message &&
        typeof message.id === 'number' &&
        pendingRequests.has(message.id)
      ) {
        // Response
        this.handleResponse(message, pendingRequests, callbacks);
      }
    } catch (error) {
      console.error('[ACP] Error handling message:', error);
    }
  }

  /**
   * Handle response message
   *
   * @param message - Response message
   * @param pendingRequests - Pending requests map
   * @param callbacks - Callback functions collection
   */
  private handleResponse(
    message: AcpMessage,
    pendingRequests: Map<number, PendingRequest<unknown>>,
    callbacks: AcpConnectionCallbacks,
  ): void {
    if (!('id' in message) || typeof message.id !== 'number') {
      return;
    }

    const pendingRequest = pendingRequests.get(message.id);
    if (!pendingRequest) {
      return;
    }

    const { resolve, reject, method } = pendingRequest;
    pendingRequests.delete(message.id);

    if ('result' in message) {
      console.log(
        `[ACP] Response for ${method}:`,
        // JSON.stringify(message.result).substring(0, 200),
        message.result,
      );

      if (message.result && typeof message.result === 'object') {
        const stopReasonValue =
          (message.result as { stopReason?: unknown }).stopReason ??
          (message.result as { stop_reason?: unknown }).stop_reason;
        if (typeof stopReasonValue === 'string') {
          callbacks.onEndTurn(stopReasonValue);
        } else if (
          'stopReason' in message.result ||
          'stop_reason' in message.result
        ) {
          // stop_reason present but not a string (e.g., null) -> still emit
          callbacks.onEndTurn();
        }
      }
      resolve(message.result);
    } else if ('error' in message) {
      const errorCode = message.error?.code || 'unknown';
      const errorMsg = message.error?.message || 'Unknown ACP error';
      const errorData = message.error?.data
        ? JSON.stringify(message.error.data)
        : '';
      console.error(`[ACP] Error response for ${method}:`, {
        code: errorCode,
        message: errorMsg,
        data: errorData,
      });
      reject(
        new Error(
          `${errorMsg} (code: ${errorCode})${errorData ? '\nData: ' + errorData : ''}`,
        ),
      );
    }
  }

  /**
   * Handle incoming requests
   *
   * @param message - Request or notification message
   * @param callbacks - Callback functions collection
   * @returns Request processing result
   */
  async handleIncomingRequest(
    message: AcpRequest | AcpNotification,
    callbacks: AcpConnectionCallbacks,
  ): Promise<unknown> {
    const { method, params } = message;

    let result = null;

    switch (method) {
      case CLIENT_METHODS.session_update:
        console.log(
          '[ACP] >>> Processing session_update:',
          JSON.stringify(params).substring(0, 300),
        );
        callbacks.onSessionUpdate(params as AcpSessionUpdate);
        break;
      case CLIENT_METHODS.authenticate_update:
        console.log(
          '[ACP] >>> Processing authenticate_update:',
          JSON.stringify(params).substring(0, 300),
        );
        callbacks.onAuthenticateUpdate(
          params as AuthenticateUpdateNotification,
        );
        break;
      case CLIENT_METHODS.session_request_permission:
        result = await this.handlePermissionRequest(
          params as AcpPermissionRequest,
          callbacks,
        );
        break;
      case CLIENT_METHODS.fs_read_text_file:
        result = await this.fileHandler.handleReadTextFile(
          params as {
            path: string;
            sessionId: string;
            line: number | null;
            limit: number | null;
          },
        );
        break;
      case CLIENT_METHODS.fs_write_text_file:
        result = await this.fileHandler.handleWriteTextFile(
          params as { path: string; content: string; sessionId: string },
        );
        break;
      default:
        console.warn(`[ACP] Unhandled method: ${method}`);
        break;
    }

    return result;
  }

  /**
   * Handle permission requests
   *
   * @param params - Permission request parameters
   * @param callbacks - Callback functions collection
   * @returns Permission request result
   */
  private async handlePermissionRequest(
    params: AcpPermissionRequest,
    callbacks: AcpConnectionCallbacks,
  ): Promise<{
    outcome: { outcome: string; optionId: string };
  }> {
    try {
      const response = await callbacks.onPermissionRequest(params);
      const optionId = response?.optionId;
      console.log('[ACP] Permission request:', optionId);
      // Handle cancel, deny, or allow
      let outcome: string;
      if (optionId && (optionId.includes('reject') || optionId === 'cancel')) {
        outcome = 'cancelled';
      } else {
        outcome = 'selected';
      }
      console.log('[ACP] Permission outcome:', outcome);

      return {
        outcome: {
          outcome,
          // optionId: optionId === 'cancel' ? 'cancel' : optionId,
          optionId,
        },
      };
    } catch (_error) {
      return {
        outcome: {
          outcome: 'rejected',
          optionId: 'reject_once',
        },
      };
    }
  }
}
