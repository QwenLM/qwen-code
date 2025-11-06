/**
 * Transport interface for SDK-CLI communication
 *
 * The Transport abstraction enables communication between SDK and CLI via different mechanisms:
 * - ProcessTransport: Local subprocess via stdin/stdout (initial implementation)
 * - HttpTransport: Remote CLI via HTTP (future)
 * - WebSocketTransport: Remote CLI via WebSocket (future)
 */

/**
 * Abstract Transport interface
 *
 * Provides bidirectional communication with lifecycle management.
 * Implements async generator pattern for reading messages with automatic backpressure.
 */
export interface Transport {
  /**
   * Initialize and start the transport.
   *
   * For ProcessTransport: spawns CLI subprocess
   * For HttpTransport: establishes HTTP connection
   * For WebSocketTransport: opens WebSocket connection
   *
   * Must be called before write() or readMessages().
   *
   * @throws Error if transport cannot be started
   */
  start(): Promise<void>;

  /**
   * Close the transport gracefully.
   *
   * For ProcessTransport: sends SIGTERM, waits 5s, then SIGKILL
   * For HttpTransport: sends close request, closes connection
   * For WebSocketTransport: sends close frame
   *
   * Idempotent - safe to call multiple times.
   */
  close(): Promise<void>;

  /**
   * Wait for transport to fully exit and cleanup.
   *
   * Resolves when all resources are cleaned up:
   * - Process has exited (ProcessTransport)
   * - Connection is closed (Http/WebSocketTransport)
   * - All cleanup callbacks have run
   *
   * @returns Promise that resolves when exit is complete
   */
  waitForExit(): Promise<void>;

  /**
   * Write a message to the transport.
   *
   * For ProcessTransport: writes to stdin
   * For HttpTransport: sends HTTP request
   * For WebSocketTransport: sends WebSocket message
   *
   * Message format: JSON Lines (one JSON object per line)
   *
   * @param message - Serialized JSON message (without trailing newline)
   * @throws Error if transport is not ready or closed
   */
  write(message: string): void;

  /**
   * Read messages from transport as async generator.
   *
   * Yields messages as they arrive, supporting natural backpressure via async iteration.
   * Generator completes when transport closes.
   *
   * For ProcessTransport: reads from stdout using readline
   * For HttpTransport: reads from chunked HTTP response
   * For WebSocketTransport: reads from WebSocket messages
   *
   * Message format: JSON Lines (one JSON object per line)
   * Malformed JSON lines are logged and skipped.
   *
   * @yields Parsed JSON messages
   * @throws Error if transport encounters fatal error
   */
  readMessages(): AsyncGenerator<unknown, void, unknown>;

  /**
   * Whether transport is ready for I/O operations.
   *
   * true: write() and readMessages() can be called
   * false: transport not started or has failed
   */
  readonly isReady: boolean;

  /**
   * Error that caused transport to exit unexpectedly (if any).
   *
   * null: transport exited normally or still running
   * Error: transport failed with this error
   *
   * Useful for diagnostics when transport closes unexpectedly.
   */
  readonly exitError: Error | null;
}
