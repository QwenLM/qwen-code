/**
 * Transport interface for SDK-CLI communication
 *
 * The Transport abstraction enables communication between SDK and CLI via different mechanisms:
 * - ProcessTransport: Local subprocess via stdin/stdout (initial implementation)
 * - HttpTransport: Remote CLI via HTTP (future)
 * - WebSocketTransport: Remote CLI via WebSocket (future)
 */

export interface Transport {
  close(): Promise<void>;

  waitForExit(): Promise<void>;

  write(message: string): void;

  readMessages(): AsyncGenerator<unknown, void, unknown>;

  readonly isReady: boolean;

  readonly exitError: Error | null;
}
