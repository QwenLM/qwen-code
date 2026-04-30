/**
 * Session types for conversation management
 *
 * Sessions are the primary isolation boundary. Each session maps 1:1
 * with a CraftAgent instance and SDK conversation.
 */

import type { StoredMessage, TokenUsage } from './message.ts';

/**
 * Session status for workflow tracking
 * Agents can update this to reflect the current state of the conversation
 */
export type SessionStatus = 'todo' | 'in_progress' | 'needs_review' | 'done' | 'cancelled';

/**
 * Session represents a conversation scope (SDK session = our scope boundary)
 */
export interface Session {
  id: string;                    // Unique identifier (stable, known immediately)
  sdkSessionId?: string;         // SDK session ID (captured after first message)
  workspaceId: string;           // Which workspace this session belongs to
  name?: string;                 // Optional user-defined name
  createdAt: number;
  lastUsedAt: number;
  // Inbox/Archive features
  isArchived?: boolean;          // Whether this session is archived
  isFlagged?: boolean;           // Whether this session is flagged
  status?: SessionStatus;        // Workflow status (todo, in_progress, needs_review, done, cancelled)
  // Read/unread tracking
  lastReadMessageId?: string;    // ID of the last message the user has read
}

/**
 * Stored session with conversation data (for persistence)
 */
export interface StoredSession extends Session {
  messages: StoredMessage[];
  tokenUsage: TokenUsage;
}

/**
 * Session metadata for listing (without loading full messages)
 * Extended with archive status for Inbox/Archive features
 */
export interface SessionMetadata {
  id: string;
  workspaceId: string;
  name?: string;
  createdAt: number;
  lastUsedAt: number;
  messageCount: number;
  preview?: string;        // Preview of first user message
  sdkSessionId?: string;
  // Inbox/Archive features
  isArchived?: boolean;    // Whether this session is archived
  isFlagged?: boolean;     // Whether this session is flagged
  status?: SessionStatus;  // Workflow status
  hidden?: boolean;        // Whether this session is hidden from session list
}
