/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Base Controller
 *
 * Abstract base class for domain-specific control plane controllers.
 * Provides common functionality for:
 * - Handling incoming control requests (SDK -> CLI)
 * - Sending outgoing control requests (CLI -> SDK)
 * - Request lifecycle management with timeout and cancellation
 * - Integration with central pending request registry
 */

import { randomUUID } from 'node:crypto';
import type { IControlContext } from '../ControlContext.js';
import type {
  ControlRequestPayload,
  ControlResponse,
  CLIControlRequest,
} from '../../types.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Registry interface for controllers to register/deregister pending requests
 */
export interface IPendingRequestRegistry {
  registerIncomingRequest(
    requestId: string,
    controller: string,
    abortController: AbortController,
    timeoutId: NodeJS.Timeout,
  ): void;
  deregisterIncomingRequest(requestId: string): void;

  registerOutgoingRequest(
    requestId: string,
    controller: string,
    resolve: (response: ControlResponse) => void,
    reject: (error: Error) => void,
    timeoutId: NodeJS.Timeout,
  ): void;
  deregisterOutgoingRequest(requestId: string): void;
}

/**
 * Abstract base controller class
 *
 * Subclasses should implement handleRequestPayload() to process specific
 * control request types.
 */
export abstract class BaseController {
  protected context: IControlContext;
  protected registry: IPendingRequestRegistry;
  protected controllerName: string;

  constructor(
    context: IControlContext,
    registry: IPendingRequestRegistry,
    controllerName: string,
  ) {
    this.context = context;
    this.registry = registry;
    this.controllerName = controllerName;
  }

  /**
   * Handle an incoming control request
   *
   * Manages lifecycle: register -> process -> deregister
   */
  async handleRequest(
    payload: ControlRequestPayload,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    const requestAbortController = new AbortController();

    // Setup timeout
    const timeoutId = setTimeout(() => {
      requestAbortController.abort();
      this.registry.deregisterIncomingRequest(requestId);
      if (this.context.debugMode) {
        console.error(`[${this.controllerName}] Request timeout: ${requestId}`);
      }
    }, DEFAULT_REQUEST_TIMEOUT_MS);

    // Register with central registry
    this.registry.registerIncomingRequest(
      requestId,
      this.controllerName,
      requestAbortController,
      timeoutId,
    );

    try {
      const response = await this.handleRequestPayload(
        payload,
        requestAbortController.signal,
      );

      // Success - deregister
      this.registry.deregisterIncomingRequest(requestId);

      return response;
    } catch (error) {
      // Error - deregister
      this.registry.deregisterIncomingRequest(requestId);
      throw error;
    }
  }

  /**
   * Send an outgoing control request to SDK
   *
   * Manages lifecycle: register -> send -> wait for response -> deregister
   */
  async sendControlRequest(
    payload: ControlRequestPayload,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<ControlResponse> {
    const requestId = randomUUID();

    return new Promise<ControlResponse>((resolve, reject) => {
      // Setup timeout
      const timeoutId = setTimeout(() => {
        this.registry.deregisterOutgoingRequest(requestId);
        reject(new Error('Control request timeout'));
        if (this.context.debugMode) {
          console.error(
            `[${this.controllerName}] Outgoing request timeout: ${requestId}`,
          );
        }
      }, timeoutMs);

      // Register with central registry
      this.registry.registerOutgoingRequest(
        requestId,
        this.controllerName,
        resolve,
        reject,
        timeoutId,
      );

      // Send control request
      const request: CLIControlRequest = {
        type: 'control_request',
        request_id: requestId,
        request: payload,
      };

      try {
        this.context.streamJson.send(request);
      } catch (error) {
        this.registry.deregisterOutgoingRequest(requestId);
        reject(error);
      }
    });
  }

  /**
   * Abstract method: Handle specific request payload
   *
   * Subclasses must implement this to process their domain-specific requests.
   */
  protected abstract handleRequestPayload(
    payload: ControlRequestPayload,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;

  /**
   * Cleanup resources
   */
  cleanup(): void {
    // Subclasses can override to add cleanup logic
  }
}
