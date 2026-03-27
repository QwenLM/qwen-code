/**
 * Shared protocol types for mock channel WebSocket communication.
 */

/** Server → Plugin Channel (WebSocket) */
export interface InboundMessage {
  type: 'inbound';
  messageId: string;
  senderId: string;
  senderName: string;
  chatId: string;
  text: string;
}

/** Plugin Channel → Server (WebSocket) — streaming chunk */
export interface ChunkMessage {
  type: 'chunk';
  messageId: string;
  chatId: string;
  text: string;
}

/** Plugin Channel → Server (WebSocket) — final response */
export interface OutboundMessage {
  type: 'outbound';
  messageId: string;
  chatId: string;
  text: string;
}

export type WsMessage = InboundMessage | ChunkMessage | OutboundMessage;
