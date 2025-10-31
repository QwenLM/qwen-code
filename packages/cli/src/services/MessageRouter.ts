/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Message Router
 *
 * Routes incoming messages to appropriate handlers based on message type.
 * Provides classification for control messages vs data messages.
 */

import type { Config } from '@qwen-code/qwen-code-core';
import type {
  CLIMessage,
  CLIControlRequest,
  CLIControlResponse,
  ControlCancelRequest,
} from '../types/protocol.js';
import {
  isCLIUserMessage,
  isCLIAssistantMessage,
  isCLISystemMessage,
  isCLIResultMessage,
  isCLIPartialAssistantMessage,
  isControlRequest,
  isControlResponse,
  isControlCancel,
} from '../types/protocol.js';

export type MessageType =
  | 'control_request'
  | 'control_response'
  | 'control_cancel'
  | 'user'
  | 'assistant'
  | 'system'
  | 'result'
  | 'stream_event'
  | 'unknown';

export interface RoutedMessage {
  type: MessageType;
  message:
    | CLIMessage
    | CLIControlRequest
    | CLIControlResponse
    | ControlCancelRequest;
}

/**
 * Message Router
 *
 * Classifies incoming messages and routes them to appropriate handlers.
 */
export class MessageRouter {
  private debugMode: boolean;

  constructor(config: Config) {
    this.debugMode = config.getDebugMode();
  }

  /**
   * Route a message to the appropriate handler based on its type
   */
  route(
    message:
      | CLIMessage
      | CLIControlRequest
      | CLIControlResponse
      | ControlCancelRequest,
  ): RoutedMessage {
    // Check control messages first
    if (isControlRequest(message)) {
      return { type: 'control_request', message };
    }
    if (isControlResponse(message)) {
      return { type: 'control_response', message };
    }
    if (isControlCancel(message)) {
      return { type: 'control_cancel', message };
    }

    // Check data messages
    if (isCLIUserMessage(message)) {
      return { type: 'user', message };
    }
    if (isCLIAssistantMessage(message)) {
      return { type: 'assistant', message };
    }
    if (isCLISystemMessage(message)) {
      return { type: 'system', message };
    }
    if (isCLIResultMessage(message)) {
      return { type: 'result', message };
    }
    if (isCLIPartialAssistantMessage(message)) {
      return { type: 'stream_event', message };
    }

    // Unknown message type
    if (this.debugMode) {
      console.error(
        '[MessageRouter] Unknown message type:',
        JSON.stringify(message, null, 2),
      );
    }
    return { type: 'unknown', message };
  }
}
