/**
 * Message Service - Database-backed implementation using Drizzle ORM.
 *
 * Provides CRUD operations for agent chat messages with:
 * - Type-safe database queries
 * - Efficient indexed queries
 * - Consistent with AgentStoredMessage interface from shared types
 */
import { randomUUID } from 'node:crypto';
import { eq, asc, and, count } from 'drizzle-orm';
import type { AgentRole, AgentStoredMessage } from 'chrome-mcp-shared';
import { getDb, messages, type MessageRow } from './db';

// ============================================================
// Types
// ============================================================

export type { AgentStoredMessage };

export interface CreateAgentStoredMessageInput {
  projectId: string;
  role: AgentRole;
  messageType: AgentStoredMessage['messageType'];
  content: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
  conversationId?: string | null;
  cliSource?: string;
  requestId?: string;
  id?: string;
  createdAt?: string;
}

// ============================================================
// Type Conversion
// ============================================================

/**
 * Convert database row to AgentStoredMessage interface.
 */
function rowToMessage(row: MessageRow): AgentStoredMessage {
  return {
    id: row.id,
    projectId: row.projectId,
    sessionId: row.sessionId,
    conversationId: row.conversationId,
    role: row.role as AgentRole,
    content: row.content,
    messageType: row.messageType as AgentStoredMessage['messageType'],
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    cliSource: row.cliSource,
    requestId: row.requestId ?? undefined,
    createdAt: row.createdAt,
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * Get messages by project ID with pagination.
 * Returns messages sorted by creation time (oldest first).
 */
export async function getMessagesByProjectId(
  projectId: string,
  limit = 50,
  offset = 0,
): Promise<AgentStoredMessage[]> {
  const db = getDb();

  const query = db
    .select()
    .from(messages)
    .where(eq(messages.projectId, projectId))
    .orderBy(asc(messages.createdAt));

  // Apply pagination if specified
  if (limit > 0) {
    query.limit(limit);
  }
  if (offset > 0) {
    query.offset(offset);
  }

  const rows = await query;
  return rows.map(rowToMessage);
}

/**
 * Get the total count of messages for a project.
 */
export async function getMessagesCountByProjectId(projectId: string): Promise<number> {
  const db = getDb();
  const result = await db
    .select({ count: count() })
    .from(messages)
    .where(eq(messages.projectId, projectId));
  return result[0]?.count ?? 0;
}

/**
 * Create a new message.
 */
export async function createMessage(
  input: CreateAgentStoredMessageInput,
): Promise<AgentStoredMessage> {
  const db = getDb();
  const now = new Date().toISOString();

  const messageData: MessageRow = {
    id: input.id?.trim() || randomUUID(),
    projectId: input.projectId,
    sessionId: input.sessionId || '',
    conversationId: input.conversationId ?? null,
    role: input.role,
    content: input.content,
    messageType: input.messageType,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    cliSource: input.cliSource ?? null,
    requestId: input.requestId ?? null,
    createdAt: input.createdAt || now,
  };

  await db
    .insert(messages)
    .values(messageData)
    .onConflictDoUpdate({
      target: messages.id,
      set: {
        role: messageData.role,
        messageType: messageData.messageType,
        content: messageData.content,
        metadata: messageData.metadata,
        sessionId: messageData.sessionId,
        conversationId: messageData.conversationId,
        cliSource: messageData.cliSource,
        requestId: messageData.requestId,
      },
    });

  return rowToMessage(messageData);
}

/**
 * Delete messages by project ID.
 * Optionally filter by conversation ID.
 * Returns the number of deleted messages.
 */
export async function deleteMessagesByProjectId(
  projectId: string,
  conversationId?: string,
): Promise<number> {
  const db = getDb();

  // Get count before deletion
  const beforeCount = await getMessagesCountByProjectId(projectId);

  if (conversationId) {
    await db
      .delete(messages)
      .where(and(eq(messages.projectId, projectId), eq(messages.conversationId, conversationId)));
  } else {
    await db.delete(messages).where(eq(messages.projectId, projectId));
  }

  // Get count after deletion to calculate deleted count
  const afterCount = await getMessagesCountByProjectId(projectId);
  return beforeCount - afterCount;
}

/**
 * Get messages by session ID with optional pagination.
 * Returns messages sorted by creation time (oldest first).
 *
 * @param sessionId - The session ID to filter by
 * @param limit - Maximum number of messages to return (0 = no limit)
 * @param offset - Number of messages to skip
 */
export async function getMessagesBySessionId(
  sessionId: string,
  limit = 0,
  offset = 0,
): Promise<AgentStoredMessage[]> {
  const db = getDb();

  const query = db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt));

  if (limit > 0) {
    query.limit(limit);
  }
  if (offset > 0) {
    query.offset(offset);
  }

  const rows = await query;
  return rows.map(rowToMessage);
}

/**
 * Get count of messages by session ID.
 */
export async function getMessagesCountBySessionId(sessionId: string): Promise<number> {
  const db = getDb();
  const result = await db
    .select({ count: count() })
    .from(messages)
    .where(eq(messages.sessionId, sessionId));
  return result[0]?.count ?? 0;
}

/**
 * Delete all messages for a session.
 * Returns the number of deleted messages.
 */
export async function deleteMessagesBySessionId(sessionId: string): Promise<number> {
  const db = getDb();

  const beforeCount = await getMessagesCountBySessionId(sessionId);
  await db.delete(messages).where(eq(messages.sessionId, sessionId));
  const afterCount = await getMessagesCountBySessionId(sessionId);

  return beforeCount - afterCount;
}

/**
 * Get messages by request ID.
 */
export async function getMessagesByRequestId(requestId: string): Promise<AgentStoredMessage[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.requestId, requestId))
    .orderBy(asc(messages.createdAt));
  return rows.map(rowToMessage);
}
