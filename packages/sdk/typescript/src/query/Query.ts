/**
 * Query class - Main orchestrator for SDK
 *
 * Manages SDK workflow, routes messages, and handles lifecycle.
 * Implements AsyncIterator protocol for message consumption.
 */

import { randomUUID } from 'node:crypto';
import type {
  CLIMessage,
  CLIUserMessage,
  CLIControlRequest,
  CLIControlResponse,
  ControlCancelRequest,
  PermissionApproval,
  PermissionSuggestion,
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
import type { Transport } from '../transport/Transport.js';
import type { CreateQueryOptions } from '../types/config.js';
import { Stream } from '../utils/Stream.js';
import { serializeJsonLine } from '../utils/jsonLines.js';
import { AbortError } from '../types/errors.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { SdkControlServerTransport } from '../mcp/SdkControlServerTransport.js';
import { ControlRequestType } from '../types/controlRequests.js';

/**
 * Pending control request tracking
 */
interface PendingControlRequest {
  resolve: (response: Record<string, unknown> | null) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  abortController: AbortController;
}

/**
 * Hook configuration for SDK initialization
 */
interface HookRegistration {
  matcher: Record<string, unknown>;
  hookCallbackIds: string[];
}

/**
 * Transport with input stream control (e.g., ProcessTransport)
 */
interface TransportWithEndInput extends Transport {
  endInput(): void;
}

/**
 * Query class
 *
 * Main entry point for SDK users. Orchestrates communication with CLI,
 * routes messages, handles control plane, and manages lifecycle.
 */
export class Query implements AsyncIterable<CLIMessage> {
  private transport: Transport;
  private options: CreateQueryOptions;
  private sessionId: string;
  private inputStream: Stream<CLIMessage>;
  private abortController: AbortController;
  private pendingControlRequests: Map<string, PendingControlRequest> =
    new Map();
  private sdkMcpTransports: Map<string, SdkControlServerTransport> = new Map();
  private initialized: Promise<void> | null = null;
  private closed = false;
  private messageRouterStarted = false;

  // First result tracking for MCP servers
  private firstResultReceivedPromise?: Promise<void>;
  private firstResultReceivedResolve?: () => void;

  // Hook callbacks tracking
  private hookCallbacks = new Map<
    string,
    (
      input: unknown,
      toolUseId: string | null,
      options: { signal: AbortSignal },
    ) => Promise<unknown>
  >();
  private nextCallbackId = 0;

  // Single-turn mode flag
  private readonly isSingleTurn: boolean;

  constructor(transport: Transport, options: CreateQueryOptions) {
    this.transport = transport;
    this.options = options;
    this.sessionId = randomUUID();
    this.inputStream = new Stream<CLIMessage>();
    this.abortController = new AbortController();
    this.isSingleTurn = options.singleTurn ?? false;

    // Setup first result tracking
    this.firstResultReceivedPromise = new Promise((resolve) => {
      this.firstResultReceivedResolve = resolve;
    });

    // Handle external abort signal
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        this.abortController.abort();
        // Set abort error on the stream before closing
        this.inputStream.setError(new AbortError('Query aborted by user'));
        this.close().catch((err) => {
          console.error('[Query] Error during abort cleanup:', err);
        });
      });
    }

    // Initialize immediately (no lazy initialization)
    this.initialize();
  }

  /**
   * Initialize the query
   */
  private initialize(): void {
    // Initialize asynchronously but don't block constructor
    // Capture the promise immediately so other code can wait for initialization
    this.initialized = (async () => {
      try {
        // Start transport
        await this.transport.start();

        // Setup SDK-embedded MCP servers
        await this.setupSdkMcpServers();

        // Prepare hooks configuration
        let hooks: Record<string, HookRegistration[]> | undefined;
        if (this.options.hooks) {
          hooks = {};
          for (const [event, matchers] of Object.entries(this.options.hooks)) {
            if (matchers.length > 0) {
              hooks[event] = matchers.map((matcher) => {
                const callbackIds: string[] = [];
                for (const callback of matcher.hooks) {
                  const callbackId = `hook_${this.nextCallbackId++}`;
                  this.hookCallbacks.set(callbackId, callback);
                  callbackIds.push(callbackId);
                }
                return {
                  matcher: matcher.matcher,
                  hookCallbackIds: callbackIds,
                };
              });
            }
          }
        }

        // Start message router in background
        this.startMessageRouter();

        // Send initialize control request
        const sdkMcpServerNames = Array.from(this.sdkMcpTransports.keys());
        await this.sendControlRequest(ControlRequestType.INITIALIZE, {
          hooks: hooks ? Object.values(hooks).flat() : null,
          sdkMcpServers:
            sdkMcpServerNames.length > 0 ? sdkMcpServerNames : undefined,
        });

        // Note: Single-turn prompts are sent directly via transport in createQuery.ts
      } catch (error) {
        console.error('[Query] Initialization error:', error);
        throw error;
      }
    })();
  }

  /**
   * Setup SDK-embedded MCP servers
   */
  private async setupSdkMcpServers(): Promise<void> {
    if (!this.options.sdkMcpServers) {
      return;
    }

    // Validate no name conflicts with external MCP servers
    const externalNames = Object.keys(this.options.mcpServers ?? {});
    const sdkNames = Object.keys(this.options.sdkMcpServers);

    const conflicts = sdkNames.filter((name) => externalNames.includes(name));
    if (conflicts.length > 0) {
      throw new Error(
        `MCP server name conflicts between mcpServers and sdkMcpServers: ${conflicts.join(', ')}`,
      );
    }

    // Import SdkControlServerTransport (dynamic to avoid circular deps)
    const { SdkControlServerTransport } = await import(
      '../mcp/SdkControlServerTransport.js'
    );

    // Create SdkControlServerTransport for each server
    for (const [name, server] of Object.entries(this.options.sdkMcpServers)) {
      // Create transport that sends MCP messages via control plane
      const transport = new SdkControlServerTransport({
        serverName: name,
        sendToQuery: async (message: JSONRPCMessage) => {
          // Send MCP message to CLI via control request
          await this.sendControlRequest(ControlRequestType.MCP_MESSAGE, {
            server_name: name,
            message,
          });
        },
      });

      // Start transport
      await transport.start();

      // Connect server to transport
      await server.connect(transport);

      // Store transport for cleanup
      this.sdkMcpTransports.set(name, transport);
    }
  }

  /**
   * Start message router (background task)
   */
  private startMessageRouter(): void {
    if (this.messageRouterStarted) {
      return;
    }

    this.messageRouterStarted = true;

    // Route messages from transport to input stream
    (async () => {
      try {
        for await (const message of this.transport.readMessages()) {
          await this.routeMessage(message);

          // Stop if closed
          if (this.closed) {
            break;
          }
        }

        // Transport completed - check if aborted first
        if (this.abortController.signal.aborted) {
          this.inputStream.setError(new AbortError('Query aborted'));
        } else {
          this.inputStream.done();
        }
      } catch (error) {
        // Transport error - propagate to stream
        this.inputStream.setError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    })().catch((err) => {
      console.error('[Query] Message router error:', err);
      this.inputStream.setError(
        err instanceof Error ? err : new Error(String(err)),
      );
    });
  }

  /**
   * Route incoming message
   */
  private async routeMessage(message: unknown): Promise<void> {
    // Check control messages first
    if (isControlRequest(message)) {
      // CLI asking SDK for something (permission, MCP message, hook callback)
      await this.handleControlRequest(message);
      return;
    }

    if (isControlResponse(message)) {
      // Response to SDK's control request
      this.handleControlResponse(message);
      return;
    }

    if (isControlCancel(message)) {
      // Cancel pending control request
      this.handleControlCancelRequest(message);
      return;
    }

    // Check data messages
    if (isCLISystemMessage(message)) {
      // SystemMessage - contains session info (cwd, tools, model, etc.) that should be passed to user
      this.inputStream.enqueue(message);
      return;
    }

    if (isCLIResultMessage(message)) {
      // Result message - trigger first result received
      if (this.firstResultReceivedResolve) {
        this.firstResultReceivedResolve();
      }
      // In single-turn mode, automatically close input after receiving result
      if (this.isSingleTurn && 'endInput' in this.transport) {
        (this.transport as TransportWithEndInput).endInput();
      }
      // Pass to user
      this.inputStream.enqueue(message);
      return;
    }

    if (
      isCLIAssistantMessage(message) ||
      isCLIUserMessage(message) ||
      isCLIPartialAssistantMessage(message)
    ) {
      // Pass to user
      this.inputStream.enqueue(message);
      return;
    }

    // Unknown message - log and pass through
    if (process.env['DEBUG_SDK']) {
      console.warn('[Query] Unknown message type:', message);
    }
    this.inputStream.enqueue(message as CLIMessage);
  }

  /**
   * Handle control request from CLI
   */
  private async handleControlRequest(
    request: CLIControlRequest,
  ): Promise<void> {
    const { request_id, request: payload } = request;

    // Create abort controller for this request
    const requestAbortController = new AbortController();

    try {
      let response: Record<string, unknown> | null = null;

      switch (payload.subtype) {
        case 'can_use_tool':
          response = (await this.handlePermissionRequest(
            payload.tool_name,
            payload.input,
            payload.permission_suggestions,
            requestAbortController.signal,
          )) as unknown as Record<string, unknown>;
          break;

        case 'mcp_message':
          response = await this.handleMcpMessage(
            payload.server_name,
            payload.message as unknown as JSONRPCMessage,
          );
          break;

        case 'hook_callback':
          response = await this.handleHookCallback(
            payload.callback_id,
            payload.input,
            payload.tool_use_id,
            requestAbortController.signal,
          );
          break;

        default:
          throw new Error(
            `Unknown control request subtype: ${payload.subtype}`,
          );
      }

      // Send success response
      await this.sendControlResponse(request_id, true, response);
    } catch (error) {
      // Send error response
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await this.sendControlResponse(request_id, false, errorMessage);
    }
  }

  /**
   * Handle permission request (can_use_tool)
   */
  private async handlePermissionRequest(
    toolName: string,
    toolInput: Record<string, unknown>,
    permissionSuggestions: PermissionSuggestion[] | null,
    signal: AbortSignal,
  ): Promise<PermissionApproval> {
    // Default: allow if no callback provided
    if (!this.options.canUseTool) {
      return { allowed: true };
    }

    try {
      // Invoke callback with timeout
      const timeoutMs = 30000; // 30 seconds
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error('Permission callback timeout')),
          timeoutMs,
        );
      });

      // Call with signal and suggestions
      const result = await Promise.race([
        Promise.resolve(
          this.options.canUseTool(toolName, toolInput, {
            signal,
            suggestions: permissionSuggestions,
          }),
        ),
        timeoutPromise,
      ]);

      // Support both boolean and object return values
      if (typeof result === 'boolean') {
        return { allowed: result };
      }
      // Ensure result is a valid PermissionApproval
      return result as PermissionApproval;
    } catch (error) {
      // Timeout or error → deny (fail-safe)
      console.warn(
        '[Query] Permission callback error (denying by default):',
        error instanceof Error ? error.message : String(error),
      );
      return { allowed: false };
    }
  }

  /**
   * Handle MCP message routing
   */
  private async handleMcpMessage(
    serverName: string,
    message: JSONRPCMessage,
  ): Promise<Record<string, unknown>> {
    // Get transport for this server
    const transport = this.sdkMcpTransports.get(serverName);
    if (!transport) {
      throw new Error(
        `MCP server '${serverName}' not found in SDK-embedded servers`,
      );
    }

    // Check if this is a request (has method and id) or notification
    const isRequest =
      'method' in message && 'id' in message && message.id !== null;

    if (isRequest) {
      // Request message - wait for response from MCP server
      const response = await this.handleMcpRequest(
        serverName,
        message,
        transport,
      );
      return { mcp_response: response };
    } else {
      // Notification or response - just route it
      transport.handleMessage(message);
      // Return acknowledgment for notifications
      return { mcp_response: { jsonrpc: '2.0', result: {}, id: 0 } };
    }
  }

  /**
   * Handle MCP request and wait for response
   */
  private handleMcpRequest(
    _serverName: string,
    message: JSONRPCMessage,
    transport: SdkControlServerTransport,
  ): Promise<JSONRPCMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('MCP request timeout'));
      }, 30000); // 30 seconds

      // Store message ID for matching
      const messageId = 'id' in message ? message.id : null;

      // Hook into transport to capture response
      const originalSend = transport.sendToQuery;
      transport.sendToQuery = async (responseMessage: JSONRPCMessage) => {
        if ('id' in responseMessage && responseMessage.id === messageId) {
          clearTimeout(timeout);
          // Restore original send
          transport.sendToQuery = originalSend;
          resolve(responseMessage);
        }
        // Forward to original handler
        return originalSend(responseMessage);
      };

      // Send message to MCP server
      transport.handleMessage(message);
    });
  }

  /**
   * Handle control response from CLI
   */
  private handleControlResponse(response: CLIControlResponse): void {
    const { response: payload } = response;
    const request_id = payload.request_id;

    const pending = this.pendingControlRequests.get(request_id);
    if (!pending) {
      console.warn(
        '[Query] Received response for unknown request:',
        request_id,
      );
      return;
    }

    // Clear timeout
    clearTimeout(pending.timeout);
    this.pendingControlRequests.delete(request_id);

    // Resolve or reject based on response type
    if (payload.subtype === 'success') {
      pending.resolve(payload.response);
    } else {
      pending.reject(new Error(payload.error ?? 'Unknown error'));
    }
  }

  /**
   * Handle control cancel request from CLI
   */
  private handleControlCancelRequest(request: ControlCancelRequest): void {
    const { request_id } = request;

    if (!request_id) {
      console.warn('[Query] Received cancel request without request_id');
      return;
    }

    const pending = this.pendingControlRequests.get(request_id);
    if (pending) {
      // Abort the request
      pending.abortController.abort();

      // Clean up
      clearTimeout(pending.timeout);
      this.pendingControlRequests.delete(request_id);

      // Reject with abort error
      pending.reject(new AbortError('Request cancelled'));
    }
  }

  /**
   * Handle hook callback request
   */
  private async handleHookCallback(
    callbackId: string,
    input: unknown,
    toolUseId: string | null,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const callback = this.hookCallbacks.get(callbackId);
    if (!callback) {
      throw new Error(`No hook callback found for ID: ${callbackId}`);
    }

    // Invoke callback with signal
    const result = await callback(input, toolUseId, { signal });
    return result as Record<string, unknown>;
  }

  /**
   * Send control request to CLI
   */
  private async sendControlRequest(
    subtype: string,
    data: Record<string, unknown> = {},
  ): Promise<Record<string, unknown> | null> {
    const requestId = randomUUID();

    const request: CLIControlRequest = {
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: subtype as never, // Type assertion needed for dynamic subtype
        ...data,
      } as CLIControlRequest['request'],
    };

    // Create promise for response
    const responsePromise = new Promise<Record<string, unknown> | null>(
      (resolve, reject) => {
        const abortController = new AbortController();
        const timeout = setTimeout(() => {
          this.pendingControlRequests.delete(requestId);
          reject(new Error(`Control request timeout: ${subtype}`));
        }, 300000); // 30 seconds

        this.pendingControlRequests.set(requestId, {
          resolve,
          reject,
          timeout,
          abortController,
        });
      },
    );

    // Send request
    this.transport.write(serializeJsonLine(request));

    // Wait for response
    return responsePromise;
  }

  /**
   * Send control response to CLI
   */
  private async sendControlResponse(
    requestId: string,
    success: boolean,
    responseOrError: Record<string, unknown> | null | string,
  ): Promise<void> {
    const response: CLIControlResponse = {
      type: 'control_response',
      response: success
        ? {
            subtype: 'success',
            request_id: requestId,
            response: responseOrError as Record<string, unknown> | null,
          }
        : {
            subtype: 'error',
            request_id: requestId,
            error: responseOrError as string,
          },
    };

    this.transport.write(serializeJsonLine(response));
  }

  /**
   * Close the query and cleanup resources
   *
   * Idempotent - safe to call multiple times.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return; // Already closed
    }

    this.closed = true;

    // Cancel pending control requests
    for (const pending of this.pendingControlRequests.values()) {
      pending.abortController.abort();
      clearTimeout(pending.timeout);
    }
    this.pendingControlRequests.clear();

    // Clear hook callbacks
    this.hookCallbacks.clear();

    // Close transport
    await this.transport.close();

    // Complete input stream - check if aborted first
    if (!this.inputStream.hasError) {
      if (this.abortController.signal.aborted) {
        this.inputStream.setError(new AbortError('Query aborted'));
      } else {
        this.inputStream.done();
      }
    }

    // Cleanup MCP transports
    for (const transport of this.sdkMcpTransports.values()) {
      try {
        await transport.close();
      } catch (error) {
        console.error('[Query] Error closing MCP transport:', error);
      }
    }
    this.sdkMcpTransports.clear();
  }

  /**
   * AsyncIterator protocol: next()
   */
  async next(): Promise<IteratorResult<CLIMessage>> {
    // Wait for initialization to complete if still in progress
    if (this.initialized) {
      await this.initialized;
    }

    return this.inputStream.next();
  }

  /**
   * AsyncIterable protocol: Symbol.asyncIterator
   */
  [Symbol.asyncIterator](): AsyncIterator<CLIMessage> {
    return this;
  }

  /**
   * Send follow-up messages for multi-turn conversations
   *
   * @param messages - Async iterable of user messages to send
   * @throws Error if query is closed
   */
  async streamInput(messages: AsyncIterable<CLIUserMessage>): Promise<void> {
    if (this.closed) {
      throw new Error('Query is closed');
    }

    try {
      // Wait for initialization to complete before sending messages
      // This prevents "write after end" errors when streamInput is called
      // with an empty iterable before initialization finishes
      if (this.initialized) {
        await this.initialized;
      }

      // Send all messages
      for await (const message of messages) {
        // Check if aborted
        if (this.abortController.signal.aborted) {
          break;
        }
        this.transport.write(serializeJsonLine(message));
      }

      // In multi-turn mode with MCP servers, wait for first result
      // to ensure MCP servers have time to process before next input
      if (
        !this.isSingleTurn &&
        this.sdkMcpTransports.size > 0 &&
        this.firstResultReceivedPromise
      ) {
        const STREAM_CLOSE_TIMEOUT = 10000; // 10 seconds

        await Promise.race([
          this.firstResultReceivedPromise,
          new Promise<void>((resolve) => {
            setTimeout(() => {
              resolve();
            }, STREAM_CLOSE_TIMEOUT);
          }),
        ]);
      }

      this.endInput();
    } catch (error) {
      // Check if aborted - if so, set abort error on stream
      if (this.abortController.signal.aborted) {
        this.inputStream.setError(
          new AbortError('Query aborted during input streaming'),
        );
        return;
      }
      throw error;
    }
  }

  /**
   * End input stream (close stdin to CLI)
   *
   * @throws Error if query is closed
   */
  endInput(): void {
    if (this.closed) {
      throw new Error('Query is closed');
    }

    if (
      'endInput' in this.transport &&
      typeof this.transport.endInput === 'function'
    ) {
      (this.transport as TransportWithEndInput).endInput();
    }
  }

  /**
   * Interrupt the current operation
   *
   * @throws Error if query is closed
   */
  async interrupt(): Promise<void> {
    if (this.closed) {
      throw new Error('Query is closed');
    }

    await this.sendControlRequest(ControlRequestType.INTERRUPT);
  }

  /**
   * Set the permission mode for tool execution
   *
   * @param mode - Permission mode ('default' | 'plan' | 'auto-edit' | 'yolo')
   * @throws Error if query is closed
   */
  async setPermissionMode(mode: string): Promise<void> {
    if (this.closed) {
      throw new Error('Query is closed');
    }

    await this.sendControlRequest(ControlRequestType.SET_PERMISSION_MODE, {
      mode,
    });
  }

  /**
   * Set the model for the current query
   *
   * @param model - Model name (e.g., 'qwen-2.5-coder-32b-instruct')
   * @throws Error if query is closed
   */
  async setModel(model: string): Promise<void> {
    if (this.closed) {
      throw new Error('Query is closed');
    }

    await this.sendControlRequest(ControlRequestType.SET_MODEL, { model });
  }

  /**
   * Get list of control commands supported by the CLI
   *
   * @returns Promise resolving to list of supported command names
   * @throws Error if query is closed
   */
  async supportedCommands(): Promise<Record<string, unknown> | null> {
    if (this.closed) {
      throw new Error('Query is closed');
    }

    return this.sendControlRequest(ControlRequestType.SUPPORTED_COMMANDS);
  }

  /**
   * Get the status of MCP servers
   *
   * @returns Promise resolving to MCP server status information
   * @throws Error if query is closed
   */
  async mcpServerStatus(): Promise<Record<string, unknown> | null> {
    if (this.closed) {
      throw new Error('Query is closed');
    }

    return this.sendControlRequest(ControlRequestType.MCP_SERVER_STATUS);
  }

  /**
   * Get the session ID for this query
   *
   * @returns UUID session identifier
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Check if the query has been closed
   *
   * @returns true if query is closed, false otherwise
   */
  isClosed(): boolean {
    return this.closed;
  }
}
