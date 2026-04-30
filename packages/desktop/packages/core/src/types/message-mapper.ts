import type { Message, StoredMessage } from './message.ts';

/**
 * Convert runtime Message to StoredMessage for persistence.
 *
 * Excludes transient runtime-only fields:
 * - isStreaming
 * - isPending
 */
export function messageToStored(msg: Message): StoredMessage {
  const {
    role,
    isStreaming,
    isPending,
    badges: _legacyBadges,
    ...rest
  } = msg as Message & { badges?: unknown };
  return { ...rest, type: role } as StoredMessage;
}

/**
 * Convert StoredMessage to runtime Message.
 *
 * Adds a timestamp fallback for legacy messages where timestamp was omitted.
 */
export function storedToMessage(stored: StoredMessage): Message {
  const { type, badges: _legacyBadges, ...rest } = stored as StoredMessage & { badges?: unknown };
  return { ...rest, role: type, timestamp: stored.timestamp ?? Date.now() } as Message;
}
