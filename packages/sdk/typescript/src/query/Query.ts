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

interface PendingControlRequest {
  resolve: (response: Record<string, unknown> | null) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  abortController: AbortController;
}

interface HookRegistration {
  matcher: Record<string, unknown>;
  hookCallbackIds: string[];
}

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
  private sdkMessages: AsyncGenerator<CLIMessage>;
  private abortController: AbortController;
  private pendingControlRequests: Map<string, PendingControlRequest> =
    new Map();
  private sdkMcpTransports: Map<string, SdkControlServerTransport> = new Map();
  private initialized: Promise<void>;
  private closed = false;
  private messageRouterStarted = false;

  private firstResultReceivedPromise?: Promise<void>;
  private firstResultReceivedResolve?: () => void;

  private hookCallbacks = new Map<
    string,
    (
      input: unknown,
      toolUseId: string | null,
      options: { signal: AbortSignal },
    ) => Promise<unknown>
  >();
  private nextCallbackId = 0;

  private readonly isSingleTurn: boolean;

  constructor(transport: Transport, options: CreateQueryOptions) {
    this.transport = transport;
    this.options = options;
    this.sessionId = randomUUID();
    this.inputStream = new Stream<CLIMessage>();
    this.abortController = options.abortController ?? new AbortController();
    this.isSingleTurn = options.singleTurn ?? false;

    /**
     * Create async generator proxy to ensure stream.next() is called at least once.
     * The generator will start iterating when the user begins iteration.
     * This ensures readResolve/readReject are set up as soon as iteration starts.
     * If errors occur before iteration starts, they'll be stored in hasError and
     * properly rejected when the user starts iterating.
     */
    this.sdkMessages = this.readSdkMessages();

    this.firstResultReceivedPromise = new Promise((resolve) => {
      this.firstResultReceivedResolve = resolve;
    });

    /**
     * Handle abort signal if controller is provided and already aborted or will be aborted.
     * If already aborted, set error immediately. Otherwise, listen for abort events
     * and set abort error on the stream before closing.
     */
    if (this.abortController.signal.aborted) {
      this.inputStream.error(new AbortError('Query aborted by user'));
      this.close().catch((err) => {
        console.error('[Query] Error during abort cleanup:', err);
      });
    } else {
      this.abortController.signal.addEventListener('abort', () => {
        this.inputStream.error(new AbortError('Query aborted by user'));
        this.close().catch((err) => {
          console.error('[Query] Error during abort cleanup:', err);
        });
      });
    }

    this.initialized = this.initialize();
    this.initialized.catch(() => {});

    this.startMessageRouter();
  }

  /**
   * Initialize the query
   */
  private async initialize(): Promise<void> {
    try {
      await this.setupSdkMcpServers();

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

      const sdkMcpServerNames = Array.from(this.sdkMcpTransports.keys());
      await this.sendControlRequest(ControlRequestType.INITIALIZE, {
        hooks: hooks ? Object.values(hooks).flat() : null,
        sdkMcpServers:
          sdkMcpServerNames.length > 0 ? sdkMcpServerNames : undefined,
      });
    } catch (error) {
      console.error('[Query] Initialization error:', error);
      throw error;
    }
  }

  /**
   * Setup SDK-embedded MCP servers
   */
  private async setupSdkMcpServers(): Promise<void> {
    if (!this.options.sdkMcpServers) {
      return;
    }

    const externalNames = Object.keys(this.options.mcpServers ?? {});
    const sdkNames = Object.keys(this.options.sdkMcpServers);

    const conflicts = sdkNames.filter((name) => externalNames.includes(name));
    if (conflicts.length > 0) {
      throw new Error(
        `MCP server name conflicts between mcpServers and sdkMcpServers: ${conflicts.join(', ')}`,
      );
    }

    /**
     * Import SdkControlServerTransport dynamically to avoid circular dependencies.
     * Create transport for each server that sends MCP messages via control plane.
     */
    const { SdkControlServerTransport } = await import(
      '../mcp/SdkControlServerTransport.js'
    );

    for (const [name, server] of Object.entries(this.options.sdkMcpServers)) {
      const transport = new SdkControlServerTransport({
        serverName: name,
        sendToQuery: async (message: JSONRPCMessage) => {
          await this.sendControlRequest(ControlRequestType.MCP_MESSAGE, {
            server_name: name,
            message,
          });
        },
      });

      await transport.start();
      await server.connect(transport);
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

    (async () => {
      try {
        for await (const message of this.transport.readMessages()) {
          await this.routeMessage(message);

          if (this.closed) {
            break;
          }
        }

        if (this.abortController.signal.aborted) {
          this.inputStream.error(new AbortError('Query aborted'));
        } else {
          this.inputStream.done();
        }
      } catch (error) {
        this.inputStream.error(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    })();
  }

  /**
   * Route incoming message
   */
  private async routeMessage(message: unknown): Promise<void> {
    if (isControlRequest(message)) {
      await this.handleControlRequest(message);
      return;
    }

    if (isControlResponse(message)) {
      this.handleControlResponse(message);
      return;
    }

    if (isControlCancel(message)) {
      this.handleControlCancelRequest(message);
      return;
    }

    if (isCLISystemMessage(message)) {
      /**
       * SystemMessage contains session info (cwd, tools, model, etc.)
       * that should be passed to user.
       */
      this.inputStream.enqueue(message);
      return;
    }

    if (isCLIResultMessage(message)) {
      if (this.firstResultReceivedResolve) {
        this.firstResultReceivedResolve();
      }
      /**
       * In single-turn mode, automatically close input after receiving result
       * to signal completion to the CLI.
       */
      if (this.isSingleTurn && 'endInput' in this.transport) {
        (this.transport as TransportWithEndInput).endInput();
      }
      this.inputStream.enqueue(message);
      return;
    }

    if (
      isCLIAssistantMessage(message) ||
      isCLIUserMessage(message) ||
      isCLIPartialAssistantMessage(message)
    ) {
      this.inputStream.enqueue(message);
      return;
    }

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

    const requestAbortController = new AbortController();

    try {
      let response: Record<string, unknown> | null = null;

      switch (payload.subtype) {
        case 'can_use_tool':
          response = (await this.handlePermissionRequest(
            payload.tool_name,
            payload.input as Record<string, unknown>,
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

      await this.sendControlResponse(request_id, true, response);
    } catch (error) {
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
    if (!this.options.canUseTool) {
      return { allowed: true };
    }

    try {
      const timeoutMs = 30000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error('Permission callback timeout')),
          timeoutMs,
        );
      });

      const result = await Promise.race([
        Promise.resolve(
          this.options.canUseTool(toolName, toolInput, {
            signal,
            suggestions: permissionSuggestions,
          }),
        ),
        timeoutPromise,
      ]);

      if (typeof result === 'boolean') {
        return { allowed: result };
      }
      return result as PermissionApproval;
    } catch (error) {
      /**
       * Timeout or error → deny (fail-safe).
       * This ensures that any issues with the permission callback
       * result in a safe default of denying access.
       */
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
    const transport = this.sdkMcpTransports.get(serverName);
    if (!transport) {
      throw new Error(
        `MCP server '${serverName}' not found in SDK-embedded servers`,
      );
    }

    /**
     * Check if this is a request (has method and id) or notification.
     * Requests need to wait for a response, while notifications are just routed.
     */
    const isRequest =
      'method' in message && 'id' in message && message.id !== null;

    if (isRequest) {
      const response = await this.handleMcpRequest(
        serverName,
        message,
        transport,
      );
      return { mcp_response: response };
    } else {
      transport.handleMessage(message);
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
      }, 30000);

      const messageId = 'id' in message ? message.id : null;

      /**
       * Hook into transport to capture response.
       * Temporarily replace sendToQuery to intercept the response message
       * matching this request's ID, then restore the original handler.
       */
      const originalSend = transport.sendToQuery;
      transport.sendToQuery = async (responseMessage: JSONRPCMessage) => {
        if ('id' in responseMessage && responseMessage.id === messageId) {
          clearTimeout(timeout);
          transport.sendToQuery = originalSend;
          resolve(responseMessage);
        }
        return originalSend(responseMessage);
      };

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

    clearTimeout(pending.timeout);
    this.pendingControlRequests.delete(request_id);

    if (payload.subtype === 'success') {
      pending.resolve(payload.response as Record<string, unknown> | null);
    } else {
      /**
       * Extract error message from error field.
       * Error can be either a string or an object with a message property.
       */
      const errorMessage =
        typeof payload.error === 'string'
          ? payload.error
          : (payload.error?.message ?? 'Unknown error');
      pending.reject(new Error(errorMessage));
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
      pending.abortController.abort();
      clearTimeout(pending.timeout);
      this.pendingControlRequests.delete(request_id);
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
        subtype: subtype as never,
        ...data,
      } as CLIControlRequest['request'],
    };

    const responsePromise = new Promise<Record<string, unknown> | null>(
      (resolve, reject) => {
        const abortController = new AbortController();
        const timeout = setTimeout(() => {
          this.pendingControlRequests.delete(requestId);
          reject(new Error(`Control request timeout: ${subtype}`));
        }, 300000);

        this.pendingControlRequests.set(requestId, {
          resolve,
          reject,
          timeout,
          abortController,
        });
      },
    );

    this.transport.write(serializeJsonLine(request));
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
      return;
    }

    this.closed = true;

    for (const pending of this.pendingControlRequests.values()) {
      pending.abortController.abort();
      clearTimeout(pending.timeout);
    }
    this.pendingControlRequests.clear();

    this.hookCallbacks.clear();

    await this.transport.close();

    /**
     * Complete input stream - check if aborted first.
     * Only set error/done if stream doesn't already have an error state.
     */
    if (this.inputStream.hasError === undefined) {
      if (this.abortController.signal.aborted) {
        this.inputStream.error(new AbortError('Query aborted'));
      } else {
        this.inputStream.done();
      }
    }

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
   * Read SDK messages from input stream (async generator proxy).
   * This ensures stream.next() is called at least once, making readReject non-null.
   *
   * We don't wait for initialization here to ensure inputStream.next() is called
   * as early as possible, so that readResolve/readReject are set up before any errors
   * (like abort) can occur. Messages will be queued in the stream if they arrive before
   * iteration starts.
   *
   * Starting iteration immediately ensures errors (like abort) can be properly propagated
   * even if they occur before initialization completes.
   */
  private async *readSdkMessages(): AsyncGenerator<CLIMessage> {
    for await (const message of this.inputStream) {
      yield message;
    }
  }

  /**
   * AsyncIterator protocol: next()
   */
  async next(...args: [] | [unknown]): Promise<IteratorResult<CLIMessage>> {
    return this.sdkMessages.next(...args);
  }

  /**
   * AsyncIterator protocol: return()
   */
  async return(value?: unknown): Promise<IteratorResult<CLIMessage>> {
    return this.sdkMessages.return(value);
  }

  /**
   * AsyncIterator protocol: throw()
   */
  async throw(e?: unknown): Promise<IteratorResult<CLIMessage>> {
    return this.sdkMessages.throw(e);
  }

  /**
   * AsyncIterable protocol: Symbol.asyncIterator
   */
  [Symbol.asyncIterator](): AsyncIterator<CLIMessage> {
    return this.sdkMessages;
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
      /**
       * Wait for initialization to complete before sending messages.
       * This prevents "write after end" errors when streamInput is called
       * with an empty iterable before initialization finishes.
       */
      await this.initialized;

      for await (const message of messages) {
        if (this.abortController.signal.aborted) {
          break;
        }
        this.transport.write(serializeJsonLine(message));
      }

      /**
       * In multi-turn mode with MCP servers, wait for first result
       * to ensure MCP servers have time to process before next input.
       * This prevents race conditions where the next input arrives before
       * MCP servers have finished processing the current request.
       */
      if (
        !this.isSingleTurn &&
        this.sdkMcpTransports.size > 0 &&
        this.firstResultReceivedPromise
      ) {
        const STREAM_CLOSE_TIMEOUT = 10000;

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
      if (this.abortController.signal.aborted) {
        console.log('[Query] Aborted during input streaming');
        this.inputStream.error(
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
