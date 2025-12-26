/**
 * Query class - Main orchestrator for SDK
 *
 * Manages SDK workflow, routes messages, and handles lifecycle.
 * Implements AsyncIterator protocol for message consumption.
 */

const DEFAULT_CAN_USE_TOOL_TIMEOUT = 60_000;
const DEFAULT_MCP_REQUEST_TIMEOUT = 60_000;
const DEFAULT_CONTROL_REQUEST_TIMEOUT = 60_000;
const DEFAULT_STREAM_CLOSE_TIMEOUT = 60_000;

import { randomUUID } from 'node:crypto';
import { SdkLogger } from '../utils/logger.js';
import type {
  SDKMessage,
  SDKUserMessage,
  CLIControlRequest,
  CLIControlResponse,
  ControlCancelRequest,
  PermissionSuggestion,
  WireSDKMcpServerConfig,
} from '../types/protocol.js';
import {
  isSDKUserMessage,
  isSDKAssistantMessage,
  isSDKSystemMessage,
  isSDKResultMessage,
  isSDKPartialAssistantMessage,
  isControlRequest,
  isControlResponse,
  isControlCancel,
} from '../types/protocol.js';
import type { Transport } from '../transport/Transport.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { QueryOptions, CLIMcpServerConfig } from '../types/types.js';
import { isSdkMcpServerConfig } from '../types/types.js';
import { Stream } from '../utils/Stream.js';
import { serializeJsonLine } from '../utils/jsonLines.js';
import { AbortError } from '../types/errors.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  SdkControlServerTransport,
  type SdkControlServerTransportOptions,
} from '../mcp/SdkControlServerTransport.js';
import { ControlRequestType } from '../types/protocol.js';

interface PendingControlRequest {
  resolve: (response: Record<string, unknown> | null) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  abortController: AbortController;
}

interface PendingMcpResponse {
  resolve: (response: JSONRPCMessage) => void;
  reject: (error: Error) => void;
}

interface TransportWithEndInput extends Transport {
  endInput(): void;
}

const logger = SdkLogger.createLogger('Query');

export class Query implements AsyncIterable<SDKMessage> {
  private transport: Transport;
  private options: QueryOptions;
  private sessionId: string;
  private inputStream: Stream<SDKMessage>;
  private sdkMessages: AsyncGenerator<SDKMessage>;
  private abortController: AbortController;
  private pendingControlRequests: Map<string, PendingControlRequest> =
    new Map();
  private pendingMcpResponses: Map<string, PendingMcpResponse> = new Map();
  private sdkMcpTransports: Map<string, SdkControlServerTransport> = new Map();
  private sdkMcpServers: Map<string, McpServer> = new Map();
  readonly initialized: Promise<void>;
  private closed = false;
  private messageRouterStarted = false;

  private firstResultReceivedPromise?: Promise<void>;
  private firstResultReceivedResolve?: () => void;

  private readonly isSingleTurn: boolean;

  constructor(
    transport: Transport,
    options: QueryOptions,
    singleTurn: boolean = false,
  ) {
    this.transport = transport;
    this.options = options;
    this.sessionId = randomUUID();
    this.inputStream = new Stream<SDKMessage>();
    this.abortController = options.abortController ?? new AbortController();
    this.isSingleTurn = singleTurn;

    /**
     * Create async generator proxy to ensure stream.next() is called at least once.
     * The generator will start iterating when the user begins iteration.
     * This ensures readResolve/readReject are set up as soon as iteration starts.
     * If errors occur before iteration starts, they'll be stored in hasError and
     * properly rejected when the user starts iterating.
     */
    this.sdkMessages = this.readSdkMessages();

    /**
     * Promise that resolves when the first SDKResultMessage is received.
     * Used to coordinate endInput() timing - ensures all initialization
     * (SDK MCP servers, control responses) is complete before closing CLI stdin.
     */
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
        logger.error('Error during abort cleanup:', err);
      });
    } else {
      this.abortController.signal.addEventListener('abort', () => {
        this.inputStream.error(new AbortError('Query aborted by user'));
        this.close().catch((err) => {
          logger.error('Error during abort cleanup:', err);
        });
      });
    }

    this.initialized = this.initialize();
    this.initialized.catch(() => {});

    this.startMessageRouter();
  }

  private async initializeSdkMcpServers(): Promise<void> {
    if (!this.options.mcpServers) {
      return;
    }

    const connectionPromises: Array<Promise<void>> = [];

    // Extract SDK MCP servers from the unified mcpServers config
    for (const [key, config] of Object.entries(this.options.mcpServers)) {
      if (!isSdkMcpServerConfig(config)) {
        continue; // Skip external MCP servers
      }

      // Use the name from SDKMcpServerConfig, fallback to key for backwards compatibility
      const serverName = config.name || key;
      const server = config.instance;

      // Create transport options with callback to route MCP server responses
      const transportOptions: SdkControlServerTransportOptions = {
        sendToQuery: async (message: JSONRPCMessage) => {
          this.handleMcpServerResponse(serverName, message);
        },
        serverName,
      };

      const sdkTransport = new SdkControlServerTransport(transportOptions);

      // Connect server to transport and only register on success
      const connectionPromise = server
        .connect(sdkTransport)
        .then(() => {
          // Only add to maps after successful connection
          this.sdkMcpServers.set(serverName, server);
          this.sdkMcpTransports.set(serverName, sdkTransport);
          logger.debug(`SDK MCP server '${serverName}' connected to transport`);
        })
        .catch((error) => {
          logger.error(
            `Failed to connect SDK MCP server '${serverName}' to transport:`,
            error,
          );
          // Don't throw - one failed server shouldn't prevent others
        });

      connectionPromises.push(connectionPromise);
    }

    // Wait for all connection attempts to complete
    await Promise.all(connectionPromises);

    if (this.sdkMcpServers.size > 0) {
      logger.info(
        `Initialized ${this.sdkMcpServers.size} SDK MCP server(s): ${Array.from(this.sdkMcpServers.keys()).join(', ')}`,
      );
    }
  }

  /**
   * Handle response messages from SDK MCP servers
   *
   * When an MCP server sends a response via transport.send(), this callback
   * routes it back to the pending request that's waiting for it.
   */
  private handleMcpServerResponse(
    serverName: string,
    message: JSONRPCMessage,
  ): void {
    // Check if this is a response with an id
    if ('id' in message && message.id !== null && message.id !== undefined) {
      const key = `${serverName}:${message.id}`;
      const pending = this.pendingMcpResponses.get(key);
      if (pending) {
        logger.debug(
          `Routing MCP response for server '${serverName}', id: ${message.id}`,
        );
        pending.resolve(message);
        this.pendingMcpResponses.delete(key);
        return;
      }
    }

    // If no pending request found, log a warning (this shouldn't happen normally)
    logger.warn(
      `Received MCP server response with no pending request: server='${serverName}'`,
      message,
    );
  }

  /**
   * Get SDK MCP servers config for CLI initialization
   *
   * Only SDK servers are sent in the initialize request.
   */
  private getSdkMcpServersForCli(): Record<string, WireSDKMcpServerConfig> {
    const sdkServers: Record<string, WireSDKMcpServerConfig> = {};

    for (const [name] of this.sdkMcpServers.entries()) {
      sdkServers[name] = { type: 'sdk', name };
    }

    return sdkServers;
  }

  /**
   * Get external MCP servers (non-SDK) that should be managed by the CLI
   */
  private getMcpServersForCli(): Record<string, CLIMcpServerConfig> {
    if (!this.options.mcpServers) {
      return {};
    }

    const externalServers: Record<string, CLIMcpServerConfig> = {};

    for (const [name, config] of Object.entries(this.options.mcpServers)) {
      if (isSdkMcpServerConfig(config)) {
        continue;
      }
      externalServers[name] = config as CLIMcpServerConfig;
    }

    return externalServers;
  }

  private async initialize(): Promise<void> {
    try {
      logger.debug('Initializing Query');

      // Initialize SDK MCP servers and wait for connections
      await this.initializeSdkMcpServers();

      // Get only successfully connected SDK servers for CLI
      const sdkMcpServersForCli = this.getSdkMcpServersForCli();
      const mcpServersForCli = this.getMcpServersForCli();

      await this.sendControlRequest(ControlRequestType.INITIALIZE, {
        hooks: null,
        sdkMcpServers:
          Object.keys(sdkMcpServersForCli).length > 0
            ? sdkMcpServersForCli
            : undefined,
        mcpServers:
          Object.keys(mcpServersForCli).length > 0
            ? mcpServersForCli
            : undefined,
        agents: this.options.agents,
      });
      logger.info('Query initialized successfully');
    } catch (error) {
      logger.error('Initialization error:', error);
      throw error;
    }
  }

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

    if (isSDKSystemMessage(message)) {
      /**
       * SystemMessage contains session info (cwd, tools, model, etc.)
       * that should be passed to user.
       */
      this.inputStream.enqueue(message);
      return;
    }

    if (isSDKResultMessage(message)) {
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
      isSDKAssistantMessage(message) ||
      isSDKUserMessage(message) ||
      isSDKPartialAssistantMessage(message)
    ) {
      this.inputStream.enqueue(message);
      return;
    }

    logger.warn('Unknown message type:', message);
    this.inputStream.enqueue(message as SDKMessage);
  }

  private async handleControlRequest(
    request: CLIControlRequest,
  ): Promise<void> {
    const { request_id, request: payload } = request;

    logger.debug(`Handling control request: ${payload.subtype}`);
    const requestAbortController = new AbortController();

    try {
      let response: Record<string, unknown> | null = null;

      switch (payload.subtype) {
        case 'can_use_tool':
          response = await this.handlePermissionRequest(
            payload.tool_name,
            payload.input as Record<string, unknown>,
            payload.permission_suggestions,
            requestAbortController.signal,
          );
          break;

        case 'mcp_message':
          response = await this.handleMcpMessage(
            payload.server_name,
            payload.message as unknown as JSONRPCMessage,
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
      logger.error(`Control request error (${payload.subtype}):`, errorMessage);
      await this.sendControlResponse(request_id, false, errorMessage);
    }
  }

  private async handlePermissionRequest(
    toolName: string,
    toolInput: Record<string, unknown>,
    permissionSuggestions: PermissionSuggestion[] | null,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    /* Default deny all wildcard tool requests */
    if (!this.options.canUseTool) {
      return { behavior: 'deny', message: 'Denied' };
    }

    try {
      const canUseToolTimeout =
        this.options.timeout?.canUseTool ?? DEFAULT_CAN_USE_TOOL_TIMEOUT;
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('Permission callback timeout')),
          canUseToolTimeout,
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

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (result.behavior === 'allow') {
        return {
          behavior: 'allow',
          updatedInput: result.updatedInput ?? toolInput,
        };
      } else {
        return {
          behavior: 'deny',
          message: result.message ?? 'Denied',
          ...(result.interrupt !== undefined
            ? { interrupt: result.interrupt }
            : {}),
        };
      }
    } catch (error) {
      /**
       * Timeout or error → deny (fail-safe).
       * This ensures that any issues with the permission callback
       * result in a safe default of denying access.
       */
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.warn(
        'Permission callback error (denying by default):',
        errorMessage,
      );
      return {
        behavior: 'deny',
        message: `Permission check failed: ${errorMessage}`,
      };
    }
  }

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

  private handleMcpRequest(
    serverName: string,
    message: JSONRPCMessage,
    transport: SdkControlServerTransport,
  ): Promise<JSONRPCMessage> {
    const messageId = 'id' in message ? message.id : null;
    const key = `${serverName}:${messageId}`;

    return new Promise((resolve, reject) => {
      const mcpRequestTimeout =
        this.options.timeout?.mcpRequest ?? DEFAULT_MCP_REQUEST_TIMEOUT;
      const timeout = setTimeout(() => {
        this.pendingMcpResponses.delete(key);
        reject(new Error('MCP request timeout'));
      }, mcpRequestTimeout);

      const cleanup = () => {
        clearTimeout(timeout);
        this.pendingMcpResponses.delete(key);
      };

      const resolveAndCleanup = (response: JSONRPCMessage) => {
        cleanup();
        resolve(response);
      };

      const rejectAndCleanup = (error: Error) => {
        cleanup();
        reject(error);
      };

      // Register pending response handler
      this.pendingMcpResponses.set(key, {
        resolve: resolveAndCleanup,
        reject: rejectAndCleanup,
      });

      // Deliver message to MCP server via transport.onmessage
      // The server will process it and call transport.send() with the response,
      // which triggers handleMcpServerResponse to resolve our pending promise
      transport.handleMessage(message);
    });
  }

  private handleControlResponse(response: CLIControlResponse): void {
    const { response: payload } = response;
    const request_id = payload.request_id;

    const pending = this.pendingControlRequests.get(request_id);
    if (!pending) {
      logger.warn(
        'Received response for unknown request:',
        request_id,
        JSON.stringify(payload),
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingControlRequests.delete(request_id);

    if (payload.subtype === 'success') {
      logger.debug(
        `Control response success for request: ${request_id}: ${JSON.stringify(payload.response)}`,
      );
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
      logger.error(
        `Control response error for request ${request_id}:`,
        errorMessage,
      );
      pending.reject(new Error(errorMessage));
    }
  }

  private handleControlCancelRequest(request: ControlCancelRequest): void {
    const { request_id } = request;

    if (!request_id) {
      logger.warn('Received cancel request without request_id');
      return;
    }

    const pending = this.pendingControlRequests.get(request_id);
    if (pending) {
      logger.debug(`Cancelling control request: ${request_id}`);
      pending.abortController.abort();
      clearTimeout(pending.timeout);
      this.pendingControlRequests.delete(request_id);
      pending.reject(new AbortError('Request cancelled'));
    }
  }

  private async sendControlRequest(
    subtype: string,
    data: Record<string, unknown> = {},
  ): Promise<Record<string, unknown> | null> {
    if (this.closed) {
      return Promise.reject(new Error('Query is closed'));
    }

    if (subtype !== ControlRequestType.INITIALIZE) {
      // Ensure all other control requests get processed after initialization
      await this.initialized;
    }

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
        const controlRequestTimeout =
          this.options.timeout?.controlRequest ??
          DEFAULT_CONTROL_REQUEST_TIMEOUT;
        const timeout = setTimeout(() => {
          this.pendingControlRequests.delete(requestId);
          reject(new Error(`Control request timeout: ${subtype}`));
        }, controlRequestTimeout);

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

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    for (const pending of this.pendingControlRequests.values()) {
      pending.abortController.abort();
      clearTimeout(pending.timeout);
      pending.reject(new Error('Query is closed'));
    }
    this.pendingControlRequests.clear();

    // Clean up pending MCP responses
    for (const pending of this.pendingMcpResponses.values()) {
      pending.reject(new Error('Query is closed'));
    }
    this.pendingMcpResponses.clear();

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
        logger.error('Error closing MCP transport:', error);
      }
    }
    this.sdkMcpTransports.clear();
    logger.info('Query is closed');
  }

  private async *readSdkMessages(): AsyncGenerator<SDKMessage> {
    for await (const message of this.inputStream) {
      yield message;
    }
  }

  async next(...args: [] | [unknown]): Promise<IteratorResult<SDKMessage>> {
    return this.sdkMessages.next(...args);
  }

  async return(value?: unknown): Promise<IteratorResult<SDKMessage>> {
    return this.sdkMessages.return(value);
  }

  async throw(e?: unknown): Promise<IteratorResult<SDKMessage>> {
    return this.sdkMessages.throw(e);
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.sdkMessages;
  }

  async streamInput(messages: AsyncIterable<SDKUserMessage>): Promise<void> {
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
       * After all user messages are sent (for-await loop ended), determine when to
       * close the CLI's stdin via endInput().
       *
       * - If a result message was already received: All initialization (SDK MCP servers,
       *   control responses, etc.) is complete, safe to close stdin immediately.
       * - If no result yet: Wait for either the result to arrive, or the timeout to expire.
       *   This gives pending control_responses from SDK MCP servers or other modules
       *   time to complete their initialization before we close the input stream.
       *
       * The timeout ensures we don't hang indefinitely - either the turn proceeds
       * normally, or it fails with a timeout, but Promise.race will always resolve.
       */
      if (
        !this.isSingleTurn &&
        this.sdkMcpTransports.size > 0 &&
        this.firstResultReceivedPromise
      ) {
        const streamCloseTimeout =
          this.options.timeout?.streamClose ?? DEFAULT_STREAM_CLOSE_TIMEOUT;
        let timeoutId: NodeJS.Timeout | undefined;

        const timeoutPromise = new Promise<void>((resolve) => {
          timeoutId = setTimeout(() => {
            logger.info('streamCloseTimeout resolved');
            resolve();
          }, streamCloseTimeout);
        });

        await Promise.race([this.firstResultReceivedPromise, timeoutPromise]);

        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }

      this.endInput();
    } catch (error) {
      if (this.abortController.signal.aborted) {
        logger.info('Aborted during input streaming');
        this.inputStream.error(
          new AbortError('Query aborted during input streaming'),
        );
        return;
      }
      throw error;
    }
  }

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

  async interrupt(): Promise<void> {
    await this.sendControlRequest(ControlRequestType.INTERRUPT);
  }

  async setPermissionMode(mode: string): Promise<void> {
    await this.sendControlRequest(ControlRequestType.SET_PERMISSION_MODE, {
      mode,
    });
  }

  async setModel(model: string): Promise<void> {
    await this.sendControlRequest(ControlRequestType.SET_MODEL, { model });
  }

  /**
   * Get list of control commands supported by the CLI
   *
   * @returns Promise resolving to list of supported command names
   * @throws Error if query is closed
   */
  async supportedCommands(): Promise<Record<string, unknown> | null> {
    return this.sendControlRequest(ControlRequestType.SUPPORTED_COMMANDS);
  }

  /**
   * Get the status of MCP servers
   *
   * @returns Promise resolving to MCP server status information
   * @throws Error if query is closed
   */
  async mcpServerStatus(): Promise<Record<string, unknown> | null> {
    return this.sendControlRequest(ControlRequestType.MCP_SERVER_STATUS);
  }

  getSessionId(): string {
    return this.sessionId;
  }

  isClosed(): boolean {
    return this.closed;
  }
}
