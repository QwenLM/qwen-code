/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Control Dispatcher
 *
 * Layer 2 of the control plane architecture. Routes control requests between
 * SDK and CLI to appropriate controllers, manages pending request registries,
 * and handles cancellation/cleanup. Application code MUST NOT depend on
 * controller instances exposed by this class; instead, use ControlService,
 * which wraps these controllers with a stable programmatic API.
 *
 * Controllers:
 * - SystemController: initialize, interrupt, set_model, supported_commands
 * - PermissionController: can_use_tool, set_permission_mode
 * - MCPController: mcp_message, mcp_server_status
 * - HookController: hook_callback
 *
 * Note: Control request types are centrally defined in the ControlRequestType
 * enum in packages/sdk/typescript/src/types/controlRequests.ts
 */

import type { IControlContext } from './ControlContext.js';
import type { IPendingRequestRegistry } from './controllers/baseController.js';
import { SystemController } from './controllers/systemController.js';
// import { PermissionController } from './controllers/permissionController.js';
// import { MCPController } from './controllers/mcpController.js';
// import { HookController } from './controllers/hookController.js';
import type {
  CLIControlRequest,
  CLIControlResponse,
  ControlResponse,
  ControlRequestPayload,
} from '../types.js';

/**
 * Tracks an incoming request from SDK awaiting CLI response
 */
interface PendingIncomingRequest {
  controller: string;
  abortController: AbortController;
  timeoutId: NodeJS.Timeout;
}

/**
 * Tracks an outgoing request from CLI awaiting SDK response
 */
interface PendingOutgoingRequest {
  controller: string;
  resolve: (response: ControlResponse) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

/**
 * Central coordinator for control plane communication.
 * Routes requests to controllers and manages request lifecycle.
 */
export class ControlDispatcher implements IPendingRequestRegistry {
  private context: IControlContext;

  // Make controllers publicly accessible
  readonly systemController: SystemController;
  // readonly permissionController: PermissionController;
  // readonly mcpController: MCPController;
  // readonly hookController: HookController;

  // Central pending request registries
  private pendingIncomingRequests: Map<string, PendingIncomingRequest> =
    new Map();
  private pendingOutgoingRequests: Map<string, PendingOutgoingRequest> =
    new Map();

  constructor(context: IControlContext) {
    this.context = context;

    // Create domain controllers with context and registry
    this.systemController = new SystemController(
      context,
      this,
      'SystemController',
    );
    // this.permissionController = new PermissionController(
    //   context,
    //   this,
    //   'PermissionController',
    // );
    // this.mcpController = new MCPController(context, this, 'MCPController');
    // this.hookController = new HookController(context, this, 'HookController');

    // Listen for main abort signal
    this.context.abortSignal.addEventListener('abort', () => {
      this.shutdown();
    });
  }

  /**
   * Routes an incoming request to the appropriate controller and sends response
   */
  async dispatch(request: CLIControlRequest): Promise<void> {
    const { request_id, request: payload } = request;

    try {
      // Route to appropriate controller
      const controller = this.getControllerForRequest(payload.subtype);
      const response = await controller.handleRequest(payload, request_id);

      // Send success response
      this.sendSuccessResponse(request_id, response);
    } catch (error) {
      // Send error response
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.sendErrorResponse(request_id, errorMessage);
    }
  }

  /**
   * Processes response from SDK for an outgoing request
   */
  handleControlResponse(response: CLIControlResponse): void {
    const responsePayload = response.response;
    const requestId = responsePayload.request_id;

    const pending = this.pendingOutgoingRequests.get(requestId);
    if (!pending) {
      // No pending request found - may have timed out or been cancelled
      if (this.context.debugMode) {
        console.error(
          `[ControlDispatcher] No pending outgoing request for: ${requestId}`,
        );
      }
      return;
    }

    // Deregister
    this.deregisterOutgoingRequest(requestId);

    // Resolve or reject based on response type
    if (responsePayload.subtype === 'success') {
      pending.resolve(responsePayload);
    } else {
      const errorMessage =
        typeof responsePayload.error === 'string'
          ? responsePayload.error
          : (responsePayload.error?.message ?? 'Unknown error');
      pending.reject(new Error(errorMessage));
    }
  }

  /**
   * Sends a control request to SDK and waits for response
   */
  async sendControlRequest(
    payload: ControlRequestPayload,
    timeoutMs?: number,
  ): Promise<ControlResponse> {
    // Delegate to system controller (or any controller, they all have the same method)
    return this.systemController.sendControlRequest(payload, timeoutMs);
  }

  /**
   * Cancels a specific request or all pending requests
   */
  handleCancel(requestId?: string): void {
    if (requestId) {
      // Cancel specific incoming request
      const pending = this.pendingIncomingRequests.get(requestId);
      if (pending) {
        pending.abortController.abort();
        this.deregisterIncomingRequest(requestId);
        this.sendErrorResponse(requestId, 'Request cancelled');

        if (this.context.debugMode) {
          console.error(
            `[ControlDispatcher] Cancelled incoming request: ${requestId}`,
          );
        }
      }
    } else {
      // Cancel ALL pending incoming requests
      const requestIds = Array.from(this.pendingIncomingRequests.keys());
      for (const id of requestIds) {
        const pending = this.pendingIncomingRequests.get(id);
        if (pending) {
          pending.abortController.abort();
          this.deregisterIncomingRequest(id);
          this.sendErrorResponse(id, 'All requests cancelled');
        }
      }

      if (this.context.debugMode) {
        console.error(
          `[ControlDispatcher] Cancelled all ${requestIds.length} pending incoming requests`,
        );
      }
    }
  }

  /**
   * Stops all pending requests and cleans up all controllers
   */
  shutdown(): void {
    if (this.context.debugMode) {
      console.error('[ControlDispatcher] Shutting down');
    }

    // Cancel all incoming requests
    for (const [
      _requestId,
      pending,
    ] of this.pendingIncomingRequests.entries()) {
      pending.abortController.abort();
      clearTimeout(pending.timeoutId);
    }
    this.pendingIncomingRequests.clear();

    // Cancel all outgoing requests
    for (const [
      _requestId,
      pending,
    ] of this.pendingOutgoingRequests.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Dispatcher shutdown'));
    }
    this.pendingOutgoingRequests.clear();

    // Cleanup controllers (MCP controller will close all clients)
    this.systemController.cleanup();
    // this.permissionController.cleanup();
    // this.mcpController.cleanup();
    // this.hookController.cleanup();
  }

  /**
   * Registers an incoming request in the pending registry
   */
  registerIncomingRequest(
    requestId: string,
    controller: string,
    abortController: AbortController,
    timeoutId: NodeJS.Timeout,
  ): void {
    this.pendingIncomingRequests.set(requestId, {
      controller,
      abortController,
      timeoutId,
    });
  }

  /**
   * Removes an incoming request from the pending registry
   */
  deregisterIncomingRequest(requestId: string): void {
    const pending = this.pendingIncomingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingIncomingRequests.delete(requestId);
    }
  }

  /**
   * Registers an outgoing request in the pending registry
   */
  registerOutgoingRequest(
    requestId: string,
    controller: string,
    resolve: (response: ControlResponse) => void,
    reject: (error: Error) => void,
    timeoutId: NodeJS.Timeout,
  ): void {
    this.pendingOutgoingRequests.set(requestId, {
      controller,
      resolve,
      reject,
      timeoutId,
    });
  }

  /**
   * Removes an outgoing request from the pending registry
   */
  deregisterOutgoingRequest(requestId: string): void {
    const pending = this.pendingOutgoingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingOutgoingRequests.delete(requestId);
    }
  }

  /**
   * Returns the controller that handles the given request subtype
   */
  private getControllerForRequest(subtype: string) {
    switch (subtype) {
      case 'initialize':
      case 'interrupt':
      case 'set_model':
      case 'supported_commands':
        return this.systemController;

      // case 'can_use_tool':
      // case 'set_permission_mode':
      //   return this.permissionController;

      // case 'mcp_message':
      // case 'mcp_server_status':
      //   return this.mcpController;

      // case 'hook_callback':
      //   return this.hookController;

      default:
        throw new Error(`Unknown control request subtype: ${subtype}`);
    }
  }

  /**
   * Sends a success response back to SDK
   */
  private sendSuccessResponse(
    requestId: string,
    response: Record<string, unknown>,
  ): void {
    const controlResponse: CLIControlResponse = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response,
      },
    };
    this.context.streamJson.send(controlResponse);
  }

  /**
   * Sends an error response back to SDK
   */
  private sendErrorResponse(requestId: string, error: string): void {
    const controlResponse: CLIControlResponse = {
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: requestId,
        error,
      },
    };
    this.context.streamJson.send(controlResponse);
  }
}
