import * as React from "react"
import i18next from "i18next"
import { formatDistanceToNowStrict } from "date-fns"
import type { Locale } from "date-fns"
import { truncateTitle } from "@craft-agent/shared/utils/title-generator"
import type { Session, Message } from "../../shared/types"
import type { SessionMeta } from "../atoms/sessions"
import type { SessionStatusId } from "../config/session-status-config"

/** Common session fields used by getSessionTitle */
type SessionLike = Pick<Session, 'name' | 'preview'> & { messages?: Session['messages'] }

/**
 * Sanitize content for display as session title.
 * Strips XML blocks (e.g. <edit_request>) and normalizes whitespace.
 */
function sanitizePreview(content: string): string {
  return content
    .replace(/<edit_request>[\s\S]*?<\/edit_request>/g, '') // Strip entire edit_request blocks
    .replace(/<[^>]+>/g, '')     // Strip remaining XML/HTML tags
    .replace(/\s+/g, ' ')        // Collapse whitespace
    .trim()
}

/**
 * Get display title for a session.
 * Priority: custom name > first user message > preview (from metadata) > "New chat"
 * Works with both Session (full) and SessionMeta (lightweight)
 */
export function getSessionTitle(session: SessionLike | SessionMeta): string {
  if (session.name) {
    return truncateTitle(session.name)
  }

  // Check loaded messages first (only available on full Session)
  if ('messages' in session && session.messages) {
    const firstUserMessage = session.messages.find(m => m.role === 'user')
    if (firstUserMessage?.content) {
      const sanitized = sanitizePreview(firstUserMessage.content)
      if (sanitized) {
        return truncateTitle(sanitized)
      }
    }
  }

  // Fall back to preview from JSONL header (for lazy-loaded sessions and SessionMeta)
  if (session.preview) {
    const sanitized = sanitizePreview(session.preview)
    if (sanitized) {
      return truncateTitle(sanitized)
    }
  }

  return i18next.t('session.defaultTitle', 'New chat')
}

/**
 * Get a compact preview line for session-list rows.
 * Prefers the stored preview/first user message, but avoids duplicating the title.
 */
export function getSessionPreviewText(session: SessionLike | SessionMeta, maxLength = 88): string | null {
  const source = session.preview
    || (('messages' in session && session.messages)
      ? session.messages.find(m => m.role === 'user')?.content
      : undefined)

  if (!source) return null

  const sanitized = sanitizePreview(source)
  if (!sanitized) return null

  const title = getSessionTitle(session).replace(/…$/, '').trim()
  const normalizedTitle = sanitizePreview(title)
  if (normalizedTitle && sanitized.toLowerCase() === normalizedTitle.toLowerCase()) {
    return null
  }

  const trimmed = sanitized.slice(0, maxLength)
  return trimmed.length < sanitized.length ? `${trimmed.trimEnd()}…` : trimmed
}

/**
 * Get the ID of the last final assistant or plan message (not intermediate)
 * Used for unread message tracking
 */
export function getLastFinalAssistantMessageId(session: Session): string | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i]
    // Include plan messages as final responses (they're AI-generated content)
    if ((msg.role === 'assistant' || msg.role === 'plan') && !msg.isIntermediate) {
      return msg.id
    }
  }
  return undefined
}

/**
 * Check if a session has unread messages
 * A session is unread if:
 * - There's a final assistant message AND
 * - Its ID differs from lastReadMessageId
 */
export function hasUnreadMessages(session: Session): boolean {
  const lastFinalId = getLastFinalAssistantMessageId(session)
  if (!lastFinalId) return false  // No final assistant message yet
  return lastFinalId !== session.lastReadMessageId
}

/**
 * Count the number of unread final assistant messages
 * Returns the count of final assistant messages after lastReadMessageId
 */
export function countUnreadMessages(session: Session): number {
  // Helper to check if message is a final response (assistant or plan)
  const isFinalResponse = (msg: Message) =>
    (msg.role === 'assistant' || msg.role === 'plan') && !msg.isIntermediate

  if (!session.lastReadMessageId) {
    // Never read - count all final messages
    return session.messages.filter(isFinalResponse).length
  }

  // Find the index of the last read message
  const lastReadIndex = session.messages.findIndex(msg => msg.id === session.lastReadMessageId)
  if (lastReadIndex === -1) {
    // Last read message not found - count all final messages
    return session.messages.filter(isFinalResponse).length
  }

  // Count final messages after the last read index
  let count = 0
  for (let i = lastReadIndex + 1; i < session.messages.length; i++) {
    if (isFinalResponse(session.messages[i])) {
      count++
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// SessionMeta helpers (lightweight, no full Session needed)
// ---------------------------------------------------------------------------

export function getSessionStatus(session: SessionMeta): SessionStatusId {
  return (session.sessionStatus as SessionStatusId) || 'todo'
}

export function hasUnreadMeta(session: SessionMeta): boolean {
  return session.hasUnread === true
}

export function hasMessagesMeta(session: SessionMeta): boolean {
  return session.lastFinalMessageId !== undefined
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Short relative time locale for date-fns formatDistanceToNowStrict.
 *  Produces compact strings: "7m", "2h", "3d", "2w", "5mo", "1y"
 *  Uses i18n keys (time.compact.*) so output is localized. */
export const shortTimeLocale = {
  formatDistance: (token: string, count: number) => {
    const tokenToKey: Record<string, string> = {
      xSeconds: 'time.compact.seconds',
      xMinutes: 'time.compact.minutes',
      xHours: 'time.compact.hours',
      xDays: 'time.compact.days',
      xWeeks: 'time.compact.weeks',
      xMonths: 'time.compact.months',
      xYears: 'time.compact.years',
    }
    const key = tokenToKey[token]
    return key ? i18next.t(key, { count }) : `${count}`
  },
}

const JUST_NOW_THRESHOLD_MS = 60 * 1000

export function formatSessionRelativeTime(timestamp: number): string {
  if (Date.now() - timestamp < JUST_NOW_THRESHOLD_MS) {
    return i18next.t('common.justNow', 'Just now')
  }

  return formatDistanceToNowStrict(new Date(timestamp), {
    locale: shortTimeLocale as Locale,
    roundingMethod: 'floor',
  })
}

/** Highlight matching text in a string with yellow background spans. */
export function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const index = lowerText.indexOf(lowerQuery)

  if (index === -1) return text

  const before = text.slice(0, index)
  const match = text.slice(index, index + query.length)
  const after = text.slice(index + query.length)

  return React.createElement(React.Fragment, null,
    before,
    React.createElement('span', { className: 'bg-yellow-300/30 rounded-[2px]' }, match),
    highlightMatch(after, query),
  )
}
