/**
 * ws shim — browser uses native WebSocket.
 *
 * The WsRpcServer imports WebSocketServer from 'ws' but is never
 * instantiated in the browser. This shim satisfies the bundler.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */
export class WebSocketServer {
  constructor(_opts?: any) {
    throw new Error('WebSocketServer is not available in the browser')
  }
  on(_event: string, _fn: Function) { return this }
  close() {}
  address() { return null }
}

// Re-export native WebSocket for the client
export const WebSocket = globalThis.WebSocket
export type { WebSocket as default }
