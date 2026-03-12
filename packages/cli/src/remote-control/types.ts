/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Remote Control Protocol Types
 *
 * Defines the message format for communication between the remote control
 * web client and the local Qwen Code CLI server.
 */

/**
 * Authentication states for the remote control connection
 */
export enum AuthState {
  /** Waiting for client to scan QR code or enter token */
  PENDING = 'pending',
  /** Client has connected and authenticated */
  AUTHENTICATED = 'authenticated',
  /** Authentication failed or token expired */
  EXPIRED = 'expired',
  /** Connection was revoked by the host */
  REVOKED = 'revoked',
}

/**
 * Authentication request from client to server
 */
export interface AuthRequest {
  type: 'auth_request';
  token: string;
}

/**
 * Authentication response from server to client
 */
export interface AuthResponse {
  type: 'auth_response';
  success: boolean;
  state: AuthState;
  sessionId: string;
  message?: string;
}

/**
 * Session state snapshot
 */
export interface SessionState {
  sessionId: string;
  sessionName: string;
  startTime: number;
  status: 'active' | 'idle' | 'working' | 'error';
  workingDirectory: string;
  model: string;
  approvalMode: 'default' | 'yolo' | 'auto';
}

/**
 * Message types in the conversation
 */
export enum MessageType {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system',
  TOOL = 'tool',
  ERROR = 'error',
}

/**
 * A message in the conversation history
 */
export interface ConversationMessage {
  id: string;
  type: MessageType;
  content: string;
  timestamp: number;
  metadata?: {
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    model?: string;
    tokenCount?: number;
  };
}

/**
 * Request to sync session state from client
 */
export interface SyncRequest {
  type: 'sync_request';
  lastMessageId?: string;
}

/**
 * Session sync response from server
 */
export interface SyncResponse {
  type: 'sync_response';
  session: SessionState;
  messages: ConversationMessage[];
  hasMore: boolean;
  cursor?: string;
}

/**
 * New message from server to client (real-time update)
 */
export interface MessageUpdate {
  type: 'message_update';
  message: ConversationMessage;
}

/**
 * Session state update from server to client
 */
export interface SessionUpdate {
  type: 'session_update';
  session: Partial<SessionState>;
}

/**
 * User input from remote client
 */
export interface UserInput {
  type: 'user_input';
  content: string;
  id: string;
}

/**
 * Acknowledgment of user input
 */
export interface UserInputAck {
  type: 'user_input_ack';
  id: string;
  status: 'accepted' | 'rejected' | 'queued';
  reason?: string;
}

/**
 * Command execution request from remote client
 */
export interface CommandRequest {
  type: 'command_request';
  command: string;
  args?: string;
}

/**
 * Command execution result
 */
export interface CommandResponse {
  type: 'command_response';
  requestId: string;
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * Control commands for the session
 */
export interface ControlCommand {
  type: 'control_command';
  command: 'pause' | 'resume' | 'stop' | 'restart';
}

/**
 * Control command acknowledgment
 */
export interface ControlCommandAck {
  type: 'control_command_ack';
  command: string;
  success: boolean;
  message?: string;
}

/**
 * Error message from server
 */
export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Ping message for connection health check
 */
export interface PingMessage {
  type: 'ping';
  timestamp: number;
}

/**
 * Pong response for connection health check
 */
export interface PongMessage {
  type: 'pong';
  timestamp: number;
  latency: number;
}

/**
 * Union type for all client-to-server messages
 */
export type ClientMessage =
  | AuthRequest
  | SyncRequest
  | UserInput
  | CommandRequest
  | ControlCommand
  | PingMessage;

/**
 * Union type for all server-to-client messages
 */
export type ServerMessage =
  | AuthResponse
  | SyncResponse
  | MessageUpdate
  | SessionUpdate
  | UserInputAck
  | CommandResponse
  | ControlCommandAck
  | ErrorMessage
  | PongMessage;

/**
 * WebSocket message envelope
 */
export interface WSMessage<T extends ClientMessage | ServerMessage> {
  version: number;
  payload: T;
}

/**
 * Connection info returned after authentication
 */
export interface ConnectionInfo {
  sessionId: string;
  sessionName: string;
  serverVersion: string;
  capabilities: string[];
  authState: AuthState;
}

/**
 * QR Code connection data
 */
export interface QRConnectionData {
  url: string;
  token: string;
  expiresAt: number;
  sessionId: string;
}

/**
 * Remote control server configuration
 */
export interface RemoteControlConfig {
  port: number;
  host: string;
  secure: boolean;
  sessionName?: string;
  maxConnections: number;
  tokenExpiryMs: number;
}

/**
 * Default configuration for remote control server
 */
export const DEFAULT_REMOTE_CONTROL_CONFIG: RemoteControlConfig = {
  port: 7373,
  host: 'localhost',
  secure: false,
  maxConnections: 5,
  tokenExpiryMs: 5 * 60 * 1000, // 5 minutes
};
